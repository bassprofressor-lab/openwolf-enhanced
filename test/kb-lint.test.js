import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  lintCerebrumStructure, lintDoNotRepeatDates, lintBuglog, lintMemorySummaries,
  stampMaturity, canonicalOf, headings,
} from "../dist/src/utils/kb-lint.js";
import { distill, chunksOf } from "../dist/src/utils/distill.js";
import { buildLinkGraph } from "../dist/src/utils/link-graph.js";

// [2026-08-20] `openwolf lint` and `openwolf distill`. The README used to estimate protocol
// adherence at "~85–90%" without ever measuring it; these are the checks behind the real number.

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ow-lint-"));
  fs.mkdirSync(path.join(d, ".wolf"), { recursive: true });
  return path.join(d, ".wolf");
};

const CANONICAL = `# Cerebrum

## User Preferences

- likes short answers

## Key Learnings

- the build is pnpm

## Do-Not-Repeat

- **[2026-08-01]** do not do that again

## Decision Log

- **[2026-08-02]** chose A over B
`;

// ── structure ─────────────────────────────────────────────────────────────────

test("a file matching the template reports nothing", () => {
  const r = lintCerebrumStructure(CANONICAL);
  assert.deepEqual(r.findings, []);
  assert.equal(r.score.conforming, r.score.checked);
});

test("a second section of the same name is the drift signal, not a duplicate name", () => {
  // Measured on this project: `## Do-Not-Repeat (Forts.)` sat 265 lines below `## Do-Not-Repeat`.
  // Both are "canonical" by name, so only the repetition gives the erosion away.
  const r = lintCerebrumStructure(CANONICAL + "\n## Do-Not-Repeat (Forts.)\n\n- another\n");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "cerebrum/section-duplicate");
});

test("a section outside the four is named", () => {
  const r = lintCerebrumStructure(CANONICAL + "\n## Session 2026-07-12 — Slice 4\n\n- x\n");
  assert.equal(r.findings[0].rule, "cerebrum/section-unknown");
});

test("a missing section is a finding — entries would land at the end of the file", () => {
  const r = lintCerebrumStructure("## Key Learnings\n\n- one\n");
  const missing = r.findings.filter((f) => f.rule === "cerebrum/section-missing");
  assert.equal(missing.length, 3);
});

test("headings inside code fences are sample text, not structure", () => {
  const r = lintCerebrumStructure(CANONICAL + "\n```\n## Not A Section\n```\n");
  assert.deepEqual(r.findings, []);
});

test("canonicalOf matches by prefix so decorated headings still resolve", () => {
  assert.equal(canonicalOf("Key Learnings — Trading (frozen)"), "Key Learnings");
  assert.equal(canonicalOf("### Something else"), null);
  assert.equal(headings("## A\n\ntext\n### B\n").length, 2);
});

// ── dates ─────────────────────────────────────────────────────────────────────

test("a dated sub-heading dates the bullets under it", () => {
  const c = `## Do-Not-Repeat

### Hook deployment (2026-07-20)

- bare bullet, dated by its heading
- another one
`;
  const r = lintDoNotRepeatDates(c);
  assert.deepEqual(r.findings, [], "bullets under a dated heading are not flagged individually");
  assert.equal(r.score.conforming, 2);
});

test("an undated Do-Not-Repeat entry is flagged — it can never age out", () => {
  const r = lintDoNotRepeatDates("## Do-Not-Repeat\n\n- never do this\n");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "cerebrum/dnr-undated");
});

test("only Do-Not-Repeat is date-checked; Key Learnings are not", () => {
  const r = lintDoNotRepeatDates("## Key Learnings\n\n- undated learning\n");
  assert.deepEqual(r.findings, []);
  assert.equal(r.score.checked, 0);
});

// ── buglog ────────────────────────────────────────────────────────────────────

