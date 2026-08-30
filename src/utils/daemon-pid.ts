import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJSON, writeJSON } from "./fs-safe.js";

/**
 * Proof that a given process is THIS project's daemon.
 *
 * `openwolf daemon stop` used to end with "find the PID listening on the configured dashboard port
 * and kill it". Port occupancy is not ownership: the configured port is a number in a committed
 * config file, the daemon may have been moved to a free one, and on a developer machine 18791 is
 * just as likely to be a dev server, another project's daemon, or something entirely unrelated.
 * The stop command would kill it and report success.
 *
 * So the daemon records what it actually is, after the bind succeeds, and stop only kills a process
 * that matches that record. Anything else holding the port is named and left alone.
 */
export interface DaemonRecord {
  pid: number;
  /** Which project this daemon serves — a daemon can hot-switch, so this is the BOOT root. */
  project_root: string;
  /** A PID from another machine means nothing here; NFS-shared home directories are real. */
  hostname: string;
  port: number;
  started_at: string;
}

export function daemonPidPath(wolfDir: string): string {
  return path.join(wolfDir, "daemon.pid");
}

export function writeDaemonRecord(wolfDir: string, projectRoot: string, port: number): void {
  try {
    writeJSON(daemonPidPath(wolfDir), {
      pid: process.pid,
      project_root: projectRoot,
      hostname: os.hostname(),
      port,
      started_at: new Date().toISOString(),
    } satisfies DaemonRecord);
  } catch { /* the daemon still works without the record; stop just falls back to reporting */ }
}

export function clearDaemonRecord(wolfDir: string): void {
  try { fs.unlinkSync(daemonPidPath(wolfDir)); } catch { /* already gone */ }
}

/** Is the PID currently alive? Signal 0 tests existence without delivering anything. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user — alive, and emphatically not ours to kill.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The PID this project's daemon claims, or null.
 *
 * Every condition has to hold: a record written on THIS host, for THIS project root, naming a live
 * process. A stale record (daemon crashed, machine rebooted and the PID was reused) fails the
 * liveness test or the host test, and a record copied along with the project fails the root test.
 */
export function readOwnDaemonPid(wolfDir: string, projectRoot: string): number | null {
  const rec = readJSON<Partial<DaemonRecord>>(daemonPidPath(wolfDir), {});
  if (typeof rec.pid !== "number" || rec.pid <= 0) return null;
  if (rec.hostname !== os.hostname()) return null;
  if (path.resolve(rec.project_root ?? "") !== path.resolve(projectRoot)) return null;
  if (!pidIsAlive(rec.pid)) return null;
  return rec.pid;
}
