# cognitive-mcp

> **MCP server framework for Think-Zone** — local-first AI cognitive tools, context management, and agent memory for LLM workflows.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Think-Zone](https://img.shields.io/badge/Think--Zone-Ecosystem-blueviolet)](https://github.com/think-zone)

---

## What is cognitive-mcp?

`cognitive-mcp` is an open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server built for the Think-Zone ecosystem. It gives AI agents — running locally via Ollama, Claude, or any MCP-compatible runtime — persistent memory, structured context, and cognitive tooling.

Think of it as a **brain layer** for your local AI stack. Instead of every conversation starting from scratch, cognitive-mcp gives your agents the ability to remember, reason across sessions, and access structured knowledge.

---

## Key Features

- **Persistent Agent Memory** — store and retrieve context across sessions
- **Cognitive Tooling** — structured tools for summarization, reflection, and context pruning
- **Local-first** — runs entirely on your machine, no cloud required
- **MCP-compatible** — works with Claude Desktop, Cursor, and any MCP client
- **TypeScript** — fully typed, easy to extend
- **Ollama integration** — plug directly into your local LLM setup

---

## Part of the Think-Zone Ecosystem

| Repo | Description |
|------|-------------|
| [creator-os](https://github.com/think-zone/creator-os) | ThinkPad automation stack — local-first AI with WSL2, Ollama, Docker |
| **cognitive-mcp** | MCP server with agent memory and cognitive tools |

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/think-zone/cognitive-mcp.git
cd cognitive-mcp

# Install dependencies
npm install

# Run the MCP server
npm start
```

---

## Roadmap

- [ ] Vector-based semantic memory
- [ ] Multi-agent context sharing
- [ ] Web dashboard for memory inspection
- [ ] Plugin system for custom cognitive tools

---

## License

MIT © [Think-Zone](https://github.com/think-zone)

---

> Built with obsession. Designed for the solo builder who wants AI that actually works offline.
