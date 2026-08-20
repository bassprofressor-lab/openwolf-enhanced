import * as fs from "node:fs";
import * as path from "node:path";
import { readJSON, writeJSON, writeText } from "./fs-safe.js";
import { ensureDir } from "./paths.js";
import { upsertMarkerBlock, AGENTS_SNIPPET } from "./marker-block.js";

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
  claudeEvent: "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop" | "PreCompact";
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
  { script: "precompact.js", claudeEvent: "PreCompact", matcher: "" },
];

// POSIX single-quote a literal so shell metacharacters in a project path (spaces, ", $, `, ;, …)
// can't break out of / inject into the generated command. Env-var expressions ($X) must stay in
// double quotes instead so the shell still expands them.
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build the hook command. `literal` = projectDir is a real path (single-quote-escaped, security);
// otherwise it's a shell variable expression kept in double quotes for expansion. Non-Claude agents
// also export OPENWOLF_PROJECT_DIR so getWolfDir() resolves the right .wolf/ regardless of cwd.
function cmd(projectDir: string, script: string, opts: { literal?: boolean; exportVar?: boolean } = {}): string {
  const dir = opts.literal ? shSingleQuote(projectDir) : `"${projectDir}"`;
  const scriptArg = opts.literal ? shSingleQuote(`${projectDir}/.wolf/hooks/${script}`) : `"${projectDir}/.wolf/hooks/${script}"`;
  const node = `node ${scriptArg}`;
  return opts.exportVar ? `OPENWOLF_PROJECT_DIR=${dir} ${node}` : node;
}

// ---- Claude: exactly the historical settings (7 hooks, $CLAUDE_PROJECT_DIR) ----
function claudeSettings(): HookSettings {
  const hooks: Record<string, JsonHookEntry[]> = { SessionStart: [], PreToolUse: [], PostToolUse: [], Stop: [], PreCompact: [] };
  for (const h of HOOKS) {
    const timeout = h.script === "post-write.js" || h.script === "stop.js" ? 10 : 5;
    hooks[h.claudeEvent].push({
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      hooks: [{ type: "command", _managedBy: "openwolf", command: cmd("$CLAUDE_PROJECT_DIR", h.script), timeout }],
    });
  }
  return { hooks };
}

// ---- Codex: same event names as Claude; edits arrive as `apply_patch`, shell as `Bash`.
// Env var for the project dir is unconfirmed upstream, so we bake in the absolute path (stable per
// machine → the trust-hash stays put until the next `openwolf update`). ----
// [2026-08-20] Codex used to get only 4 of the 8 hooks: session-start, post-write, post-bash,
// stop. Missing were pre-read, pre-write, post-read and precompact — exactly the ones carrying
// read avoidance, the do-not-repeat warning and the compaction snapshot. OpenWolf ran on Codex
// at half strength without anything ever failing.
//
// Matchers are a UNION of Claude and Codex tool names: which name Codex actually sends depends
// on its version, and a matcher that misses fails silently. The earlier `^apply_patch$` would
// never have seen a write reported as `Write`. `statusMessage` is Codex-specific and shows there
// what is currently running.
function codexSettings(projectRoot: string): HookSettings {
  const c = (script: string, statusMessage: string, timeout = 15) => ({
    type: "command" as const, _managedBy: "openwolf", statusMessage,
    command: cmd(projectRoot, script, { literal: true, exportVar: true }), timeout,
  });
  const WRITE = "^(Edit|Write|MultiEdit|apply_patch)$";
  const READ = "^(Read|read_file)$";
  return {
    hooks: {
      // [2026-08-20, review] NO matcher here on purpose. `startup|resume|clear` omits `compact`,
      // and session-start.ts has a dedicated branch for source === "compact" that re-injects the
      // post-compaction digest — which this same change newly makes reachable by deploying
      // PreCompact to Codex. Claude's entry matches every source too (matcher: "").
      SessionStart: [{ hooks: [c("session-start.js", "OpenWolf session bootstrap")] }],
      PreToolUse: [
        { matcher: READ, hooks: [c("pre-read.js", "OpenWolf read precheck")] },
        { matcher: WRITE, hooks: [c("pre-write.js", "OpenWolf write precheck")] },
      ],
      PostToolUse: [
        { matcher: READ, hooks: [c("post-read.js", "OpenWolf read tracking")] },
        { matcher: WRITE, hooks: [c("post-write.js", "OpenWolf anatomy update", 20)] },
        { matcher: "^(Bash|shell|local_shell)$", hooks: [c("post-bash.js", "OpenWolf shell tracking")] },
      ],
      PreCompact: [{ hooks: [c("precompact.js", "OpenWolf compaction snapshot")] }],
      Stop: [{ hooks: [c("stop.js", "OpenWolf session wrap-up", 20)] }],
    },
  };
}

