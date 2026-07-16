import * as net from "node:net";
import * as path from "node:path";
import { readJSON, writeJSON } from "./fs-safe.js";
import { getRegisteredProjects } from "../cli/registry.js";

// Multi-project port handling. Every project ships the same default dashboard/daemon ports
// (18791/18790), so running several daemons means only the first binds and every other project's
// dashboard opens the first project's data. We give each registered project a unique port pair, and
// let `openwolf dashboard` fall back to a free port at runtime if its configured one is taken.

const DEFAULT_DASH = 18791; // dashboard port (odd); the daemon pairs to dashboard-1 (even)

interface PortCfg { openwolf?: { daemon?: { port?: number }; dashboard?: { port?: number } } }

export interface PortChange { name: string; root: string; oldPort: number; newPort: number }

/** Is a TCP port free to bind on localhost? */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Lowest free dashboard port ≥ base (stepping by 2 so the daemon pair port stays free too). */
export async function findFreePort(base: number = DEFAULT_DASH, span = 100): Promise<number> {
  for (let p = base; p < base + span; p += 2) {
    if ((await isPortFree(p)) && (await isPortFree(p - 1))) return p;
  }
  return base;
}

/**
 * Give every registered project a unique dashboard/daemon port pair. A project whose dashboard port
 * collides with an already-seen project is moved to the next free pair, written to its config.json.
 * Deterministic: the first project keeps its port; later collisions get reassigned. Skips OS-level
 * checks on purpose — a project's running daemon must keep its current port; we only de-duplicate
 * across configs. Returns what changed (empty = nothing collided).
 */
export function reconcileProjectPorts(dryRun = false): PortChange[] {
  const projects = getRegisteredProjects(true);
  const used = new Set<number>();
  const changes: PortChange[] = [];

  for (const p of projects) {
    const cfgPath = path.join(p.root, ".wolf", "config.json");
    const cfg = readJSON<PortCfg>(cfgPath, {});
    if (!cfg.openwolf) continue; // uninitialized — init writes the defaults
    const dash = cfg.openwolf.dashboard ?? (cfg.openwolf.dashboard = {});
    const daemon = cfg.openwolf.daemon ?? (cfg.openwolf.daemon = {});
    let dport = dash.port ?? DEFAULT_DASH;

    if (used.has(dport) || used.has(dport - 1)) {
      let np = DEFAULT_DASH;
      while (used.has(np) || used.has(np - 1)) np += 2;
      const oldPort = dport;
      dash.port = np;
      daemon.port = np - 1;
      dport = np;
      if (!dryRun) writeJSON(cfgPath, cfg);
      changes.push({ name: p.name, root: p.root, oldPort, newPort: np });
    }
    used.add(dport);
    used.add(daemon.port ?? dport - 1);
  }
  return changes;
}
