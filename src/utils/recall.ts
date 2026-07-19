import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { stripPrivate, nativeMemoryDir } from "../hooks/shared.js";

// A keyword search over the flat .wolf knowledge files — the query interface OpenWolf
// lacked. No database: it scans STATUS.md / cerebrum.md / memory.md / buglog.json, scores
// each line (or bug entry) by term matches, and returns a compact ranked index so the model
// can then Read the specific file:line for detail (progressive disclosure, zero infra).
//
// Each hit also carries a stable, content-addressed `id` (e.g. `c-3f9a2b`) — the citation
// handle. It's derived from the file category + the normalized text of the hit's *logical
// block* (a list item, a table row, a bug, a prose paragraph), so it survives reordering and
// unrelated edits elsewhere in the file, and changes only when that entry's own text changes.
// `resolveId()` turns an id back into its full block — the second, targeted disclosure layer.

export interface RecallHit {
  file: string;
  line: number;      // line of the matched unit (1-based)
  text: string;      // the matched line/unit, trimmed
  score: number;
  id: string;        // stable citation id for the enclosing block
  blockLine: number; // first line of the enclosing block
}

export interface ResolvedEntry {
  id: string;
  file: string;
  line: number; // first line of the block
  text: string; // full block text
}

const DEFAULT_SOURCES = ["STATUS.md", "cerebrum.md", "memory.md", "buglog.json"];

interface Unit { line: number; text: string; }
interface Block { start: number; end: number; text: string; }

// One-letter category prefix for a source label, so an id reads as "which store".
function prefixFor(label: string): string {
  if (label.startsWith("native/")) return "n";
  const base = label.toLowerCase();
  if (base.startsWith("status")) return "s";
  if (base.startsWith("cerebrum")) return "c";
  if (base.startsWith("memory")) return "m";
  if (base.startsWith("buglog")) return "b";
  return "x";
}

// Content-addressed id: prefix + 6 hex of sha1(category + normalized block text). Whitespace
// and case are normalized so trivial reflows keep the id stable; real content edits change it.
export function entryId(label: string, blockText: string): string {
  const norm = blockText.replace(/\s+/g, " ").trim().toLowerCase();
  const h = crypto.createHash("sha1").update(prefixFor(label) + ":" + norm).digest("hex").slice(0, 6);
  return `${prefixFor(label)}-${h}`;
}

// Split a source into logical blocks (the unit a citation points at). buglog.json → one block
// per bug. Markdown → a new block begins at a heading, list item, or table row, and at the first
// non-blank line after a blank; wrapped continuation lines fold into the current block. Private
// blocks are blanked (newlines kept) so their content never leaks into an expanded citation.
export function blocksFor(src: string, content: string): Block[] {
  if (src.endsWith(".json")) {
    return unitsFor(src, content).map((u) => ({ start: u.line, end: u.line, text: u.text }));
  }
  const deprivated = content.replace(/<private>[\s\S]*?<\/private>/gi, (m) => m.replace(/[^\n]/g, ""));
  const lines = deprivated.split(/\r?\n/);
  const isBoundary = (l: string) => /^(#{1,6}\s|[-*]\s|\d+\.\s|\|)/.test(l);
  const blocks: Block[] = [];
  let cur: { start: number; lines: string[] } | null = null;
  const flush = () => { if (cur) { blocks.push({ start: cur.start, end: cur.start + cur.lines.length - 1, text: cur.lines.join("\n").trim() }); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) { flush(); continue; }
    if (cur === null || isBoundary(raw)) { flush(); cur = { start: i + 1, lines: [raw] }; }
    else cur.lines.push(raw);
  }
  flush();
  return blocks.filter((b) => b.text.length > 0);
}

function blockContaining(blocks: Block[], line: number): Block | null {
  for (const b of blocks) if (line >= b.start && line <= b.end) return b;
  return null;
}

// Turn a source file into searchable units: markdown → one unit per non-blank line;
// buglog.json → one unit per bug (id + message + root cause + fix + tags flattened).
function unitsFor(src: string, content: string): Unit[] {
  if (src.endsWith(".json")) {
    let raw: unknown;
    try { raw = JSON.parse(content); } catch { return []; }
    // JSON.parse yields null for "null", a number for "5", etc. The `.bugs` access below would then
    // throw a TypeError OUTSIDE the try — guard for a real object first (bug: recall crashed on null buglog).
    if (!raw || typeof raw !== "object") return [];
    const bugs = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { bugs?: unknown[] }).bugs) ? (raw as { bugs: Array<Record<string, unknown>> }).bugs : [];
    return (bugs as Array<Record<string, unknown>>).map((b, i) => ({
      line: i + 1,
      text: stripPrivate([b.id, b.error_message, b.root_cause, b.fix, Array.isArray(b.tags) ? (b.tags as unknown[]).join(" ") : b.tags]
        .filter(Boolean).join(" — ")),
    }));
  }
  // Blank out private blocks but KEEP the newlines, so reported line numbers stay accurate.
  const deprivated = content.replace(/<private>[\s\S]*?<\/private>/gi, (m) => m.replace(/[^\n]/g, ""));
  return deprivated.split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter((u) => u.text.trim().length > 0);
}

