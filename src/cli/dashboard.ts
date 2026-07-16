import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON, writeJSON } from "../utils/fs-safe.js";
import { ensureDashboardToken } from "../utils/dashboard-auth.js";
import { findFreePort } from "../utils/ports.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WolfConfig {
  openwolf: {
    dashboard: { port: number };
    daemon?: { port: number };
  };
}

/** Ask the daemon on `port` which project it serves (unauthenticated /api/whoami). null if not an
 *  OpenWolf daemon or unreachable. */
async function whoami(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/whoami`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = (await res.json()) as { project?: string };
    return j.project ?? null;
  } catch {
    return null;
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

export async function dashboardCommand(): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  const config = readJSON<WolfConfig>(path.join(wolfDir, "config.json"), {
    openwolf: { dashboard: { port: 18791 } },
  });

  let port = config.openwolf.dashboard.port;
  const configPath = path.join(wolfDir, "config.json");

  // If something already listens on the configured port, check whether it's THIS project's daemon
  // (connect to it) or another project's / a foreign server (relocate to a free port and persist
  // it) — so a second project's dashboard never opens the first project's data.
  let running = await isPortOpen(port);
  if (running) {
    const owner = await whoami(port);
    const ours = owner && path.resolve(owner) === path.resolve(projectRoot);
    if (!ours) {
      const free = await findFreePort(port + 2);
      console.log(`  Port ${port} is held by another daemon — moving this dashboard to ${free}.`);
      port = free;
      config.openwolf.dashboard.port = free;
      config.openwolf.daemon = config.openwolf.daemon ?? { port: free - 1 };
      config.openwolf.daemon.port = free - 1;
      writeJSON(configPath, config);
      running = false; // start our own daemon on the new port
    }
  }

  // The dashboard requires a token; pass it via the URL so the SPA can pick it up.
  const token = ensureDashboardToken(wolfDir);
  const baseUrl = `http://localhost:${port}`;
  const url = `${baseUrl}/?token=${token}`;

  if (!running) {
    console.log("  Daemon not running. Starting dashboard server...");

    // Find the daemon script
    const daemonScript = path.resolve(__dirname, "..", "daemon", "wolf-daemon.js");
    if (!fs.existsSync(daemonScript)) {
      console.error(`  Daemon script not found at: ${daemonScript}`);
      console.log("  Run 'pnpm build' in the openwolf directory first.");
      return;
    }

    // Fork the daemon as a child process, passing project root explicitly
    const child = fork(daemonScript, [], {
      cwd: projectRoot,
      env: { ...process.env, OPENWOLF_PROJECT_ROOT: projectRoot, OPENWOLF_DASHBOARD_PORT: String(port) },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Wait for the port to open (up to 5 seconds)
    let ready = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isPortOpen(port)) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      console.log(`  Server didn't start in time. Try manually: node "${daemonScript}"`);
      return;
    }

    console.log(`  ✓ Dashboard server running on port ${port}`);
  }

  console.log(`  Opening ${baseUrl}...`);

  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
    console.log(`  Could not open browser. Visit: ${url}`);
  }
}
