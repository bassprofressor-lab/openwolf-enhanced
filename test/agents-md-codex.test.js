import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { upsertMarkerBlock, MARKER_BEGIN, MARKER_END, AGENTS_SNIPPET } from "../dist/src/utils/marker-block.js";
import { deployAgentHooks, _internal } from "../dist/src/utils/agent-hooks.js";

// [2026-08-20] Two gaps against upstream 2.1.0, closed here:
//  1. We never wrote AGENTS.md. On Codex our hooks fired, but the protocol never reached the
//     model — it reads AGENTS.md, not CLAUDE.md.
//  2. Codex got only 4 of the 8 hooks; pre-read, pre-write, post-read and precompact were missing.
// Both faults were silent: nothing failed, nothing simply took effect.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ow-agents-"));

test("upsertMarkerBlock creates the file when it does not exist", () => {
  const f = path.join(tmp(), "AGENTS.md");
  assert.equal(upsertMarkerBlock(f, "hello").changed, true);
  const t = fs.readFileSync(f, "utf-8");
  assert.ok(t.startsWith(MARKER_BEGIN) && t.trimEnd().endsWith(MARKER_END));
  assert.ok(t.includes("hello"));
});

test("upsertMarkerBlock is idempotent — a second run changes nothing", () => {
  const f = path.join(tmp(), "AGENTS.md");
  upsertMarkerBlock(f, "body");
  const before = fs.readFileSync(f, "utf-8");
  assert.equal(upsertMarkerBlock(f, "body").changed, false, "unchanged content = no write");
  assert.equal(fs.readFileSync(f, "utf-8"), before);
});

test("upsertMarkerBlock leaves user content outside the markers byte for byte", () => {
  const f = path.join(tmp(), "AGENTS.md");
  const before = "# My project\n\nMy own rules, which nobody may touch.\n\n";
  const after = "\n\n## Afterwards\nThis stays too.\n";
  fs.writeFileSync(f, `${before}${MARKER_BEGIN}\nOLD\n${MARKER_END}${after}`);
  assert.equal(upsertMarkerBlock(f, "NEW").changed, true);
  const t = fs.readFileSync(f, "utf-8");
  assert.ok(t.startsWith(before), "text above unchanged");
  assert.ok(t.endsWith(after), "text below unchanged");
  assert.ok(t.includes("NEW") && !t.includes("OLD"), "block replaced");
});

test("upsertMarkerBlock prepends the block without losing existing text", () => {
  const f = path.join(tmp(), "AGENTS.md");
  fs.writeFileSync(f, "# Existing file\nImportant text.\n");
  assert.equal(upsertMarkerBlock(f, "P").changed, true);
  const t = fs.readFileSync(f, "utf-8");
  assert.ok(t.indexOf(MARKER_BEGIN) === 0, "block sits at the top");
  assert.ok(t.includes("Important text."), "existing content preserved");
});

test("upsertMarkerBlock refuses to act on broken markers instead of guessing", () => {
  // END before BEGIN, and BEGIN without END: either could be a half-written foreign file.
  // Repairing it is more dangerous than leaving it alone.
  for (const content of [`${MARKER_END}\nx\n${MARKER_BEGIN}`, `${MARKER_BEGIN}\nx\n`]) {
    const f = path.join(tmp(), "AGENTS.md");
    fs.writeFileSync(f, content);
    const r = upsertMarkerBlock(f, "new");
    assert.equal(r.changed, false);
    assert.ok(r.refused, "the reason must be named, not swallowed");
    assert.equal(fs.readFileSync(f, "utf-8"), content, "file untouched");
  }
});

test("AGENTS_SNIPPET does NOT use an @-include — Codex does not understand it", () => {
  assert.ok(!AGENTS_SNIPPET.includes("@.wolf/"),
    "a reference that silently does nothing is worse than an instruction to read");
  assert.ok(AGENTS_SNIPPET.includes(".wolf/STATUS.md"));
  assert.ok(AGENTS_SNIPPET.includes("anatomy.md") && AGENTS_SNIPPET.includes("cerebrum.md"));
});

