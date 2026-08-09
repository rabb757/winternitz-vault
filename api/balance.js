import { Connection, PublicKey } from "@solana/web3.js";

/**
 * What the user actually holds, so the trade box can show a balance and offer
 * a percentage of it instead of asking for a number out of thin air.
 */

const RPC = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export default async function handler(req, res) {
  try {
    const { wallet, mint } = req.query ?? {};
    if (!wallet) return res.status(400).json({ error: "falta la wallet" });

    const conn = new Connection(RPC, "confirmed");
    const owner = new PublicKey(wallet);

    const [lamports, tokenAccounts] = await Promise.all([
      conn.getBalance(owner),
      mint
        ? conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }).catch(() => ({ value: [] }))
        : Promise.resolve({ value: [] }),
    ]);

    const token = tokenAccounts.value.reduce(
      (sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ sol: lamports / 1e9, token });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) });
  }
}
