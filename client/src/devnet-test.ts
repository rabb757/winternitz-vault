import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { publicKeyHash, sign, cat, utf8, u64, hex, SIG_LEN } from "./wots.js";

/**
 * End-to-end proof on devnet.
 *
 * The interesting assertions are the negative ones. Anyone can mint a token
 * and call it quantum; what has to be shown is that the vault refuses a second
 * use of a key that has already signed, because that is the whole property a
 * one-time scheme rests on. A run that mints successfully but never proves the
 * refusal has proved nothing.
 */

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PAYER_PATH =
  process.env.PAYER ?? "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\.config\\solana\\id.json";
const PROGRAM_PATH =
  process.env.PROGRAM_KEYPAIR ??
  "\\\\wsl.localhost\\Ubuntu-22.04\\home\\bunny\\wntr\\target\\deploy\\winternitz_vault-keypair.json";

const loadKeypair = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

const conn = new Connection(RPC, "confirmed");
const payer = loadKeypair(PAYER_PATH);
const PROGRAM_ID = process.env.PROGRAM_ID
  ? new PublicKey(process.env.PROGRAM_ID)
  : loadKeypair(PROGRAM_PATH).publicKey;

const SEED_PREFIX = utf8("vault");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  OK  " : " FALLO"} ${label}${detail ? `  ${detail}` : ""}`);
}

/** The message a spend authorises. Everything that could be tampered with is
 *  inside it, including the key the vault rotates to. */
function spendDigest(
  domain: string,
  vaultId: Uint8Array,
  nonce: bigint,
  source: PublicKey,
  destination: PublicKey,
  amount: bigint,
  nextPkHash: Uint8Array,
) {
  return keccak_256(
    cat(
      utf8(domain),
      vaultId,
      u64(nonce),
      source.toBytes(),
      destination.toBytes(),
      u64(amount),
      nextPkHash,
    ),
  );
}

