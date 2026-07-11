import * as fs from "node:fs";
import * as path from "node:path";
import { readJSON, writeJSON, writeText } from "./fs-safe.js";
import { ensureDir } from "./paths.js";

// Deploys OpenWolf's hook scripts into whichever AI-coding CLIs a project uses. Claude Code is
// always targeted; Codex CLI, Gemini CLI, and OpenCode are auto-detected (their config dir exists)
// and, where their hook model matches Claude's, get the same Node scripts registered.
//
// Codex and Gemini share Claude's convention — command hooks, JSON on stdin (session_id, cwd,
// tool_name, tool_input), and `hookSpecificOutput.additionalContext` on stdout — so the existing
// scripts run there unchanged; only event names and tool matchers are mapped. OpenCode has no
// JSON-hook / SessionStart-injection model, so it gets a JS plugin adapter with documented limits.

export type AgentId = "claude" | "codex" | "gemini" | "opencode";
export const NON_CLAUDE_AGENTS: AgentId[] = ["codex", "gemini", "opencode"];

interface JsonHookEntry { matcher?: string; hooks: Array<{ type: "command"; command: string; timeout: number; _managedBy?: string; name?: string }>; }
type HookSettings = { hooks: Record<string, JsonHookEntry[]> };

// A hook script referenced agent-neutrally. `matchers` maps an agent to the tool-name pattern it
// fires on (absent = a non-tool event like SessionStart/Stop).
interface HookDef {
  script: string;
  claudeEvent: "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";
  matcher: string; // Claude tool matcher ("" for non-tool events)
}

const HOOKS: HookDef[] = [
  { script: "session-start.js", claudeEvent: "SessionStart", matcher: "" },
  { script: "pre-read.js", claudeEvent: "PreToolUse", matcher: "Read" },
  { script: "pre-write.js", claudeEvent: "PreToolUse", matcher: "Write|Edit|MultiEdit" },
  { script: "post-read.js", claudeEvent: "PostToolUse", matcher: "Read" },
  { script: "post-write.js", claudeEvent: "PostToolUse", matcher: "Write|Edit|MultiEdit" },
  { script: "post-bash.js", claudeEvent: "PostToolUse", matcher: "Bash" },
  { script: "stop.js", claudeEvent: "Stop", matcher: "" },
];

function cmd(projectDirExpr: string, script: string, exportProjectDir: boolean): string {
  const node = `node "${projectDirExpr}/.wolf/hooks/${script}"`;
  // Non-Claude agents don't export CLAUDE_PROJECT_DIR; set OPENWOLF_PROJECT_DIR so getWolfDir()
  // resolves the right .wolf/ regardless of the hook's cwd.
  return exportProjectDir ? `OPENWOLF_PROJECT_DIR="${projectDirExpr}" ${node}` : node;
}

// ---- Claude: exactly the historical settings (7 hooks, $CLAUDE_PROJECT_DIR) ----
function claudeSettings(): HookSettings {
  const hooks: Record<string, JsonHookEntry[]> = { SessionStart: [], PreToolUse: [], PostToolUse: [], Stop: [] };
  for (const h of HOOKS) {
    const timeout = h.script === "post-write.js" || h.script === "stop.js" ? 10 : 5;
    hooks[h.claudeEvent].push({
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      hooks: [{ type: "command", _managedBy: "openwolf", command: cmd("$CLAUDE_PROJECT_DIR", h.script, false), timeout }],
    });
  }
  return { hooks };
}

// ---- Codex: same event names as Claude; edits arrive as `apply_patch`, shell as `Bash`.
// Env var for the project dir is unconfirmed upstream, so we bake in the absolute path (stable per
// machine → the trust-hash stays put until the next `openwolf update`). ----
function codexSettings(projectRoot: string): HookSettings {
  const P = projectRoot;
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd(P, "session-start.js", true), timeout: 15 }] }],
      PostToolUse: [
        { matcher: "^apply_patch$", hooks: [{ type: "command", command: cmd(P, "post-write.js", true), timeout: 15 }] },
        { matcher: "^Bash$", hooks: [{ type: "command", command: cmd(P, "post-bash.js", true), timeout: 15 }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: cmd(P, "stop.js", true), timeout: 15 }] }],
    },
  };
}

// ---- Gemini: PostToolUse = AfterTool, Stop = SessionEnd; tools write_file/replace/run_shell_command.
// $GEMINI_PROJECT_DIR is documented. Timeouts are milliseconds here. ----
function geminiSettings(): HookSettings {
  const P = "$GEMINI_PROJECT_DIR";
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", name: "openwolf-session-start", command: cmd(P, "session-start.js", true), timeout: 10000 }] }],
      AfterTool: [
        { matcher: "write_file|replace", hooks: [{ type: "command", name: "openwolf-post-write", command: cmd(P, "post-write.js", true), timeout: 15000 }] },
        { matcher: "run_shell_command", hooks: [{ type: "command", name: "openwolf-post-bash", command: cmd(P, "post-bash.js", true), timeout: 15000 }] },
      ],
      SessionEnd: [{ hooks: [{ type: "command", name: "openwolf-stop", command: cmd(P, "stop.js", true), timeout: 15000 }] }],
    },
  };
}

