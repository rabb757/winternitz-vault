//! Winternitz vault.
//!
//! An SPL token whose mint authority and treasury live behind one-time
//! hash-based signatures instead of Ed25519. Ed25519 is the signature scheme
//! every ordinary Solana account uses, and it is the part of the stack a
//! large enough quantum computer would break first: Shor's algorithm recovers
//! a private key from a public key. Hash preimages have no such shortcut, so a
//! vault that only ever accepts a Winternitz signature survives that day.
//!
//! What this program does NOT claim: ordinary holders still move their tokens
//! with Ed25519, because that is how Solana accounts work. What is protected
//! here is the authority that can create supply and the treasury that holds
//! it, which is where the irreversible damage would be done.
//!
//! ## The scheme
//!
//! Winternitz signs by revealing partway along a hash chain. For each of the
//! 34 chunks of the message digest there is a chain of 255 hashes; the secret
//! is the start, the public key is the end, and a signature reveals the link
//! at the position the message asks for. A verifier walks the rest of the way
//! and checks it lands on the public key. Nobody can walk backwards, so the
//! signature cannot be turned into the secret.
//!
//! The catch, and the reason for every design decision below: a key can only
//! sign ONCE. A second signature reveals two links on the same chains and a
//! forger can interpolate between them. So each spend carries the hash of the
//! next public key, and the vault rotates on the spot. Reusing a key does not
//! merely produce a weaker signature here, it fails outright: the key it would
//! verify against no longer exists.

#![allow(unexpected_cfgs)]

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    keccak,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

pub mod wots;

/* ------------------------------------------------------------------ *
 *  Parameters
 * ------------------------------------------------------------------ */

/// Bytes kept from each chain hash.
///
/// 24 bytes is 192 bits of classical and 96 bits of quantum preimage
/// resistance, well above the 128/64 that SPHINCS+ accepts at NIST level 1.
/// It is also the largest value that keeps a whole signature inside one
/// Solana transaction, which matters more than it sounds: a scheme that needs
/// two transactions to spend is a scheme with a half-signed state to reason
/// about.
pub const N: usize = 24;

/// One chunk per byte of the keccak256 digest.
pub const MSG_CHUNKS: usize = 32;

/// Chunks carrying the checksum. Without it a forger could raise a message
/// byte and walk that chain forward for free; the checksum falls when a byte
/// rises, so any forgery needs a chain walked backwards.
pub const SUM_CHUNKS: usize = 2;

pub const CHUNKS: usize = MSG_CHUNKS + SUM_CHUNKS;
pub const SIG_LEN: usize = CHUNKS * N; // 816 bytes
pub const CHAIN_MAX: u8 = 255;

/// tag, bump, nonce, vault_id, pk_hash, mint
pub const VAULT_LEN: usize = 1 + 1 + 8 + 32 + 32 + 32;
pub const VAULT_TAG: u8 = 1;

pub const SEED_PREFIX: &[u8] = b"vault";

/* ------------------------------------------------------------------ *
 *  Winternitz
 * ------------------------------------------------------------------ */

/// One step along chain `index`. The index goes into the hash so the chains
/// are independent: a link from one chunk is worthless in another.
#[inline(always)]
fn step(index: u8, value: &mut [u8; N]) {
    let mut buf = [0u8; 1 + N];
    buf[0] = index;
    buf[1..].copy_from_slice(value);
    let h = keccak::hash(&buf);
    value.copy_from_slice(&h.0[..N]);
}

pub fn walk(index: u8, start: &[u8; N], times: u8) -> [u8; N] {
    let mut cur = *start;
    for _ in 0..times {
        step(index, &mut cur);
    }
    cur
}

/// Message digest split into chunks, followed by the checksum.
pub fn chunks_of(digest: &[u8; 32]) -> [u8; CHUNKS] {
    let mut out = [0u8; CHUNKS];
    out[..MSG_CHUNKS].copy_from_slice(digest);

    // Highest possible sum is 32 * 255 = 8160, so two chunks always hold it.
    let mut sum: u32 = 0;
    for &b in digest.iter() {
        sum += (CHAIN_MAX - b) as u32;
    }
    out[MSG_CHUNKS] = (sum >> 8) as u8;
    out[MSG_CHUNKS + 1] = (sum & 0xff) as u8;
    out
}

