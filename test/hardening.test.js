// Regression tests for the 1.26.1 hardening pass.
//
// Each test below pins ONE behaviour that was wrong before, phrased so that reverting the fix
// turns the test red for the same reason the bug was reported. Where a claim from the audit did
// not survive verification, the test pins what the code actually does instead — those cases are
// marked, so nobody "fixes" them back.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { safeTaskSlug } from "../dist/src/daemon/cron-engine.js";
import { isSafeCaptureUrl, isAllowedBrowserPath } from "../dist/src/designqc/designqc-capture.js";
import { isPrivateHost, assertSafeBaseUrl } from "../dist/src/daemon/llm-provider.js";
import { isOutsideProject, matchesAnatomyEntry, updateSession } from "../dist/hooks/shared.js";
import { makeIgnoreMatcher } from "../dist/src/utils/maintenance.js";
import { toCSV } from "../dist/src/cli/export-cmd.js";
import { deepMergeDefaults } from "../dist/src/cli/update.js";
import { pruneProposals } from "../dist/src/utils/maintenance.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- cron: a repo-controlled task id must not become a path -------------------------------------

test("safeTaskSlug: a manifest id can never escape proposals/", () => {
  // cron-manifest.json is committed, so `id` is attacker-controlled on a cloned repo. This used to
  // be pasted straight into path.join(.wolf/proposals, `${taskId}-${stamp}.md`).
  assert.equal(safeTaskSlug("../../../../etc/cron.d/openwolf"), "etc-cron.d-openwolf");
  assert.equal(safeTaskSlug("..\\..\\Windows\\System32\\x"), "Windows-System32-x");
  assert.equal(safeTaskSlug("a/../../b"), "a-b");

  // Whatever comes out has to be a plain single path segment.
  for (const evil of ["../x", "/abs/x", "..", "...", "./.", "C:\\x", "a\0b"]) {
    const slug = safeTaskSlug(evil);
    assert.equal(path.basename(slug), slug, `"${evil}" → "${slug}" must be one segment`);
    assert.ok(!slug.includes(".."), `"${evil}" → "${slug}" must not contain ".."`);
    assert.ok(slug.length > 0, `"${evil}" must not produce an empty name`);
  }
});

test("safeTaskSlug: keeps ordinary ids readable and dodges Windows device names", () => {
  assert.equal(safeTaskSlug("memory-consolidation"), "memory-consolidation");
  assert.equal(safeTaskSlug("cerebrum_reflection.v2"), "cerebrum_reflection.v2");
  // CON/PRN/AUX/NUL/COM1-9/LPT1-9 cannot be opened as files on Windows, with or without extension.
  assert.equal(safeTaskSlug("con"), "task-con");
  assert.equal(safeTaskSlug("LPT1"), "task-LPT1");
  assert.equal(safeTaskSlug(""), "task");
});

// --- hooks: the Windows cross-drive hole in the "outside the project" guard ---------------------

test("isOutsideProject: catches the win32 cross-drive case path.relative cannot express", () => {
  // path.win32.relative("C:\\proj", "F:\\secrets\\x") === "F:\\secrets\\x" — no leading "..", so
  // the old `startsWith("..")` test passed it and the foreign path leaked into anatomy/memory (#56).
  const rel = path.win32.relative("C:\\proj", "F:\\secrets\\x").replace(/\\/g, "/");
  assert.equal(rel, "F:/secrets/x", "precondition: relative() gives up and returns the target");
  assert.equal(rel.startsWith(".."), false, "precondition: the old guard saw nothing wrong");
  assert.equal(isOutsideProject(rel), true, "the new guard rejects it");

  assert.equal(isOutsideProject("F:x"), true, "drive-relative form too");
  assert.equal(isOutsideProject("/etc/passwd"), true, "an absolute posix path is not relative");
  assert.equal(isOutsideProject(""), true, "empty means the path IS the root");
  assert.equal(isOutsideProject("../sibling/x.ts"), true);
});

test("isOutsideProject: ordinary in-project paths stay inside, including a leading-dot name", () => {
  assert.equal(isOutsideProject("src/index.ts"), false);
  assert.equal(isOutsideProject("a/b/c.md"), false);
  // "..config" is a legal file name in the project root and used to be misread as a traversal,
  // because the old test was an unanchored startsWith("..").
  assert.equal(isOutsideProject("..config"), false);
});

// --- hooks: anatomy entries must match on a path boundary ---------------------------------------

