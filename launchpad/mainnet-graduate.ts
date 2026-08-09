/**
 * Graduates the first mainnet token and collects the fees through the vault.
 *
 * This is the irreversible half of the product: migrating moves the curve's
 * reserves into a DAMM v2 pool and locks that liquidity permanently. Holders
 * keep their tokens and can sell into the pool afterwards; nobody, us included,
 * can take the liquidity back out.
 *
 *   npx tsx mainnet-graduate.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient, MigrationFeeOption, DAMM_V2_MIGRATION_FEE_ADDRESS,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { publicKeyHash, sign, cat, utf8, u64 } from "../client/src/wots.js";
import { masterFromMnemonic, keyAt } from "../client/src/new-master-seed.js";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const PAYER_PATH = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\mainnet-deployer.json";
const SEED_FILE = "C:\\Users\\zarne\\Desktop\\quantum-token\\MASTER-SEED.txt";
const VAULT_PROGRAM = new PublicKey("13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT");
const POOL = new PublicKey("CPV2sn259NM4xxsM8jZoHaqo6ArnrEBX2NdufUViDfm1");

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, "utf8"))));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flagsOf = (k: { isSigner: boolean; isWritable: boolean }) => (k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0);

async function send(tx: Transaction, signers: Keypair[], label: string) {
  tx.feePayer = payer.publicKey;
  const s = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ${label}: ${s}`);
  return s;
}

function executeIx(vault: PublicKey, vaultId: Uint8Array, nonce: bigint, seed: Uint8Array, next: Uint8Array, inner: TransactionInstruction) {
  const parts: Uint8Array[] = [
    utf8("WNTR:EXEC"), vaultId, u64(nonce), inner.programId.toBytes(), Uint8Array.of(inner.keys.length),
  ];
  for (const k of inner.keys) parts.push(k.pubkey.toBytes(), Uint8Array.of(flagsOf(k)));
  parts.push(new Uint8Array(inner.data), next);
  const sig = sign(seed, keccak_256(cat(...parts)));
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: inner.programId, isSigner: false, isWritable: false },
      ...inner.keys.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable })),
    ],
    data: Buffer.concat([
      Buffer.of(3), next, sig, Buffer.of(inner.keys.length),
      Buffer.from(inner.keys.map(flagsOf)), Buffer.from(inner.data),
    ]),
  });
}

async function main() {
  const words = readFileSync(SEED_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join(" ");
  const master = masterFromMnemonic(words);
  const pk0 = publicKeyHash(keyAt(master, 0));
  const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk0)], VAULT_PROGRAM);

  console.log(`saldo  : ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`boveda : ${vault.toBase58()}\n`);

  /* ------------------------- 1. claim while on the curve ------------------------- */
  console.log("1. cobrando los fees de la curva ANTES de graduar");
  await claim(vault, pk0, master, "pre");

  /* -------------------------------- 2. migrate ---------------------------------- */
  console.log("\n2. graduando: migrando a DAMM v2");
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100];
  const m = await dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool: POOL, dammConfig });
  const tx = m.transaction;
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30_000 }));
  await send(tx, [payer, m.firstPositionNftKeypair, m.secondPositionNftKeypair], "migrateToDammV2");
  console.log("  liquidez bloqueada al 100%, para siempre");

  /* ------------------------ 3. claim from the locked LP ------------------------- */
  await sleep(4000);
  console.log("\n3. cobrando los fees DESPUES de graduar");
  await claim(vault, pk0, master, "post");

  const st: any = await dbc.state.getPool(POOL).catch(() => null);
  const s = st?.poolState ?? st?.account?.poolState ?? st;
  console.log(`\nisMigrated: ${String(s?.isMigrated)}`);
  console.log(`saldo restante: ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
}

/** One claim, wrapped in the vault, compressed with a lookup table, resent if dropped. */
async function claim(vault: PublicKey, pk0: Uint8Array, master: Uint8Array, tag: string) {
  const built = await dbc.partner.claimPartnerTradingFee({
    feeClaimer: vault, payer: payer.publicKey, pool: POOL,
    maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615"),
    receiver: payer.publicKey, tempWSolAcc: payer.publicKey,
  });
  const inner = built.instructions.find((i) => i.keys.some((k) => k.pubkey.equals(vault) && k.isSigner));
  if (!inner) { console.log("  nada que cobrar"); return; }

  const at = built.instructions.indexOf(inner);
  const pre = built.instructions.slice(0, at);
  if (pre.length) await send(new Transaction().add(...pre), [payer], "preparacion").catch(() => {});

  const info = await conn.getAccountInfo(vault);
  const nonce = info!.data.readBigUInt64LE(2);
  // Key n is derived from the master, so the vault can be driven from the seed
  // alone for as many signatures as it will ever need.
  const seed = keyAt(master, Number(nonce));
  const next = publicKeyHash(keyAt(master, Number(nonce) + 1));
  const wrapped = executeIx(vault, pk0, nonce, seed, next, inner);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), wrapped];

  const keys = new Map<string, PublicKey>();
  for (const ix of instructions) {
    keys.set(ix.programId.toBase58(), ix.programId);
    for (const k of ix.keys) keys.set(k.pubkey.toBase58(), k.pubkey);
  }
  const slot = await conn.getSlot("finalized");
  const [createIx, lut] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  await send(new Transaction().add(createIx, AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: [...keys.values()],
  })), [payer], "tabla");

  let table = null;
  for (let a = 0; a < 15 && !table; a++) {
    await sleep(1200);
    table = (await conn.getAddressLookupTable(lut)).value;
    if (table && table.state.addresses.length < keys.size) table = null;
  }
  if (!table) { console.log("  la tabla no se activo"); return; }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
    }).compileToV0Message([table]));
    vtx.sign([payer]);
    if (attempt === 1) console.log(`  transaccion de cobro: ${vtx.serialize().length} bytes`);
    try {
      const sig = await conn.sendTransaction(vtx, { maxRetries: 5 });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`  cobro ${tag}: ${sig}`);
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (/custom program error|Instruction \d/i.test(msg)) { console.log(`  rechazado: ${msg.slice(0, 160)}`); return; }
      await sleep(2500);
    }
  }
  console.log("  no confirmo");
}

main().catch((e) => { console.error(e); process.exit(1); });
