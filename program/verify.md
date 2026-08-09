# Verifying this program

The bytecode at `13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT` on Solana
mainnet is built from this repository at commit `82cf98a2ac4de70f3f799afcc4a5911423a34f04`.

Reproduce the build and check:

```bash
solana-verify build --library-name winternitz_vault
solana-verify get-program-hash 13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT
sha256sum program/target/deploy/winternitz_vault.so
```

Upload the record for the explorer to pick up:

```bash
solana-verify verify-from-repo   --remote   --commit-hash 82cf98a2ac4de70f3f799afcc4a5911423a34f04   --library-name winternitz_vault   --program-id 13EtnfYGUH8NaGAnUpDTVgSsXoewNnULp7ESwHzQUANT   https://github.com/rabb757/winternitz-vault
```
