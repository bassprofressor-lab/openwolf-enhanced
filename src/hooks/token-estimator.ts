import * as fs from "node:fs";
import * as path from "node:path";

// Lives under src/hooks/ because the hooks are compiled with their own tsconfig
// (rootDir: src/hooks) and must not import from outside it — which is precisely why three
// divergent copies of this table existed in the first place. src/tracker/token-estimator.ts
// re-exports from here so non-hook code shares the same numbers.

// Single source of truth for extension → content type. Three separate copies of this
// table used to live in post-read.ts, post-write.ts and anatomy-scanner.ts, and they
// disagreed: .rs/.go/.java/.c/.cpp counted as "code" on read but "mixed" on write, and
// a .md write was charged the code ratio outright. Same file, different token estimate
// depending on which hook happened to run. Everything now routes through here.
const CODE_EXTS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".css", ".scss", ".sql", ".sh", ".yaml",
  ".yml", ".json", ".toml", ".xml", ".dart",
]);

const PROSE_EXTS = new Set([".md", ".txt", ".rst", ".adoc"]);

export type ContentType = "code" | "prose" | "mixed";

export interface TokenRatios {
  code: number;
  prose: number;
  mixed: number;
}

export const DEFAULT_RATIOS: TokenRatios = { code: 3.5, prose: 4.0, mixed: 3.75 };

export function detectContentType(filePath: string): ContentType {
  const ext = path.extname(filePath).toLowerCase();
  if (CODE_EXTS.has(ext)) return "code";
  if (PROSE_EXTS.has(ext)) return "prose";
  return "mixed";
}

interface TokenAuditConfig {
  openwolf?: { token_audit?: { chars_per_token_code?: number; chars_per_token_prose?: number } };
}

const ratioCache = new Map<string, TokenRatios>();

/**
 * Ratios from config.json (openwolf.token_audit). These keys were shipped in the init
 * template and documented as tunable, but nothing ever read them — every estimator
 * hardcoded 3.5/4.0/3.75. There is no separate "mixed" key by design: it is the midpoint
 * of the two configured ends, which is exactly what the old hardcoded 3.75 was.
 */
export function getTokenRatios(wolfDir: string): TokenRatios {
  const cached = ratioCache.get(wolfDir);
  if (cached) return cached;

  let cfg: TokenAuditConfig = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(wolfDir, "config.json"), "utf-8")) as TokenAuditConfig;
  } catch { /* missing or malformed config — defaults below */ }
  const audit = cfg.openwolf?.token_audit ?? {};
  const sane = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

  const code = sane(audit.chars_per_token_code, DEFAULT_RATIOS.code);
  const prose = sane(audit.chars_per_token_prose, DEFAULT_RATIOS.prose);
  const ratios: TokenRatios = { code, prose, mixed: (code + prose) / 2 };

  ratioCache.set(wolfDir, ratios);
  return ratios;
}

export function estimateTokens(
  text: string,
  type: ContentType = "mixed",
  ratios: TokenRatios = DEFAULT_RATIOS
): number {
  const ratio = type === "code" ? ratios.code : type === "prose" ? ratios.prose : ratios.mixed;
  return Math.ceil(text.length / ratio);
}

/** Estimate from a path, so callers cannot pick the wrong content type by hand. */
export function estimateFileTokens(
  text: string,
  filePath: string,
  ratios: TokenRatios = DEFAULT_RATIOS
): number {
  return estimateTokens(text, detectContentType(filePath), ratios);
}
