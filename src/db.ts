import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The default scope a memory lands in when none is supplied. Keeps the v0.1
 * single-pool behaviour intact: existing callers that never pass a scope keep
 * reading and writing one shared namespace.
 */
export const DEFAULT_SCOPE = "agent:default";

/** A single stored memory. */
export interface Memory {
  id: number;
  content: string;
  tags: string[];
  scope: string;
  created_at: string;
  updated_at: string;
}

/** A paginated set of memories. */
export interface Page {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  memories: Memory[];
}

interface MemoryRow {
  id: number;
  content: string;
  tags: string; // JSON array of strings
  scope: string;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the SQLite file path. Override with the COGNITIVE_MCP_DB_PATH env var.
 * Defaults to ~/.cognitive-mcp/memory.db so memory persists across sessions
 * regardless of the working directory the server was launched from.
 */
export function resolveDbPath(): string {
  const override = process.env.COGNITIVE_MCP_DB_PATH;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".cognitive-mcp", "memory.db");
}

/** De-duplicate and trim tags, preserving first-seen order. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Normalize a scope label. Trims surrounding whitespace and falls back to
 * {@link DEFAULT_SCOPE} for empty/blank input, so a missing scope is never an
 * error — it just means "the default namespace". Convention is `agent:<id>` for
 * private working memory and `shared:<key>` for cross-agent memory, but the
 * store does not enforce that shape — any non-blank label is a valid scope.
 */
export function normalizeScope(scope?: string): string {
  const s = (scope ?? "").trim();
  return s.length > 0 ? s : DEFAULT_SCOPE;
}

/** De-duplicate and trim a list of scopes, preserving first-seen order. */
export function normalizeScopes(scopes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of scopes) {
    const s = raw.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Split a free-text query into whitespace-separated search terms. */
export function tokenize(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * A tiny persistent memory store backed by a single SQLite file via Node's
 * built-in `node:sqlite` (no native dependencies). Synchronous on purpose —
 * the operations are local and fast, and the MCP handlers stay simple.
 */
export class MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string = resolveDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT '${DEFAULT_SCOPE}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
    `);
    this.migrate();
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);`
    );
  }

  /**
   * Forward-only migrations for databases created by an earlier version.
   * Adds the `scope` column to pre-scope stores; existing rows fall into
   * {@link DEFAULT_SCOPE}, preserving the old single-pool behaviour.
   */
  private migrate(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(memories)`)
      .all() as unknown as Array<{ name: string }>;
    const hasScope = columns.some((c) => c.name === "scope");
    if (!hasScope) {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT '${DEFAULT_SCOPE}';`
      );
    }
  }

  private rowToMemory(row: MemoryRow): Memory {
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      content: row.content,
      tags,
      scope: row.scope ?? DEFAULT_SCOPE,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Save a new memory and return it (with its assigned id and timestamps). */
  store(content: string, tags: string[] = [], scope?: string): Memory {
    const now = new Date().toISOString();
    const normalized = normalizeTags(tags);
    const resolvedScope = normalizeScope(scope);
    const info = this.db
      .prepare(
        `INSERT INTO memories (content, tags, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(content, JSON.stringify(normalized), resolvedScope, now, now);
    return {
      id: Number(info.lastInsertRowid),
      content,
      tags: normalized,
      scope: resolvedScope,
      created_at: now,
      updated_at: now,
    };
  }

  /** Fetch a single memory by id, or undefined if it does not exist. */
  get(id: number): Memory | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
      | MemoryRow
      | undefined;
    return row ? this.rowToMemory(row) : undefined;
  }

  /** Delete a memory by id. Returns true if a row was removed. */
  forget(id: number): boolean {
    return Number(this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes) > 0;
  }

  /**
   * Delete every memory in a scope. Returns how many rows were removed.
   * This is the scope-level purge backing retention / right-to-forget policy —
   * dropping an entire namespace (e.g. one agent's private memory) in one call.
   */
  purgeScope(scope: string): number {
    const resolved = normalizeScope(scope);
    return Number(
      this.db.prepare(`DELETE FROM memories WHERE scope = ?`).run(resolved).changes
    );
  }

  /** Browse memories newest-first, optionally filtered by tags and scope. */
  list(limit: number, offset: number, tags: string[] = [], scopes: string[] = []): Page {
    return this.query({ terms: [], tags, scopes, limit, offset });
  }

  /** Keyword search: every term must appear in content; optional tag + scope filter. */
  search(
    query: string,
    tags: string[],
    limit: number,
    offset: number,
    scopes: string[] = []
  ): Page {
    return this.query({ terms: tokenize(query), tags, scopes, limit, offset });
  }

  private query(opts: {
    terms: string[];
    tags: string[];
    scopes: string[];
    limit: number;
    offset: number;
  }): Page {
    const { terms, tags, scopes, limit, offset } = opts;
    const where: string[] = [];
    const params: (string | number)[] = [];

    for (const term of terms) {
      where.push(`LOWER(content) LIKE ?`);
      params.push(`%${term.toLowerCase()}%`);
    }
    for (const tag of normalizeTags(tags)) {
      // tags are stored as a JSON array of strings; match the quoted token
      where.push(`LOWER(tags) LIKE ?`);
      params.push(`%${JSON.stringify(tag).toLowerCase()}%`);
    }
    const scopeFilter = normalizeScopes(scopes);
    if (scopeFilter.length) {
      where.push(`scope IN (${scopeFilter.map(() => "?").join(", ")})`);
      params.push(...scopeFilter);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memories ${whereSql}`)
      .get(...params) as { n: number | bigint };
    const total = Number(totalRow.n);

    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as unknown as MemoryRow[];

    const memories = rows.map((r) => this.rowToMemory(r));
    const hasMore = offset + memories.length < total;
    return {
      total,
      count: memories.length,
      offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + memories.length } : {}),
      memories,
    };
  }

  close(): void {
    this.db.close();
  }
}
