/**
 * Tests for the fixes in 1.28.2 — every one of them written against the BROKEN behaviour first,
 * so a regression fails here instead of going unnoticed for months. The findings came from a
 * four-way model audit; each was verified against real project data before anything was changed,
 * and these tests encode what "verified" meant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `openwolf-${n}-`));

import { capBuglogWithArchive, extractMarkdownSection, maskPrivate, replaceOrAppendMarkdown } from "../dist/hooks/shared.js";
import { dedupeAndCapBuglog } from "../dist/src/utils/maintenance.js";
import { assertAllowedApiKeyEnv, assertTrustedLlmHost } from "../dist/src/daemon/llm-provider.js";
import { readRemoteToken, writeRemoteToken } from "../dist/src/utils/remote.js";
import { safeCopyFile } from "../dist/src/utils/fs-safe.js";
import { nativeMemoryHealth } from "../dist/src/utils/maintenance.js";

const mkBugs = (n, auto = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `bug-${String(i + 1).padStart(3, "0")}`,
    file: "a.ts",
    tags: i < auto ? ["auto-detected", "guard"] : ["manual"],
  }));

// ── buglog: overflow is moved, never dropped ────────────────────────────────────────────────
test("capBuglogWithArchive keeps the cap and loses nothing", () => {
  const dir = tmp("buglog");
  const { kept, archived } = capBuglogWithArchive(dir, mkBugs(250), 200);
  assert.equal(kept.length, 200);
  assert.equal(archived.length, 50);
  assert.equal(kept[0].id, "bug-051", "the cap trims from the front…");
  const arch = JSON.parse(fs.readFileSync(path.join(dir, "buglog-archive.json"), "utf8"));
  assert.equal(arch.bugs.length, 50, "…and everything trimmed is in the archive");
  assert.equal(arch.bugs[0].id, "bug-001");
  const all = new Set([...kept, ...arch.bugs].map((b) => b.id));
  assert.equal(all.size, 250, "no entry disappeared");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auto-detected noise is spent before a curated entry is touched", () => {
  const dir = tmp("buglog2");
  const { kept, archived } = capBuglogWithArchive(dir, mkBugs(210, 10), 200);
  assert.equal(archived.length, 10);
  assert.ok(archived.every((b) => b.tags.includes("auto-detected")), "only auto entries archived");
  assert.ok(kept.every((b) => !b.tags.includes("auto-detected")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the doctor path archives too — it used to delete curated entries outright", () => {
  const dir = tmp("buglog3");
  fs.writeFileSync(path.join(dir, "buglog.json"), JSON.stringify({ version: 1, bugs: mkBugs(295, 1) }));
  dedupeAndCapBuglog(dir, 200);
  const left = JSON.parse(fs.readFileSync(path.join(dir, "buglog.json"), "utf8")).bugs;
  const arch = JSON.parse(fs.readFileSync(path.join(dir, "buglog-archive.json"), "utf8")).bugs;
  assert.equal(left.length, 200);
  assert.equal(arch.length, 95);
  assert.equal(left.length + arch.length, 295, "295 in, 295 out");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the archive does not duplicate an id that is already in it", () => {
  const dir = tmp("buglog4");
  capBuglogWithArchive(dir, mkBugs(210), 200);
  capBuglogWithArchive(dir, mkBugs(210), 200);
  const arch = JSON.parse(fs.readFileSync(path.join(dir, "buglog-archive.json"), "utf8")).bugs;
  assert.equal(arch.length, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── cerebrum section lookup ─────────────────────────────────────────────────────────────────
test("a prose mention of the heading no longer wins over the heading itself", () => {
  const md = [
    "## Key Learnings",
    "- We noted this under `## Do-Not-Repeat (cont.)` last week, which is prose, not a heading.",
    "- Another learning.",
    "",
    "## Do-Not-Repeat",
    "- Never copy config.py to server 2.",
    "- Never use rm -rf on the data volume.",
    "",
    "## Decision Log",
    "- Something else entirely.",
  ].join("\n");
  const section = extractMarkdownSection(md, /^#{2,3}\s*Do[-\s]?Not[-\s]?Repeat/i);
  const entries = section.split("\n").filter((l) => l.trim().startsWith("-"));
  assert.equal(entries.length, 2, "the real section, not the sentence that quotes it");
  assert.ok(section.includes("config.py"));
  assert.ok(!section.includes("Another learning"));
  assert.ok(!section.includes("Something else entirely"), "stops at the next same-level heading");
});

// ── private blocks on the display path ──────────────────────────────────────────────────────
test("maskPrivate hides the secret and says that it did", () => {
  const out = maskPrivate("before\n<private>\nDB_PASSWORD=hunter2\n</private>\nafter");
  assert.ok(!out.includes("hunter2"), "the secret is gone");
  assert.ok(out.includes("[private — hidden by OpenWolf]"), "and the reader can tell");
  assert.ok(out.includes("before") && out.includes("after"));
});

// ── memory.md: replace, do not pile up ──────────────────────────────────────────────────────
test("the session-end row is replaced, not appended a second time", () => {
  const dir = tmp("memory");
  const p = path.join(dir, "memory.md");
  fs.writeFileSync(p, "# Memory\n\n| 10:00 | earlier work | ok |\n");
  const first = "| 10:05 | Session end: 1 writes | 0 reads |\n";
  const second = "| 10:09 | Session end: 4 writes | 2 reads |\n";
  replaceOrAppendMarkdown(p, "", first);
  replaceOrAppendMarkdown(p, first, second);
  const out = fs.readFileSync(p, "utf8");
  assert.equal((out.match(/Session end:/g) || []).length, 1, "one row, not one per turn");
  assert.ok(out.includes("4 writes"));
  assert.ok(out.includes("earlier work"), "unrelated rows survive");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── LLM allowlists ──────────────────────────────────────────────────────────────────────────
test("a committed config cannot choose which secret is sent", () => {
  assert.doesNotThrow(() => assertAllowedApiKeyEnv("ANTHROPIC_API_KEY"));
  assert.doesNotThrow(() => assertAllowedApiKeyEnv("OPENAI_API_KEY"));
  assert.throws(() => assertAllowedApiKeyEnv("AWS_SECRET_ACCESS_KEY"), /not allowed/);
  assert.throws(() => assertAllowedApiKeyEnv("GITHUB_TOKEN"), /not allowed/);
});

test("a committed config cannot choose where the secret goes", () => {
  assert.doesNotThrow(() => assertTrustedLlmHost("https://api.anthropic.com/v1"));
  assert.doesNotThrow(() => assertTrustedLlmHost("http://localhost:11434/v1"), "local models stay free");
  assert.doesNotThrow(() => assertTrustedLlmHost("http://127.0.0.1:1234/v1"));
  assert.throws(() => assertTrustedLlmHost("https://attacker.example/v1"), /has not agreed/);
});

test("this machine can opt in to another host or key, a repository cannot", () => {
  process.env.OPENWOLF_TRUSTED_LLM_HOSTS = "api.groq.com";
  process.env.OPENWOLF_EXTRA_API_KEY_ENV = "GROQ_API_KEY";
  try {
    assert.doesNotThrow(() => assertTrustedLlmHost("https://api.groq.com/openai/v1"));
    assert.doesNotThrow(() => assertAllowedApiKeyEnv("GROQ_API_KEY"));
  } finally {
    delete process.env.OPENWOLF_TRUSTED_LLM_HOSTS;
    delete process.env.OPENWOLF_EXTRA_API_KEY_ENV;
  }
});

// ── workspace token is bound to its URL ─────────────────────────────────────────────────────
test("a redirected remote.base_url does not get the workspace token", () => {
  const dir = tmp("remote");
  const cfg = (url) => fs.writeFileSync(path.join(dir, "config.json"),
    JSON.stringify({ openwolf: { remote: { enabled: true, base_url: url, project: "p" } } }));

  cfg("https://workspace.example");
  writeRemoteToken(dir, "owp_secret_token", "https://workspace.example");
  assert.equal(readRemoteToken(dir), "owp_secret_token", "the linked host still gets it");

  cfg("https://attacker.example");
  assert.equal(readRemoteToken(dir), "", "a changed base_url gets nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a legacy bare token keeps working", () => {
  const dir = tmp("remote2");
  fs.writeFileSync(path.join(dir, "config.json"),
    JSON.stringify({ openwolf: { remote: { enabled: true, base_url: "https://workspace.example" } } }));
  fs.writeFileSync(path.join(dir, "remote-token"), "plain_old_token");
  assert.equal(readRemoteToken(dir), "plain_old_token");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── atomic hook deployment ──────────────────────────────────────────────────────────────────
test("safeCopyFile never leaves a truncated destination or a temp file behind", () => {
  const dir = tmp("copy");
  const src = path.join(dir, "src.js");
  const dest = path.join(dir, "dest.js");
  fs.writeFileSync(src, "x".repeat(200_000));
  fs.writeFileSync(dest, "old content");
  safeCopyFile(src, dest);
  assert.equal(fs.readFileSync(dest, "utf8").length, 200_000);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")), [], "no leftovers");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the native memory index is measured in bytes ────────────────────────────────────────────
test("a short MEMORY.md with long lines is reported as over budget", () => {
  const dir = tmp("native");
  // 175 lines, well under the 200-line rule, but 30 KB — the shape that actually gets truncated.
  const line = `- [topic](t.md) — ${"x".repeat(160)}\n`;
  fs.writeFileSync(path.join(dir, "MEMORY.md"), line.repeat(175));
  fs.writeFileSync(path.join(dir, "t.md"), "# t\n");
  const h = nativeMemoryHealth(dir);
  assert.ok(h.indexLines <= 200, "the line rule says it is fine");
  assert.ok(h.indexBytesExceeded, "the byte rule catches it");
  assert.ok(h.indexCutoffExceeded, "and the summary flag follows the stricter of the two");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── stop hook survives a half-written session file ──────────────────────────────────────────
function runStop(dir) {
  execFileSync("node", [path.join(repoRoot, "dist", "hooks", "stop.js")], {
    cwd: repoRoot, input: JSON.stringify({ session_id: "abc-123" }), encoding: "utf8",
    env: { ...process.env, OPENWOLF_PROJECT_DIR: dir },
  });
}

test("a session file written by another hook's partial shape does not kill the stop hook", () => {
  const dir = tmp("partial");
  const hooks = path.join(dir, ".wolf", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  // Exactly what post-bash leaves behind when it runs before session-start: no files_read,
  // no session_id. Object.keys(undefined) used to throw, and main().catch() ate it.
  fs.writeFileSync(path.join(hooks, "_session-abc-123.json"),
    JSON.stringify({ files_written: [], edit_counts: {}, bash_writes: 54, external_writes: 12 }));
  runStop(dir);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, ".wolf", "token-ledger.json"), "utf8"));
  assert.equal(ledger.sessions.length, 1, "the session was booked instead of lost");
  assert.equal(ledger.lifetime.total_writes, 66, "54 shell + 12 external writes");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a ledger without sessions[] does not disable the stop hook forever", () => {
  const dir = tmp("stub");
  const wolf = path.join(dir, ".wolf");
  fs.mkdirSync(path.join(wolf, "hooks"), { recursive: true });
  // The stub session-start used to write when the ledger was missing.
  fs.writeFileSync(path.join(wolf, "token-ledger.json"), JSON.stringify({ version: 1, lifetime: { total_sessions: 1 } }));
  fs.writeFileSync(path.join(wolf, "hooks", "_session-abc-123.json"), JSON.stringify({
    session_id: "abc-123", started: new Date().toISOString(), files_read: {},
    files_written: [{ file: "a.ts", action: "Edit", tokens: 10, at: "t" }],
    edit_counts: {}, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_warned: 0,
    cerebrum_warnings: 0, stop_count: 0,
  }));
  runStop(dir);
  const ledger = JSON.parse(fs.readFileSync(path.join(wolf, "token-ledger.json"), "utf8"));
  assert.ok(Array.isArray(ledger.sessions) && ledger.sessions.length === 1, "it recovered");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two sessions started in the same minute keep separate ledger entries", () => {
  const dir = tmp("sameminute");
  const hooks = path.join(dir, ".wolf", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const mk = (harnessId) => ({
    session_id: "session-2026-09-03-1855",      // identical minute id, as session-start writes it
    started: new Date().toISOString(), files_read: {},
    files_written: [{ file: `${harnessId}.ts`, action: "Edit", tokens: 10, at: "t" }],
    edit_counts: {}, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_warned: 0,
    cerebrum_warnings: 0, stop_count: 0,
  });
  for (const id of ["h-A", "h-B"]) {
    fs.writeFileSync(path.join(hooks, `_session-${id}.json`), JSON.stringify(mk(id)));
    execFileSync("node", [path.join(repoRoot, "dist", "hooks", "stop.js")], {
      cwd: repoRoot, input: JSON.stringify({ session_id: id }), encoding: "utf8",
      env: { ...process.env, OPENWOLF_PROJECT_DIR: dir },
    });
  }
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, ".wolf", "token-ledger.json"), "utf8"));
  assert.equal(ledger.sessions.length, 2, "the second stop must not replace the first entry");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("three stops in one session leave ONE session-end row, not three", () => {
  // The helper is tested above in isolation, but the value that makes it work — session.memory_line
  // — is persisted by the stop hook itself. That link is the part that can silently break, so this
  // drives the real compiled hook. Before the fix each turn appended its own near-identical row;
  // one real project had 232 of them for 173 sessions.
  const dir = tmp("sessionend");
  const hooks = path.join(dir, ".wolf", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const file = path.join(hooks, "_session-e2e.json");
  fs.writeFileSync(file, JSON.stringify({
    session_id: "session-2026-09-03-2200", started: new Date().toISOString(), files_read: {},
    files_written: [{ file: "a.ts", action: "Edit", tokens: 10, at: "t" }], edit_counts: {},
    anatomy_hits: 0, anatomy_misses: 0, repeated_reads_warned: 0, cerebrum_warnings: 0, stop_count: 0,
  }));
  for (const turn of [1, 2, 3]) {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    s.files_written.push({ file: `b${turn}.ts`, action: "Edit", tokens: 10, at: "t" });
    fs.writeFileSync(file, JSON.stringify(s));
    execFileSync("node", [path.join(repoRoot, "dist", "hooks", "stop.js")], {
      cwd: repoRoot, input: JSON.stringify({ session_id: "e2e" }), encoding: "utf8",
      env: { ...process.env, OPENWOLF_PROJECT_DIR: dir },
    });
  }
  const memory = fs.readFileSync(path.join(dir, ".wolf", "memory.md"), "utf8");
  assert.equal((memory.match(/Session end:/g) || []).length, 1, "one row for the session");
  assert.match(memory, /4 writes across 4 files/, "and it carries the latest numbers");
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).memory_line, "the row is remembered for the next turn");
  fs.rmSync(dir, { recursive: true, force: true });
});
