import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { findPool } from "./_pool.js";

/**
 * Builds a buy or sell and returns it unsigned, so trading happens on this
 * site instead of bouncing the user to Jupiter.
 *
 * A token lives in two different places over its life and the route has to
 * follow it: while it is on the curve only Meteora's bonding curve program can
 * fill an order, and once it graduates the liquidity is in a normal pool that
 * aggregators can reach. The caller should not have to know which.
 */

const RPC = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const WSOL = "So11111111111111111111111111111111111111112";
// quote-api.jup.ag/v6 is gone; the free public endpoint is lite-api, and the
// keyed one is api.jup.ag. Both speak the same swap/v1 shape.
const JUP = process.env.JUP_API ?? "https://lite-api.jup.ag/swap/v1";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "usa POST" });

  try {
    const { mint, amount, side, wallet, slippageBps = 300 } = req.body ?? {};
    if (!mint || !wallet) return res.status(400).json({ error: "faltan datos" });

    const selling = side === "sell";
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: "importe invalido" });

    const conn = new Connection(RPC, "confirmed");
    const owner = new PublicKey(wallet);
    const baseMint = new PublicKey(mint);

    const dbc = new DynamicBondingCurveClient(conn, "confirmed");
    const found = await findPool(conn, dbc.state.getProgram(), baseMint, process.env.DBC_CONFIG);
    const migrated = found ? found.migrated : true;

    /* ------------------------- still on the curve ------------------------- */
    if (found && !migrated) {
      const pool = found.address;
      // Selling is denominated in tokens, buying in SOL.
      const decimals = selling ? 6 : 9;

      // A plain ExactIn buy that would carry the curve past its graduation
      // threshold is rejected outright rather than filled up to the line, which
      // is why a token could sit at 4.99 of 5 and refuse every further buy.
      // PartialFill takes only what the curve can still absorb.
      const tx = await dbc.pool.swap2({
        owner, pool,
        swapMode: selling ? SwapMode.ExactIn : SwapMode.PartialFill,
        amountIn: new BN(Math.round(amt * 10 ** decimals)),
        minimumAmountOut: new BN(0),
        swapBaseForQuote: selling,
        referralTokenAccount: null,
      });
      tx.feePayer = owner;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      return res.status(200).json({
        route: "curve",
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        versioned: false,
      });
    }

    /* --------------------------- graduated pool --------------------------- */
    const inputMint = selling ? mint : WSOL;
    const outputMint = selling ? WSOL : mint;
    const raw = Math.round(amt * 10 ** (selling ? 6 : 9));

    const quote = await fetch(
      `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${raw}&slippageBps=${slippageBps}`,
    ).then((r) => r.json());
    if (!quote || quote.error || !quote.outAmount) {
      return res.status(502).json({ error: "no hay ruta de intercambio todavia", detail: quote?.error ?? null });
    }

    const swap = await fetch(`${JUP}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    }).then((r) => r.json());
    if (!swap?.swapTransaction) return res.status(502).json({ error: "no se pudo construir el intercambio" });

    // Sanity check that what came back is a transaction we can hand to a wallet.
    try { VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64")); }
    catch { return res.status(502).json({ error: "el agregador devolvio algo ilegible" }); }

    return res.status(200).json({
      route: "pool",
      transaction: swap.swapTransaction,
      versioned: true,
      out: Number(quote.outAmount) / 10 ** (selling ? 9 : 6),
      impactPct: Number(quote.priceImpactPct ?? 0) * 100,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message ?? e).slice(0, 250) });
  }
}
