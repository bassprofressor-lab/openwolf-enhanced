import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { searchBugs } from "../buglog/bug-tracker.js";

export function bugSearch(term: string): void {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  const results = searchBugs(wolfDir, term);

  if (results.length === 0) {
    console.log(`No bugs found matching "${term}".`);
    return;
  }

  console.log(`Found ${results.length} matching bug(s):\n`);

  for (const b of results) {
    // Null-safe display: entries can be missing fields or use files[] (schema drift, #44).
    const bug = b as typeof b & { files?: string[] };
    const files = Array.isArray(bug.files) ? bug.files.join(", ") : (bug.file ?? "—");
    console.log(`  [${bug.id ?? "?"}] ${(bug.error_message ?? "(no message)").slice(0, 80)}`);
    console.log(`    File: ${files}${bug.line ? `:${bug.line}` : ""}`);
    console.log(`    Root cause: ${bug.root_cause ?? "—"}`);
    console.log(`    Fix: ${bug.fix ?? "—"}`);
    console.log(`    Tags: ${Array.isArray(bug.tags) ? bug.tags.filter(Boolean).join(", ") : "—"}`);
    console.log(`    Occurrences: ${bug.occurrences ?? 1} | Last seen: ${bug.last_seen ?? "—"}`);
    console.log("");
  }
}
