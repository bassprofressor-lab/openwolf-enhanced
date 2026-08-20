import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { distill, chunksOf } from "../utils/distill.js";
import { CANONICAL_SECTIONS } from "../utils/kb-lint.js";
import { writeText, safeCopyFile } from "../utils/fs-safe.js";

// `openwolf distill` — file an eroded cerebrum.md back under its four sections.
//
// [2026-08-20] Deliberately not an LLM pass. See the header of utils/distill.ts: this project
// already logged what happens when a model is handed a file it has only partly seen.

export function distillCommand(opts: { dryRun?: boolean } = {}): void {
  const wolfDir = path.join(findProjectRoot(), ".wolf");
  const file = path.join(wolfDir, "cerebrum.md");
  if (!fs.existsSync(file)) { console.log("\n  No cerebrum.md here.\n"); return; }

  const before = fs.readFileSync(file, "utf-8");
  const result = distill(before);
  const chunks = chunksOf(before).filter((c) => c.heading !== null);

  console.log("");
  if (!result.lossless) {
    // The whole point of the equality check: refuse rather than write a file that lost something.
    console.log("  REFUSED — the rewrite would not be lossless. Nothing was written.");
    if (result.lostHeadings.length) console.log(`  headings that would vanish: ${result.lostHeadings.join(", ")}`);
    for (const l of result.lostLines) console.log(`    - ${l.slice(0, 100)}`);
    console.log("  This is a bug in distill, not in your file — please report it.\n");
    process.exitCode = 1;
    return;
  }

  const beforeTop = before.split(/\r?\n/).filter((l) => /^##\s/.test(l)).length;
  const afterTop = result.content.split(/\r?\n/).filter((l) => /^##\s/.test(l)).length;

  console.log(`  cerebrum.md: ${beforeTop} top-level sections → ${afterTop}`);
  console.log(`  ${result.moved} of ${chunks.length} blocks would be re-filed. Content is carried over unchanged.`);
  console.log("");
  for (const s of CANONICAL_SECTIONS) {
    const n = chunks.filter((c) => c.target === s).length;
    if (n > 0) console.log(`    ## ${s.padEnd(18)} ${n} block(s)`);
  }
  console.log("");

  if (opts.dryRun) {
    console.log("  Dry run — nothing written. Drop --dry-run to apply.\n");
    return;
  }

  const backupDir = path.join(wolfDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const backup = path.join(backupDir, `cerebrum.md.pre-distill-${stamp}`);
  safeCopyFile(file, backup);
  writeText(file, result.content);

  console.log(`  Written. Backup: ${path.relative(process.cwd(), backup)}`);
  console.log("  Check it with `git diff` (or against the backup) before you keep it.\n");
}
