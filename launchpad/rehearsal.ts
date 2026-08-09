/**
 * Full devnet rehearsal of the launchpad, end to end.
 *
 * The vault is well tested on its own; the launchpad has never touched a chain.
 * This runs the whole path once with no money at stake:
 *
 *   1. open a vault and make it the fee claimer
 *   2. create the Meteora config that every token will inherit
 *   3. launch a token on a QUANT address from the pre-ground pool
 *   4. buy until the curve graduates
 *   5. claim the trading fees THROUGH the vault, with a one-time signature
 *
 * Step 5 is the one that matters and the one that could fail. Meteora's claim
 * instruction carries a lot of accounts, and an 816-byte signature on top may
 * not fit in a transaction. Better to find that out here than on mainnet.
 *
 * The graduation threshold is lowered to 2 SOL so the rehearsal is affordable;
 * everything else matches the real config.
 *
 *   WNTR_CLUSTER=devnet npx tsx rehearsal.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SystemProgram,
  AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient, buildCurve, TokenType, TokenDecimal, TokenAuthorityOption,
  CollectFeeMode, BaseFeeMode, MigrationOption, MigrationFeeOption, ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import BN from "bn.js";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { publicKeyHash, sign, cat, utf8, u64, hex } from "../client/src/wots.js";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH = process.env.PAYER ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\id.json";
const VAULT_PROGRAM = new PublicKey("HBHP37mXs86kxn8i5twKiPkvtZWx2wDyUEUGVQAo72Da");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const KEYS_DIR = join(process.cwd(), "keys");
const THRESHOLD_SOL = 2;

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const payer = load(PAYER_PATH);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let step = 0;
let failed = 0;
const ok = (m: string, extra = "") => console.log(`  OK   ${m}${extra ? "  " + extra : ""}`);
const bad = (m: string, extra = "") => { failed++; console.log(` FALLO ${m}${extra ? "  " + extra : ""}`); };
const head = (m: string) => console.log(`\n${++step}. ${m}`);

async function send(tx: Transaction, signers: Keypair[], label: string) {
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`       ${label}: ${sig.slice(0, 22)}..`);
  return sig;
}

/* ------------------------- the vault, as a wallet ------------------------- */

/** Digest for the vault's `execute`: target program, every account with its
 *  privileges, the payload, and the key it rotates to. */
function executeDigest(vaultId: Uint8Array, nonce: bigint, inner: TransactionInstruction, next: Uint8Array) {
  const parts: Uint8Array[] = [
    utf8("WNTR:EXEC"), vaultId, u64(nonce), inner.programId.toBytes(), Uint8Array.of(inner.keys.length),
  ];
  for (const k of inner.keys) {
    parts.push(k.pubkey.toBytes(), Uint8Array.of((k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0)));
  }
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
      Buffer.of(3), next, sig,
      Buffer.of(inner.keys.length),
      Buffer.from(inner.keys.map((k) => (k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0))),
      Buffer.from(inner.data),
    ]),
  });
}

