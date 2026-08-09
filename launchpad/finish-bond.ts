/**
 * Takes one live token the rest of the way: buy until the curve completes,
 * migrate it, and check that it is tradeable afterwards.
 *
 * Runs against mainnet with real SOL, through the same endpoints the website
 * uses, so what is verified here is what a user would actually get.
 */

import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient, MigrationFeeOption, DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://lb.drpc.live/solana/ArDEkRRjbE6Ro0VCg-jAk9L-69wEozoR76beFhW5UfFk";
const PAYER = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\mainnet-deployer.json";
const MINT = process.env.MINT ?? "2GT1uaDRewahpdiuNBCDBTtcehniY6KwVAnVpaeQUANT";
const CONFIG = new PublicKey("AJmWcxmjBvqMV24ZByvgpcoReuQzHNGvSs1GoHN63www");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SITE = "https://winternitz.io";

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER, "utf8"))));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = deriveDbcPoolAddress(WSOL, new PublicKey(MINT), CONFIG);

async function state() {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error("no existe ese pool");
  const d: any = dbc.state.getProgram().coder.accounts.decode("virtualPool", info.data);
  return d.poolState ?? d;
}

/** Buys through the site's own endpoint, so the test exercises the real path. */
async function buyViaSite(amount: number) {
  const r = await fetch(`${SITE}/api/swap`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mint: MINT, amount, side: "buy", wallet: payer.publicKey.toBase58() }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(j.error);
  const tx = Transaction.from(Buffer.from(j.transaction, "base64"));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25_000 }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  return { sig, route: j.route };
}

async function main() {
  console.log(`token : ${MINT}`);
  console.log(`pool  : ${pool.toBase58()}`);
  console.log(`saldo : ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

  let st = await state();
  const threshold = 5;
  let raised = Number(st.quoteReserve) / 1e9;
  console.log(`1. curva al ${(raised / threshold * 100).toFixed(2)}% (${raised.toFixed(4)} / ${threshold} SOL)`);

  // Overshoot on purpose: partial fill takes only what fits, so asking for more
  // than is left is the reliable way to land exactly on the threshold.
  for (let i = 0; i < 6 && raised < threshold - 0.000001; i++) {
    const missing = threshold - raised;
    const ask = Math.min(missing * 1.5 + 0.01, 1);
    const { sig, route } = await buyViaSite(ask);
    console.log(`   compra de ${ask.toFixed(4)} SOL [${route}]: ${sig.slice(0, 22)}..`);
    await sleep(2500);
    st = await state();
    raised = Number(st.quoteReserve) / 1e9;
    console.log(`   ahora ${(raised / threshold * 100).toFixed(2)}%`);
  }

  if (raised < threshold - 0.000001) { console.log("no se pudo completar la curva"); return; }
  console.log("   curva COMPLETA\n");

  console.log("2. migrando");
  if (Number(st.isMigrated ?? 0) > 0) {
    console.log("   ya estaba migrado");
  } else {
    const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100];
    const m = await dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig });
    m.transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30_000 }));
    m.transaction.feePayer = payer.publicKey;
    const sig = await sendAndConfirmTransaction(conn, m.transaction,
      [payer, m.firstPositionNftKeypair, m.secondPositionNftKeypair], { commitment: "confirmed" });
    console.log(`   migrateToDammV2: ${sig}`);
  }

  await sleep(4000);
  st = await state();
  console.log(`   isMigrated: ${String(st.isMigrated)}`);

  console.log("\n3. comprobando que se puede comprar despues de graduar");
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${SITE}/api/swap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mint: MINT, amount: 0.02, side: "buy", wallet: payer.publicKey.toBase58() }),
    });
    const j: any = await r.json();
    if (j.route === "pool" && j.transaction) { console.log(`   ruta [pool], recibirias ${Number(j.out ?? 0).toFixed(0)} tokens`); break; }
    console.log(`   todavia no hay ruta (${j.error ?? j.route}), reintento`);
    await sleep(6000);
  }

  console.log(`\nsaldo restante: ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
