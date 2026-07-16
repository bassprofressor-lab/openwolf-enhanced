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
  findDuplicateEntries,
} from "../dist/src/utils/maintenance.js";
import {
  isSecretFile,
  parseAnatomy,
  readBugLog,
  buildResumeDigest,
  nativeMemoryDir,
} from "../dist/hooks/shared.js";
import { toCSV, collectRows } from "../dist/src/cli/export-cmd.js";
import { splitForContext } from "../dist/src/daemon/cron-engine.js";

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

// --- findDuplicateEntries: near-duplicate consolidation hint ---
test("findDuplicateEntries: flags similar cerebrum entries, ignores distinct + short ones", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "cerebrum.md"),
    "## Key Learnings\n" +
    "- always restart the backend container after changing python dependencies rebuild image first\n" +
    "- remember to restart the backend container whenever python dependencies change rebuild the image\n" +
    "- the dashboard listens on port eighteen thousand seven hundred ninety one by default always\n" +
    "- short one\n");
  const dupes = findDuplicateEntries(w, { threshold: 0.4 });
  assert.equal(dupes.length, 1, "one near-duplicate pair");
  assert.ok(dupes[0].similarity >= 0.4);
  assert.ok(dupes[0].aLine === 2 && dupes[0].bLine === 3, "flags the two restart bullets");
  // unrelated project → no cerebrum → empty, no throw
  assert.deepEqual(findDuplicateEntries(tmpWolf()), []);
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

test("recall: BM25 ranks a rare term above a common one; substring matching preserved", () => {
  const w = tmpWolf();
  // "restart" is common (3 units), "quokka" is rare (1 unit).
  fs.writeFileSync(path.join(w, "memory.md"),
    "| 1 | the daemon restart happened | a | ok | 1k |\n" +
    "| 2 | another daemon restart today | b | ok | 1k |\n" +
    "| 3 | daemon restart number three | c | ok | 1k |\n" +
    "| 4 | quokka anomaly observed once | d | ok | 1k |\n");
  const hits = recall(w, "restart quokka", { limit: 5, includeNative: false });
  assert.ok(hits[0].text.toLowerCase().includes("quokka"), "rare term wins the top slot");
  // substring matching still works: "restar" hits "restart"
  assert.ok(recall(w, "restar", { includeNative: false }).length >= 3, "substring match preserved");
});

// --- consolidate: apply LLM-merged entries to cerebrum ---
import { applyConsolidations } from "../dist/src/cli/consolidate-cmd.js";
test("applyConsolidations: replaces block A with merged text, deletes block B, keeps the rest", () => {
  const content = "## Key Learnings\n- entry alpha detail\n- entry bravo detail\n- unrelated keep me\n";
  // 1-based lines: heading=1, alpha=2, bravo=3, keep=4
  const out = applyConsolidations(content, [{ aStart: 2, aEnd: 2, bStart: 3, bEnd: 3, mergedText: "- merged alpha+bravo" }]);
  assert.ok(out.includes("- merged alpha+bravo"), "merged entry present");
  assert.ok(!out.includes("entry alpha") && !out.includes("entry bravo"), "both duplicates removed");
  assert.ok(out.includes("- unrelated keep me"), "unrelated entry preserved");
  assert.ok(out.includes("## Key Learnings"), "heading preserved");
  // multi-line merged text + two independent merges, applied without index drift
  const c2 = "- a1\n- a2\n- b1\n- b2\n- tail\n";
  const out2 = applyConsolidations(c2, [
    { aStart: 1, aEnd: 1, bStart: 2, bEnd: 2, mergedText: "- A" },
    { aStart: 3, aEnd: 3, bStart: 4, bEnd: 4, mergedText: "- B\n  cont" },
  ]);
  assert.equal(out2, "- A\n- B\n  cont\n- tail\n");
});

// --- recall --all: cross-project search ---
import { recallAcross } from "../dist/src/utils/recall.js";
test("recallAcross: merges hits across projects, tags project, global top-N by score", () => {
  const a = tmpWolf(); const b = tmpWolf();
  fs.writeFileSync(path.join(a, "cerebrum.md"), "- the widget subsystem uses a ring buffer widget widget\n");
  fs.writeFileSync(path.join(b, "cerebrum.md"), "- unrelated note about the widget once\n");
  const hits = recallAcross([{ name: "alpha", wolfDir: a }, { name: "beta", wolfDir: b }], "widget", { limit: 5, includeNative: false });
  assert.ok(hits.length >= 2, "finds hits in both projects");
  assert.equal(hits[0].project, "alpha", "higher term-frequency project ranks first");
  assert.ok(hits.every((h) => h.wolfDir && h.project), "each hit tagged with project + wolfDir");
  // respects the global limit
  assert.ok(recallAcross([{ name: "alpha", wolfDir: a }, { name: "beta", wolfDir: b }], "widget", { limit: 1, includeNative: false }).length === 1);
});