test("a bug record without root_cause or fix cannot prevent a repeat", () => {
  const r = lintBuglog([
    { id: "bug-001", error_message: "boom", root_cause: "x", fix: "y" },
    { id: "bug-002", error_message: "boom" },
  ]);
  assert.equal(r.score.conforming, 1);
  assert.equal(r.findings[0].rule, "buglog/incomplete");
  assert.ok(r.findings[0].message.includes("root_cause"));
});

test("SEVERITY: a duplicate bug id is an error, because the second record is unreachable", () => {
  // Found on the first real run: 8 collisions, e.g. bug-002 was both a cross-tenant leak and a
  // provider warning banner. `openwolf bug bug-002` answers with whichever comes first.
  const r = lintBuglog([
    { id: "bug-002", error_message: "leak", root_cause: "a", fix: "b" },
    { id: "bug-002", error_message: "banner", root_cause: "a", fix: "b" },
  ]);
  const dup = r.findings.filter((f) => f.rule === "buglog/duplicate-id");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, "error");
});

// ── memory ────────────────────────────────────────────────────────────────────

test("an unfilled session-summary scaffold means the session is invisible to recall", () => {
  const r = lintMemorySummaries("## Session\n<!-- session summary goes here -->\n");
  assert.equal(r.findings[0].rule, "memory/empty-summary");
});

test("a filled summary counts on the other side of the ratio", () => {
  const r = lintMemorySummaries("**Did:** things · **Learned:** more · **Next:** rest\n");
  assert.deepEqual(r.findings, []);
  assert.equal(r.score.conforming, 1);
});

// ── maturity ──────────────────────────────────────────────────────────────────

test("maturity records a baseline first and only then reports ages", () => {
  const w = tmp();
  fs.writeFileSync(path.join(w, "cerebrum.md"), "## Key Learnings\n\n- one\n- two\n");
  const day0 = new Date("2026-01-01T00:00:00Z");
  const first = stampMaturity(w, ["cerebrum.md"], 30, day0);
  assert.equal(first.firstRun, true, "the run that creates the record says so");
  assert.equal(first.stable, 0);

  const later = stampMaturity(w, ["cerebrum.md"], 30, new Date("2026-03-01T00:00:00Z"));
  assert.equal(later.firstRun, false);
  assert.equal(later.stable, 2, "unchanged for two months — settled");
});

test("maturity prunes ids that left the corpus", () => {
  // A previous ledger in this project reached 44 MB because nothing ever removed anything.
  const w = tmp();
  fs.writeFileSync(path.join(w, "cerebrum.md"), "## Key Learnings\n\n- one\n- two\n");
  stampMaturity(w, ["cerebrum.md"], 30, new Date("2026-01-01T00:00:00Z"));
  fs.writeFileSync(path.join(w, "cerebrum.md"), "## Key Learnings\n\n- one\n");
  stampMaturity(w, ["cerebrum.md"], 30, new Date("2026-01-02T00:00:00Z"));
  const state = JSON.parse(fs.readFileSync(path.join(w, "kb-state.json"), "utf-8"));
  assert.equal(Object.keys(state.first_seen).length, 1);
});

test("headings do not count as entries — otherwise distill would appear to reset the corpus", () => {
  const w = tmp();
  fs.writeFileSync(path.join(w, "cerebrum.md"), "## Key Learnings\n\n### A dated note (2026-01-01)\n\n- one\n");
  const m = stampMaturity(w, ["cerebrum.md"], 30, new Date("2026-01-01T00:00:00Z"));
  assert.equal(m.stable + m.fresh, 1, "one bullet, not three blocks");
});

// ── distill ───────────────────────────────────────────────────────────────────

const DRIFTED = `# Cerebrum

## User Preferences

- likes short answers

## Key Learnings

- the build is pnpm

## Key Learnings — Trading (frozen)

- carry is the only edge

## Do-Not-Repeat

- **[2026-08-01]** not again

## Do-Not-Repeat (Forts.)

- **[2026-08-02]** also not

## Decision Log

- **[2026-08-02]** chose A

## Session 2026-07-12 — Slice 4+5

- loose note under the session

### Key Learnings (12.07)

- learned during the slice

### Decision Log (12.07)

- decided during the slice

### Do-Not-Repeat (12.07)

- burned during the slice
`;

