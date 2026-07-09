import * as fs from "node:fs";
import * as path from "node:path";
import { readJSON, writeJSON, readText, writeText } from "./fs-safe.js";

// ---------------------------------------------------------------------------
// Retention / size limits. Defaults here are the source of truth; a project's
// config.json (openwolf.retention) can override any of them.
// ---------------------------------------------------------------------------
export interface Retention {
  token_ledger_max_sessions: number;
  session_io_max: number;
  buglog_max_entries: number;
  backups_keep: number;
  memory_consolidate_after_days: number;
  memory_max_bytes: number;
  daemon_log_max_bytes: number;
}

export const DEFAULT_RETENTION: Retention = {
  token_ledger_max_sessions: 200,
  session_io_max: 100,
  buglog_max_entries: 200,
  backups_keep: 10,
  memory_consolidate_after_days: 7,
  memory_max_bytes: 262144, // 256 KB
  daemon_log_max_bytes: 524288, // 512 KB
};

export function getRetention(wolfDir: string): Retention {
  const cfg = readJSON<{ openwolf?: { retention?: Partial<Retention> } }>(
    path.join(wolfDir, "config.json"),
    {}
  );
  return { ...DEFAULT_RETENTION, ...(cfg.openwolf?.retention ?? {}) };
}

// ---------------------------------------------------------------------------
// .wolfignore matcher (mirror of hooks/shared.ts — separate build roots).
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
      if (parts.includes(pat)) return true;
      if (pat.startsWith("*.") && norm.endsWith(pat.slice(1))) return true;
      if (norm.startsWith(pat + "/")) return true;
      if (pat.includes("*")) {
        const re = new RegExp(
          "^" +
            pat
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, " ")
              .replace(/\*/g, "[^/]*")
              .replace(/ /g, ".*") +
            "$"
        );
        if (re.test(norm) || re.test(base)) return true;
      }
    }
    return false;
  };
}

export function loadWolfignore(projectRoot: string): (relPath: string) => boolean {
  try {
    const content = fs.readFileSync(path.join(projectRoot, ".wolfignore"), "utf-8");
    return makeIgnoreMatcher(content.split("\n"));
  } catch {
    return () => false;
  }
}

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else total += fileSize(full);
  }
  return total;
}

export interface FootprintEntry {
  name: string;
  bytes: number;
  warn?: string;
}

