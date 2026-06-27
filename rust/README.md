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
| `COGNITIVE_MCP_KEY_MODE` | no | `keystore` (default) or `passphrase` |
| `COGNITIVE_MCP_DB_PATH` | no | defaults to `~/.cognitive-mcp/memory.db` |

**`passphrase`** (attended / portable) — set `COGNITIVE_MCP_KEY_MODE=passphrase`:

| Env var | Required | Meaning |
|---------|----------|---------|
| `COGNITIVE_MCP_PASSPHRASE` | yes | stretched with Argon2id into the key-encryption-key |
| `COGNITIVE_MCP_PEPPER` | yes (≥16 chars) | blind-index pepper; keep secret, keep OUT of the DB dir |

In keystore mode the DB is created on first run and the keys are minted into the
keychain. In passphrase mode the DB plus two sidecars (`.salt`, wrapped `.dek`)
are created on first run.

> Threat note: keystore/DPAPI custody defeats device theft and key exfiltration,
> but not live same-user malware. TPM 2.0 / Secure-Enclave non-exportable sealing
> (which can wrap the keychain item) is the next hardening — see
> `../private/SECURITY-ARCHITECTURE.md` §5.

## Status

Working vertical slice: encrypted store + crypto + pseudonymization + MCP server
+ **OS-keystore key custody** (keystore default, passphrase opt-in). Next:
TPM/Secure-Enclave sealing + attended hardware mode, retention/TTL purge, the
local↔cloud signal boundary, and exposing the identity layer only after the
Tier-0 legal gate clears.
