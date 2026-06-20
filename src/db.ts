import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A single stored memory. */
export interface Memory {
  id: number;
  content: string;
  tags: string[];
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
    `);
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
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Save a new memory and return it (with its assigned id and timestamps). */
  store(content: string, tags: string[] = []): Memory {
    const now = new Date().toISOString();
    const normalized = normalizeTags(tags);
    const info = this.db
      .prepare(
        `INSERT INTO memories (content, tags, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
      .run(content, JSON.stringify(normalized), now, now);
    return {
      id: Number(info.lastInsertRowid),
      content,
      tags: normalized,
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

  /** Browse memories newest-first, optionally filtered by tags. */
  list(limit: number, offset: number, tags: string[] = []): Page {
    return this.query({ terms: [], tags, limit, offset });
  }

  /** Keyword search: every term must appear in content; optional tag filter. */
  search(query: string, tags: string[], limit: number, offset: number): Page {
    return this.query({ terms: tokenize(query), tags, limit, offset });
  }

  private query(opts: {
    terms: string[];
    tags: string[];
    limit: number;
    offset: number;
  }): Page {
    const { terms, tags, limit, offset } = opts;
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
