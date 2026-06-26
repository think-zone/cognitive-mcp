import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Memory {
  id: number;
  content: string;
  tags: string[];
  context: string;
  weight: number;
  last_accessed: string;
  created_at: string;
  updated_at: string;
}
export interface Page {
  total: number; count: number; offset: number;
  has_more: boolean; next_offset?: number; memories: Memory[];
}
export interface MemoryLink {
  from_id: number; to_id: number; relation: string; created_at: string;
}
interface MemoryRow {
  id: number; content: string; tags: string; context: string;
  weight: number; last_accessed: string; created_at: string; updated_at: string;
}
interface LinkRow { from_id: number; to_id: number; relation: string; created_at: string; }

export function resolveDbPath(): string {
  const override = process.env.COGNITIVE_MCP_DB_PATH;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".cognitive-mcp", "memory.db");
}
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase(); if (!t || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}
export function tokenize(query: string): string[] {
  return query.split(/\s+/).map(t => t.trim()).filter(t => t.length > 0);
}
function escapeFts(term: string): string { return '"' + term.replace(/"/g, '""') + '"'; }

export class MemoryStore {
  private db: DatabaseSync;
  constructor(dbPath: string = resolveDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.applyDecay();
  }
  private migrate(): void {
    this.db.exec(/*sql*/`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]', context TEXT NOT NULL DEFAULT 'default',
        weight REAL NOT NULL DEFAULT 1.0, last_accessed TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_context ON memories(context);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_weight ON memories(weight DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, content='memories', content_rowid='id',
        tokenize='unicode61 remove_diacritics 1'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TABLE IF NOT EXISTS memory_links (
        from_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        to_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'related', created_at TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_id);
      CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_id);
    `);
  }
  private applyDecay(): void {
    this.db.exec(`
      UPDATE memories SET weight = MAX(0.05, weight * POW(0.99,
        CAST((julianday('now') - julianday(last_accessed)) AS REAL)))
      WHERE julianday('now') - julianday(last_accessed) > 1;
    `);
  }
  private rowToMemory(row: MemoryRow): Memory {
    let tags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
    } catch { tags = []; }
    return { id: row.id, content: row.content, tags, context: row.context,
      weight: row.weight, last_accessed: row.last_accessed,
      created_at: row.created_at, updated_at: row.updated_at };
  }
  store(content: string, tags: string[] = [], context = "default"): Memory {
    const now = new Date().toISOString();
    const normalized = normalizeTags(tags);
    const info = this.db.prepare(
      `INSERT INTO memories (content, tags, context, weight, last_accessed, created_at, updated_at)
       VALUES (?, ?, ?, 1.0, ?, ?, ?)`
    ).run(content, JSON.stringify(normalized), context, now, now, now);
    return { id: Number(info.lastInsertRowid), content, tags: normalized,
      context, weight: 1.0, last_accessed: now, created_at: now, updated_at: now };
  }
  get(id: number): Memory | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? this.rowToMemory(row) : undefined;
  }
  forget(id: number): boolean {
    return Number(this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes) > 0;
  }
  reinforce(id: number): Memory | undefined {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE memories SET weight = MIN(1.0, weight + (1.0 - weight) * 0.3),
      last_accessed = ? WHERE id = ?`).run(now, id);
    return this.get(id);
  }
  update(id: number, content: string, tags: string[]): Memory | undefined {
    const now = new Date().toISOString();
    const normalized = normalizeTags(tags);
    const changes = Number(this.db.prepare(
      `UPDATE memories SET content = ?, tags = ?, updated_at = ? WHERE id = ?`
    ).run(content, JSON.stringify(normalized), now, id).changes);
    return changes === 0 ? undefined : this.get(id);
  }
  exportAll(context?: string): Memory[] {
    const rows = context
      ? this.db.prepare(`SELECT * FROM memories WHERE context = ? ORDER BY created_at ASC`).all(context) as unknown as MemoryRow[]
      : this.db.prepare(`SELECT * FROM memories ORDER BY created_at ASC`).all() as unknown as MemoryRow[];
    return rows.map(r => this.rowToMemory(r));
  }
  importMemories(memories: Omit<Memory, "id">[]): number {
    const insert = this.db.prepare(
      `INSERT INTO memories (content, tags, context, weight, last_accessed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    let count = 0;
    for (const m of memories) {
      const normalized = normalizeTags(m.tags);
      insert.run(m.content, JSON.stringify(normalized), m.context ?? "default",
        m.weight ?? 1.0, m.last_accessed ?? m.created_at, m.created_at, m.updated_at);
      count++;
    }
    return count;
  }
  list(limit: number, offset: number, tags: string[] = [], context?: string): Page {
    return this.baseQuery({ tags, limit, offset, context });
  }
  search(query: string, tags: string[], limit: number, offset: number, context?: string): Page {
    const terms = tokenize(query);
    if (terms.length === 0) return this.list(limit, offset, tags, context);
    return this.ftsQuery(terms, tags, limit, offset, context);
  }
  private baseQuery(opts: { tags: string[]; limit: number; offset: number; context?: string }): Page {
    const { tags, limit, offset, context } = opts;
    const where: string[] = []; const params: (string | number)[] = [];
    if (context) { where.push(`m.context = ?`); params.push(context); }
    for (const tag of normalizeTags(tags)) {
      where.push(`EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)`);
      params.push(tag);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM memories m ${whereSql}`).get(...params) as { n: number | bigint };
    const rows = this.db.prepare(`SELECT m.* FROM memories m ${whereSql} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as MemoryRow[];
    return this.buildPage(rows, Number(totalRow.n), offset);
  }
  private ftsQuery(terms: string[], tags: string[], limit: number, offset: number, context?: string): Page {
    const ftsExpr = terms.map(escapeFts).join(" ");
    const tagFilters: string[] = []; const tagParams: string[] = [];
    for (const tag of normalizeTags(tags)) {
      tagFilters.push(`EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)`);
      tagParams.push(tag);
    }
    const ctxClause = context ? "AND m.context = ?" : "";
    const ctxParam = context ? [context] : [];
    const tagWhere = tagFilters.length ? `AND ${tagFilters.join(" AND ")}` : "";
    const countSql = `SELECT COUNT(*) AS n FROM memories_fts f JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ? ${ctxClause} ${tagWhere}`;
    const totalRow = this.db.prepare(countSql).get(ftsExpr, ...ctxParam, ...tagParams) as { n: number | bigint };
    const fetchSql = `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ? ${ctxClause} ${tagWhere}
      ORDER BY (-bm25(memories_fts)) * m.weight DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(fetchSql).all(ftsExpr, ...ctxParam, ...tagParams, limit, offset) as unknown as MemoryRow[];
    if (rows.length > 0) {
      const now = new Date().toISOString();
      const ph = rows.map(() => "?").join(",");
      this.db.prepare(`UPDATE memories SET last_accessed = ? WHERE id IN (${ph})`).run(now, ...rows.map(r => r.id));
    }
    return this.buildPage(rows, Number(totalRow.n), offset);
  }
  private buildPage(rows: MemoryRow[], total: number, offset: number): Page {
    const memories = rows.map(r => this.rowToMemory(r));
    const hasMore = offset + memories.length < total;
    return { total, count: memories.length, offset, has_more: hasMore,
      ...(hasMore ? { next_offset: offset + memories.length } : {}), memories };
  }
  link(fromId: number, toId: number, relation: string): MemoryLink {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR REPLACE INTO memory_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)`)
      .run(fromId, toId, relation, now);
    return { from_id: fromId, to_id: toId, relation, created_at: now };
  }
  unlink(fromId: number, toId: number, relation: string): boolean {
    return Number(this.db.prepare(`DELETE FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?`)
      .run(fromId, toId, relation).changes) > 0;
  }
  memoryContext(id: number): { memory: Memory | undefined; linked: Array<Memory & { relation: string; direction: "outbound" | "inbound" }> } {
    const memory = this.get(id);
    if (!memory) return { memory: undefined, linked: [] };
    const outRows = this.db.prepare(`SELECT m.*, l.relation FROM memory_links l JOIN memories m ON m.id = l.to_id WHERE l.from_id = ?`).all(id) as unknown as Array<MemoryRow & { relation: string }>;
    const inRows = this.db.prepare(`SELECT m.*, l.relation FROM memory_links l JOIN memories m ON m.id = l.from_id WHERE l.to_id = ?`).all(id) as unknown as Array<MemoryRow & { relation: string }>;
    return { memory, linked: [
      ...outRows.map(r => ({ ...this.rowToMemory(r), relation: r.relation, direction: "outbound" as const })),
      ...inRows.map(r => ({ ...this.rowToMemory(r), relation: r.relation, direction: "inbound" as const })),
    ]};
  }
  contexts(): string[] {
    return (this.db.prepare(`SELECT DISTINCT context FROM memories ORDER BY context`).all() as Array<{ context: string }>).map(r => r.context);
  }
  close(): void { this.db.close(); }
}