test("matchesAnatomyEntry: a shared suffix is not a match", () => {
  assert.equal(matchesAnatomyEntry("/home/me/proj/src/api/client.ts", "src/api/client.ts"), true);
  assert.equal(matchesAnatomyEntry("src/api/client.ts", "src/api/client.ts"), true, "already relative");

  // The old `endsWith(rel)` half had no separator before the entry, so another project's file —
  // or a directory merely ENDING in the entry's first segment — printed the wrong description and
  // was booked as an anatomy hit.
  assert.equal(matchesAnatomyEntry("/tmp/other-src/api/client.ts", "src/api/client.ts"), false);
  assert.equal(matchesAnatomyEntry("/vendor/xsrc/api/client.ts", "src/api/client.ts"), false);
});

// --- hooks: _session.json updates must be deltas, not snapshots ---------------------------------

test("updateSession: applies the mutation to what is ON DISK, not to a stale snapshot", () => {
  const dir = tmpDir("ow-session-");
  const f = path.join(dir, "_session.json");
  fs.writeFileSync(f, JSON.stringify({ reads: 0, writes: 0 }));

  // Simulate the race the missing lock allowed: a sibling hook writes between our read and write.
  const stale = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ reads: 0, writes: 7 }));

  updateSession(f, stale, (s) => { s.reads += 1; });

  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(after.reads, 1, "our delta was applied");
  assert.equal(after.writes, 7, "the sibling's update survived — a snapshot write would say 0");
  assert.equal(fs.existsSync(f + ".lock"), false, "the lock is released");
});

// --- designqc: the browser binary comes from a committed config file ----------------------------

