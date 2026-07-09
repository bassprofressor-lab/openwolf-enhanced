import * as fs from "node:fs";
import * as path from "node:path";
import { getWolfDir, ensureWolfDir, readJSON, writeJSON, appendMarkdown, timeShort, getRetention, compactMemoryIfLarge, countSemanticEntries } from "./shared.js";

interface FileRead {
  count: number;
  tokens: number;
  first_read: string;
}

interface FileWrite {
  file: string;
  action: string;
  tokens: number;
  at: string;
}

interface SessionData {
  session_id: string;
  started: string;
  files_read: Record<string, FileRead>;
  files_written: FileWrite[];
  edit_counts: Record<string, number>;
  anatomy_hits: number;
  anatomy_misses: number;
  repeated_reads_warned: number;
  cerebrum_warnings: number;
  stop_count: number;
  reminders_shown?: string[];
}

interface SessionEntry {
  id: string;
  started: string;
  ended: string;
  reads: Array<{
    file: string;
    tokens_estimated: number;
    was_repeated: boolean;
    anatomy_had_description: boolean;
  }>;
  writes: Array<{ file: string; tokens_estimated: number; action: string }>;
  totals: {
    input_tokens_estimated: number;
    output_tokens_estimated: number;
    reads_count: number;
    writes_count: number;
    repeated_reads_blocked: number;
    anatomy_lookups: number;
  };
}

async function main(): Promise<void> {
  ensureWolfDir();
  const wolfDir = getWolfDir();
  const hooksDir = path.join(wolfDir, "hooks");
  const sessionFile = path.join(hooksDir, "_session.json");

  const session = readJSON<SessionData>(sessionFile, {
    session_id: "",
    started: "",
    files_read: {},
    files_written: [],
    edit_counts: {},
    anatomy_hits: 0,
    anatomy_misses: 0,
    repeated_reads_warned: 0,
    cerebrum_warnings: 0,
    stop_count: 0,
  });

  session.stop_count++;

  // Only write to ledger if there's been activity
  const readCount = Object.keys(session.files_read).length;
  const writeCount = session.files_written.length;

  if (readCount === 0 && writeCount === 0) {
    writeJSON(sessionFile, session);
    process.exit(0);
    return;
  }

  // Collect end-of-turn reminders. These are surfaced via additionalContext (stdout) at the
  // very end so they land in Claude's next context window — stderr would only hit the terminal.
  // Each reminder type fires at most once per session so it doesn't re-nag every turn.
  const candidates = [
    { key: "buglog", msg: checkForMissingBugLogs(wolfDir, session) },
    { key: "cerebrum", msg: checkCerebrumFreshness(wolfDir, session) },
    { key: "summary", msg: checkSemanticSummaries(wolfDir, writeCount) },
    { key: "status", msg: checkStatusFreshness(wolfDir, session) },
  ].filter((c): c is { key: string; msg: string } => c.msg !== null);
  const alreadyShown = new Set(session.reminders_shown ?? []);
  const fresh = candidates.filter((c) => !alreadyShown.has(c.key));
  for (const c of fresh) alreadyShown.add(c.key);
  session.reminders_shown = [...alreadyShown];
  const reminders = fresh.map((c) => c.msg);

  // Build session entry for ledger
  const reads = Object.entries(session.files_read).map(([file, data]) => ({
    file,
    tokens_estimated: data.tokens,
    was_repeated: data.count > 1,
    anatomy_had_description: false, // simplified
  }));

  const writes = session.files_written.map((w) => ({
    file: w.file,
    tokens_estimated: w.tokens,
    action: w.action,
  }));

  const inputTokens = reads.reduce((sum, r) => sum + r.tokens_estimated, 0);
  const outputTokens = writes.reduce((sum, w) => sum + w.tokens_estimated, 0);

  const sessionEntry: SessionEntry = {
    id: session.session_id,
    started: session.started,
    ended: new Date().toISOString(),
    reads,
    writes,
    totals: {
      input_tokens_estimated: inputTokens,
      output_tokens_estimated: outputTokens,
      reads_count: readCount,
      writes_count: writeCount,
      repeated_reads_blocked: session.repeated_reads_warned,
      anatomy_lookups: session.anatomy_hits,
    },
  };

  // Update token-ledger.json
  const ledgerPath = path.join(wolfDir, "token-ledger.json");
  const ledger = readJSON(ledgerPath, {
    version: 1,
    created_at: "",
    lifetime: {
      total_tokens_estimated: 0,
      total_reads: 0,
      total_writes: 0,
      total_sessions: 0,
      anatomy_hits: 0,
      anatomy_misses: 0,
      repeated_reads_blocked: 0,
      estimated_savings_vs_bare_cli: 0,
    },
    sessions: [] as SessionEntry[],
    daemon_usage: [],
    waste_flags: [],
    optimization_report: { last_generated: null, patterns: [] },
  }) as {
    version: number;
    lifetime: Record<string, number>;
    sessions: SessionEntry[];
    [key: string]: unknown;
  };

  // Keep token-ledger.json bounded: cap per-session arrays and total session count.
  // Without this, sessions[] (each embedding full reads[]/writes[]) grows without limit
  // and writeJSON's full-file rewrite becomes quadratic over time. Limits are tunable
  // via config.json openwolf.retention.
  const ret = getRetention(wolfDir);
  if (Array.isArray(sessionEntry.reads) && sessionEntry.reads.length > ret.session_io_max) {
    sessionEntry.reads = sessionEntry.reads.slice(-ret.session_io_max);
  }
  if (Array.isArray(sessionEntry.writes) && sessionEntry.writes.length > ret.session_io_max) {
    sessionEntry.writes = sessionEntry.writes.slice(-ret.session_io_max);
  }
  ledger.sessions.push(sessionEntry);
  if (ledger.sessions.length > ret.token_ledger_max_sessions) {
    ledger.sessions = ledger.sessions.slice(-ret.token_ledger_max_sessions);
  }
  ledger.lifetime.total_reads += readCount;
  ledger.lifetime.total_writes += writeCount;
  ledger.lifetime.total_tokens_estimated += inputTokens + outputTokens;
  ledger.lifetime.anatomy_hits += session.anatomy_hits;
  ledger.lifetime.anatomy_misses += session.anatomy_misses;
  ledger.lifetime.repeated_reads_blocked += session.repeated_reads_warned;

  // Estimate savings: anatomy hits save ~200 tokens each, repeated reads blocked save their token count
  const savedFromAnatomy = session.anatomy_hits * 200;
  const savedFromRepeats = Object.values(session.files_read)
    .filter((r) => r.count > 1)
    .reduce((sum, r) => sum + r.tokens * (r.count - 1), 0);
  ledger.lifetime.estimated_savings_vs_bare_cli += savedFromAnatomy + savedFromRepeats;

  writeJSON(ledgerPath, ledger);

  // Write a session summary line to memory.md if there was meaningful activity
  if (writeCount > 0) {
    try {
      const uniqueFiles = new Set(session.files_written.map(w => path.basename(w.file)));
      const fileList = [...uniqueFiles].slice(0, 5).join(", ");
      const memoryPath = path.join(wolfDir, "memory.md");
      appendMarkdown(memoryPath, `| ${timeShort()} | Session end: ${writeCount} writes across ${uniqueFiles.size} files (${fileList}) | ${readCount} reads | ~${inputTokens + outputTokens} tok |\n`);
    } catch {}
  }

  // Opportunistic self-maintenance: keep memory.md bounded even when the daemon
  // (which normally runs the consolidation cron) isn't running. Stat-gated → cheap.
  try { compactMemoryIfLarge(wolfDir, ret.memory_max_bytes); } catch {}

  writeJSON(sessionFile, session);

  // Surface reminders into Claude's next context window (Stop hooks can inject via stdout JSON).
  if (reminders.length > 0) {
    const additionalContext = `⚠️ OpenWolf end-of-turn reminders:\n${reminders.map((r) => `• ${r}`).join("\n")}`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext } }));
  }

  process.exit(0);
}

