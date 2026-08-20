import * as fs from "node:fs";
import * as path from "node:path";
import { blocksFor, entryId } from "./recall.js";
import { readJSON, writeJSON } from "./fs-safe.js";
import { buildLinkGraph, orphans } from "./link-graph.js";

// ─────────────────────────────────────────────────────────────────────────────
// Linting the knowledge base against the protocol it promises.
//
// [2026-08-20] OPENWOLF.md states rules — four cerebrum sections, dated Do-Not-Repeat entries,
// buglog entries carrying root_cause and fix — and until now nothing ever checked them. The README
// estimated adherence at "~85–90%". That number was never measured; it was a guess that got firmer
// by being repeated.
//
// Measured on this project's own knowledge base the day this was written: cerebrum.md had grown to
// 1006 lines and 52 headings, 44 of them dated one-offs, with 47% of the file sitting past the last
// section the template knows — including a literal `## Do-Not-Repeat (Forts.)`, i.e. someone
// appended a continuation instead of filing into the section that already existed. A young project
// (126 lines) still matched the template exactly. So the schema does not fail at birth; it erodes
// with age, silently, because nothing ever objected.
//
// What this file measures is deliberately narrow: conventions that are mechanically checkable.
// It does NOT measure whether the right thing was learned — that stays unmeasurable, and the
// output says so rather than dressing a partial number up as a total one.
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = "error" | "warn";

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
}

/**
 * Per-rule conformance, counted in ITEMS rather than rules — twelve conforming buglog entries and
 * one broken heading are not "50% compliant". Weighting by item is what keeps the headline number
 * from swinging on the count of rules rather than the state of the corpus.
 */
export interface RuleScore {
  rule: string;
  checked: number;
  conforming: number;
}

export interface Maturity {
  /** Entries whose content id has been present, unchanged, for at least `stableDays`. */
  stable: number;
  /** Entries first seen within `stableDays` — still in motion. */
  fresh: number;
  stableDays: number;
  /**
   * True when this run created the record. Everything then looks brand new, because it is being
   * seen for the first time — not because the corpus is new. Reporting "0 settled" without saying
   * so would be a measurement presented as a finding.
   */
  firstRun: boolean;
}

export interface LintReport {
  findings: Finding[];
  scores: RuleScore[];
  /** Item-weighted share of checkable conventions that hold, or null when nothing was checkable. */
  compliance: number | null;
  /**
   * Checks that did not run, so the headline number can say what it left out.
   *
   * [2026-08-20] Found by smoke-testing the published 1.23.0: `--skip-links` reported 95.3% where
   * the full run reported 86.7%, because dropping the link checks also drops ~1,270 of the 1,612
   * items. Same command, same corpus, two numbers, and nothing said which was which — the exact
   * failure this command exists to remove.
   */
  skippedChecks: string[];
  maturity: Maturity | null;
}

export const CANONICAL_SECTIONS = ["User Preferences", "Key Learnings", "Do-Not-Repeat", "Decision Log"];

/** A date in any of the spellings that occur in practice: 2026-08-19, 19.08.2026, 12.07. */
const DATE_RE = /\b(20\d\d-\d\d-\d\d|\d\d\.\d\d\.(?:20\d\d|\d\d)?|\d\d\.\d\d\b)/;

export interface Heading { line: number; level: number; text: string; }

export function headings(content: string): Heading[] {
  const out: Heading[] = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    // A `## heading` inside a fenced code block is sample text, not structure.
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) out.push({ line: i + 1, level: m[1].length, text: m[2] });
  }
  return out;
}

/** The canonical section a heading belongs to, by prefix — `Do-Not-Repeat (Forts.)` is still one. */
export function canonicalOf(text: string): string | null {
  const t = text.replace(/^[^\w]*/, "");
  return CANONICAL_SECTIONS.find((c) => t.toLowerCase().startsWith(c.toLowerCase())) ?? null;
}

/**
 * Structure of cerebrum.md: exactly the four sections, each appearing once. Sub-headings below
 * them are fine — that is how a section carries dated detail without the file going flat.
 */
export function lintCerebrumStructure(content: string, file = "cerebrum.md"): { findings: Finding[]; score: RuleScore } {
  const findings: Finding[] = [];
  const tops = headings(content).filter((h) => h.level === 2);
  const seen = new Map<string, number>();

  for (const h of tops) {
    const canon = canonicalOf(h.text);
    if (!canon) {
      findings.push({
        rule: "cerebrum/section-unknown", severity: "warn", file, line: h.line,
        message: `"${h.text}" is not one of the four sections — its content is filed where nothing looks for it`,
      });
      continue;
    }
    const prev = seen.get(canon);
    if (prev !== undefined) {
      findings.push({
        rule: "cerebrum/section-duplicate", severity: "warn", file, line: h.line,
        message: `second "${canon}" section (first at line ${prev}) — appended alongside instead of into it`,
      });
    } else {
      seen.set(canon, h.line);
    }
  }

  for (const c of CANONICAL_SECTIONS) {
    if (!seen.has(c)) {
      findings.push({
        rule: "cerebrum/section-missing", severity: "warn", file, line: 1,
        message: `no "## ${c}" section — the protocol writes into it, so entries land at the end of the file`,
      });
    }
  }

  const checked = tops.length + CANONICAL_SECTIONS.length;
  return { findings, score: { rule: "cerebrum/structure", checked, conforming: Math.max(0, checked - findings.length) } };
}

