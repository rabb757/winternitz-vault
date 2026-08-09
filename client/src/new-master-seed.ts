import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "bip39";
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import { writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { publicKeyHash, cat, utf8, hex } from "./wots.js";

/**
 * Creates the master secret the launchpad's vault will answer to, for good.
 *
 * Everything the launchpad ever earns is paid to an address derived from this,
 * and Meteora's config has no way to change a fee claimer once it is set. Lose
 * this and the income is not stolen, it is frozen: nobody can ever claim it.
 *
 * Two rules shaped how this is written:
 *
 *   It is never printed. The words go straight to a file. A secret that passes
 *   through a terminal has been in scrollback, in a log, and in whatever tool
 *   was reading that terminal.
 *
 *   It is never derived from a Solana keypair. That would be the whole point
 *   thrown away: a quantum computer recovers an Ed25519 private key from the
 *   public one, and if the seed came from that key it would recover the seed
 *   too, along with every Winternitz key it will ever produce.
 *
 * A key for signature number n is keccak("WNTR:KEY" || master || n), so the
 * one secret covers every signature the vault will ever make.
 */

const OUT = process.env.SEED_FILE ?? "C:\\Users\\zarne\\Desktop\\quantum-token\\MASTER-SEED.txt";
const VAULT_PROGRAM = new PublicKey("13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT");

/** The 32 bytes behind signature `n`. */
export function keyAt(master: Uint8Array, n: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, n, true);
  return keccak_256(cat(utf8("WNTR:KEY"), master, idx));
}

export function masterFromMnemonic(words: string): Uint8Array {
  if (!validateMnemonic(words)) throw new Error("las palabras no son un mnemonico BIP39 valido");
  return new Uint8Array(mnemonicToSeedSync(words)).slice(0, 32);
}

export function vaultOf(master: Uint8Array): { pk0: Uint8Array; vault: PublicKey } {
  const pk0 = publicKeyHash(keyAt(master, 0));
  const [vault] = PublicKey.findProgramAddressSync([utf8("vault"), Buffer.from(pk0)], VAULT_PROGRAM);
  return { pk0, vault };
}

function main() {
  let words: string;

  if (existsSync(OUT)) {
    // Overwriting an existing master seed would orphan whatever it already
    // controls, so this refuses and re-derives from the file instead.
    words = readFileSync(OUT, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join(" ");
    console.log("Ya existia una semilla. No la toco, solo derivo su direccion.");
  } else {
    words = generateMnemonic(256); // 24 words
    writeFileSync(OUT, `# SEMILLA MAESTRA DE LA BOVEDA WINTERNITZ
# Quien tenga estas palabras cobra todos los fees del launchpad.
# Si se pierden, ese dinero queda congelado para siempre: nadie podra reclamarlo.
# Copialas a papel y a tu gestor de contrasenas, y borra este fichero.

${words}
`, { mode: 0o600 });
    try { chmodSync(OUT, 0o600); } catch { /* windows */ }
    console.log("Semilla creada. NO se ha mostrado por pantalla.");
  }

  const master = masterFromMnemonic(words);
  const { pk0, vault } = vaultOf(master);

  console.log(`\nfichero  : ${OUT}`);
  console.log(`boveda   : ${vault.toBase58()}`);
  console.log(`pk0      : ${hex(pk0)}`);
  console.log(`\nEsos dos valores son publicos. Las palabras no salen de ese fichero.`);
  console.log(`Guardalas y luego borra el fichero.`);
}

main();
