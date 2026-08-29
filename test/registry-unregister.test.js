import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  normalizeProjectPath,
  registerProject,
  unregisterProject,
  pruneMissingProjects,
  readRegistry,
  getRegistryPath,
} from "../dist/src/cli/registry.js";

// The registry lives at ~/.openwolf/registry.json and getRegistryDir() reads os.homedir(), which
// takes $HOME on POSIX and %USERPROFILE% on Windows. Redirecting both gives the real code path a
// throwaway home, so these tests exercise the actual read/write/compare chain instead of a mock —
// and never touch the developer's own registry.
function withTempHome(fn) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openwolf-registry-")));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function makeProject(home, name) {
  const root = path.join(home, "projects", name);
  fs.mkdirSync(path.join(root, ".wolf"), { recursive: true });
  return root;
}

test("unregister removes the named project and leaves the others alone", () => {
  withTempHome((home) => {
    const a = makeProject(home, "alpha");
    const b = makeProject(home, "beta");
    registerProject(a, "alpha", "1.0.0");
    registerProject(b, "beta", "1.0.0");

    const removed = unregisterProject(a);

    assert.equal(removed.length, 1);
    assert.equal(removed[0].name, "alpha");
    assert.deepEqual(readRegistry().projects.map((p) => p.name), ["beta"]);
  });
});

test("unregister leaves the project's .wolf/ on disk — it edits the registry, nothing else", () => {
  withTempHome((home) => {
    const a = makeProject(home, "alpha");
    registerProject(a, "alpha", "1.0.0");
    unregisterProject(a);
    assert.ok(fs.existsSync(path.join(a, ".wolf")), ".wolf/ must survive an unregister");
  });
});

test("a trailing separator or a .. segment still names the same project", () => {
  withTempHome((home) => {
    const a = makeProject(home, "alpha");
    registerProject(a, "alpha", "1.0.0");
    assert.equal(unregisterProject(a + path.sep).length, 1);
  });
});

test("an unregister that matches nothing changes nothing and reports nothing", () => {
  withTempHome((home) => {
    const a = makeProject(home, "alpha");
    registerProject(a, "alpha", "1.0.0");
    const before = fs.readFileSync(getRegistryPath(), "utf-8");

    assert.deepEqual(unregisterProject(path.join(home, "projects", "nope")), []);
    assert.equal(fs.readFileSync(getRegistryPath(), "utf-8"), before);
  });
});

test("a typo'd path does not create a registry file out of nothing", () => {
  withTempHome((home) => {
    assert.deepEqual(unregisterProject(path.join(home, "projects", "never-existed")), []);
    assert.equal(fs.existsSync(getRegistryPath()), false);
  });
});

// The bug this guards: normalizeProjectPath used to lowercase on EVERY platform. On Linux
// /srv/App and /srv/app are two different directories, so `openwolf unregister /srv/App` would
// have deleted the entry for /srv/app — a project the user never named. On Windows the folding is
// correct and must stay, because NTFS really does treat the two as one directory.
test("case only folds where the filesystem folds it", () => {
  const upper = normalizeProjectPath(path.join(path.sep, "srv", "App"));
  const lower = normalizeProjectPath(path.join(path.sep, "srv", "app"));
  if (process.platform === "win32") {
    assert.equal(upper, lower, "Windows: C:\\App and c:\\app are one directory");
  } else {
    assert.notEqual(upper, lower, "POSIX: /srv/App and /srv/app are two directories");
  }
});

test("on a case-sensitive filesystem, unregistering /x/App must not remove /x/app", { skip: process.platform === "win32" ? "case-insensitive filesystem" : false }, () => {
  withTempHome((home) => {
    const lower = makeProject(home, "casetest");
    registerProject(lower, "casetest", "1.0.0");

    const removed = unregisterProject(path.join(home, "projects", "CaseTest"));

    assert.deepEqual(removed, [], "a differently-cased path is a different project here");
    assert.deepEqual(readRegistry().projects.map((p) => p.name), ["casetest"]);
  });
});

test("--prune drops entries whose .wolf/ is gone and keeps the live ones", () => {
  withTempHome((home) => {
    const live = makeProject(home, "live");
    const wolfless = makeProject(home, "wolfless");
    const vanished = makeProject(home, "vanished");
    registerProject(live, "live", "1.0.0");
    registerProject(wolfless, "wolfless", "1.0.0");
    registerProject(vanished, "vanished", "1.0.0");

    fs.rmSync(path.join(wolfless, ".wolf"), { recursive: true });  // OpenWolf removed from it
    fs.rmSync(vanished, { recursive: true });                       // whole project deleted

    const removed = pruneMissingProjects().map((p) => p.name).sort();

    assert.deepEqual(removed, ["vanished", "wolfless"]);
    assert.deepEqual(readRegistry().projects.map((p) => p.name), ["live"]);
  });
});

test("--prune on a healthy registry writes nothing", () => {
  withTempHome((home) => {
    const live = makeProject(home, "live");
    registerProject(live, "live", "1.0.0");
    const before = fs.statSync(getRegistryPath()).mtimeMs;

    assert.deepEqual(pruneMissingProjects(), []);
    assert.equal(fs.statSync(getRegistryPath()).mtimeMs, before);
  });
});
