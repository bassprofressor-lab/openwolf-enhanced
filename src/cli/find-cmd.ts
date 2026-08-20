import * as path from "node:path";
import * as fs from "node:fs";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON } from "../utils/fs-safe.js";
import { parseAnatomy } from "../scanner/anatomy-scanner.js";

// `openwolf find <query>` — where does this live? (Idea from cytostack/openwolf 2.1.0.)
//
// Answers the question that otherwise costs a grep across half the repo: which file, which line.
// Fed EXCLUSIVELY from what the scanner already writes (anatomy.md, anatomy-symbols.json,
// anatomy-graph.json) — so there is no second index that can go stale without anyone noticing.

export interface FindFile { path: string; description: string; tokens: number; importance: number; }
export interface FindSymbol { name: string; kind: string; startLine: number; endLine: number; tokens: number; }
export interface FindIndex { files: FindFile[]; symbols: Record<string, FindSymbol[]>; }

export interface FindHit {
  path: string;
  symbol?: string;
  kind?: string;
  startLine?: number;
  endLine?: number;
  score: number;
  why: string;
  tokens: number;
  importance: number;
}

// Weights live here as constants rather than scattered through the code, so the ranking stays
// inspectable and a test can pin it down.
const W = {
  symbolExact: 100,
  fileExact: 90,
  symbolPrefix: 70,
  symbolSubstring: 50,
  filePrefix: 45,
  fileSubstring: 35,
  pathSubstring: 25,
  descSubstring: 15,
  /** Importance breaks ties only — it never outranks the kind of match. */
  importance: 8,
};

/**
 * Score the hits. Pure, so the ranking can be tested without touching a filesystem.
 *
 * Rule: the KIND of match always beats importance. An unimportant file with an exact symbol name
 * belongs above a central file that merely mentions the word in its description — otherwise
 * importance hides the very thing that was searched for.
 */
export function rankFind(query: string, index: FindIndex, limit = 15): FindHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const hits: FindHit[] = [];

  for (const [filePath, syms] of Object.entries(index.symbols)) {
    const meta = byPath.get(filePath);
    for (const s of syms) {
      const n = s.name.toLowerCase();
      let base = 0;
      let why = "";
      if (n === q) { base = W.symbolExact; why = `${s.kind} ${s.name}`; }
      else if (n.startsWith(q)) { base = W.symbolPrefix; why = `${s.kind} ${s.name}`; }
      else if (n.includes(q)) { base = W.symbolSubstring; why = `${s.kind} ${s.name}`; }
      if (base === 0) continue;
      const importance = meta?.importance ?? 0;
      hits.push({
        path: filePath, symbol: s.name, kind: s.kind,
        startLine: s.startLine, endLine: s.endLine,
        score: base + importance * W.importance, why,
        tokens: s.tokens, importance,
      });
    }
  }

  for (const f of index.files) {
    const base = path.posix.basename(f.path).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, "");
    let score = 0;
    let why = "";
    if (stem === q || base === q) { score = W.fileExact; why = "Dateiname"; }
    else if (stem.startsWith(q)) { score = W.filePrefix; why = "Dateiname beginnt so"; }
    else if (base.includes(q)) { score = W.fileSubstring; why = "Dateiname enthaelt"; }
    else if (f.path.toLowerCase().includes(q)) { score = W.pathSubstring; why = "Pfad enthaelt"; }
    else if (f.description.toLowerCase().includes(q)) { score = W.descSubstring; why = "Beschreibung"; }
    if (score === 0) continue;
    hits.push({
      path: f.path, score: score + f.importance * W.importance, why,
      tokens: f.tokens, importance: f.importance,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) ||
    (a.startLine ?? 0) - (b.startLine ?? 0));
  return hits.slice(0, limit);
}

/** Load the index from the files the scanner already writes. */
export function loadFindIndex(wolfDir: string): FindIndex {
  const symbols = readJSON<{ files?: Record<string, FindSymbol[]> }>(
    path.join(wolfDir, "anatomy-symbols.json"), {}).files ?? {};
  const graph = readJSON<{ importance?: Record<string, number> }>(
    path.join(wolfDir, "anatomy-graph.json"), {}).importance ?? {};

  // Reuse the EXISTING parser instead of standing a second one next to it: two parsers for the
  // same format drift apart, and the second one is always the last to notice.
  const files: FindFile[] = [];
  let md = "";
  try { md = fs.readFileSync(path.join(wolfDir, "anatomy.md"), "utf-8"); } catch { /* no index yet */ }
  for (const [sectionKey, entries] of parseAnatomy(md)) {
    const dir = sectionKey === "./" ? "" : sectionKey.replace(/\/$/, "") + "/";
    for (const e of entries) {
      const rel = dir + e.file;
      files.push({ path: rel, description: e.description ?? "", tokens: e.tokens ?? 0, importance: graph[rel] ?? 0 });
    }
  }
  return { files, symbols };
}

const bar = (v: number): string => "▁▂▃▄▅▆▇█"[Math.min(7, Math.max(0, Math.round(v * 7)))];

export function findCommand(queryParts: string[], opts: { limit?: string; json?: boolean } = {}): void {
  const query = queryParts.join(" ");
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");
  const index = loadFindIndex(wolfDir);

  if (index.files.length === 0) {
    if (opts.json) { console.log(JSON.stringify({ query, error: "no-index", hits: [] })); return; }
    console.log("\n  No anatomy index yet. Run `openwolf scan` first.\n");
    return;
  }
  // [2026-08-20, review] A non-numeric --limit produced NaN, and slice(0, NaN) returns [] — so
  // `--limit abc` reported "No match" for a symbol that is indexed. Silent wrong answers are worse
  // than a rejected flag.
  const parsed = parseInt(opts.limit ?? "15", 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  const hits = rankFind(query, index, limit);
  // Machine-readable for agents and scripts — same data, without the bars and the footnotes.
  if (opts.json) {
    console.log(JSON.stringify({ query, indexedFiles: index.files.length, hits }, null, 2));
    return;
  }
  console.log("");
  if (hits.length === 0) {
    console.log(`  No match for "${query}".`);
    console.log(`  The index holds ${index.files.length} files, ${Object.keys(index.symbols).length} of them with symbols.`);
    console.log("  Symbols are only recorded for larger files — for small ones, grep is the right tool.\n");
    return;
  }
  console.log(`  ${hits.length} hit(s) for "${query}"`);
  console.log("");
  for (const h of hits) {
    const wo = h.startLine ? `${h.path}:${h.startLine}` : h.path;
    const spanne = h.startLine && h.endLine && h.endLine > h.startLine ? `-${h.endLine}` : "";
    console.log(`  ${bar(h.importance)} ${wo}${spanne}`);
    console.log(`      ${h.why}  ·  ~${h.tokens.toLocaleString("en-US")} tok`);
  }
  console.log("");
  console.log("  ▁…█ = importance in the import graph (how often, and from how central a file).");
  console.log("");
}
