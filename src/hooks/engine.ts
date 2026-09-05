/**
 * Engine switch — decides which knowledge system owns a session.
 *
 * OpenWolf and cfetch both hook into the same `.claude/settings.json` and both inject a resume
 * block at SessionStart. Running both means paying for two protocols and writing two memories
 * that drift apart from the moment they diverge. This module makes exactly one of them active.
 *
 * The choice is per session and lives ONLY in the environment:
 *
 *     claude                          -> wolf   (the default)
 *     OPENWOLF_ENGINE=cfetch claude   -> cfetch
 *
 * Deliberately no project-level state: a stored choice can drift out of sync with what is
 * actually installed, and two concurrent sessions in the same project would fight over it.
 * The environment cannot drift — it is read fresh on every hook invocation.
 *
 * An unknown value falls back to `wolf` rather than standing every hook down. Failing towards
 * the system that is definitely installed keeps a typo from silently disabling the memory.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type Engine = "wolf" | "cfetch";

export const ENGINE_ENV = "OPENWOLF_ENGINE";
export const DEFAULT_ENGINE: Engine = "wolf";

/** Every value we accept, lowercased. Aliases exist because muscle memory says "openwolf". */
const ALIASES: Record<string, Engine> = {
  wolf: "wolf",
  openwolf: "wolf",
  "openwolf-enhanced": "wolf",
  cfetch: "cfetch",
};

export interface EngineChoice {
  engine: Engine;
  /** The raw value that was set, if any — for reporting an unusable one back to the user. */
  raw?: string;
  /** True when a value was set that we could not map, and we fell back to the default. */
  unrecognized: boolean;
}

/** Resolve the active engine from the environment. Pure apart from the env read. */
export function resolveEngine(env: NodeJS.ProcessEnv = process.env): EngineChoice {
  const raw = env[ENGINE_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { engine: DEFAULT_ENGINE, unrecognized: false };
  }
  const key = String(raw).trim().toLowerCase();
  const mapped = ALIASES[key];
  if (mapped) return { engine: mapped, raw: String(raw), unrecognized: false };
  return { engine: DEFAULT_ENGINE, raw: String(raw), unrecognized: true };
}

/** Convenience: just the engine name. */
export function activeEngine(env: NodeJS.ProcessEnv = process.env): Engine {
  return resolveEngine(env).engine;
}

/**
 * True when OpenWolf is NOT the active engine and its hooks must stay silent.
 *
 * Every OpenWolf hook calls this first and exits 0 without output. Exit 0 matters: a non-zero
 * exit from a PreToolUse hook can block the tool call it was only meant to observe.
 */
export function standDown(env: NodeJS.ProcessEnv = process.env): boolean {
  return activeEngine(env) !== "wolf";
}

/**
 * Is a `cfetch` binary reachable on PATH?
 *
 * Used only to tell a silent hand-off apart from a silent failure: if the session is meant to
 * run on cfetch and cfetch is not installed, NO knowledge system is active and the user must
 * hear about it — that is exactly the kind of quiet nothing this switch is supposed to prevent.
 *
 * Deliberately a PATH walk instead of spawning `cfetch --version`: a hook has a few hundred
 * milliseconds, and a process spawn on a cold NFS mount can eat all of it.
 */
export function cfetchOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathVar = env.PATH || "";
  if (!pathVar) return false;
  const sep = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["cfetch.exe", "cfetch.cmd", "cfetch.bat"] : ["cfetch"];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch { /* unreadable PATH entry — keep looking */ }
    }
  }
  return false;
}

/** The block injected at SessionStart when another engine owns the session. */
export function standDownNotice(choice: EngineChoice, cfetchPresent: boolean): string {
  const lines = [
    `## Active knowledge engine: ${choice.engine}`,
    "",
    `OpenWolf stood down for this session (\`${ENGINE_ENV}=${choice.engine}\`). Its hooks write nothing`,
    "and `.wolf/` is not being updated — do not record this session's work there.",
    "",
    `Follow ${choice.engine}'s protocol, not \`.wolf/OPENWOLF.md\`. Where CLAUDE.md imports a protocol`,
    `switch, the ${choice.engine} branch is the one that applies.`,
  ];
  if (choice.engine === "cfetch" && !cfetchPresent) {
    lines.push(
      "",
      "⚠️ **No `cfetch` binary on PATH.** OpenWolf has stood down but nothing took over, so this",
      "session has NO knowledge system at all: no resume context, no memory being written. Either",
      `install cfetch or start again without ${ENGINE_ENV} to get OpenWolf back.`,
    );
  }
  return lines.join("\n");
}

/** Prepended to OpenWolf's own digest when the env held a value we could not map. */
export function unrecognizedWarning(choice: EngineChoice): string {
  return [
    `⚠️ \`${ENGINE_ENV}=${choice.raw}\` is not a value I know, so this session runs on OpenWolf`,
    `(the default). Valid values: ${Object.keys(ALIASES).join(", ")}.`,
  ].join("\n");
}
