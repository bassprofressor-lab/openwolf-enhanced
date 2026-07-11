import * as fs from "node:fs";
import * as path from "node:path";
import { getWolfDir } from "../hooks/shared.js";
import { recallAcross, resolveId } from "../utils/recall.js";
import { getRegisteredProjects } from "./registry.js";

interface RecallCliOpts { limit?: string; json?: boolean; full?: boolean; id?: string; all?: boolean }

interface Target { name?: string; wolfDir: string }

// The projects to search: just this one, or every registered project when --all.
function targets(all: boolean | undefined): Target[] {
  if (!all) return [{ wolfDir: getWolfDir() }];
  return getRegisteredProjects(true)
    .map((p) => ({ name: p.name, wolfDir: path.join(p.root, ".wolf") }))
    .filter((t) => fs.existsSync(t.wolfDir));
}

// "project:file" when searching across projects, plain "file" otherwise.
const label = (t: Target, file: string) => (t.name ? `${t.name}:${file}` : file);

export function recallCommand(query: string[], opts: RecallCliOpts): void {
  const searchTargets = targets(opts.all);
  if (searchTargets.length === 0) {
    console.error(opts.all ? "No registered projects with a .wolf/ found." : "No .wolf/ in this project. Run `openwolf init` first.");
    process.exitCode = 1;
    return;
  }

  // --- Targeted second layer: resolve a citation id to its full block (searches every target). ---
  if (opts.id) {
    for (const t of searchTargets) {
      const entry = resolveId(t.wolfDir, opts.id);
      if (entry) {
        if (opts.json) { process.stdout.write(JSON.stringify({ ...entry, project: t.name }, null, 2) + "\n"); return; }
        console.log(`[${entry.id}]  ${label(t, entry.file)}:${entry.line}\n`);
        console.log(entry.text);
        return;
      }
    }
    if (opts.json) process.stdout.write("null\n");
    else console.log(`No entry with id "${opts.id}".`);
    process.exitCode = 1;
    return;
  }

  const q = (query || []).join(" ").trim();
  if (!q) {
    console.error("Usage: openwolf recall <query> [--full] [--all]  |  openwolf recall --id <id>");
    process.exitCode = 1;
    return;
  }
  const limit = Math.max(1, parseInt(opts.limit || "12", 10) || 12);

  const hits = recallAcross(searchTargets, q, { limit });

  if (opts.json) {
    process.stdout.write(JSON.stringify(hits.map(({ wolfDir, ...h }) => h), null, 2) + "\n");
    return;
  }
  if (hits.length === 0) {
    console.log(`No matches for "${q}"${opts.all ? " across all projects" : ""}.`);
    return;
  }
  console.log(`${hits.length} match(es) for "${q}"${opts.all ? ` across ${searchTargets.length} projects` : ""}:\n`);
  for (const h of hits) {
    const loc = h.project ? `${h.project}:${h.file}` : h.file;
    console.log(`  [${h.id}] ${String(h.score).padStart(3)}  ${loc}:${h.line}`);
    if (opts.full) {
      const entry = resolveId(h.wolfDir, h.id);
      const body = entry ? entry.text : h.text;
      console.log(body.split("\n").map((l) => `       │ ${l}`).join("\n"));
    } else {
      const snippet = h.text.length > 120 ? h.text.slice(0, 117) + "…" : h.text;
      console.log(`       ${snippet}`);
    }
  }
  console.log(opts.full
    ? `\nCite an entry as [id]; re-open it later with \`openwolf recall --id <id>${opts.all ? " --all" : ""}\`.`
    : `\nExpand: \`openwolf recall "${q}" --full${opts.all ? " --all" : ""}\`  ·  one entry: \`openwolf recall --id <id>${opts.all ? " --all" : ""}\``);
}
