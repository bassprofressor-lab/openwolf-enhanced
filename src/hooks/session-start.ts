import * as fs from "node:fs";
import * as path from "node:path";
import { getWolfDir, ensureWolfDir, writeJSON, appendMarkdown, readJSON, timestamp, timeShort, buildResumeDigest, readStdin, SESSION_SUMMARY_SCAFFOLD } from "./shared.js";

async function main(): Promise<void> {
  ensureWolfDir();
  const wolfDir = getWolfDir();

  // Clean up stale .tmp files left from failed atomic writes
  try {
    const files = fs.readdirSync(wolfDir);
    for (const f of files) {
      if (f.endsWith(".tmp")) {
        try { fs.unlinkSync(path.join(wolfDir, f)); } catch {}
      }
    }
  } catch {}
  const hooksDir = path.join(wolfDir, "hooks");
  const sessionFile = path.join(hooksDir, "_session.json");
  const now = new Date();
  const sessionId = `session-${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

  // SessionStart fires for startup/resume/clear/compact. Only startup and clear begin a genuinely
  // new session — on resume/compact the session is still live, and resetting _session.json here
  // would wipe this session's read/write tracking mid-flight and append a spurious memory header
  // on every compaction (compaction survival).
  let source = "startup";
  try {
    const hookInput = JSON.parse(await readStdin()) as { source?: unknown };
    if (typeof hookInput.source === "string") source = hookInput.source;
  } catch {}
  const continuing = (source === "compact" || source === "resume") && fs.existsSync(sessionFile);

  if (!continuing) {
    // Create fresh session state
    writeJSON(sessionFile, {
      session_id: sessionId,
      started: timestamp(),
      files_read: {},
      files_written: [],
      edit_counts: {},
      anatomy_hits: 0,
      anatomy_misses: 0,
      repeated_reads_warned: 0,
      cerebrum_warnings: 0,
      stop_count: 0,
    });

    // Append session header to memory.md
    const memoryPath = path.join(wolfDir, "memory.md");
    const header = `\n## Session: ${now.toISOString().slice(0, 10)} ${timeShort()}\n\n${SESSION_SUMMARY_SCAFFOLD}\n\n| Time | Action | File(s) | Outcome | ~Tokens |\n|------|--------|---------|---------|--------|\n`;
    appendMarkdown(memoryPath, header);
  }

  // Check cerebrum freshness — remind Claude to learn
  try {
    const cerebrumPath = path.join(wolfDir, "cerebrum.md");
    const cerebrumContent = fs.readFileSync(cerebrumPath, "utf-8");
    const stat = fs.statSync(cerebrumPath);
    const daysSinceUpdate = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);

    // Count actual entries (non-comment, non-empty lines in content sections)
    const entryLines = cerebrumContent.split("\n").filter(l => {
      const t = l.trim();
      return t.startsWith("- ") || t.startsWith("* ") || (t.startsWith("[") && t.includes("]"));
    });

    if (entryLines.length < 3) {
      process.stderr.write(
        `💡 OpenWolf: cerebrum.md has only ${entryLines.length} entries. Learn from this session — record user preferences, project conventions, and mistakes to .wolf/cerebrum.md.\n`
      );
    } else if (daysSinceUpdate > 3) {
      process.stderr.write(
        `💡 OpenWolf: cerebrum.md hasn't been updated in ${Math.floor(daysSinceUpdate)} days. Look for opportunities to add learnings this session.\n`
      );
    }
  } catch {}

  // Check buglog — remind if empty
  try {
    const buglogPath = path.join(wolfDir, "buglog.json");
    const buglog = readJSON<{ bugs: unknown[] }>(buglogPath, { bugs: [] });
    if (buglog.bugs.length === 0) {
      process.stderr.write(
        `📋 OpenWolf: buglog.json is empty. If you encounter or fix any bugs, errors, or failed tests this session, log them to .wolf/buglog.json.\n`
      );
    }
  } catch {}

  // Increment total_sessions in token-ledger — only for a genuinely new session, not a
  // resume/compact continuation (which would double-count the same session).
  if (!continuing) {
    const ledgerPath = path.join(wolfDir, "token-ledger.json");
    const ledger = readJSON(ledgerPath, { version: 1, lifetime: { total_sessions: 0 } }) as {
      version: number;
      lifetime: { total_sessions: number };
      [key: string]: unknown;
    };
    ledger.lifetime.total_sessions++;
    writeJSON(ledgerPath, ledger);
  }

  // Inject a compact resume digest as additionalContext so the model continues without
  // re-reading STATUS.md/cerebrum/memory. Bounded and config-gated. stdout is reserved
  // for this JSON — reminders above go to stderr, so they don't collide.
  try {
    const config = readJSON<{ openwolf?: { session_context?: { enabled?: boolean; max_chars?: number } } }>(
      path.join(wolfDir, "config.json"),
      {}
    );
    const sc = config.openwolf?.session_context ?? {};
    if (sc.enabled !== false) {
      let digest = buildResumeDigest(wolfDir, sc.max_chars ?? 6000);

      // Post-compaction restore: compaction wipes the live context, so resurface the in-flight
      // session state (which files were already touched) that the digest above doesn't cover.
      if (continuing && source === "compact") {
        const session = readJSON<{ files_written?: Array<{ file: string }> }>(sessionFile, {});
        const files = [...new Set((session.files_written ?? []).map((w) => w.file))];
        // Consume the PreCompact snapshot: it exists solely for this handoff (trigger tells the
        // model whether the user compacted deliberately or the window simply ran out), and
        // deleting it after reading keeps .wolf/hooks/ free of stale one-shot state.
        const snapPath = path.join(hooksDir, "_precompact-snapshot.json");
        const snap = readJSON<{ trigger?: string }>(snapPath, {});
        try { fs.unlinkSync(snapPath); } catch {}
        const how = snap.trigger === "manual" ? "just compacted via /compact" :
          snap.trigger === "auto" ? "just auto-compacted (window was full)" : "just compacted";
        if (files.length > 0) {
          const note = `## Session in progress (context was ${how})\nFiles already modified this session: ${files.slice(-15).join(", ")}. Don't re-read them wholesale — check .wolf/memory.md for what was done.`;
          digest = digest ? `${note}\n\n${digest}` : note;
        }
      }

      if (digest) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: digest } })
        );
      }
    }
  } catch {}

  process.exit(0);
}

main().catch(() => process.exit(0));
