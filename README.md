# cognitive-mcp

> **Persistent memory for AI agents — local-first, over the [Model Context Protocol](https://modelcontextprotocol.io).**
> One SQLite file. Five tools. No server, no account, no cloud.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Think-Zone](https://img.shields.io/badge/Think--Zone-Ecosystem-blueviolet)](https://github.com/think-zone)

---

## What it does

Most AI agents forget everything the moment a conversation ends. **cognitive-mcp** gives them a memory that survives across sessions.

It's an MCP server exposing five tools — **store**, **search**, **list**, **forget**, and **purge** — backed by a single local SQLite file. Point Claude Desktop, Cursor, or any MCP client at it, and your agent can write things down and recall them later. Everything stays on your machine. Memories can be namespaced into **scopes** so several agents can share one store without stepping on each other.

## Features (v0.1)

- 🧠 **Persistent memory across sessions** — what you save today is there tomorrow
- 🔎 **Keyword search** with tag filtering and pagination
- 🗂️ **Scopes** — namespace memory per agent (`agent:<id>`) or share it (`shared:<key>`), with scope-level purge
- 💾 **One local SQLite file** — no database server, no migrations, no setup
- 🔌 **Works with any MCP client** — Claude Desktop, Cursor, and more
- 🏠 **100% local** — no account, no API key, no network calls
- ⚡ **Runs with `npx`** — nothing to clone or build

Requires **Node.js 22.5+** (it uses Node's built-in SQLite — no native modules to compile).

> **Honest scope:** v0.1 ships plain **keyword** search. Semantic/vector memory, summarization, and a web dashboard are planned — see the [Roadmap](#roadmap). They are not built yet, and this README will not pretend otherwise.

## Install

Add cognitive-mcp to your MCP client. For **Claude Desktop**, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cognitive": {
      "command": "npx",
      "args": ["-y", "cognitive-mcp"]
    }
  }
}
```

Restart the client. The memory file is created automatically at `~/.cognitive-mcp/memory.db` the first time a tool runs.

<details>
<summary><strong>Cursor &amp; other MCP clients</strong></summary>

Any client that speaks MCP over stdio works. Use the same command (`npx -y cognitive-mcp`) wherever the client asks for an MCP server command.
</details>

<details>
<summary><strong>Run from source (development)</strong></summary>

```bash
git clone https://github.com/think-zone/cognitive-mcp.git
cd cognitive-mcp
npm install
npm run build
```

Then point your client at the built entry point:

```json
{
  "mcpServers": {
    "cognitive": {
      "command": "node",
      "args": ["/absolute/path/to/cognitive-mcp/dist/index.js"]
    }
  }
}
```
</details>

## Tools

| Tool | What it does | Arguments |
|------|--------------|-----------|
| `memory_store` | Save a fact/note with optional tags | `content` *(required)*, `tags[]`, `scope` |
| `memory_search` | Keyword search across memories | `query` *(required)*, `tags[]`, `scopes[]`, `limit`, `offset`, `response_format` |
| `memory_list` | Browse memories, newest first | `tags[]`, `scopes[]`, `limit`, `offset`, `response_format` |
| `memory_forget` | Delete a memory by id | `id` *(required)* |
| `memory_purge` | Delete every memory in a scope | `scope` *(required)* |

`memory_search` matches every whitespace-separated term against memory content (case-insensitive). The read tools accept `response_format: "markdown" | "json"` (default `markdown`).

### Scopes

Every memory lives in a **scope** — a namespace string. Pass `scope` when storing
and `scopes[]` when reading; omit them and everything uses one shared pool
(`agent:default`), exactly like v0.1.

- `agent:<id>` — an agent's private working memory
- `shared:<key>` — memory several agents read and write together

`memory_search` / `memory_list` take `scopes[]` to restrict a read to one or more
namespaces (omit to span all). `memory_purge` drops an entire scope in one call —
the namespace-level counterpart to `memory_forget`, for retention / right-to-forget.

Databases created by v0.1 are migrated automatically on first open: a `scope`
column is added and existing memories fall into `agent:default` — no data loss.

### Example

> **You:** Remember that I deploy on Fridays and my staging URL is staging.example.com.
> **Agent** → `memory_store` → *Stored memory #1.*
>
> *…a week later, brand-new session…*
>
> **You:** When do I usually deploy?
> **Agent** → `memory_search` `{ query: "deploy" }` → *You deploy on Fridays (memory #1).*

## Where memory is stored

A single SQLite file at `~/.cognitive-mcp/memory.db`. Override the location with an environment variable:

```bash
COGNITIVE_MCP_DB_PATH=/path/to/my-memory.db
```

Back it up, sync it, or delete it to start fresh — it's just a file.

## Roadmap

Shipped and planned (see [ROADMAP.md](ROADMAP.md) for detail):

- [x] **Multi-agent shared memory** — scopes (`agent:<id>` / `shared:<key>`) with scope-level purge
- [ ] **v0.2 — Semantic search** via local embeddings (Ollama), so recall works by meaning, not just keywords
- [ ] **v0.2 — `memory_summarize`** to condense many memories into a short brief
- [ ] **v0.3 — HTTP transport + bearer auth** so multiple agents share one store over the network
- [ ] **v0.3 — Web dashboard** to browse and edit memories in the browser
- [ ] Plugin system for custom cognitive tools

The v0.2 items are good first contributions — issues and PRs welcome.

## Part of the Think-Zone ecosystem

| Repo | Description |
|------|-------------|
| **cognitive-mcp** | Persistent agent memory over MCP (this repo) |
| [creator-os](https://github.com/think-zone/creator-os) | Local-first AI automation stack |

## Development

```bash
npm install
npm run build     # compile TypeScript to dist/
npm run smoke     # spin up the server and exercise all five tools end-to-end
npm run dev       # run from source with tsx
```

## License

MIT © [Think-Zone](https://github.com/think-zone)
