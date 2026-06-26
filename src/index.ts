#!/usr/bin/env node
/**
 * cognitive-mcp — persistent, local-first memory for AI agents over MCP.
 *
 * v0.2 — "search by meaning of relevance, forget what's stale, think about what you know."
 *
 * Tools:
 *   memory_store      save a note/fact with optional tags + context
 *   memory_search     BM25-ranked full-text search (FTS5), weighted by recency/use
 *   memory_list       browse recent memories (optionally by context / tags)
 *   memory_forget     delete a memory by id
 *   memory_reinforce  bump a memory's weight so it decays slower and ranks higher
 *   memory_update     edit a memory's content/tags
 *   memory_link       create a typed link between two memories (knowledge graph)
 *   memory_context    fetch a memory plus everything linked to it
 *   memory_reflect    summarise a slice of memories via MCP sampling, store the brief
 *   memory_export     export memories as JSON for backup / sharing
 *   memory_import     import a previously exported JSON bundle
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MemoryStore,
  resolveDbPath,
  type Memory,
  type Page,
} from "./db.js";
import { formatPageMarkdown } from "./format.js";

const VERSION = "0.2.0";

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// --- Shared output schemas --------------------------------------------------
const MemoryObject = z.object({
  id: z.number().describe("Unique memory id"),
  content: z.string().describe("The stored text"),
  tags: z.array(z.string()).describe("Tags attached to the memory"),
  context: z.string().describe("Namespace this memory belongs to"),
  weight: z.number().describe("Relevance weight 0.05-1.0 (decays over time, rises on use)"),
  last_accessed: z.string().describe("ISO-8601 timestamp of last retrieval"),
  created_at: z.string().describe("ISO-8601 creation timestamp"),
  updated_at: z.string().describe("ISO-8601 last-update timestamp"),
});

const pageOutputShape = {
  total: z.number().describe("Total memories matching the query"),
  count: z.number().describe("Number returned in this response"),
  offset: z.number().describe("Offset used for this page"),
  has_more: z.boolean().describe("Whether more results are available"),
  next_offset: z.number().optional().describe("Offset to pass for the next page"),
  memories: z.array(MemoryObject).describe("The matching memories"),
};

// --- Server + store ---------------------------------------------------------
const server = new McpServer({
  name: "cognitive-mcp-server",
  version: VERSION,
});

const store = new MemoryStore();

/** Build a CallToolResult for a page of memories (text + structured). */
function pageResult(
  page: Page,
  fmt: ResponseFormat,
  title: string,
  emptyMessage: string
) {
  const text =
    fmt === ResponseFormat.JSON
      ? JSON.stringify(page, null, 2)
      : formatPageMarkdown(page, { title, emptyMessage });
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: page as unknown as Record<string, unknown>,
  };
}

// Reusable schema fragments
const tagsSchema = z
  .array(z.string().min(1).max(64))
  .max(32)
  .optional()
  .describe("Optional labels to categorise / filter memories");

const contextSchema = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe("Namespace to isolate memories (e.g. a project or persona). Defaults to 'default'.");

