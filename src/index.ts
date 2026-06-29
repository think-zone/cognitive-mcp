#!/usr/bin/env node
/**
 * cognitive-mcp — persistent, local-first memory for AI agents over MCP.
 *
 * Five tools, one SQLite file, stdio transport. No server, no account, no cloud.
 *   - memory_store   save a note/fact with optional tags + scope
 *   - memory_search  keyword search across stored memories (optionally per scope)
 *   - memory_list    browse the most recent memories (optionally per scope)
 *   - memory_forget  delete a memory by id
 *   - memory_purge   delete every memory in a scope (namespace-level forget)
 *
 * Scopes namespace memory so multiple agents can share one store: `agent:<id>`
 * for private working memory, `shared:<key>` for cross-agent memory. Omitting a
 * scope keeps the v0.1 single-pool behaviour (everything in `agent:default`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore, resolveDbPath, DEFAULT_SCOPE, type Memory, type Page } from "./db.js";
import { formatPageMarkdown } from "./format.js";

const VERSION = "0.2.0";

// --- Shared input schemas ---------------------------------------------------
/** A single scope label to write into. */
const scopeInput = z
  .string()
  .min(1)
  .max(128)
  .describe(
    `Namespace for this memory. Convention: 'agent:<id>' for private memory, 'shared:<key>' for cross-agent memory. Defaults to '${DEFAULT_SCOPE}'.`
  );

/** Zero or more scopes to restrict a read to. Empty/omitted = all scopes. */
const scopesInput = z
  .array(z.string().min(1).max(128))
  .max(32)
  .optional()
  .describe("Only return memories in these scopes. Omit to search every scope.");

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// --- Shared output schemas --------------------------------------------------
const MemoryObject = z.object({
  id: z.number().describe("Unique memory id"),
  content: z.string().describe("The stored text"),
  tags: z.array(z.string()).describe("Tags attached to the memory"),
  scope: z.string().describe("Namespace the memory lives in"),
  created_at: z.string().describe("ISO-8601 creation timestamp"),
  updated_at: z.string().describe("ISO-8601 last-update timestamp"),
});

const pageOutputShape = {
  total: z.number().describe("Total memories matching the query"),
  count: z.number().describe("Number returned in this response"),
  offset: z.number().describe("Offset used for this page"),
  has_more: z.boolean().describe("Whether more results are available"),
  next_offset: z.number().optional().describe("Offset to pass for the next page"),
  memories: z.array(MemoryObject).describe("The matching memories, newest first"),
};

// --- Server + store ---------------------------------------------------------
const server = new McpServer({
  name: "cognitive-mcp-server",
  version: VERSION,
});

const store = new MemoryStore();

/** Build a CallToolResult for a page of memories (text + structured). */
function pageResult(page: Page, fmt: ResponseFormat, title: string, emptyMessage: string) {
  const text =
    fmt === ResponseFormat.JSON
      ? JSON.stringify(page, null, 2)
      : formatPageMarkdown(page, { title, emptyMessage });
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: page as unknown as Record<string, unknown>,
  };
}

// --- memory_store -----------------------------------------------------------
server.registerTool(
  "memory_store",
  {
    title: "Store Memory",
    description: `Save a fact, note, preference, or any piece of text so it can be recalled in a later session.

Use this whenever the user shares something worth remembering across conversations (a preference, a decision, a name, a recurring detail).

Args:
  - content (string, required): the text to remember (1-10000 chars)
  - tags (string[], optional): short labels to categorise the memory for later filtering (max 32)
  - scope (string, optional): namespace for this memory ('agent:<id>' private, 'shared:<key>' shared); defaults to '${DEFAULT_SCOPE}'

Returns: { memory: { id, content, tags, scope, created_at, updated_at } } — the stored memory with its assigned numeric id.`,
    inputSchema: {
      content: z
        .string()
        .min(1, "content must not be empty")
        .max(10000, "content must not exceed 10000 characters")
        .describe("The text to remember"),
      tags: z
        .array(z.string().min(1).max(64))
        .max(32)
        .optional()
        .describe("Optional labels to categorise this memory"),
      scope: scopeInput.optional(),
    },
    outputSchema: { memory: MemoryObject },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ content, tags, scope }) => {
    const memory: Memory = store.store(content, tags ?? [], scope);
    const tagText = memory.tags.length ? ` [tags: ${memory.tags.join(", ")}]` : "";
    const scopeText = memory.scope !== DEFAULT_SCOPE ? ` in ${memory.scope}` : "";
    return {
      content: [
        { type: "text" as const, text: `Stored memory #${memory.id}${scopeText}${tagText}.` },
      ],
      structuredContent: { memory },
    };
  }
);

