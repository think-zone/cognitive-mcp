# Contributing to cognitive-mcp

Thanks for your interest in contributing! cognitive-mcp is a small, focused project and outside contributions are genuinely welcome.

## Before You Start

- Check the [open issues](https://github.com/think-zone/cognitive-mcp/issues) to see if someone is already working on what you have in mind.
- For larger changes, open an issue first to discuss the approach before writing code.
- The v0.3 roadmap items (semantic search via local embeddings, web dashboard) are explicitly good targets.

## Development Setup

You need Node.js 22.5 or later (the project uses Node's built-in SQLite module).

```bash
git clone https://github.com/think-zone/cognitive-mcp.git
cd cognitive-mcp
npm install
npm run build   # compile TypeScript to dist/
npm run smoke   # run the full end-to-end test suite
```

The smoke script spins up the MCP server and exercises every tool against a temporary database. All checks should pass before submitting a PR.

## Project Structure

```
src/
  index.ts    # MCP server entry point + all tool definitions
  db.ts       # SQLite store: schema, FTS5 search, decay, graph
  format.ts   # Markdown rendering of memory pages
test/
  smoke.mjs   # End-to-end test over a real stdio MCP client
dist/         # Compiled output (generated, do not edit)
```

Tools are currently defined inline in `src/index.ts`. If a future change makes that file unwieldy, we can split tools into a `src/tools/` directory — but for now keep new tools in `index.ts` and shared persistence logic in `db.ts`.

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
- Keep new tools in `src/index.ts` and shared store logic in `src/db.ts`
- Prefer explicit, readable code over clever one-liners
- Use parameterised SQL — never interpolate user input into a query string
- No new runtime dependencies without discussion — the tiny dependency footprint is intentional

## Submitting a Pull Request

The PR template will guide you. The key things:

- Describe what changed and why
- Link any related issue (`Closes #123`)
- Confirm `npm run build` and `npm run smoke` both pass

## Questions?

Open an issue and tag it `question`. This project is maintained by a solo builder so response times may vary, but everything gets read.
