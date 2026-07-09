import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  makeIgnoreMatcher,
  getRetention,
  compactLedger,
  dedupeAndCapBuglog,
  humanBytes,
} from "../dist/src/utils/maintenance.js";
import {
  isSecretFile,
  parseAnatomy,
  readBugLog,
} from "../dist/hooks/shared.js";

function tmpWolf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owtest-"));
  fs.mkdirSync(path.join(dir, ".wolf"), { recursive: true });
  return path.join(dir, ".wolf");
}

// --- .gitignore/.wolfignore matcher ---
test("makeIgnoreMatcher: dir names, *.ext, ** globs, prefixes", () => {
  const m = makeIgnoreMatcher(["node_modules", "dist/", "*.log", "**/*.gen.ts", "# a comment", ""]);
  assert.equal(m("node_modules/x.js"), true);
  assert.equal(m("dist/bundle.js"), true);
  assert.equal(m("debug.log"), true);
  assert.equal(m("src/schema.gen.ts"), true);
  assert.equal(m("src/app.ts"), false);
});

// --- secret files ---
test("isSecretFile: keys/certs/keystores excluded, source not", () => {
  for (const f of ["server.pem", "AuthKey_ABC.p8", "id_rsa", ".env", ".env.production", "app.keystore", "credentials"]) {
    assert.equal(isSecretFile(f), true, `${f} should be secret`);
  }
  for (const f of ["app.ts", "README.md", "id_rsa.pub", "config.json"]) {
    assert.equal(isSecretFile(f), false, `${f} should NOT be secret`);
  }
});

// --- CRLF-tolerant anatomy parse (#50) ---
test("parseAnatomy: keeps entries on CRLF line endings", () => {
  const crlf = "## src/\r\n- `a.ts` — Entry A (~120 tok)\r\n- `b.ts` — Entry B (~80 tok)\r\n";
  const m = parseAnatomy(crlf);
  const entries = m.get("src/") || [];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].file, "a.ts");
  assert.equal(entries[0].tokens, 120);
});

// --- retention defaults ---
test("getRetention: defaults when config absent", () => {
  const w = tmpWolf();
  const r = getRetention(w);
  assert.equal(r.token_ledger_max_sessions, 200);
  assert.equal(r.buglog_max_entries, 200);
});

// --- ledger compaction caps ---
test("compactLedger: caps sessions and per-session io", () => {
  const w = tmpWolf();
  const sessions = Array.from({ length: 250 }, (_, i) => ({
    id: "s" + i,
    reads: Array.from({ length: 150 }, (_, k) => ({ file: "f" + k })),
    writes: Array.from({ length: 150 }, (_, k) => ({ file: "w" + k })),
  }));
  fs.writeFileSync(path.join(w, "token-ledger.json"), JSON.stringify({ version: 1, lifetime: {}, sessions }));
  const r = getRetention(w);
  const res = compactLedger(w, r);
  assert.equal(res.changed, true);
  const led = JSON.parse(fs.readFileSync(path.join(w, "token-ledger.json"), "utf8"));
  assert.equal(led.sessions.length, 200);
  assert.equal(led.sessions[0].reads.length, 100);
  assert.equal(led.sessions[0].writes.length, 100);
});

// --- buglog legacy-array migration + dedup + cap ---
test("dedupeAndCapBuglog: migrates bare array, dedupes auto entries, keeps manual", () => {
  const w = tmpWolf();
  const bugs = Array.from({ length: 5 }, () => ({
    file: "src/same.ts", tags: ["auto-detected", "async-fix"], occurrences: 1, last_seen: "2026-07-01",
  }));
  bugs.push({ id: "m1", file: "src/real.ts", tags: ["manual"] });
  fs.writeFileSync(path.join(w, "buglog.json"), JSON.stringify(bugs)); // bare ARRAY (legacy)
  const res = dedupeAndCapBuglog(w, 200);
  assert.equal(res.changed, true);
  const log = JSON.parse(fs.readFileSync(path.join(w, "buglog.json"), "utf8"));
  assert.ok(!Array.isArray(log), "should migrate to { version, bugs }");
  assert.equal(log.bugs.length, 2, "5 same-file+category auto merged to 1, + 1 manual");
  assert.ok(log.bugs.some((b) => b.id === "m1"), "manual entry preserved");
});

// --- readBugLog tolerates legacy array + object shapes ---
test("readBugLog: normalizes bare array and object forms", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "buglog.json"), JSON.stringify([{ id: "a" }, { id: "b" }]));
  assert.equal(readBugLog(w).bugs.length, 2);
  fs.writeFileSync(path.join(w, "buglog.json"), JSON.stringify({ version: 1, bugs: [{ id: "c" }] }));
  assert.equal(readBugLog(w).bugs.length, 1);
});

// --- humanBytes formatting ---
test("humanBytes: B/KB/MB", () => {
  assert.equal(humanBytes(512), "512 B");
  assert.match(humanBytes(2048), /2\.0 KB/);
  assert.match(humanBytes(5 * 1024 * 1024), /5\.0 MB/);
});
