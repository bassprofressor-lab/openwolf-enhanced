import * as fs from "node:fs";
import * as path from "node:path";
import { getWolfDir, ensureWolfDir, readJSON, writeJSON, appendMarkdown, timeShort, getRetention, compactMemoryIfLarge, countSemanticEntries, withLock, tryWithLock, updateSession, sessionFileFor, readStdin, readTranscriptUsage, detectAgent, type RealUsage, bookInjection } from "./shared.js";
import { estimateTokens, getTokenRatios } from "./token-estimator.js";

interface FileRead {
  count: number;
  tokens: number;
  first_read: string;
  anatomy_had_description?: boolean;
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
  /** Writes outside the project root — counted, never named. A session working in an additional
   *  working directory produces these and nothing else. */
  external_writes?: number;
  /** Writes made through the shell (heredoc, `>`, sed -i, cp) — counted, never named. post-write
   *  never sees these: it only matches Write|Edit|MultiEdit. [bug-149] */
  bash_writes?: number;
  /**
   * What this session has ALREADY contributed to ledger.lifetime.
   *
   * Stop fires once per TURN, not once per session — that is what stop_count counts. But
   * files_read/files_written/anatomy_hits are cumulative for the whole session, so adding them to
   * lifetime on every stop books the same work again and again: over N turns the ledger counts
   * 1+2+3+…+N instead of N. Measured in this project before the fix: 200 session entries for 13
   * sessions, total_writes 187090, estimated_savings_vs_bare_cli 898967826 — the number the tool
   * advertises its own value with. [bug-210]
   *
   * Absent on a fresh session (session-start writes the object without it) → everything counts as
   * new, which is correct. Present across compact/resume, where the session file survives on
   * purpose — which is also correct, because those turns are the same session.
   */
  booked?: Booked;
}

/** Cumulative amounts already added to lifetime for the current session. */
interface Booked {
  reads: number;
  writes: number;
  tokens: number;
  anatomy_hits: number;
  anatomy_misses: number;
  repeated_reads_blocked: number;
  savings: number;
  real_input: number;
  real_output: number;
  real_cache_read: number;
  real_cache_creation: number;
  real_api_calls: number;
}

const NOTHING_BOOKED: Booked = {
  reads: 0, writes: 0, tokens: 0, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_blocked: 0,
  savings: 0, real_input: 0, real_output: 0, real_cache_read: 0, real_cache_creation: 0, real_api_calls: 0,
};

/**
 * Only what is new since the last stop goes into lifetime.
 *
 * Clamped at zero: if the cumulative value ever goes DOWN (session file reset while `booked`
 * survived, retention trimming a counter), the honest answer is "nothing new", never a negative
 * correction — that would silently eat other sessions' numbers.
 */
const delta = (current: number, booked: number): number => Math.max(0, current - booked);

interface SessionEntry {
  id: string;
  agent?: string;
  started: string;
  ended: string;
  real_usage?: RealUsage;
  reads: Array<{
    file: string;
    tokens_estimated: number;
    read_count: number;
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
    /** Shell / outside-project writes — counted in lifetime.total_writes, never named. */
    unnamed_writes?: number;
  };
}

