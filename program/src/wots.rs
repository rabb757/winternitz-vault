//! The signing half of the scheme.
//!
//! This never runs on-chain: a vault only ever verifies. It lives here so the
//! program and the client are checked against the same code rather than
//! against two readings of the same description, which is how hash-based
//! schemes usually go wrong.

use crate::{CHAIN_MAX, CHUNKS, N, SIG_LEN};
use solana_program::keccak;

/// Secret for chain `i`, derived so a signer only has to keep 32 bytes.
pub fn secret(seed: &[u8; 32], i: u8) -> [u8; N] {
    let h = keccak::hashv(&[b"WNTR:SK", seed, &[i]]).0;
    let mut out = [0u8; N];
    out.copy_from_slice(&h[..N]);
    out
}

pub fn public_key_hash(seed: &[u8; 32]) -> [u8; 32] {
    let mut ends = [0u8; SIG_LEN];
    for i in 0..CHUNKS {
        let end = crate::walk(i as u8, &secret(seed, i as u8), CHAIN_MAX);
        ends[i * N..(i + 1) * N].copy_from_slice(&end);
    }
    keccak::hash(&ends).0
}

/// Reveals each chain at the position the digest asks for.
pub fn sign(seed: &[u8; 32], digest: &[u8; 32]) -> [u8; SIG_LEN] {
    let counts = crate::chunks_of(digest);
    let mut sig = [0u8; SIG_LEN];
    for i in 0..CHUNKS {
        let link = crate::walk(i as u8, &secret(seed, i as u8), counts[i]);
        sig[i * N..(i + 1) * N].copy_from_slice(&link);
    }
    sig
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify;

    fn digest_of(m: &[u8]) -> [u8; 32] {
        keccak::hash(m).0
    }

    #[test]
    fn signs_and_verifies() {
        let seed = [7u8; 32];
        let pk = public_key_hash(&seed);
        let d = digest_of(b"pay 1000 to alice");
        assert!(verify(&pk, &d, &sign(&seed, &d)));
    }

    #[test]
    fn rejects_a_different_message() {
        let seed = [7u8; 32];
        let pk = public_key_hash(&seed);
        let signed = digest_of(b"pay 1000 to alice");
        let claimed = digest_of(b"pay 1000 to mallory");
        assert!(!verify(&pk, &claimed, &sign(&seed, &signed)));
    }

    #[test]
    fn rejects_another_key() {
        let pk = public_key_hash(&[7u8; 32]);
        let d = digest_of(b"pay 1000 to alice");
        assert!(!verify(&pk, &d, &sign(&[8u8; 32], &d)));
    }

    /// The checksum is the part that makes a one-time signature safe against
    /// the obvious attack: take a signature, raise a message byte, and walk
    /// that chain forward for free. Raising a byte lowers the checksum, and
    /// lowering it needs a chain walked backwards, which nobody can do.
    #[test]
    fn checksum_blocks_walking_a_chunk_forward() {
        let seed = [7u8; 32];
        let pk = public_key_hash(&seed);
        let mut d = digest_of(b"pay 1 to alice");
        d[0] = 10;
        let sig = sign(&seed, &d);

        // Forge a digest whose first byte is higher, and advance that chain to
        // match. Every other chunk is copied across untouched.
        let mut forged = d;
        forged[0] = 200;
        let mut fsig = sig;
        let mut link = [0u8; N];
        link.copy_from_slice(&sig[..N]);
        let advanced = crate::walk(0, &link, 190);
        fsig[..N].copy_from_slice(&advanced);

        assert!(!verify(&pk, &forged, &fsig), "checksum failed to catch the forgery");
    }

    #[test]
    fn rejects_a_truncated_signature() {
        let seed = [7u8; 32];
        let pk = public_key_hash(&seed);
        let d = digest_of(b"pay 1000 to alice");
        let sig = sign(&seed, &d);
        assert!(!verify(&pk, &d, &sig[..SIG_LEN - 1]));
    }

    /// Printed so the TypeScript client can be checked against the exact bytes
    /// the program will verify, instead of against a second reading of the spec.
    #[test]
    fn print_test_vector() {
        let seed = [1u8; 32];
        let d = digest_of(b"winternitz test vector");
        let sig = sign(&seed, &d);
        println!("seed      : {}", hex(&seed));
        println!("pk_hash   : {}", hex(&public_key_hash(&seed)));
        println!("digest    : {}", hex(&d));
        println!("sig[0..24]: {}", hex(&sig[..N]));
        println!("sig_hash  : {}", hex(&keccak::hash(&sig).0));
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