/** Do-Not-Repeat entries carry a date — OPENWOLF.md says so explicitly, and undated ones cannot age out. */
export function lintDoNotRepeatDates(content: string, file = "cerebrum.md"): { findings: Finding[]; score: RuleScore } {
  const findings: Finding[] = [];
  const hs = headings(content);
  const lines = content.split(/\r?\n/);
  let checked = 0, conforming = 0;

  for (let i = 0; i < hs.length; i++) {
    if (hs[i].level !== 2 || canonicalOf(hs[i].text) !== "Do-Not-Repeat") continue;
    const end = hs.slice(i + 1).find((h) => h.level <= 2)?.line ?? lines.length + 1;
    const section = lines.slice(hs[i].line, end - 1).join("\n");
    // A dated sub-heading dates everything under it; only then are the bullets allowed to be bare.
    let currentSubIsDated = DATE_RE.test(hs[i].text);
    let subLine = hs[i].line;
    for (const b of blocksFor(file, section)) {
      const absolute = hs[i].line + b.start;
      const head = b.text.split("\n")[0];
      if (/^#{3,6}\s/.test(head)) { currentSubIsDated = DATE_RE.test(head); subLine = absolute; continue; }
      if (!/^\s*[-*]\s/.test(head)) continue;
      checked++;
      if (DATE_RE.test(b.text) || currentSubIsDated) { conforming++; continue; }
      findings.push({
        rule: "cerebrum/dnr-undated", severity: "warn", file, line: absolute,
        message: `undated Do-Not-Repeat entry — cannot be aged out or trusted as current (nearest heading line ${subLine})`,
      });
    }
  }
  return { findings, score: { rule: "cerebrum/dnr-undated", checked, conforming } };
}

interface BugEntry { id?: string; error_message?: string; root_cause?: string; fix?: string; [k: string]: unknown }

/** buglog entries: the protocol names error_message, root_cause and fix as the point of the record. */
export function lintBuglog(entries: BugEntry[], file = "buglog.json"): { findings: Finding[]; score: RuleScore } {
  const findings: Finding[] = [];
  const ids = new Map<string, number>();
  let conforming = 0;

  entries.forEach((b, i) => {
    const missing = (["error_message", "root_cause", "fix"] as const).filter((k) => !String(b[k] ?? "").trim());
    if (missing.length === 0) conforming++;
    else {
      findings.push({
        rule: "buglog/incomplete", severity: "warn", file, line: i + 1,
        message: `${b.id ?? `entry #${i + 1}`} has no ${missing.join(", ")} — a bug record without them cannot prevent a repeat`,
      });
    }
    const id = String(b.id ?? "").trim();
    if (!id) return;
    const prev = ids.get(id);
    // Duplicate ids are an error, not a warning: `openwolf bug <id>` resolves to whichever comes
    // first, so the second record is unreachable through the tool that exists to find it.
    if (prev !== undefined) {
      findings.push({
        rule: "buglog/duplicate-id", severity: "error", file, line: i + 1,
        message: `id ${id} already used by entry #${prev} — one of the two is unreachable`,
      });
    } else ids.set(id, i + 1);
  });

  return { findings, score: { rule: "buglog/complete", checked: entries.length, conforming } };
}

/** Session summaries whose scaffold was never replaced — the handoff note that was never written. */
export function lintMemorySummaries(content: string, file = "memory.md"): { findings: Finding[]; score: RuleScore } {
  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  let checked = 0, conforming = 0;
  lines.forEach((l, i) => {
    if (!/<!--\s*session summary/i.test(l)) return;
    checked++;
    findings.push({
      rule: "memory/empty-summary", severity: "warn", file, line: i + 1,
      message: "session summary scaffold was never filled in — this session is invisible to recall",
    });
  });
  // Every filled-in summary counts on the other side of the ratio, so the score reflects the file.
  const filled = (content.match(/^\s*\*\*Did:\*\*/gm) ?? []).length;
  checked += filled;
  conforming += filled;
  return { findings, score: { rule: "memory/summaries", checked, conforming } };
}

interface KbState { version: 1; first_seen: Record<string, string> }

/**
 * Entry maturity, from content-addressed ids.
 *
 * [2026-08-20] `entryId` is stable across reordering and changes only when the entry's own text
 * changes — which makes "how long has this been true?" answerable without any new bookkeeping in
 * the files themselves. An entry that has survived unchanged for weeks is settled knowledge; one
 * that appeared yesterday is not, and treating them alike is what makes an old cerebrum feel
 * uniformly stale.
 *
 * Ids no longer present are pruned on every run. A previous ledger in this project grew to 44 MB
 * because nothing ever removed anything; that lesson is cheap to apply here.
 */
export function stampMaturity(wolfDir: string, sources: string[], stableDays = 30, now = new Date()): Maturity | null {
  const statePath = path.join(wolfDir, "kb-state.json");
  const firstRun = !fs.existsSync(statePath);
  const state = readJSON<KbState>(statePath, { version: 1, first_seen: {} });
  if (!state.first_seen || typeof state.first_seen !== "object") state.first_seen = {};

  const today = now.toISOString().slice(0, 10);
  const live = new Set<string>();
  for (const src of sources) {
    let content: string;
    try { content = fs.readFileSync(path.join(wolfDir, src), "utf-8"); } catch { continue; }
    for (const b of blocksFor(src, content)) {
      // Headings are structure, not knowledge. Counting them would also mean `distill` — which
      // re-levels headings and nothing else — appeared to reset the age of half the corpus.
      if (/^#{1,6}\s/.test(b.text.split("\n")[0]) && b.text.split("\n").length === 1) continue;
      live.add(entryId(src, b.text));
    }
  }
  if (live.size === 0) return null;

  for (const id of live) if (!state.first_seen[id]) state.first_seen[id] = today;
  for (const id of Object.keys(state.first_seen)) if (!live.has(id)) delete state.first_seen[id];

  const cutoff = new Date(now.getTime() - stableDays * 86400_000).toISOString().slice(0, 10);
  let stable = 0;
  for (const id of live) if ((state.first_seen[id] ?? today) <= cutoff) stable++;

  writeJSON(statePath, state);
  return { stable, fresh: live.size - stable, stableDays, firstRun };
}

export interface LintOptions {
  /** Skip the link graph — it reads the whole native memory directory and is the slow part. */
  skipLinks?: boolean;
  stableDays?: number;
  now?: Date;
}

export function lintKnowledgeBase(wolfDir: string, opts: LintOptions = {}): LintReport {
  const findings: Finding[] = [];
  const scores: RuleScore[] = [];
  const read = (f: string): string | null => {
    try { return fs.readFileSync(path.join(wolfDir, f), "utf-8"); } catch { return null; }
  };

  const cerebrum = read("cerebrum.md");
  if (cerebrum !== null) {
    for (const r of [lintCerebrumStructure(cerebrum), lintDoNotRepeatDates(cerebrum)]) {
      findings.push(...r.findings);
      scores.push(r.score);
    }
  }

  const memory = read("memory.md");
  if (memory !== null) {
    const r = lintMemorySummaries(memory);
    findings.push(...r.findings);
    scores.push(r.score);
  }

  const bugs = readJSON<unknown>(path.join(wolfDir, "buglog.json"), null);
  const bugList = Array.isArray(bugs)
    ? bugs
    : Array.isArray((bugs as { bugs?: unknown } | null)?.bugs)
      ? (bugs as { bugs: BugEntry[] }).bugs
      : null;
  if (bugList) {
    const r = lintBuglog(bugList as BugEntry[]);
    findings.push(...r.findings);
    scores.push(r.score);
  }

  if (!opts.skipLinks) {
    try {
      const g = buildLinkGraph(wolfDir);
      // Dead links are reported per target, not per occurrence: one mistyped slug cited from
      // fifteen entries is one thing to fix, and fifteen lines of output would bury the rest.
      const byTarget = new Map<string, { count: number; from: string; line: number }>();
      for (const d of g.dangling) {
        const e = byTarget.get(d.target);
        if (e) e.count++;
        else byTarget.set(d.target, { count: 1, from: d.fromSrc, line: 1 });
      }
      for (const [target, e] of byTarget) {
        findings.push({
          rule: "links/dangling", severity: "warn", file: e.from, line: e.line,
          message: `"${target}" is referenced ${e.count}× but does not exist — a note meant to be written, or a typo`,
        });
      }
      const refs = g.edges.length;
      scores.push({ rule: "links/resolve", checked: refs + g.dangling.length, conforming: refs });

      const orphaned = orphans(g, "file");
      if (orphaned.length > 0) {
        findings.push({
          rule: "links/orphans", severity: "warn", file: "native memory", line: 1,
          message: `${orphaned.length} topic files nothing points at and that point nowhere — reachable only by full-text search`,
        });
      }
      const fileNodes = g.nodes.filter((n) => n.kind === "file").length;
      scores.push({ rule: "links/wired", checked: fileNodes, conforming: Math.max(0, fileNodes - orphaned.length) });
    } catch { /* no graph: not a lint failure */ }
  }

  const checked = scores.reduce((s, r) => s + r.checked, 0);
  const conforming = scores.reduce((s, r) => s + r.conforming, 0);

  return {
    findings,
    scores,
    skippedChecks: opts.skipLinks ? ["link"] : [],
    compliance: checked > 0 ? conforming / checked : null,
    maturity: stampMaturity(wolfDir, ["cerebrum.md"], opts.stableDays ?? 30, opts.now),
  };
}
