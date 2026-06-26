import type { Memory, Page } from "./db.js";

/** Render one memory as a markdown bullet, including context + weight cues. */
export function formatMemoryLine(m: Memory): string {
  const tags = m.tags.length ? ` _[${m.tags.join(", ")}]_` : "";
  const ctx = m.context && m.context !== "default" ? ` \`${m.context}\`` : "";
  // A compact weight indicator so users can see decayed vs. fresh memories.
  const w = m.weight < 0.5 ? " · faded" : m.weight >= 0.99 ? "" : "";
  return `- **#${m.id}**${ctx} ${m.content}${tags}\n  <sub>${m.created_at}${w}</sub>`;
}

/** Render a page of memories as human-readable markdown. */
export function formatPageMarkdown(
  page: Page,
  opts: { title: string; emptyMessage: string }
): string {
  if (page.memories.length === 0) return opts.emptyMessage;

  const noun = page.total === 1 ? "memory" : "memories";
  const more = page.has_more
    ? ` — more available (next offset: ${page.next_offset}).`
    : ".";

  const lines: string[] = [
    `# ${opts.title}`,
    "",
    `Showing ${page.count} of ${page.total} ${noun}${more}`,
    "",
  ];
  for (const m of page.memories) lines.push(formatMemoryLine(m));
  return lines.join("\n");
}
