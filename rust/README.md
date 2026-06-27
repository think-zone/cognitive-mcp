# cognitive-mcp (Rust) — encrypted, local-first agent memory

Secure rewrite of cognitive-mcp. The TypeScript version lives in the repo root;
this `rust/` crate is the destination (see `../private/SECURITY-ARCHITECTURE.md`).

## What's here

- **Full-database encryption** — libsql AES-256 (cipher bundled into SQLite; no
  OpenSSL/Perl/NASM). Search works because the DB is decrypted in memory.
- **Field-level encryption** — XChaCha20-Poly1305 with AAD binding for the most
  sensitive values (identifiers, person attributes).
- **Pseudonymized identity resolution** — cross-platform identities map to an
  opaque person id via truncated keyed-HMAC blind indexes; no plaintext linkage
  on disk. (Library-only; intentionally **not** exposed over MCP yet.)
- **Envelope key bootstrap** — passphrase → Argon2id KEK → wraps a persisted DEK.
- **MCP server** (rmcp, stdio) exposing the scoped memory tools:
  `memory_store`, `memory_search`, `memory_list`, `memory_forget`, `memory_purge`.

## Build requirements

- Rust stable (MSVC on Windows).
- **CMake** — libsql's `encryption` feature compiles SQLite3MultipleCiphers via
  CMake. Visual Studio Build Tools 2022 already ships one; put it on PATH:

  ```bash
  # Git Bash example
  export PATH="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin:$PATH"
  ```

  (Or install CMake from https://cmake.org / `winget install Kitware.CMake`.)

```bash
cargo build      # build the server binary
cargo test       # 19 tests: crypto, pseudonymization, encrypted store, keys
cargo run        # start the MCP server (needs env vars below)
```

## Running the server

Key custody is selected by `COGNITIVE_MCP_KEY_MODE`:

**`keystore`** (default) — the DEK and the blind-index pepper live in the OS
keychain (Windows Credential Manager; macOS later). DPAPI-protected, bound to the
logged-in user, **no secret in any config file**. This is the unattended default.

| Env var | Required | Meaning |
|---------|----------|---------|
| `COGNITIVE_MCP_KEY_MODE` | no | `keystore` (default), `tpm`, or `passphrase` |
| `COGNITIVE_MCP_DB_PATH` | no | defaults to `~/.cognitive-mcp/memory.db` |

**`tpm`** (strongest, Windows) — set `COGNITIVE_MCP_KEY_MODE=tpm`. The DEK and
pepper are sealed by a **non-exportable RSA key inside the TPM** (CNG Platform
Crypto Provider) and stored as sidecar blobs (`.dek.tpm`, `.pepper.tpm`). The key
cannot be extracted for offline use and the blobs only unseal on this machine's
TPM. No secret in any config file. Needs only `COGNITIVE_MCP_DB_PATH`.

**`passphrase`** (attended / portable) — set `COGNITIVE_MCP_KEY_MODE=passphrase`:

| Env var | Required | Meaning |
|---------|----------|---------|
| `COGNITIVE_MCP_PASSPHRASE` | yes | stretched with Argon2id into the key-encryption-key |
| `COGNITIVE_MCP_PEPPER` | yes (≥16 chars) | blind-index pepper; keep secret, keep OUT of the DB dir |

The DB (and any sidecars) are created on first run. **Pick one mode per database**
— the modes derive different keys, so switching mode on an existing DB can't
decrypt it.

> Threat ladder: `passphrase` resists offline attack on a stolen disk but the
> key lives in memory once entered; `keystore` (DPAPI) defeats device theft + key
> exfiltration but a live same-user process can still read the key; `tpm` makes
> the wrapping key **non-exportable** so even live malware can't steal it for
> offline/other-machine use (it can still ask the TPM to unseal while running as
> you). See `../private/SECURITY-ARCHITECTURE.md` §5.

## Status

Working vertical slice: encrypted store + crypto + pseudonymization + MCP server
+ **three key-custody modes** (keystore default, TPM-sealed, passphrase). 20 tests
green incl. a real-TPM seal/unseal roundtrip. Next: macOS keychain/Secure-Enclave
backend, retention/TTL purge + crypto-shredding, the local↔cloud signal boundary,
and exposing the identity layer only after the Tier-0 legal gate clears.
