import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * getWolfDir() must find its project WITHOUT any environment variable.
 *
 * Until 2026-08-28 the Codex and Gemini hook commands passed the project root as a POSIX env
 * prefix: `OPENWOLF_PROJECT_DIR='/abs/proj' node '/abs/proj/.wolf/hooks/x.js'`. That syntax exists
 * only in POSIX shells — cmd.exe tries to RUN a program named `OPENWOLF_PROJECT_DIR=…` and
 * PowerShell rejects it — so on Windows the hooks never started. The prefix is gone; the hooks now
 * locate themselves, because the deployed copies always live at <project>/.wolf/hooks/.
 *
 * Without this test the fallback is invisible: with the env var set (as it is under Claude Code)
 * everything looks fine either way.
 */
function deployHooksInto(projectDir) {
  const hooksDir = path.join(projectDir, ".wolf", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const src = path.join(repoRoot, "dist", "hooks");
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".js"))) {
    fs.copyFileSync(path.join(src, f), path.join(hooksDir, f));
  }
  fs.writeFileSync(path.join(hooksDir, "package.json"), '{"type":"module"}\n');
  return hooksDir;
}

test("getWolfDir resolves from the script's own location when no env var is set", async () => {
  // mkdtemp hands back the symlinked form on macOS (/var → /private/var); the module sees the
  // resolved one, so compare against the realpath.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openwolf-root-")));
  const hooksDir = deployHooksInto(project);
  const shared = await import(pathToFileURL(path.join(hooksDir, "shared.js")).href);

  const saved = { c: process.env.CLAUDE_PROJECT_DIR, o: process.env.OPENWOLF_PROJECT_DIR };
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.OPENWOLF_PROJECT_DIR;
    assert.equal(shared.getWolfDir(), path.join(project, ".wolf"),
      "derived from <project>/.wolf/hooks/ with no environment help");

    // Explicit env still wins — Claude Code sets CLAUDE_PROJECT_DIR, and with --worktree or an
    // added directory that is the authority, not where the script happens to sit.
    process.env.CLAUDE_PROJECT_DIR = path.join(project, "elsewhere");
    assert.equal(shared.getWolfDir(), path.join(project, "elsewhere", ".wolf"),
      "CLAUDE_PROJECT_DIR takes precedence over the script location");

    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.OPENWOLF_PROJECT_DIR = path.join(project, "opencode");
    assert.equal(shared.getWolfDir(), path.join(project, "opencode", ".wolf"),
      "OPENWOLF_PROJECT_DIR still honoured — the OpenCode plugin sets it in the child env");
  } finally {
    if (saved.c === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.c;
    if (saved.o === undefined) delete process.env.OPENWOLF_PROJECT_DIR; else process.env.OPENWOLF_PROJECT_DIR = saved.o;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a hook script outside a .wolf/hooks/ layout falls back to cwd, not to a wrong root", async () => {
  // dist/hooks/shared.js is NOT under .wolf/hooks/, so the guard must decline to use its location.
  const shared = await import(pathToFileURL(path.join(repoRoot, "dist", "hooks", "shared.js")).href);
  const saved = { c: process.env.CLAUDE_PROJECT_DIR, o: process.env.OPENWOLF_PROJECT_DIR };
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.OPENWOLF_PROJECT_DIR;
    assert.equal(shared.getWolfDir(), path.join(process.cwd(), ".wolf"));
  } finally {
    if (saved.c === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.c;
    if (saved.o === undefined) delete process.env.OPENWOLF_PROJECT_DIR; else process.env.OPENWOLF_PROJECT_DIR = saved.o;
  }
});
