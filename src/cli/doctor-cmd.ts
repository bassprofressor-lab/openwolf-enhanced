import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { readRegistry, getRegistryPath } from "./registry.js";
import {
  getRetention,
  footprint,
  humanBytes,
  compactLedger,
  consolidateMemory,
  dedupeAndCapBuglog,
  pruneBackups,
  cleanTmp,
  rotateDaemonLog,
  dirSize,
  suggestIgnores,
  type CompactResult,
} from "../utils/maintenance.js";

interface DoctorOpts {
  dryRun?: boolean;
}

// `openwolf doctor` — daemon-independent .wolf/ health report + compaction.
export async function doctorCommand(opts: DoctorOpts): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  const ret = getRetention(wolfDir);
  const dry = !!opts.dryRun;

  console.log("OpenWolf Doctor");
  console.log("===============\n");

  // --- Footprint report ---
  const before = footprint(wolfDir, ret);
  console.log(`.wolf/ footprint: ${humanBytes(before.total)}`);
  for (const it of before.items.slice(0, 8)) {
    console.log(`  ${humanBytes(it.bytes).padStart(9)}  ${it.name}`);
  }
  if (before.warnings.length) {
    console.log("\nWarnings:");
    for (const w of before.warnings) console.log(`  ⚠ ${w}`);
  }

  // --- Cross-project registry health: dead entries + dashboard-port collisions ---
  try {
    const projects = readRegistry().projects || [];
    const dead = projects.filter((p) => !fs.existsSync(p.root));
    const portMap = new Map<number, string[]>();
    for (const p of projects) {
      if (!fs.existsSync(p.root)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(p.root, ".wolf", "config.json"), "utf-8"));
        const port = cfg?.openwolf?.dashboard?.port;
        if (typeof port === "number") portMap.set(port, [...(portMap.get(port) || []), p.name]);
      } catch { /* config missing/unreadable */ }
    }
    const collisions = [...portMap.entries()].filter(([, names]) => names.length > 1);
    if (dead.length || collisions.length) {
      console.log("\nRegistry health:");
      for (const d of dead) {
        console.log(`  ⚠ dead entry: ${d.name} → ${d.root} (path gone). Remove it from ${getRegistryPath()}.`);
      }
      for (const [port, names] of collisions) {
        console.log(`  ⚠ port ${port} shared by ${names.join(", ")} — their daemons will collide. Give each a unique dashboard.port in .wolf/config.json.`);
      }
    } else if (projects.length > 1) {
      console.log(`\nRegistry health: ${projects.length} projects — unique ports, no dead entries ✓`);
    }
  } catch { /* registry not readable — skip */ }

  // --- .wolfignore suggestions: noisy project dirs the scanner reads but needn't ---
  try {
    const suggestions = suggestIgnores(projectRoot);
    if (suggestions.length) {
      console.log("\nSuggested .wolfignore entries (not ignored yet, add to skip scanning):");
      for (const s of suggestions) {
        console.log(`  ${s.pattern.padEnd(32)} ${s.reason}`);
      }
      console.log(`  → append the useful ones to ${path.join(projectRoot, ".wolfignore")}`);
    }
  } catch { /* scan failed — skip suggestions */ }

  if (dry) {
    console.log("\n(dry run — no changes written. Run without --dry-run to compact.)");
    return;
  }

  // --- Compaction pass ---
  console.log("\nCompacting…");
  const totalBefore = before.total;
  const results: CompactResult[] = [
    compactLedger(wolfDir, ret),
    consolidateMemory(wolfDir, ret.memory_consolidate_after_days),
    dedupeAndCapBuglog(wolfDir, ret.buglog_max_entries),
    pruneBackups(wolfDir, ret.backups_keep),
    rotateDaemonLog(wolfDir, ret.daemon_log_max_bytes),
    cleanTmp(wolfDir),
  ];

  let anyChange = false;
  for (const r of results) {
    console.log(`  ${r.changed ? "✓" : "·"} ${r.detail}`);
    if (r.changed) anyChange = true;
  }

  const totalAfter = dirSize(wolfDir);
  const freed = totalBefore - totalAfter;
  console.log("");
  if (anyChange && freed > 0) {
    console.log(`Done. .wolf/ ${humanBytes(totalBefore)} → ${humanBytes(totalAfter)} (freed ${humanBytes(freed)}).`);
  } else if (anyChange) {
    console.log(`Done. .wolf/ now ${humanBytes(totalAfter)}.`);
  } else {
    console.log("Everything already within limits — nothing to compact.");
  }
}
