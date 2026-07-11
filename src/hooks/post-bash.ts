import * as fs from "node:fs";
import * as path from "node:path";
import {
  getWolfDir, ensureWolfDir, getCaptureConfig, redactSecrets,
  isNotableCommand, tailWithinBytes, timeShort, readStdin,
} from "./shared.js";

// PostToolUse:Bash — opt-in passive capture of notable shell activity into .wolf/activity.log.
// File edits are already journaled by post-write.ts; this fills the remaining gap: what commands
// ran (commits, installs, tests, builds, deploys) and which ones failed. The log feeds the
// session-start resume digest so the next session sees it. Off unless openwolf.capture.enabled.

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
  const cap = getCaptureConfig(wolfDir);
  if (!cap.enabled) { process.exit(0); return; } // opt-in only

  const raw = await readStdin();
  let input: { tool_input?: { command?: string }; tool_response?: unknown };
  try { input = JSON.parse(raw); } catch { process.exit(0); return; }

  const cmd = (input.tool_input?.command ?? "").trim();
  if (!cmd) { process.exit(0); return; }
  // Never capture the capture-reading commands themselves, to avoid feedback noise.
  if (/\bopenwolf\b/.test(cmd)) { process.exit(0); return; }

  const failed = classifyOutcome(input.tool_response) === "error";
  if (!failed && !isNotableCommand(cmd)) { process.exit(0); return; }

  const safe = redactSecrets(cmd.replace(/\s+/g, " ")).slice(0, 200);
  const line = `${timeShort()}  ${safe}${failed ? "  → error" : ""}`;

  // Append + cap in the write path (a cap only enforced by `doctor` isn't a cap).
  try {
    const logPath = path.join(wolfDir, "activity.log");
    let existing = "";
    try { existing = fs.readFileSync(logPath, "utf8"); } catch { /* first write */ }
    fs.writeFileSync(logPath, tailWithinBytes(existing + line + "\n", cap.logMaxBytes), "utf8");
  } catch { /* best-effort; never block the tool */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
