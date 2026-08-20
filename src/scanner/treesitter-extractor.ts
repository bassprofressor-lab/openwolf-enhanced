// ─────────────────────────────────────────────────────────────────────────────
// tree-sitter symbol extraction (idea from cytostack/openwolf 2.1.0).
//
// Why OPTIONAL: `tree-sitter-wasms` unpacks to ~52 MB, more than everything else in this package
// combined. For a tool whose whole point is frugality, making that a hard dependency is the wrong
// trade. So it lives in `optionalDependencies` and this module falls back cleanly to the existing
// regex extractor when it is absent.
//
// Why bother at all: the regex version only knows line-anchored top-level declarations and guesses
// a symbol's end as "the line before the next one". tree-sitter gives the REAL end from the syntax
// tree and finds methods inside classes — both decide whether an offset/limit read hint lands on
// the right slice. Measured on this repo: 472 of 487 shared symbols (97 %) had an end line that
// was too far.
//
// Used only from `openwolf scan` (async). The hooks stay synchronous on the regex path; their
// symbols get replaced on the next scan.
// ─────────────────────────────────────────────────────────────────────────────

import type { SymbolEntry } from "./symbol-extractor.js";

const GRAMMARS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
};

// Wrappers that hold declarations but are not symbols themselves. [2026-08-20, review] The first
// cut listed only export_statement/declaration_list/class_body, so `export const f = () => {}`
// (lexical_declaration -> variable_declarator -> arrow_function) and Python's decorated_definition
// were never reached — 9 real symbols vanished on this repo after a scan.
const WRAPPERS = new Set([
  "export_statement", "declaration_list", "class_body", "statement_block",
  "lexical_declaration", "variable_declaration", "variable_declarator",
  "decorated_definition", "expression_statement",
]);

// Node types that count as a symbol, mapped onto our three categories.
const KIND_MAP: Record<string, SymbolEntry["kind"]> = {
  function_declaration: "fn", function_definition: "fn", method_definition: "fn",
  method_declaration: "fn", arrow_function: "fn", generator_function_declaration: "fn",
  function_item: "fn", func_literal: "fn",
  class_declaration: "class", class_definition: "class", class_specifier: "class",
  struct_item: "class", impl_item: "class", type_declaration: "class",
  interface_declaration: "section", type_alias_declaration: "section",
  enum_declaration: "section", enum_item: "section", trait_item: "section",
  module: "section", mod_item: "section",
};

let loaded: { Parser: any; Language: any; langs: Map<string, any> } | null = null;
let unavailable: string | null = null;

/** true when tree-sitter could handle this extension (grammar known). */
export function treeSitterSupports(ext: string): boolean {
  return ext.toLowerCase() in GRAMMARS;
}

/** Why tree-sitter is not being used — so the scan report can say so instead of staying silent. */
export function treeSitterUnavailableReason(): string | null {
  return unavailable;
}

async function load(): Promise<{ Parser: any; Language: any; langs: Map<string, any> } | null> {
  if (loaded) return loaded;
  if (unavailable) return null;
  try {
    const mod: any = await import("web-tree-sitter");
    const Parser = mod.Parser ?? mod.default?.Parser ?? mod.default;
    // [2026-08-20] Two versions, two shapes — and the order matters:
    //   0.24.x: `Parser.Language`, but only available AFTER `Parser.init()`
    //   0.26.x: `Language` as its own export
    // So init() runs first and Language is resolved afterwards. The other way round, the tool
    // wrongly reported "unexpected version".
    //
    // ⚠ Do NOT bump blindly: 0.26 is ABI-incompatible with the grammars in tree-sitter-wasms
    // 0.1.13 — Language.load() fails there with an EMPTY error message. Upstream pins ^0.24.7
    // for the same reason.
    await Parser.init();
    const Language = mod.Language ?? mod.default?.Language ?? Parser?.Language;
    if (!Language?.load) { unavailable = "web-tree-sitter without Language.load — unexpected version"; return null; }
    loaded = { Parser, Language, langs: new Map() };
    return loaded;
  } catch (e) {
    unavailable = `web-tree-sitter failed to load (${(e as Error).message.split("\n")[0]})`;
    return null;
  }
}

