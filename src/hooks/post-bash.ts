import * as fs from "node:fs";
import * as path from "node:path";
import {
  getWolfDir, ensureWolfDir, getCaptureConfig, redactSecrets, isFileWritingCommand,
  isNotableCommand, tailWithinBytes, timeShort, readStdin, withLock, readJSON, writeJSON,
} from "./shared.js";

// PostToolUse:Bash — two jobs.
//
// 1. Count file-writing shell commands into the session tracker. post-write.ts only matches
//    Write|Edit|MultiEdit, so edits made through the shell were invisible to it and the end-of-turn
//    reminders stayed silent for a session that worked that way. [bug-149]
// 2. Opt-in passive capture of notable shell activity into .wolf/activity.log: what commands ran
//    (commits, installs, tests, builds, deploys) and which failed. The log feeds the session-start
//    resume digest. Off unless openwolf.capture.enabled.
//
// (1) runs regardless of the capture setting — see the note at the gate below.

interface SessionData {
  files_written: unknown[];
  edit_counts: Record<string, number>;
  /** Writes made through the shell: counted, never named (no path is parsed). */
  bash_writes?: number;
  [key: string]: unknown;
}

// Read Claude Code's Bash tool_response and decide if the command failed. Shapes vary across
// versions, so we probe a few fields and fall back to "unknown" (treated as success, not error).
function classifyOutcome(resp: unknown): "ok" | "error" | "unknown" {
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    for (const k of ["exit_code", "exitCode", "code", "returncode"]) {
      if (typeof r[k] === "number") return (r[k] as number) === 0 ? "ok" : "error";
    }
    if (r.interrupted === true || r.is_error === true || r.isError === true) return "error";
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    if (stderr.trim() && !stdout.trim()) return "error";
  }
  if (typeof resp === "string" && /(^|\s)(error|failed|command not found)\b|exit code [1-9]/i.test(resp)) {
    return "error";
  }
  return "unknown";
}

async function main(): Promise<void> {
  ensureWolfDir();
  const wolfDir = getWolfDir();

  const raw = await readStdin();
  let input: { tool_input?: { command?: string }; tool_response?: unknown };
  try { input = JSON.parse(raw); } catch { process.exit(0); return; }

  const cmd = (input.tool_input?.command ?? "").trim();
  if (!cmd) { process.exit(0); return; }
  // Never capture invocations of the openwolf CLI itself, to avoid feedback noise. Match the
  // COMMAND position of each shell segment, not the whole string — the old `\bopenwolf\b` skipped
  // every command that merely mentioned an openwolf PATH, which made the write counter blind for
  // exactly the sessions that work on an openwolf checkout.
  const invokesOpenwolf = cmd
    .split(/&&|\|\||[;|]/)
    .some((seg) => /^(?:\s*[A-Za-z_]\w*=\S*)*\s*(?:\S*\/)?openwolf(?:\s|$)/.test(seg));
  if (invokesOpenwolf) { process.exit(0); return; }

  const failed = classifyOutcome(input.tool_response) === "error";

  // Count writes made through the shell. A command that failed wrote nothing, so it does not count.
  //
  // This sits BEFORE the capture gate on purpose: activity.log is opt-in, but the reminders that read
  // this counter are not. Gating the counter behind openwolf.capture.enabled would leave every default
  // install exactly as blind as the bug it fixes. [bug-149]
  if (!failed && isFileWritingCommand(cmd)) {
    try {
      const sessionFile = path.join(wolfDir, "hooks", "_session.json");
      withLock(sessionFile, () => {
        const session = readJSON<SessionData>(sessionFile, { files_written: [], edit_counts: {} });
        session.bash_writes = (session.bash_writes ?? 0) + 1;
        writeJSON(sessionFile, session);
      });
    } catch { /* best-effort; never block the tool */ }
  }

  const cap = getCaptureConfig(wolfDir);
  if (!cap.enabled) { process.exit(0); return; } // activity.log is opt-in
  if (!failed && !isNotableCommand(cmd)) { process.exit(0); return; }

  const safe = redactSecrets(cmd.replace(/\s+/g, " ")).slice(0, 200);
  const line = `${timeShort()}  ${safe}${failed ? "  → error" : ""}`;

  // Append + cap in the write path (a cap only enforced by `doctor` isn't a cap). Locked so
  // concurrent Bash hooks don't clobber each other's read-modify-write.
  try {
    const logPath = path.join(wolfDir, "activity.log");
    withLock(logPath, () => {
      let existing = "";
      try { existing = fs.readFileSync(logPath, "utf8"); } catch { /* first write */ }
      fs.writeFileSync(logPath, tailWithinBytes(existing + line + "\n", cap.logMaxBytes), "utf8");
    });
  } catch { /* best-effort; never block the tool */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
