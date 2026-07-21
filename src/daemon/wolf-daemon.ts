import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON, writeJSON, withLock } from "../utils/fs-safe.js";
import { ensureDashboardToken, tokenMatches } from "../utils/dashboard-auth.js";
import { Logger } from "../utils/logger.js";
import { CronEngine } from "./cron-engine.js";
import { startFileWatcher } from "./file-watcher.js";
import { DesignQCEngine } from "../designqc/designqc-engine.js";
import { DEFAULT_VIEWPORTS } from "../designqc/designqc-types.js";
import { getRegisteredProjects } from "../cli/registry.js";
import { aggregateProjects, aggregateNativeMemory, nativeMemoryHealth, nativeMemoryFiles } from "../utils/maintenance.js";
import { resolveLlmConfig, requiresApiKey } from "./llm-provider.js";
import { nativeMemoryDir } from "../hooks/shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prefer explicit OPENWOLF_PROJECT_ROOT env (set by CLI commands) over cwd detection.
// projectRoot/wolfDir are mutable so /api/switch can hot-reload another project in place.
// The dashboard token, by contrast, is per-daemon (not re-read on switch) so an authenticated
// dashboard session survives a project switch.
let projectRoot = process.env.OPENWOLF_PROJECT_ROOT || findProjectRoot();
let wolfDir = path.join(projectRoot, ".wolf");

interface WolfConfig {
  openwolf: {
    daemon: { port: number; log_level: string };
    dashboard: { enabled: boolean; port: number; host?: string };
    cron: { enabled: boolean; heartbeat_interval_minutes: number };
  };
}

function loadConfig(dir: string): WolfConfig {
  return readJSON<WolfConfig>(path.join(dir, "config.json"), {
    openwolf: {
      daemon: { port: 18790, log_level: "info" },
      dashboard: { enabled: true, port: 18791 },
      cron: { enabled: true, heartbeat_interval_minutes: 30 },
    },
  });
}
// Mutable: switchProject re-reads the NEW project's config (its cron.enabled used to be ignored).
// Bind-once values — daemon/dashboard ports, log level, heartbeat cadence — still need a restart.
let config = loadConfig(wolfDir);

// Per-project dashboard token, required on every /api/* request and WS connection.
const dashboardToken = ensureDashboardToken(wolfDir);

const logger = new Logger(
  path.join(wolfDir, "daemon.log"),
  config.openwolf.daemon.log_level as "debug" | "info" | "warn" | "error"
);

const startTime = Date.now();
const wsClients = new Set<WebSocket>();

// Files served to the dashboard on demand (via /api/files and full_state broadcasts).
const WOLF_BROADCAST_FILES = [
  "OPENWOLF.md", "identity.md", "cerebrum.md", "memory.md", "anatomy.md",
  "config.json", "token-ledger.json", "buglog.json",
  "cron-manifest.json", "cron-state.json",
  "designqc-report.json", "activity.log",
];

// Read a .wolf file for delivery to the dashboard, trimming the largest ones so a
// multi-MB token-ledger.json isn't shipped in full over HTTP/WS on every connect.
// The dashboard only needs lifetime aggregates + recent sessions, so we keep the
// last 50 sessions when the file is large.
function readWolfFileForDashboard(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(wolfDir, file), "utf-8");
  } catch {
    return "";
  }
  if (file === "token-ledger.json" && raw.length > 256 * 1024) {
    try {
      const led = JSON.parse(raw) as { sessions?: unknown[]; [k: string]: unknown };
      if (Array.isArray(led.sessions) && led.sessions.length > 50) {
        led.sessions = led.sessions.slice(-50);
        led._trimmed_for_dashboard = true;
      }
      return JSON.stringify(led);
    } catch {
      return raw;
    }
  }
  return raw;
}

// Express server
const app = express();
app.use(express.json());

// Serve dashboard static files (unauthenticated so the page can load and read its token).
// In dist: dist/src/daemon/wolf-daemon.js → ../../../dist/dashboard/
const dashboardDir = path.resolve(__dirname, "..", "..", "..", "dist", "dashboard");
if (fs.existsSync(dashboardDir)) {
  app.use(express.static(dashboardDir));
}

