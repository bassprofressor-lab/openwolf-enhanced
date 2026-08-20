import { CANONICAL_SECTIONS, canonicalOf, headings } from "./kb-lint.js";

// ─────────────────────────────────────────────────────────────────────────────
// Filing an eroded cerebrum.md back under the four sections it is supposed to have.
//
// [2026-08-20] This is a MOVE, never a rewrite. Not a stylistic preference — this project already
// logged the opposite as a critical bug (2026-07-14): an AI cron task overwrote a file it had only
// seen an excerpt of. Handing an accumulated year of learnings to a model with "tidy this up"
// is the same failure with better manners.
//
// So: headings are re-levelled and re-ordered, and every other line is carried across untouched.
// `distill()` proves that before returning — if the multiset of body lines is not identical, it
// reports the discrepancy and the caller writes nothing.
// ─────────────────────────────────────────────────────────────────────────────

export interface Chunk {
  /** Heading text, or null for content that sits above the first heading. */
  heading: string | null;
  level: number;
  target: string;
  /** The level-2 section this chunk sat under in the original file, if any. */
  parent: string | null;
  body: string[];
  line: number;
}

export interface DistillResult {
  content: string;
  moved: number;
  /** Set when the content check failed — the caller must not write. */
  lossless: boolean;
  lostLines: string[];
  /** Section headings that existed before and would disappear. Must be empty. */
  lostHeadings: string[];
}

const DEFAULT_TARGET = "Key Learnings";

/**
 * Split into chunks at heading levels 2 and 3, and decide where each belongs.
 *
 * The classification has to look at level 3, not just level 2, because of how the drift actually
 * happened: `## Session 2026-07-12 — Slice 4+5` contains `### Key Learnings`, `### Decision Log`
 * AND `### Do-Not-Repeat` underneath it. Filing that whole block by its `##` heading would dump
 * three different kinds of knowledge into one bucket. Splitting at level 3 sends each to its own.
 */
export function chunksOf(content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const hs = headings(content).filter((h) => h.level === 2 || h.level === 3);
  const chunks: Chunk[] = [];

  const preambleEnd = hs.length > 0 ? hs[0].line - 1 : lines.length;
  const preamble = lines.slice(0, preambleEnd);
  if (preamble.some((l) => l.trim())) {
    chunks.push({ heading: null, level: 0, target: "", parent: null, body: preamble, line: 1 });
  }

  let ancestor: string | null = null;
  let ancestorRaw: string | null = null;
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    const end = i + 1 < hs.length ? hs[i + 1].line - 1 : lines.length;
    const own = canonicalOf(h.text);
    const parent = h.level === 3 ? ancestorRaw : null;
    if (h.level === 2) { ancestor = own; ancestorRaw = h.text; }
    // Own name wins; otherwise inherit from the enclosing level-2 section; otherwise default.
    const target = own ?? (h.level === 3 ? ancestor : null) ?? DEFAULT_TARGET;
    chunks.push({ heading: h.text, level: h.level, target, parent, body: lines.slice(h.line, end), line: h.line });
  }
  return chunks;
}

/** Body lines that carry content, for the equality proof. Blank lines and headings are excluded. */
function contentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l))
    .map((l) => l.trimEnd());
}

export function distill(content: string): DistillResult {
  const chunks = chunksOf(content);
  const out: string[] = [];
  let moved = 0;

  const preamble = chunks.find((c) => c.heading === null);
  if (preamble) {
    out.push(...preamble.body);
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push("");
  }

  for (const section of CANONICAL_SECTIONS) {
    const mine = chunks.filter((c) => c.heading !== null && c.target === section);
    if (mine.length === 0) continue;
    out.push(`## ${section}`, "");

    for (const c of mine) {
      const isTheSectionItself = c.level === 2 && c.heading === section;
      if (!isTheSectionItself) {
        // Everything else keeps its own heading, demoted to level 3 so the section stays whole.
        // The original wording is preserved verbatim — it is often the only date an entry carries.
        out.push(`### ${c.heading}`, "");
        // "Moved" means the entry is now filed somewhere it was not before: a level-2 heading that
        // got demoted, or a sub-heading whose enclosing section was not the one it belongs to.
        if (c.level === 2 || c.parent !== section) moved++;
      }
      const body = [...c.body];
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (body.length) out.push(...body, "");
    }
  }

  let result = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  // ── the proof ──────────────────────────────────────────────────────────────
  const before = contentLines(content).sort();
  const after = contentLines(result).sort();
  const lostLines: string[] = [];
  const afterCount = new Map<string, number>();
  for (const l of after) afterCount.set(l, (afterCount.get(l) ?? 0) + 1);
  for (const l of before) {
    const n = afterCount.get(l) ?? 0;
    if (n === 0) lostLines.push(l);
    else afterCount.set(l, n - 1);
  }

  const headBefore = headings(content).filter((h) => h.level >= 2).map((h) => h.text);
  const headAfter = new Set(headings(result).map((h) => h.text));
  const lostHeadings = headBefore.filter((t) => !headAfter.has(t) && canonicalOf(t) === null);

  return {
    content: result,
    moved,
    lossless: lostLines.length === 0 && lostHeadings.length === 0,
    lostLines: lostLines.slice(0, 10),
    lostHeadings,
  };
}
