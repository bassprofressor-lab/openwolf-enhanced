// Regression tests for the 1.28.0 pass: defects upstream OpenWolf reported in 2.5.1 that this
// fork also had, verified one by one against our own code rather than assumed from a changelog.
//
// Each test is phrased so that reverting its fix turns it red for the same reason the defect was
// reported. Where upstream's finding did NOT apply to this fork, there is no test here — the
// difference is recorded in CHANGELOG.md instead, so nobody "fixes" something that was never broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { withLock, tryWithLock, withLockOr, LockTimeoutError } from "../dist/src/utils/fs-safe.js";
import {
  sessionFileFor, pruneOldSessionFiles, relativeToProject, updateSession,
} from "../dist/hooks/shared.js";
import { registerProject, unregisterProject, getRegistryPath, readRegistry } from "../dist/src/cli/registry.js";
import { ensureDashboardToken } from "../dist/src/utils/dashboard-auth.js";
import { readOwnDaemonPid, writeDaemonRecord, daemonPidPath } from "../dist/src/utils/daemon-pid.js";
import { unionAnatomyExcludes } from "../dist/src/cli/update.js";
import { DEFAULT_ANATOMY_EXCLUDES, isPythonVenv } from "../dist/src/utils/maintenance.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// --- the lock actually locks now (upstream #86) ------------------------------------------------

test("withLock fails closed under contention instead of running the callback anyway", () => {
  const dir = tmp("ow-lock-");
  const target = path.join(dir, "state.json");
  fs.writeFileSync(target, "{}");
  // A lock held by a LIVE process (this one), fresh enough not to be stolen as stale.
  fs.writeFileSync(target + ".lock", String(process.pid));

  let ran = false;
  assert.throws(
    () => withLock(target, () => { ran = true; }),
    LockTimeoutError,
    "an unacquirable lock must be an error, not a suggestion",
  );
  assert.equal(ran, false, "the callback must NOT run — that is what made the lock decorative");

  fs.unlinkSync(target + ".lock");
  let ran2 = false;
  withLock(target, () => { ran2 = true; });
  assert.equal(ran2, true, "an uncontended lock still runs normally");
  assert.equal(fs.existsSync(target + ".lock"), false, "and releases");
});

test("withLock still steals a lock left behind by a dead process", () => {
  const dir = tmp("ow-lock-stale-");
  const target = path.join(dir, "state.json");
  const lock = target + ".lock";
  fs.writeFileSync(lock, "999999");
  // Older than STALE_MS: the process that held it is gone, so the lock must not wedge the file
  // forever. Failing closed must not mean failing permanently.
  const old = Date.now() - 60_000;
  fs.utimesSync(lock, old / 1000, old / 1000);

  let ran = false;
  withLock(target, () => { ran = true; });
  assert.equal(ran, true, "a stale lock is stolen, not obeyed");
});

test("tryWithLock and withLockOr report a skipped update instead of throwing", () => {
  const dir = tmp("ow-lock-try-");
  const target = path.join(dir, "state.json");
  fs.writeFileSync(target + ".lock", String(process.pid));

  let warned = "";
  const orig = process.stderr.write;
  process.stderr.write = (s) => { warned += s; return true; };
  let ok, value;
  try {
    ok = tryWithLock(target, () => { throw new Error("must not run"); });
    value = withLockOr(target, () => "skipped", () => "ran");
  } finally { process.stderr.write = orig; }

  assert.equal(ok, false, "tryWithLock reports failure rather than throwing at a hook");
  assert.equal(value, "skipped", "withLockOr returns the caller's fallback");
  assert.match(warned, /could not acquire the lock/, "a lost update is never silent");
});

// --- one state file per session (upstream #89) --------------------------------------------------

test("sessionFileFor keys state by session id, and stays legacy when there is none", () => {
  const hooks = "/p/.wolf/hooks";
  assert.equal(sessionFileFor(hooks, "abc-123"), path.join(hooks, "_session-abc-123.json"));
  // No id (an agent that does not provide one) → the old shared path, unchanged behaviour.
  assert.equal(sessionFileFor(hooks), path.join(hooks, "_session.json"));
  assert.equal(sessionFileFor(hooks, ""), path.join(hooks, "_session.json"));
  assert.equal(sessionFileFor(hooks, 42), path.join(hooks, "_session.json"));

  // The id becomes a FILE NAME and comes from outside, so it can only ever name a file here.
  for (const evil of ["../../etc/passwd", "a/b", "..", "./."]) {
    const f = sessionFileFor(hooks, evil);
    // Normalise the expected side too: sessionFileFor() builds `f` with path.join(), which
    // rewrites separators on win32 (\p\.wolf\hooks). The raw POSIX `hooks` string never goes
    // through path, so a bare comparison only matches on POSIX and keeps the windows job red.
    assert.equal(path.dirname(f), path.join(hooks), `"${evil}" escaped the hooks directory: ${f}`);
    assert.ok(!path.basename(f).includes(".."), `"${evil}" kept a traversal segment`);
  }
});

