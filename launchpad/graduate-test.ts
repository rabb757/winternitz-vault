/**
 * The one thing never tested: fees AFTER graduation.
 *
 * The rehearsal proved the vault can claim while a token is still on the
 * curve. What nobody has checked is the case that matters for years rather
 * than days: once the curve graduates, the liquidity is permanently locked in
 * a DAMM v2 pool, and the fees it earns have to keep reaching the vault.
 *
 * If that does not work, the whole "locked, not burned, and we still collect"
 * argument is wrong, and the mainnet config would lock the mistake in forever
 * because a fee claimer cannot be changed.
 *
 * Threshold is 0.5 SOL so the graduation is affordable on a faucet budget.
 *
 *   npx tsx graduate-test.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SystemProgram,
  AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient, buildCurve, TokenType, TokenDecimal, TokenAuthorityOption,
  CollectFeeMode, BaseFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
  SwapMode, DAMM_V2_MIGRATION_FEE_ADDRESS,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { publicKeyHash, sign, cat, utf8, u64 } from "../client/src/wots.js";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.PAYER ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\id.json";
const VAULT_PROGRAM = new PublicKey(process.env.VAULT_PROGRAM ?? "HBHP37mXs86kxn8i5twKiPkvtZWx2wDyUEUGVQAo72Da");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const KEYS_DIR = join(process.cwd(), "keys");
const THRESHOLD = 0.3;

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const payer = load(PAYER_PATH);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (m: string, x = "") => console.log(`  OK   ${m}${x ? "  " + x : ""}`);
const bad = (m: string, x = "") => { failed++; console.log(` FALLO ${m}${x ? "  " + x : ""}`); };
let step = 0;
const head = (m: string) => console.log(`\n${++step}. ${m}`);

async function send(tx: Transaction, signers: Keypair[], label: string) {
  tx.feePayer = payer.publicKey;
  const s = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`       ${label}: ${s.slice(0, 20)}..`);
  return s;
}

const flagsOf = (k: { isSigner: boolean; isWritable: boolean }) => (k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0);

function executeDigest(vaultId: Uint8Array, nonce: bigint, inner: TransactionInstruction, next: Uint8Array) {
  const parts: Uint8Array[] = [
    utf8("WNTR:EXEC"), vaultId, u64(nonce), inner.programId.toBytes(), Uint8Array.of(inner.keys.length),
  ];
  for (const k of inner.keys) parts.push(k.pubkey.toBytes(), Uint8Array.of(flagsOf(k)));
  parts.push(new Uint8Array(inner.data), next);
  return keccak_256(cat(...parts));
}

function executeIx(vault: PublicKey, inner: TransactionInstruction, next: Uint8Array, sig: Uint8Array) {
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

/** Runs one instruction through the vault: lookup table, fresh blockhash, resend. */
async function throughVault(
  vault: PublicKey, vaultId: Uint8Array, seed: Uint8Array, next: Uint8Array,
  inner: TransactionInstruction, label: string,
): Promise<string | null> {
  const info = await conn.getAccountInfo(vault);
  const nonce = info!.data.readBigUInt64LE(2);
  const wrapped = executeIx(vault, inner, next, sign(seed, executeDigest(vaultId, nonce, inner, next)));
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), wrapped];

  const keys = new Map<string, PublicKey>();
  for (const ix of instructions) {
    keys.set(ix.programId.toBase58(), ix.programId);
    for (const k of ix.keys) keys.set(k.pubkey.toBase58(), k.pubkey);
  }
  const slot = await conn.getSlot("finalized");
  const [createIx, lut] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  await send(new Transaction().add(createIx, AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: [...keys.values()],
  })), [payer], "tabla");

  let table = null;
  for (let a = 0; a < 12 && !table; a++) {
    await sleep(1200);
    table = (await conn.getAddressLookupTable(lut)).value;
    if (table && table.state.addresses.length < keys.size) table = null;
  }
  if (!table) { bad("la tabla no se activo"); return null; }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
    }).compileToV0Message([table]));
    vtx.sign([payer]);
    if (attempt === 1) console.log(`       ${label}: ${vtx.serialize().length} bytes`);
    try {
      const sig = await conn.sendTransaction(vtx, { maxRetries: 5 });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return sig;
    } catch (e) {
      const m = (e as Error).message;
      if (/custom program error|Instruction \d/i.test(m)) { bad(`${label} rechazado`, m.slice(0, 180)); return null; }
      await sleep(2000);
    }
  }
  bad(`${label} no confirmo`);
  return null;
}

async function claimThroughVault(
  pool: PublicKey, vault: PublicKey, vaultId: Uint8Array, seed: Uint8Array, next: Uint8Array, label: string,
) {
  const tx = await dbc.partner.claimPartnerTradingFee({
    feeClaimer: vault, payer: payer.publicKey, pool,
    maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615"),
    receiver: payer.publicKey, tempWSolAcc: payer.publicKey,
  });
  const inner = tx.instructions.find((i) => i.keys.some((k) => k.pubkey.equals(vault) && k.isSigner));
  if (!inner) { bad(`${label}: ninguna instruccion pide la firma de la boveda`); return null; }
  const at = tx.instructions.indexOf(inner);
  const pre = tx.instructions.slice(0, at);
  if (pre.length) await send(new Transaction().add(...pre), [payer], "preparacion").catch(() => {});
  return throughVault(vault, vaultId, seed, next, inner, label);
}

