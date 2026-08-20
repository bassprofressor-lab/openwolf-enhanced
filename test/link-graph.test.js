import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractRefs, normalizeSlug, buildLinkGraph, backlinksFor, orphans }
  from "../dist/src/utils/link-graph.js";
import { stripPrivate, blankPrivate } from "../dist/hooks/shared.js";

// [2026-08-20] Backlinks and the link graph — plus the bug they uncovered in blankPrivate.

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ow-graph-"));
  fs.mkdirSync(path.join(d, ".wolf"), { recursive: true });
  return d;
};

test("extractRefs finds citation ids and wikilinks", () => {
  const r = extractRefs("see [c-3f9a2b] and [[some-note]] and [[other|alias]]");
  assert.deepEqual(r.ids, ["c-3f9a2b"]);
  assert.deepEqual(r.wikis, ["some-note", "other"]);
});

test("extractRefs reads markdown links into .md files — that is how an index wires itself", () => {
  // The bound on link text used to be 160 characters, chosen from imagination. This project's own
  // index uses 473-character descriptive sentences as link text, so every index entry was missed.
  const long = "x".repeat(400);
  const r = extractRefs(`- [${long}](topic_file_2026.md)`);
  assert.deepEqual(r.wikis, ["topic_file_2026.md"]);
});

test("extractRefs ignores brackets inside code — an array literal is not a link", () => {
  // Measured on the real knowledge base: 10 of 17 reported dead links were Odoo snippets like
  // `[[6,0,[taxId]]]`. A dead-link report full of false positives gets ignored.
  assert.deepEqual(extractRefs("`[[6,0,[taxId]]]`").wikis, []);
  assert.deepEqual(extractRefs("```\n[[4, tagId]]\n```").wikis, []);
  assert.deepEqual(extractRefs('[["categ_ids","in",[tagId]]]').wikis, [], "commas and quotes are no slug");
});

test("normalizeSlug treats - and _ alike, because both spellings exist in practice", () => {
  assert.equal(normalizeSlug("Foo_Bar_2026.md"), "foo-bar-2026");
  assert.equal(normalizeSlug("foo-bar-2026"), "foo-bar-2026");
});

test("buildLinkGraph resolves links, counts degrees and names dead ones", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, ".wolf", "cerebrum.md"), "- rule one, see [[alpha]]\n\n- rule two, see [[alpha]] and [[ghost]]\n");
  const nd = path.join(d, "mem");
  fs.mkdirSync(nd);
  fs.writeFileSync(path.join(nd, "alpha.md"), "---\nname: alpha\n---\n\n- alpha content\n");

  const g = buildLinkGraph(path.join(d, ".wolf"), { sources: ["cerebrum.md"], nativeDir: nd });
  const alpha = g.nodes.find((n) => n.key === "file:native/alpha.md");
  assert.ok(alpha, "the topic file is a node");
  assert.equal(alpha.inbound, 2, "both rules point at it");
  assert.equal(backlinksFor(g, alpha.key).length, 2);
  assert.deepEqual(g.dangling.map((x) => x.target), ["ghost"], "a dead link is named, not swallowed");
});

test("buildLinkGraph keys files by label, not by slug — the collision cost a whole index", () => {
  // `.wolf/memory.md` and `native/MEMORY.md` both normalize to "memory". Keying by slug let one
  // silently replace the other, and the index file lost every outgoing link it had.
  const d = tmp();
  fs.writeFileSync(path.join(d, ".wolf", "memory.md"), "- local memory\n");
  const nd = path.join(d, "mem");
  fs.mkdirSync(nd);
  fs.writeFileSync(path.join(nd, "MEMORY.md"), "- [an entry](topic.md)\n");
  fs.writeFileSync(path.join(nd, "topic.md"), "- topic\n");

  const g = buildLinkGraph(path.join(d, ".wolf"), { sources: ["memory.md"], nativeDir: nd });
  const keys = g.nodes.filter((n) => n.kind === "file").map((n) => n.key);
  assert.ok(keys.includes("file:memory.md") && keys.includes("file:native/MEMORY.md"),
    "both files survive as distinct nodes");
  assert.equal(g.nodes.find((n) => n.key === "file:native/topic.md").inbound, 1,
    "the index link is counted");
});

test("orphans finds notes nothing points at and that point nowhere", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, ".wolf", "cerebrum.md"), "- nothing here\n");
  const nd = path.join(d, "mem");
  fs.mkdirSync(nd);
  fs.writeFileSync(path.join(nd, "lonely.md"), "- nobody links me\n");
  const g = buildLinkGraph(path.join(d, ".wolf"), { sources: ["cerebrum.md"], nativeDir: nd });
  assert.ok(orphans(g, "file").some((n) => n.key === "file:native/lonely.md"));
});

