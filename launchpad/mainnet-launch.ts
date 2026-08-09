/**
 * Creates the launchpad on mainnet and launches the first token.
 *
 * This is the rehearsed path, run for real: open the vault, create the Meteora
 * config with that vault as the permanent fee claimer, and launch a token on a
 * pre-ground QUANT address.
 *
 * The threshold is 5 SOL because this config is for TESTING. Its fee claimer
 * is derived from a seed that was shown in a chat, so it must never hold the
 * project's real income. The production config gets a fresh seed generated on
 * a machine, never displayed, and its own threshold.
 *
 *   npx tsx mainnet-launch.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient, buildCurve, TokenType, TokenDecimal, TokenAuthorityOption,
  CollectFeeMode, BaseFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicKeyHash, utf8, hex } from "../client/src/wots.js";
import { masterFromMnemonic, keyAt } from "../client/src/new-master-seed.js";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const PAYER_PATH = "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\mainnet-deployer.json";
const VAULT_PROGRAM = new PublicKey("13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SEED_FILE = "C:\\Users\\zarne\\Desktop\\quantum-token\\MASTER-SEED.txt";
const KEYS_DIR = join(process.cwd(), "keys");

const THRESHOLD_SOL = Number(process.env.THRESHOLD ?? 40);
const NAME = "Winternitz One";
const SYMBOL = "WNTR1";

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const payer = load(PAYER_PATH);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(tx: Transaction, signers: Keypair[], label: string) {
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ${label}: ${sig}`);
  return sig;
}

async function main() {
  const words = readFileSync(SEED_FILE, "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join(" ");
  const master = masterFromMnemonic(words);
  const pk0 = publicKeyHash(keyAt(master, 0));
  const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk0)], VAULT_PROGRAM);

  const balance = await conn.getBalance(payer.publicKey);
  console.log(`pagador : ${payer.publicKey.toBase58()}`);
  console.log(`saldo   : ${balance / LAMPORTS_PER_SOL} SOL`);
  console.log(`boveda  : ${vault.toBase58()}`);
  console.log(`umbral  : ${THRESHOLD_SOL} SOL (config de PRUEBAS)\n`);
  if (balance < 0.15 * LAMPORTS_PER_SOL) throw new Error("saldo insuficiente");

  /* ------------------------------- vault ------------------------------- */
  if (await conn.getAccountInfo(vault)) {
    console.log("1. la boveda ya existe");
  } else {
    console.log("1. abriendo la boveda");
    await send(new Transaction().add(new TransactionInstruction({
      programId: VAULT_PROGRAM,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: WSOL, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.of(0), pk0]),
    })), [payer], "initialize");
  }

  /* ------------------------------- config ------------------------------ */
  console.log("\n2. creando la config de Meteora");
  const curve = buildCurve({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 150, endingFeeBps: 150, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 33, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot, percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: THRESHOLD_SOL,
  });

  const configKp = Keypair.generate();
  await send(await dbc.partner.createConfig({
    config: configKp.publicKey, feeClaimer: vault, leftoverReceiver: payer.publicKey,
    quoteMint: WSOL, payer: payer.publicKey, ...curve,
  }), [payer, configKp], "createConfig");

  const onchain: any = await dbc.state.getPoolConfig(configKp.publicKey);
  const claimer = onchain?.feeClaimer?.toBase58?.();
  console.log(`  feeClaimer on-chain: ${claimer}`);
  if (claimer !== vault.toBase58()) throw new Error("el feeClaimer no es la boveda, abortando");

  /* -------------------------------- token ------------------------------ */
  console.log("\n3. lanzando el primer token");
  let mintKp: Keypair | null = null;
  for (const f of readdirSync(KEYS_DIR).filter((x) => x.endsWith(".json"))) {
    const kp = load(join(KEYS_DIR, f));
    if (!(await conn.getAccountInfo(kp.publicKey))) { mintKp = kp; break; }
  }
  if (!mintKp) throw new Error("sin claves QUANT libres");
  console.log(`  mint: ${mintKp.publicKey.toBase58()}`);

  const tx = await dbc.creator.createPool({
    name: NAME, symbol: SYMBOL, uri: "https://winternitz.io/meta/wntr1.json",
    payer: payer.publicKey, poolCreator: payer.publicKey,
    config: configKp.publicKey, baseMint: mintKp.publicKey,
  });
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }));
  await send(tx, [payer, mintKp], "createPool");

  let pool: any = null;
  for (let i = 0; i < 10 && !pool; i++) {
    pool = await dbc.state.getPoolByBaseMint(mintKp.publicKey).catch(() => null);
    if (!pool) await sleep(1500);
  }
  const poolAddr = (pool?.publicKey ?? pool?.address) as PublicKey;

  const out = {
    cluster: "mainnet",
    vaultProgram: VAULT_PROGRAM.toBase58(),
    vault: vault.toBase58(),
    pk0: hex(pk0),
    config: configKp.publicKey.toBase58(),
    mint: mintKp.publicKey.toBase58(),
    pool: poolAddr?.toBase58() ?? null,
    thresholdSol: THRESHOLD_SOL,
    note: "config de PRUEBAS: su semilla se mostro en un chat",
  };
  writeFileSync(join(process.cwd(), "mainnet-test.json"), JSON.stringify(out, null, 2) + "\n");

  console.log("\n--- EN MAINNET ---");
  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(14)} ${v}`);
  console.log(`\nsaldo restante: ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`\ncomprar: https://jup.ag/swap/SOL-${out.mint}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
