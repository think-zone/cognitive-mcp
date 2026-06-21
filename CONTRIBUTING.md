# Contributing to cognitive-mcp

Thanks for your interest in contributing! cognitive-mcp is a small, focused project and outside contributions are genuinely welcome.

## Before You Start

- Check the [open issues](https://github.com/think-zone/cognitive-mcp/issues) to see if someone is already working on what you have in mind.
- For larger changes, open an issue first to discuss the approach before writing code.
- The v0.2 roadmap items (semantic search, memory_summarize) are explicitly good first targets.

## Development Setup

You need Node.js 22.5 or later (the project uses Node's built-in SQLite module).

```bash
git clone https://github.com/think-zone/cognitive-mcp.git
cd cognitive-mcp
npm install
npm run build      # compile TypeScript to dist/
npm run smoke      # run the full end-to-end test suite
```

The smoke script spins up the MCP server and exercises all four tools (store, search, list, forget) against a temporary database. All four should pass before submitting a PR.

## Project Structure

```
src/
  index.ts        # MCP server entry point and tool definitions
  db.ts           # SQLite database setup and queries
  tools/          # Individual tool implementations
dist/             # Compiled output (generated, do not edit)
```

## Making Changes

1. Fork the repo and create a branch: `git checkout -b my-feature`
2. Make your changes in `src/`
3. Run `npm run build` to compile
4. Run `npm run smoke` to verify all tools still work end-to-end
5. Commit with a clear message (e.g. `feat: add memory_summarize tool`)
6. Push your branch and open a pull request

## Commit Style

Use a short prefix to categorise commits:

- `feat:` new feature or tool
- `fix:` bug fix
- `docs:` README or comment changes
- `refactor:` code restructure with no behaviour change
- `test:` changes to the smoke tests

## Code Style

- TypeScript strict mode is on — no `any` without a comment explaining why
- Keep tool implementations in `src/tools/` and export them from `index.ts`
- Prefer explicit, readable code over clever one-liners
- No new runtime dependencies without discussion — the zero-dependency footprint is intentional

## Submitting a Pull Request

The PR template will guide you. The key things:

- Describe what changed and why
- Link any related issue (`Closes #123`)
- Confirm `npm run build` and `npm run smoke` both pass

## Questions?

Open an issue and tag it `question`. This project is maintained by a solo builder so response times may vary, but everything gets read.