// Unauthenticated identity probe: lets `openwolf dashboard` tell whether the daemon already on this
// port belongs to THIS project (connect) or another one (move to a free port). Only exposes the
// project root — no secrets, and the server binds to localhost.
app.get("/api/whoami", (_req, res) => {
  res.json({ project: projectRoot });
});

// Require the dashboard token on every /api/* call (header or ?token=). Blocks drive-by
// requests from a page in the user's browser or another local user (upstream #30/#34).
app.use("/api", (req, res, next) => {
  const provided = (req.headers["x-openwolf-token"] as string) || (req.query.token as string) || "";
  if (!tokenMatches(provided, dashboardToken)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// Detect project metadata
function detectProjectMeta(): { name: string; description: string } {
  let name = path.basename(projectRoot);
  let description = "";

  // Try package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    if (pkg.name) name = pkg.name;
    if (pkg.description) description = pkg.description;
  } catch {}

  // Try Cargo.toml for name if not found
  if (name === path.basename(projectRoot)) {
    try {
      const cargo = fs.readFileSync(path.join(projectRoot, "Cargo.toml"), "utf-8");
      const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) name = nameMatch[1];
    } catch {}
  }

  // If no description, try cerebrum.md project description
  if (!description) {
    try {
      const cerebrum = fs.readFileSync(path.join(wolfDir, "cerebrum.md"), "utf-8");
      const descMatch = cerebrum.match(/\*\*Project:\*\*\s*(.+)/);
      if (descMatch) description = descMatch[1].trim();
    } catch {}
  }

  // If still no description, try README first paragraph
  if (!description) {
    for (const readme of ["README.md", "readme.md", "README.rst"]) {
      try {
        const content = fs.readFileSync(path.join(projectRoot, readme), "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("!") && !trimmed.startsWith("=") && !trimmed.startsWith("-") && !trimmed.startsWith("<") && !trimmed.startsWith("[") && !trimmed.startsWith("```") && trimmed.length > 10) {
            description = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
            break;
          }
        }
        if (description) break;
      } catch {}
    }
  }

  return { name, description };
}

let projectMeta = detectProjectMeta();

// API routes
app.get("/api/config", (_req, res) => {
  const llm = resolveLlmConfig(path.join(projectRoot, ".wolf"));
  // A local model server needs no key — the dashboard must not report AI tasks as unavailable there.
  const usable = !!process.env[llm.apiKeyEnv] || !requiresApiKey(llm);
  res.json({ hasApiKey: usable, llmProvider: llm.provider, llmModel: llm.model });
});

app.get("/api/projects", (_req, res) => {
  res.json(getRegisteredProjects(true));
});

// Cross-project rollup for the aggregate dashboard view.
app.get("/api/aggregate", (_req, res) => {
  res.json({ projects: aggregateProjects(getRegisteredProjects(true)) });
});

// Claude's native Auto Memory for this project — read-only browse + health.
app.get("/api/native-memory", (_req, res) => {
  const nd = nativeMemoryDir(projectRoot);
  if (!nd) { res.json({ available: false }); return; }
  try {
    res.json({ available: true, health: nativeMemoryHealth(nd), files: nativeMemoryFiles(nd) });
  } catch {
    res.json({ available: false });
  }
});

// Cross-project native-memory health rollup — one row per registered project.
app.get("/api/native-memory/aggregate", (_req, res) => {
  res.json({ projects: aggregateNativeMemory(getRegisteredProjects(true)) });
});

// Read one native-memory topic file. Name must be a plain .md basename that actually exists in
// the directory (no path separators / traversal), and the content is size-capped.
app.get("/api/native-memory/file", (req, res) => {
  const nd = nativeMemoryDir(projectRoot);
  if (!nd) { res.status(404).json({ error: "no native memory" }); return; }
  const name = String(req.query.name ?? "");
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) { res.status(400).json({ error: "invalid name" }); return; }
  let listing: string[] = [];
  try { listing = fs.readdirSync(nd); } catch { /* unreadable */ }
  if (!listing.includes(name)) { res.status(404).json({ error: "not found" }); return; }
  try {
    let content = fs.readFileSync(path.join(nd, name), "utf-8");
    if (content.length > 200_000) content = content.slice(0, 200_000) + "\n… (truncated)";
    res.json({ name, content });
  } catch {
    res.status(500).json({ error: "read failed" });
  }
});

app.post("/api/switch", (req, res) => {
  const { root } = (req.body ?? {}) as { root?: string };
  if (!root || !fs.existsSync(path.join(root, ".wolf"))) {
    res.status(400).json({ error: "Invalid project root" });
    return;
  }
  // Only switch to a project that's actually registered — don't let an authenticated request
  // point the daemon at an arbitrary directory on disk that happens to contain a .wolf/.
  const isRegistered = getRegisteredProjects(true).some((p) => path.resolve(p.root) === path.resolve(root));
  if (!isRegistered) {
    res.status(403).json({ error: "Not a registered OpenWolf project" });
    return;
  }
  if (root === projectRoot) {
    res.status(400).json({ error: "Already on this project" });
    return;
  }
  res.json({ ok: true });
  // Hot-reload in place — no process restart, existing (authenticated) WS clients are kept.
  setImmediate(() => switchProject(root));
});

app.get("/api/health", (_req, res) => {
  const cronState = readJSON<{ engine_status: string; last_heartbeat: string | null; dead_letter_queue: unknown[] }>(
    path.join(wolfDir, "cron-state.json"),
    { engine_status: "unknown", last_heartbeat: null, dead_letter_queue: [] }
  );
  const cronManifest = readJSON<{ tasks?: unknown[] }>(
    path.join(wolfDir, "cron-manifest.json"),
    { tasks: [] }
  );
  const taskCount = Array.isArray(cronManifest.tasks) ? cronManifest.tasks.length : 0;
  res.json({
    status: "healthy",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    last_heartbeat: cronState.last_heartbeat,
    tasks: taskCount,
    dead_letters: Array.isArray(cronState.dead_letter_queue) ? cronState.dead_letter_queue.length : 0,
  });
});

app.get("/api/project", (_req, res) => {
  res.json({
    name: projectMeta.name,
    description: projectMeta.description,
    root: projectRoot,
  });
});

app.get("/api/files", (_req, res) => {
  const files: Record<string, string> = {};
  for (const file of WOLF_BROADCAST_FILES) {
    files[file] = readWolfFileForDashboard(file);
  }
  // Also try suggestions.json
  try {
    files["suggestions.json"] = fs.readFileSync(path.join(wolfDir, "suggestions.json"), "utf-8");
  } catch {
    files["suggestions.json"] = "";
  }
  res.json(files);
});

app.get("/api/designqc-report", (_req, res) => {
  const report = readJSON(path.join(wolfDir, "designqc-report.json"), null);
  res.json(report);
});

// Serve a Design QC capture image so the dashboard can show thumbnails/lightbox
// instead of bare filenames. Under /api → already behind the dashboard-token gate
// (which also accepts ?token=, so an <img src> can authenticate). Path-safe.
app.get("/api/designqc/capture/:file", (req, res) => {
  const capturesDir = path.join(wolfDir, "designqc-captures");
  const safe = path.basename(req.params.file); // strip any traversal
  const filePath = path.join(capturesDir, safe);
  if (!filePath.startsWith(capturesDir + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: "capture not found" });
    return;
  }
  const ext = path.extname(safe).toLowerCase();
  const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-cache");
  // The capture lives under .wolf/ (a dotdir); Express 5's sendFile defaults to
  // dotfiles:"ignore" and would 404 the whole path. Allow it explicitly.
  res.sendFile(filePath, { dotfiles: "allow" });
});

// Manually trigger a Design QC capture (works on a deployed URL, not just localhost — #4, bug 4).
app.post("/api/designqc/run", (req, res) => {
  const dc = (config.openwolf as unknown as { designqc?: { viewports?: unknown[]; max_screenshots?: number; chrome_path?: string | null } }).designqc ?? {};
  const engine = new DesignQCEngine(wolfDir, projectRoot, {
    devServerUrl: (req.body as { url?: string })?.url || undefined,
    viewports: (dc.viewports as never) || DEFAULT_VIEWPORTS,
    maxScreenshots: dc.max_screenshots || 16,
    chromePath: dc.chrome_path ?? undefined,
    quality: 70,
    maxWidth: 1200,
  });
  res.setTimeout(120_000);
  engine.capture()
    .then((result) => res.json({ status: "ok", screenshots: result.screenshots.length, total_size_kb: result.totalSizeKB }))
    .catch((err) => {
      logger.error(`DesignQC run failed: ${err}`);
      res.status(500).json({ error: String(err) });
    });
});

// Trigger a cron task by ID
app.post("/api/cron/run/:taskId", (req, res) => {
  const { taskId } = req.params;
  if (!cronEngine) {
    res.status(503).json({ error: "Cron engine not running" });
    return;
  }
  // Return 202 immediately — the task runs in the background; results arrive via the
  // WebSocket / file-watcher. A failure is broadcast as task_error (upstream #4, bug 1).
  res.status(202).json({ status: "accepted", task_id: taskId });
  cronEngine.runTask(taskId).catch((err) => {
    logger.error(`Manual task trigger failed for ${taskId}: ${err}`);
    broadcast({ type: "task_error", task_id: taskId, error: String(err) });
  });
});

// SPA fallback
app.get("/{*path}", (_req, res) => {
  const indexPath = path.join(dashboardDir, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: "Dashboard not built. Run: pnpm build:dashboard" });
  }
});

// Start HTTP server
// OPENWOLF_DASHBOARD_PORT lets `openwolf dashboard` place this daemon on a free port when the
// configured one is taken by another project's daemon (multi-project port handling).
const port = Number(process.env.OPENWOLF_DASHBOARD_PORT) || config.openwolf.dashboard.port;
// Bind to loopback by default so the dashboard isn't exposed on the network (upstream #30).
const host = config.openwolf.dashboard.host || "127.0.0.1";
const server = app.listen(port, host, () => {
  logger.info(`Dashboard server listening on ${host}:${port}`);
});

// WebSocket server. Reject the upgrade before it completes if the token is missing/wrong,
// so an unauthenticated client never establishes a connection at all.
const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    let t = "";
    try { t = new URL(info.req.url || "", "http://localhost").searchParams.get("token") || ""; } catch { /* reject */ }
    if (tokenMatches(t, dashboardToken)) cb(true);
    else cb(false, 401, "unauthorized");
  },
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  logger.info("WebSocket client connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; task_id?: string };
      handleDashboardCommand(msg);
    } catch {
      logger.warn("Invalid WebSocket message received");
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
  });

  // Send the current full state to THIS newly-connected client. Without this, a fresh page load or
  // an auto-reconnect after a daemon restart never re-fetches the files — the dashboard keeps showing
  // stale pre-restart data until some .wolf file happens to change. (The frontend doesn't request it.)
  try {
    const files: Record<string, string> = {};
    for (const file of WOLF_BROADCAST_FILES) files[file] = readWolfFileForDashboard(file);
    ws.send(JSON.stringify({ type: "full_state", files, timestamp: new Date().toISOString() }));
  } catch (err) {
    logger.error(`Initial full_state failed: ${err}`);
  }
  broadcast({ type: "daemon_started", timestamp: new Date().toISOString() });
});

function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function handleDashboardCommand(msg: { type: string; task_id?: string }): void {
  switch (msg.type) {
    case "trigger_task":
      if (msg.task_id && cronEngine) {
        cronEngine.runTask(msg.task_id).catch((err) => {
          logger.error(`Manual task trigger failed: ${err}`);
        });
      }
      break;
    case "retry_dead_letter":
      if (msg.task_id) {
        // Same lock as the cron engine's execution_log writes: this read-modify-write must not
        // race a concurrent writer (engine entry, CLI `cron retry`) and clobber it.
        const statePath = path.join(wolfDir, "cron-state.json");
        withLock(statePath, () => {
          const state = readJSON<{ dead_letter_queue: Array<{ task_id: string }> }>(statePath, {
            dead_letter_queue: [],
          });
          state.dead_letter_queue = state.dead_letter_queue.filter(
            (d) => d.task_id !== msg.task_id
          );
          writeJSON(statePath, state);
        });
      }
      break;
    case "force_scan":
      if (cronEngine) {
        cronEngine.runTask("anatomy-rescan").catch((err) => {
          logger.error(`Force scan failed: ${err}`);
        });
      }
      break;
    case "request_full_state":
      // Send all files
      try {
        const files: Record<string, string> = {};
        for (const file of WOLF_BROADCAST_FILES) {
          files[file] = readWolfFileForDashboard(file);
        }
        broadcast({ type: "full_state", files, timestamp: new Date().toISOString() });
      } catch (err) {
        logger.error(`Full state request failed: ${err}`);
      }
      break;
  }
}

// Cron engine
let cronEngine: CronEngine | null = null;
if (config.openwolf.cron.enabled) {
  cronEngine = new CronEngine(wolfDir, projectRoot, logger, broadcast);
  cronEngine.start();
}

// File watcher
let fileWatcher = startFileWatcher(wolfDir, logger, broadcast);

// Hot-switch to another registered project without restarting the process (#4, bug 7).
// The dashboard token is unchanged, so already-connected clients stay authenticated.
function switchProject(newRoot: string): void {
  logger.info(`Switching project to: ${newRoot}`);

  // Stop the current subsystems.
  if (cronEngine) { cronEngine.stop(); cronEngine = null; }
  fileWatcher.close();

  // Swap the mutable project bindings — including the config, so the NEW project's settings
  // (cron.enabled in particular) govern from here on, not the boot project's.
  projectRoot = newRoot;
  wolfDir = path.join(newRoot, ".wolf");
  projectMeta = detectProjectMeta();
  config = loadConfig(wolfDir);

  // Restart subsystems for the new project.
  if (config.openwolf.cron.enabled) {
    cronEngine = new CronEngine(wolfDir, projectRoot, logger, broadcast);
    cronEngine.start();
  }
  fileWatcher = startFileWatcher(wolfDir, logger, broadcast);

  // Mark the new project as running.
  markCronState({ engine_status: "running", last_heartbeat: new Date().toISOString() });

  // Push the new project's state to all connected dashboard clients (trimmed via the helper).
  const files: Record<string, string> = {};
  for (const file of WOLF_BROADCAST_FILES) files[file] = readWolfFileForDashboard(file);
  broadcast({ type: "project_switched", project: { name: projectMeta.name, root: projectRoot }, files });
}

// Read-modify-write cron-state.json under the same lock the cron engine holds for its
// execution_log entries — an unlocked stale-snapshot write (from this process's timers or a
// concurrent CLI `openwolf cron retry`) could otherwise clobber a freshly appended entry.
// Always derives the path from the LIVE wolfDir (correct across project switches).
function markCronState(patch: Record<string, unknown>): void {
  const statePath = path.join(wolfDir, "cron-state.json");
  withLock(statePath, () => {
    const state = readJSON<Record<string, unknown>>(statePath, {});
    writeJSON(statePath, { ...state, ...patch });
  });
}

// Health heartbeat
const heartbeatInterval = config.openwolf.cron.heartbeat_interval_minutes * 60 * 1000;
const heartbeatTimer = setInterval(() => {
  markCronState({ last_heartbeat: new Date().toISOString() });
  broadcast({ type: "health", status: "healthy", uptime: Math.floor((Date.now() - startTime) / 1000) });
}, heartbeatInterval);

// Update cron-state to running
markCronState({ engine_status: "running", last_heartbeat: new Date().toISOString() });

logger.info("OpenWolf daemon started");

// Graceful shutdown
function shutdown(): void {
  logger.info("Daemon shutting down...");
  broadcast({ type: "daemon_stopping", timestamp: new Date().toISOString() });

  clearInterval(heartbeatTimer);
  if (cronEngine) cronEngine.stop();

  // markCronState uses the LIVE wolfDir: after a project switch, shutdown must mark the
  // actual project "stopped", not the boot project.
  markCronState({ engine_status: "stopped" });

  for (const client of wsClients) {
    client.close();
  }
  wsClients.clear();

  server.close(() => {
    logger.info("Daemon stopped");
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