// --- memory_store -----------------------------------------------------------
server.registerTool(
  "memory_store",
  {
    title: "Store Memory",
    description: `Save a fact, note, preference, or any piece of text so it can be recalled in a later session.

Use this whenever the user shares something worth remembering across conversations.

Args:
- content (string, required): the text to remember (1-10000 chars)
- tags (string[], optional): short labels for later filtering (max 32)
- context (string, optional): a namespace to isolate this memory (default 'default')

Returns: { memory } — the stored memory with its assigned numeric id.`,
    inputSchema: {
      content: z
        .string()
        .min(1, "content must not be empty")
        .max(10000, "content must not exceed 10000 characters")
        .describe("The text to remember"),
      tags: tagsSchema,
      context: contextSchema,
    },
    outputSchema: { memory: MemoryObject },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ content, tags, context }) => {
    const memory: Memory = store.store(content, tags ?? [], context ?? "default");
    const tagText = memory.tags.length ? ` [tags: ${memory.tags.join(", ")}]` : "";
    const ctxText = memory.context !== "default" ? ` (context: ${memory.context})` : "";
    return {
      content: [
        { type: "text" as const, text: `Stored memory #${memory.id}${tagText}${ctxText}.` },
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
    description: `Full-text search across stored memories, ranked by relevance (BM25) and memory weight, so the most pertinent and frequently used memories surface first.

Supports prefix matching (deploy* matches "deployment") and phrase queries. Results are paginated.

Args:
- query (string, required): keywords or phrases to match
- tags (string[], optional): only return memories carrying ALL of these tags
- context (string, optional): restrict the search to one namespace
- limit (number, 1-100, default 20): max results
- offset (number, default 0): results to skip
- response_format ('markdown' | 'json', default 'markdown')

Returns: { total, count, offset, has_more, next_offset?, memories[] }`,
    inputSchema: {
      query: z
        .string()
        .min(1, "query must not be empty")
        .max(500, "query must not exceed 500 characters")
        .describe("Keywords or phrases to search for"),
      tags: tagsSchema,
      context: contextSchema,
      limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Results to skip (pagination)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' or 'json'"),
    },
    outputSchema: pageOutputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, tags, context, limit, offset, response_format }) => {
    const page = store.search(query, tags ?? [], limit, offset, context);
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
    description: `Browse stored memories, newest first. Optionally filter by context and/or tags.

Args:
- tags (string[], optional): only return memories carrying ALL of these tags
- context (string, optional): restrict to one namespace
- limit (number, 1-100, default 20)
- offset (number, default 0)
- response_format ('markdown' | 'json', default 'markdown')

Returns: { total, count, offset, has_more, next_offset?, memories[] }`,
    inputSchema: {
      tags: tagsSchema,
      context: contextSchema,
      limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
      offset: z.number().int().min(0).default(0).describe("Results to skip (pagination)"),
      response_format: z
        .nativeEnum(ResponseFormat)
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: 'markdown' or 'json'"),
    },
    outputSchema: pageOutputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ tags, context, limit, offset, response_format }) => {
    const page = store.list(limit, offset, tags ?? [], context);
    return pageResult(page, response_format, "Recent memories", "No memories stored yet.");
  }
);

