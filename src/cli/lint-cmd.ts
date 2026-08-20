import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { lintKnowledgeBase, type Finding, type LintReport } from "../utils/kb-lint.js";

// `openwolf lint` — does the knowledge base still keep the rules it promises?
//
// [2026-08-20] The README used to estimate protocol adherence at "~85–90%". Nothing measured it;
// the number was a guess that hardened through repetition. This prints a measured one, and is
// explicit about what it can and cannot see.

function groupByRule(findings: Finding[]): Map<string, Finding[]> {
  const m = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = m.get(f.rule);
    if (list) list.push(f);
    else m.set(f.rule, [f]);
  }
  return m;
}

const SHOWN_PER_RULE = 4;

export function printLint(report: LintReport, opts: { strict?: boolean } = {}): number {
  const errors = report.findings.filter((f) => f.severity === "error");
  const warns = report.findings.filter((f) => f.severity === "warn");

  console.log("");
  if (report.compliance !== null) {
    const pct = Math.round(report.compliance * 1000) / 10;
    const checked = report.scores.reduce((s, r) => s + r.checked, 0);
    const omitted = report.skippedChecks.length ? `, ${report.skippedChecks.join(" + ")} checks skipped` : "";
    console.log(`  Protocol compliance: ${pct}%  (${checked.toLocaleString("en-US")} checkable items${omitted})`);
    // A partial run scores higher simply by checking less. Naming the omission is what keeps the
    // two numbers from being quoted interchangeably.
    if (omitted) console.log("  Partial run — not comparable with a full one, which checks more items.");
    // Say plainly what the number is not, so it does not get quoted as something larger.
    console.log("  Mechanically checkable conventions only — not whether the right thing was learned.");
  } else {
    // Early return: printing "nothing checkable" and then "everything holds" is a contradiction,
    // and a checker that contradicts itself in four lines does not get read a fifth time.
    console.log("  Nothing checkable found — is this a .wolf project?\n");
    return 0;
  }

  if (report.maturity) {
    const { stable, fresh, stableDays, firstRun } = report.maturity;
    if (firstRun) {
      console.log(`  Entry maturity: baseline recorded for ${fresh} entries — ages become readable from here on.`);
    } else {
      console.log(`  Entry maturity: ${stable} settled (unchanged ≥ ${stableDays} d) · ${fresh} still moving`);
    }
  }
  console.log("");

  for (const [rule, list] of groupByRule(report.findings)) {
    const sev = list[0].severity === "error" ? "ERROR" : "warn ";
    console.log(`  ${sev}  ${rule}  (${list.length})`);
    for (const f of list.slice(0, SHOWN_PER_RULE)) {
      console.log(`         ${f.file}:${f.line}  ${f.message}`);
    }
    if (list.length > SHOWN_PER_RULE) console.log(`         … and ${list.length - SHOWN_PER_RULE} more`);
    console.log("");
  }

  if (report.findings.length === 0) {
    console.log("  Everything checkable holds.\n");
    return 0;
  }

  const structural = report.findings.some((f) => f.rule.startsWith("cerebrum/section"));
  if (structural) console.log("  Sections drifted — `openwolf distill --dry-run` shows how they would be filed back.");
  console.log(`  ${errors.length} error(s), ${warns.length} warning(s)\n`);

  if (errors.length > 0) return 1;
  return opts.strict && warns.length > 0 ? 1 : 0;
}

export function lintCommand(opts: { json?: boolean; strict?: boolean; skipLinks?: boolean } = {}): void {
  const wolfDir = path.join(findProjectRoot(), ".wolf");
  const report = lintKnowledgeBase(wolfDir, { skipLinks: opts.skipLinks });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    // Exit code carries the same verdict in both modes, so CI does not have to parse the JSON.
    const failed = report.findings.some((f) => f.severity === "error")
      || (opts.strict === true && report.findings.length > 0);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  process.exitCode = printLint(report, opts);
}
