import { keccak_256 } from "@noble/hashes/sha3";
import { publicKeyHash, sign, verify, hex, utf8, N } from "./wots.js";

/**
 * Proves the TypeScript signer and the Rust verifier agree, before a single
 * lamport is spent. The expected values come from `cargo test print_test_vector`.
 */

const EXPECTED = {
  pkHash: "fe5020b437c6b20c5e7375bcd9a3c6918b6d7654d8f488ffd8e3975f9fe5ab2a",
  digest: "ee3ac08879e1c9ad49981a20b07abf2bd0171540013cb1b4c77ac074089da713",
  sigHead: "4e7850f3be9f49450cdc8a56add99f02c60efdcad1ebc9d4",
  sigHash: "02207cde031055670bd22c656eb8f6b1679600450dd1ab7cb3f1888cb504c6c3",
};

const seed = new Uint8Array(32).fill(1);
const digest = keccak_256(utf8("winternitz test vector"));
const sig = sign(seed, digest);

const got = {
  pkHash: hex(publicKeyHash(seed)),
  digest: hex(digest),
  sigHead: hex(sig.slice(0, N)),
  sigHash: hex(keccak_256(sig)),
};

let bad = 0;
for (const k of Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>) {
  const ok = got[k] === EXPECTED[k];
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "MAL "} ${k.padEnd(8)} ${got[k]}`);
  if (!ok) console.log(`     esperado ${EXPECTED[k]}`);
}

if (!verify(publicKeyHash(seed), digest, sig)) {
  console.log("MAL  la verificacion local rechaza su propia firma");
  bad++;
}

console.log(bad === 0 ? "\ncliente y programa coinciden byte a byte" : `\n${bad} discrepancia(s)`);
process.exit(bad === 0 ? 0 : 1);
