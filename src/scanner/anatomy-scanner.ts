import * as fs from "node:fs";
import * as path from "node:path";
import { extractDescription, capDescription } from "./description-extractor.js";
import { readJSON } from "../utils/fs-safe.js";
import { writeText } from "../utils/fs-safe.js";
import { normalizePath } from "../utils/paths.js";
import { loadIgnore } from "../utils/maintenance.js";
import { extractSymbols, symbolsSupported, SYMBOL_MIN_TOKENS, type SymbolEntry } from "./symbol-extractor.js";
import { estimateFileTokens, getTokenRatios, type TokenRatios } from "../tracker/token-estimator.js";

interface AnatomyEntry {
  file: string;
  description: string;
  tokens: number;
}

interface WolfConfig {
  version: number;
  openwolf: {
    anatomy: {
      max_description_length: number;
      max_files: number;
      exclude_patterns: string[];
    };
    token_audit: {
      chars_per_token_code: number;
      chars_per_token_prose: number;
    };
  };
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".webm", ".ogg",
  ".sqlite", ".db",
  ".wasm",
  ".lock",
]);

function estimateTokens(text: string, filePath: string, ratios: TokenRatios): number {
  return estimateFileTokens(text, filePath, ratios);
}

// Files that should never appear in anatomy (secrets, env files)
const ALWAYS_EXCLUDE_FILES = new Set([".env", ".env.local", ".env.production", ".env.staging", ".env.development"]);
// Private keys, certs, keystores, credential files — must never be indexed (upstream #54).
const SECRET_EXTS = new Set([".pem", ".key", ".p8", ".p12", ".pfx", ".keystore", ".jks", ".crt", ".cer", ".der", ".asc", ".gpg", ".pgp", ".ppk", ".kdbx"]);
const SECRET_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", ".netrc", ".pgpass", ".htpasswd", ".npmrc", ".pypirc"]);
function isSecretFile(basename: string): boolean {
  const b = basename.toLowerCase();
  if (b === ".env" || b.startsWith(".env.")) return true;
  if (SECRET_NAMES.has(b)) return true;
  const dot = b.lastIndexOf(".");
  const ext = dot > 0 ? b.slice(dot) : "";
  return SECRET_EXTS.has(ext);
}

function shouldExclude(
  relPath: string,
  excludePatterns: string[]
): boolean {
  const parts = relPath.split("/");
  const basename = parts[parts.length - 1];

  // Always exclude sensitive files regardless of config
  if (ALWAYS_EXCLUDE_FILES.has(basename)) return true;
  // Also exclude .env.* variants and any secret-bearing file (keys/certs/keystores).
  if (isSecretFile(basename)) return true;

  for (const pattern of excludePatterns) {
    // Simple glob: check if any path segment matches
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (relPath.endsWith(ext)) return true;
    } else {
      if (parts.includes(pattern)) return true;
    }
  }
  return false;
}

function walkDir(
  dir: string,
  rootDir: string,
  excludePatterns: string[],
  maxFiles: number,
  entries: Map<string, AnatomyEntry[]>,
  ignore: (relPath: string) => boolean,
  symbols: Record<string, SymbolEntry[]>,
  ratios: TokenRatios
): void {
  let totalFiles = 0;
  for (const [, list] of entries) totalFiles += list.length;
  if (totalFiles >= maxFiles) return;

  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relPath = normalizePath(path.relative(rootDir, fullPath));

    if (shouldExclude(relPath, excludePatterns)) continue;
    if (ignore(relPath)) continue; // .wolfignore

    if (item.isDirectory()) {
      walkDir(fullPath, rootDir, excludePatterns, maxFiles, entries, ignore, symbols, ratios);
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      // Skip files > 1MB
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 1024 * 1024) continue;
      } catch {
        continue;
      }

      // Read file for token estimation
      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      const desc = capDescription(extractDescription(fullPath));
      const tokens = estimateTokens(content, fullPath, ratios);
      const section = normalizePath(path.relative(rootDir, dir)) || ".";
      const sectionKey = section === "." ? "./" : section + "/";

      if (!entries.has(sectionKey)) {
        entries.set(sectionKey, []);
      }

      entries.get(sectionKey)!.push({
        file: item.name,
        description: desc,
        tokens,
      });

      // Symbol-level hints for big files: record top-level declarations with line ranges so a
      // pre-read hint can send the agent to one function via offset/limit. Keyed the same way
      // pre-read resolves a file (section + name) so lookups match.
      if (tokens >= SYMBOL_MIN_TOKENS && symbolsSupported(ext)) {
        const syms = extractSymbols(content, ext);
        if (syms.length > 0) {
          symbols[normalizePath(path.join(sectionKey, item.name))] = syms;
        }
      }

      totalFiles++;
      if (totalFiles >= maxFiles) return;
    }
  }
}

