import * as fs from "node:fs";
import { getWolfDir } from "../hooks/shared.js";
import { recall } from "../utils/recall.js";

export function recallCommand(query: string[], opts: { limit?: string; json?: boolean }): void {
  const wolfDir = getWolfDir();
  if (!fs.existsSync(wolfDir)) {
    console.error("No .wolf/ in this project. Run `openwolf init` first.");
    process.exitCode = 1;
    return;
  }
  const q = (query || []).join(" ").trim();
  if (!q) {
    console.error("Usage: openwolf recall <query>");
    process.exitCode = 1;
    return;
  }
  const limit = Math.max(1, parseInt(opts.limit || "12", 10) || 12);
  const hits = recall(wolfDir, q, { limit });

  if (opts.json) {
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
    return;
  }
  if (hits.length === 0) {
    console.log(`No matches for "${q}".`);
    return;
  }
  console.log(`${hits.length} match(es) for "${q}":\n`);
  for (const h of hits) {
    const snippet = h.text.length > 120 ? h.text.slice(0, 117) + "…" : h.text;
    console.log(`  ${String(h.score).padStart(3)}  ${h.file}:${h.line}`);
    console.log(`       ${snippet}`);
  }
  console.log(`\nRead the file:line for full context.`);
}