interface SourceFile { label: string; abspath: string; }
interface RecallOpts { limit?: number; sources?: string[]; includeNative?: boolean; nativeDir?: string | null; }

// The set of files a recall/resolve spans: OpenWolf's own knowledge files plus (unless disabled)
// every topic file in Claude's native Auto Memory, labelled `native/<file>`.
function sourceFiles(wolfDir: string, opts: RecallOpts): SourceFile[] {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const files: SourceFile[] = sources.map((src) => ({ label: src, abspath: path.join(wolfDir, src) }));
  if (opts.includeNative !== false) {
    const nd = opts.nativeDir !== undefined ? opts.nativeDir : nativeMemoryDir(path.dirname(wolfDir));
    if (nd) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(nd); } catch { /* unreadable */ }
      for (const name of entries) {
        if (name.endsWith(".md") && !name.includes(".bak")) {
          files.push({ label: `native/${name}`, abspath: path.join(nd, name) });
        }
      }
    }
  }
  return files;
}

// BM25 constants (Okapi defaults). k1 tempers term-frequency saturation; b the length penalty.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface Doc { src: string; line: number; text: string; lower: string; tokens: string[]; len: number; blockStart: number; blockText: string; }

export function recall(wolfDir: string, query: string, opts: RecallOpts = {}): RecallHit[] {
  const limit = opts.limit ?? 12;
  // Split on any non-letter/digit run (Unicode-aware, so umlauts stay inside a word) → whole-word tokens.
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  if (terms.length === 0) return [];

  // Pass 1: collect every searchable unit as a "document", tokenized into whole words. Matching is
  // word-PREFIX (anchored at word start): "restar" still hits "restart" and "port" still hits "ports",
  // but a query no longer spuriously matches mid-word ("port" no longer hits "report"). We only enrich
  // the *ranking* with BM25.
  const docs: Doc[] = [];
  for (const { label: src, abspath } of sourceFiles(wolfDir, opts)) {
    let content: string;
    try { content = fs.readFileSync(abspath, "utf-8"); } catch { continue; }
    const blocks = blocksFor(src, content);
    for (const { line, text } of unitsFor(src, content)) {
      const block = blockContaining(blocks, line);
      const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      docs.push({
        src, line, text: text.trim(), lower: text.toLowerCase(), tokens,
        len: tokens.length || 1,
        blockStart: block ? block.start : line, blockText: block ? block.text : text,
      });
    }
  }
  if (docs.length === 0) return [];

  // Document frequency per query term (how many units contain it) → IDF for rare-term weighting.
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, docs.reduce((c, d) => c + (d.tokens.some((t) => t.startsWith(term)) ? 1 : 0), 0));
  const idf = new Map<string, number>();
  for (const term of terms) idf.set(term, Math.log(1 + (N - df.get(term)! + 0.5) / (df.get(term)! + 0.5)));

  // Pass 2: BM25 score. A rare term in a short unit outranks a common term in a long one.
  const hits: RecallHit[] = [];
  for (const d of docs) {
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const tf = d.tokens.reduce((c, t) => c + (t.startsWith(term) ? 1 : 0), 0);
      if (tf === 0) continue;
      matched++;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (d.len / avgdl));
      score += idf.get(term)! * (tf * (BM25_K1 + 1)) / denom;
    }
    if (matched === 0) continue;
    hits.push({ file: d.src, line: d.line, text: d.text, score: Math.round(score * 1000) / 1000, id: entryId(d.src, d.blockText), blockLine: d.blockStart });
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return hits.slice(0, limit);
}

export interface ProjectHit extends RecallHit { project?: string; wolfDir: string }

// Search several projects and return the global top-N by score. Each hit is tagged with its
// project name + wolfDir (so a follow-up resolveId knows where to look). Per-project limit = the
// final limit, which is enough for a correct global top-N.
export function recallAcross(targets: Array<{ name?: string; wolfDir: string }>, query: string, opts: RecallOpts = {}): ProjectHit[] {
  const limit = opts.limit ?? 12;
  const tagged: ProjectHit[] = targets.flatMap((t) =>
    recall(t.wolfDir, query, opts).map((h) => ({ ...h, project: t.name, wolfDir: t.wolfDir }))
  );
  tagged.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return tagged.slice(0, limit);
}

// Resolve a citation id back to its full block — the targeted second disclosure layer. Scans the
// same sources, recomputes each block's id, and returns the first match (null if none). Accepts
// the id with or without its category prefix so `recall --id 3f9a2b` also works.
export function resolveId(wolfDir: string, id: string, opts: RecallOpts = {}): ResolvedEntry | null {
  const want = id.trim().toLowerCase();
  const wantBare = want.includes("-") ? want.slice(want.indexOf("-") + 1) : want;
  for (const { label: src, abspath } of sourceFiles(wolfDir, opts)) {
    let content: string;
    try { content = fs.readFileSync(abspath, "utf-8"); } catch { continue; }
    for (const b of blocksFor(src, content)) {
      const eid = entryId(src, b.text);
      if (eid === want || eid.slice(eid.indexOf("-") + 1) === wantBare) {
        return { id: eid, file: src, line: b.start, text: b.text };
      }
    }
  }
  return null;
}