async function language(ctx: { Parser: any; Language: any; langs: Map<string, any> }, name: string): Promise<any | null> {
  if (ctx.langs.has(name)) return ctx.langs.get(name);
  try {
    // The path comes from package resolution, not from a guessed node_modules path — otherwise it
    // breaks under pnpm, where packages are not laid out flat.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
    const lang = await ctx.Language.load(wasmPath);
    ctx.langs.set(name, lang);
    return lang;
  } catch (e) {
    // Record the reason instead of swallowing it — otherwise the scan report later says just "null".
    unavailable = unavailable ?? `grammar ${name} failed to load (${(e as Error)?.message || "no message"})`;
    ctx.langs.set(name, null);
    return null;
  }
}

function nameOf(node: any): string | null {
  const direct = node.childForFieldName?.("name");
  if (direct?.text) return direct.text;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && (c.type === "identifier" || c.type === "type_identifier" || c.type === "property_identifier")) {
      return c.text;
    }
  }
  return null;
}

/**
 * Symbols from the syntax tree. Returns `null` when tree-sitter is unavailable — the caller then
 * takes the regex path. `null` means "not measured", an empty list means "measured, found nothing".
 * Conflating the two would be exactly the silent omission this codebase keeps trying to avoid.
 */
export async function extractSymbolsTS(
  content: string, ext: string, maxCount: number, ratio = 3.5
): Promise<SymbolEntry[] | null> {
  const grammar = GRAMMARS[ext.toLowerCase()];
  if (!grammar) return null;
  const ctx = await load();
  if (!ctx) return null;
  const lang = await language(ctx, grammar);
  if (!lang) return null;

  let tree: any;
  try {
    const parser = new ctx.Parser();
    parser.setLanguage(lang);
    tree = parser.parse(content);
  } catch {
    return null;
  }
  if (!tree?.rootNode) return null;

  const out: SymbolEntry[] = [];
  const seen = new Set<string>();
  const visit = (node: any, depth: number): void => {
    if (out.length >= maxCount || depth > 3) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (!c) continue;
      const kind = KIND_MAP[c.type];
      if (kind) {
        const name = nameOf(c);
        const start = c.startPosition.row + 1;
        const key = `${name}:${start}`;
        if (name && !seen.has(key)) {
          seen.add(key);
          out.push({
            name, kind, startLine: start, endLine: c.endPosition.row + 1,
            tokens: Math.ceil((c.endIndex - c.startIndex) / ratio),
          });
        }
        // Descend into class/impl bodies to catch methods — precisely what the regex version cannot do.
        if (kind === "class") visit(c, depth + 1);
      } else if (WRAPPERS.has(c.type)) {
        visit(c, depth); // skip wrappers without spending depth
      }
      if (out.length >= maxCount) return;
    }
  };
  visit(tree.rootNode, 0);
  out.sort((a, b) => a.startLine - b.startLine);
  return out;
}

/**
 * Follow-up pass after the (synchronous) scan: replace the regex-guessed symbol ranges with the
 * real ones from the syntax tree.
 *
 * Deliberately a separate, ASYNCHRONOUS pass. Scanner and hooks stay synchronous — tree-sitter is
 * WASM and needs `await`, and turning the hook path async would be a far bigger change for a gain
 * only the full scan needs.
 *
 * Returns how many files were refined — 0 plus a reason when tree-sitter is missing.
 */
export async function refineSymbols(
  symbols: Record<string, SymbolEntry[]>,
  readFile: (relPath: string) => string | null,
  maxCount: number
): Promise<{ refined: number; skipped: number; reason: string | null }> {
  let refined = 0;
  let skipped = 0;
  for (const relPath of Object.keys(symbols)) {
    const ext = relPath.includes(".") ? relPath.slice(relPath.lastIndexOf(".")) : "";
    if (!treeSitterSupports(ext)) { skipped++; continue; }
    const content = readFile(relPath);
    if (content === null) { skipped++; continue; }
    const better = await extractSymbolsTS(content, ext, maxCount);
    // [2026-08-20, review] MERGE, do not replace. tree-sitter is more accurate where it looks,
    // but it does not look everywhere — replacing wholesale deleted symbols the regex extractor
    // had found, and an unfindable symbol defeats the entire point of `openwolf find`.
    // tree-sitter wins on names it knows (its ranges are the real ones); regex-only names survive.
    if (better && better.length > 0) {
      const known = new Set(better.map((s) => s.name));
      const kept = (symbols[relPath] ?? []).filter((s) => !known.has(s.name));
      symbols[relPath] = [...better, ...kept].sort((a, b) => a.startLine - b.startLine);
      refined++;
    } else skipped++;
  }
  return { refined, skipped, reason: refined === 0 ? treeSitterUnavailableReason() : null };
}
