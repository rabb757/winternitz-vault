import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { publicKeyHash, sign, cat, utf8, u64, hex } from "./wots.js";

/**
 * Proves the vault can act as a general-purpose authority.
 *
 * The launchpad needs this: Meteora pays trading fees to whichever address is
 * set as fee claimer, and that address has to sign to collect them. If it is
 * an ordinary keypair, every cent the project earns hangs off one Ed25519 key.
 * If it is this vault, collecting requires a one-time signature.
 *
 * An SPL transfer stands in for the fee claim here. What matters is not which
 * program is called but that the call is arbitrary, that the signature covers
 * every account and byte of it, and that changing anything afterwards fails.
 */

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const PAYER_PATH =
  process.env.PAYER ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\id.json";
const PROGRAM_PATH =
  process.env.PROGRAM_KEYPAIR ??
  "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\wntr\\target\\deploy\\winternitz_vault-keypair.json";

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const payer = load(PAYER_PATH);
const PROGRAM_ID = process.env.PROGRAM_ID ? new PublicKey(process.env.PROGRAM_ID) : load(PROGRAM_PATH).publicKey;
const SEED = utf8("vault");

let passed = 0, failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`${ok ? "  OK  " : " FALLO"} ${label}${detail ? `  ${detail}` : ""}`);
};

/** Flags byte matching the program: bit0 signer, bit1 writable. */
const flagsOf = (m: { isSigner: boolean; isWritable: boolean }) =>
  (m.isSigner ? 1 : 0) | (m.isWritable ? 2 : 0);

/**
 * The digest the vault will rebuild on chain. Every account and every byte of
 * the inner call is inside it, so a signature authorises one exact call.
 */
function executeDigest(
  vaultId: Uint8Array, nonce: bigint, inner: TransactionInstruction, nextPkHash: Uint8Array,
) {
  const parts: Uint8Array[] = [
    utf8("WNTR:EXEC"), vaultId, u64(nonce), inner.programId.toBytes(),
    Uint8Array.of(inner.keys.length),
  ];
  for (const k of inner.keys) parts.push(k.pubkey.toBytes(), Uint8Array.of(flagsOf(k)));
  parts.push(new Uint8Array(inner.data), nextPkHash);
  return keccak_256(cat(...parts));
}

function executeIx(vault: PublicKey, inner: TransactionInstruction, nextPkHash: Uint8Array, sig: Uint8Array) {
  const data = Buffer.concat([
    Buffer.of(3), nextPkHash, sig,
    Buffer.of(inner.keys.length),
    Buffer.from(inner.keys.map(flagsOf)),
    Buffer.from(inner.data),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: inner.programId, isSigner: false, isWritable: false },
      ...inner.keys.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable })),
    ],
    data,
  });
}

const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

async function send(ix: TransactionInstruction, label: string) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(budget(), ix), [payer], {
    commitment: "confirmed",
  });
  console.log(`       ${label}: ${sig.slice(0, 20)}..`);
  return sig;
}

async function expectRejection(ix: TransactionInstruction, label: string) {
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(budget(), ix), [payer], { commitment: "confirmed" });
    check(label, false, "la cadena lo ACEPTO");
  } catch {
    check(label, true, "rechazado");
  }
}

async function main() {
  console.log(`programa : ${PROGRAM_ID.toBase58()}`);
  console.log(`rpc      : ${RPC}\n`);

  const seeds = [0, 1, 2, 3].map(() => new Uint8Array(randomBytes(32)));
  const pk = seeds.map(publicKeyHash);
  const [vault] = PublicKey.findProgramAddressSync([SEED, Buffer.from(pk[0])], PROGRAM_ID);
  console.log(`boveda   : ${vault.toBase58()}\n`);

  console.log("1. token con la boveda como autoridad, y boveda abierta");
  const mint = await createMint(conn, payer, vault, null, 6);
  await send(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.of(0), pk[0]]),
    }),
    "initialize",
  );

  // Fund a treasury the vault owns, using the mint path that already works.
  const treasury = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vault, true);
  const mine = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const minted = 1_000_000_000n;
  const dMint = keccak_256(
    cat(utf8("WNTR:MINT"), pk[0], u64(0n), mint.toBytes(), treasury.address.toBytes(), u64(minted), pk[1]),
  );
  await send(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: treasury.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.of(1), u64(minted), pk[1], sign(seeds[0], dMint)]),
    }),
    "mint a tesoreria",
  );
  check("la tesoreria tiene 1000", (await getAccount(conn, treasury.address)).amount === minted);

  /* ---- the new instruction: an arbitrary call, signed once ---- */
  console.log("\n2. la boveda ejecuta una llamada ARBITRARIA a otro programa");
  const out = 250_000_000n;
  const inner = createTransferInstruction(treasury.address, mine.address, vault, out, [], TOKEN_PROGRAM_ID);
  const dExec = executeDigest(pk[0], 1n, inner, pk[2]);
  const goodIx = executeIx(vault, inner, pk[2], sign(seeds[1], dExec));

  // compileMessage needs a blockhash and a fee payer before it will serialise.
  const probe = new Transaction().add(budget(), goodIx);
  probe.feePayer = payer.publicKey;
  probe.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const size = probe.compileMessage().serialize().length + 65;
  check("la transaccion cabe en 1232 bytes", size <= 1232, `${size} bytes`);

  await send(goodIx, "execute → spl transfer");
  check("se movieron 250 desde la tesoreria", (await getAccount(conn, mine.address)).amount === out);
  const after = await conn.getAccountInfo(vault);
  check("la boveda roto a pk2", hex(after!.data.subarray(42, 74)) === hex(pk[2]));
  check("nonce 2", after!.data.readBigUInt64LE(2) === 2n);

  console.log("\n3. lo que tiene que fallar");
  await expectRejection(goodIx, "reenviar la misma llamada firmada");

  // Same signature, one account swapped: the digest covered that account.
  const swapped = createTransferInstruction(treasury.address, treasury.address, vault, out, [], TOKEN_PROGRAM_ID);
  await expectRejection(
    executeIx(vault, swapped, pk[3], sign(seeds[1], dExec)),
    "cambiar una cuenta despues de firmar",
  );

  const tampered = createTransferInstruction(treasury.address, mine.address, vault, 999_999n, [], TOKEN_PROGRAM_ID);
  const dOk = executeDigest(pk[0], 2n, tampered, pk[3]);
  const bad = executeIx(vault, createTransferInstruction(treasury.address, mine.address, vault, 1n, [], TOKEN_PROGRAM_ID), pk[3], sign(seeds[2], dOk));
  await expectRejection(bad, "cambiar el importe de la llamada interna");

  await expectRejection(
    executeIx(vault, inner, pk[3], sign(seeds[0], executeDigest(pk[0], 2n, inner, pk[3]))),
    "firmar con una clave ya gastada",
  );

  console.log("\n4. la boveda sigue viva despues de los rechazos");
  const last = createTransferInstruction(treasury.address, mine.address, vault, 100_000_000n, [], TOKEN_PROGRAM_ID);
  const dLast = executeDigest(pk[0], 2n, last, pk[3]);
  await send(executeIx(vault, last, pk[3], sign(seeds[2], dLast)), "execute #2");
  check("total recibido 350", (await getAccount(conn, mine.address)).amount === out + 100_000_000n);

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