// --- memory_forget ----------------------------------------------------------
server.registerTool(
  "memory_forget",
  {
    title: "Forget Memory",
    description: `Permanently delete a memory by its numeric id. This cannot be undone.

Args:
- id (number, required): the id of the memory to delete

Returns: { id, deleted }`,
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

// --- memory_reinforce -------------------------------------------------------
server.registerTool(
  "memory_reinforce",
  {
    title: "Reinforce Memory",
    description: `Strengthen a memory you found useful so it decays more slowly and ranks higher in future searches. Call this when you act on a recalled memory.

Args:
- id (number, required): the memory to reinforce

Returns: { memory } with its updated weight, or { found: false } if no such id.`,
    inputSchema: {
      id: z.number().int().min(1).describe("The id of the memory to reinforce"),
    },
    outputSchema: {
      found: z.boolean(),
      memory: MemoryObject.optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ id }) => {
    const memory = store.reinforce(id);
    if (!memory) {
      return {
        content: [{ type: "text" as const, text: `No memory found with id ${id}.` }],
        structuredContent: { found: false },
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Reinforced memory #${id} (weight now ${memory.weight.toFixed(2)}).`,
        },
      ],
      structuredContent: { found: true, memory },
    };
  }
);

// --- memory_update ----------------------------------------------------------
server.registerTool(
  "memory_update",
  {
    title: "Update Memory",
    description: `Edit the content and tags of an existing memory.

Args:
- id (number, required)
- content (string, required): the new text (1-10000 chars)
- tags (string[], optional): replaces the existing tag set

Returns: { found, memory? }`,
    inputSchema: {
      id: z.number().int().min(1).describe("The id of the memory to update"),
      content: z.string().min(1).max(10000).describe("New content"),
      tags: tagsSchema,
    },
    outputSchema: {
      found: z.boolean(),
      memory: MemoryObject.optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id, content, tags }) => {
    const memory = store.update(id, content, tags ?? []);
    if (!memory) {
      return {
        content: [{ type: "text" as const, text: `No memory found with id ${id}.` }],
        structuredContent: { found: false },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Updated memory #${id}.` }],
      structuredContent: { found: true, memory },
    };
  }
);

// --- memory_link ------------------------------------------------------------
server.registerTool(
  "memory_link",
  {
    title: "Link Memories",
    description: `Create a typed, directed link between two memories to build a knowledge graph. Examples of relations: 'caused_by', 'contradicts', 'see_also', 'depends_on', 'related'.

Args:
- from_id (number, required): source memory
- to_id (number, required): target memory
- relation (string, optional, default 'related'): the edge label

Returns: { link }`,
    inputSchema: {
      from_id: z.number().int().min(1).describe("Source memory id"),
      to_id: z.number().int().min(1).describe("Target memory id"),
      relation: z
        .string()
        .min(1)
        .max(64)
        .default("related")
        .describe("The relationship type"),
    },
    outputSchema: {
      link: z.object({
        from_id: z.number(),
        to_id: z.number(),
        relation: z.string(),
        created_at: z.string(),
      }),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ from_id, to_id, relation }) => {
    const link = store.link(from_id, to_id, relation);
    return {
      content: [
        {
          type: "text" as const,
          text: `Linked #${from_id} —[${relation}]→ #${to_id}.`,
        },
      ],
      structuredContent: { link },
    };
  }
);

// --- memory_context ---------------------------------------------------------
server.registerTool(
  "memory_context",
  {
    title: "Memory Context",
    description: `Fetch a memory together with every memory directly linked to it. Use this to pull in related context around a single fact.

Args:
- id (number, required): the focal memory

Returns: { found, memory?, linked[] } where each linked item carries its relation and direction.`,
    inputSchema: {
      id: z.number().int().min(1).describe("The focal memory id"),
    },
    outputSchema: {
      found: z.boolean(),
      memory: MemoryObject.optional(),
      linked: z
        .array(
          MemoryObject.extend({
            relation: z.string(),
            direction: z.enum(["outbound", "inbound"]),
          })
        )
        .describe("Directly linked memories"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }) => {
    const { memory, linked } = store.memoryContext(id);
    if (!memory) {
      return {
        content: [{ type: "text" as const, text: `No memory found with id ${id}.` }],
        structuredContent: { found: false, linked: [] },
      };
    }
    const lines = [`# Memory #${memory.id}`, "", memory.content, ""];
    if (linked.length) {
      lines.push(`## Linked (${linked.length})`);
      for (const l of linked) {
        const arrow = l.direction === "outbound" ? "→" : "←";
        lines.push(`- ${arrow} [${l.relation}] #${l.id}: ${l.content}`);
      }
    } else {
      lines.push("_No linked memories._");
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      structuredContent: { found: true, memory, linked },
    };
  }
);

// --- memory_reflect ---------------------------------------------------------
server.registerTool(
  "memory_reflect",
  {
    title: "Reflect on Memories",
    description: `Summarise or analyse a slice of memories and store the result as a new memory. Uses MCP sampling (the connected client's own model) — no extra API key or model required. If the client does not support sampling, returns the gathered memories for you to summarise yourself.

Args:
- prompt (string, required): what to reflect on (e.g. "the open decisions")
- tags (string[], optional): only reflect over memories with these tags
- context (string, optional): only reflect over this namespace
- limit (number, default 50): max memories to feed into the reflection
- store_result (boolean, default true): store the brief as a new memory tagged 'reflection'

Returns: { reflection, stored_memory? }`,
    inputSchema: {
      prompt: z.string().min(1).max(500).describe("What to reflect on"),
      tags: tagsSchema,
      context: contextSchema,
      limit: z.number().int().min(1).max(200).default(50).describe("Max memories to consider"),
      store_result: z
        .boolean()
        .default(true)
        .describe("Whether to store the brief as a new memory"),
    },
    outputSchema: {
      reflection: z.string(),
      sampled: z.boolean().describe("Whether the brief was generated via MCP sampling"),
      stored_memory: MemoryObject.optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ prompt, tags, context, limit, store_result }) => {
    const page = store.list(limit, 0, tags ?? [], context);
    if (page.memories.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No memories to reflect on." }],
        structuredContent: { reflection: "", sampled: false },
      };
    }

    const corpus = page.memories
      .map((m) => `#${m.id}: ${m.content}${m.tags.length ? ` [${m.tags.join(", ")}]` : ""}`)
      .join("\n");

    let reflection = "";
    let sampled = false;

    // Try MCP sampling — the client's own LLM produces the brief.
    try {
      const result = await server.server.createMessage({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Here are stored memories:\n\n${corpus}\n\nTask: ${prompt}\n\nWrite a concise brief (max 200 words).`,
            },
          },
        ],
        maxTokens: 400,
      });
      if (result?.content?.type === "text") {
        reflection = result.content.text.trim();
        sampled = true;
      }
    } catch {
      // Sampling unsupported — fall back to returning the corpus for the caller.
      reflection =
        `(Sampling unavailable — ${page.memories.length} memories gathered for "${prompt}".)\n\n${corpus}`;
    }

    let storedMemory: Memory | undefined;
    if (store_result && sampled && reflection) {
      storedMemory = store.store(
        reflection,
        ["reflection", ...(tags ?? [])],
        context ?? "default"
      );
    }

    return {
      content: [{ type: "text" as const, text: reflection }],
      structuredContent: {
        reflection,
        sampled,
        ...(storedMemory ? { stored_memory: storedMemory } : {}),
      },
    };
  }
);

// --- memory_export ----------------------------------------------------------
server.registerTool(
  "memory_export",
  {
    title: "Export Memories",
    description: `Export memories as a JSON bundle for backup, version control, or sharing with another agent. Optionally limit to one context.

Args:
- context (string, optional): only export this namespace

Returns: { count, bundle } where bundle is a JSON string of the memories.`,
    inputSchema: {
      context: contextSchema,
    },
    outputSchema: {
      count: z.number(),
      bundle: z.string().describe("JSON string of exported memories"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ context }) => {
    const memories = store.exportAll(context);
    const bundle = JSON.stringify({ version: VERSION, memories }, null, 2);
    return {
      content: [{ type: "text" as const, text: bundle }],
      structuredContent: { count: memories.length, bundle },
    };
  }
);

// --- memory_import ----------------------------------------------------------
server.registerTool(
  "memory_import",
  {
    title: "Import Memories",
    description: `Import a previously exported JSON bundle. Memories are appended (new ids assigned); existing memories are untouched.

Args:
- bundle (string, required): the JSON produced by memory_export

Returns: { imported }`,
    inputSchema: {
      bundle: z.string().min(2).describe("JSON bundle from memory_export"),
    },
    outputSchema: {
      imported: z.number(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ bundle }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bundle);
    } catch {
      throw new Error("bundle is not valid JSON");
    }
    const memories =
      parsed && typeof parsed === "object" && "memories" in parsed
        ? (parsed as { memories: Omit<Memory, "id">[] }).memories
        : (parsed as Omit<Memory, "id">[]);
    if (!Array.isArray(memories)) {
      throw new Error("bundle does not contain a memories array");
    }
    const imported = store.importMemories(memories);
    return {
      content: [{ type: "text" as const, text: `Imported ${imported} memories.` }],
      structuredContent: { imported },
    };
  }
);

// --- Run --------------------------------------------------------------------
async function main(): Promise<void> {
  // Fail fast with a clear message on unsupported Node versions (node:sqlite needs 22.5+)
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(
      `cognitive-mcp requires Node.js >= 22.5.0 (you have ${process.versions.node}).`
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdio servers must never write to stdout — log to stderr only.
  console.error(`cognitive-mcp v${VERSION} ready (db: ${resolveDbPath()})`);
}

main().catch((error) => {
  console.error("Fatal error starting cognitive-mcp:", error);
  process.exit(1);
});
