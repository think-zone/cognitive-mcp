import { DEFAULT_SCOPE, type Memory, type Page } from "./db.js";

/** Render one memory as a two-line markdown bullet. */
export function formatMemoryLine(m: Memory): string {
  const tags = m.tags.length ? `  _[${m.tags.join(", ")}]_` : "";
  const scope = m.scope && m.scope !== DEFAULT_SCOPE ? `  \`${m.scope}\`` : "";
  return `- **#${m.id}** ${m.content}${tags}${scope}\n  <sub>${m.created_at}</sub>`;
}

/** Render a page of memories as human-readable markdown. */
export function formatPageMarkdown(
  page: Page,
  opts: { title: string; emptyMessage: string }
): string {
  if (page.memories.length === 0) return opts.emptyMessage;

  const noun = page.total === 1 ? "memory" : "memories";
  const more = page.has_more ? ` — more available (next offset: ${page.next_offset}).` : ".";

  const lines: string[] = [
    `# ${opts.title}`,
    "",
    `Showing ${page.count} of ${page.total} ${noun}${more}`,
    "",
  ];
  for (const m of page.memories) lines.push(formatMemoryLine(m));
  return lines.join("\n");
}
