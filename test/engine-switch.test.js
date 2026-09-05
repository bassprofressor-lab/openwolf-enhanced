// --- engine switch: exactly one knowledge system per session ---
// OpenWolf and cfetch both hook into .claude/settings.json and both inject at SessionStart.
// Running both means paying twice and writing two memories that drift. OPENWOLF_ENGINE decides.
import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveEngine, activeEngine, standDown, cfetchOnPath, standDownNotice, unrecognizedWarning,
  DEFAULT_ENGINE, ENGINE_ENV,
} from "../dist/hooks/engine.js";

test("resolveEngine: unset or empty falls back to the default", () => {
  assert.equal(resolveEngine({}).engine, DEFAULT_ENGINE);
  assert.equal(resolveEngine({ [ENGINE_ENV]: "" }).engine, DEFAULT_ENGINE);
  assert.equal(resolveEngine({ [ENGINE_ENV]: "   " }).engine, DEFAULT_ENGINE);
  assert.equal(resolveEngine({}).unrecognized, false);
});

test("resolveEngine: accepted values, case and whitespace insensitive", () => {
  assert.equal(resolveEngine({ [ENGINE_ENV]: "cfetch" }).engine, "cfetch");
  assert.equal(resolveEngine({ [ENGINE_ENV]: "CFETCH" }).engine, "cfetch");
  assert.equal(resolveEngine({ [ENGINE_ENV]: "  cfetch  " }).engine, "cfetch");
  assert.equal(resolveEngine({ [ENGINE_ENV]: "wolf" }).engine, "wolf");
  assert.equal(resolveEngine({ [ENGINE_ENV]: "openwolf" }).engine, "wolf");
  assert.equal(resolveEngine({ [ENGINE_ENV]: "openwolf-enhanced" }).engine, "wolf");
});

test("resolveEngine: a typo falls back to OpenWolf and says so", () => {
  const c = resolveEngine({ [ENGINE_ENV]: "cfech" });
  assert.equal(c.engine, "wolf", "a typo must not disable the memory");
  assert.equal(c.unrecognized, true);
  assert.equal(c.raw, "cfech");
  assert.match(unrecognizedWarning(c), /cfech/);
});

test("standDown: only when another engine owns the session", () => {
  assert.equal(standDown({}), false);
  assert.equal(standDown({ [ENGINE_ENV]: "wolf" }), false);
  assert.equal(standDown({ [ENGINE_ENV]: "cfech" }), false, "typo keeps OpenWolf running");
  assert.equal(standDown({ [ENGINE_ENV]: "cfetch" }), true);
  assert.equal(activeEngine({ [ENGINE_ENV]: "cfetch" }), "cfetch");
});

test("cfetchOnPath: finds a binary, and reports honestly when there is none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-path-"));
  assert.equal(cfetchOnPath({ PATH: dir }), false);
  fs.writeFileSync(path.join(dir, process.platform === "win32" ? "cfetch.exe" : "cfetch"), "");
  assert.equal(cfetchOnPath({ PATH: dir }), true);
  assert.equal(cfetchOnPath({ PATH: "" }), false);
  assert.equal(cfetchOnPath({}), false);
});

test("standDownNotice: names the engine, and warns when nothing took over", () => {
  const choice = { engine: "cfetch", unrecognized: false };
  const withBinary = standDownNotice(choice, true);
  assert.match(withBinary, /cfetch/);
  assert.doesNotMatch(withBinary, /No `cfetch` binary/);

  const without = standDownNotice(choice, false);
  assert.match(without, /No `cfetch` binary on PATH/,
    "standing down with nothing to take over is the silent failure this switch exists to prevent");
  assert.match(without, /NO knowledge system/);
});

// --- the test that actually matters: do the hooks stand down on disk? ---
// The unit tests above prove the decision. These prove the consequence.
//
// NOTE: an earlier cut asserted "no .wolf/ was created", which passes with or without the guard,
// because ensureWolfDir() never creates anything — it exits when .wolf/ is missing. So every run
// below gets a REAL .wolf/ and its full contents are compared before and after, and each hook
// carries a CONTROL run without the variable. A stand-down assertion whose control shows no
// effect proves nothing: a switch welded permanently shut would pass it just as well.
const HOOKS = ["pre-read", "pre-write", "post-read", "post-write", "post-bash", "stop", "precompact"];

// Measured, not assumed (see scratchpad probe): these five change .wolf/ under the input below
// when OpenWolf is active, so for them the stand-down assertion has a working control.
const WITH_CONTROL = {
  "pre-read":   { session_id: "t", tool_name: "Read",  tool_input: { file_path: "README.md" } },
  "post-read":  { session_id: "t", tool_name: "Read",  tool_input: { file_path: "README.md" }, tool_response: {} },
  "post-write": { session_id: "t", tool_name: "Write", tool_input: { file_path: "neu.txt", content: "x" }, tool_response: {} },
  "stop":       { session_id: "t", stop_hook_active: false },
  "precompact": { session_id: "t", trigger: "manual" },
};
// pre-write and post-bash produced no observable effect under any input tried (secret paths,
// cerebrum writes, git commit, failing npm test, rm -rf). Rather than dress that up as a passing
// test, they are covered by the static guard test at the bottom, which is honest about its reach.