test("isAllowedBrowserPath: only browser-named binaries, and never one shipped by the repo", () => {
  assert.equal(isAllowedBrowserPath("/usr/bin/google-chrome"), true);
  assert.equal(isAllowedBrowserPath("/opt/chromium-browser"), true);
  assert.equal(isAllowedBrowserPath("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), true);
  assert.equal(isAllowedBrowserPath("C:\\x\\msedge.EXE"), true, "case-insensitive, .exe stripped");

  // .wolf/config.json is committed, so designqc.chrome_path was a way for a cloned repo to choose
  // which executable puppeteer launches.
  assert.equal(isAllowedBrowserPath("/usr/bin/curl"), false);
  assert.equal(isAllowedBrowserPath("/tmp/payload.sh"), false);
  assert.equal(isAllowedBrowserPath("/bin/sh"), false);

  // Even a correctly NAMED binary is refused when it lives in the project being screenshotted.
  assert.equal(isAllowedBrowserPath("/proj/tools/chrome", "/proj"), false);
  assert.equal(isAllowedBrowserPath("/usr/bin/chrome", "/proj"), true);
});

test("isSafeCaptureUrl: repo-derived URLs may only be public http(s)", () => {
  // Reached via package.json "homepage", a .env var or vercel.json — all repo-controlled, and the
  // screenshot lands in .wolf/designqc-captures/, a committed directory a model then reads.
  assert.equal(isSafeCaptureUrl("https://example.com", "repo"), true);
  assert.equal(isSafeCaptureUrl("file:///C:/Users/me", "repo"), false, "would photograph the home dir");
  assert.equal(isSafeCaptureUrl("http://169.254.169.254/latest/meta-data/", "repo"), false, "cloud metadata");
  assert.equal(isSafeCaptureUrl("http://127.0.0.1:3000", "repo"), false);
  assert.equal(isSafeCaptureUrl("http://192.168.1.10/admin", "repo"), false);
  assert.equal(isSafeCaptureUrl("http://[::ffff:7f00:1]/", "repo"), false, "v4-mapped loopback");
  assert.equal(isSafeCaptureUrl("not a url", "repo"), false);
});

test("isSafeCaptureUrl: an operator-supplied URL may be local, but never a non-http scheme", () => {
  // --url and the token-gated daemon route: dev servers live on loopback and on the LAN.
  assert.equal(isSafeCaptureUrl("http://localhost:5173", "user"), true);
  assert.equal(isSafeCaptureUrl("http://192.168.1.10:3000", "user"), true);
  assert.equal(isSafeCaptureUrl("file:///etc/passwd", "user"), false);
  assert.equal(isSafeCaptureUrl("chrome://settings", "user"), false);
  assert.equal(isSafeCaptureUrl("data:text/html,<h1>x", "user"), false);
});

// --- embeddings egress reuses the LLM guard (same class as bug-130) -----------------------------

test("assertSafeBaseUrl: names the offending config key, and still blocks what it always blocked", () => {
  // The embeddings client now calls this too; telling someone to fix "llm_base_url" when the value
  // sits under recall.embeddings.base_url sends them to the wrong line.
  assert.throws(
    () => assertSafeBaseUrl("http://evil.example.com/v1", "recall.embeddings.base_url"),
    /recall\.embeddings\.base_url must use https/,
  );
  assert.throws(() => assertSafeBaseUrl("https://169.254.169.254/v1"), /private\/link-local/);
  assert.doesNotThrow(() => assertSafeBaseUrl("http://localhost:1234/v1"), "loopback stays keyless-friendly");
  assert.doesNotThrow(() => assertSafeBaseUrl("https://api.openai.com/v1"));
});

test("isPrivateHost: exported for reuse, and still only judges IP literals (bug-212/213)", () => {
  assert.equal(isPrivateHost("169.254.169.254"), true);
  assert.equal(isPrivateHost("10.0.0.1"), true);
  assert.equal(isPrivateHost("fe90::1"), true, "fe80::/10 is wider than the fe80: prefix [bug-213]");
  assert.equal(isPrivateHost("fc2.com"), false, "a NAME starting with fc is not an IPv6 ULA [bug-212]");
  assert.equal(isPrivateHost("example.com"), false);
});

// --- gitignore matcher: "?" is a wildcard, not a regex quantifier -------------------------------

test("makeIgnoreMatcher: ? matches exactly one character", () => {
  const m = makeIgnoreMatcher(["build?/*.js"]);
  // Unescaped, "?" made the preceding character optional: "buil/x.js" matched and "build2/x.js"
  // did not — the rule silently covered a different set of files than it reads as.
  assert.equal(m("build2/x.js"), true, "one character in the ? position");
  assert.equal(m("buil/x.js"), false, "must NOT match with the character missing");
  assert.equal(m("build22/x.js"), false, "? is exactly one, not many");
});

// --- CSV export: values come from agent-written files --------------------------------------------

test("toCSV: a leading formula character is neutralised", () => {
  const csv = toCSV([{ msg: "=HYPERLINK(\"http://x\",\"click\")", ok: "plain" }]);
  const dataLine = csv.split("\n")[1];
  assert.ok(dataLine.startsWith("\"'=HYPERLINK"), `formula not neutralised: ${dataLine}`);
  assert.ok(dataLine.endsWith("plain"), "ordinary values are untouched");

  for (const lead of ["=", "+", "-", "@"]) {
    const line = toCSV([{ v: `${lead}cmd` }]).split("\n")[1];
    assert.equal(line, `'${lead}cmd`, `${lead} must be prefixed`);
  }
  assert.equal(toCSV([{ v: "normal" }]).split("\n")[1], "normal", "no marker where none is needed");
});

// --- init must not reset a project's config.json --------------------------------------------------

test("deepMergeDefaults: user values win, new default keys are added", () => {
  // `openwolf init` in an existing project used to copy the template over config.json, which reset
  // assigned ports, tuned retention limits, and openwolf.remote.* — unlinking the team workspace.
  const defaults = {
    openwolf: {
      daemon: { port: 18790, log_level: "info" },
      remote: { enabled: false, base_url: "", project: "" },
      retention: { backups_keep: 10, proposals_keep: 20 },
    },
  };
  const user = {
    openwolf: {
      daemon: { port: 18999 },
      remote: { enabled: true, base_url: "https://wolf.example.com", project: "team" },
      retention: { backups_keep: 3 },
    },
  };
  const merged = deepMergeDefaults(defaults, user);
  assert.equal(merged.openwolf.daemon.port, 18999, "the assigned port survives");
  assert.equal(merged.openwolf.daemon.log_level, "info", "untouched defaults remain");
  assert.equal(merged.openwolf.remote.base_url, "https://wolf.example.com", "the workspace link survives");
  assert.equal(merged.openwolf.retention.backups_keep, 3, "tuned limit survives");
  assert.equal(merged.openwolf.retention.proposals_keep, 20, "a NEW key from the template is added");
});

// --- proposals/ is bounded like backups/ and daemon.log ------------------------------------------

test("pruneProposals: keeps the newest N and leaves a small directory alone", () => {
  const wolf = tmpDir("ow-prop-");
  const dir = path.join(wolf, "proposals");
  fs.mkdirSync(dir);
  for (const n of ["a-2026-01-01.md", "b-2026-02-01.md", "c-2026-03-01.md", "d-2026-04-01.md"]) {
    fs.writeFileSync(path.join(dir, n), "x");
  }
  const r = pruneProposals(wolf, 2);
  assert.equal(r.changed, true);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ["c-2026-03-01.md", "d-2026-04-01.md"], "the newest two are kept");

  assert.equal(pruneProposals(wolf, 10).changed, false, "already within the limit");
  assert.equal(pruneProposals(tmpDir("ow-prop-none-"), 10).changed, false, "no directory is not an error");
});
