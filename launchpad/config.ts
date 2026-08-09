/**
 * Winternitz launchpad: the partner config every token launched here inherits.
 *
 * The curve, the pool and the migration are Meteora's Dynamic Bonding Curve.
 * We deliberately write no contract that custodies anyone's money: the one
 * piece that is ours is the Winternitz vault, and it sits where the value
 * accumulates rather than where the trading happens.
 *
 * Economics, and the reasoning behind each number:
 *
 *   Fee to the trader        1.5%
 *     ├─ Meteora protocol    0.3%   (20% of the fee, same 0.25-0.3 band Raydium
 *     │                              and Uniswap charge; unavoidable short of
 *     │                              writing our own curve)
 *     ├─ Platform (us)       0.8%
 *     └─ Creator             0.4%
 *
 * A creator fee on Meteora comes OUT of the fee, it is not stacked on top the
 * way Raydium does it. Paying the creator 0.5% net would have meant charging
 * 1.875%, which would make this the most expensive launchpad on Solana and
 * cost more in lost volume than it earns. 1.5% still undercuts Raydium's own
 * documented 1.75% example while paying creators a real share.
 *
 * Raising a fee later is easy. Winning back traders who left because you were
 * expensive is not.
 *
 * Run: npx tsx launchpad/config.ts            (devnet)
 *      WNTR_CLUSTER=mainnet npx tsx launchpad/config.ts
 */

import { PublicKey } from "@solana/web3.js";
import { pathToFileURL } from "node:url";
import {
  buildCurve,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
  ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/* --------------------------------- knobs --------------------------------- */

/** Total taken from each trade, in basis points. */
export const FEE_BPS = 150;

/**
 * The creator's cut, as a percentage of the fee left after Meteora's share.
 * 33% of the remaining 1.2% is 0.4% to the creator and 0.8% to us.
 */
export const CREATOR_FEE_PERCENTAGE = 33;

export const SUPPLY_TOTAL = 1_000_000_000;

/** Share of supply that goes into the pool at graduation; the rest sells on the curve. */
export const SUPPLY_ON_MIGRATION_PCT = 20;

/** SOL that has to enter the curve before it graduates into a real pool. */
export const MIGRATION_THRESHOLD_SOL = 40;

const CLUSTER = process.env.WNTR_CLUSTER === "mainnet" ? "mainnet" : "devnet";
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

/* ---------------------------- who gets paid ---------------------------- */

export const VAULT_PROGRAM = new PublicKey("HBHP37mXs86kxn8i5twKiPkvtZWx2wDyUEUGVQAo72Da");

/**
 * Every lamport this launchpad ever earns arrives here: the trading fees from
 * every curve and the fees from every locked LP after graduation. There is no
 * `updateFeeClaimer` in the SDK, so this address is permanent for every token
 * launched under this config.
 *
 * That is the reason it must not be an ordinary wallet. One Ed25519 key would
 * become the single point of failure for the entire business, and it is the
 * exact claim the site makes about not being that.
 *
 * Derive it from the vault's first public key hash:
 *   PublicKey.findProgramAddressSync([Buffer.from("vault"), pk0], VAULT_PROGRAM)
 *
 * Collecting then goes through the vault's `execute` instruction, which CPIs
 * into Meteora and needs a one-time Winternitz signature per claim.
 */
export const FEE_CLAIMER: PublicKey | null = null; // set once the vault seed is decided

/**
 * Leftovers from a curve that never graduated. Small, occasional, and not
 * worth a one-time signature, so an ordinary wallet is the right tool.
 */
export const LEFTOVER_RECEIVER = new PublicKey("87nKpkAkMEL2aHt7wTxa2b9BNSWjKg7kNp67Y7sdfzhU");

export const curveConfig = buildCurve({
  token: {
    tokenType: TokenType.SPLToken,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE, // SOL
    // DBC mints the whole supply up front and leaves no mint authority. That
    // is why the vault guards the treasury and the fee claimer instead: with
    // an immutable token there is no mint authority left to protect.
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: SUPPLY_TOTAL,
    leftover: 0,
  },

  fee: {
    baseFeeParams: {
      // A flat fee. A scheduler that starts high to punish snipers is worth
      // revisiting, but only once there is real launch data to tune it with.
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: {
        startingFeeBps: FEE_BPS,
        endingFeeBps: FEE_BPS,
        numberOfPeriod: 0,
        totalDuration: 0,
      },
    },
    dynamicFeeEnabled: false,
    // Collect in SOL, not in the launched token: fees in a token that may go
    // to zero are not revenue.
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: CREATOR_FEE_PERCENTAGE,
    poolCreationFee: 0, // launching must be free, that is the whole point
    enableFirstSwapWithMinFee: false,
  },

  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },

  // 100% permanently locked. Nobody, us included, can pull the liquidity.
  // A locked LP also has no owning key, which makes it the one part of this
  // system that a quantum computer has nothing to attack.
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 100,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
  },

  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },

  activationType: ActivationType.Slot,
  percentageSupplyOnMigration: SUPPLY_ON_MIGRATION_PCT,
  migrationQuoteThreshold: MIGRATION_THRESHOLD_SOL,
});

/* -------------------------------- summary -------------------------------- */

export function describe(): string {
  const meteora = FEE_BPS * 0.2;
  const rest = FEE_BPS - meteora;
  const creator = (rest * CREATOR_FEE_PERCENTAGE) / 100;
  const platform = rest - creator;
  return [
    `fee al trader   ${(FEE_BPS / 100).toFixed(2)}%`,
    `  meteora       ${(meteora / 100).toFixed(2)}%`,
    `  plataforma    ${(platform / 100).toFixed(2)}%`,
    `  creador       ${(creator / 100).toFixed(2)}%`,
    `umbral          ${MIGRATION_THRESHOLD_SOL} SOL`,
    `supply          ${SUPPLY_TOTAL.toLocaleString("es-ES")} · ${SUPPLY_ON_MIGRATION_PCT}% al pool`,
    `LP              100% bloqueado permanentemente`,
  ].join("\n");
}

// pathToFileURL rather than string surgery: a Windows path produces
// file:///C:/... with three slashes, which no hand-built prefix matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`[${CLUSTER}]`);
  console.log(describe());
  console.log("\nquote mint:", WSOL.toBase58());
  console.log("\nEsto solo imprime la config. Desplegarla es un paso aparte:");
  console.log("  dbc.partner.createConfig({ config, feeClaimer, leftoverReceiver, quoteMint, payer, ...curveConfig })");
  console.log("leftoverReceiver:", LEFTOVER_RECEIVER.toBase58());
  console.log("feeClaimer      :", FEE_CLAIMER ? FEE_CLAIMER.toBase58() : "PENDIENTE (boveda Winternitz)");
  if (!FEE_CLAIMER) {
    console.log("\nNO despliegues sin esto: feeClaimer es permanente, el SDK no tiene forma de cambiarlo.");
  }
}