// --- citations + progressive disclosure (entryId / blocksFor / resolveId) ---
import { entryId, blocksFor, resolveId } from "../dist/src/utils/recall.js";
test("entryId: stable, whitespace/case-insensitive, category-prefixed, content-sensitive", () => {
  const a = entryId("cerebrum.md", "  Never  force-push  MAIN ");
  const b = entryId("cerebrum.md", "never force-push main");
  assert.equal(a, b, "normalizes whitespace + case → same id");
  assert.ok(/^c-[0-9a-f]{6}$/.test(a), "prefix c- + 6 hex");
  assert.equal(entryId("memory.md", "x").slice(0, 2), "m-");
  assert.equal(entryId("native/foo.md", "x").slice(0, 2), "n-");
  assert.notEqual(entryId("cerebrum.md", "fact one"), entryId("cerebrum.md", "fact two"), "content edit → new id");
});

test("blocksFor: list items split, wrapped lines fold in, buglog → one block per bug", () => {
  const md = "## Head\n- item one\n  wrapped continuation\n- item two\n\npara line a\npara line b\n";
  const blocks = blocksFor("cerebrum.md", md);
  const texts = blocks.map((b) => b.text);
  assert.ok(texts.includes("## Head"));
  assert.ok(texts.some((t) => t.startsWith("- item one") && t.includes("wrapped continuation")), "continuation folds in");
  assert.ok(texts.includes("- item two"));
  assert.ok(texts.some((t) => t.includes("para line a") && t.includes("para line b")), "paragraph is one block");

  const buglog = JSON.stringify({ bugs: [{ id: "bug-1", error_message: "boom" }, { id: "bug-2", error_message: "bang" }] });
  const bb = blocksFor("buglog.json", buglog);
  assert.equal(bb.length, 2);
});

test("resolveId: recall hit id round-trips to its full block; unknown id → null", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "cerebrum.md"),
    "## Do-Not-Repeat\n- never force-push the main branch under any circumstances\n- daemon port is 18791\n");
  const hits = recall(w, "force-push main", { limit: 5, includeNative: false });
  const hit = hits.find((h) => h.text.includes("force-push"));
  assert.ok(hit && /^c-[0-9a-f]{6}$/.test(hit.id), "hit carries a citation id");
  const entry = resolveId(w, hit.id, { includeNative: false });
  assert.ok(entry, "id resolves");
  assert.equal(entry.file, "cerebrum.md");
  assert.ok(entry.text.includes("never force-push the main branch"), "full block returned");
  // bare id (no prefix) also resolves
  assert.ok(resolveId(w, hit.id.split("-")[1], { includeNative: false }));
  assert.equal(resolveId(w, "c-000000", { includeNative: false }), null);
});

// --- multi-agent hook deployment (Claude + Codex/Gemini/OpenCode) ---
import { deployAgentHooks, detectAgents, _internal } from "../dist/src/utils/agent-hooks.js";
test("agent-hooks: per-agent config shapes, merge preserves user hooks, auto-detect + deploy", () => {
  const claude = _internal.claudeSettings();
  assert.equal(claude.hooks.SessionStart.length, 1);
  assert.equal(claude.hooks.PostToolUse.length, 3); // Read, Write|Edit, Bash
  assert.ok(claude.hooks.SessionStart[0].hooks[0].command.includes("$CLAUDE_PROJECT_DIR/.wolf/hooks/session-start.js"));

  const codex = _internal.codexSettings("/abs/proj");
  assert.ok(codex.hooks.PostToolUse.some((e) => e.matcher === "^apply_patch$"));
  assert.ok(codex.hooks.PostToolUse.some((e) => e.matcher === "^Bash$"));
  assert.ok(codex.hooks.SessionStart[0].hooks[0].command.includes("OPENWOLF_PROJECT_DIR='/abs/proj'"), "codex path single-quoted");
  assert.ok(codex.hooks.SessionStart[0].hooks[0].command.includes("'/abs/proj/.wolf/hooks/session-start.js'"));
  // command injection: a malicious project path is fully single-quoted → inert to the shell
  const evil = _internal.codexSettings(`/tmp/x";$(touch /tmp/pwned)`).hooks.SessionStart[0].hooks[0].command;
  assert.ok(evil.startsWith(`OPENWOLF_PROJECT_DIR='/tmp/x";$(touch /tmp/pwned)'`), "payload wrapped in single quotes");
  // an embedded single-quote is escaped with the POSIX '\'' idiom (no break-out)
  const q = _internal.codexSettings(`/a'b`).hooks.SessionStart[0].hooks[0].command;
  assert.ok(q.includes(`'/a'\\''b'`), "embedded single-quote escaped");

  const gem = _internal.geminiSettings();
  assert.ok(gem.hooks.AfterTool.some((e) => e.matcher === "run_shell_command"));
  assert.ok(gem.hooks.SessionEnd, "Stop maps to SessionEnd");
  assert.ok(gem.hooks.SessionStart[0].hooks[0].command.includes("$GEMINI_PROJECT_DIR"));

  const plugin = _internal.opencodePlugin("/abs/proj");
  assert.ok(plugin.includes("tool.execute.after") && plugin.includes("experimental.session.compacting"));
  assert.ok(plugin.includes('"/abs/proj"'));

  // merge: replace the previous managed entry, preserve BOTH a normal user hook and a user hook that
  // happens to invoke a .wolf/hooks/ script (L3 — only _managedBy entries are ours).
  const existing = { hooks: { SessionStart: [
    { hooks: [{ type: "command", command: "echo user-hook" }] },
    { hooks: [{ type: "command", command: 'node "$X/.wolf/hooks/my-own.js"' }] }, // user's own — must survive
    { hooks: [{ type: "command", _managedBy: "openwolf", command: 'node "$CLAUDE_PROJECT_DIR/.wolf/hooks/session-start.js"' }] },
  ] } };
  const merged = _internal.mergeManagedHooks(existing, _internal.claudeSettings());
  const ss = merged.hooks.SessionStart;
  assert.ok(ss.some((e) => e.hooks[0].command === "echo user-hook"), "user hook preserved");
  assert.ok(ss.some((e) => e.hooks[0].command.includes("my-own.js")), "user's own .wolf/hooks hook preserved (L3)");
  assert.equal(ss.filter((e) => e.hooks.some((h) => h._managedBy === "openwolf")).length, 1, "exactly one managed entry (no dup)");

  // auto-detect + deploy into a temp project
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owagent-"));
  fs.mkdirSync(path.join(root, ".codex"));
  fs.mkdirSync(path.join(root, ".gemini"));
  fs.mkdirSync(path.join(root, ".opencode"));
  assert.deepEqual(detectAgents(root).sort(), ["codex", "gemini", "opencode"]);
  const results = deployAgentHooks(root);
  assert.ok(results.find((r) => r.agent === "claude").deployed);
  assert.ok(fs.existsSync(path.join(root, ".claude", "settings.json")));
  assert.ok(fs.existsSync(path.join(root, ".codex", "hooks.json")));
  assert.ok(fs.existsSync(path.join(root, ".gemini", "settings.json")));
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugin", "openwolf.js")));
});

