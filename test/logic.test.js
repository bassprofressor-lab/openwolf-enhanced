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
  suggestIgnores,
  aggregateProjects,
  projectSummary,
  nativeMemoryHealth,
} from "../dist/src/utils/maintenance.js";
import {
  isSecretFile,
  parseAnatomy,
  readBugLog,
  buildResumeDigest,
  nativeMemoryDir,
} from "../dist/hooks/shared.js";
import { toCSV, collectRows } from "../dist/src/cli/export-cmd.js";

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

// --- buildResumeDigest (session-start resume context) ---
test("buildResumeDigest: includes real STATUS, Do-Not-Repeat, last session; skips stub", () => {
  const wolf = tmpWolf();
  fs.writeFileSync(path.join(wolf, "STATUS.md"), "# STATUS\n\n## Next\nShip the widget.\n");
  fs.writeFileSync(path.join(wolf, "cerebrum.md"),
    "## Key Learnings\n- x\n\n## Do-Not-Repeat\n- [07.10] never force-push main\n\n## Decision Log\n- y\n");
  fs.writeFileSync(path.join(wolf, "memory.md"),
    "## Session: 2026-07-09 10:00\n\n| 10:01 | old | f | ok | 1k |\n\n## Session: 2026-07-10 12:00\n\n| 12:30 | new work | g | done | 2k |\n");
  const d = buildResumeDigest(wolf, 6000);
  assert.ok(d.includes("Ship the widget."), "has STATUS content");
  assert.ok(d.includes("never force-push main"), "has Do-Not-Repeat");
  assert.ok(d.includes("new work"), "has latest session");
  assert.ok(!d.includes("old"), "excludes older session block");
});

test("buildResumeDigest: returns null when nothing useful (stub STATUS, no cerebrum/memory)", () => {
  const wolf = tmpWolf();
  fs.writeFileSync(path.join(wolf, "STATUS.md"), "# STATUS — {{PROJECT_NAME}}\n\n## Next\n_<what next>_\n\n- (nothing yet)\n");
  assert.equal(buildResumeDigest(wolf, 6000), null);
});

test("buildResumeDigest: respects the char cap", () => {
  const wolf = tmpWolf();
  fs.writeFileSync(path.join(wolf, "STATUS.md"), "# STATUS\n\n" + "x".repeat(20000));
  const d = buildResumeDigest(wolf, 2000);
  assert.ok(d.length <= 2000, `digest ${d.length} within cap`);
  assert.ok(d.includes("truncated"), "marks truncation");
});

// --- export: toCSV escaping + union columns ---
test("toCSV: header union, RFC4180 quoting, arrays joined", () => {
  const csv = toCSV([
    { a: 1, b: "plain" },
    { a: 2, b: 'has,comma "and" quote', c: ["x", "y"] },
  ]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "a,b,c");
  assert.equal(lines[1], "1,plain,");
  assert.equal(lines[2], '2,"has,comma ""and"" quote",x; y');
});

test("toCSV: empty input → empty string", () => {
  assert.equal(toCSV([]), "");
});

// --- export: collectRows flattens ledger + buglog ---
test("collectRows: sessions flatten totals; bugs flatten fields; unknown throws", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "token-ledger.json"), JSON.stringify({
    version: 1, lifetime: {}, sessions: [
      { id: "s1", started: "t0", ended: "t1", totals: { reads_count: 3, writes_count: 1 } },
    ],
  }));
  const sess = collectRows(w, "sessions");
  assert.equal(sess.length, 1);
  assert.equal(sess[0].id, "s1");
  assert.equal(sess[0].reads_count, 3);

  fs.writeFileSync(path.join(w, "buglog.json"), JSON.stringify({ version: 1, bugs: [
    { id: "b1", file: "a.ts", tags: ["x", "y"], occurrences: 2 },
  ]}));
  const bugs = collectRows(w, "bugs");
  assert.equal(bugs[0].id, "b1");
  assert.equal(bugs[0].tags, "x; y");

  assert.throws(() => collectRows(w, "nope"), /unknown export target/);
});

// --- suggestIgnores: flags noisy dirs, respects existing ignores + defaults ---
test("suggestIgnores: suggests noisy dir, skips ignored + default-excluded + child dirs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owsug-"));
  const mk = (rel, n) => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "x");
  };
  mk("generated", 60);           // noisy → should be suggested
  mk("generated/sub", 60);       // child of a suggested dir → must NOT be suggested separately
  mk("src", 5);                  // small → ignored
  mk("node_modules/pkg", 100);   // default-excluded → never suggested
  mk("vendor", 60);              // noisy but...
  fs.writeFileSync(path.join(root, ".wolfignore"), "vendor/\n"); // ...already ignored → skip

  const s = suggestIgnores(root, { minFiles: 40 });
  const pats = s.map((x) => x.pattern);
  assert.ok(pats.includes("generated/"), "flags the noisy generated/ dir");
  assert.ok(!pats.some((p) => p.startsWith("generated/sub")), "does not also flag the child dir");
  assert.ok(!pats.includes("node_modules/"), "never flags default-excluded dirs");
  assert.ok(!pats.includes("vendor/"), "respects existing .wolfignore");
});