// --- memory_search ----------------------------------------------------------
server.registerTool(
  "memory_search",
  {
    title: "Search Memory",
    description: `Search stored memories by keyword. Every whitespace-separated term must appear (case-insensitive substring match) in a memory's content. Optionally filter by tags. Results are newest-first and paginated.

This is plain keyword/substring search. Semantic (vector) search is on the roadmap and NOT yet available.

Args:
  - query (string, required): one or more keywords to match against memory content
  - tags (string[], optional): only return memories that carry ALL of these tags
  - limit (number, 1-100, default 20): max results to return
  - offset (number, default 0): results to skip, for pagination
  - scopes (string[], optional): only search within these namespaces; omit to search every scope
  - response_format ('markdown' | 'json', default 'markdown')

Returns: { total, count, offset, has_more, next_offset?, memories[] }`,
    inputSchema: {
      query: z
        .string()
        .min(1, "query must not be empty")
        .max(500, "query must not exceed 500 characters")
        .refine((value) => value.trim().length > 0, "query must include at least one non-whitespace character")
        .describe("Keywords to search for"),
      tags: z
        .array(z.string().min(1).max(64))
        .max(32)
        .optional()
        .describe("Only return memories carrying all of these tags"),
      scopes: scopesInput,
      limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Results to skip (pagination)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' (human-readable) or 'json' (structured)"),
    },
    outputSchema: pageOutputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, tags, scopes, limit, offset, response_format }) => {
    const page = store.search(query, tags ?? [], limit, offset, scopes ?? []);
    return pageResult(
      page,
      response_format,
      `Search: "${query}"`,
      `No memories found matching "${query}".`
    );
  }
);

// --- memory_list ------------------------------------------------------------
server.registerTool(
  "memory_list",
  {
    title: "List Memory",
    description: `Browse stored memories, newest first. Optionally filter by tags. Use this to review what has been remembered.

Args:
  - tags (string[], optional): only return memories carrying ALL of these tags
  - scopes (string[], optional): only list memories in these namespaces; omit to list every scope
  - limit (number, 1-100, default 20)
  - offset (number, default 0)
  - response_format ('markdown' | 'json', default 'markdown')

Returns: { total, count, offset, has_more, next_offset?, memories[] }`,
    inputSchema: {
      tags: z
        .array(z.string().min(1).max(64))
        .max(32)
        .optional()
        .describe("Only return memories carrying all of these tags"),
      scopes: scopesInput,
      limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Results to skip (pagination)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' (human-readable) or 'json' (structured)"),
    },
    outputSchema: pageOutputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ tags, scopes, limit, offset, response_format }) => {
    const page = store.list(limit, offset, tags ?? [], scopes ?? []);
    return pageResult(page, response_format, "Recent memories", "No memories stored yet.");
  }
);

// --- memory_forget ----------------------------------------------------------
server.registerTool(
  "memory_forget",
  {
    title: "Forget Memory",
    description: `Permanently delete a memory by its numeric id. This cannot be undone.

Use memory_search or memory_list first to find the id you want to remove.

Args:
  - id (number, required): the id of the memory to delete

Returns: { id, deleted } — 'deleted' is false if no memory had that id.`,
    inputSchema: {
      id: z.number().int().min(1).describe("The id of the memory to delete"),
    },
    outputSchema: {
      id: z.number().describe("The id that was requested"),
      deleted: z.boolean().describe("Whether a memory was actually deleted"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }) => {
    const deleted = store.forget(id);
    const text = deleted
      ? `Deleted memory #${id}.`
      : `No memory found with id ${id}; nothing deleted.`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { id, deleted },
    };
  }
);

// --- memory_purge -----------------------------------------------------------
server.registerTool(
  "memory_purge",
  {
    title: "Purge Scope",
    description: `Permanently delete EVERY memory in a scope (namespace). This cannot be undone.

Use this for retention / right-to-forget policy — dropping an entire namespace
(e.g. one agent's private memory) in a single call. To remove a single memory,
use memory_forget instead.

Args:
  - scope (string, required): the namespace to empty (e.g. 'agent:cb', 'shared:fans')

Returns: { scope, deleted } — 'deleted' is the number of memories removed.`,
    inputSchema: {
      scope: scopeInput,
    },
    outputSchema: {
      scope: z.string().describe("The scope that was purged"),
      deleted: z.number().describe("How many memories were deleted"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ scope }) => {
    const deleted = store.purgeScope(scope);
    const noun = deleted === 1 ? "memory" : "memories";
    return {
      content: [
        { type: "text" as const, text: `Purged ${deleted} ${noun} from scope ${scope}.` },
      ],
      structuredContent: { scope, deleted },
    };
  }
);

// --- Run --------------------------------------------------------------------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must never write to stdout — log to stderr only.
  console.error(`cognitive-mcp v${VERSION} ready (db: ${resolveDbPath()})`);
}

main().catch((error) => {
  console.error("Fatal error starting cognitive-mcp:", error);
  process.exit(1);
});
