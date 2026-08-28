// Guards the hook commands we WRITE INTO other tools' config files against shell syntax that only
// exists on one platform. Runs in CI on Linux and on Windows, because the generated shape differs
// by platform (quoting) and both variants have to stay portable.
//
// Why this exists: bug-291. We shipped `node "$CLAUDE_PROJECT_DIR/.wolf/hooks/x.js"` for months.
// On Windows without Git for Windows, Claude Code runs hooks through PowerShell, where
// $CLAUDE_PROJECT_DIR is an undefined variable — the path collapsed and every hook died, with
// nothing failing loudly enough to notice. Same family as bug-271 (POSIX syntax in postinstall).
import assert from "node:assert/strict";
import { _internal } from "../dist/src/utils/agent-hooks.js";

const problems = [];
const check = (label, cond, detail) => { if (!cond) problems.push(`${label}: ${detail}`); };

// --- Claude: exec form only. No shell runs these, so no quoting question can arise. ---
const claude = _internal.claudeSettings();
for (const [event, entries] of Object.entries(claude.hooks)) {
  for (const entry of entries) {
    for (const h of entry.hooks) {
      check(event, h.command === "node", `command must be the bare executable, got ${JSON.stringify(h.command)}`);
      check(event, Array.isArray(h.args) && h.args.length === 1, "exec form requires exactly one arg (the script path)");
      check(event, h.args?.[0]?.startsWith("${CLAUDE_PROJECT_DIR}/.wolf/hooks/"),
        `arg must be anchored to \${CLAUDE_PROJECT_DIR}, got ${JSON.stringify(h.args?.[0])}`);
      check(event, h._managedBy === "openwolf", "missing ownership marker — update would sweep foreign hooks");
    }
  }
}
check("PostToolUse", claude.hooks.PostToolUse.some((e) => e.matcher === "Bash|PowerShell"),
  "the Windows shell tool is named PowerShell; a matcher of Bash alone never fires there [bug-292]");

// --- Codex/Gemini: still shell strings. They may not carry POSIX-only constructs. ---
const POSIX_ENV_PREFIX = /^\s*[A-Za-z_]\w*=/;      // `VAR=x node …` — cmd.exe runs it as a program
const SHELL_VAR = /\$\{?[A-Za-z_]/;                 // `$VAR` — never expands in cmd.exe/PowerShell
for (const [agent, settings] of [["codex", _internal.codexSettings("/abs/proj")],
                                 ["gemini", _internal.geminiSettings("/abs/proj")]]) {
  for (const entry of Object.values(settings.hooks).flat()) {
    for (const h of entry.hooks) {
      check(agent, !POSIX_ENV_PREFIX.test(h.command), `POSIX env prefix in: ${h.command}`);
      check(agent, !SHELL_VAR.test(h.command), `shell variable that Windows will not expand: ${h.command}`);
      check(agent, h.command.includes("/.wolf/hooks/"), `no hook script path in: ${h.command}`);
      if (process.platform === "win32") {
        check(agent, !h.command.includes("node '"), `single quotes are not quoting in cmd.exe: ${h.command}`);
      }
    }
  }
}

if (problems.length) {
  console.error("Hook portability check FAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`Hook portability OK on ${process.platform} (${Object.values(claude.hooks).flat().length} Claude entries, codex + gemini shell strings clean)`);