// Merge managed OpenWolf hook entries into an existing settings object, preserving the user's own
// hooks. An entry is "ours" if any of its commands references `.wolf/hooks/` (or is _managedBy us).
export function mergeManagedHooks(existing: Record<string, unknown>, settings: HookSettings): Record<string, unknown> {
  const merged = { ...existing };
  if (!merged.hooks || typeof merged.hooks !== "object") merged.hooks = {};
  const hooks = merged.hooks as Record<string, JsonHookEntry[]>;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    hooks[event] = hooks[event].filter(
      (e) => !e.hooks?.some((h) => (h.command && h.command.includes(".wolf/hooks/")) || (h as { _managedBy?: string })._managedBy === "openwolf")
    );
    hooks[event].push(...entries);
  }
  return merged;
}

// The OpenCode plugin (plain ESM). OpenCode has no SessionStart injection, so the resume digest is
// pushed in at compaction; file/shell activity is captured after each tool run via the Node scripts.
function opencodePlugin(projectRoot: string): string {
  return `// OpenWolf plugin for OpenCode — generated by \`openwolf update\`. Do not edit.
// Note: OpenCode exposes no SessionStart context-injection hook (unlike Claude/Codex/Gemini), so the
// resume digest is injected at compaction; edits/shell are captured after each tool run. See the README.
import { spawnSync } from "node:child_process";

const PROJECT = ${JSON.stringify(projectRoot)};
const env = { ...process.env, OPENWOLF_PROJECT_DIR: PROJECT };

function runHook(script, payload) {
  try {
    spawnSync("node", [PROJECT + "/.wolf/hooks/" + script], { input: JSON.stringify(payload), env, encoding: "utf8", timeout: 15000 });
  } catch {}
}
function resumeDigest() {
  try {
    const r = spawnSync("node", [PROJECT + "/.wolf/hooks/session-start.js"], { input: "{}", env, encoding: "utf8", timeout: 15000 });
    const out = JSON.parse(r.stdout || "{}");
    return (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || "";
  } catch { return ""; }
}

export const OpenWolf = async () => ({
  "experimental.session.compacting": async (_input, output) => {
    const ctx = resumeDigest();
    if (ctx && output && output.context && output.context.push) output.context.push(ctx);
  },
  "tool.execute.after": async (input, output) => {
    const tool = String((input && input.tool) || "").toLowerCase();
    const args = (output && output.args) || (input && input.args) || {};
    if (tool === "bash") runHook("post-bash.js", { tool_name: "Bash", tool_input: { command: args.command || "" }, tool_response: output });
    else if (tool === "edit" || tool === "write") runHook("post-write.js", { tool_name: "Edit", tool_input: { file_path: args.filePath || args.file_path || "" } });
  },
});
`;
}

export interface AgentDeployResult { agent: AgentId; deployed: boolean; detail: string; }

// Which non-Claude agents this project uses (their config dir exists).
export function detectAgents(projectRoot: string): AgentId[] {
  const found: AgentId[] = [];
  for (const [agent, dir] of [["codex", ".codex"], ["gemini", ".gemini"], ["opencode", ".opencode"]] as const) {
    if (fs.existsSync(path.join(projectRoot, dir))) found.push(agent);
  }
  return found;
}

function deployJsonAgent(dir: string, file: string, settings: HookSettings): void {
  ensureDir(dir);
  const p = path.join(dir, file);
  const existing = fs.existsSync(p) ? readJSON<Record<string, unknown>>(p, {}) : {};
  writeJSON(p, mergeManagedHooks(existing, settings));
}

// Deploy OpenWolf hooks to Claude (always) plus every detected agent. Returns a per-agent result.
export function deployAgentHooks(projectRoot: string): AgentDeployResult[] {
  const results: AgentDeployResult[] = [];

  // Claude — always.
  deployJsonAgent(path.join(projectRoot, ".claude"), "settings.json", claudeSettings());
  results.push({ agent: "claude", deployed: true, detail: ".claude/settings.json" });

  for (const agent of detectAgents(projectRoot)) {
    try {
      if (agent === "codex") {
        deployJsonAgent(path.join(projectRoot, ".codex"), "hooks.json", codexSettings(projectRoot));
        results.push({ agent, deployed: true, detail: ".codex/hooks.json (re-approve trust in Codex)" });
      } else if (agent === "gemini") {
        deployJsonAgent(path.join(projectRoot, ".gemini"), "settings.json", geminiSettings());
        results.push({ agent, deployed: true, detail: ".gemini/settings.json" });
      } else if (agent === "opencode") {
        const dir = path.join(projectRoot, ".opencode", "plugin");
        ensureDir(dir);
        writeText(path.join(dir, "openwolf.js"), opencodePlugin(projectRoot));
        results.push({ agent, deployed: true, detail: ".opencode/plugin/openwolf.js (compaction-only inject)" });
      }
    } catch (e) {
      results.push({ agent, deployed: false, detail: `failed: ${(e as Error).message}` });
    }
  }
  return results;
}

// Exposed for tests.
export const _internal = { claudeSettings, codexSettings, geminiSettings, opencodePlugin, mergeManagedHooks };
