import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Resolve Claude Code's native Auto Memory directory for a project, so OpenWolf can read/search
// it instead of maintaining a competing store. Claude stores it at
// ~/.claude/projects/<slug>/memory/ where the slug is the project path with "/" → "-"
// (e.g. /root/orderflow → -root-orderflow). `OPENWOLF_NATIVE_MEMORY_DIR` overrides the guess.
// Returns null if the directory doesn't exist (Auto Memory off / different layout) → callers fall back.
export function nativeMemoryDir(projectRoot?: string): string | null {
  const override = process.env.OPENWOLF_NATIVE_MEMORY_DIR;
  if (override) return fs.existsSync(override) ? override : null;
  const root = projectRoot || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const slug = root.replace(/\//g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", slug, "memory");
  return fs.existsSync(dir) ? dir : null;
}

export function getWolfDir(): string {
  // Prefer an explicit project dir so hooks work even if CWD changes during a session.
  // CLAUDE_PROJECT_DIR is set by Claude Code; OPENWOLF_PROJECT_DIR is what our own hook
  // commands set for other agents (Codex/Gemini/OpenCode) that don't export that variable.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.OPENWOLF_PROJECT_DIR || process.cwd();
  return path.join(projectDir, ".wolf");
}

/**
 * Bail out silently if .wolf/ directory doesn't exist in the current project.
 * Call this at the top of every hook to avoid crashes in non-OpenWolf projects.
 */
export function ensureWolfDir(): void {
  const wolfDir = getWolfDir();
  if (!fs.existsSync(wolfDir)) {
    process.exit(0);
  }
}

// Best-effort advisory lock around a read-modify-write cycle so concurrent hook/daemon
// processes don't clobber each other's updates to the same file (M1). It NEVER blocks a hook
// for long: it waits up to ~1s for the lock, steals a stale lock (>5s old), and if it still
// can't acquire it, runs unlocked rather than risk a hook timeout.
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}
export function withLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = targetPath + ".lock";
  const MAX_WAIT_MS = 1000;
  const STALE_MS = 5000;
  const start = Date.now();
  let held = false;
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try { fs.writeSync(fd, String(process.pid)); } catch { /* ignore */ }
      fs.closeSync(fd);
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; } // lock vanished — retry immediately
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } }
  }
}

export function readJSON<T = unknown>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch {
    // On Windows, rename can fail if another process holds a handle.
    // Fall back to direct write and clean up the tmp file.
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8"); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Retention limits, read from config.json (openwolf.retention) with safe defaults.
// Duplicated from utils/maintenance.ts because hooks build with a separate rootDir.
export interface Retention {
  token_ledger_max_sessions: number;
  session_io_max: number;
  buglog_max_entries: number;
  memory_max_bytes: number;
}
export function getRetention(wolfDir: string): Retention {
  const defaults: Retention = {
    token_ledger_max_sessions: 200,
    session_io_max: 100,
    buglog_max_entries: 200,
    memory_max_bytes: 262144,
  };
  const cfg = readJSON<{ openwolf?: { retention?: Partial<Retention> } }>(
    path.join(wolfDir, "config.json"),
    {}
  );
  return { ...defaults, ...(cfg.openwolf?.retention ?? {}) };
}

// ---------------------------------------------------------------------------
// .wolfignore — gitignore-style scoping for anatomy + hook tracking.
// Lives at the project root. Minimal matcher: dir names, path prefixes, *.ext,
// and ** globs. (Duplicated in utils/maintenance.ts — separate build roots.)
// ---------------------------------------------------------------------------
export function makeIgnoreMatcher(patterns: string[]): (relPath: string) => boolean {
  const pats = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("!"));
  if (pats.length === 0) return () => false;

  return (relPath: string): boolean => {
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = norm.split("/");
    const base = parts[parts.length - 1];
    for (const raw of pats) {
      const pat = raw.replace(/\/+$/, "");
      if (norm === pat || base === pat) return true;
      if (parts.includes(pat)) return true; // dir name anywhere in path
      if (pat.startsWith("*.") && norm.endsWith(pat.slice(1))) return true;
      if (norm.startsWith(pat + "/")) return true; // under a dir prefix
      if (pat.includes("*")) {
        const re = new RegExp(
          "^" +
            pat
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, "\u0000")
              .replace(/\*/g, "[^/]*")
              .replace(/\u0000/g, ".*") +
            "$"
        );
        if (re.test(norm) || re.test(base)) return true;
      }
    }
    return false;
  };
}

// Secret-bearing files that must never be captured into anatomy.md / memory.md.
// Upstream only excluded .env* (issue #54) — private keys, certs, keystores and
// credential files leaked their first ~100 chars (e.g. a PEM header) into the brain.
const SECRET_EXTS = new Set([
  ".pem", ".key", ".p8", ".p12", ".pfx", ".keystore", ".jks", ".crt", ".cer",
  ".der", ".asc", ".gpg", ".pgp", ".ppk", ".kdbx",
]);
const SECRET_NAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "credentials", ".netrc", ".pgpass", ".htpasswd", ".npmrc", ".pypirc",
]);
export function isSecretFile(fileName: string): boolean {
  const b = path.basename(fileName).toLowerCase();
  if (b === ".env" || b.startsWith(".env.")) return true;
  if (SECRET_NAMES.has(b)) return true;
  const dot = b.lastIndexOf(".");
  const ext = dot > 0 ? b.slice(dot) : ""; // dot>0 so leading-dot names (.netrc) aren't treated as ext
  return SECRET_EXTS.has(ext);
}

export function loadWolfignore(projectRoot: string): (relPath: string) => boolean {
  try {
    const content = fs.readFileSync(path.join(projectRoot, ".wolfignore"), "utf-8");
    return makeIgnoreMatcher(content.split("\n"));
  } catch {
    return () => false;
  }
}

// Combined ignore matcher: honors .gitignore AND .wolfignore (upstream #15). Gitignored
// paths (build output, deps, generated files) shouldn't be indexed or tracked either.
export function loadIgnore(projectRoot: string): (relPath: string) => boolean {
  const lines: string[] = [];
  for (const f of [".gitignore", ".wolfignore"]) {
    try {
      lines.push(...fs.readFileSync(path.join(projectRoot, f), "utf-8").split("\n"));
    } catch { /* file absent — skip */ }
  }
  return makeIgnoreMatcher(lines);
}