// Per-item footprint of a .wolf directory plus soft-limit warnings.
export function footprint(wolfDir: string, ret: Retention): {
  total: number;
  items: FootprintEntry[];
  warnings: string[];
} {
  const items: FootprintEntry[] = [];
  const warnings: string[] = [];

  const push = (name: string, warn?: string) => {
    const full = path.join(wolfDir, name);
    const bytes = fs.existsSync(full)
      ? fs.statSync(full).isDirectory()
        ? dirSize(full)
        : fileSize(full)
      : 0;
    if (bytes > 0) items.push({ name, bytes, warn });
    if (warn && bytes > 0) warnings.push(`${name}: ${humanBytes(bytes)} — ${warn}`);
  };

  // Live files that can grow
  const ledgerBytes = fileSize(path.join(wolfDir, "token-ledger.json"));
  items.push({ name: "token-ledger.json", bytes: ledgerBytes });
  if (ledgerBytes > 3 * 1024 * 1024) {
    warnings.push(`token-ledger.json: ${humanBytes(ledgerBytes)} — run 'openwolf doctor' to compact`);
  }

  const memBytes = fileSize(path.join(wolfDir, "memory.md"));
  items.push({ name: "memory.md", bytes: memBytes });
  if (memBytes > ret.memory_max_bytes) {
    warnings.push(`memory.md: ${humanBytes(memBytes)} — exceeds ${humanBytes(ret.memory_max_bytes)}, consolidate with 'openwolf doctor'`);
  }

  const bugBytes = fileSize(path.join(wolfDir, "buglog.json"));
  items.push({ name: "buglog.json", bytes: bugBytes });

  for (const f of ["anatomy.md", "cerebrum.md", "cron-state.json"]) {
    const b = fileSize(path.join(wolfDir, f));
    if (b > 0) items.push({ name: f, bytes: b });
  }

  const logBytes = fileSize(path.join(wolfDir, "daemon.log"));
  if (logBytes > 0) {
    items.push({ name: "daemon.log", bytes: logBytes });
    if (logBytes > ret.daemon_log_max_bytes) {
      warnings.push(`daemon.log: ${humanBytes(logBytes)} — rotate with 'openwolf doctor'`);
    }
  }

  // Directories
  const backupsDir = path.join(wolfDir, "backups");
  if (fs.existsSync(backupsDir)) {
    const count = safeReaddir(backupsDir).length;
    const b = dirSize(backupsDir);
    items.push({ name: `backups/ (${count})`, bytes: b });
    if (count > ret.backups_keep) {
      warnings.push(`backups/: ${count} kept — prune to ${ret.backups_keep} with 'openwolf doctor'`);
    }
  }
  const capturesDir = path.join(wolfDir, "designqc-captures");
  if (fs.existsSync(capturesDir)) {
    items.push({ name: "designqc-captures/", bytes: dirSize(capturesDir) });
  }

  items.sort((a, b) => b.bytes - a.bytes);
  return { total: dirSize(wolfDir), items, warnings };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Compaction operations. Each returns bytes freed (before - after) and is a
// no-op / safe when nothing needs doing.
// ---------------------------------------------------------------------------
export interface CompactResult {
  changed: boolean;
  before: number;
  after: number;
  detail: string;
}

const noop = (name: string): CompactResult => ({ changed: false, before: 0, after: 0, detail: `${name}: nothing to do` });

export function compactLedger(wolfDir: string, ret: Retention): CompactResult {
  const p = path.join(wolfDir, "token-ledger.json");
  if (!fs.existsSync(p)) return noop("token-ledger");
  const before = fileSize(p);
  const ledger = readJSON<{ sessions?: Array<{ reads?: unknown[]; writes?: unknown[] }> }>(p, {});
  if (!Array.isArray(ledger.sessions)) return noop("token-ledger");

  let changed = false;
  for (const s of ledger.sessions) {
    if (Array.isArray(s.reads) && s.reads.length > ret.session_io_max) {
      s.reads = s.reads.slice(-ret.session_io_max);
      changed = true;
    }
    if (Array.isArray(s.writes) && s.writes.length > ret.session_io_max) {
      s.writes = s.writes.slice(-ret.session_io_max);
      changed = true;
    }
  }
  if (ledger.sessions.length > ret.token_ledger_max_sessions) {
    ledger.sessions = ledger.sessions.slice(-ret.token_ledger_max_sessions);
    changed = true;
  }
  if (!changed) return { changed: false, before, after: before, detail: `token-ledger: within limits (${before ? humanBytes(before) : "0"})` };
  writeJSON(p, ledger);
  const after = fileSize(p);
  return { changed: true, before, after, detail: `token-ledger: ${ledger.sessions.length} sessions kept, ${humanBytes(before)} → ${humanBytes(after)}` };
}

// Summarize sessions older than `olderThanDays` down to a single line each.
// Mirrors the daemon's consolidateMemory so it also runs without the daemon.
export function consolidateMemory(wolfDir: string, olderThanDays: number): CompactResult {
  const p = path.join(wolfDir, "memory.md");
  const content = readText(p);
  if (!content) return noop("memory");
  const before = Buffer.byteLength(content, "utf-8");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);

  const lines = content.split("\n");
  const out: string[] = [];
  let inOld = false;
  let oldLines: string[] = [];
  let consolidated = 0;

  const flush = () => {
    if (inOld && oldLines.length > 0) {
      // Already-consolidated blocks are kept verbatim → idempotent, preserves counts.
      if (oldLines.some((l) => l.startsWith("> Consolidated session"))) {
        for (const l of oldLines) out.push(l);
        return;
      }
      const actions = oldLines.filter((l) => l.startsWith("|") && !l.startsWith("|--") && !/^\|\s*Time/i.test(l)).length;
      out.push(`> Consolidated session (${actions} actions)`);
      out.push("");
      consolidated++;
    }
  };

  for (const line of lines) {
    const m = line.match(/^## Session: (\d{4}-\d{2}-\d{2})/);
    if (m) {
      flush();
      const d = new Date(m[1]);
      inOld = d < cutoff;
      oldLines = [];
      out.push(line);
      continue;
    }
    if (inOld) oldLines.push(line);
    else out.push(line);
  }
  flush();

  const result = out.join("\n");
  const after = Buffer.byteLength(result, "utf-8");
  if (after >= before || consolidated === 0) return { changed: false, before, after: before, detail: `memory.md: no sessions older than ${olderThanDays}d` };
  writeText(p, result);
  return { changed: true, before, after, detail: `memory.md: ${consolidated} old sessions consolidated, ${humanBytes(before)} → ${humanBytes(after)}` };
}

interface Bug {
  id: string;
  file: string;
  tags: string[];
  occurrences?: number;
  last_seen?: string;
  [k: string]: unknown;
}

// Merge auto-detected duplicates (same basename + same category) and cap the total.
export function dedupeAndCapBuglog(wolfDir: string, max: number): CompactResult {
  const p = path.join(wolfDir, "buglog.json");
  if (!fs.existsSync(p)) return noop("buglog");
  const before = fileSize(p);
  // Tolerate legacy bare-array buglogs ([...]) as well as {version, bugs:[]}.
  const raw = readJSON<unknown>(p, { version: 1, bugs: [] as Bug[] });
  const wasArray = Array.isArray(raw);
  const log: { version?: number; bugs?: Bug[] } = wasArray
    ? { version: 1, bugs: raw as Bug[] }
    : (raw as { version?: number; bugs?: Bug[] });
  const bugs = Array.isArray(log.bugs) ? log.bugs : [];
  const startCount = bugs.length;

  const key = (b: Bug) => `${path.basename(b.file || "")}::${(b.tags || []).filter((t) => t !== "auto-detected").sort().join(",")}`;
  const merged = new Map<string, Bug>();
  const manual: Bug[] = [];
  for (const b of bugs) {
    // Only fold auto-detected entries; keep manual bugs untouched and un-deduped.
    if (!(b.tags || []).includes("auto-detected")) {
      manual.push(b);
      continue;
    }
    const k = key(b);
    const prev = merged.get(k);
    if (prev) {
      prev.occurrences = (prev.occurrences ?? 1) + (b.occurrences ?? 1);
      if (b.last_seen && (!prev.last_seen || b.last_seen > prev.last_seen)) prev.last_seen = b.last_seen;
    } else {
      merged.set(k, { ...b });
    }
  }
  let result = [...manual, ...merged.values()];
  if (result.length > max) result = result.slice(-max);

  // No change AND already in the canonical object form → nothing to do.
  if (result.length === startCount && !wasArray) {
    return { changed: false, before, after: before, detail: `buglog: ${startCount} entries, within limits` };
  }
  writeJSON(p, { version: log.version ?? 1, bugs: result });
  const after = fileSize(p);
  const note = wasArray ? " (migrated legacy array → {version,bugs})" : "";
  return { changed: true, before, after, detail: `buglog: ${startCount} → ${result.length} entries${note}, ${humanBytes(before)} → ${humanBytes(after)}` };
}

export function pruneBackups(wolfDir: string, keep: number): CompactResult {
  const dir = path.join(wolfDir, "backups");
  if (!fs.existsSync(dir)) return noop("backups");
  const before = dirSize(dir);
  const entries = safeReaddir(dir)
    .map((n) => ({ name: n, full: path.join(dir, n) }))
    .filter((e) => {
      try {
        return fs.statSync(e.full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name)); // stamped names sort chronologically

  if (entries.length <= keep) return { changed: false, before, after: before, detail: `backups: ${entries.length} kept, within limit (${keep})` };
  const toRemove = entries.slice(0, entries.length - keep);
  for (const e of toRemove) {
    try {
      fs.rmSync(e.full, { recursive: true, force: true });
    } catch {}
  }
  const after = dirSize(dir);
  return { changed: true, before, after, detail: `backups: removed ${toRemove.length}, kept ${keep} (${humanBytes(before)} → ${humanBytes(after)})` };
}

export function cleanTmp(wolfDir: string): CompactResult {
  let removed = 0;
  let freed = 0;
  const walk = (dir: string) => {
    for (const n of safeReaddir(dir)) {
      const full = path.join(dir, n);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (n !== "backups") walk(full);
      } else if (n.endsWith(".tmp")) {
        freed += st.size;
        try {
          fs.unlinkSync(full);
          removed++;
        } catch {}
      }
    }
  };
  walk(wolfDir);
  if (removed === 0) return noop("tmp files");
  return { changed: true, before: freed, after: 0, detail: `tmp: removed ${removed} stale .tmp file(s) (${humanBytes(freed)})` };
}

export function rotateDaemonLog(wolfDir: string, maxBytes: number): CompactResult {
  const p = path.join(wolfDir, "daemon.log");
  if (!fs.existsSync(p)) return noop("daemon.log");
  const before = fileSize(p);
  if (before <= maxBytes) return { changed: false, before, after: before, detail: `daemon.log: ${humanBytes(before)}, within limit` };
  // Keep the tail (most recent half of the limit).
  try {
    const content = readText(p);
    const keep = content.slice(-Math.floor(maxBytes / 2));
    const trimmed = keep.slice(keep.indexOf("\n") + 1); // start at a clean line boundary
    writeText(p, `> [rotated by openwolf doctor]\n${trimmed}`);
  } catch {
    return noop("daemon.log");
  }
  const after = fileSize(p);
  return { changed: true, before, after, detail: `daemon.log: rotated ${humanBytes(before)} → ${humanBytes(after)}` };
}
