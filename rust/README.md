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

The server reads keys from the environment (interim custody — real OS-keystore /
TPM custody is a later phase):

| Env var | Required | Meaning |
|---------|----------|---------|
| `COGNITIVE_MCP_PASSPHRASE` | yes | stretched with Argon2id into the key-encryption-key |
| `COGNITIVE_MCP_PEPPER` | yes (≥16 chars) | blind-index pepper; keep secret, keep OUT of the DB dir |
| `COGNITIVE_MCP_DB_PATH` | no | defaults to `~/.cognitive-mcp/memory.db` |

The DB plus two sidecars (`.salt`, wrapped `.dek`) are created on first run.

## Status

Working vertical slice (store + crypto + pseudonymization + MCP server). Next:
real key custody (TPM/OS keystore + attended mode), retention/TTL purge, the
local↔cloud signal boundary, and exposing the identity layer only after the
Tier-0 legal gate clears.