test("two concurrent sessions no longer share one state file", () => {
  const hooks = tmp("ow-sessions-");
  const a = sessionFileFor(hooks, "session-a");
  const b = sessionFileFor(hooks, "session-b");
  assert.notEqual(a, b);

  updateSession(a, { reads: 0 }, (s) => { s.reads = 5; });
  updateSession(b, { reads: 0 }, (s) => { s.reads = 1; });

  assert.equal(JSON.parse(fs.readFileSync(a, "utf8")).reads, 5, "session A keeps its own count");
  assert.equal(JSON.parse(fs.readFileSync(b, "utf8")).reads, 1, "session B does not inherit it");
});

test("pruneOldSessionFiles clears spent session files but never the legacy one", () => {
  const hooks = tmp("ow-prune-sessions-");
  const old = path.join(hooks, "_session-old.json");
  const fresh = path.join(hooks, "_session-fresh.json");
  const legacy = path.join(hooks, "_session.json");
  for (const f of [old, fresh, legacy]) fs.writeFileSync(f, "{}");
  const ancient = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, ancient, ancient);
  fs.utimesSync(legacy, ancient, ancient);

  pruneOldSessionFiles(hooks, 7);

  assert.equal(fs.existsSync(old), false, "a session finished weeks ago is already in the ledger");
  assert.equal(fs.existsSync(fresh), true, "a live session is left alone");
  assert.equal(fs.existsSync(legacy), true, "the shared file belongs to no session — age says nothing");
});

// --- project containment survives a symlinked root (upstream #80) --------------------------------

test("relativeToProject: separator-anchored, and resolves a symlinked project root", () => {
  assert.equal(relativeToProject("/proj/src/a.ts", "/proj"), "src/a.ts");
  // A sibling sharing the prefix is not inside.
  assert.equal(relativeToProject("/proj2/src/a.ts", "/proj"), "");
  assert.equal(relativeToProject("/elsewhere/a.ts", "/proj"), "");

  // The real case: the root is reached through a link. Lexically nothing matches, and every read
  // in the project went untracked with no error anywhere.
  const base = tmp("ow-symlink-");
  const real = path.join(base, "real-project");
  fs.mkdirSync(path.join(real, "src"), { recursive: true });
  fs.writeFileSync(path.join(real, "src", "a.ts"), "x");
  const link = path.join(base, "linked");
  try {
    fs.symlinkSync(real, link, "dir");
  } catch {
    return; // no symlink permission (Windows without developer mode) — the lexical cases still ran
  }
  assert.equal(
    relativeToProject(path.join(real, "src", "a.ts"), link),
    "src/a.ts",
    "a file under the real path belongs to the project opened through the link",
  );
});

// --- the registry is shared by every project on the machine (upstream #88) -----------------------

test("concurrent registrations do not lose each other", () => {
  const home = tmp("ow-registry-");
  const env = { ...process.env, OPENWOLF_HOME: home, HOME: home, USERPROFILE: home };
  // Separate PROCESSES, not promises: the lost update happens between OS processes, and a
  // single-threaded in-process loop cannot reproduce it.
  // ESM needs a file:// URL for an absolute specifier — on win32 path.resolve() yields
  // `C:\…` and the loader rejects `c:` as an unknown protocol, killing every child before
  // it reaches registerProject(). pathToFileURL() makes it valid on both platforms.
  const script = `
    import { registerProject } from ${JSON.stringify(pathToFileURL(path.resolve("dist/src/cli/registry.js")).href)};
    registerProject(process.argv[2], "p" + process.argv[3], "1.28.0");
  `;
  const scriptPath = path.join(home, "reg.mjs");
  fs.writeFileSync(scriptPath, script);

  const N = 30;
  const kids = [];
  for (let i = 0; i < N; i++) {
    kids.push(new Promise((resolve) => {
      const c = spawn(process.execPath, [scriptPath, `/tmp/proj-${i}`, String(i)], { env, stdio: "ignore" });
      c.on("exit", (code) => resolve(code));
    }));
  }
  return Promise.all(kids).then((codes) => {
    // A child that never started (loader error) is otherwise indistinguishable from one that
    // ran — that is what once turned a startup failure into a phantom lost-update. Assert the
    // children actually succeeded, so the next real regression cannot masquerade the same way.
    const failed = codes.filter((c) => c !== 0).length;
    assert.equal(failed, 0, `${failed}/${N} registration children exited non-zero`);
    const reg = JSON.parse(fs.readFileSync(path.join(home, ".openwolf", "registry.json"), "utf8"));
    assert.equal(reg.projects.length, N, `all ${N} registrations must survive, kept ${reg.projects.length}`);
  });
});