function spendIx(
  tag: 1 | 2,
  vault: PublicKey,
  source: PublicKey,
  destination: PublicKey,
  amount: bigint,
  nextPkHash: Uint8Array,
  sig: Uint8Array,
) {
  const data = Buffer.concat([Buffer.of(tag), u64(amount), nextPkHash, sig]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Verification burns roughly 4,300 keccaks, far past the 200k default. */
const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

async function send(ix: TransactionInstruction, label: string) {
  const tx = new Transaction().add(budget(), ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  console.log(`       ${label}: ${sig}`);
  return sig;
}

/** Expects the chain to refuse. A success here is the failure. */
async function expectRejection(ix: TransactionInstruction, label: string) {
  try {
    const tx = new Transaction().add(budget(), ix);
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    check(label, false, "la cadena lo ACEPTO");
  } catch {
    check(label, true, "rechazado por la cadena");
  }
}

async function main() {
  console.log(`programa : ${PROGRAM_ID.toBase58()}`);
  console.log(`pagador  : ${payer.publicKey.toBase58()}`);
  console.log(`saldo    : ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL\n`);

  // ---- keys. Only the seeds are secret, and each one signs exactly once. ----
  const seed0 = new Uint8Array(randomBytes(32));
  const seed1 = new Uint8Array(randomBytes(32));
  const seed2 = new Uint8Array(randomBytes(32));
  const seed3 = new Uint8Array(randomBytes(32));
  const pk0 = publicKeyHash(seed0);
  const pk1 = publicKeyHash(seed1);
  const pk2 = publicKeyHash(seed2);
  const pk3 = publicKeyHash(seed3);

  const [vault] = PublicKey.findProgramAddressSync([SEED_PREFIX, Buffer.from(pk0)], PROGRAM_ID);
  console.log(`boveda   : ${vault.toBase58()}`);
  console.log(`pk0      : ${hex(pk0)}\n`);

  // ---- 1. a mint whose authority is the vault, not a keypair ----
  console.log("1. crear el token con la boveda como autoridad de emision");
  const mint = await createMint(conn, payer, vault, null, 6);
  console.log(`       mint: ${mint.toBase58()}`);
  const mintInfo = await conn.getParsedAccountInfo(mint);
  const authority = (mintInfo.value?.data as any)?.parsed?.info?.mintAuthority;
  check("la autoridad de emision es el PDA cuantico", authority === vault.toBase58());

  // ---- 2. open the vault ----
  console.log("\n2. abrir la boveda");
  await send(
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.of(0), pk0]),
    }),
    "initialize",
  );
  const opened = await conn.getAccountInfo(vault);
  check("la boveda existe y guarda pk0", !!opened && hex(opened.data.subarray(42, 74)) === hex(pk0));

  // ---- 3. mint with a Winternitz signature ----
  console.log("\n3. emitir 1000 firmando con Winternitz (nonce 0, clave pk0)");
  const mine = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const amount = 1_000_000_000n; // 1000 with 6 decimals
  const d0 = spendDigest("WNTR:MINT", pk0, 0n, mint, mine.address, amount, pk1);
  const sig0 = sign(seed0, d0);
  check("la firma mide 816 bytes", sig0.length === SIG_LEN, `${sig0.length}`);
  const mintIx = spendIx(1, vault, mint, mine.address, amount, pk1, sig0);
  await send(mintIx, "mint_to");
  check(
    "el destinatario recibio 1000",
    (await getAccount(conn, mine.address)).amount === amount,
  );
  const afterMint = await conn.getAccountInfo(vault);
  check("la boveda roto a pk1", hex(afterMint!.data.subarray(42, 74)) === hex(pk1));

  // ---- 4. the assertions that matter ----
  console.log("\n4. lo que tiene que fallar");
  await expectRejection(mintIx, "reenviar la MISMA transaccion firmada");

  const dReuse = spendDigest("WNTR:MINT", pk0, 1n, mint, mine.address, 1n, pk2);
  await expectRejection(
    spendIx(1, vault, mint, mine.address, 1n, pk2, sign(seed0, dReuse)),
    "volver a firmar con la clave ya usada (seed0)",
  );

  const dWrong = spendDigest("WNTR:MINT", pk0, 1n, mint, mine.address, 1n, pk2);
  await expectRejection(
    spendIx(1, vault, mint, mine.address, 1n, pk2, sign(seed3, dWrong)),
    "firmar con una clave que la boveda no conoce",
  );

  const dTamper = spendDigest("WNTR:MINT", pk0, 1n, mint, mine.address, 1n, pk2);
  await expectRejection(
    spendIx(1, vault, mint, mine.address, 999_999n, pk2, sign(seed1, dTamper)),
    "cambiar el importe despues de firmar",
  );

  const dOther = spendDigest("WNTR:MINT", pk0, 1n, mint, payer.publicKey, 1n, pk2);
  await expectRejection(
    spendIx(1, vault, mint, mine.address, 1n, pk2, sign(seed1, dOther)),
    "cambiar el destinatario despues de firmar",
  );

  // ---- 5. treasury: tokens the vault itself holds ----
  console.log("\n5. tesoreria custodiada por la boveda");
  const treasury = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vault, true);
  const toTreasury = 500_000_000n;
  const d1 = spendDigest("WNTR:MINT", pk0, 1n, mint, treasury.address, toTreasury, pk2);
  await send(spendIx(1, vault, mint, treasury.address, toTreasury, pk2, sign(seed1, d1)), "mint a tesoreria");
  check("la tesoreria tiene 500", (await getAccount(conn, treasury.address)).amount === toTreasury);

  const out = 200_000_000n;
  const d2 = spendDigest("WNTR:XFER", pk0, 2n, treasury.address, mine.address, out, pk3);
  await send(spendIx(2, vault, treasury.address, mine.address, out, pk3, sign(seed2, d2)), "transfer");
  check("quedan 300 en tesoreria", (await getAccount(conn, treasury.address)).amount === toTreasury - out);
  check("el destinatario suma 1200", (await getAccount(conn, mine.address)).amount === amount + out);

  const final = await conn.getAccountInfo(vault);
  check("la boveda va por nonce 3", final!.data.readBigUInt64LE(2) === 3n);
  check("la boveda apunta a pk3", hex(final!.data.subarray(42, 74)) === hex(pk3));

  console.log(`\nmint    : ${mint.toBase58()}`);
  console.log(`boveda  : ${vault.toBase58()}`);
  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
