import { PublicKey } from "@solana/web3.js";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";

/**
 * Finds a token's bonding curve without scanning the program.
 *
 * getPoolByBaseMint is a getProgramAccounts call, and every serious RPC
 * throttles or refuses those. When it failed the caller could not tell
 * "this token has graduated" from "the lookup broke", and the difference
 * matters: one routes a buy to an aggregator, the other to the curve. Buys
 * were being sent to the wrong place, so the curve never advanced.
 *
 * The pool address is derivable, so this asks a direct question instead.
 */

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

export async function findPool(conn, program, mint, configsCsv) {
  const configs = String(configsCsv ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const base = new PublicKey(mint);

  const addresses = configs.map((c) => deriveDbcPoolAddress(WSOL, base, new PublicKey(c)));
  const infos = await conn.getMultipleAccountsInfo(addresses);

  for (const [i, info] of infos.entries()) {
    if (!info) continue;
    const decoded = program.coder.accounts.decode("virtualPool", info.data);
    const state = decoded.poolState ?? decoded;
    return {
      address: addresses[i],
      config: configs[i],
      state,
      migrated: Number(state.isMigrated ?? 0) > 0,
    };
  }
  return null;
}