async function main() {
  console.log(`rpc    : ${RPC}`);
  console.log(`pagador: ${payer.publicKey.toBase58()}`);
  console.log(`saldo  : ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  /* ---------------------------------------------------------------- 1 */
  head("abrir la boveda que cobrara los fees");
  const seeds = [0, 1, 2, 3].map(() => new Uint8Array(randomBytes(32)));
  const pk = seeds.map(publicKeyHash);
  const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk[0])], VAULT_PROGRAM);
  console.log(`       boveda: ${vault.toBase58()}`);

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

  /* ---------------------------------------------------------------- 2 */
  head("crear la config de Meteora con la boveda como feeClaimer");
  const curve = buildCurve({
    token: {
      tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000, leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 150, endingFeeBps: 150, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 33, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: THRESHOLD_SOL,
  });

  const configKp = Keypair.generate();
  await send(await dbc.partner.createConfig({
    config: configKp.publicKey,
    feeClaimer: vault,                  // <- the whole point
    leftoverReceiver: payer.publicKey,
    quoteMint: WSOL,
    payer: payer.publicKey,
    ...curve,
  }), [payer, configKp], "createConfig");

  const onchain = await dbc.state.getPoolConfig(configKp.publicKey);
  ok("config creada", configKp.publicKey.toBase58().slice(0, 8) + "..");
  const claimer = (onchain as any)?.feeClaimer?.toBase58?.();
  claimer === vault.toBase58()
    ? ok("el feeClaimer on-chain ES la boveda")
    : bad("el feeClaimer no es la boveda", String(claimer));

  /* ---------------------------------------------------------------- 3 */
  head("lanzar un token en una direccion QUANT del deposito");
  // A key from the pool is single use: once a token is created the mint account
  // exists forever, so pick one that has not been spent on a previous run.
  let mintKp: Keypair | null = null;
  for (const f of readdirSync(KEYS_DIR).filter((x) => x.endsWith(".json"))) {
    const kp = load(join(KEYS_DIR, f));
    if (!(await conn.getAccountInfo(kp.publicKey))) { mintKp = kp; break; }
  }
  if (!mintKp) throw new Error("no quedan claves QUANT sin usar en el deposito");
  console.log(`       mint: ${mintKp.publicKey.toBase58()}`);
  mintKp.publicKey.toBase58().endsWith("QUANT")
    ? ok("la direccion del token acaba en QUANT")
    : bad("la direccion no acaba en QUANT");

  await send(await dbc.creator.createPool({
    name: "Rehearsal Quantum", symbol: "RQNT",
    uri: "https://winternitz.io/launchpad.html",
    payer: payer.publicKey, poolCreator: payer.publicKey,
    config: configKp.publicKey, baseMint: mintKp.publicKey,
  }), [payer, mintKp], "createPool");

  // The pool exists the moment the transaction confirms, but the RPC's account
  // index lags a beat behind, so a single lookup right after creating it
  // reports nothing.
  let pool: any = null;
  for (let i = 0; i < 8 && !pool; i++) {
    pool = await dbc.state.getPoolByBaseMint(mintKp.publicKey).catch(() => null);
    if (!pool) await sleep(1500);
  }
  if (!pool) { bad("no se encontro el pool"); throw new Error("sin pool"); }
  ok("curva viva");
  const poolAddr = (pool.publicKey ?? pool.address) as PublicKey;

  /* ---------------------------------------------------------------- 4 */
  head(`comprar hasta cruzar el umbral de ${THRESHOLD_SOL} SOL`);
  const buys = [0.8, 0.8, 0.3, 0.1, 0.05, 0.02];
  for (const amt of buys) {
    try {
      await send(await dbc.pool.swap({
        owner: payer.publicKey, pool: poolAddr,
        amountIn: new BN(amt * LAMPORTS_PER_SOL), minimumAmountOut: new BN(0),
        swapBaseForQuote: false, referralTokenAccount: null,
      }), [payer], `compra de ${amt} SOL`);
    } catch (e) {
      console.log(`       compra de ${amt} SOL fallo: ${(e as Error).message.slice(0, 90)}`);
    }
    await sleep(1200);
  }
  const after: any = await dbc.state.getPool(poolAddr).catch(() => null);
  const state = after?.poolState ?? after?.account ?? after;
  const quote = state?.quoteReserve?.toString?.() ?? null;
  if (quote) console.log(`       recaudado en la curva: ${Number(quote) / LAMPORTS_PER_SOL} SOL`);
  const progress = await dbc.state.getPoolQuoteTokenCurveProgress(poolAddr).catch(() => null);
  if (progress != null) console.log(`       progreso de la curva: ${(Number(progress) * 100).toFixed(1)}%`);
  const done = state?.isMigrated ?? state?.migrationProgress;
  console.log(`       estado de migracion: ${done ?? "?"}`);
  ok("la curva acepto compras");

  /* ---------------------------------------------------------------- 5 */
  head("cobrar los fees CON LA BOVEDA (la prueba que importa)");
  const claimTx = await dbc.partner.claimPartnerTradingFee({
    feeClaimer: vault, payer: payer.publicKey, pool: poolAddr,
    maxBaseAmount: new BN(0), maxQuoteAmount: new BN("18446744073709551615"),
    receiver: payer.publicKey,
    tempWSolAcc: payer.publicKey,
  });

  const needSig = claimTx.instructions.filter((i) => i.keys.some((k) => k.pubkey.equals(vault) && k.isSigner));
  console.log(`       instrucciones: ${claimTx.instructions.length}, de ellas ${needSig.length} necesitan la firma de la boveda`);

  for (const [i, inner] of needSig.entries()) {
    const info = await conn.getAccountInfo(vault);
    const nonce = info!.data.readBigUInt64LE(2);
    const next = pk[i + 1] ?? publicKeyHash(new Uint8Array(randomBytes(32)));
    const digest = executeDigest(pk[0], nonce, inner, next);
    const wrapped = executeIx(vault, inner, next, sign(seeds[i], digest));
    // Even with a lookup table the claim came to 1254 bytes, 22 over the limit.
    // The account setup around it does not need the vault's signature, so it
    // goes in its own transactions and leaves the signed one carrying nothing
    // but the compute budget and the claim itself.
    const at = claimTx.instructions.indexOf(inner);
    const pre = claimTx.instructions.slice(0, at);
    const post = claimTx.instructions.slice(at + 1);
    if (pre.length) await send(new Transaction().add(...pre), [payer], `preparacion (${pre.length} ix)`);

    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      wrapped,
    ];

    // A legacy transaction spends 32 bytes on every account key, and with 816
    // bytes of signature already inside the instruction there is no room. A
    // lookup table turns each of those keys into a single byte, which is the
    // only reason a Winternitz signature and a Meteora claim fit together.
    const keys = new Map<string, PublicKey>();
    for (const ix of instructions) {
      keys.set(ix.programId.toBase58(), ix.programId);
      for (const k of ix.keys) keys.set(k.pubkey.toBase58(), k.pubkey);
    }
    const addresses = [...keys.values()];
    console.log(`       cuentas distintas a comprimir: ${addresses.length}`);

    const slot = await conn.getSlot("finalized");
    const [createIx, lut] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
    });
    await send(new Transaction().add(createIx, AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses,
    })), [payer], "tabla de direcciones");

    // A table is only usable one slot after it was extended.
    let table = null;
    for (let a = 0; a < 12 && !table; a++) {
      await sleep(1200);
      table = (await conn.getAddressLookupTable(lut)).value;
      if (table && table.state.addresses.length < addresses.length) table = null;
    }
    if (!table) { bad("la tabla no se activo"); break; }
    ok("tabla activa", `${table.state.addresses.length} direcciones`);

    // Devnet drops transactions under load, and a v0 transaction built a few
    // awaits earlier can miss its blockhash window. Rebuild and resend rather
    // than reporting a failure that never reached a validator.
    let landed: string | null = null;
    for (let attempt = 1; attempt <= 4 && !landed; attempt++) {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: payer.publicKey, recentBlockhash: blockhash, instructions,
      }).compileToV0Message([table]);
      const vtx = new VersionedTransaction(msg);
      vtx.sign([payer]);

      if (attempt === 1) {
        const size = vtx.serialize().length;
        console.log(`       tamano con tabla: ${size} bytes (antes 1621)`);
        size <= 1232 ? ok("cabe en una transaccion") : bad("sigue sin caber", `${size}`);
        if (size > 1232) break;
      }

      try {
        const sig = await conn.sendTransaction(vtx, { maxRetries: 5, skipPreflight: false });
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        landed = sig;
      } catch (e) {
        const m = (e as Error).message;
        // A transaction that was simulated and rejected will not improve on a
        // retry; only a dropped one is worth sending again.
        if (/custom program error|insufficient|Instruction \d/i.test(m)) {
          bad("el cobro fue rechazado", m.slice(0, 200));
          break;
        }
        console.log(`       intento ${attempt} no confirmo, reintentando`);
        await sleep(2000);
      }
    }

    if (landed) {
      console.log(`       claim: ${landed}`);
      ok("LA BOVEDA COBRO LOS FEES DE METEORA");
    } else if (failed === 0) {
      bad("el cobro no llego a confirmarse en 4 intentos");
    }

    if (landed && post.length) {
      await send(new Transaction().add(...post), [payer], `cierre (${post.length} ix)`).catch(() => {});
    }
  }
  if (needSig.length === 0) bad("ninguna instruccion pedia la firma de la boveda: revisar");

  console.log(`\nboveda : ${vault.toBase58()}`);
  console.log(`config : ${configKp.publicKey.toBase58()}`);
  console.log(`token  : ${mintKp.publicKey.toBase58()}`);
  console.log(`pool   : ${poolAddr.toBase58()}`);
  console.log(`\n${failed === 0 ? "ENSAYO COMPLETO EN VERDE" : failed + " fallo(s)"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
