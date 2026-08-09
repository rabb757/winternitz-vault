# Winternitz Vault

The post-quantum standard of Solana. A vault program that answers to Winternitz
one-time hash-based signatures instead of Ed25519, so a working quantum
computer running Shor's algorithm has nothing to attack.

- Live on mainnet: `13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT`
- Launchpad: https://winternitz.io/launchpad.html
- Audit and receipts: https://winternitz.io/#audit

## Layout

| Folder | What is in it |
|---|---|
| `program/` | The vault program in Rust. Verifies signatures, holds a treasury, does arbitrary CPIs. |
| `client/` | TypeScript signer plus a shared test vector against Rust, byte for byte. |
| `launchpad/` | Meteora DBC config, mainnet scripts, migrator, fee sweeper. |
| `api/` | Vercel serverless endpoints the site uses. |
| `assets/` and `meta/` | Logo, token metadata. |

## Prior art

Written from the specification rather than forked. The idea of a Winternitz
vault on Solana is Dean Little's; the original program guards lamports and does
not touch tokens.
https://github.com/blueshift-gg/solana-winternitz-vault

## What is not here

Anything that touches money: the master seed, private keys, `.env.local`. See
`.gitignore`.
