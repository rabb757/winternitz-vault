import { keccak_256 } from "@noble/hashes/sha3";

/**
 * Winternitz one-time signatures, client side.
 *
 * This is a line-by-line twin of the Rust in ../program/src. The two are kept
 * honest by a shared test vector rather than by inspection: check-vector.ts
 * signs a fixed message here and compares against the bytes the Rust tests
 * print. A hash-based scheme that disagrees with its verifier by one byte
 * fails in exactly the same way as a wrong key, so this is not optional.
 */

export const N = 24;
export const MSG_CHUNKS = 32;
export const SUM_CHUNKS = 2;
export const CHUNKS = MSG_CHUNKS + SUM_CHUNKS;
export const SIG_LEN = CHUNKS * N;
export const CHAIN_MAX = 255;

export const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const u64 = (v: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** One step along chain `index`. The index is inside the hash, so a link from
 *  one chunk cannot be replayed into another. */
function step(index: number, value: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + N);
  buf[0] = index;
  buf.set(value, 1);
  return keccak_256(buf).slice(0, N);
}

export function walk(index: number, start: Uint8Array, times: number): Uint8Array {
  let cur = start;
  for (let i = 0; i < times; i++) cur = step(index, cur);
  return cur;
}

/** Secret for one chain, derived so the signer only keeps 32 bytes. */
export function secret(seed: Uint8Array, i: number): Uint8Array {
  return keccak_256(cat(utf8("WNTR:SK"), seed, Uint8Array.of(i))).slice(0, N);
}

export function publicKeyHash(seed: Uint8Array): Uint8Array {
  const ends = new Uint8Array(SIG_LEN);
  for (let i = 0; i < CHUNKS; i++) ends.set(walk(i, secret(seed, i), CHAIN_MAX), i * N);
  return keccak_256(ends);
}

/** Digest bytes, then the checksum that makes forging by walking forward useless. */
export function chunksOf(digest: Uint8Array): Uint8Array {
  const out = new Uint8Array(CHUNKS);
  out.set(digest, 0);
  let sum = 0;
  for (const b of digest) sum += CHAIN_MAX - b;
  out[MSG_CHUNKS] = (sum >> 8) & 0xff;
  out[MSG_CHUNKS + 1] = sum & 0xff;
  return out;
}

export function sign(seed: Uint8Array, digest: Uint8Array): Uint8Array {
  const counts = chunksOf(digest);
  const sig = new Uint8Array(SIG_LEN);
  for (let i = 0; i < CHUNKS; i++) sig.set(walk(i, secret(seed, i), counts[i]), i * N);
  return sig;
}

/** Local mirror of the on-chain check, so a failure can be told apart from a
 *  transport problem before anything is sent. */
export function verify(pkHash: Uint8Array, digest: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== SIG_LEN) return false;
  const counts = chunksOf(digest);
  const ends = new Uint8Array(SIG_LEN);
  for (let i = 0; i < CHUNKS; i++) {
    ends.set(walk(i, sig.slice(i * N, (i + 1) * N), CHAIN_MAX - counts[i]), i * N);
  }
  return hex(keccak_256(ends)) === hex(pkHash);
}
