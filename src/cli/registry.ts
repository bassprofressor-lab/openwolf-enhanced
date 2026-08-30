/**
 * Central registry of all OpenWolf-managed projects.
 * Stored at ~/.openwolf/registry.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isWindows } from "../utils/platform.js";
import { writeJSON, withLock } from "../utils/fs-safe.js";

export interface RegisteredProject {
  root: string;
  name: string;
  registered_at: string;
  last_updated: string;
  version: string;
}

export interface Registry {
  version: number;
  projects: RegisteredProject[];
}

export function getRegistryDir(): string {
  return path.join(os.homedir(), ".openwolf");
}

export function getRegistryPath(): string {
  return path.join(getRegistryDir(), "registry.json");
}

export function readRegistry(): Registry {
  const registryPath = getRegistryPath();
  try {
    const raw = fs.readFileSync(registryPath, "utf-8");
    return JSON.parse(raw) as Registry;
  } catch {
    return { version: 1, projects: [] };
  }
}

export function writeRegistry(registry: Registry): void {
  const dir = getRegistryDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic: a plain writeFileSync truncates first, so a reader arriving mid-write got a partial
  // file and readRegistry()'s catch turned that into "no projects registered". This registry is
  // the list `openwolf update` walks — an empty read is not a harmless glitch.
  writeJSON(getRegistryPath(), registry);
}

/**
 * Read-modify-write the registry under a lock.
 *
 * ~/.openwolf/registry.json is the one piece of state shared by EVERY project on the machine, and
 * it was the only shared file with neither a lock nor an atomic write. `openwolf init` in several
 * projects at once — which is exactly how a machine gets set up — had each process read the same
 * snapshot and write its own back, so all but the last registration were lost silently.
 *
 * The lock lives next to the registry, not in a project, because the contention is between
 * projects.
 */
function updateRegistry(mutate: (registry: Registry) => boolean): void {
  const dir = getRegistryDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  withLock(getRegistryPath(), () => {
    const registry = readRegistry();
    // The mutator says whether anything actually changed. A lookup that matched nothing must not
    // rewrite the file — nor create one, which would turn a typo'd path into a new registry.
    if (mutate(registry)) writeRegistry(registry);
  });
}

/**
 * Register a project in the central registry.
 * Updates existing entry if the project root matches.
 */
export function registerProject(projectRoot: string, name: string, version: string): void {
  const normalized = normalizeProjectPath(projectRoot);
  const now = new Date().toISOString();

  updateRegistry((registry) => {
    const existing = registry.projects.find(p => normalizeProjectPath(p.root) === normalized);
    if (existing) {
      existing.name = name;
      existing.last_updated = now;
      existing.version = version;
    } else {
      registry.projects.push({
        root: projectRoot,
        name,
        registered_at: now,
        last_updated: now,
        version,
      });
    }
    return true;
  });
}

/**
 * Remove a project from the registry. Returns the entries that were removed, so the caller can
 * name them — an unregister that prints nothing is indistinguishable from one that missed.
 *
 * Nothing is written when nothing matched: a typo'd path must not create a registry file, nor
 * rewrite an existing one for no reason.
 *
 * This touches the registry ONLY. The project's .wolf/ directory stays exactly where it is.
 */
export function unregisterProject(projectRoot: string): RegisteredProject[] {
  const target = normalizeProjectPath(projectRoot);
  let removed: RegisteredProject[] = [];
  updateRegistry((registry) => {
    removed = registry.projects.filter(p => normalizeProjectPath(p.root) === target);
    if (removed.length === 0) return false;
    registry.projects = registry.projects.filter(p => normalizeProjectPath(p.root) !== target);
    return true;
  });
  return removed;
}

/**
 * Drop every entry whose project no longer has a .wolf/ — the same view `openwolf update` takes,
 * so this removes exactly the entries update would otherwise keep failing on.
 *
 * Deliberately NOT automatic: a root can be missing because a network share or external drive
 * is not mounted right now, and pruning that would quietly unregister a live project. The caller
 * asks for this explicitly.
 */
export function pruneMissingProjects(): RegisteredProject[] {
  const isPresent = (p: RegisteredProject): boolean => fs.existsSync(path.join(p.root, ".wolf"));
  let gone: RegisteredProject[] = [];
  updateRegistry((registry) => {
    gone = registry.projects.filter(p => !isPresent(p));
    if (gone.length === 0) return false;
    registry.projects = registry.projects.filter(isPresent);
    return true;
  });
  return gone;
}

/**
 * Get all registered projects, optionally filtering out ones that no longer exist.
 */
export function getRegisteredProjects(validateExists: boolean = false): RegisteredProject[] {
  const registry = readRegistry();
  if (!validateExists) return registry.projects;

  const valid: RegisteredProject[] = [];
  const removed: string[] = [];

  for (const project of registry.projects) {
    const wolfDir = path.join(project.root, ".wolf");
    if (fs.existsSync(wolfDir)) {
      valid.push(project);
    } else {
      removed.push(project.root);
    }
  }

  // Clean up stale entries — through the lock, since another process may be registering right now
  // and a snapshot written from here would drop its brand-new entry.
  if (removed.length > 0) {
    updateRegistry((reg) => {
      reg.projects = reg.projects.filter((p) => fs.existsSync(path.join(p.root, ".wolf")));
      return true;
    });
  }

  return valid;
}

/**
 * Canonical form for deciding whether two paths mean the same project.
 *
 * Case-folding is Windows-only on purpose. NTFS treats `C:\\Proj` and `c:\\proj` as one directory,
 * so folding is the only way to recognise the same project there. On Linux they are two DIFFERENT
 * directories, and folding meant `unregister /srv/App` also matched the entry for `/srv/app` — a
 * removal of something the user never named. The same comparison decides whether `registerProject`
 * updates an entry or adds one, so the bug could also overwrite a neighbouring project's record.
 *
 * `path.resolve` first, so a relative argument, a trailing separator or a `..` segment compares
 * equal to the stored absolute root. Exported for the tests: this one line decides what a
 * destructive command deletes.
 */
export function normalizeProjectPath(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return isWindows() ? resolved.toLowerCase() : resolved;
}