async function main(): Promise<void> {
  ensureWolfDir();
  const wolfDir = getWolfDir();
  const hooksDir = path.join(wolfDir, "hooks");

  // Stop payload carries the harness transcript path — the source of real, measured token usage.
  let hookInput: { transcript_path?: string; session_id?: string } = {};
  try {
    hookInput = JSON.parse(await readStdin());
  } catch {}
  // Must be resolved from the payload, like every other hook — this hook is what folds the
  // session into the ledger, so reading a different session's file here would attribute one
  // session's whole turn to another.
  const sessionFile = sessionFileFor(hooksDir, hookInput.session_id);

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
  // Writes with no path attached: another working directory (#56) or the shell (no path is parsed).
  // Kept SEPARATE from writeCount — the ledger and the memory.md line name the files they counted,
  // and these have no names by design.
  const externalWrites = session.external_writes ?? 0;
  const bashWrites = session.bash_writes ?? 0;
  const unnamedWrites = externalWrites + bashWrites;
  const totalWrites = writeCount + unnamedWrites;

  if (readCount === 0 && totalWrites === 0) {
    // Only stop_count moved; apply it as a delta so an idle turn cannot overwrite a sibling
    // hook's concurrent update with this hook's stale snapshot.
    updateSession<SessionData>(sessionFile, session, (s) => {
      s.stop_count = Math.max(s.stop_count ?? 0, session.stop_count);
    });
    process.exit(0);
    return;
  }

  // Collect end-of-turn reminders. These are surfaced via additionalContext (stdout) at the
  // very end so they land in Claude's next context window — stderr would only hit the terminal.
  // Each reminder type fires at most once per session so it doesn't re-nag every turn.
  const candidates = [
    { key: "buglog", msg: checkForMissingBugLogs(wolfDir, session) },
    { key: "cerebrum", msg: checkCerebrumFreshness(wolfDir, session) },
    { key: "summary", msg: checkSemanticSummaries(wolfDir, totalWrites) },
    { key: "status", msg: checkStatusFreshness(wolfDir, session) },
  ].filter((c): c is { key: string; msg: string } => c.msg !== null);
  const alreadyShown = new Set(session.reminders_shown ?? []);
  const fresh = candidates.filter((c) => !alreadyShown.has(c.key));
  for (const c of fresh) alreadyShown.add(c.key);
  session.reminders_shown = [...alreadyShown];
  const reminders = fresh.map((c) => c.msg);

  // Build session entry for ledger
  // One entry per unique file — read_count carries the repetition, since the waste detector
  // cannot recover it by counting array entries (it used to try, and never found any).
  const reads = Object.entries(session.files_read).map(([file, data]) => ({
    file,
    tokens_estimated: data.tokens,
    read_count: data.count,
    was_repeated: data.count > 1,
    anatomy_had_description: data.anatomy_had_description ?? false,
  }));

  const writes = session.files_written.map((w) => ({
    file: w.file,
    tokens_estimated: w.tokens,
    action: w.action,
  }));

  const inputTokens = reads.reduce((sum, r) => sum + r.tokens_estimated, 0);
  const outputTokens = writes.reduce((sum, w) => sum + w.tokens_estimated, 0);

  // Measure real API usage from the transcript when the harness provides a path (F1). Done outside
  // the ledger lock — it's a plain file read; only the accumulation below runs under the lock.
  const realUsage = hookInput.transcript_path ? readTranscriptUsage(hookInput.transcript_path) : null;

  const sessionEntry: SessionEntry = {
    id: session.session_id,
    agent: detectAgent(),
    started: session.started,
    ended: new Date().toISOString(),
    ...(realUsage ? { real_usage: realUsage } : {}),
    reads,
    writes,
    totals: {
      input_tokens_estimated: inputTokens,
      output_tokens_estimated: outputTokens,
      reads_count: readCount,
      writes_count: writeCount,
      repeated_reads_blocked: session.repeated_reads_warned,
      anatomy_lookups: session.anatomy_hits,
      ...(unnamedWrites > 0 ? { unnamed_writes: unnamedWrites } : {}),
    },
  };

  // Update token-ledger.json — lock the read-modify-write so concurrent sessions and the cron
  // token report don't clobber each other (M1).
  const ret = getRetention(wolfDir);
  const ledgerPath = path.join(wolfDir, "token-ledger.json");
  // A contended ledger write is skipped, not forced: this hook's numbers are cumulative and the
  // next Stop re-books the same deltas, so one skipped turn costs nothing. Forcing it would
  // overwrite whichever process is inside the critical section right now.
  tryWithLock(ledgerPath, () => {
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
  if (Array.isArray(sessionEntry.reads) && sessionEntry.reads.length > ret.session_io_max) {
    sessionEntry.reads = sessionEntry.reads.slice(-ret.session_io_max);
  }
  if (Array.isArray(sessionEntry.writes) && sessionEntry.writes.length > ret.session_io_max) {
    sessionEntry.writes = sessionEntry.writes.slice(-ret.session_io_max);
  }
  // One entry per session, not per turn: the entry carries the session's cumulative state, so a
  // later stop REPLACES the earlier one instead of appending a near-duplicate under the same id.
  const existing = ledger.sessions.findIndex((s) => s.id === sessionEntry.id);
  if (existing === -1) ledger.sessions.push(sessionEntry);
  else ledger.sessions[existing] = sessionEntry;
  if (ledger.sessions.length > ret.token_ledger_max_sessions) {
    ledger.sessions = ledger.sessions.slice(-ret.token_ledger_max_sessions);
  }

  // Everything below books DELTAS. The values on `session` are cumulative for the whole session and
  // this hook runs every turn — see the `booked` doc comment. [bug-210]
  const booked = { ...NOTHING_BOOKED, ...(session.booked ?? {}) };
  const totalWritesNow = writeCount + unnamedWrites;
  const tokensNow = inputTokens + outputTokens;

  // Estimate savings: anatomy hits save ~200 tokens each, repeated reads blocked save their token count
  const savedFromAnatomy = session.anatomy_hits * 200;
  const savedFromRepeats = Object.values(session.files_read)
    .filter((r) => r.count > 1)
    .reduce((sum, r) => sum + r.tokens * (r.count - 1), 0);
  const savingsNow = savedFromAnatomy + savedFromRepeats;

  ledger.lifetime.total_reads += delta(readCount, booked.reads);
  // Unnamed writes (shell / other working dirs) count toward the lifetime total — they were real
  // work. They stay OUT of the session's named writes[] list (no path was recorded, by design).
  ledger.lifetime.total_writes += delta(totalWritesNow, booked.writes);
  ledger.lifetime.total_tokens_estimated += delta(tokensNow, booked.tokens);
  ledger.lifetime.anatomy_hits += delta(session.anatomy_hits, booked.anatomy_hits);
  ledger.lifetime.anatomy_misses += delta(session.anatomy_misses, booked.anatomy_misses);
  ledger.lifetime.repeated_reads_blocked += delta(session.repeated_reads_warned, booked.repeated_reads_blocked);
  ledger.lifetime.estimated_savings_vs_bare_cli += delta(savingsNow, booked.savings);

  // Accumulate measured usage alongside the estimates, so the ledger carries both a heuristic and
  // a verifiable ground truth (F1). readTranscriptUsage reads the WHOLE transcript, so these are
  // cumulative per session too and need the same delta treatment.
  if (realUsage) {
    const lt = ledger.lifetime;
    lt.real_input_tokens = (lt.real_input_tokens ?? 0) + delta(realUsage.input_tokens, booked.real_input);
    lt.real_output_tokens = (lt.real_output_tokens ?? 0) + delta(realUsage.output_tokens, booked.real_output);
    lt.real_cache_read_tokens = (lt.real_cache_read_tokens ?? 0) + delta(realUsage.cache_read_input_tokens, booked.real_cache_read);
    lt.real_cache_creation_tokens = (lt.real_cache_creation_tokens ?? 0) + delta(realUsage.cache_creation_input_tokens, booked.real_cache_creation);
    lt.real_api_calls = (lt.real_api_calls ?? 0) + delta(realUsage.api_calls, booked.real_api_calls);
  }

  // Mark what is now booked.
  //
  // [fix] Setting this field inside the lock was never the point — PERSISTING it was. The write to
  // _session.json used to sit ~30 lines further down, past two memory.md appends and a memory
  // compaction, outside this lock. Anything that ended the process in that window (a hook timeout,
  // the user quitting, a full disk during compactMemoryIfLarge) left the ledger credited and the
  // session file still carrying the OLD booked values, so the next Stop re-booked every delta on
  // top. The comment claimed that could not happen. It is now written under the same lock, one
  // statement after the ledger, which is what the comment always described.
  session.booked = {
    reads: Math.max(readCount, booked.reads),
    writes: Math.max(totalWritesNow, booked.writes),
    tokens: Math.max(tokensNow, booked.tokens),
    anatomy_hits: Math.max(session.anatomy_hits, booked.anatomy_hits),
    anatomy_misses: Math.max(session.anatomy_misses, booked.anatomy_misses),
    repeated_reads_blocked: Math.max(session.repeated_reads_warned, booked.repeated_reads_blocked),
    savings: Math.max(savingsNow, booked.savings),
    real_input: Math.max(realUsage?.input_tokens ?? 0, booked.real_input),
    real_output: Math.max(realUsage?.output_tokens ?? 0, booked.real_output),
    real_cache_read: Math.max(realUsage?.cache_read_input_tokens ?? 0, booked.real_cache_read),
    real_cache_creation: Math.max(realUsage?.cache_creation_input_tokens ?? 0, booked.real_cache_creation),
    real_api_calls: Math.max(realUsage?.api_calls ?? 0, booked.real_api_calls),
  };

  writeJSON(ledgerPath, ledger);

  // Persist the session's own bookkeeping here, still holding the ledger lock. The deltas are
  // re-applied to whatever is on disk right now, so a PostToolUse hook that wrote between this
  // hook's initial read and this line does not lose its update.
  const bookedNow = session.booked;
  const remindersNow = session.reminders_shown;
  updateSession<SessionData>(sessionFile, session, (s) => {
    s.booked = bookedNow;
    s.reminders_shown = remindersNow;
    s.stop_count = Math.max(s.stop_count ?? 0, session.stop_count);
  });
  });

  // Write a session summary line to memory.md if there was meaningful activity
  const memoryPath = path.join(wolfDir, "memory.md");

  // A session that wrote only through the shell, or only in another directory, still happened.
  // Without this, memory.md shows a gap exactly where the work was — which is how someone later
  // concludes the day was quiet.
  if (writeCount === 0 && unnamedWrites > 0) {
    try {
      const via = [
        externalWrites > 0 ? `${externalWrites} outside this project root` : "",
        bashWrites > 0 ? `${bashWrites} through the shell` : "",
      ].filter(Boolean).join(", ");
      appendMarkdown(memoryPath, `| ${timeShort()} | Session end: ${unnamedWrites} untracked writes (${via}) | ${readCount} reads | ~${inputTokens + outputTokens} tok |\n`);
    } catch { /* memory.md is a nicety, not a dependency */ }
  }

  if (writeCount > 0) {
    try {
      const uniqueFiles = new Set(session.files_written.map(w => path.basename(w.file)));
      const fileList = [...uniqueFiles].slice(0, 5).join(", ");
      appendMarkdown(memoryPath, `| ${timeShort()} | Session end: ${writeCount} writes across ${uniqueFiles.size} files (${fileList}) | ${readCount} reads | ~${inputTokens + outputTokens} tok |\n`);
    } catch {}
  }

  // Opportunistic self-maintenance: keep memory.md bounded even when the daemon
  // (which normally runs the consolidation cron) isn't running. Stat-gated → cheap.
  try { compactMemoryIfLarge(wolfDir, ret.memory_max_bytes); } catch {}

  // Surface reminders into Claude's next context window (Stop hooks can inject via stdout JSON).
  if (reminders.length > 0) {
    const additionalContext = `⚠️ OpenWolf end-of-turn reminders:\n${reminders.map((r) => `• ${r}`).join("\n")}`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext } }));
    // The reminder block is context the model pays for in the next window — book it. This runs
    // after the ledger write above, hence its own short lock rather than restructuring that block.
    bookInjection(wolfDir, estimateTokens(additionalContext, "prose", getTokenRatios(wolfDir)));
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
  // Work done in an additional working directory, or through the shell, counts too. Either can be
  // the only thing a session does, and a reminder that stays silent through eleven slices of it is
  // worse than no reminder at all: it looks like the handoff doc is fine.
  const external = session.external_writes ?? 0;
  const bash = session.bash_writes ?? 0;
  const writes = codeWrites.length + external + bash;
  if (writes < 3) return null;

  try {
    const stat = fs.statSync(statusPath);
    const sessionStartMs = session.started ? Date.parse(session.started) : 0;
    if (sessionStartMs && stat.mtimeMs < sessionStartMs) {
      const where = codeWrites.length > 0 ? "" :
        external > 0 && bash > 0 ? " (all of them outside this project root or through the shell)" :
        external > 0 ? " (all of them outside this project root)" :
        " (all of them through the shell)";
      return `STATUS.md wasn't updated this session despite ${writes} code writes${where}. Update .wolf/STATUS.md (✅ done / 🚀 next quest) before /clear so the next session resumes in one read.`;
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