// --- aggregateProjects / projectSummary (cross-project rollup) ---
test("projectSummary: reads lifetime stats + bug count; missing .wolf → exists:false", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "owagg-"));
  const proj = path.join(base, "p1");
  fs.mkdirSync(path.join(proj, ".wolf"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".wolf", "token-ledger.json"), JSON.stringify({
    version: 1, lifetime: { total_sessions: 7, total_tokens_estimated: 1234, estimated_savings_vs_bare_cli: 500 },
  }));
  fs.writeFileSync(path.join(proj, ".wolf", "buglog.json"), JSON.stringify({ version: 1, bugs: [{ id: "a" }, { id: "b" }] }));

  const s = projectSummary(proj, "p1");
  assert.equal(s.exists, true);
  assert.equal(s.total_sessions, 7);
  assert.equal(s.total_tokens_estimated, 1234);
  assert.equal(s.estimated_savings, 500);
  assert.equal(s.open_bugs, 2);

  const gone = projectSummary(path.join(base, "does-not-exist"), "ghost");
  assert.equal(gone.exists, false);
  assert.equal(gone.total_sessions, 0);
  assert.equal(gone.open_bugs, 0);

  const agg = aggregateProjects([{ root: proj, name: "p1" }, { root: path.join(base, "does-not-exist"), name: "ghost" }]);
  assert.equal(agg.length, 2);
  assert.equal(agg[0].name, "p1");
});

// --- recall: keyword search over knowledge files ---
import { recall } from "../dist/src/utils/recall.js";
test("recall: ranks multi-term matches, searches buglog entries, empty query → []", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "cerebrum.md"),
    "## Do-Not-Repeat\n- never force-push the main branch\n- the daemon port is 18791\n");
  fs.writeFileSync(path.join(w, "memory.md"),
    "| 10:00 | force-push incident on main | git | fixed | 1k |\n| 11:00 | unrelated | x | ok | 1k |\n");
  fs.writeFileSync(path.join(w, "buglog.json"), JSON.stringify({ version: 1, bugs: [
    { id: "bug-1", error_message: "EADDRINUSE port already in use", root_cause: "daemon port clash", tags: ["daemon"] },
  ]}));

  const hits = recall(w, "force-push main", { limit: 5 });
  assert.ok(hits.length >= 2, "finds matches in cerebrum + memory");
  // a unit containing BOTH terms outranks single-term ones
  assert.ok(hits[0].text.toLowerCase().includes("force-push") && hits[0].text.toLowerCase().includes("main"));

  const bugHits = recall(w, "EADDRINUSE", { limit: 5 });
  assert.equal(bugHits[0].file, "buglog.json");
  assert.ok(bugHits[0].text.includes("EADDRINUSE"));

  assert.deepEqual(recall(w, "   ", {}), []);
  assert.deepEqual(recall(w, "zzznomatchzzz", {}), []);
});

// --- <private> tag exclusion (recall + resume digest) ---
import { stripPrivate } from "../dist/hooks/shared.js";
test("stripPrivate: removes blocks (multiline, inline, case-insensitive)", () => {
  assert.equal(stripPrivate("a <private>secret</private> b"), "a  b");
  assert.equal(stripPrivate("x\n<PRIVATE>\nline1\nline2\n</PRIVATE>\ny").replace(/\n+/g, "\n"), "x\ny");
});

test("recall + buildResumeDigest exclude <private> content", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "STATUS.md"),
    "# STATUS\n\n## Next\nShip it.\n\n<private>\nAPI_KEY=sk-supersecret-value\n</private>\n\nafter\n");
  fs.writeFileSync(path.join(w, "cerebrum.md"), "## Do-Not-Repeat\n- keep it public\n");
  fs.writeFileSync(path.join(w, "memory.md"), "note with <private>sk-supersecret-value</private> inline\n");

  const hits = recall(w, "supersecret");
  assert.equal(hits.length, 0, "private content is not searchable");

  const d = buildResumeDigest(w, 6000);
  assert.ok(!d.includes("supersecret"), "private content is not injected");
  assert.ok(d.includes("Ship it."), "public content still present");

  // line numbers stay accurate after a multi-line private block: 'after' is on original line 9
  fs.writeFileSync(path.join(w, "memory.md"), "l1\n<private>\nx\n</private>\nfindme\n");
  const h2 = recall(w, "findme");
  assert.equal(h2[0].line, 5, "line number preserved across a private block");
});

