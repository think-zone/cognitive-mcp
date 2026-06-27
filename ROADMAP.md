# Roadmap

Tracked work for cognitive-mcp, newest milestones first. This file is the local
source of truth for planned work; turn items into GitHub issues when ready.

## v0.2 — multi-agent + recall

- [x] **Namespace / scope contract** — private `agent:<id>` and shared `shared:<key>`
      scopes on every memory, scope-aware `store` / `search` / `list`, and a
      scope-level `memory_purge` for retention / right-to-forget. Forward-only
      migration adds the `scope` column to v0.1 databases (existing rows fall into
      `agent:default`). *Shipped on `feat/v0.2-scope-contract`.*
- [ ] **Semantic search via local embeddings (Ollama)** — recall by meaning, not
      just keywords. Embed on `memory_save` + backfill; store vectors in SQLite;
      `memory_search` gains a `keyword` (default) / `semantic` mode; graceful
      fallback to keyword when Ollama is unreachable. Keeps the 100%-local promise.
- [ ] **`memory_summarize`** — condense many memories into a short brief. Returns
      ranked/selected memories + a structured outline for the calling model to
      summarize; no mandatory external LLM dependency in the server.

## v0.3 — sharing + UI

- [ ] **HTTP transport + bearer auth** — run as a remote MCP service (Streamable
      HTTP) alongside stdio, so multiple agents/runtimes share one store. Auth is
      mandatory once memory leaves the local machine; tokens map to scopes from the
      scope contract. stdio + local-first stays the zero-config default. Pairs with
      the scope contract to complete real multi-agent shared memory.
- [ ] **Web dashboard** — browse, search, edit, and delete memories in the browser.
      Read-only first; reuses the HTTP transport/auth; gated behind auth when remote.

## Later

- [ ] **Plugin system** — register custom cognitive tools via config without
      forking. Documented contract; opt-in; sandbox/permission notes.

---

### Acceptance criteria

**Scope contract (done)**
- `scope` column + migration that preserves existing rows ✓
- save/search/forget honour scope; search can span multiple scopes ✓
- scope-level purge supported ✓
- smoke tests cover private vs shared isolation + migration ✓

**Semantic search**
- embeddings generated on save + backfill path
- `semantic` mode returns meaning-matched results in smoke tests
- zero third-party network calls (local Ollama only)
- graceful fallback when Ollama is absent

**HTTP transport + auth**
- HTTP transport works with an MCP client end-to-end
- requests without a valid bearer token are rejected
- stdio remains the default; local-first story unchanged
- notes on encryption-at-rest / token handling for shared deployments