async function main() {
  console.log(`rpc: ${RPC}\nsaldo: ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  head("boveda");
  const seeds = [0, 1, 2, 3].map(() => new Uint8Array(randomBytes(32)));
  const pk = seeds.map(publicKeyHash);
  const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk[0])], VAULT_PROGRAM);
  await send(new Transaction().add(new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.of(0), pk[0]]),
  })), [payer], "initialize");
  ok("boveda abierta", vault.toBase58().slice(0, 8) + "..");

  head(`config con umbral de ${THRESHOLD} SOL`);
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
    activationType: ActivationType.Slot, percentageSupplyOnMigration: 20, migrationQuoteThreshold: THRESHOLD,
  });
  const configKp = Keypair.generate();
  await send(await dbc.partner.createConfig({
    config: configKp.publicKey, feeClaimer: vault, leftoverReceiver: payer.publicKey,
    quoteMint: WSOL, payer: payer.publicKey, ...curve,
  }), [payer, configKp], "createConfig");
  ok("config creada");

  head("lanzar el token");
  let mintKp: Keypair | null = null;
  for (const f of readdirSync(KEYS_DIR).filter((x) => x.endsWith(".json"))) {
    const kp = load(join(KEYS_DIR, f));
    if (!(await conn.getAccountInfo(kp.publicKey))) { mintKp = kp; break; }
  }
  if (!mintKp) throw new Error("sin claves QUANT libres");
  await send(await dbc.creator.createPool({
    name: "Graduation Test", symbol: "GRAD", uri: "https://winternitz.io/",
    payer: payer.publicKey, poolCreator: payer.publicKey,
    config: configKp.publicKey, baseMint: mintKp.publicKey,
  }), [payer, mintKp], "createPool");
  let pool: any = null;
  for (let i = 0; i < 8 && !pool; i++) { pool = await dbc.state.getPoolByBaseMint(mintKp.publicKey).catch(() => null); if (!pool) await sleep(1500); }
  const poolAddr = (pool.publicKey ?? pool.address) as PublicKey;
  ok("token vivo", mintKp.publicKey.toBase58().slice(-9));

  head("comprar hasta GRADUAR");
  // An ExactIn swap that would overshoot the threshold is rejected outright,
  // which is why the curve stalled at 56% last time. PartialFill takes only as
  // much as the curve can still absorb and graduates it in one go.
  try {
    await send(await dbc.pool.swap2({
      owner: payer.publicKey, pool: poolAddr, swapMode: SwapMode.PartialFill,
      amountIn: new BN(Math.round(THRESHOLD * 2 * LAMPORTS_PER_SOL)),
      minimumAmountOut: new BN(0), referralTokenAccount: null,
    } as any), [payer], "compra con relleno parcial");
  } catch (e) {
    bad("la compra fallo", (e as Error).message.slice(0, 160));
  }
  await sleep(2000);
  const prog = await dbc.state.getPoolQuoteTokenCurveProgress(poolAddr).catch(() => null);
  console.log(`       progreso: ${prog != null ? (Number(prog) * 100).toFixed(1) + "%" : "?"}`);
  Number(prog) >= 0.999 ? ok("curva completa, lista para graduar") : bad("la curva no llego al 100%");

  head("COBRAR ANTES de graduar");
  const before = await claimThroughVault(poolAddr, vault, pk[0], seeds[0], pk[1], "claim pre-graduacion");
  before ? ok("la boveda cobro los fees de la curva", before.slice(0, 18) + "..") : bad("no cobro antes de graduar");

  head("MIGRAR a DAMM v2");
  let migrated = false;
  try {
    // Each migration fee tier has its own DAMM v2 config; ours is the 1% one.
    const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100];
    console.log(`       dammConfig: ${dammConfig.toBase58()}`);
    const m = await dbc.migration.migrateToDammV2({ payer: payer.publicKey, pool: poolAddr, dammConfig });
    await send(m.transaction, [payer, m.firstPositionNftKeypair, m.secondPositionNftKeypair], "migrateToDammV2");
    migrated = true;
    ok("migrado, liquidez bloqueada al 100%");
  } catch (e) {
    bad("la migracion fallo", (e as Error).message.slice(0, 200));
  }

  head("COBRAR DESPUES de graduar");
  if (!migrated) {
    console.log("       no se pudo migrar, no hay nada que cobrar despues");
  } else {
    await sleep(3000);
    const after = await claimThroughVault(poolAddr, vault, pk[0], seeds[1], pk[2], "claim post-graduacion");
    after ? ok("LA BOVEDA COBRA TAMBIEN DESPUES DE GRADUAR", after.slice(0, 18) + "..") : bad("no cobro despues de graduar");
  }

  console.log(`\nboveda: ${vault.toBase58()}\npool  : ${poolAddr.toBase58()}`);
  console.log(`\n${failed === 0 ? "ANTES Y DESPUES: AMBOS EN VERDE" : failed + " fallo(s)"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