// --- the dashboard token's permissions (upstream #79) -------------------------------------------

test("an existing dashboard token has its permissions repaired, not its value rotated", () => {
  if (process.platform === "win32") return; // no POSIX mode bits to repair
  const wolf = tmp("ow-token-");
  const p = path.join(wolf, "dashboard-token");
  fs.writeFileSync(p, "pre-existing-token");
  fs.chmodSync(p, 0o644); // readable by every other local user

  const returned = ensureDashboardToken(wolf);

  assert.equal(returned, "pre-existing-token", "the token a live browser tab holds is NOT rotated");
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, "but it stops being readable by others");
});

// --- daemon stop kills the daemon, not whoever holds the port (upstream #78) ---------------------

test("readOwnDaemonPid vouches for our daemon only", () => {
  const wolf = tmp("ow-daemonpid-");
  const root = "/some/project";

  assert.equal(readOwnDaemonPid(wolf, root), null, "no record → nothing to stop");

  writeDaemonRecord(wolf, root, 18791);
  assert.equal(readOwnDaemonPid(wolf, root), process.pid, "our own live record vouches for us");

  // A record for another project — the daemon may have been started elsewhere and the file copied.
  assert.equal(readOwnDaemonPid(wolf, "/a/different/project"), null, "project root must match");

  const rec = JSON.parse(fs.readFileSync(daemonPidPath(wolf), "utf8"));
  fs.writeFileSync(daemonPidPath(wolf), JSON.stringify({ ...rec, hostname: "some-other-host" }));
  assert.equal(readOwnDaemonPid(wolf, root), null, "a PID from another machine means nothing here");

  // A dead PID: the daemon crashed, or the machine rebooted and the number was reused.
  fs.writeFileSync(daemonPidPath(wolf), JSON.stringify({ ...rec, pid: 2147483646 }));
  assert.equal(readOwnDaemonPid(wolf, root), null, "a stale record must not authorise a kill");
});

// --- the anatomy index stops filling with other people's code (upstream #93 + 2.4.1) -------------

test("the default anatomy exclusions cover virtualenvs, build caches and agent config", () => {
  for (const needed of [".venv", "venv", "site-packages", ".gradle", ".DS_Store", "node_modules"]) {
    assert.ok(DEFAULT_ANATOMY_EXCLUDES.includes(needed), `missing exclusion: ${needed}`);
  }
  // Pointing the model at its own harness config is noise, and those files ranked high because
  // they are short and keyword-dense.
  for (const agentDir of [".claude", ".codex", ".opencode", ".gemini", ".cursor"]) {
    assert.ok(DEFAULT_ANATOMY_EXCLUDES.includes(agentDir), `missing agent-config exclusion: ${agentDir}`);
  }
});

test("a virtualenv is detected by pyvenv.cfg, whatever the directory is called", () => {
  const base = tmp("ow-venv-");
  const env = path.join(base, "totally-custom-name");
  fs.mkdirSync(env);
  assert.equal(isPythonVenv(env), false, "an ordinary directory is not a venv");
  fs.writeFileSync(path.join(env, "pyvenv.cfg"), "home = /usr\n");
  assert.equal(isPythonVenv(env), true, "the marker file is what defines one, not the name");
});

test("unionAnatomyExcludes adds new defaults without dropping a customised entry", () => {
  // A project initialised before an exclusion existed must still receive it on update — and the
  // user's own additions must survive, which a plain deep merge would not guarantee in either
  // direction (it replaces arrays wholesale).
  const cfg = { openwolf: { anatomy: { exclude_patterns: ["node_modules", "my-generated-dir"] } } };
  const out = unionAnatomyExcludes(cfg, DEFAULT_ANATOMY_EXCLUDES);
  const patterns = out.openwolf.anatomy.exclude_patterns;
  assert.ok(patterns.includes("my-generated-dir"), "a customised entry is never removed");
  assert.ok(patterns.includes(".venv"), "a new default arrives");
  assert.equal(new Set(patterns).size, patterns.length, "no duplicates");

  // Nothing to do when the section is absent — must not invent one.
  assert.deepEqual(unionAnatomyExcludes({}, DEFAULT_ANATOMY_EXCLUDES), {});
});