// ── the bug the graph uncovered ────────────────────────────────────────────────

test("a <private> mention inside backticks is prose, not a marker", () => {
  // This project's own MEMORY.md describes a bug with the words `<private>` in backticks. Because
  // matching is fail-closed, that single mention redacted 104 of 114 lines of the index — and
  // `recall` silently could not see any of it.
  const text = "line one\nwe fixed a bug where `<private>` went to the model\nline three\n";
  assert.equal(stripPrivate(text), text, "nothing is removed");
  assert.ok(blankPrivate(text).includes("line three"), "the rest of the file survives");
});

test("SECURITY: an unclosed <private> outside code still swallows to end of input", () => {
  // The fail-closed property must survive the fix. A forgotten closing tag means "private",
  // never "not private" — it reaches the resume digest, recall, the semantic index and `push`.
  const text = "public line\n<private>\nsecret one\nsecret two\n";
  const stripped = stripPrivate(text);
  assert.ok(stripped.includes("public line"));
  assert.ok(!stripped.includes("secret one") && !stripped.includes("secret two"),
    "everything after the unclosed marker stays redacted");
  const blanked = blankPrivate(text);
  assert.ok(!blanked.includes("secret"), "same for the line-preserving variant");
  assert.equal(blanked.split("\n").length, text.split("\n").length, "line count preserved");
});

test("SECURITY: a properly closed block is still redacted, and only it", () => {
  const text = "before\n<private>\nhidden\n</private>\nafter\n";
  const s = stripPrivate(text);
  assert.ok(s.includes("before") && s.includes("after"));
  assert.ok(!s.includes("hidden"));
});

test("SECURITY: a fenced block does not disarm a real marker outside it", () => {
  const text = "```\n<private>\n```\nstill public\n<private>\nreally secret\n";
  const s = stripPrivate(text);
  assert.ok(s.includes("still public"), "the fenced mention is inert");
  assert.ok(!s.includes("really secret"), "the real marker after it still redacts");
});

test("SECURITY: the cron LLM path strips <private> before anything leaves the machine", async () => {
  // [2026-08-20] This was the one egress path that did not. Two AI tasks ship enabled and read
  // cerebrum.md / memory.md / anatomy.md; with an API key exported they went to the API weekly,
  // raw. push/recall/consolidate all route through blocksFor(), which blanks private regions.
  const src = await fs.promises.readFile(
    new URL("../dist/src/daemon/cron-engine.js", import.meta.url), "utf-8");
  // Assert on the read itself, not on a nearby symbol: every readFileSync whose result is fed to
  // the model must pass through stripPrivate. Anchoring on the read is what makes this test fail
  // if someone later adds a second, unstripped context path.
  const reads = [...src.matchAll(/(\w+)\(fs\.readFileSync\(filePath[^)]*\)\)/g)].map((m) => m[1]);
  assert.ok(reads.length > 0, "the context-file read is still where the test expects it");
  assert.ok(reads.every((fn) => fn === "stripPrivate"),
    `context files must be stripped before they reach the model — found: ${reads.join(", ")}`);
});

test("doctor warns an existing install whose AI cron tasks still send files", async () => {
  // cron-manifest.json is user data — `update` never rewrites it. Shipping the tasks disabled
  // therefore protects only NEW projects; this warning is how an existing one finds out.
  const { footprint, getRetention } = await import("../dist/src/utils/maintenance.js");
  const d = tmp();
  const w = path.join(d, ".wolf");
  fs.writeFileSync(path.join(w, "cron-manifest.json"), JSON.stringify({
    version: 1,
    tasks: [
      { id: "project-suggestions", enabled: true, action: { type: "ai_task", params: { context_files: [".wolf/memory.md"] } } },
      { id: "anatomy-rescan", enabled: true, action: { type: "scan_project" } },
    ],
  }));
  fs.writeFileSync(path.join(w, "config.json"), JSON.stringify({ openwolf: { cron: { enabled: true } } }));

  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const ret = getRetention(w);
    const withKey = footprint(w, ret).warnings.filter((x) => x.startsWith("cron:"));
    assert.equal(withKey.length, 1, "one warning naming the sending task");
    assert.ok(withKey[0].includes("project-suggestions") && withKey[0].includes(".wolf/memory.md"));
    assert.ok(!withKey[0].includes("anatomy-rescan"), "a task that sends nothing is not named");

    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(footprint(w, ret).warnings.filter((x) => x.startsWith("cron:")).length, 0,
      "no key, no exposure, no lecture");
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
});
