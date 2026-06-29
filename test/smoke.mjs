// Smoke test: spawn the built server over stdio and exercise all four tools
// end-to-end through a real MCP client. Uses a throwaway temp DB so it never
// touches your real ~/.cognitive-mcp store.
//
//   npm run build && npm run smoke
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
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, COGNITIVE_MCP_DB_PATH: dbPath },
  stderr: "inherit",
});

const client = new Client({ name: "cognitive-mcp-smoke", version: "0.0.0" });

try {
  await client.connect(transport);

  // tools/list
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check("lists exactly five tools", names.length === 5, `got [${names.join(", ")}]`);
  for (const expected of [
    "memory_forget",
    "memory_list",
    "memory_purge",
    "memory_search",
    "memory_store",
  ]) {
    check(`exposes ${expected}`, names.includes(expected));
  }

  // store two memories
  const a = await client.callTool({
    name: "memory_store",
    arguments: { content: "DW prefers dark mode and tabs over spaces", tags: ["preference", "dw"] },
  });
  const idA = a.structuredContent?.memory?.id;
  check("store returns a numeric id", typeof idA === "number", JSON.stringify(a.structuredContent));

  const b = await client.callTool({
    name: "memory_store",
    arguments: { content: "disco-bass deploy webhook is at disco-bass.com/api/stripe/webhook", tags: ["discoslop"] },
  });
  const idB = b.structuredContent?.memory?.id;
  check("second store gets a distinct id", typeof idB === "number" && idB !== idA);

  // keyword search (json)
  const s = await client.callTool({
    name: "memory_search",
    arguments: { query: "dark mode", response_format: "json" },
  });
  check(
    "search matches the right memory",
    s.structuredContent?.total === 1 && s.structuredContent?.memories?.[0]?.id === idA,
    JSON.stringify(s.structuredContent)
  );

  // multi-term search must AND the terms
  const sAnd = await client.callTool({
    name: "memory_search",
    arguments: { query: "dark webhook", response_format: "json" },
  });
  check("multi-term search ANDs terms (no match)", sAnd.structuredContent?.total === 0);

  // no-match search
  const s0 = await client.callTool({
    name: "memory_search",
    arguments: { query: "nonexistentxyz", response_format: "json" },
  });
  check("no-match search returns 0", s0.structuredContent?.total === 0);

  // whitespace-only query should be rejected
  const whitespace = await client.callTool({
    name: "memory_search",
    arguments: { query: "   ", response_format: "json" },
  });
  check("whitespace-only search query is rejected", whitespace.isError === true);

  // tag filter via list
  const l = await client.callTool({
    name: "memory_list",
    arguments: { tags: ["discoslop"], response_format: "json" },
  });
  check(
    "list tag filter narrows correctly",
    l.structuredContent?.total === 1 && l.structuredContent?.memories?.[0]?.id === idB
  );

  // list all, newest first
  const lall = await client.callTool({ name: "memory_list", arguments: { response_format: "json" } });
  check(
    "list returns both, newest first",
    lall.structuredContent?.total === 2 && lall.structuredContent?.memories?.[0]?.id === idB
  );

  // markdown is the default format
  const lmd = await client.callTool({ name: "memory_list", arguments: {} });
  check(
    "default response_format is markdown",
    typeof lmd.content?.[0]?.text === "string" && lmd.content[0].text.includes("# Recent memories")
  );

  // forget
  const f = await client.callTool({ name: "memory_forget", arguments: { id: idA } });
  check("forget deletes the memory", f.structuredContent?.deleted === true);

  const f2 = await client.callTool({ name: "memory_forget", arguments: { id: idA } });
  check("forget is idempotent once gone", f2.structuredContent?.deleted === false);

  const after = await client.callTool({ name: "memory_list", arguments: { response_format: "json" } });
  check("one memory remains after forget", after.structuredContent?.total === 1);

  // --- scopes ---------------------------------------------------------------
  // remaining memory (idB) was stored without a scope -> default namespace
  check("unscoped memory lands in agent:default", after.structuredContent?.memories?.[0]?.scope === "agent:default");

  // store into three distinct scopes
  const cb = await client.callTool({
    name: "memory_store",
    arguments: { content: "tipper RoyalFan converts on goal hits", tags: ["lead"], scope: "agent:cb" },
  });
  check("store honours scope", cb.structuredContent?.memory?.scope === "agent:cb");
  const idCb = cb.structuredContent?.memory?.id;

  await client.callTool({
    name: "memory_store",
    arguments: { content: "OF welcome email template v2", scope: "agent:of" },
  });
  await client.callTool({
    name: "memory_store",
    arguments: { content: "fan_42 = high-value cross-platform lead", tags: ["lead"], scope: "shared:fans" },
  });

  // list filtered to a single scope
  const onlyCb = await client.callTool({
    name: "memory_list",
    arguments: { scopes: ["agent:cb"], response_format: "json" },
  });
  check(
    "list scope filter isolates one namespace",
    onlyCb.structuredContent?.total === 1 && onlyCb.structuredContent?.memories?.[0]?.id === idCb
  );

  // list spanning multiple scopes
  const multi = await client.callTool({
    name: "memory_list",
    arguments: { scopes: ["agent:cb", "shared:fans"], response_format: "json" },
  });
  check("list spans multiple scopes", multi.structuredContent?.total === 2);

  // search constrained by scope
  const scopedSearch = await client.callTool({
    name: "memory_search",
    arguments: { query: "lead", scopes: ["shared:fans"], response_format: "json" },
  });
  check(
    "search respects scope filter",
    scopedSearch.structuredContent?.total === 1 &&
      scopedSearch.structuredContent?.memories?.[0]?.scope === "shared:fans"
  );

  // unscoped search sees every namespace: "fan" is in agent:cb (RoyalFan)
  // and shared:fans (fan_42) content, across two different scopes
  const allFan = await client.callTool({
    name: "memory_search",
    arguments: { query: "fan", response_format: "json" },
  });
  check("unscoped search spans all scopes", allFan.structuredContent?.total === 2);

  // purge an entire scope
  const purge = await client.callTool({ name: "memory_purge", arguments: { scope: "agent:cb" } });
  check("purge reports deleted count", purge.structuredContent?.deleted === 1);

  const cbGone = await client.callTool({
    name: "memory_list",
    arguments: { scopes: ["agent:cb"], response_format: "json" },
  });
  check("purged scope is empty", cbGone.structuredContent?.total === 0);

  // purge leaves other scopes untouched
  const ofLeft = await client.callTool({
    name: "memory_list",
    arguments: { scopes: ["agent:of"], response_format: "json" },
  });
  check("purge does not touch other scopes", ofLeft.structuredContent?.total === 1);

  // purging an empty/unknown scope deletes nothing
  const purge0 = await client.callTool({ name: "memory_purge", arguments: { scope: "agent:cb" } });
  check("purge of empty scope deletes nothing", purge0.structuredContent?.deleted === 0);

  await client.close();
} catch (err) {
  failures++;
  console.error("Smoke test threw:", err);
} finally {
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