/// Walks each chain the rest of the way and checks the ends hash to `pk_hash`.
///
/// Cost is one keccak per step: about 4,300 on an average digest and 8,670 in
/// the worst case, so callers must raise the compute budget.
pub fn verify(pk_hash: &[u8; 32], digest: &[u8; 32], sig: &[u8]) -> bool {
    if sig.len() != SIG_LEN {
        return false;
    }
    let counts = chunks_of(digest);
    let mut ends = [0u8; SIG_LEN];

    for i in 0..CHUNKS {
        let mut link = [0u8; N];
        link.copy_from_slice(&sig[i * N..(i + 1) * N]);
        let end = walk(i as u8, &link, CHAIN_MAX - counts[i]);
        ends[i * N..(i + 1) * N].copy_from_slice(&end);
    }

    keccak::hash(&ends).0 == *pk_hash
}

/* ------------------------------------------------------------------ *
 *  Vault account
 * ------------------------------------------------------------------ */

struct Vault {
    bump: u8,
    nonce: u64,
    vault_id: [u8; 32],
    pk_hash: [u8; 32],
    mint: Pubkey,
}

impl Vault {
    fn read(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < VAULT_LEN || data[0] != VAULT_TAG {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut nonce = [0u8; 8];
        nonce.copy_from_slice(&data[2..10]);
        let mut vault_id = [0u8; 32];
        vault_id.copy_from_slice(&data[10..42]);
        let mut pk_hash = [0u8; 32];
        pk_hash.copy_from_slice(&data[42..74]);
        let mut mint = [0u8; 32];
        mint.copy_from_slice(&data[74..106]);
        Ok(Vault {
            bump: data[1],
            nonce: u64::from_le_bytes(nonce),
            vault_id,
            pk_hash,
            mint: Pubkey::new_from_array(mint),
        })
    }

    fn write(&self, data: &mut [u8]) {
        data[0] = VAULT_TAG;
        data[1] = self.bump;
        data[2..10].copy_from_slice(&self.nonce.to_le_bytes());
        data[10..42].copy_from_slice(&self.vault_id);
        data[42..74].copy_from_slice(&self.pk_hash);
        data[74..106].copy_from_slice(self.mint.as_ref());
    }
}

/* ------------------------------------------------------------------ *
 *  Entrypoint
 * ------------------------------------------------------------------ */

// Host builds (the unit tests) have no runtime to register with.
#[cfg(target_os = "solana")]
entrypoint!(process);

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0 => initialize(program_id, accounts, rest),
        1 => spend(program_id, accounts, rest, Action::Mint),
        2 => spend(program_id, accounts, rest, Action::Transfer),
        3 => execute(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/* --------------------------- initialize --------------------------- */

/// Creates the vault and pins its first public key.
///
/// The vault address is derived from that first key hash, so the address a
/// token points at is a commitment to the key that opened it: an operator
/// cannot quietly swap the authority for a different one and keep the address.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let vault_ai = next_account_info(iter)?;
    let mint_ai = next_account_info(iter)?;
    let system = next_account_info(iter)?;

    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut pk_hash = [0u8; 32];
    pk_hash.copy_from_slice(&data[..32]);

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected, bump) = Pubkey::find_program_address(&[SEED_PREFIX, &pk_hash], program_id);
    if expected != *vault_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if !vault_ai.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?.minimum_balance(VAULT_LEN);
    invoke_signed(
        &system_instruction::create_account(payer.key, vault_ai.key, rent, VAULT_LEN as u64, program_id),
        &[payer.clone(), vault_ai.clone(), system.clone()],
        &[&[SEED_PREFIX, &pk_hash, &[bump]]],
    )?;

