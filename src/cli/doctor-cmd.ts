import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
  nativeMemoryHealth,
  findDuplicateEntries,
  repairNativeMemoryIndex,
  type CompactResult,
} from "../utils/maintenance.js";
import { nativeMemoryDir } from "../hooks/shared.js";

interface DoctorOpts {
  dryRun?: boolean;
  fixIndex?: boolean;
  indexDays?: string;
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

  // --- Claude native Auto Memory health (read-only interop) ---
  try {
    const nd = nativeMemoryDir(projectRoot);
    if (nd) {
      const h = nativeMemoryHealth(nd);
      console.log("\nClaude native memory (~/.claude/…/memory):");
      console.log(`  ${h.topicFiles} topic files, ${humanBytes(h.footprintBytes)}; MEMORY.md index ${h.indexLines} lines (${h.indexedCount} referenced)`);
      if (h.indexCutoffExceeded)
        console.log(`  ⚠ MEMORY.md > 200 lines — only the first 200 load at session start; the rest is invisible until you trim it.`);
      if (h.orphanCount)
        console.log(`  ⚠ ${h.orphanCount} topic files not in the index → never surface on resume. Search them: \`openwolf recall <query>\``);
      if (h.deadLinks.length)
        console.log(`  ⚠ ${h.deadLinks.length} dead index link(s) → missing file: ${h.deadLinks.slice(0, 3).join(", ")}${h.deadLinks.length > 3 ? "…" : ""}`);
      if (h.staleCount)
        console.log(`  · ${h.staleCount} topic files untouched in 90+ days`);

      // --fix-index turns that orphan warning into an action. Opt-in on purpose: MEMORY.md is
      // injected into context every session and only its first 200 lines load, so growing it is a
      // trade the user has to make knowingly.
      if (opts.fixIndex && h.orphanCount) {
        const days = Number(opts.indexDays ?? 90) || 90;
        const rep = repairNativeMemoryIndex(nd, { withinDays: days, dryRun: !!opts.dryRun });
        if (!rep.added.length) {
          console.log(`  · --fix-index: nothing to add — all ${h.orphanCount} unindexed file(s) are older than ${days}d (raise with --index-days)`);
        } else if (rep.wrote) {
          console.log(`  ✓ --fix-index: appended ${rep.added.length} entr${rep.added.length === 1 ? "y" : "ies"} to MEMORY.md`);
          for (const a of rep.added.slice(0, 5)) console.log(`      ${a.line.slice(0, 110)}`);
          if (rep.added.length > 5) console.log(`      … and ${rep.added.length - 5} more`);
        } else {
          console.log(`  · --fix-index (dry run): would append ${rep.added.length} entr${rep.added.length === 1 ? "y" : "ies"}`);
        }
        if (rep.skippedBudget)
          console.log(`  · ${rep.skippedBudget} more would not fit — only the first 200 index lines load at session start`);
        if (rep.skippedStale)
          console.log(`  · ${rep.skippedStale} unindexed file(s) older than ${days}d left out — reach them with \`openwolf recall\``);
      } else if (h.orphanCount && !opts.fixIndex) {
        console.log(`  · run \`openwolf doctor --fix-index\` to append the recent ones to MEMORY.md`);
      }
    } else {
      // [2026-08-28] A miss used to print NOTHING, which is the worst of both worlds: recall keeps
      // working (it just never sees the native store) and nobody learns that half the memory is
      // missing. nativeMemoryDir() guesses Claude Code's project slug, and the guess has known
      // blind spots: Claude sanitizes EVERY non-alphanumeric character to "-" (so the plain
      // slash→dash guess is POSIX-only), truncates past 200 characters and appends a hash, and
      // honours CLAUDE_CODE_PROJECT_DIR_NAME when CLAUDE_CONFIG_DIR is set. Say so, and name the
      // override rather than leaving the user to guess.
      const base = path.join(os.homedir(), ".claude", "projects");
      const known = fs.existsSync(base);
      console.log("\nClaude native memory (~/.claude/…/memory):");
      console.log(known
        ? `  · not found for this project — Auto Memory may be off, or the project-slug guess missed`
        : `  · ${base} does not exist — Claude Code Auto Memory has not run here`);
      if (known)
        console.log(`  · if it exists under a different name, point at it: OPENWOLF_NATIVE_MEMORY_DIR=<path>`);
    }
  } catch { /* native memory unreadable — skip */ }

  // --- Near-duplicate cerebrum entries (read-only consolidation hint) ---
  try {
    const dupes = findDuplicateEntries(wolfDir);
    if (dupes.length) {
      console.log(`\nPossible duplicate entries in cerebrum.md (${dupes.length} — review & merge, not auto-fixed):`);
      for (const d of dupes.slice(0, 5)) {
        console.log(`  ${Math.round(d.similarity * 100)}%  lines ${d.aLine} ↔ ${d.bLine}`);
        console.log(`       ${d.aPreview}…`);
        console.log(`       ${d.bPreview}…`);
      }
    }
  } catch { /* recall/blocks unavailable — skip */ }

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