function makeProject() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ow-engine-"));
  const wolf = path.join(proj, ".wolf");
  fs.mkdirSync(path.join(wolf, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(wolf, "memory.md"), "# Memory\n");
  fs.writeFileSync(path.join(wolf, "anatomy.md"), "# Anatomy\n");
  fs.writeFileSync(path.join(wolf, "cerebrum.md"), "# Cerebrum\n");
  fs.writeFileSync(path.join(wolf, "config.json"), "{}\n");
  fs.writeFileSync(path.join(proj, "README.md"), "# Test\n".repeat(50));
  return proj;
}

/** Full snapshot of .wolf/: every file path mapped to its contents. */
function snapshot(proj) {
  const root = path.join(proj, ".wolf");
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

function runHook(name, cwd, env, stdin) {
  const hookPath = path.resolve("dist/hooks", `${name}.js`);
  return execFileSync(process.execPath, [hookPath], {
    cwd, input: typeof stdin === "string" ? stdin : JSON.stringify(stdin ?? {}), encoding: "utf8",
    env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: cwd },
    timeout: 20000,
  });
}

const START = { source: "startup", session_id: "t" };

test("hooks with a working control: active writes, stood down writes nothing", () => {
  for (const [hook, input] of Object.entries(WITH_CONTROL)) {
    // Control: OpenWolf active, same project, same input — must change .wolf/.
    const ctrl = makeProject();
    runHook("session-start", ctrl, {}, START);
    const ctrlBefore = snapshot(ctrl);
    runHook(hook, ctrl, {}, input);
    assert.notDeepEqual(snapshot(ctrl), ctrlBefore,
      `control for ${hook} had no effect — the stand-down assertion below would be vacuous`);
    fs.rmSync(ctrl, { recursive: true, force: true });

    // The real thing: same setup, engine handed over.
    const proj = makeProject();
    runHook("session-start", proj, {}, START);
    const before = snapshot(proj);
    const out = runHook(hook, proj, { [ENGINE_ENV]: "cfetch" }, input);
    assert.equal(out, "", `${hook} must produce no output when stood down`);
    assert.deepEqual(snapshot(proj), before, `${hook} wrote into .wolf/ during a cfetch session`);
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("session-start hands over instead of going silent, and writes nothing", () => {
  const proj = makeProject();
  const before = snapshot(proj);
  const out = runHook("session-start", proj, { [ENGINE_ENV]: "cfetch" }, START);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /Active knowledge engine: cfetch/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /do not record this session's work there/);
  assert.deepEqual(snapshot(proj), before, "session-start wrote into .wolf/ during a cfetch session");
  fs.rmSync(proj, { recursive: true, force: true });
});

test("control: without the variable session-start DOES write", () => {
  const proj = makeProject();
  const before = snapshot(proj);
  runHook("session-start", proj, {}, START);
  const after = snapshot(proj);
  assert.notDeepEqual(after, before, "a default session must still write to .wolf/");
  assert.notEqual(after["memory.md"], before["memory.md"], "memory.md gets this session's header");
  fs.rmSync(proj, { recursive: true, force: true });
});

// Static guard. Covers pre-write and post-bash, where no behavioural control could be found, and
// catches the real regression risk: a NEW hook added later that nobody wires into the switch.
// It reads the compiled hooks, so it also fails if the guard is lost between source and dist.
test("every deployed hook consults the engine switch", () => {
  for (const hook of [...HOOKS, "session-start"]) {
    const src = fs.readFileSync(path.resolve("dist/hooks", `${hook}.js`), "utf8");
    assert.match(src, /from "\.\/engine\.js"/, `${hook} does not import the engine switch`);
    assert.match(src, /standDown\(\)|resolveEngine\(\)/, `${hook} never asks which engine is active`);
  }
});

test("the guard runs before any disk work", () => {
  // Order matters: a guard placed after ensureWolfDir()/readJSON would already have touched the
  // project on behalf of the other engine.
  for (const hook of HOOKS) {
    const src = fs.readFileSync(path.resolve("dist/hooks", `${hook}.js`), "utf8");
    const guard = src.indexOf("standDown()");
    const work = src.search(/ensureWolfDir\(\)|getWolfDir\(\)/);
    assert.ok(guard > -1, `${hook}: no guard`);
    assert.ok(work === -1 || guard < work, `${hook}: guard sits after the first disk access`);
  }
});