    Vault {
        bump,
        nonce: 0,
        vault_id: pk_hash,
        pk_hash,
        mint: *mint_ai.key,
    }
    .write(&mut vault_ai.try_borrow_mut_data()?);

    msg!("vault opened, quantum-signed authority armed");
    Ok(())
}

/* ------------------------------ spend ------------------------------ */

enum Action {
    Mint,
    Transfer,
}

/// Verifies a one-time signature, rotates the key, then acts on the token.
///
/// The signed message covers the nonce, the destination, the amount and the
/// next public key. Everything that could be tampered with is inside the
/// digest, so a signature is good for exactly one spend of exactly one shape.
fn spend(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8], action: Action) -> ProgramResult {
    let iter = &mut accounts.iter();
    let vault_ai = next_account_info(iter)?;
    let source_ai = next_account_info(iter)?; // mint, or the treasury account
    let destination_ai = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    if data.len() != 8 + 32 + SIG_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut amount_bytes = [0u8; 8];
    amount_bytes.copy_from_slice(&data[..8]);
    let amount = u64::from_le_bytes(amount_bytes);
    let mut next_pk_hash = [0u8; 32];
    next_pk_hash.copy_from_slice(&data[8..40]);
    let sig = &data[40..];

    if vault_ai.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let mut vault = Vault::read(&vault_ai.try_borrow_data()?)?;

    // The stored bump turns a search of up to 255 candidates into one
    // derivation, which matters when the rest of the instruction is already
    // spending most of the compute budget on hashes.
    let expected = Pubkey::create_program_address(&[SEED_PREFIX, &vault.vault_id, &[vault.bump]], program_id)?;
    if expected != *vault_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let domain: &[u8] = match action {
        Action::Mint => b"WNTR:MINT",
        Action::Transfer => b"WNTR:XFER",
    };
    let digest = keccak::hashv(&[
        domain,
        &vault.vault_id,
        &vault.nonce.to_le_bytes(),
        source_ai.key.as_ref(),
        destination_ai.key.as_ref(),
        &amount.to_le_bytes(),
        &next_pk_hash,
    ])
    .0;

    if !verify(&vault.pk_hash, &digest, sig) {
        msg!("winternitz signature rejected");
        return Err(ProgramError::InvalidArgument);
    }

    // Rotate BEFORE the token call. A key that has been shown once is spent
    // whatever happens next, and writing it away first means an instruction
    // that fails later cannot leave the old key live for a second attempt.
    vault.pk_hash = next_pk_hash;
    vault.nonce = vault.nonce.saturating_add(1);
    vault.write(&mut vault_ai.try_borrow_mut_data()?);

    let seeds: &[&[u8]] = &[SEED_PREFIX, &vault.vault_id, &[vault.bump]];

    let ix = match action {
        // SPL Token MintTo is tag 7: mint, destination, authority.
        Action::Mint => {
            if *source_ai.key != vault.mint {
                return Err(ProgramError::InvalidArgument);
            }
            let mut d = Vec::with_capacity(9);
            d.push(7u8);
            d.extend_from_slice(&amount.to_le_bytes());
            Instruction {
                program_id: *token_program.key,
                accounts: vec![
                    AccountMeta::new(*source_ai.key, false),
                    AccountMeta::new(*destination_ai.key, false),
                    AccountMeta::new_readonly(*vault_ai.key, true),
                ],
                data: d,
            }
        }
        // SPL Token Transfer is tag 3: source, destination, authority.
        Action::Transfer => {
            let mut d = Vec::with_capacity(9);
            d.push(3u8);
            d.extend_from_slice(&amount.to_le_bytes());
            Instruction {
                program_id: *token_program.key,
                accounts: vec![
                    AccountMeta::new(*source_ai.key, false),
                    AccountMeta::new(*destination_ai.key, false),
                    AccountMeta::new_readonly(*vault_ai.key, true),
                ],
                data: d,
            }
        }
    };

    invoke_signed(
        &ix,
        &[source_ai.clone(), destination_ai.clone(), vault_ai.clone(), token_program.clone()],
        &[seeds],
    )?;

    msg!("spent, key rotated to nonce {}", vault.nonce);
    Ok(())
}