/**
 * Check if files were edited multiple times but buglog.json wasn't updated.
 * Emit a stderr reminder so Claude sees it in the next turn.
 */
function checkForMissingBugLogs(wolfDir: string, session: SessionData): string | null {
  if (!session.edit_counts) return null;

  const multiEditFiles = Object.entries(session.edit_counts)
    .filter(([, count]) => count >= 3)
    .map(([file]) => path.basename(file));

  if (multiEditFiles.length === 0) return null;

  // Check if buglog was written to this session
  const buglogWritten = session.files_written.some(w =>
    w.file.includes("buglog.json")
  );

  if (!buglogWritten) {
    return `Files edited 3+ times this session (${multiEditFiles.join(", ")}) but buglog.json was not updated. If you fixed bugs, log them to .wolf/buglog.json.`;
  }
  return null;
}

/**
 * Check if cerebrum.md was updated recently. If it hasn't been updated in
 * a while and there was significant activity, return a gentle reminder.
 */
function checkCerebrumFreshness(wolfDir: string, session: SessionData): string | null {
  const cerebrumPath = path.join(wolfDir, "cerebrum.md");
  try {
    const stat = fs.statSync(cerebrumPath);
    const hoursSinceUpdate = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);

    // If cerebrum hasn't been updated in 24h+ and there were significant writes
    if (hoursSinceUpdate > 24 && session.files_written.length >= 3) {
      return `cerebrum.md hasn't been updated in ${Math.floor(hoursSinceUpdate)}h. Did you learn any user preferences, conventions, or gotchas this session? Consider updating .wolf/cerebrum.md.`;
    }
  } catch {
    // cerebrum.md doesn't exist, that's ok
  }
  return null;
}

/**
 * If STATUS.md is older than the session start (or missing) and there was meaningful code
 * activity, nudge Claude to update the handoff doc so the next /clear resumes cheaply. (upstream #40)
 */
function checkStatusFreshness(wolfDir: string, session: SessionData): string | null {
  const statusPath = path.join(wolfDir, "STATUS.md");
  const codeWrites = session.files_written.filter(
    (w) => !w.file.includes("/.wolf/") && !w.file.endsWith(".tmp")
  );
  if (codeWrites.length < 3) return null;

  try {
    const stat = fs.statSync(statusPath);
    const sessionStartMs = session.started ? Date.parse(session.started) : 0;
    if (sessionStartMs && stat.mtimeMs < sessionStartMs) {
      return `STATUS.md wasn't updated this session despite ${codeWrites.length} code writes. Update .wolf/STATUS.md (✅ done / 🚀 next quest) before /clear so the next session resumes in one read.`;
    }
  } catch {
    return `.wolf/STATUS.md is missing. Create it with the current quest summary + next steps so /clear stays cheap.`;
  }
  return null;
}

/**
 * If there were meaningful edits this session but no non-mechanical memory.md summary
 * was written, nudge Claude to record what it did. (upstream #55)
 */
function checkSemanticSummaries(wolfDir: string, writeCount: number): string | null {
  if (writeCount < 3) return null;
  if (countSemanticEntries(wolfDir) > 0) return null;
  return `${writeCount} files were changed this session but no meaningful summary was written to memory.md. Consider recording what you did and why.`;
}

main().catch(() => process.exit(0));
