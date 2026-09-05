import * as fs from "node:fs";
import * as path from "node:path";
import {
  getWolfDir, ensureWolfDir, getCaptureConfig, redactSecrets, isFileWritingCommand,
  isNotableCommand, tailWithinBytes, timeShort, readStdin, withLock, tryWithLock, readJSON, writeJSON, sessionFileFor,
} from "./shared.js";
import { standDown } from "./engine.js";

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

/**
 * Does this shell segment invoke the openwolf CLI in COMMAND position (optionally behind
 * `VAR=value` env prefixes and a path)? Matching the command position rather than the bare word
 * keeps the write counter alive in sessions that merely mention an openwolf path. [bug-149]
 *
 * The env-prefix group requires the trailing `\s+` on purpose. With `\s*` leading each iteration
 * instead, `\S*` and the following iteration could split the SAME token in exponentially many
 * ways: a ~70-character segment like `A=a=a=a=…` backtracked for minutes, and this hook runs on
 * every Bash call, so it blocked the agent. Demanding whitespace after each assignment — which is
 * how shell env prefixes actually work — makes the boundary unambiguous and the match linear.
 */
export function segmentInvokesOpenwolf(seg: string): boolean {
  return /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:\S*\/)?openwolf(?:\s|$)/.test(seg);
}

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
    // NOTE: no "stderr but no stdout" heuristic — plenty of successful commands write only to
    // stderr (git checkout progress, curl -v, warnings). It misclassified them as failures,
    // undercounting bash_writes and mislabeling activity.log entries. Explicit signals only.
  }
  if (typeof resp === "string" && /(^|\s)(error|failed|command not found)\b|exit code [1-9]/i.test(resp)) {
    return "error";
  }
  return "unknown";
}

async function main(): Promise<void> {
  // Stand down when another engine owns this session (OPENWOLF_ENGINE). Before any
  // .wolf/ work: a cfetch session must not get a knowledge base created behind its back.
  if (standDown()) return;
  ensureWolfDir();
  const wolfDir = getWolfDir();

  const raw = await readStdin();
  let input: { session_id?: string; tool_input?: { command?: string }; tool_response?: unknown };
  try { input = JSON.parse(raw); } catch { process.exit(0); return; }

  const cmd = (input.tool_input?.command ?? "").trim();
  if (!cmd) { process.exit(0); return; }
  // Never capture invocations of the openwolf CLI itself, to avoid feedback noise. Match the
  // COMMAND position of each shell segment, not the whole string — the old `\bopenwolf\b` skipped
  // every command that merely mentioned an openwolf PATH, which made the write counter blind for
  // exactly the sessions that work on an openwolf checkout.
  // Newlines separate commands exactly like `;` does, and they were missing from this split: a
  // two-line Bash block whose second line ran `openwolf push` was tested as ONE segment starting
  // with the first line's command, so the filter saw no openwolf invocation and captured the whole
  // thing. Multi-line blocks are the normal shape of an agent's shell call, so this was the common
  // case, not the edge one.
  const invokesOpenwolf = cmd.split(/&&|\|\||[;|\n\r]/).some(segmentInvokesOpenwolf);
  if (invokesOpenwolf) { process.exit(0); return; }

  const failed = classifyOutcome(input.tool_response) === "error";

  // Count writes made through the shell. A command that failed wrote nothing, so it does not count.
  //
  // This sits BEFORE the capture gate on purpose: activity.log is opt-in, but the reminders that read
  // this counter are not. Gating the counter behind openwolf.capture.enabled would leave every default
  // install exactly as blind as the bug it fixes. [bug-149]
  if (!failed && isFileWritingCommand(cmd)) {
    try {
      const sessionFile = sessionFileFor(path.join(wolfDir, "hooks"), input.session_id);
      tryWithLock(sessionFile, () => {
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
    tryWithLock(logPath, () => {
      let existing = "";
      try { existing = fs.readFileSync(logPath, "utf8"); } catch { /* first write */ }
      fs.writeFileSync(logPath, tailWithinBytes(existing + line + "\n", cap.logMaxBytes), "utf8");
    });
  } catch { /* best-effort; never block the tool */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