// --- native memory interop: resolver, recall, health ---
test("nativeMemoryDir: env override wins; missing dir → null", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "ownm-"));
  process.env.OPENWOLF_NATIVE_MEMORY_DIR = real;
  assert.equal(nativeMemoryDir("/whatever"), real);
  process.env.OPENWOLF_NATIVE_MEMORY_DIR = path.join(real, "nope");
  assert.equal(nativeMemoryDir("/whatever"), null);
  delete process.env.OPENWOLF_NATIVE_MEMORY_DIR;
});

test("recall searches native memory when nativeDir given, labels hits native/…", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "memory.md"), "| 10:00 | local note about widgets | f | ok | 1k |\n");
  const nd = fs.mkdtempSync(path.join(os.tmpdir(), "ownm2-"));
  fs.writeFileSync(path.join(nd, "topic_widgets.md"), "deep dive on the widget subsystem redesign\n");
  const hits = recall(w, "widget", { nativeDir: nd });
  assert.ok(hits.some((h) => h.file.startsWith("native/")), "has a native hit");
  assert.ok(hits.some((h) => h.file === "memory.md"), "still searches .wolf files");
  // native off:
  assert.ok(!recall(w, "widget", { includeNative: false }).some((h) => h.file.startsWith("native/")));
});

test("nativeMemoryHealth: counts orphans, dead links, 200-line cutoff", () => {
  const nd = fs.mkdtempSync(path.join(os.tmpdir(), "ownm3-"));
  fs.writeFileSync(path.join(nd, "MEMORY.md"),
    "# Index\n- [A](existing.md) — x\n- [B](deadlink.md) — y\n" + "filler\n".repeat(210));
  fs.writeFileSync(path.join(nd, "existing.md"), "content\n");
  fs.writeFileSync(path.join(nd, "orphan.md"), "not in index\n");
  const h = nativeMemoryHealth(nd);
  assert.equal(h.topicFiles, 2);            // existing + orphan (MEMORY.md excluded)
  assert.equal(h.indexedCount, 1);          // only existing.md is referenced AND exists
  assert.equal(h.orphanCount, 1);           // orphan.md
  assert.deepEqual(h.deadLinks, ["deadlink.md"]);
  assert.equal(h.indexCutoffExceeded, true);
});

// --- nativeMemoryFiles: per-file listing with indexed flag ---
import { nativeMemoryFiles } from "../dist/src/utils/maintenance.js";
test("nativeMemoryFiles: lists topic files with correct indexed flag, excludes MEMORY.md/.bak", () => {
  const nd = fs.mkdtempSync(path.join(os.tmpdir(), "ownm4-"));
  fs.writeFileSync(path.join(nd, "MEMORY.md"), "# Index\n- [A](existing.md) — x\n");
  fs.writeFileSync(path.join(nd, "existing.md"), "content\n");
  fs.writeFileSync(path.join(nd, "orphan.md"), "not indexed\n");
  fs.writeFileSync(path.join(nd, "MEMORY.md.bak-pre-compact-1"), "backup\n");
  const files = nativeMemoryFiles(nd);
  assert.equal(files.length, 2, "excludes MEMORY.md and .bak");
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.equal(byName["existing.md"].indexed, true);
  assert.equal(byName["orphan.md"].indexed, false);
  assert.ok(byName["existing.md"].bytes > 0 && byName["existing.md"].mtime);
});

// --- MCP server dispatch ---
import { handleMcpMessage, MCP_TOOLS } from "../dist/src/mcp/server.js";
test("handleMcpMessage: initialize, tools/list, tools/call, notifications, unknown method", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "owmcp-"));
  fs.mkdirSync(path.join(proj, ".wolf"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".wolf", "memory.md"), "| 10:00 | fixed the widget bug | f | ok | 1k |\n");
  const opts = { projectDir: proj, version: "9.9.9" };

  const init = handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, opts);
  assert.equal(init.result.serverInfo.name, "openwolf");
  assert.equal(init.result.serverInfo.version, "9.9.9");
  assert.equal(init.result.protocolVersion, "2025-06-18");

  const list = handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, opts);
  assert.equal(list.result.tools.length, MCP_TOOLS.length);
  assert.ok(list.result.tools.some((t) => t.name === "openwolf_recall"));

  const call = handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "openwolf_recall", arguments: { query: "widget" } } }, opts);
  assert.equal(call.result.isError, false);
  assert.ok(call.result.content[0].text.includes("widget"));

  // notification → no reply
  assert.equal(handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, opts), null);
  // unknown tool → isError text result
  const bad = handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } }, opts);
  assert.equal(bad.result.isError, true);
  // unknown method with id → JSON-RPC error
  const unk = handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "foo/bar" }, opts);
  assert.equal(unk.error.code, -32601);
});
