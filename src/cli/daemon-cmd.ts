import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON, writeJSON, withLock } from "../utils/fs-safe.js";
import { readDashboardToken } from "../utils/dashboard-auth.js";
import { isPortFree } from "../utils/ports.js";
import { isWindows, execShim } from "../utils/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getDashboardPort(): number {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");
  const config = readJSON<{ openwolf: { dashboard: { port: number } } }>(
    path.join(wolfDir, "config.json"),
    { openwolf: { dashboard: { port: 18791 } } }
  );
  return config.openwolf.dashboard.port;
}

// On Windows the pm2 shim is pm2.cmd. Node cannot spawn a .cmd without a shell (CVE-2024-27980
// hardening), so every call goes through execShim(), which routes it via cmd.exe with the
// arguments still quoted individually rather than joined into a parseable string.
const PM2 = isWindows() ? "pm2.cmd" : "pm2";

function getPm2Name(): string {
  const projectRoot = findProjectRoot();
  // Sanitize so the project folder name can't inject pm2/shell args or spaces.
  const safe = path.basename(projectRoot).replace(/[^A-Za-z0-9_.-]/g, "-");
  return `openwolf-${safe}`;
}

function hasPm2(): boolean {
  try {
    execFileSync(isWindows() ? "where" : "which", ["pm2"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Pull the listening PID for `port` out of a `netstat -ano -p tcp` dump.
//
// Key off the SHAPE of the row, never off words in it. Two reasons, both of which made the
// old `includes("LISTENING")` test fail on this machine:
//   1. netstat localizes the state column — a German Windows prints ABHÖREN, a French one
//      ÉCOUTE — so the daemon was never found and `daemon stop` reported "no daemon running"
//      while one was plainly listening.
//   2. netstat writes the OEM codepage, not UTF-8, so that word arrives mojibake'd anyway.
// Row layout: TCP  <local>  <remote>  <state>  <pid>. A listener is the row whose REMOTE
// address is the wildcard (0.0.0.0:0 / [::]:0); matching the port anywhere in the line also
// hit TIME_WAIT rows, whose last column is a foreign PID — one taskkill away from killing
// somebody else's process.
//
// Exported for the test, and pure on purpose: the bug lived in the PARSE, and a parse that can
// only be exercised through a live socket on a localized Windows is a parse nobody tests.
// Everything platform-bound — spawning netstat — stays in findPidOnPort below.
export function parseNetstatListenerPid(output: string, port: number): number | null {
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") continue;
    const [, local, remote] = parts;
    if (!local.endsWith(`:${port}`) || !remote.endsWith(":0")) continue;
    const pid = parseInt(parts[parts.length - 1], 10);
    if (pid > 0) return pid;
  }
  return null;
}

function findPidOnPort(port: number): number | null {
  try {
    if (isWindows()) {
      const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf-8" });
      const pid = parseNetstatListenerPid(output, port);
      if (pid !== null) return pid;
    } else {
      const output = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8" });
      const pid = parseInt(output.trim(), 10);
      if (pid > 0) return pid;
    }
  } catch {}
  return null;
}

function killPid(pid: number): boolean {
  try {
    if (isWindows()) {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

// A hard stop skips the daemon's own shutdown handler, which is what writes engine_status
// "stopped". On Windows that is EVERY hard stop — there is no signal delivery, so both taskkill
// and pm2 terminate the process outright. Without this, cron-state.json keeps saying "running"
// and `openwolf status` plus the dashboard both report a daemon that is gone. Whoever stopped it
// writes the truth. Idempotent, so it is safe to call when the handler DID run.
function markDaemonStopped(wolfDir: string): void {
  const statePath = path.join(wolfDir, "cron-state.json");
  try {
    withLock(statePath, () => {
      const state = readJSON<Record<string, unknown>>(statePath, {});
      // No cron state at all means the daemon never wrote one — nothing to correct, and inventing
      // a file here would only confuse the next start.
      if (Object.keys(state).length === 0) return;
      writeJSON(statePath, { ...state, engine_status: "stopped" });
    });
  } catch { /* best effort — the kill already happened */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ask the daemon to shut itself down, and wait until it really has. Returns false whenever that
// path is unavailable (nothing listening, no token, a daemon older than the /api/shutdown route,
// or a process too wedged to honour it) so the caller can fall back to killing it.
async function requestGracefulStop(wolfDir: string, port: number): Promise<boolean> {
  const token = readDashboardToken(wolfDir);
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      headers: { "x-openwolf-token": token },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  // The 202 arrives BEFORE the server closes. Poll the port instead of trusting the status code —
  // shutdown() force-exits after 5s, so ~6s is the honest upper bound.
  for (let i = 0; i < 60; i++) {
    if (await isPortFree(port)) return true;
    await sleep(100);
  }
  return false;
}

export function daemonStart(): void {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  if (!hasPm2()) {
    console.log("pm2 not found. Install with: pnpm add -g pm2");
    return;
  }
  const name = getPm2Name();
  // Resolve daemon script relative to openwolf's install dir, not the target project
  const daemonScript = path.resolve(__dirname, "..", "daemon", "wolf-daemon.js");

  try {
    execShim(PM2, ["start", daemonScript, "--name", name, "--cwd", projectRoot, "--", "--env", `OPENWOLF_PROJECT_ROOT=${projectRoot}`], {
      stdio: "inherit",
      env: { ...process.env, OPENWOLF_PROJECT_ROOT: projectRoot },
    });
    execShim(PM2, ["save"], { stdio: "ignore" });
    console.log(`\n  ✓ Daemon started: ${name}`);
    if (isWindows()) {
      console.log("  Tip: Run 'pm2-windows-startup' for boot persistence.");
    }
  } catch {
    console.error("Failed to start daemon.");
  }
}

export async function daemonStop(): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  // PM2 first, and deliberately NOT the graceful endpoint here: pm2 owns the process, so a
  // self-initiated exit reads as a crash and its autorestart brings the daemon straight back.
  // `pm2 stop` is the only stop pm2 respects. It kills rather than signals on Windows, hence the
  // state fix-up afterwards.
  if (hasPm2()) {
    const name = getPm2Name();
    try {
      execShim(PM2, ["stop", name], { stdio: "ignore" });
      markDaemonStopped(wolfDir);
      console.log(`  ✓ Daemon stopped (PM2): ${name}`);
      return;
    } catch {
      // PM2 process not found — fall through to port-based stop
    }
  }

  // Unsupervised daemon (the `openwolf dashboard` case): ask it to stop itself, so its own
  // shutdown handler runs — on Windows too, where no signal could ever reach it.
  const port = getDashboardPort();
  if (await requestGracefulStop(wolfDir, port)) {
    console.log(`  ✓ Daemon stopped cleanly (port ${port})`);
    return;
  }

  // Last resort: kill whatever is listening, then write the state the handler never got to write.
  const pid = findPidOnPort(port);
  if (pid) {
    if (killPid(pid)) {
      markDaemonStopped(wolfDir);
      console.log(`  ✓ Daemon stopped (PID ${pid} on port ${port})`);
    } else {
      console.error(`  Failed to kill process ${pid} on port ${port}.`);
    }
  } else {
    console.log(`  No daemon running on port ${port}.`);
  }
}

export async function daemonRestart(): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  // First try PM2
  if (hasPm2()) {
    const name = getPm2Name();
    try {
      execShim(PM2, ["restart", name], { stdio: "ignore" });
      console.log(`  ✓ Daemon restarted (PM2): ${name}`);
      return;
    } catch {
      // PM2 process not found — fall through
    }
  }

  // Fall back: stop then start via dashboard command flow. Same order as daemonStop — ask
  // first, kill only if asking failed, and never leave cron-state.json claiming "running".
  const port = getDashboardPort();
  if (await requestGracefulStop(wolfDir, port)) {
    console.log("  Stopped old daemon cleanly.");
  } else {
    const pid = findPidOnPort(port);
    if (pid) {
      killPid(pid);
      markDaemonStopped(wolfDir);
      console.log(`  Stopped old daemon (PID ${pid}).`);
    }
  }
  console.log("  Use 'openwolf dashboard' to start a new daemon.");
}

export function daemonLogs(): void {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  if (!hasPm2()) {
    console.log("pm2 not found.");
    return;
  }

  const name = getPm2Name();
  try {
    execShim(PM2, ["logs", name, "--lines", "50", "--nostream"], { stdio: "inherit" });
  } catch {
    console.error("Failed to get daemon logs.");
  }
}
