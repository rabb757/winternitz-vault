/**
 * Sweeps the platform's trading fees into the vault itself.
 *
 * Until now the claim was authorised by the vault but paid out to an ordinary
 * hot wallet, which meant the Winternitz signature protected the permission and
 * not the money. Sending the proceeds to the vault closes that gap: once inside,
 * the only way out is a one-time signature.
 *
 *   npx tsx claim-to-vault.ts            reports what is claimable
 *   LIVE=1 npx tsx claim-to-vault.ts     actually claims it
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { publicKeyHash, sign, cat, utf8, u64 } from "../client/src/wots.js";
import { masterFromMnemonic, keyAt } from "../client/src/new-master-seed.js";

const RPC = process.env.RPC ?? "https://lb.drpc.live/solana/ArDEkRRjbE6Ro0VCg-jAk9L-69wEozoR76beFhW5UfFk";
const PAYER = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\mainnet-deployer.json";
const SEED_FILE = "C:\\Users\\zarne\\Desktop\\quantum-token\\MASTER-SEED.txt";
const VAULT_PROGRAM = new PublicKey("13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const CONFIGS = [
  "AJmWcxmjBvqMV24ZByvgpcoReuQzHNGvSs1GoHN63www",
  "H1kkWgTd4fApHToei2m3ycgwVtBt7QR6v2dourLoZdHW",
];
const MINTS = (process.env.SEED_MINTS ?? [
  "287s2QVf7DCzJNn4B8TeZmtXS2FRV12B2ArSF6BQUANT",
  "2cNxQVontJsWqXeUCyj2qfmDZznVi28mA937cLcQUANT",
  "2dEiKAF6oWNnq4BxGKTwxPATr9dWW7DsCe7YgAXQUANT",
  "2fJAxBnbC8CytPDaqrCYmR4G6RRmP21dCY6RFR9QUANT",
  "2CTfu8arZbA7s1W6PitzwpHU9Uz51axChydDYs4QUANT",
  "2GT1uaDRewahpdiuNBCDBTtcehniY6KwVAnVpaeQUANT",
].join(",")).split(",").map((m) => m.trim()).filter(Boolean);

const LIVE = Boolean(process.env.LIVE);
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER, "utf8"))));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const program = dbc.state.getProgram();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flagsOf = (k: { isSigner: boolean; isWritable: boolean }) => (k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0);

const words = readFileSync(SEED_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join(" ");
const master = masterFromMnemonic(words);
const pk0 = publicKeyHash(keyAt(master, 0));
const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk0)], VAULT_PROGRAM);

function executeIx(nonce: bigint, inner: TransactionInstruction) {
  const seed = keyAt(master, Number(nonce));
  const next = publicKeyHash(keyAt(master, Number(nonce) + 1));
  const parts: Uint8Array[] = [
    utf8("WNTR:EXEC"), pk0, u64(nonce), inner.programId.toBytes(), Uint8Array.of(inner.keys.length),
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

async function poolOf(mint: string) {
  for (const c of CONFIGS) {
    const a = deriveDbcPoolAddress(WSOL, new PublicKey(mint), new PublicKey(c));
    const info = await conn.getAccountInfo(a);
    if (!info) continue;
    const d: any = program.coder.accounts.decode("virtualPool", info.data);
    return { address: a, state: d.poolState ?? d };
  }
  return null;
}

async function claim(mint: string, pool: PublicKey) {
  // receiver is the vault, not the hot wallet: the whole point is that what
  // the vault collects can only leave with a one-time signature.
  const built = await dbc.partner.claimPartnerTradingFee({
    feeClaimer: vault, payer: payer.publicKey, pool,
    maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615"),
    receiver: vault, tempWSolAcc: vault,
  });

  const inner = built.instructions.find((i) => i.keys.some((k) => k.pubkey.equals(vault) && k.isSigner));
  if (!inner) { console.log("   nada que firmar"); return false; }

  const pre = built.instructions.slice(0, built.instructions.indexOf(inner));
  if (pre.length) {
    const t = new Transaction().add(...pre);
    t.feePayer = payer.publicKey;
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" }).catch(() => {});
  }

  const info = await conn.getAccountInfo(vault);
  const nonce = info!.data.readBigUInt64LE(2);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), executeIx(nonce, inner)];

  const keys = new Map<string, PublicKey>();
  for (const ix of instructions) {
    keys.set(ix.programId.toBase58(), ix.programId);
    for (const k of ix.keys) keys.set(k.pubkey.toBase58(), k.pubkey);
  }
  const slot = await conn.getSlot("finalized");
  const [createIx, lut] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  const t = new Transaction().add(createIx, AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: [...keys.values()],
  }));
  t.feePayer = payer.publicKey;
  await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });

  let table = null;
  for (let a = 0; a < 15 && !table; a++) {
    await sleep(1200);
    table = (await conn.getAddressLookupTable(lut)).value;
    if (table && table.state.addresses.length < keys.size) table = null;
  }
  if (!table) { console.log("   la tabla no se activo"); return false; }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
    }).compileToV0Message([table]));
    vtx.sign([payer]);
    if (attempt === 1) console.log(`   transaccion: ${vtx.serialize().length} bytes`);
    try {
      const sig = await conn.sendTransaction(vtx, { maxRetries: 5 });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`   cobrado: ${sig}`);
      return true;
    } catch (e) {
      const m = (e as Error).message;
      if (/custom program error|Instruction \d/i.test(m)) { console.log(`   rechazado: ${m.slice(0, 170)}`); return false; }
      await sleep(2500);
    }
  }
  console.log("   no confirmo");
  return false;
}

async function main() {
  console.log(`boveda : ${vault.toBase58()}`);
  const before = await conn.getBalance(vault);
  console.log(`saldo  : ${before / LAMPORTS_PER_SOL} SOL`);
  console.log(`modo   : ${LIVE ? "*** COBRANDO DE VERDAD ***" : "solo informe"}\n`);

  let total = 0;
  for (const mint of MINTS) {
    const p = await poolOf(mint);
    if (!p) { console.log(`${mint.slice(0, 6)}.. sin pool`); continue; }
    const pending = Number(p.state.partnerQuoteFee ?? 0) / 1e9;
    total += pending;
    console.log(`${mint.slice(0, 6)}..  ${pending.toFixed(5)} SOL`);
    if (LIVE && pending > 0.0005) await claim(mint, p.address);
  }

  console.log(`\npendiente total: ${total.toFixed(5)} SOL`);
  // Meteora pays in wrapped SOL, so the money lands in the vault's token
  // account, not its lamport balance. Reporting the lamports made a successful
  // claim look like nothing had arrived.
  const wsolAta = PublicKey.findProgramAddressSync(
    [vault.toBytes(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBytes(), WSOL.toBytes()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0];
  const held = await conn.getTokenAccountBalance(wsolAta).catch(() => null);
  console.log(`boveda WSOL    : ${held?.value.uiAmount ?? 0} (cuenta ${wsolAta.toBase58()})`);
  console.log(`boveda lamports: ${(await conn.getBalance(vault)) / LAMPORTS_PER_SOL} SOL (solo alquiler)`);
  if (!LIVE) console.log("\nNada se ha movido. Ejecuta con LIVE=1 para cobrar.");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