// Opportunistic memory.md compaction, invoked from the stop hook. Stat-gated so it
// only does real work when the file crosses the size cap (rare), keeping the hook fast.
// Consolidates session blocks older than 7 days into a one-line summary each.
export function compactMemoryIfLarge(wolfDir: string, maxBytes: number): void {
  const p = path.join(wolfDir, "memory.md");
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;

  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const lines = content.split("\n");
  const out: string[] = [];
  let inOld = false;
  let oldLines: string[] = [];
  let changed = false;
  const flush = () => {
    if (inOld && oldLines.length > 0) {
      // Keep already-consolidated blocks verbatim → idempotent across runs.
      if (oldLines.some((l) => l.startsWith("> Consolidated session"))) {
        for (const l of oldLines) out.push(l);
        return;
      }
      const actions = oldLines.filter((l) => l.startsWith("|") && !l.startsWith("|--") && !/^\|\s*Time/i.test(l)).length;
      out.push(`> Consolidated session (${actions} actions)`);
      out.push("");
      changed = true;
    }
  };
  for (const line of lines) {
    const m = line.match(/^## Session: (\d{4}-\d{2}-\d{2})/);
    if (m) {
      flush();
      inOld = new Date(m[1]) < cutoff;
      oldLines = [];
      out.push(line);
      continue;
    }
    if (inOld) oldLines.push(line);
    else out.push(line);
  }
  flush();
  if (!changed) return;

  const serialized = out.join("\n");
  const tmp = p + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, serialized, "utf-8");
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Read buglog.json tolerating the legacy bare-array format ([...]) as well as the
// current {version, bugs:[]} shape. Normalizes to the object form; callers that write
// back via writeJSON thereby migrate a legacy array without losing entries.
export interface BugLogEntry {
  id?: string;
  file?: string;
  tags?: string[];
  last_seen?: string;
  occurrences?: number;
  fix?: string;
  [k: string]: unknown;
}
export function readBugLog(wolfDir: string): { version: number; bugs: BugLogEntry[] } {
  const raw = readJSON<unknown>(path.join(wolfDir, "buglog.json"), { version: 1, bugs: [] });
  if (Array.isArray(raw)) return { version: 1, bugs: raw as BugLogEntry[] };
  const o = (raw ?? {}) as { version?: number; bugs?: unknown };
  return { version: o.version ?? 1, bugs: Array.isArray(o.bugs) ? (o.bugs as BugLogEntry[]) : [] };
}

export function readMarkdown(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function appendMarkdown(filePath: string, line: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, line, "utf-8");
}

export interface AnatomyEntry {
  file: string;
  description: string;
  tokens: number;
}

export function parseAnatomy(content: string): Map<string, AnatomyEntry[]> {
  const sections = new Map<string, AnatomyEntry[]>();
  let currentSection = "";
  // Split on \r?\n so CRLF files (Windows + git autocrlf) don't leave a trailing \r
  // that breaks the end-anchored entry regex — which would drop every entry (upstream #50).
  for (const line of content.split(/\r?\n/)) {
    const sm = line.match(/^## (.+)/);
    if (sm) {
      currentSection = sm[1].trim();
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }
    if (!currentSection) continue;
    const em = line.match(/^- `([^`]+)`(?:\s+—\s+(.+?))?\s*\(~(\d+)\s+tok\)$/);
    if (em) {
      sections.get(currentSection)!.push({
        file: em[1],
        description: em[2] || "",
        tokens: parseInt(em[3], 10),
      });
    }
  }
  return sections;
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
  const keys = [...sections.keys()].sort();
  for (const key of keys) {
    lines.push(`## ${key}`);
    lines.push("");
    const entries = sections.get(key)!.sort((a, b) => a.file.localeCompare(b.file));
    for (const e of entries) {
      const desc = e.description ? ` — ${e.description}` : "";
      lines.push(`- \`${e.file}\`${desc} (~${e.tokens} tok)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function extractDescription(filePath: string, preloadedContent?: string): string {
  const MAX_DESC = 150;
  const basename = path.basename(filePath);
  const ext = path.extname(basename).toLowerCase();
  const known: Record<string, string> = {
    "package.json": "Node.js package manifest",
    "tsconfig.json": "TypeScript configuration",
    ".gitignore": "Git ignore rules",
    "README.md": "Project documentation",
    "composer.json": "PHP package manifest",
    "requirements.txt": "Python dependencies",
    "schema.sql": "Database schema",
    "Dockerfile": "Docker container definition",
    "docker-compose.yml": "Docker Compose services",
    "Cargo.toml": "Rust package manifest",
    "go.mod": "Go module definition",
    "Gemfile": "Ruby dependencies",
    "pubspec.yaml": "Dart/Flutter package manifest",
  };
  if (known[basename]) return known[basename];

  let content: string;
  if (preloadedContent !== undefined) {
    // Caller already read the file (e.g. post-write hook) — avoid a second open.
    content = preloadedContent.slice(0, 12288);
  } else {
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(12288); // 12KB
      const n = fs.readSync(fd, buf, 0, 12288, 0);
      fs.closeSync(fd);
      content = buf.subarray(0, n).toString("utf-8");
    } catch {
      return "";
    }
  }
  if (!content.trim()) return "";

  const cap = (s: string) => s.length <= MAX_DESC ? s : s.slice(0, MAX_DESC - 3) + "...";

  // Markdown heading
  if (ext === ".md" || ext === ".mdx") {
    const m = content.match(/^#{1,2}\s+(.+)$/m);
    if (m) return cap(m[1].trim());
  }

  // HTML title
  if (ext === ".html" || ext === ".htm") {
    const m = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m) return cap(m[1].trim());
  }

  // JSDoc / PHPDoc / Javadoc — first meaningful line
  const jm = content.match(/\/\*\*\s*\n?\s*\*?\s*(.+)/);
  if (jm) {
    const l = jm[1].replace(/\*\/$/, "").trim();
    if (l && !l.startsWith("@") && l.length > 5) return cap(l);
  }

  // Python docstring
  if (ext === ".py") {
    const dm = content.match(/^(?:#[^\n]*\n)*\s*(?:"""(.+?)"""|'''(.+?)''')/s);
    if (dm) {
      const first = (dm[1] || dm[2]).split("\n")[0].trim();
      if (first && first.length > 3) return cap(first);
    }
  }

  // Rust doc comments
  if (ext === ".rs") {
    const lines = content.split("\n");
    for (const line of lines.slice(0, 20)) {
      const m = line.match(/^\s*(?:\/\/\/|\/\/!)\s*(.+)/);
      if (m && m[1].length > 5) return cap(m[1].trim());
    }
  }

  // Go package comment
  if (ext === ".go") {
    const m = content.match(/\/\/\s*Package\s+\w+\s+(.*)/);
    if (m) return cap(m[1].trim());
  }

  // C# XML doc
  if (ext === ".cs") {
    const m = content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
    if (m) {
      const text = m[1].replace(/\/\/\/\s*/g, "").replace(/\s+/g, " ").trim();
      if (text.length > 5) return cap(text);
    }
  }

  // Elixir @moduledoc
  if (ext === ".ex" || ext === ".exs") {
    const m = content.match(/@moduledoc\s+"""\s*\n\s*(.*)/);
    if (m) return cap(m[1].trim());
  }

  // Header comment (skip generic ones)
  const hdrLines = content.split("\n");
  for (const line of hdrLines.slice(0, 15)) {
    const t = line.trim();
    if (!t || t === "<?php" || t.startsWith("#!") || t.startsWith("namespace") || t.startsWith("use ") || t.startsWith("import ") || t.startsWith("from ") || t.startsWith("require") || t.startsWith("module ")) continue;
    const cm = t.match(/^(?:\/\/|#|--)\s*(.+)/);
    if (cm) {
      const text = cm[1].trim();
      const lower = text.toLowerCase();
      if (text.length > 5 && !lower.startsWith("copyright") && !lower.startsWith("license") && !lower.startsWith("@") && !lower.startsWith("strict") && !lower.startsWith("generated") && !lower.startsWith("eslint-") && !lower.startsWith("nolint")) {
        return cap(text);
      }
    }
    if (!t.startsWith("//") && !t.startsWith("#") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("--")) break;
  }

  // ─── PHP / Laravel ───────────────────────────────────────
  if (ext === ".php") {
    if (basename.endsWith(".blade.php")) {
      const ext2 = content.match(/@extends\(\s*['"]([^'"]+)['"]\s*\)/);
      const sections = (content.match(/@section\(\s*['"](\w+)['"]/g) || []).map(s => s.match(/['"](\w+)['"]/)?.[1]).filter(Boolean);
      const parts: string[] = [];
      if (ext2) parts.push(`extends ${ext2[1]}`);
      if (sections.length) parts.push(`sections: ${sections.join(", ")}`);
      return cap(parts.length ? `Blade: ${parts.join(", ")}` : "Blade template");
    }

    const classM = content.match(/class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    const className = classM?.[1] || "";
    const parent = classM?.[2] || "";
    const pubMethods = (content.match(/public\s+function\s+(\w+)/g) || [])
      .map(m => m.match(/public\s+function\s+(\w+)/)?.[1])
      .filter(n => n && n !== "__construct" && n !== "middleware") as string[];

    if (basename.endsWith("Controller.php") || parent === "Controller") {
      if (pubMethods.length > 0) {
        const display = pubMethods.slice(0, 5).join(", ");
        return cap(pubMethods.length > 5 ? `${display} + ${pubMethods.length - 5} more` : display);
      }
    }

    if (parent === "Model" || parent === "Authenticatable") {
      const parts: string[] = [];
      const tbl = content.match(/\$table\s*=\s*['"]([^'"]+)['"]/);
      if (tbl) parts.push(`table: ${tbl[1]}`);
      const fill = content.match(/\$fillable\s*=\s*\[([^\]]*)\]/s);
      if (fill) { const c = (fill[1].match(/['"]/g) || []).length / 2; parts.push(`${Math.floor(c)} fields`); }
      const rels = (content.match(/\$this->(hasMany|hasOne|belongsTo|belongsToMany|morphMany|morphTo)\(/g) || []).length;
      if (rels) parts.push(`${rels} rels`);
      return cap(parts.length ? `Model — ${parts.join(", ")}` : `Model: ${className}`);
    }

    if (basename.match(/^\d{4}_\d{2}_\d{2}/)) {
      const create = content.match(/Schema::create\(\s*['"]([^'"]+)['"]/);
      if (create) return `Migration: create ${create[1]} table`;
      const alter = content.match(/Schema::table\(\s*['"]([^'"]+)['"]/);
      if (alter) return `Migration: alter ${alter[1]} table`;
      return "Database migration";
    }

    if (className && pubMethods.length > 0) {
      const display = pubMethods.slice(0, 4).join(", ");
      return cap(pubMethods.length > 4 ? `${className}: ${display} + ${pubMethods.length - 4} more` : `${className}: ${display}`);
    }
  }

  // ─── TS/JS/React/Next.js ─────────────────────────────────
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    // React component
    if (ext === ".tsx" || ext === ".jsx") {
      const comp = content.match(/(?:export\s+(?:default\s+)?)?(?:function|const)\s+(\w+)/);
      const parts: string[] = [];
      if (comp) parts.push(comp[1]);
      const renders: string[] = [];
      if (/<(?:form|Form)/i.test(content)) renders.push("form");
      if (/<(?:table|Table|DataTable)/i.test(content)) renders.push("table");
      if (/<(?:dialog|Dialog|Modal|Drawer)/i.test(content)) renders.push("modal");
      if (renders.length) parts.push(`renders ${renders.join(", ")}`);
      if (parts.length) return cap(parts.join(" — "));
    }

    // Next.js conventions
    if (basename === "page.tsx" || basename === "page.js") return "Next.js page component";
    if (basename === "layout.tsx" || basename === "layout.js") return "Next.js layout";
    if (basename === "route.ts" || basename === "route.js") {
      const methods = [...new Set((content.match(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/g) || [])
        .map(m => m.match(/(GET|POST|PUT|PATCH|DELETE)/)?.[1]))].filter(Boolean);
      return methods.length ? `Next.js API route: ${methods.join(", ")}` : "Next.js API route";
    }

    // Express/Fastify routes
    const routeHits = content.match(/\.(get|post|put|patch|delete)\s*\(\s*['"`]/g);
    if (routeHits && routeHits.length > 0) {
      const methods = [...new Set(routeHits.map(r => r.match(/\.(get|post|put|patch|delete)/)?.[1]?.toUpperCase()))];
      return cap(`API routes: ${methods.join(", ")} (${routeHits.length} endpoints)`);
    }

    // tRPC router
    if (content.includes("createTRPCRouter") || content.includes("publicProcedure")) {
      const procs = (content.match(/\.(query|mutation|subscription)\s*\(/g) || []).length;
      return procs ? `tRPC router: ${procs} procedures` : "tRPC router";
    }

    // Zod schemas
    if (content.includes("z.object") || content.includes("z.string")) {
      const schemas = (content.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*z\./g) || [])
        .map(s => s.match(/(?:const|let)\s+(\w+)/)?.[1]).filter(Boolean);
      if (schemas.length) return cap(`Zod schemas: ${schemas.slice(0, 4).join(", ")}${schemas.length > 4 ? ` + ${schemas.length - 4} more` : ""}`);
    }

    // Exports summary
    const exports = (content.match(/export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+(\w+)/g) || [])
      .map(e => e.match(/(\w+)$/)?.[1]).filter(Boolean) as string[];
    if (exports.length > 0 && exports.length <= 5) return `Exports ${exports.join(", ")}`;
    if (exports.length > 5) return cap(`Exports ${exports.slice(0, 4).join(", ")} + ${exports.length - 4} more`);
  }

  // ─── Python / Django / FastAPI / Flask ────────────────────
  if (ext === ".py") {
    // Django model
    if (content.includes("models.Model")) {
      const cls = content.match(/class\s+(\w+)\(.*models\.Model\)/);
      const fields = (content.match(/^\s+\w+\s*=\s*models\.\w+/gm) || []).length;
      return cap(`Model: ${cls?.[1] || "unknown"}, ${fields} fields`);
    }
    // FastAPI/Flask routes
    if (content.includes("@router.") || content.includes("@app.")) {
      const routes = (content.match(/@(?:router|app)\.(get|post|put|patch|delete)\s*\(/g) || []);
      return cap(routes.length ? `API: ${routes.length} endpoints` : "API router");
    }
    // Pydantic
    if (content.includes("BaseModel") && content.includes("Field(")) {
      const cls = content.match(/class\s+(\w+)\(.*BaseModel\)/);
      return cls ? `Pydantic: ${cls[1]}` : "Pydantic model";
    }
    // Celery
    if (content.includes("@shared_task") || content.includes("@app.task")) {
      const tasks = (content.match(/def\s+(\w+)/g) || []).map(m => m.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_")) as string[];
      return cap(tasks.length ? `Celery tasks: ${tasks.join(", ")}` : "Celery task");
    }
    // Generic
    const pyClass = content.match(/class\s+(\w+)/);
    const funcs = (content.match(/def\s+(\w+)/g) || []).map(f => f.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_")) as string[];
    if (pyClass && funcs.length > 0) return cap(funcs.length > 4 ? `${pyClass[1]}: ${funcs.slice(0, 4).join(", ")} + ${funcs.length - 4} more` : `${pyClass[1]}: ${funcs.join(", ")}`);
    if (funcs.length > 0) return cap(funcs.slice(0, 4).join(", "));
  }

  // ─── Go ──────────────────────────────────────────────────
  if (ext === ".go") {
    const handlers = (content.match(/func\s+(\w+)\s*\(\s*\w+\s+http\.ResponseWriter/g) || [])
      .map(m => m.match(/func\s+(\w+)/)?.[1]).filter(Boolean);
    if (handlers.length) return cap(`HTTP handlers: ${handlers.slice(0, 5).join(", ")}`);
    const iface = content.match(/type\s+(\w+)\s+interface\s*\{/);
    if (iface) return `Interface: ${iface[1]}`;
    const structM = content.match(/type\s+(\w+)\s+struct\s*\{/);
    if (structM) return `Struct: ${structM[1]}`;
    const funcs = (content.match(/^func\s+(\w+)/gm) || []).map(m => m.match(/func\s+(\w+)/)?.[1]).filter(n => n && n[0] === n[0].toUpperCase()) as string[];
    if (funcs.length) return cap(funcs.slice(0, 5).join(", "));
  }

  // ─── Rust ────────────────────────────────────────────────
  if (ext === ".rs") {
    const structM = content.match(/pub\s+struct\s+(\w+)/);
    if (structM) {
      const methods = (content.match(/pub\s+(?:async\s+)?fn\s+(\w+)/g) || []).map(m => m.match(/fn\s+(\w+)/)?.[1]).filter(Boolean);
      return cap(methods.length ? `${structM[1]}: ${methods.slice(0, 4).join(", ")}` : `Struct: ${structM[1]}`);
    }
    const traitM = content.match(/pub\s+trait\s+(\w+)/);
    if (traitM) return `Trait: ${traitM[1]}`;
    const enumM = content.match(/pub\s+enum\s+(\w+)/);
    if (enumM) return `Enum: ${enumM[1]}`;
    const fns = (content.match(/pub\s+(?:async\s+)?fn\s+(\w+)/g) || []).map(m => m.match(/fn\s+(\w+)/)?.[1]).filter(Boolean);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // ─── Java / Spring ───────────────────────────────────────
  if (ext === ".java") {
    const cls = content.match(/(?:public\s+)?class\s+(\w+)/);
    const className = cls?.[1] || basename.replace(".java", "");
    const annotations = (content.match(/@(RestController|Controller|Service|Repository|Component|Entity|Configuration)/g) || []).map(a => a.slice(1));
    const mappings = (content.match(/@(?:Get|Post|Put|Patch|Delete|Request)Mapping/g) || []).length;
    if (mappings) return cap(`${annotations[0] || "Spring"}: ${className} (${mappings} endpoints)`);
    if (annotations.length) return `${annotations[0]}: ${className}`;
    if (content.includes("@Entity")) return `Entity: ${className}`;
    const methods = (content.match(/public\s+(?:static\s+)?(?:\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\(/g) || [])
      .map(m => m.match(/(\w+)\s*\(/)?.[1]).filter(n => n && n !== className) as string[];
    if (methods.length) return cap(`${className}: ${methods.slice(0, 4).join(", ")}`);
    return className ? `Class: ${className}` : "";
  }

  // ─── Kotlin ──────────────────────────────────────────────
  if (ext === ".kt" || ext === ".kts") {
    const cls = content.match(/(?:data\s+)?class\s+(\w+)/);
    if (content.match(/data\s+class/)) return `Data class: ${cls?.[1] || basename.replace(/\.kts?$/, "")}`;
    if (content.includes("routing {")) return "Ktor routing";
    const fns = (content.match(/fun\s+(\w+)/g) || []).map(m => m.match(/fun\s+(\w+)/)?.[1]).filter(Boolean);
    if (cls && fns.length) return cap(`${cls[1]}: ${fns.slice(0, 4).join(", ")}`);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // ─── C# / .NET ───────────────────────────────────────────
  if (ext === ".cs") {
    const cls = content.match(/(?:public\s+)?(?:partial\s+)?class\s+(\w+)(?:\s*:\s*(\w+))?/);
    const className = cls?.[1] || basename.replace(".cs", "");
    const parent = cls?.[2] || "";
    if (parent === "Controller" || parent === "ControllerBase" || content.includes("[ApiController]")) {
      const actions = (content.match(/\[Http(Get|Post|Put|Patch|Delete)\]/g) || []).map(a => a.match(/Http(\w+)/)?.[1]).filter(Boolean);
      return cap(actions.length ? `API Controller: ${className} (${[...new Set(actions)].join(", ")})` : `Controller: ${className}`);
    }
    if (parent === "DbContext" || content.includes("DbSet<")) {
      const sets = (content.match(/DbSet<(\w+)>/g) || []).map(s => s.match(/<(\w+)>/)?.[1]).filter(Boolean);
      return cap(sets.length ? `DbContext: ${sets.join(", ")}` : `DbContext: ${className}`);
    }
    return className ? `Class: ${className}` : "";
  }

  // ─── Ruby / Rails ────────────────────────────────────────
  if (ext === ".rb") {
    const cls = content.match(/class\s+(\w+)(?:\s*<\s*(\w+(?:::\w+)?))?/);
    const className = cls?.[1] || "";
    const parent = cls?.[2] || "";
    if (parent?.includes("Controller")) {
      const actions = (content.match(/def\s+(index|show|new|create|edit|update|destroy|\w+)/g) || [])
        .map(m => m.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_")) as string[];
      return cap(actions.length ? `Controller: ${actions.join(", ")}` : `Controller: ${className}`);
    }
    if (parent === "ApplicationRecord" || parent === "ActiveRecord::Base") return `Model: ${className}`;
    if (basename.match(/^\d{14}_/)) {
      const create = content.match(/create_table\s+:(\w+)/);
      return create ? `Migration: create ${create[1]}` : "Database migration";
    }
    const methods = (content.match(/def\s+(\w+)/g) || []).map(m => m.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_")) as string[];
    if (cls && methods.length) return cap(`${className}: ${methods.slice(0, 4).join(", ")}`);
  }

  // ─── Swift ───────────────────────────────────────────────
  if (ext === ".swift") {
    if (content.includes(": View") || content.includes("some View")) {
      const name = content.match(/struct\s+(\w+)\s*:\s*View/);
      return name ? `SwiftUI view: ${name[1]}` : "SwiftUI view";
    }
    const proto = content.match(/protocol\s+(\w+)/);
    if (proto) return `Protocol: ${proto[1]}`;
    const struct = content.match(/(?:public\s+)?struct\s+(\w+)/);
    const cls = content.match(/(?:public\s+)?class\s+(\w+)/);
    const name = struct?.[1] || cls?.[1] || "";
    if (name) return `${struct ? "Struct" : "Class"}: ${name}`;
  }

  // ─── Dart / Flutter ──────────────────────────────────────
  if (ext === ".dart") {
    if (content.includes("StatefulWidget") || content.includes("StatelessWidget")) {
      const name = content.match(/class\s+(\w+)\s+extends\s+(?:Stateful|Stateless)Widget/);
      return name ? `${content.includes("StatefulWidget") ? "Stateful" : "Stateless"} widget: ${name[1]}` : "Flutter widget";
    }
    const cls = content.match(/class\s+(\w+)/);
    if (cls) return `Class: ${cls[1]}`;
  }

  // ─── Vue / Svelte / Astro ────────────────────────────────
  if (ext === ".vue") {
    const name = content.match(/name:\s*['"]([^'"]+)['"]/);
    const setup = content.includes("<script setup");
    const parts: string[] = [];
    if (name) parts.push(name[1]);
    if (setup) parts.push("setup");
    return cap(parts.length ? `Vue: ${parts.join(", ")}` : "Vue component");
  }
  if (ext === ".svelte") return `Svelte: ${basename.replace(".svelte", "")}`;
  if (ext === ".astro") return `Astro: ${basename.replace(".astro", "")}`;

  // ─── CSS / SCSS / Less ───────────────────────────────────
  if (ext === ".css" || ext === ".scss" || ext === ".less") {
    const rules = (content.match(/^[.#@][^\n{]+/gm) || []).length;
    const vars = (content.match(/--[\w-]+\s*:/g) || []).length;
    const parts: string[] = [];
    if (rules) parts.push(`${rules} rules`);
    if (vars) parts.push(`${vars} vars`);
    return cap(parts.length ? `Styles: ${parts.join(", ")}` : "Stylesheet");
  }

  // ─── SQL ─────────────────────────────────────────────────
  if (ext === ".sql") {
    const creates = (content.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)/gi) || [])
      .map(m => m.match(/(?:TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([`"']?\w+)/i)?.[1]?.replace(/[`"']/g, "")).filter(Boolean);
    if (creates.length) return cap(`SQL: tables: ${creates.slice(0, 4).join(", ")}`);
  }

  // ─── Proto / GraphQL ─────────────────────────────────────
  if (ext === ".proto") {
    const msgs = (content.match(/message\s+(\w+)/g) || []).map(m => m.match(/message\s+(\w+)/)?.[1]).filter(Boolean);
    const services = (content.match(/service\s+(\w+)/g) || []).map(m => m.match(/service\s+(\w+)/)?.[1]).filter(Boolean);
    const parts: string[] = [];
    if (msgs.length) parts.push(`messages: ${msgs.slice(0, 3).join(", ")}`);
    if (services.length) parts.push(`services: ${services.join(", ")}`);
    return cap(parts.length ? `Proto: ${parts.join(", ")}` : "");
  }
  if (ext === ".graphql" || ext === ".gql") {
    const types = (content.match(/type\s+(\w+)/g) || []).map(m => m.match(/type\s+(\w+)/)?.[1]).filter(Boolean);
    return cap(types.length ? `GraphQL: types: ${types.slice(0, 4).join(", ")}` : "GraphQL schema");
  }

  // ─── YAML ────────────────────────────────────────────────
  if (ext === ".yaml" || ext === ".yml") {
    if (content.includes("runs-on:")) {
      const name = content.match(/^name:\s*(.+)$/m);
      return cap(name ? `CI: ${name[1].trim()}` : "GitHub Actions workflow");
    }
    if (content.includes("apiVersion:") && content.includes("kind:")) {
      const kind = content.match(/kind:\s*(\w+)/);
      return cap(kind ? `K8s ${kind[1]}` : "Kubernetes manifest");
    }
    if (content.includes("services:") && (basename.includes("docker") || basename.includes("compose"))) {
      const services = (content.match(/^\s{2}\w+:/gm) || []).length;
      return `Docker Compose: ${services} services`;
    }
  }

  // ─── TOML ────────────────────────────────────────────────
  if (ext === ".toml") {
    const desc = content.match(/^description\s*=\s*"([^"]+)"/m);
    if (desc) return cap(desc[1]);
  }

  // ─── Elixir ──────────────────────────────────────────────
  if (ext === ".ex" || ext === ".exs") {
    const mod = content.match(/defmodule\s+([\w.]+)/);
    if (content.includes("Phoenix.LiveView")) return cap(mod ? `LiveView: ${mod[1]}` : "Phoenix LiveView");
    if (content.includes("Controller")) return cap(mod ? `Phoenix controller: ${mod[1]}` : "Phoenix controller");
    const fns = (content.match(/def\s+(\w+)/g) || []).map(m => m.match(/def\s+(\w+)/)?.[1]).filter(Boolean);
    if (mod && fns.length) return cap(`${mod[1]}: ${fns.slice(0, 4).join(", ")}`);
    if (mod) return mod[1];
  }

  // ─── Lua ─────────────────────────────────────────────────
  if (ext === ".lua") {
    const fns = (content.match(/function\s+(?:\w+[.:])?(\w+)/g) || []).map(m => m.match(/(\w+)\s*$/)?.[1]).filter(Boolean);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // ─── Zig ─────────────────────────────────────────────────
  if (ext === ".zig") {
    const fns = (content.match(/pub\s+fn\s+(\w+)/g) || []).map(m => m.match(/fn\s+(\w+)/)?.[1]).filter(Boolean);
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // Last resort
  const declM = content.match(/(?:function|class|const|interface|type|enum)\s+(\w+)/);
  if (declM) {
    const name = declM[1];
    const methods = (content.match(/(?:public\s+)?(?:async\s+)?(?:function\s+|(?:get|set)\s+)(\w+)\s*\(/g) || [])
      .map(m => m.match(/(\w+)\s*\(/)?.[1]).filter(n => n && n !== name && n !== "__construct" && n !== "constructor") as string[];
    if (methods.length > 0 && methods.length <= 5) return cap(`${name}: ${methods.join(", ")}`);
    if (methods.length > 5) return cap(`${name}: ${methods.slice(0, 3).join(", ")} + ${methods.length - 3} more`);
    return `Declares ${name}`;
  }
  return "";
}

// Estimation lives in tracker/token-estimator.ts — the single source of truth for both
// the extension table and the char/token ratios. Re-exported here so hook call sites keep
// importing from ./shared.js as before.
import { estimateTokens } from "./token-estimator.js";

export {
  estimateTokens,
  estimateFileTokens,
  detectContentType,
  getTokenRatios,
  DEFAULT_RATIOS,
  type ContentType,
  type TokenRatios,
} from "./token-estimator.js";

// Which coding agent is driving this hook — labels ledger sessions so per-agent usage can be split.
export function detectAgent(): string {
  if (process.env.CLAUDE_PROJECT_DIR) return "claude";
  if (process.env.CODEX_PROJECT_ROOT) return "codex";
  if (process.env.GEMINI_CLI || process.env.GEMINI_PROJECT_DIR) return "gemini";
  return process.env.OPENWOLF_AGENT || "default";
}

// Real API usage measured from a harness transcript — the verifiable numbers the estimated
// ledger can be checked against, rather than trusting the char/token heuristic.
export interface RealUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  api_calls: number;
}

// Parse a Claude Code / Codex transcript (JSONL) and sum the real token usage. Each API call emits
// one `message.usage` block; streaming can repeat a message id across lines, so we keep the last
// usage seen per id and count distinct ids as api_calls. Returns null if the file is unreadable or
// carries no usage data (older harness, no transcript).
export function readTranscriptUsage(transcriptPath: string): RealUsage | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }
  const byId = new Map<string, { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }>();
  let anon = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry?.message?.usage;
      if (usage && typeof usage === "object" && typeof usage.output_tokens === "number") {
        byId.set(entry.message.id ?? `anon-${anon++}`, usage);
      }
    } catch {}
  }
  if (byId.size === 0) return null;
  const total: RealUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, api_calls: byId.size };
  for (const u of byId.values()) {
    total.input_tokens += u.input_tokens ?? 0;
    total.output_tokens += u.output_tokens ?? 0;
    total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  }
  return total;
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function timeShort(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    // If no stdin data after 4s, resolve with whatever we have so far.
    // On Windows, stdin delivery from Claude Code hooks can be slow.
    setTimeout(() => resolve(chunks.length ? Buffer.concat(chunks).toString("utf-8") : "{}"), 4000);
  });
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// Count non-mechanical (semantic) entries written to memory.md today. Mechanical rows
// (auto file-op / session-end lines) don't count. Used by the stop hook to detect whether
// a meaningful session summary was written. (upstream #55)
export function countSemanticEntries(wolfDir: string): number {
  try {
    const content = fs.readFileSync(path.join(wolfDir, "memory.md"), "utf-8");
    const mechanical = /^\|\s*[\d:]+\s*\|\s*(Created|Edited|Multi-edited|Session end:|designqc:)/;
    const today = `| ${new Date().toISOString().slice(0, 10)}`;
    let count = 0;
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith(today) && !mechanical.test(line)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// Remove <private>…</private> blocks (case-insensitive, spanning newlines). Content wrapped
// this way in a knowledge file is kept out of the injected resume digest and out of `recall`
// results — a lightweight way to note secrets/sensitive context without leaking it into the LLM.
export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "");
}

// Structured session-summary scaffold written under each new session header in memory.md.
// An HTML comment → invisible in rendered markdown (no clutter), but a clear prompt for the
// agent to replace at session end with a consistent, greppable one-liner (see OPENWOLF.md).
export const SESSION_SUMMARY_SCAFFOLD =
  "<!-- session summary — replace at session end: **Did:** … · **Learned:** … · **Next:** … · **Files:** … -->";

// --- Session-start resume digest -------------------------------------------------
// Assemble a compact, hard-capped context bundle injected at SessionStart so the model
// resumes without spending reads reconstructing state from STATUS.md/cerebrum/memory.
// "Smarter" than a full dump: high-signal sections only, each individually clipped.

function clipText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = "\n… (truncated — open the file for the rest)";
  return text.slice(0, Math.max(0, cap - marker.length)).trimEnd() + marker;
}

// A STATUS.md that is still the unedited template carries no resume value.
function isStatusStub(s: string): boolean {
  return /\{\{PROJECT_NAME\}\}/.test(s) || (/_<[^>]*>_/.test(s) && /nothing yet/.test(s));
}

// Body of a markdown section identified by its heading, up to the next h1/h2 heading.
function extractMarkdownSection(md: string, headingRe: RegExp): string {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

// The most recent "## Session:" block in memory.md that actually has data rows.
function lastMemorySession(md: string): string {
  const lines = md.split(/\r?\n/);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (/^## Session:/.test(lines[i])) starts.push(i);
  for (let s = starts.length - 1; s >= 0; s--) {
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(starts[s], end);
    if (block.some((l) => /^\|\s*\d{1,2}:\d{2}/.test(l))) return block.join("\n").trim();
  }
  return "";
}

// A one-line headline of the latest session instead of dumping every row (progressive
// disclosure): date + row count + the first few action cells. Detail is a Read away.
function memoryHeadline(md: string): string {
  const block = lastMemorySession(md);
  if (!block) return "";
  const lines = block.split(/\r?\n/);
  const header = lines[0].replace(/^## Session:\s*/, "").trim();
  const rows = lines.filter((l) => /^\|\s*\d{1,2}:\d{2}/.test(l));
  const actions = rows.slice(0, 3).map((r) => r.split("|")[2]?.trim()).filter(Boolean);
  const more = rows.length > 3 ? `, +${rows.length - 3} more` : "";
  return `Last session ${header}: ${rows.length} entr${rows.length === 1 ? "y" : "ies"} — ${actions.join("; ")}${more}\n` +
    "(Read memory.md or `openwolf recall <query>` for detail.)";
}

const BULLET_RE = /^\s*[-*] /gm;

// Index of knowledge files the model can pull on demand, with entry counts and token cost —
// so it knows what's available without us pre-dumping it (progressive disclosure).
function availabilityIndex(read: (f: string) => string, cerebrum: string, nativeDir: string | null): string {
  const items: string[] = [];
  if (cerebrum.trim()) {
    const entries = (cerebrum.match(BULLET_RE) || []).length;
    items.push(`- cerebrum.md — ${entries} entries, ~${estimateTokens(cerebrum, "prose")} tok (preferences, learnings, decisions, do-not-repeat) → Read or \`openwolf recall\``);
  }
  const buglog = read("buglog.json");
  if (buglog.trim()) {
    let n = 0;
    try {
      const raw = JSON.parse(buglog) as unknown;
      n = Array.isArray(raw) ? raw.length : ((raw as { bugs?: unknown[] }).bugs?.length ?? 0);
    } catch { /* unparseable */ }
    if (n > 0) items.push(`- buglog.json — ${n} logged bugs → \`openwolf recall <error>\``);
  }
  const anatomy = read("anatomy.md");
  if (anatomy.trim()) {
    const files = (anatomy.match(BULLET_RE) || []).length;
    if (files > 0) items.push(`- anatomy.md — ${files} files mapped → Read before opening files`);
  }
  // Claude's own native Auto Memory — searchable via recall, not just what its index loads.
  if (nativeDir) {
    let topics = 0;
    try { topics = fs.readdirSync(nativeDir).filter((n) => n.endsWith(".md") && !n.includes(".bak") && n !== "MEMORY.md").length; } catch { /* unreadable */ }
    if (topics > 0) items.push(`- Claude native memory — ${topics} topic files (only the MEMORY.md index auto-loads) → \`openwolf recall <query>\` searches all of them`);
  }
  return items.join("\n");
}

// --- Bash activity capture (opt-in) -----------------------------------------
// A PostToolUse:Bash hook can append notable commands + failures to .wolf/activity.log, which the
// resume digest then surfaces. Off by default — commands can carry secrets, so it's opt-in and the
// captured text is redacted. These helpers are pure so they can be unit-tested without a hook run.

export interface CaptureConfig { enabled: boolean; logMaxBytes: number; }

export function getCaptureConfig(wolfDir: string): CaptureConfig {
  const cfg = readJSON<{ openwolf?: { capture?: { enabled?: boolean; log_max_bytes?: number } } }>(
    path.join(wolfDir, "config.json"), {}
  );
  const c = cfg.openwolf?.capture ?? {};
  return {
    enabled: c.enabled === true, // opt-in: anything but an explicit true stays off
    logMaxBytes: typeof c.log_max_bytes === "number" && c.log_max_bytes > 0 ? c.log_max_bytes : 131072,
  };
}

// Best-effort secret redaction before a command hits disk: collapse common token/key shapes and
// `KEY=secret` / `--token secret` assignments to `***`. Not a guarantee — the real guard is opt-in.
export function redactSecrets(cmd: string): string {
  return cmd
    .replace(/\bgh[posru]_[A-Za-z0-9]{16,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9-]{16,}/g, "***") // sk-ant-…, sk-proj-… (keys contain dashes)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "***")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "***")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, "***") // JWTs
    // password embedded in a URL: scheme://user:pass@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1***@")
    // curl basic auth: -u user:pass  /  --user user:pass
    .replace(/(-u\s+|--user[= ])[^\s:]+:\S+/g, "$1***")
    // header/kv forms: x-api-key: …, api_key=…, authorization: bearer …
    .replace(/((?:x-)?api[-_]?key\s*[:=]\s*)\S+/gi, "$1***")
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)\S+/gi, "$1***")
    // flags: --token X, --password X, --secret X, --otp X …
    .replace(/(--?(?:otp|token|password|passwd|pwd|pass|secret|api[-_]?key|apikey|auth|credential)s?[= ])\S+/gi, "$1***")
    // env assignments: FOO_TOKEN=…, DB_PASS=…, X_PWD=…, *_PASSPHRASE=…
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|CREDENTIAL|CRED|PWD|PASS|KEY))=\S+/gi, "$1=***");
}

// A command worth capturing on success: state-changing actions (commits, installs, builds, tests,
// migrations, deploys). Trivial read-only inspection (ls/cat/grep/git status…) returns false and is
// dropped. Failures are captured by the caller regardless of this.
export function isNotableCommand(cmd: string): boolean {
  return /\b(git\s+(?:commit|push|pull|merge|rebase|tag|revert|reset|cherry-pick|stash)|(?:npm|pnpm|yarn)\s+(?:i\b|install|ci|add|remove|run|build|test|publish|update)|pip\d?\s+install|poetry\s+(?:add|install)|cargo\s+(?:build|test|run|publish|install)|go\s+(?:build|test|run|install)|make\b|docker(?:\s+compose)?\s+(?:build|up|down|restart|run)|tsc\b|vite\s+build|pytest|jest|mocha|vitest|migrate|alembic|prisma\s+(?:migrate|db)|deploy|terraform\s+(?:apply|destroy)|kubectl\s+(?:apply|delete|rollout)|systemctl\s+(?:restart|start|stop)|pm2\s+(?:restart|start|stop|reload))\b/i
    .test(cmd.trim());
}

// Throwaway write targets: scratch space and device files. Editing /tmp is not project work, and
// counting it would make every `foo > /tmp/out` look like an authored change.
function isThrowawayTarget(target: string): boolean {
  const t = target.replace(/^['"]|['"]$/g, "");
  return t.startsWith("/dev/") || t.startsWith("/tmp/") || t.startsWith("/var/tmp/") || t === "/dev/null";
}

// Does this shell command modify a file?
//
// post-write.ts only sees the Write|Edit|MultiEdit tools. Everything done through the shell —
// heredocs, `>` redirection, `sed -i`, `cp` — bypasses it entirely, so a session that edits via Bash
// reports zero writes and every end-of-turn reminder (STATUS.md, memory.md summary) stays silent.
// That is the half of bug-148 that 1.16.1 did not close. [bug-149]
//
// Deliberately answers only "did this write a file", never "which file": no path is extracted or
// stored, so nothing can leak into anatomy/memory (upstream #56). Conservative by design — a missed
// write costs a reminder, a false one cries wolf.
export function isFileWritingCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c) return false;

  // Redirection into a real file: `> f`, `>> f`, `cat <<EOF > f`. The lookbehind drops fd-prefixed
  // forms (`2>`), the `(?!&)` drops fd-dups (`>&2`, `2>&1`) — neither writes a file.
  for (const m of c.matchAll(/(?<![0-9<>])>>?\s*(?!&)([^\s;&|<>()]+)/g)) {
    if (!isThrowawayTarget(m[1])) return true;
  }

  // In-place editors.
  if (/\bsed\s+(?:-[a-zA-Z]*i|--in-place)/.test(c)) return true;
  if (/\b(?:perl|ruby)\s+-[a-zA-Z]*i\b/.test(c)) return true;

  // Writers that take the path as an argument. `tee` alone is a write; `tee /dev/null` is not.
  if (/\btee\b/.test(c) && !/\btee\s+(?:-\w+\s+)*\/dev\/null\b/.test(c)) return true;
  if (/\b(?:cp|mv|rsync|patch|truncate)\s/.test(c)) return true;
  if (/\bgit\s+apply\b/.test(c)) return true;

  // Inline interpreters that write files (python -c, node -e, and their heredoc forms) — the way
  // bulk edits usually get made when the shell is already open.
  if (/\b(?:writeFileSync|appendFileSync|write_text|writelines|json\.dump|shutil\.(?:copy|move|copyfile))\b/.test(c)) return true;
  if (/\bopen\s*\([^)]*,\s*['"][wax]/.test(c)) return true;

  return false;
}

// Trim log content to at most maxBytes by dropping whole leading lines (keeps the newest tail).
export function tailWithinBytes(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  const lines = content.split("\n");
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n"), "utf8") > maxBytes) lines.shift();
  return lines.join("\n");
}

// Last few non-blank lines of activity.log, for the resume digest. Empty when capture is unused.
export function activityTail(wolfDir: string, maxLines = 8): string {
  let content = "";
  try { content = fs.readFileSync(path.join(wolfDir, "activity.log"), "utf8"); } catch { return ""; }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

// --- Localization for the injected resume digest (en default, de) ---------------------------
// The digest is the one substantial block OpenWolf writes into the model's context, so it's worth
// localizing. Language = OPENWOLF_LANG env (de*/en*) → config openwolf.lang → "en".
export type DigestLang = "en" | "de";

export function resumeLang(wolfDir: string): DigestLang {
  const env = (process.env.OPENWOLF_LANG || "").toLowerCase();
  if (env.startsWith("de")) return "de";
  if (env.startsWith("en")) return "en";
  const cfg = readJSON<{ openwolf?: { lang?: string } }>(path.join(wolfDir, "config.json"), {});
  return (cfg.openwolf?.lang || "").toLowerCase().startsWith("de") ? "de" : "en";
}

const DIGEST_I18N: Record<DigestLang, {
  statusPoint: string; doNotRepeat: string; recentActivity: string; recentCommands: string; availableOnDemand: string; preamble: string;
}> = {
  en: {
    statusPoint: "STATUS.md — resume point",
    doNotRepeat: "Do-Not-Repeat (cerebrum.md",
    recentActivity: "Recent activity (memory.md)",
    recentCommands: "Recent commands (activity.log)",
    availableOnDemand: "📇 Available on demand",
    preamble:
      "🐺 OpenWolf resume context — the project's own handoff notes, injected so you can continue " +
      "without re-reading these files. Curated context is inline; pull anything under “Available on " +
      "demand” with Read or `openwolf recall <query>`.",
  },
  de: {
    statusPoint: "STATUS.md — Wiedereinstiegspunkt",
    doNotRepeat: "Do-Not-Repeat (cerebrum.md",
    recentActivity: "Jüngste Aktivität (memory.md)",
    recentCommands: "Jüngste Kommandos (activity.log)",
    availableOnDemand: "📇 Auf Abruf verfügbar",
    preamble:
      "🐺 OpenWolf-Wiedereinstiegs-Kontext — die Handoff-Notizen des Projekts, injiziert, damit du " +
      "weiterarbeiten kannst, ohne diese Dateien neu zu lesen. Kuratierter Kontext ist inline; alles unter " +
      "„Auf Abruf verfügbar“ per Read oder `openwolf recall <query>` nachladen.",
  },
};

export function buildResumeDigest(wolfDir: string, maxChars = 6000): string | null {
  const L = DIGEST_I18N[resumeLang(wolfDir)];
  const read = (f: string): string => {
    try { return stripPrivate(fs.readFileSync(path.join(wolfDir, f), "utf-8")); } catch { return ""; }
  };
  const tok = (s: string): number => estimateTokens(s, "prose");
  const parts: string[] = [];

  // Curated, high-value knowledge → inline (with a token-cost hint).
  const status = read("STATUS.md").trim();
  if (status && !isStatusStub(status)) {
    const clipped = clipText(status, Math.floor(maxChars * 0.5));
    parts.push(`### ${L.statusPoint} (~${tok(clipped)} tok)\n${clipped}`);
  }
  const cerebrum = read("cerebrum.md");
  const dnr = extractMarkdownSection(cerebrum, /^#{2,3}\s*Do[-\s]?Not[-\s]?Repeat/i);
  if (dnr) {
    const clipped = clipText(dnr, Math.floor(maxChars * 0.28));
    parts.push(`### ${L.doNotRepeat}, ~${tok(clipped)} tok)\n${clipped}`);
  }

  // Recent activity → compact headline, not every row.
  const head = memoryHeadline(read("memory.md"));
  if (head) parts.push(`### ${L.recentActivity}\n${head}`);

  // Recent shell commands + failures, if capture is enabled (opt-in).
  const cmds = activityTail(wolfDir, 8);
  if (cmds) parts.push(`### ${L.recentCommands}\n${cmds}`);

  // Everything else → an index to pull on demand (incl. Claude's native Auto Memory).
  const index = availabilityIndex(read, cerebrum, nativeMemoryDir(path.dirname(wolfDir)));
  if (index) parts.push(`### ${L.availableOnDemand}\n${index}`);

  if (parts.length === 0) return null;
  return clipText(L.preamble + "\n\n" + parts.join("\n\n"), maxChars);
}
