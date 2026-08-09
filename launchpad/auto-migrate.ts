/**
 * Migrates any token whose curve has completed.
 *
 * A finished curve cannot be bought from, and until it is migrated the pool it
 * would migrate into does not exist either, so the token is unbuyable in both
 * places at once. Every attempt returns an error and it reads to a user as a
 * broken launchpad. Nothing on chain does this by itself; somebody has to call
 * it, and that somebody is this.
 *
 *   npx tsx auto-migrate.ts          checks and migrates once
 *   WATCH=1 npx tsx auto-migrate.ts  keeps watching
 */

import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient, MigrationFeeOption,
  DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://lb.drpc.live/solana/ArDEkRRjbE6Ro0VCg-jAk9L-69wEozoR76beFhW5UfFk";
const PAYER = process.env.PAYER ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\mainnet-deployer.json";
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SITE = "https://winternitz.io";
const WATCH = Boolean(process.env.WATCH);
const EVERY = Number(process.env.EVERY ?? 30) * 1000;

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER, "utf8"))));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const program = dbc.state.getProgram();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

/** The board already knows every token and its config; reuse it. */
async function board() {
  const r = await fetch(`${SITE}/api/tokens`, { headers: { "cache-control": "no-cache" } });
  const j: any = await r.json();
  return { tokens: j.tokens ?? [], configs: j.configs ?? [] };
}

async function poolFor(mint: string, configs: string[]) {
  for (const c of configs) {
    const address = deriveDbcPoolAddress(WSOL, new PublicKey(mint), new PublicKey(c));
    const info = await conn.getAccountInfo(address);
    if (!info) continue;
    const d: any = program.coder.accounts.decode("virtualPool", info.data);
    return { address, state: d.poolState ?? d };
  }
  return null;
}

async function migrate(mint: string, pool: PublicKey) {
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100];
  const m = await dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig });
  m.transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40_000 }));
  m.transaction.feePayer = payer.publicKey;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(
        conn, m.transaction, [payer, m.firstPositionNftKeypair, m.secondPositionNftKeypair],
        { commitment: "confirmed" },
      );
      console.log(`[${now()}] ${mint.slice(0, 6)}.. MIGRADO ${sig}`);
      return true;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // "Block height exceeded" means the confirmation timed out, not that the
      // migration failed; the next pass will see it already done.
      if (/expired|block height/i.test(msg)) {
        console.log(`[${now()}] ${mint.slice(0, 6)}.. confirmacion caducada, se revisara luego`);
        return false;
      }
      if (attempt === 3) console.log(`[${now()}] ${mint.slice(0, 6)}.. fallo: ${msg.slice(0, 140)}`);
      await sleep(3000);
    }
  }
  return false;
}

async function pass() {
  const { tokens, configs } = await board();
  const balance = await conn.getBalance(payer.publicKey);
  const ready = [];

  for (const t of tokens) {
    if (t.migrated) continue;
    const p = await poolFor(t.mint, configs);
    if (!p) continue;
    const raised = Number(p.state.quoteReserve ?? 0) / 1e9;
    // Compare against the threshold rather than the reported percentage: the
    // board rounds, and "99.99%" and "done" must not be confused.
    if (raised + 1e-9 >= t.threshold) ready.push({ ...t, pool: p.address, raised });
  }

  if (!ready.length) {
    console.log(`[${now()}] nada que migrar (${tokens.length} tokens, ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL)`);
    return;
  }

  for (const t of ready) {
    console.log(`[${now()}] ${t.symbol ?? "?"} completo (${t.raised.toFixed(4)}/${t.threshold}), migrando`);
    if (balance < 0.05 * LAMPORTS_PER_SOL) {
      console.log(`[${now()}] SIN FONDOS para migrar, hace falta recargar ${payer.publicKey.toBase58()}`);
      return;
    }
    await migrate(t.mint, t.pool);
    await sleep(2000);
  }
}

async function main() {
  console.log(`migrador automatico · pagador ${payer.publicKey.toBase58()}`);
  do {
    await pass().catch((e) => console.log(`[${now()}] error: ${(e as Error).message.slice(0, 140)}`));
    if (WATCH) await sleep(EVERY);
  } while (WATCH);
}

main().catch((e) => { console.error(e); process.exit(1); });