// Codex only reads hooks when `hooks = true` sits under `[features]`. Without that switch a
// perfectly fine-looking hooks.json is there and none of it fires — so we create the file when it
// is missing and WARN otherwise, rather than editing someone else's config.toml.
function ensureCodexFeatureFlag(codexDir: string): string | null {
  const p = path.join(codexDir, "config.toml");
  if (!fs.existsSync(p)) {
    writeText(p, "[features]\nhooks = true\n");
    return null;
  }
  const existing = fs.readFileSync(p, "utf-8");
  // Anchored AND table-scoped. [2026-08-20, review] Anchoring alone still accepted `hooks = true`
  // under any other table (e.g. `[experimental]`), where Codex ignores it — the warning would be
  // swallowed while the hooks stayed dead. So: find [features] and look only until the next table.
  const lines = existing.split(/\r?\n/);
  let inFeatures = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (table) { inFeatures = table[1].trim() === "features"; continue; }
    if (inFeatures && /^\s*hooks\s*=\s*true\s*$/.test(line)) return null;
  }
  return 'set "hooks = true" under [features] in .codex/config.toml — otherwise Codex ignores the hooks';
}

// ---- Gemini: PostToolUse = AfterTool, Stop = SessionEnd; tools write_file/replace/run_shell_command.
// $GEMINI_PROJECT_DIR is documented. Timeouts are milliseconds here. ----
function geminiSettings(): HookSettings {
  const P = "$GEMINI_PROJECT_DIR";
  const g = (name: string, script: string) => ({ type: "command" as const, name, _managedBy: "openwolf", command: cmd(P, script, { exportVar: true }), timeout: 15000 });
  return {
    hooks: {
      SessionStart: [{ hooks: [g("openwolf-session-start", "session-start.js")] }],
      AfterTool: [
        { matcher: "write_file|replace", hooks: [g("openwolf-post-write", "post-write.js")] },
        { matcher: "run_shell_command", hooks: [g("openwolf-post-bash", "post-bash.js")] },
      ],
      SessionEnd: [{ hooks: [g("openwolf-stop", "stop.js")] }],
    },
  };
}

// Merge managed OpenWolf hook entries into an existing settings object, preserving the user's own
// hooks. An entry is "ours" ONLY if it carries `_managedBy: "openwolf"` — so a user's own hook that
// happens to invoke a `.wolf/hooks/` script is never silently removed. Every entry we emit sets it.
export function mergeManagedHooks(existing: Record<string, unknown>, settings: HookSettings): Record<string, unknown> {
  const merged = { ...existing };
  if (!merged.hooks || typeof merged.hooks !== "object") merged.hooks = {};
  const hooks = merged.hooks as Record<string, JsonHookEntry[]>;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    hooks[event] = hooks[event].filter(
      (e) => !e.hooks?.some((h) => (h as { _managedBy?: string })._managedBy === "openwolf")
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
        const codexDir = path.join(projectRoot, ".codex");
        deployJsonAgent(codexDir, "hooks.json", codexSettings(projectRoot));
        const warn = ensureCodexFeatureFlag(codexDir);
        const ctx = upsertMarkerBlock(path.join(projectRoot, "AGENTS.md"), AGENTS_SNIPPET);
        const bits = [".codex/hooks.json (re-approve trust in Codex)"];
        if (ctx.changed) bits.push("AGENTS.md block");
        if (ctx.refused) bits.push(`AGENTS.md skipped: ${ctx.refused}`);
        if (warn) bits.push(`⚠ ${warn}`);
        results.push({ agent, deployed: true, detail: bits.join(" · ") });
      } else if (agent === "gemini") {
        deployJsonAgent(path.join(projectRoot, ".gemini"), "settings.json", geminiSettings());
        results.push({ agent, deployed: true, detail: ".gemini/settings.json" });
      } else if (agent === "opencode") {
        const dir = path.join(projectRoot, ".opencode", "plugin");
        ensureDir(dir);
        writeText(path.join(dir, "openwolf.js"), opencodePlugin(projectRoot));
        // OpenCode reads AGENTS.md as its context file — without the block it never sees the protocol.
        const ctx = upsertMarkerBlock(path.join(projectRoot, "AGENTS.md"), AGENTS_SNIPPET);
        results.push({ agent, deployed: true, detail: ".opencode/plugin/openwolf.js (compaction-only inject)"
          + (ctx.changed ? " · AGENTS.md block" : "") + (ctx.refused ? ` · AGENTS.md skipped: ${ctx.refused}` : "") });
      }
    } catch (e) {
      results.push({ agent, deployed: false, detail: `failed: ${(e as Error).message}` });
    }
  }
  return results;
}

// Exposed for tests.
export const _internal = { claudeSettings, codexSettings, geminiSettings, opencodePlugin, mergeManagedHooks, ensureCodexFeatureFlag };
