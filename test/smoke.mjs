// Smoke test: spawn the built server over stdio and exercise all tools
// end-to-end through a real MCP client. Uses a throwaway temp DB so it never
// touches your real ~/.cognitive-mcp store.
//
// npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "dist", "index.js");

const tmpDir = mkdtempSync(join(tmpdir(), "cognitive-mcp-smoke-"));
const dbPath = join(tmpDir, "memory.db");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

// Abort if the suite hangs (e.g. server never connects).
const watchdog = setTimeout(() => {
  console.error("\nSmoke test timed out after 30s.");
  process.exit(1);
}, 30_000);
watchdog.unref?.();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, COGNITIVE_MCP_DB_PATH: dbPath },
  stderr: "inherit",
});

const client = new Client({ name: "cognitive-mcp-smoke", version: "0.0.0" });

try {
  await client.connect(transport);

  // tools/list — expect the full v0.2 tool set
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expectedTools = [
    "memory_context",
    "memory_export",
    "memory_forget",
    "memory_import",
    "memory_link",
    "memory_list",
    "memory_reflect",
    "memory_reinforce",
    "memory_search",
    "memory_store",
    "memory_update",
  ];
  check("lists all v0.2 tools", names.length === expectedTools.length, `got [${names.join(", ")}]`);
  for (const expected of expectedTools) {
    check(`exposes ${expected}`, names.includes(expected));
  }

  // store two memories
  const a = await client.callTool({
    name: "memory_store",
    arguments: { content: "DW prefers dark mode and tabs over spaces", tags: ["preference", "dw"] },
  });
  const idA = a.structuredContent?.memory?.id;
  check("store returns a numeric id", typeof idA === "number", JSON.stringify(a.structuredContent));
  check("store defaults to 'default' context", a.structuredContent?.memory?.context === "default");
  check("store seeds weight at 1.0", a.structuredContent?.memory?.weight === 1.0);

  const b = await client.callTool({
    name: "memory_store",
    arguments: {
      content: "disco-bass deploy webhook is at disco-bass.com/api/stripe/webhook",
      tags: ["discoslop"],
      context: "work",
    },
  });
  const idB = b.structuredContent?.memory?.id;
  check("second store gets a distinct id", typeof idB === "number" && idB !== idA);
  check("store honours custom context", b.structuredContent?.memory?.context === "work");

  // FTS5 search (json)
  const s = await client.callTool({
    name: "memory_search",
    arguments: { query: "dark mode", response_format: "json" },
  });
  check(
    "FTS search matches the right memory",
    s.structuredContent?.total === 1 && s.structuredContent?.memories?.[0]?.id === idA,
    JSON.stringify(s.structuredContent)
  );

  // prefix search (FTS5 superpower vs v0.1 LIKE)
  const sPrefix = await client.callTool({
    name: "memory_search",
    arguments: { query: "deploy", response_format: "json" },
  });
  check("FTS matches by token (deploy)", sPrefix.structuredContent?.total === 1 && sPrefix.structuredContent?.memories?.[0]?.id === idB);

  // multi-term search must AND the terms
  const sAnd = await client.callTool({
    name: "memory_search",
    arguments: { query: "dark webhook", response_format: "json" },
  });
  check("multi-term search ANDs terms (no match)", sAnd.structuredContent?.total === 0);

  // context-scoped search
  const sCtx = await client.callTool({
    name: "memory_search",
    arguments: { query: "webhook", context: "work", response_format: "json" },
  });
  check("context filter scopes search", sCtx.structuredContent?.total === 1 && sCtx.structuredContent?.memories?.[0]?.id === idB);

  const sCtxMiss = await client.callTool({
    name: "memory_search",
    arguments: { query: "webhook", context: "default", response_format: "json" },
  });
  check("context filter excludes other namespaces", sCtxMiss.structuredContent?.total === 0);

  // tag filter via list (json_each — exact, no false positives)
  const l = await client.callTool({
    name: "memory_list",
    arguments: { tags: ["discoslop"], response_format: "json" },
  });
  check(
    "list tag filter narrows correctly",
    l.structuredContent?.total === 1 && l.structuredContent?.memories?.[0]?.id === idB
  );

  // reinforce raises weight
  const r = await client.callTool({ name: "memory_reinforce", arguments: { id: idA } });
  check("reinforce reports found", r.structuredContent?.found === true);
  check("reinforce keeps weight <= 1.0", (r.structuredContent?.memory?.weight ?? 0) <= 1.0);

  // update edits content
  const u = await client.callTool({
    name: "memory_update",
    arguments: { id: idA, content: "DW now prefers light mode", tags: ["preference"] },
  });
  check("update edits content", u.structuredContent?.memory?.content === "DW now prefers light mode");
  const sUpdated = await client.callTool({
    name: "memory_search",
    arguments: { query: "light", response_format: "json" },
  });
  check("FTS index updates on edit", sUpdated.structuredContent?.total === 1 && sUpdated.structuredContent?.memories?.[0]?.id === idA);

  // memory graph: link + context
  await client.callTool({ name: "memory_link", arguments: { from_id: idA, to_id: idB, relation: "see_also" } });
  const ctx = await client.callTool({ name: "memory_context", arguments: { id: idA } });
  check("memory_context returns the focal memory", ctx.structuredContent?.memory?.id === idA);
  check(
    "memory_context returns linked neighbour",
    Array.isArray(ctx.structuredContent?.linked) &&
      ctx.structuredContent.linked.some((m) => m.id === idB && m.relation === "see_also")
  );

  // export / import round-trips
  const exp = await client.callTool({ name: "memory_export", arguments: {} });
  check("export reports a count", exp.structuredContent?.count === 2);
  const bundle = exp.structuredContent?.bundle;
  const imp = await client.callTool({ name: "memory_import", arguments: { bundle } });
  check("import re-adds the exported memories", imp.structuredContent?.imported === 2);
  const afterImport = await client.callTool({ name: "memory_list", arguments: { response_format: "json" } });
  check("store doubles after import", afterImport.structuredContent?.total === 4);

  // markdown is the default format
  const lmd = await client.callTool({ name: "memory_list", arguments: {} });
  check(
    "default response_format is markdown",
    typeof lmd.content?.[0]?.text === "string" && lmd.content[0].text.includes("# Recent memories")
  );

  // forget + cascade
  const f = await client.callTool({ name: "memory_forget", arguments: { id: idA } });
  check("forget deletes the memory", f.structuredContent?.deleted === true);
  const f2 = await client.callTool({ name: "memory_forget", arguments: { id: idA } });
  check("forget is idempotent once gone", f2.structuredContent?.deleted === false);

  // deleting a linked memory cascades its links (no orphan in context)
  const ctxGone = await client.callTool({ name: "memory_context", arguments: { id: idB } });
  check(
    "links cascade on delete",
    !(ctxGone.structuredContent?.linked ?? []).some((m) => m.id === idA)
  );

  await client.close();
} catch (err) {
  failures++;
  console.error("Smoke test threw:", err);
} finally {
  clearTimeout(watchdog);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