// --- resume digest i18n (en default, de) ---
import { resumeLang } from "../dist/hooks/shared.js";
test("resume digest i18n: config lang + OPENWOLF_LANG env; localizes headers/preamble", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "STATUS.md"), "# STATUS\nWe are mid-migration; next step is the auth cutover.\n");

  // default → English
  assert.equal(resumeLang(w), "en");
  const en = buildResumeDigest(w);
  assert.ok(en.includes("resume point") && en.includes("resume context"), "English labels");

  // config lang: de → German
  fs.writeFileSync(path.join(w, "config.json"), JSON.stringify({ openwolf: { lang: "de" } }));
  assert.equal(resumeLang(w), "de");
  const de = buildResumeDigest(w);
  assert.ok(de.includes("Wiedereinstiegspunkt") && de.includes("Wiedereinstiegs-Kontext"), "German labels");
  assert.ok(!de.includes("resume point"), "no English leakage");

  // env overrides config
  process.env.OPENWOLF_LANG = "en-US";
  try { assert.equal(resumeLang(w), "en"); } finally { delete process.env.OPENWOLF_LANG; }
});

// --- LLM provider abstraction (cron AI tasks) ---
import { llmConfigFrom, buildLlmRequest, parseLlmResponse, wasTruncated, assertSafeBaseUrl, requiresApiKey, isLocalEndpoint } from "../dist/src/daemon/llm-provider.js";
import { explainLlmError } from "../dist/src/cli/llm-cmd.js";
test("llm-provider: assertSafeBaseUrl blocks SSRF / cleartext key exfil", () => {
  assertSafeBaseUrl("https://api.groq.com/openai/v1"); // ok
  assertSafeBaseUrl("http://localhost:11434/v1");       // ok: local model
  assertSafeBaseUrl("http://127.0.0.1:1234/v1");        // ok: loopback
  assert.throws(() => assertSafeBaseUrl("http://attacker.tld/collect"), /https/, "remote http rejected");
  assert.throws(() => assertSafeBaseUrl("http://169.254.169.254/latest"), /https|private/, "cloud metadata rejected");
  assert.throws(() => assertSafeBaseUrl("https://10.0.0.5/v1"), /private/, "private ip rejected");
  assert.throws(() => assertSafeBaseUrl("ftp://x/y"), /http/, "non-http scheme rejected");
  // buildLlmRequest enforces it
  assert.throws(() => buildLlmRequest(llmConfigFrom({ llm_provider: "openai", llm_base_url: "http://evil.tld", api_key_env: "X" }), "k", "hi"));
});
test("llm-provider: defaults to Anthropic; openai override; request/response shapes", () => {
  // default (no cron config) → Anthropic, historical model + key env
  const def = llmConfigFrom(undefined);
  assert.equal(def.provider, "anthropic");
  assert.equal(def.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.match(def.baseUrl, /api\.anthropic\.com/);

  // OpenAI-compatible provider (e.g. Groq) via config
  const groq = llmConfigFrom({ llm_provider: "openai", llm_base_url: "https://api.groq.com/openai/v1/", llm_model: "llama-3.3-70b-versatile", api_key_env: "GROQ_API_KEY" });
  assert.equal(groq.provider, "openai");
  assert.equal(groq.baseUrl, "https://api.groq.com/openai/v1"); // trailing slash trimmed
  assert.equal(groq.model, "llama-3.3-70b-versatile");
  assert.equal(groq.apiKeyEnv, "GROQ_API_KEY");

  // Anthropic request shape
  const ar = buildLlmRequest(def, "sk-ant", "hello");
  assert.ok(ar.url.endsWith("/messages"));
  assert.equal(ar.headers["x-api-key"], "sk-ant");
  assert.ok(ar.headers["anthropic-version"]);
  assert.ok(!("authorization" in ar.headers));

  // OpenAI request shape
  const or = buildLlmRequest(groq, "gsk_x", "hello");
  assert.ok(or.url.endsWith("/chat/completions"));
  assert.equal(or.headers.authorization, "Bearer gsk_x");
  assert.equal(JSON.parse(or.body).stream, false);

  // Response parsing for both
  assert.equal(parseLlmResponse("anthropic", { content: [{ type: "text", text: " hi " }] }), "hi");
  assert.equal(parseLlmResponse("openai", { choices: [{ message: { content: " yo " } }] }), "yo");
  assert.equal(parseLlmResponse("openai", {}), ""); // malformed → empty, no throw

  // Reasoning models burn max_tokens on hidden reasoning and return HTTP 200 with EMPTY content.
  // That must raise, not return "" — otherwise consolidate skips every merge and `llm --test` says ✓.
  assert.throws(
    () => parseLlmResponse("openai", { choices: [{ message: { content: "" }, finish_reason: "length" }] }),
    /max_tokens/,
    "openai: truncated before any answer → throw",
  );
  assert.throws(
    () => parseLlmResponse("anthropic", { content: [], stop_reason: "max_tokens" }),
    /max_tokens/,
    "anthropic: truncated before any answer → throw",
  );
  // Truncated AFTER saying something is still usable — keep the text, do not throw.
  assert.equal(
    parseLlmResponse("openai", { choices: [{ message: { content: "partial " }, finish_reason: "length" }] }),
    "partial",
  );

  // …but a caller that OVERWRITES A FILE must be able to see that it was cut off: half a cerebrum.md
  // still contains "# Cerebrum" and would be written over the complete one. wasTruncated() says so.
  assert.equal(wasTruncated("openai", { choices: [{ finish_reason: "length" }] }), true);
  assert.equal(wasTruncated("openai", { choices: [{ finish_reason: "stop" }] }), false);
  assert.equal(wasTruncated("anthropic", { stop_reason: "max_tokens" }), true);
  assert.equal(wasTruncated("anthropic", { stop_reason: "end_turn" }), false);
});
test("llm-provider: local model server needs no API key, and sends no auth header", () => {
  const ollama = llmConfigFrom({ llm_provider: "openai", llm_base_url: "http://localhost:11434/v1", llm_model: "qwen3:22b" });
  assert.equal(isLocalEndpoint(ollama.baseUrl), true);
  assert.equal(requiresApiKey(ollama), false, "loopback endpoint must not demand a key");

  // Keyless request: no Authorization header at all (not an empty "Bearer ").
  const r = buildLlmRequest(ollama, "", "hi");
  assert.ok(!("authorization" in r.headers), "no auth header when key is empty");
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(JSON.parse(r.body).model, "qwen3:22b");

  // A key is still sent if the user has one set (some local servers are configured to require it).
  assert.equal(buildLlmRequest(ollama, "tok", "hi").headers.authorization, "Bearer tok");

  // Remote providers still require a key — this must not have been loosened for everyone.
  assert.equal(requiresApiKey(llmConfigFrom(undefined)), true, "anthropic still needs a key");
  assert.equal(requiresApiKey(llmConfigFrom({ llm_provider: "openai", llm_base_url: "https://api.groq.com/openai/v1" })), true);
  assert.equal(isLocalEndpoint("https://evil.tld/localhost"), false, "path, not host");
  assert.equal(isLocalEndpoint("https://localhost.evil.tld/v1"), false, "suffix trick rejected");
});
test("splitForContext: keeps every byte — a big file is split, never truncated (bug-157)", () => {
  // The bug: cerebrum.md (78 KB) was cut to its last 20 KB and the model was asked for "the cleaned
  // file", which would have deleted the other 58 KB. Splitting must therefore be LOSSLESS.
  const paras = Array.from({ length: 60 }, (_, i) => `## Section ${i}\n- fact ${i} that must survive`);
  const text = paras.join("\n\n");
  const chunks = splitForContext(text, 500);

  assert.ok(chunks.length > 1, "oversized text is actually split");
  for (const c of chunks) assert.ok(Buffer.byteLength(c, "utf-8") <= 500 || !c.includes("\n\n"), "chunks respect the cap");
  // Every original fact still exists somewhere — nothing was dropped on the floor.
  const joined = chunks.join("\n\n");
  for (let i = 0; i < 60; i++) assert.ok(joined.includes(`fact ${i} that must survive`), `fact ${i} survived the split`);
  assert.equal(joined, text, "round-trips exactly: split is lossless, not lossy");

  // Small input is passed through untouched — no needless chunking.
  assert.deepEqual(splitForContext("short", 500), ["short"]);
});

test("llm-cmd: errors name the actual fix", () => {
  const ollama = llmConfigFrom({ llm_provider: "openai", llm_base_url: "http://localhost:11434/v1", llm_model: "qwen3:22b" });
  const refused = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.match(explainLlmError(ollama, refused), /ssh -N -R 11434:localhost:11434/, "local + refused → port-forward hint");
  assert.match(explainLlmError(ollama, new Error("openai API error (qwen3:22b) 404: model not found")), /ollama pull qwen3:22b/);

  // The forwarded port must come from the configured base_url, not a hard-coded 11434 — LM Studio is
  // on 1234, and telling that user to forward 11434 forwards a port nothing listens on.
  const lmstudio = llmConfigFrom({ llm_provider: "openai", llm_base_url: "http://127.0.0.1:1234/v1", llm_model: "qwen/qwen3.6-27b" });
  assert.match(explainLlmError(lmstudio, refused), /ssh -N -R 1234:localhost:1234/, "port is read from base_url");
  assert.doesNotMatch(explainLlmError(lmstudio, refused), /11434/, "no Ollama port leaks into an LM Studio hint");
  // A 404 means "server up, model unknown" — do not tell an LM Studio user to run `ollama pull`.
  const notFound = explainLlmError(lmstudio, new Error("openai API error (qwen/qwen3.6-27b) 404: model not found"));
  assert.match(notFound, /curl http:\/\/127\.0\.0\.1:1234\/v1\/models/, "404 → show how to list the real ids");

  const groq = llmConfigFrom({ llm_provider: "openai", llm_base_url: "https://api.groq.com/openai/v1", api_key_env: "GROQ_API_KEY" });
  assert.match(explainLlmError(groq, refused), /Cannot reach https:\/\/api\.groq\.com/, "remote + refused → no ssh advice");
  assert.match(explainLlmError(groq, new Error("... 401: invalid key")), /GROQ_API_KEY/);
});

// --- Bash activity capture (opt-in) helpers ---
import {
  getCaptureConfig, redactSecrets, isNotableCommand, tailWithinBytes, activityTail,
} from "../dist/hooks/shared.js";
test("capture: opt-in config, secret redaction, notable-command filter, tail cap", () => {
  const w = tmpWolf();
  // default: no config → disabled, default cap
  assert.deepEqual(getCaptureConfig(w), { enabled: false, logMaxBytes: 131072 });
  fs.writeFileSync(path.join(w, "config.json"), JSON.stringify({ openwolf: { capture: { enabled: true, log_max_bytes: 4096 } } }));
  assert.deepEqual(getCaptureConfig(w), { enabled: true, logMaxBytes: 4096 });

  // redaction — including the bypasses the security review flagged
  const R = redactSecrets;
  assert.ok(!R("git push https://ghp_ABCDEFGHIJKLMNOP0123@x").includes("ghp_ABCDEFGHIJKLMNOP0123"));
  assert.ok(R("export API_KEY=supersecretvalue").endsWith("API_KEY=***"));
  assert.ok(!R("anthropic --key sk-ant-api03-abcdefghijklmnop").includes("api03-abcdefghijklmnop"), "sk-ant (dashes)");
  assert.ok(!R("export DB_PASS=hunter2hunter2").includes("hunter2"), "PASS suffix");
  assert.ok(!R("psql postgres://admin:Sup3rSecret@db/prod").includes("Sup3rSecret"), "url creds");
  assert.ok(!R('curl -H "x-api-key: sk-XYZ1234567890abcd"').includes("XYZ1234567890abcd"), "header form");
  assert.ok(!R("curl -u alice:topsecretpw https://x").includes("topsecretpw"), "basic auth");
  assert.equal(R("npm run build"), "npm run build"); // untouched
  // no catastrophic backtracking on a long adversarial input
  const t0 = Date.now(); R("A".repeat(100000) + "=x"); assert.ok(Date.now() - t0 < 500, "redaction stays linear");

  // notable filter
  assert.ok(isNotableCommand("git commit -m 'x'"));
  assert.ok(isNotableCommand("pnpm build && pnpm test"));
  assert.ok(!isNotableCommand("ls -la"));
  assert.ok(!isNotableCommand("git status"));
  assert.ok(!isNotableCommand("cat package.json | grep name"));

  // tail cap drops leading lines
  const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const capped = tailWithinBytes(many, 40);
  assert.ok(Buffer.byteLength(capped) <= 40);
  assert.ok(capped.includes("line 99"), "keeps the newest tail");

  // activityTail reads last N lines
  fs.writeFileSync(path.join(w, "activity.log"), "10:00  a\n10:01  b\n10:02  c\n");
  assert.equal(activityTail(w, 2), "10:01  b\n10:02  c");
  assert.equal(activityTail(tmpWolf()), ""); // absent → empty
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

// --- aggregateNativeMemory: cross-project rollup ---
import { aggregateNativeMemory } from "../dist/src/utils/maintenance.js";
test("aggregateNativeMemory: per-project health, missing memory → available:false", () => {
  const nd = fs.mkdtempSync(path.join(os.tmpdir(), "ownm5-"));
  fs.writeFileSync(path.join(nd, "MEMORY.md"), "# Index\n- [A](existing.md) — x\n");
  fs.writeFileSync(path.join(nd, "existing.md"), "content\n");
  fs.writeFileSync(path.join(nd, "orphan.md"), "not indexed\n");
  // p1 resolves to a real native dir; p2 has none (resolver → null); p3 throws (swallowed).
  const resolve = (root) => {
    if (root === "/p1") return nd;
    if (root === "/p3") throw new Error("boom");
    return null;
  };
  const rows = aggregateNativeMemory(
    [{ root: "/p1", name: "p1" }, { root: "/p2", name: "p2" }, { root: "/p3", name: "p3" }],
    resolve
  );
  assert.equal(rows.length, 3);
  const p1 = rows.find((r) => r.name === "p1");
  assert.equal(p1.available, true);
  assert.equal(p1.health.topicFiles, 2);
  assert.equal(p1.health.orphanCount, 1);
  const p2 = rows.find((r) => r.name === "p2");
  assert.equal(p2.available, false);
  assert.equal(p2.health, null);
  const p3 = rows.find((r) => r.name === "p3");
  assert.equal(p3.available, false); // resolver threw → treated as unavailable, no crash
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

// --- Remote workspace bridge (link/push/recall --team) ---
import {
  cerebrumCandidates, buglogCandidates, titleFor, teamId, teamCiteFromId,
  getRemoteConfig, setRemoteConfig, isLinked, writeRemoteToken, readRemoteToken,
  readPushed, markPushed,
} from "../dist/src/utils/remote.js";
import { ensureWolfGitignore } from "../dist/src/utils/wolf-gitignore.js";

test("remote: what gets offered to the team, and what never leaves the machine", () => {
  const cerebrum = [
    "## User Preferences",
    "- The user prefers German and hates emoji in commit messages, always ask before deploying.",
    "",
    "## Key Learnings",
    "- **Docker bind-mounts on a FILE break on atomic writes** — the container keeps the old inode, so a reload silently reads stale config.",
    "- <private>The production root password is hunter2hunter2 and must never be shared with anyone.</private>",
    "- short",
    "",
    "## Decision Log",
    "- We chose Postgres over Mongo because every table is workspace-scoped and we need real joins.",
    "",
    "## Notes",
    "- This section maps to nothing and must be ignored entirely by the pusher.",
  ].join("\n");

  const c = cerebrumCandidates(cerebrum);
  const types = c.map((x) => x.type).sort();
  assert.deepEqual(types, ["decision", "learning"], "only Key Learnings + Decision Log by default");

  const blob = JSON.stringify(c);
  assert.ok(!blob.includes("hunter2"), "<private> content must never reach a candidate");
  assert.ok(!blob.includes("emoji"), "User Preferences are personal — skipped by default");
  assert.ok(!blob.includes("This section maps to nothing"), "unmapped sections are ignored");
  assert.ok(!c.some((x) => x.body === "short"), "one-liners are not worth a team entry");
  assert.ok(c.every((x) => x.localId.startsWith("c-")), "candidates carry their local citation id");

  // opt-in preferences
  const withPrefs = cerebrumCandidates(cerebrum, { withPreferences: true });
  assert.ok(withPrefs.some((x) => x.type === "note" && x.tags.includes("preference")));
  assert.ok(!JSON.stringify(withPrefs).includes("hunter2"), "private stays private even with --with-preferences");

  // buglog → type "bug"; auto-detected guesses are not knowledge
  const bugs = buglogCandidates({ bugs: [
    { id: "bug-1", error_message: "nginx reload read stale config", file: "nginx.conf", root_cause: "inode drift", fix: "docker restart", tags: ["nginx"] },
    { id: "bug-2", error_message: "auto guess", fix: "changed x → y", tags: ["auto-detected"] },
    { id: "bug-3", error_message: "no fix recorded" },
  ]});
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].type, "bug");
  assert.ok(bugs[0].body.includes("Root cause: inode drift"));

  // titles are stripped of markdown noise
  assert.equal(titleFor("- **Bold thing** happened"), "Bold thing happened");
});

test("remote: team citation ids cannot collide with local ones", () => {
  // Both systems mint `c-3f9a2b`-shaped ids from different hashes over different text.
  assert.equal(teamId("c-3f9a2b"), "t-3f9a2b");
  assert.equal(teamCiteFromId("t-3f9a2b"), "c-3f9a2b");
  assert.equal(teamCiteFromId(teamId("c-abc123")), "c-abc123", "round-trips");
  assert.equal(teamId(null), "t-?");
  // A cite pasted straight from the workspace web UI is already `c-…` — must not become `c-c-…`.
  assert.equal(teamCiteFromId("c-8f06e6"), "c-8f06e6");
});

test("remote: link state, token never in config.json, gitignore protects it", () => {
  const w = tmpWolf();

  assert.equal(getRemoteConfig(w), null, "unlinked by default");
  assert.equal(isLinked(w), false);

  setRemoteConfig(w, { enabled: true, base_url: "https://wolfpack.example.com", project: "orderflow" });
  writeRemoteToken(w, "owp_deadbeef");

  const cfg = getRemoteConfig(w);
  assert.equal(cfg.baseUrl, "https://wolfpack.example.com");
  assert.equal(cfg.project, "orderflow");
  assert.equal(isLinked(w), true);
  assert.equal(readRemoteToken(w), "owp_deadbeef");

  // The token must never be written into config.json — that file gets committed.
  const raw = fs.readFileSync(path.join(w, "config.json"), "utf8");
  assert.ok(!raw.includes("owp_deadbeef"), "token must not land in config.json");
  assert.equal(fs.statSync(path.join(w, "remote-token")).mode & 0o777, 0o600, "token file is 0600");

  // …and 0600 does nothing against `git add`, so it must be ignored too.
  assert.equal(ensureWolfGitignore(w), "created");
  const gi = fs.readFileSync(path.join(w, ".gitignore"), "utf8");
  assert.ok(gi.includes("remote-token"));
  assert.ok(gi.includes("dashboard-token"));
  assert.equal(ensureWolfGitignore(w), "ok", "idempotent");

  // push bookkeeping: an entry offered once is not offered again
  assert.equal(readPushed(w).size, 0);
  markPushed(w, ["c-aaa111", "c-bbb222"]);
  markPushed(w, ["c-aaa111"]);
  assert.deepEqual([...readPushed(w)].sort(), ["c-aaa111", "c-bbb222"]);
});

// --- Shell writes: the edits post-write.ts can never see (bug-149) ---
import { isFileWritingCommand } from "../dist/hooks/shared.js";
test("bash writes: heredocs/redirects/in-place edits count, inspection and scratch do not", () => {
  const W = isFileWritingCommand;

  // writes
  assert.ok(W("cat > src/app.ts <<'EOF'\nconst x = 1\nEOF"), "heredoc into file");
  assert.ok(W("echo 'x' >> .env.example"), "append redirect");
  assert.ok(W("sed -i 's/foo/bar/' src/a.ts"), "sed -i");
  assert.ok(W("sed --in-place=.bak 's/a/b/' f.md"), "sed --in-place");
  assert.ok(W("perl -pi -e 's/a/b/' f.md"), "perl -i");
  assert.ok(W("cp dist/x.js dist/y.js"), "cp");
  assert.ok(W("mv old.ts new.ts"), "mv");
  assert.ok(W("git apply patch.diff"), "git apply");
  assert.ok(W("echo hi | tee -a CHANGELOG.md"), "tee");
  assert.ok(W("node -e \"fs.writeFileSync('a.json', '{}')\""), "node -e writeFileSync");
  assert.ok(W("python3 -c \"open('out.txt', 'w').write('x')\""), "python open(...,'w')");

  // not writes — inspection, and scratch/device targets
  assert.ok(!W("ls -la"), "ls");
  assert.ok(!W("grep -rn foo src/"), "grep");
  assert.ok(!W("git status && git log --oneline -3"), "git read-only");
  assert.ok(!W("pnpm build && pnpm test"), "build/test write dist, but are not authored edits");
  assert.ok(!W("curl -s localhost:3000/api/health 2>/dev/null"), "fd-prefixed redirect to /dev/null");
  assert.ok(!W("node script.js > /dev/null 2>&1"), "/dev/null + fd-dup");
  assert.ok(!W("echo x > /tmp/scratch.txt"), "scratch dir is not project work");
  assert.ok(!W("python3 -c \"print(open('a.json').read())\""), "open() for reading");
  assert.ok(!W("cat pkg.json | tee /dev/null"), "tee /dev/null");
});

// --- recall: malformed buglog.json must not crash (bug: TypeError on `null` outside the try) ---
test("recall: buglog.json = 'null' does not crash", () => {
  const wolf = tmpWolf();
  fs.writeFileSync(path.join(wolf, "buglog.json"), "null");
  fs.writeFileSync(path.join(wolf, "memory.md"), "- fixed the port forwarding issue\n");
  // Before the guard, unitsFor() did `(null).bugs` and threw a TypeError here.
  assert.doesNotThrow(() => recall(wolf, "port"));
});

test("recall: buglog.json = number/string is ignored, other sources still searched", () => {
  const wolf = tmpWolf();
  fs.writeFileSync(path.join(wolf, "buglog.json"), "42");
  fs.writeFileSync(path.join(wolf, "memory.md"), "- the widget alignment bug is fixed\n");
  let hits;
  assert.doesNotThrow(() => { hits = recall(wolf, "widget"); });
  assert.ok(hits.some((h) => h.file === "memory.md"), "markdown source still matched");
});

// --- readTranscriptUsage: sum real usage, dedupe by message id, skip garbage (F1) ---
import { readTranscriptUsage } from "../dist/hooks/shared.js";
test("readTranscriptUsage: sums usage, keeps last per id, counts distinct calls", () => {
  const wolf = tmpWolf();
  const tp = path.join(wolf, "transcript.jsonl");
  fs.writeFileSync(tp, [
    JSON.stringify({ message: { id: "m1", usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 } } }),
    JSON.stringify({ message: { id: "m1", usage: { input_tokens: 1200, output_tokens: 450, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 } } }), // same id → replaces
    JSON.stringify({ message: { id: "m2", usage: { input_tokens: 50, output_tokens: 120, cache_read_input_tokens: 9700, cache_creation_input_tokens: 0 } } }),
    "{ not valid json",
    "",
  ].join("\n"));
  const u = readTranscriptUsage(tp);
  assert.equal(u.api_calls, 2, "two distinct message ids");
  assert.equal(u.input_tokens, 1250);
  assert.equal(u.output_tokens, 570, "m1 deduped to its last output (450), not summed");
  assert.equal(u.cache_read_input_tokens, 17700);
  assert.equal(u.cache_creation_input_tokens, 500);
});

test("readTranscriptUsage: missing file or no usage → null", () => {
  assert.equal(readTranscriptUsage("/no/such/transcript.jsonl"), null);
  const wolf = tmpWolf();
  const tp = path.join(wolf, "empty.jsonl");
  fs.writeFileSync(tp, JSON.stringify({ message: { id: "x", role: "user" } }) + "\n");
  assert.equal(readTranscriptUsage(tp), null, "no usage blocks → null");
});

// --- extractSymbols: top-level decls with line ranges (symbol-level anatomy) ---
import { extractSymbols, symbolsSupported } from "../dist/src/scanner/symbol-extractor.js";
test("extractSymbols: TS fn/class/const-arrow/interface with ranges", () => {
  const src = [
    "// header",                                   // 1
    "export interface Config { a: number }",       // 2
    "export function parse(x: string) {",          // 3
    "  return x.trim();",                          // 4
    "}",                                           // 5
    "export const build = async (o) => {",         // 6
    "  return o;",                                 // 7
    "}",                                           // 8
    "export class Engine {",                       // 9
    "  run() { return 1; }",                       // 10
    "}",                                           // 11
  ].join("\n");
  const syms = extractSymbols(src, ".ts");
  const byName = Object.fromEntries(syms.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ["Config", "Engine", "build", "parse"]);
  assert.equal(byName.Config.kind, "section");
  assert.equal(byName.parse.kind, "fn");
  assert.equal(byName.build.kind, "fn");        // const arrow
  assert.equal(byName.Engine.kind, "class");
  assert.equal(byName.parse.startLine, 3);
  assert.equal(byName.parse.endLine, 5);        // line before next symbol (build @6)
  assert.equal(byName.Engine.endLine, 11);      // last symbol → end of file
});

test("extractSymbols: unsupported ext → [] and symbolsSupported reflects it", () => {
  assert.equal(symbolsSupported(".ts"), true);
  assert.equal(symbolsSupported(".md"), false);
  assert.deepEqual(extractSymbols("anything\nhere", ".md"), []);
});

// --- reconcileProjectPorts: unique dashboard/daemon port pair per registered project ---
import { reconcileProjectPorts } from "../dist/src/utils/ports.js";
test("reconcileProjectPorts: reassigns a colliding project, leaves the first + non-colliders", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owports-"));
  const mk = (name, port) => {
    const root = path.join(home, name);
    fs.mkdirSync(path.join(root, ".wolf"), { recursive: true });
    fs.writeFileSync(path.join(root, ".wolf", "config.json"),
      JSON.stringify({ openwolf: { daemon: { port: port - 1 }, dashboard: { port, host: "127.0.0.1" } } }));
    return root;
  };
  const a = mk("a", 18791), b = mk("b", 18791), c = mk("c", 18795); // a & b collide, c is unique
  fs.mkdirSync(path.join(home, ".openwolf"), { recursive: true });
  fs.writeFileSync(path.join(home, ".openwolf", "registry.json"), JSON.stringify({
    version: 1, projects: [a, b, c].map((root, i) => ({ root, name: "abc"[i], registered_at: "x", last_updated: "x", version: "1" })),
  }));

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const changes = reconcileProjectPorts(false);
    const port = (root) => JSON.parse(fs.readFileSync(path.join(root, ".wolf", "config.json"), "utf8")).openwolf.dashboard.port;
    assert.equal(port(a), 18791, "first keeps its port");
    assert.notEqual(port(b), 18791, "collider b was moved");
    assert.equal(port(b) % 2, 1, "b's new dashboard port stays odd");
    assert.equal(port(c), 18795, "non-collider c unchanged");
    assert.ok(changes.some((x) => x.name === "b"), "b reported as changed");
    assert.ok(!changes.some((x) => x.name === "a" || x.name === "c"), "a/c not reported");
    // config structure preserved (host still there)
    assert.equal(JSON.parse(fs.readFileSync(path.join(b, ".wolf", "config.json"), "utf8")).openwolf.dashboard.host, "127.0.0.1");
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});
