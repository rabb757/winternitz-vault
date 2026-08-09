import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { findPool } from "./_pool.js";

/**
 * Lets the creator of a token collect their share of the trading fees.
 *
 * 0.4% of every trade accrues to whoever launched the token, and until now
 * there was no way to take it out: the money was piling up in the pool with
 * nobody able to move it. The creator signs with their own wallet, so this
 * only builds the transaction and hands it back.
 */

const RPC = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const U64_MAX = "18446744073709551615";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "usa POST" });

  try {
    const { mint, wallet } = req.body ?? {};
    if (!mint || !wallet) return res.status(400).json({ error: "faltan datos" });

    const conn = new Connection(RPC, "confirmed");
    const creator = new PublicKey(wallet);
    const dbc = new DynamicBondingCurveClient(conn, "confirmed");

    const found = await findPool(conn, dbc.state.getProgram(), mint, process.env.DBC_CONFIG);
    if (!found) return res.status(404).json({ error: "ese token no esta en el launchpad" });

    const { state, address: pool } = found;

    // Only the creator can claim, and the chain would reject anyone else
    // anyway; failing here saves the user a rejected signature prompt.
    if (String(state.creator) !== creator.toBase58()) {
      return res.status(403).json({ error: "esa wallet no creo este token" });
    }

    const pending = Number(state.creatorQuoteFee ?? 0) / 1e9;
    if (!(pending > 0)) return res.status(200).json({ pending: 0, transaction: null });

    const tx = await dbc.creator.claimCreatorTradingFee({
      creator, payer: creator, pool,
      maxBaseAmount: new BN(0), maxQuoteAmount: new BN(U64_MAX),
      receiver: creator, tempWSolAcc: creator,
    });
    tx.feePayer = creator;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;

    return res.status(200).json({
      pending,
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message ?? e).slice(0, 250) });
  }
}