test("Codex now gets ALL eight hooks, not four", () => {
  const codex = _internal.codexSettings("/abs/proj");
  const scripts = Object.values(codex.hooks)
    .flat()
    .flatMap((e) => e.hooks.map((h) => h.command.match(/([a-z-]+\.js)/)?.[1]))
    .filter(Boolean);
  for (const s of ["session-start.js", "pre-read.js", "pre-write.js", "post-read.js",
                   "post-write.js", "post-bash.js", "stop.js", "precompact.js"]) {
    assert.ok(scripts.includes(s), `${s} missing from the Codex registration`);
  }
  assert.ok(codex.hooks.PreToolUse?.length === 2, "pre-read and pre-write");
  assert.ok(codex.hooks.PreCompact?.length === 1, "precompact");
  // Every entry carries our marker — otherwise the merge would sweep away foreign hooks.
  for (const e of Object.values(codex.hooks).flat()) {
    for (const h of e.hooks) assert.equal(h._managedBy, "openwolf");
  }
});

test("ensureCodexFeatureFlag creates config.toml, warns otherwise — and is not fooled by webhooks", () => {
  const d1 = tmp();
  assert.equal(_internal.ensureCodexFeatureFlag(d1), null, "freshly created = no warning");
  assert.match(fs.readFileSync(path.join(d1, "config.toml"), "utf-8"), /^\s*hooks\s*=\s*true\s*$/m);

  const d2 = tmp();
  fs.writeFileSync(path.join(d2, "config.toml"), "[features]\nhooks = true\n");
  assert.equal(_internal.ensureCodexFeatureFlag(d2), null, "flag present = silent");

  const d3 = tmp();
  fs.writeFileSync(path.join(d3, "config.toml"), "[features]\nwebhooks = true\n# hooks = true\n");
  assert.ok(_internal.ensureCodexFeatureFlag(d3), "webhooks and a commented-out flag do NOT count");
  assert.ok(fs.readFileSync(path.join(d3, "config.toml"), "utf-8").includes("webhooks = true"),
    "someone else's config.toml is never rewritten");
});

test("deployAgentHooks writes AGENTS.md as soon as a Codex project is detected", () => {
  const proj = tmp();
  fs.mkdirSync(path.join(proj, ".codex"), { recursive: true });
  const res = deployAgentHooks(proj);
  const codex = res.find((r) => r.agent === "codex");
  assert.ok(codex?.deployed, "Codex detected and deployed");
  const agents = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf-8");
  assert.ok(agents.includes(MARKER_BEGIN) && agents.includes(".wolf/STATUS.md"));
  const hooks = JSON.parse(fs.readFileSync(path.join(proj, ".codex", "hooks.json"), "utf-8"));
  assert.ok(hooks.hooks.PreToolUse && hooks.hooks.PreCompact, "the previously missing events are there");
  assert.ok(fs.existsSync(path.join(proj, ".codex", "config.toml")), "features flag set");
});

test("Codex SessionStart has no matcher, so a compaction still gets the digest", () => {
  // [2026-08-20, review] A `startup|resume|clear` matcher omitted `compact`. session-start.ts has a
  // dedicated branch for source === "compact" that re-injects the post-compaction digest, and this
  // same change deploys PreCompact to Codex — so the omission would have silently dropped exactly
  // the handover it enables. Claude's entry matches every source too.
  const codex = _internal.codexSettings("/abs/proj");
  const ss = codex.hooks.SessionStart;
  assert.equal(ss.length, 1);
  assert.ok(!ss[0].matcher, "no matcher = every source, including compact");
});

test("ensureCodexFeatureFlag is table-scoped, not just anchored", () => {
  // hooks = true under any other table does nothing for Codex — the warning has to survive it.
  const d = tmp();
  fs.writeFileSync(path.join(d, "config.toml"), "[experimental]\nhooks = true\n");
  assert.ok(_internal.ensureCodexFeatureFlag(d), "wrong table must still warn");

  const d2 = tmp();
  fs.writeFileSync(path.join(d2, "config.toml"), "[other]\nx = 1\n\n[features]\nhooks = true\n");
  assert.equal(_internal.ensureCodexFeatureFlag(d2), null, "correct table, later in the file");
});
