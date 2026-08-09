/**
 * Moves the collected fees out of the vault and into a normal wallet as SOL.
 *
 * Meteora pays in wrapped SOL, so the vault holds a token account rather than a
 * balance you can see in Phantom. Three steps get it out:
 *
 *   1. the vault signs an SPL transfer of its WSOL to the operator's account
 *   2. the operator closes that account, which unwraps it into real SOL
 *   3. the operator sends the SOL to the destination
 *
 * Step 1 is the one that needs a one-time Winternitz signature. Nothing leaves
 * the vault without it, which is the entire point of the vault.
 *
 *   npx tsx withdraw-fees.ts                    reports
 *   LIVE=1 npx tsx withdraw-fees.ts             withdraws to the default wallet
 *   LIVE=1 TO=<address> npx tsx withdraw-fees.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { readFileSync } from "node:fs";
import { publicKeyHash, sign, cat, utf8, u64 } from "../client/src/wots.js";
import { masterFromMnemonic, keyAt } from "../client/src/new-master-seed.js";

const RPC = process.env.RPC ?? "https://lb.drpc.live/solana/ArDEkRRjbE6Ro0VCg-jAk9L-69wEozoR76beFhW5UfFk";
const PAYER = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\mainnet-deployer.json";
const SEED_FILE = "C:\\Users\\zarne\\Desktop\\quantum-token\\MASTER-SEED.txt";
const VAULT_PROGRAM = new PublicKey("13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TO = new PublicKey(process.env.TO ?? "87nKpkAkMEL2aHt7wTxa2b9BNSWjKg7kNp67Y7sdfzhU");
const LIVE = Boolean(process.env.LIVE);

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flagsOf = (k: { isSigner: boolean; isWritable: boolean }) => (k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0);

const words = readFileSync(SEED_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join(" ");
const master = masterFromMnemonic(words);
const pk0 = publicKeyHash(keyAt(master, 0));
const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk0)], VAULT_PROGRAM);

const vaultWsol = getAssociatedTokenAddressSync(WSOL, vault, true);
const opWsol = getAssociatedTokenAddressSync(WSOL, payer.publicKey, false);

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

async function send(tx: Transaction, label: string) {
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  console.log(`   ${label}: ${sig}`);
  return sig;
}

async function main() {
  const bal = await conn.getTokenAccountBalance(vaultWsol).catch(() => null);
  const raw = BigInt(bal?.value.amount ?? "0");
  const sol = Number(raw) / 1e9;

  console.log(`boveda WSOL : ${sol} (cuenta ${vaultWsol.toBase58()})`);
  console.log(`destino     : ${TO.toBase58()}`);
  console.log(`saldo destino antes: ${(await conn.getBalance(TO)) / LAMPORTS_PER_SOL} SOL`);
  if (!LIVE) return console.log("\nSolo informe. Ejecuta con LIVE=1 para sacarlo.");
  if (raw === 0n) return console.log("\nNo hay nada que sacar.");

  console.log("\n1. la boveda firma la salida de su WSOL");
  const inner = createTransferInstruction(vaultWsol, opWsol, vault, raw, [], TOKEN_PROGRAM_ID);

  // The operator's wrapped-SOL account has to exist before the vault can send
  // to it, and creating it does not need the vault's signature.
  await send(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, opWsol, payer.publicKey, WSOL),
  ), "cuenta receptora").catch(() => {});

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
  await send(new Transaction().add(createIx, AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: [...keys.values()],
  })), "tabla");

  let table = null;
  for (let a = 0; a < 15 && !table; a++) {
    await sleep(1200);
    table = (await conn.getAddressLookupTable(lut)).value;
    if (table && table.state.addresses.length < keys.size) table = null;
  }
  if (!table) return console.log("   la tabla no se activo");

  let done = false;
  for (let attempt = 1; attempt <= 5 && !done; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
    }).compileToV0Message([table]));
    vtx.sign([payer]);
    try {
      const sig = await conn.sendTransaction(vtx, { maxRetries: 5 });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      console.log(`   firma cuantica OK: ${sig}`);
      done = true;
    } catch (e) {
      const m = (e as Error).message;
      if (/custom program error|Instruction \d/i.test(m)) return console.log(`   rechazado: ${m.slice(0, 180)}`);
      await sleep(2500);
    }
  }
  if (!done) return console.log("   no confirmo");

  console.log("\n2. desenvolviendo a SOL de verdad y enviando");
  const before = await conn.getBalance(payer.publicKey);
  await send(new Transaction().add(
    createCloseAccountInstruction(opWsol, payer.publicKey, payer.publicKey),
  ), "desenvolver");
  const gained = (await conn.getBalance(payer.publicKey)) - before;
  const toSend = Math.max(0, gained - 10_000);
  if (toSend > 0) {
    await send(new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: TO, lamports: toSend }),
    ), `enviados ${(toSend / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }

  console.log(`\nsaldo destino ahora: ${(await conn.getBalance(TO)) / LAMPORTS_PER_SOL} SOL`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
