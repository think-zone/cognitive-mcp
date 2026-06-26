# cognitive-mcp

Persistent memory for AI agents — local-first, over the Model Context Protocol. One SQLite file. No server, no account, no cloud.

## What it does

Most AI agents forget everything the moment a conversation ends. `cognitive-mcp` gives them a memory that survives across sessions — and in **v0.2**, a memory that *ranks by relevance, forgets what's stale, and can reason about what it knows*.

It's an MCP server backed by a single local SQLite file. Point Claude Desktop, Cursor, or any MCP client at it, and your agent can write things down, search them by relevance, link them together, and recall them later. Everything stays on your machine.

## Features (v0.2)

- 🧠 **Persistent memory across sessions** — what you save today is there tomorrow
- 🔎 **Ranked full-text search** — SQLite FTS5 with BM25 relevance scoring, prefix and phrase matching (no embeddings, no Ollama, no network)
- ⏳ **Weighted decay** — memories you don't use gently fade and rank lower; the ones you act on stay sharp via `memory_reinforce`
- 🗂️ **Contexts** — namespace memories per project or persona, all in the same file
- 🕸️ **Memory graph** — link memories with typed relations (`see_also`, `depends_on`, `contradicts`…) and pull related context in one call
- 🤔 **Reflection** — `memory_reflect` summarises a slice of memories using the client's own model via MCP sampling (no extra API key)
- 📦 **Export / import** — back up, version-control, or share a memory bundle as JSON
- 💾 **One local SQLite file** — no database server, no migrations, no setup
- 🔌 **Works with any MCP client** — Claude Desktop, Cursor, and more
- 🏠 **100% local** — no account, no API key, no network calls
- ⚡ **Runs with npx** — nothing to clone or build

Requires **Node.js 22.5+** (it uses Node's built-in SQLite — no native modules to compile).

> Honest scope: search is keyword/full-text (FTS5), not vector/semantic. Local embedding-based recall remains on the roadmap. This README won't pretend otherwise.

## Install

Add `cognitive-mcp` to your MCP client. For Claude Desktop, edit `claude_desktop_config.json`:

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

## Tools

| Tool | What it does | Key arguments |
| --- | --- | --- |
| `memory_store` | Save a fact/note | `content` (required), `tags[]`, `context` |
| `memory_search` | BM25-ranked full-text search, weighted by recency/use | `query` (required), `tags[]`, `context`, `limit`, `offset`, `response_format` |
| `memory_list` | Browse memories, newest first | `tags[]`, `context`, `limit`, `offset`, `response_format` |
| `memory_forget` | Delete a memory by id | `id` (required) |
| `memory_reinforce` | Strengthen a memory so it decays slower and ranks higher | `id` (required) |
| `memory_update` | Edit a memory's content/tags | `id`, `content` (required), `tags[]` |
| `memory_link` | Create a typed link between two memories | `from_id`, `to_id` (required), `relation` |
| `memory_context` | Fetch a memory plus everything linked to it | `id` (required) |
| `memory_reflect` | Summarise a slice of memories via MCP sampling, store the brief | `prompt` (required), `tags[]`, `context`, `limit`, `store_result` |
| `memory_export` | Export memories as a JSON bundle | `context` |
| `memory_import` | Import a previously exported bundle | `bundle` (required) |

`memory_search` ranks results by BM25 relevance combined with each memory's weight, so frequently used memories surface above equally-matching but stale ones. The read tools accept `response_format: "markdown" | "json"` (default markdown).

## How relevance & decay work

Every memory carries a `weight` between `0.05` and `1.0`. New memories start at `1.0`. On each server startup, weights decay roughly **1% per day** since the memory was last accessed (floored at `0.05` — nothing is ever auto-deleted). Whenever a memory is returned by a search, its `last_accessed` is refreshed; calling `memory_reinforce` pulls its weight back toward `1.0`. The net effect: memory that matters stays prominent, and the rest quietly recedes — without you ever having to prune manually.

## Example

> **You:** Remember that I deploy on Fridays and my staging URL is staging.example.com.
> **Agent →** `memory_store` **→** Stored memory #1.

…a week later, brand-new session…

> **You:** When do I usually deploy?
> **Agent →** `memory_search { query: "deploy" }` **→** You deploy on Fridays (memory #1).
> **Agent →** `memory_reinforce { id: 1 }` **→** keeps that fact fresh for next time.

## Where memory is stored

A single SQLite file at `~/.cognitive-mcp/memory.db`. Override the location with an environment variable:

```
COGNITIVE_MCP_DB_PATH=/path/to/my-memory.db
```

Back it up, sync it, or delete it to start fresh — it's just a file. You can also move memories around with `memory_export` / `memory_import`.

## Roadmap

Planned, not yet shipped:

- **v0.3** — Semantic search via local embeddings (Ollama), so recall works by meaning as well as keywords
- **v0.3** — Web dashboard to browse, edit, and visualise the memory graph in the browser
- Multi-agent shared memory
- Plugin system for custom cognitive tools

Contributions welcome — see `CONTRIBUTING.md`.

## Part of the Think-Zone ecosystem

| Repo | Description |
| --- | --- |
| `cognitive-mcp` | Persistent agent memory over MCP (this repo) |
| `creator-os` | Local-first AI automation stack |

## Development

```
npm install
npm run build   # compile TypeScript to dist/
npm run smoke   # spin up the server and exercise every tool end-to-end
npm run dev     # run from source with tsx
```

## License

MIT © Think-Zone
