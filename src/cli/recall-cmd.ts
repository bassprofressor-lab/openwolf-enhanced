import * as fs from "node:fs";
import { getWolfDir } from "../hooks/shared.js";
import { recall, resolveId } from "../utils/recall.js";

interface RecallCliOpts { limit?: string; json?: boolean; full?: boolean; id?: string; }

export function recallCommand(query: string[], opts: RecallCliOpts): void {
  const wolfDir = getWolfDir();
  if (!fs.existsSync(wolfDir)) {
    console.error("No .wolf/ in this project. Run `openwolf init` first.");
    process.exitCode = 1;
    return;
  }

  // --- Targeted second layer: resolve a citation id to its full block. No query needed. ---
  if (opts.id) {
    const entry = resolveId(wolfDir, opts.id);
    if (!entry) {
      if (opts.json) process.stdout.write("null\n");
      else console.log(`No entry with id "${opts.id}".`);
      process.exitCode = 1;
      return;
    }
    if (opts.json) { process.stdout.write(JSON.stringify(entry, null, 2) + "\n"); return; }
    console.log(`[${entry.id}]  ${entry.file}:${entry.line}\n`);
    console.log(entry.text);
    return;
  }

  const q = (query || []).join(" ").trim();
  if (!q) {
    console.error("Usage: openwolf recall <query> [--full]  |  openwolf recall --id <id>");
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
    console.log(`  [${h.id}] ${String(h.score).padStart(3)}  ${h.file}:${h.line}`);
    if (opts.full) {
      // Second layer, inline: expand every hit to its full logical block.
      const entry = resolveId(wolfDir, h.id);
      const body = entry ? entry.text : h.text;
      console.log(body.split("\n").map((l) => `       │ ${l}`).join("\n"));
    } else {
      const snippet = h.text.length > 120 ? h.text.slice(0, 117) + "…" : h.text;
      console.log(`       ${snippet}`);
    }
  }
  if (opts.full) {
    console.log(`\nCite an entry as [id]; re-open it later with \`openwolf recall --id <id>\`.`);
  } else {
    console.log(`\nExpand: \`openwolf recall "${q}" --full\`  ·  one entry: \`openwolf recall --id <id>\``);
  }
}