export function serializeAnatomy(
  sections: Map<string, AnatomyEntry[]>,
  metadata: { lastScanned: string; fileCount: number; hits: number; misses: number }
): string {
  const lines: string[] = [
    "# anatomy.md",
    "",
    `> Auto-maintained by OpenWolf. Last scanned: ${metadata.lastScanned}`,
    `> Files: ${metadata.fileCount} tracked | Anatomy hits: ${metadata.hits} | Misses: ${metadata.misses}`,
    "",
  ];

  const sortedKeys = [...sections.keys()].sort();

  for (const key of sortedKeys) {
    lines.push(`## ${key}`);
    lines.push("");
    const entries = sections.get(key)!;
    entries.sort((a, b) => a.file.localeCompare(b.file));
    for (const entry of entries) {
      const desc = entry.description ? ` — ${entry.description}` : "";
      lines.push(`- \`${entry.file}\`${desc} (~${entry.tokens} tok)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function parseAnatomy(content: string): Map<string, AnatomyEntry[]> {
  const sections = new Map<string, AnatomyEntry[]>();
  let currentSection = "";

  // Split on \r?\n so CRLF files don't leave a trailing \r that breaks the entry regex (upstream #50).
  for (const line of content.split(/\r?\n/)) {
    const sectionMatch = line.match(/^## (.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, []);
      }
      continue;
    }

    if (!currentSection) continue;

    const entryMatch = line.match(/^- `([^`]+)`(?:\s+—\s+(.+?))?\s*\(~(\d+)\s+tok\)$/);
    if (entryMatch) {
      sections.get(currentSection)!.push({
        file: entryMatch[1],
        description: entryMatch[2] || "",
        tokens: parseInt(entryMatch[3], 10),
      });
    }
  }

  return sections;
}

/**
 * Scan the project and return the anatomy content and file count WITHOUT writing to disk.
 */
export function buildAnatomy(wolfDir: string, projectRoot: string): { content: string; fileCount: number; symbols: Record<string, SymbolEntry[]> } {
  const configPath = path.join(wolfDir, "config.json");
  const config = readJSON<WolfConfig>(configPath, {
    version: 1,
    openwolf: {
      anatomy: {
        max_description_length: 100,
        max_files: 500,
        exclude_patterns: ["node_modules", ".git", "dist", "build", ".wolf"],
      },
      token_audit: { chars_per_token_code: 3.5, chars_per_token_prose: 4.0 },
    },
  });

  const entries = new Map<string, AnatomyEntry[]>();
  const symbols: Record<string, SymbolEntry[]> = {};
  const ignore = loadIgnore(projectRoot);
  walkDir(
    projectRoot,
    projectRoot,
    config.openwolf.anatomy.exclude_patterns,
    config.openwolf.anatomy.max_files,
    entries,
    ignore,
    symbols,
    getTokenRatios(wolfDir)
  );

  let fileCount = 0;
  for (const [, list] of entries) fileCount += list.length;

  const serialized = serializeAnatomy(entries, {
    lastScanned: new Date().toISOString(),
    fileCount,
    hits: 0,
    misses: 0,
  });

  return { content: serialized, fileCount, symbols };
}

export function scanProject(wolfDir: string, projectRoot: string): number {
  const { content, fileCount, symbols } = buildAnatomy(wolfDir, projectRoot);
  const anatomyPath = path.join(wolfDir, "anatomy.md");
  writeText(anatomyPath, content);
  // Sidecar: symbol-level line ranges for big files (see symbol-extractor). Written next to
  // anatomy.md; pre-read reads it to point the agent at a slice instead of the whole file.
  writeText(path.join(wolfDir, "anatomy-symbols.json"), JSON.stringify({ version: 1, files: symbols }, null, 2));
  return fileCount;
}

export function updateAnatomyEntry(
  wolfDir: string,
  filePath: string,
  projectRoot: string,
  action: "upsert" | "delete"
): void {
  const anatomyPath = path.join(wolfDir, "anatomy.md");
  let content: string;
  try {
    content = fs.readFileSync(anatomyPath, "utf-8");
  } catch {
    content = "# anatomy.md\n\n> Auto-maintained by OpenWolf.\n";
  }

  const sections = parseAnatomy(content);
  const relPath = normalizePath(path.relative(projectRoot, filePath));
  const dir = path.dirname(relPath);
  const fileName = path.basename(relPath);
  const sectionKey = dir === "." ? "./" : dir + "/";

  if (action === "delete") {
    const entries = sections.get(sectionKey);
    if (entries) {
      const idx = entries.findIndex((e) => e.file === fileName);
      if (idx !== -1) entries.splice(idx, 1);
      if (entries.length === 0) sections.delete(sectionKey);
    }
  } else {
    // upsert
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    const desc = capDescription(extractDescription(filePath));
    const tokens = estimateTokens(fileContent, filePath, getTokenRatios(wolfDir));
    const entry: AnatomyEntry = { file: fileName, description: desc, tokens };

    if (!sections.has(sectionKey)) {
      sections.set(sectionKey, []);
    }
    const entries = sections.get(sectionKey)!;
    const idx = entries.findIndex((e) => e.file === fileName);
    if (idx !== -1) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
  }

  let fileCount = 0;
  for (const [, list] of sections) fileCount += list.length;

  const serialized = serializeAnatomy(sections, {
    lastScanned: new Date().toISOString(),
    fileCount,
    hits: 0,
    misses: 0,
  });

  writeText(anatomyPath, serialized);
}