/* ----------------------------- execute ------------------------------ */

/// Runs an arbitrary instruction on another program, signed by the vault.
///
/// This is the difference between a token-specific authority and a wallet.
/// Whatever the vault owns or is authority over, it can now act on: claiming
/// trading fees from a bonding curve, moving a treasury, holding a position.
/// The launchpad needs exactly this, because the address that collects fees
/// must be able to sign, and if that address is an ordinary keypair then every
/// cent the project ever earns hangs off one Ed25519 key.
///
/// The signature covers the target program, every account with its exact
/// privileges, the instruction data and the next public key. Nothing about the
/// call can be altered after signing, and the key is spent either way.
///
/// Instruction data after the tag:
///   next_pk_hash    32
///   signature      816
///   account_count    1
///   flags            account_count bytes (bit0 signer, bit1 writable)
///   cpi_data         the rest
///
/// Accounts: [vault(w), target_program, ...the accounts of the inner call]
///
/// A caller almost always needs an address lookup table here: 816 bytes of
/// signature leaves little room, and a table turns each 32-byte account key
/// into a single byte.
fn execute(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    const HEAD: usize = 32 + SIG_LEN + 1;
    if data.len() < HEAD || accounts.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let vault_ai = &accounts[0];
    let target = &accounts[1];
    let rest = &accounts[2..];

    let mut next_pk_hash = [0u8; 32];
    next_pk_hash.copy_from_slice(&data[..32]);
    let sig = &data[32..32 + SIG_LEN];
    let count = data[32 + SIG_LEN] as usize;

    if rest.len() != count || data.len() < HEAD + count {
        return Err(ProgramError::InvalidInstructionData);
    }
    let flags = &data[HEAD..HEAD + count];
    let cpi_data = &data[HEAD + count..];

    if vault_ai.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let mut vault = Vault::read(&vault_ai.try_borrow_data()?)?;
    let expected = Pubkey::create_program_address(&[SEED_PREFIX, &vault.vault_id, &[vault.bump]], program_id)?;
    if expected != *vault_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    // Hashed incrementally: the account list is variable length, and every
    // byte of it has to be inside the digest or a signature for one call could
    // be replayed against a different set of accounts.
    let mut h = keccak::Hasher::default();
    h.hash(b"WNTR:EXEC");
    h.hash(&vault.vault_id);
    h.hash(&vault.nonce.to_le_bytes());
    h.hash(target.key.as_ref());
    h.hash(&[count as u8]);
    for (i, ai) in rest.iter().enumerate() {
        h.hash(ai.key.as_ref());
        h.hash(&[flags[i]]);
    }
    h.hash(cpi_data);
    h.hash(&next_pk_hash);
    let digest = h.result().0;

    if !verify(&vault.pk_hash, &digest, sig) {
        msg!("winternitz signature rejected");
        return Err(ProgramError::InvalidArgument);
    }

    // Rotate before the call, for the same reason as a spend: a key that has
    // been shown once is spent whether or not the call that follows succeeds.
    vault.pk_hash = next_pk_hash;
    vault.nonce = vault.nonce.saturating_add(1);
    vault.write(&mut vault_ai.try_borrow_mut_data()?);

    let metas: Vec<AccountMeta> = rest
        .iter()
        .enumerate()
        .map(|(i, ai)| AccountMeta {
            pubkey: *ai.key,
            is_signer: flags[i] & 1 != 0,
            is_writable: flags[i] & 2 != 0,
        })
        .collect();

    let mut infos: Vec<AccountInfo> = rest.to_vec();
    infos.push(vault_ai.clone());
    infos.push(target.clone());

    invoke_signed(
        &Instruction { program_id: *target.key, accounts: metas, data: cpi_data.to_vec() },
        &infos,
        &[&[SEED_PREFIX, &vault.vault_id, &[vault.bump]]],
    )?;

    msg!("executed on {}, key rotated to nonce {}", target.key, vault.nonce);
    Ok(())
}
