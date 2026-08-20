// ─────────────────────────────────────────────────────────────────────────────
// Import graph + PageRank importance (idea from cytostack/openwolf 2.1.0, §J2).
//
// What for: `openwolf find` has to decide which of several hits comes first. File size is no
// help — the biggest file is rarely the most important one. How often a file is imported, and
// from how important a file, is a much better signal.
//
// Deliberately PROJECT-INTERNAL relative imports only. Package imports ("react", "node:fs") say
// nothing about the structure of THIS project and would flood the graph with leaves.
//
// Self-contained (no relative imports) so tests can load the module directly.
// ─────────────────────────────────────────────────────────────────────────────

export type Graph = Record<string, string[]>;

const TS_JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const PY_EXT = new Set([".py"]);

/** Languages whose imports we read. Everything else is treated as a leaf — honest, rather than guessed. */
export function importsSupported(ext: string): boolean {
  return TS_JS_EXT.has(ext.toLowerCase()) || PY_EXT.has(ext.toLowerCase());
}

const TS_PATTERNS: RegExp[] = [
  /\bimport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
  /\bexport\s+[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
];

/**
 * Raw import specifiers from source. Only relative ones are returned.
 *
 * Python: `from .x import y` and `from ..pkg.mod import y` are relative and get normalized into a
 * path fragment with leading `./` or `../`, so `resolveImport` can treat both languages alike.
 */
export function extractImports(content: string, ext: string): string[] {
  const e = ext.toLowerCase();
  const out: string[] = [];
  if (TS_JS_EXT.has(e)) {
    for (const re of TS_PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(content); m; m = re.exec(content)) {
        if (m[1].startsWith(".")) out.push(m[1]);
      }
    }
  } else if (PY_EXT.has(e)) {
    const re = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm;
    for (let m = re.exec(content); m; m = re.exec(content)) {
      const up = m[1].length - 1; // a single dot = same package
      const rest = m[2].replace(/\./g, "/");
      const prefix = up === 0 ? "./" : "../".repeat(up);
      out.push(prefix + rest);
    }
  }
  return [...new Set(out)];
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/__init__.py"];

/**
 * Collapse `.` and `..` segments. Returns `null` when `..` walks out of the project root.
 *
 * [2026-08-20, review] This used to `parts.pop()` on an empty array and carry on, so
 * `../../shared/util` from `src/a.ts` silently became `shared/util` — an import pointing OUTSIDE
 * the project could then resolve onto an unrelated file inside it and add a phantom edge. That
 * skews PageRank invisibly, which is exactly what this module's header says must not happen.
 */
function normalize(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Resolve a relative specifier against the files that actually exist.
 *
 * Returns `null` when nothing matches — an unresolvable import must NOT create an edge. Invented
 * edges would skew importance, and do it invisibly.
 *
 * `.js` in TypeScript sources means the `.ts` file (ESM convention), so a `.js` match also checks
 * for — and prefers — the `.ts` variant.
 */
export function resolveImport(spec: string, fromRel: string, known: Set<string>): string | null {
  const baseDir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const joined = normalize(`${baseDir}/${spec}`);
  if (joined === null) return null; // escapes the project root — no edge

  if (/\.(js|jsx|mjs|cjs)$/.test(joined)) {
    const tsVariant = joined.replace(/\.(js|jsx|mjs|cjs)$/, (m) =>
      m === ".js" ? ".ts" : m === ".jsx" ? ".tsx" : m === ".mjs" ? ".mts" : ".cts");
    if (known.has(tsVariant)) return tsVariant;
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    const cand = joined + suffix;
    if (known.has(cand)) return cand;
  }
  return null;
}

/**
 * PageRank over the import graph, normalized to 0..1 (largest value = 1).
 *
 * Dangling nodes (files with no resolvable imports) spread their mass evenly — without that,
 * probability leaks on every iteration and the ranking tips over. An edge A->B means "A imports
 * B", so importance flows toward the imported file.
 */
export function pageRank(
  graph: Graph,
  nodes: string[],
  opts: { damping?: number; iterations?: number } = {}
): Record<string, number> {
  const d = opts.damping ?? 0.85;
  const iters = opts.iterations ?? 30;
  const n = nodes.length;
  if (n === 0) return {};
  if (n === 1) return { [nodes[0]]: 1 };

  const idx = new Map(nodes.map((f, i) => [f, i]));
  const out: number[][] = nodes.map(() => []);
  for (const [from, tos] of Object.entries(graph)) {
    const fi = idx.get(from);
    if (fi === undefined) continue;
    for (const to of tos) {
      const ti = idx.get(to);
      if (ti !== undefined && ti !== fi) out[fi].push(ti);
    }
  }

  let rank = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const targets = out[i];
      if (targets.length === 0) { dangling += rank[i]; continue; }
      const share = rank[i] / targets.length;
      for (const t of targets) next[t] += share;
    }
    const spread = dangling / n;
    for (let i = 0; i < n; i++) next[i] = (1 - d) / n + d * (next[i] + spread);
    rank = next;
  }

  const max = Math.max(...rank);
  const result: Record<string, number> = {};
  for (let i = 0; i < n; i++) result[nodes[i]] = max > 0 ? rank[i] / max : 0;
  return result;
}

/** Turn per-file raw imports into a resolved graph. */
export function buildGraph(rawImports: Record<string, string[]>): Graph {
  const known = new Set(Object.keys(rawImports));
  const graph: Graph = {};
  for (const [file, specs] of Object.entries(rawImports)) {
    const edges: string[] = [];
    for (const spec of specs) {
      const target = resolveImport(spec, file, known);
      if (target && target !== file) edges.push(target);
    }
    graph[file] = [...new Set(edges)];
  }
  return graph;
}

/**
 * Convert PageRank scores into rank percentiles (0..1).
 *
 * Why not the raw, max-normalized value: on an import graph it is heavily right-skewed. Measured
 * on this repo (158 files) the median was 0.058 against a maximum of 1.0 — which put 118 of 158
 * files in the lowest bar. Useless as a display and too coarse as a tiebreak. The percentile keeps
 * the ORDER exactly and spreads it evenly.
 *
 * Equal scores share a percentile (average rank) — otherwise the order of two equally important
 * files would depend on the accident of the sort.
 */
export function toPercentile(scores: Record<string, number>): Record<string, number> {
  const items = Object.entries(scores);
  const n = items.length;
  if (n === 0) return {};
  if (n === 1) return { [items[0][0]]: 1 };
  items.sort((a, b) => a[1] - b[1]);

  const out: Record<string, number> = {};
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && items[j + 1][1] === items[i][1]) j++;
    const avgRank = (i + j) / 2;
    const pct = avgRank / (n - 1);
    for (let k = i; k <= j; k++) out[items[k][0]] = pct;
    i = j + 1;
  }
  return out;
}
