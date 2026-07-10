import * as fs from "node:fs";
import * as path from "node:path";

// A keyword search over the flat .wolf knowledge files — the query interface OpenWolf
// lacked. No database: it scans STATUS.md / cerebrum.md / memory.md / buglog.json, scores
// each line (or bug entry) by term matches, and returns a compact ranked index so the model
// can then Read the specific file:line for detail (progressive disclosure, zero infra).

export interface RecallHit {
  file: string;
  line: number;
  text: string;
  score: number;
}

const DEFAULT_SOURCES = ["STATUS.md", "cerebrum.md", "memory.md", "buglog.json"];

interface Unit { line: number; text: string; }

// Turn a source file into searchable units: markdown → one unit per non-blank line;
// buglog.json → one unit per bug (id + message + root cause + fix + tags flattened).
function unitsFor(src: string, content: string): Unit[] {
  if (src.endsWith(".json")) {
    let raw: unknown;
    try { raw = JSON.parse(content); } catch { return []; }
    const bugs = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { bugs?: unknown[] }).bugs) ? (raw as { bugs: Array<Record<string, unknown>> }).bugs : [];
    return (bugs as Array<Record<string, unknown>>).map((b, i) => ({
      line: i + 1,
      text: [b.id, b.error_message, b.root_cause, b.fix, Array.isArray(b.tags) ? (b.tags as unknown[]).join(" ") : b.tags]
        .filter(Boolean).join(" — "),
    }));
  }
  return content.split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter((u) => u.text.trim().length > 0);
}

export function recall(
  wolfDir: string,
  query: string,
  opts: { limit?: number; sources?: string[] } = {}
): RecallHit[] {
  const limit = opts.limit ?? 12;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const sources = opts.sources ?? DEFAULT_SOURCES;

  const hits: RecallHit[] = [];
  for (const src of sources) {
    let content: string;
    try { content = fs.readFileSync(path.join(wolfDir, src), "utf-8"); } catch { continue; }
    for (const { line, text } of unitsFor(src, content)) {
      const lower = text.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const occ = lower.split(term).length - 1;
        if (occ > 0) { matched++; score += occ; }
      }
      if (matched === 0) continue;
      // Reward units that contain every query term (closer to what was asked for).
      if (matched === terms.length && terms.length > 1) score += terms.length * 2;
      hits.push({ file: src, line, text: text.trim(), score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return hits.slice(0, limit);
}