test("distill splits at level 3, because that is where the drift put the classification", () => {
  // `## Session … Slice 4+5` contains Key Learnings, Decision Log AND Do-Not-Repeat underneath it.
  // Filing the block by its level-2 heading would dump three kinds of knowledge into one bucket.
  const byTarget = {};
  for (const c of chunksOf(DRIFTED)) {
    if (c.heading === null) continue;
    (byTarget[c.target] ??= []).push(c.heading);
  }
  assert.ok(byTarget["Decision Log"].some((h) => h.includes("Decision Log (12.07)")));
  assert.ok(byTarget["Do-Not-Repeat"].some((h) => h.includes("Do-Not-Repeat (12.07)")));
  assert.ok(byTarget["Key Learnings"].some((h) => h.includes("Session 2026-07-12")),
    "the session's own loose note falls back to Key Learnings");
});

test("distill produces exactly the four sections", () => {
  const r = distill(DRIFTED);
  const tops = r.content.split("\n").filter((l) => /^##\s/.test(l));
  assert.deepEqual(tops, ["## User Preferences", "## Key Learnings", "## Do-Not-Repeat", "## Decision Log"]);
});

test("SAFETY: distill moves text and never rewrites it", () => {
  // This project logged the opposite as a critical bug (2026-07-14): an AI cron task overwrote a
  // file it had only seen an excerpt of. The equality proof is what makes this safe to run blind.
  const r = distill(DRIFTED);
  assert.equal(r.lossless, true);
  const body = (t) => t.split("\n").filter((l) => l.trim() && !/^#{1,6}\s/.test(l)).sort();
  assert.deepEqual(body(r.content), body(DRIFTED), "every content line survives, unchanged");
});

test("SAFETY: no original heading text is lost — often the only date an entry carries", () => {
  const r = distill(DRIFTED);
  for (const h of ["Key Learnings — Trading (frozen)", "Do-Not-Repeat (Forts.)", "Session 2026-07-12 — Slice 4+5"]) {
    assert.ok(r.content.includes(`### ${h}`), `${h} kept, demoted to level 3`);
  }
  assert.deepEqual(r.lostHeadings, []);
});

test("distill is idempotent — a second pass changes nothing", () => {
  const once = distill(DRIFTED).content;
  assert.equal(distill(once).content, once);
});

test("distill leaves an already-canonical file alone", () => {
  const r = distill(CANONICAL);
  assert.equal(r.moved, 0);
  assert.equal(r.lossless, true);
});

// ── the regression the first real run exposed ─────────────────────────────────

test("REGRESSION: a bug id is a link target, so live bug references are not reported dead", () => {
  // [2026-08-20] On its first run against the real knowledge base, lint reported 10 dangling links.
  // Four of them were `[[bug-209]]`-style references to bugs that DO exist in buglog.json — the
  // graph gave bug records block ids but no address. A checker whose false positives point at the
  // checker is worse than no checker.
  const d = path.dirname(tmp());
  const w = path.join(d, ".wolf");
  fs.writeFileSync(path.join(w, "buglog.json"), JSON.stringify([
    { id: "bug-209", error_message: "benchmark fed the fixed file", root_cause: "x", fix: "y" },
  ]));
  fs.writeFileSync(path.join(w, "cerebrum.md"), "## Key Learnings\n\n- the benchmark defect, see [[bug-209]]\n");

  const g = buildLinkGraph(w, { sources: ["cerebrum.md", "buglog.json"], includeNative: false });
  assert.deepEqual(g.dangling, [], "the reference resolves");
  assert.equal(g.edges.length, 1);
});
