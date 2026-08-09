/**
 * Sells the test tokens back into their curves to get the devnet SOL out.
 *
 * Every rehearsal bought its way up a bonding curve, and that SOL is not spent,
 * it is sitting in the curve holding the tokens I got back. Selling returns it,
 * minus the fee on each leg.
 *
 *   RPC=https://api.devnet.solana.com npx tsx recover-devnet.ts
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.PAYER ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\id.json";

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, "utf8"))));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const before = await conn.getBalance(payer.publicKey);
  console.log(`saldo inicial: ${before / LAMPORTS_PER_SOL} SOL\n`);

  const accounts = await conn.getParsedTokenAccountsByOwner(payer.publicKey, { programId: TOKEN_PROGRAM_ID });
  const held = accounts.value
    .map((a) => ({ mint: a.account.data.parsed.info.mint as string, raw: a.account.data.parsed.info.tokenAmount.amount as string }))
    .filter((t) => BigInt(t.raw) > 0n);

  console.log(`${held.length} token(s) con saldo\n`);

  let recovered = 0;
  for (const t of held) {
    const mint = new PublicKey(t.mint);
    const pool: any = await dbc.state.getPoolByBaseMint(mint).catch(() => null);
    if (!pool) { console.log(`${t.mint.slice(0, 8)}.. sin curva, se queda`); continue; }
    const poolAddr = (pool.publicKey ?? pool.address) as PublicKey;

    const balBefore = await conn.getBalance(payer.publicKey);
    try {
      const tx = await dbc.pool.swap({
        owner: payer.publicKey, pool: poolAddr,
        amountIn: new BN(t.raw), minimumAmountOut: new BN(0),
        swapBaseForQuote: true,           // <- selling back
        referralTokenAccount: null,
      });
      tx.feePayer = payer.publicKey;
      await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      const got = (await conn.getBalance(payer.publicKey)) - balBefore;
      recovered += got;
      console.log(`${t.mint.slice(0, 8)}.. vendido, +${(got / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e) {
      // A curve that already completed will not buy its tokens back.
      console.log(`${t.mint.slice(0, 8)}.. no se pudo vender: ${(e as Error).message.slice(0, 60)}`);
    }
    await sleep(900);
  }

  const after = await conn.getBalance(payer.publicKey);
  console.log(`\nrecuperado: ${(recovered / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`saldo final: ${after / LAMPORTS_PER_SOL} SOL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
