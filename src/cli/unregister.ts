/**
 * `openwolf unregister` — take a project OUT of the central registry.
 *
 * `openwolf init` puts a project into ~/.openwolf/registry.json and nothing ever took it out
 * again. A throwaway project under %TEMP% therefore stayed on the list for good, and every
 * `openwolf update` kept walking to a path that no longer existed. The removal function had been
 * sitting in registry.ts unused since the registry was introduced; this is the command for it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import {
  readRegistry,
  unregisterProject,
  pruneMissingProjects,
  getRegistryPath,
  normalizeProjectPath,
  type RegisteredProject,
} from "./registry.js";

interface UnregisterOpts {
  prune?: boolean;
  dryRun?: boolean;
}

function describe(p: RegisteredProject): string {
  const gone = !fs.existsSync(p.root) ? " (path gone)"
    : !fs.existsSync(path.join(p.root, ".wolf")) ? " (.wolf/ gone)"
    : "";
  return `${p.name} → ${p.root}${gone}`;
}

export function unregisterCommand(target: string | undefined, opts: UnregisterOpts = {}): void {
  if (opts.prune && target) {
    console.error("  --prune removes every dead entry; it takes no path. Drop one or the other.");
    process.exitCode = 1;
    return;
  }

  const registry = readRegistry();
  if (registry.projects.length === 0) {
    console.log(`  Registry is empty (${getRegistryPath()}) — nothing to unregister.`);
    return;
  }

  if (opts.prune) {
    // Ask before touching anything, so --dry-run and the real run agree on what "dead" means.
    const dead = registry.projects.filter((p) => !fs.existsSync(path.join(p.root, ".wolf")));
    if (dead.length === 0) {
      console.log(`  No dead entries — all ${registry.projects.length} registered projects still have a .wolf/.`);
      return;
    }
    if (opts.dryRun) {
      console.log(`  [dry run] Would remove ${dead.length} dead ${dead.length === 1 ? "entry" : "entries"}:`);
      for (const p of dead) console.log(`    · ${describe(p)}`);
      return;
    }
    const removed = pruneMissingProjects();
    console.log(`  ✓ Removed ${removed.length} dead ${removed.length === 1 ? "entry" : "entries"}:`);
    for (const p of removed) console.log(`    · ${describe(p)}`);
    return;
  }

  // No path given: the project you are standing in. Resolve it the same way `init` did when it
  // registered the project, so the two agree.
  const root = target ? path.resolve(target) : findProjectRoot();

  if (opts.dryRun) {
    const hit = registry.projects.filter((p) => normalizeProjectPath(p.root) === normalizeProjectPath(root));
    if (hit.length === 0) {
      console.log(`  [dry run] ${root} is not in the registry — nothing would change.`);
      return;
    }
    console.log("  [dry run] Would remove:");
    for (const p of hit) console.log(`    · ${describe(p)}`);
    return;
  }

  const removed = unregisterProject(root);
  if (removed.length === 0) {
    console.error(`  Not registered: ${root}`);
    console.error(`  Registered projects: ${registry.projects.map((p) => p.name).join(", ")}`);
    console.error("  See the full list with 'openwolf update --list'.");
    process.exitCode = 1;
    return;
  }

  for (const p of removed) console.log(`  ✓ Unregistered ${describe(p)}`);
  console.log(`  The registry no longer lists it (${getRegistryPath()}); 'openwolf update' will skip it.`);
  console.log(`  Its .wolf/ directory was NOT touched — delete it by hand if you want it gone.`);
}
