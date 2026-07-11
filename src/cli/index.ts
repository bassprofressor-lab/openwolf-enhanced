import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { initCommand } from "./init.js";
import { statusCommand } from "./status.js";
import { scanCommand } from "./scan.js";
import { dashboardCommand } from "./dashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("openwolf")
    .description("Token-conscious AI brain for Claude Code projects")
    .version(getVersion());

  program
    .command("init")
    .description("Initialize .wolf/ in current project")
    .action(initCommand);

  program
    .command("status")
    .description("Show daemon health, last session stats, file integrity")
    .action(statusCommand);

  program
    .command("scan")
    .description("Force full anatomy rescan")
    .option("--check", "Verify anatomy.md matches filesystem (no changes)")
    .action(scanCommand);

  program
    .command("dashboard")
    .description("Open browser to dashboard")
    .action(dashboardCommand);

  const daemon = program
    .command("daemon")
    .description("Daemon management");

  daemon
    .command("start")
    .description("Start daemon via pm2")
    .action(async () => {
      const { daemonStart } = await import("./daemon-cmd.js");
      daemonStart();
    });

  daemon
    .command("stop")
    .description("Stop daemon")
    .action(async () => {
      const { daemonStop } = await import("./daemon-cmd.js");
      daemonStop();
    });

  daemon
    .command("restart")
    .description("Restart daemon")
    .action(async () => {
      const { daemonRestart } = await import("./daemon-cmd.js");
      daemonRestart();
    });

  daemon
    .command("logs")
    .description("Show last 50 lines of daemon log")
    .action(async () => {
      const { daemonLogs } = await import("./daemon-cmd.js");
      daemonLogs();
    });

  const cron = program
    .command("cron")
    .description("Cron task management");

  cron
    .command("list")
    .description("Show all cron tasks with next run times")
    .action(async () => {
      const { cronList } = await import("./cron-cmd.js");
      cronList();
    });

  cron
    .command("run <id>")
    .description("Manually trigger a cron task")
    .action(async (id: string) => {
      const { cronRun } = await import("./cron-cmd.js");
      await cronRun(id);
    });

  cron
    .command("retry <id>")
    .description("Retry a dead-lettered task")
    .action(async (id: string) => {
      const { cronRetry } = await import("./cron-cmd.js");
      cronRetry(id);
    });

  // --- Update command ---
  program
    .command("update")
    .description("Update all registered OpenWolf projects to latest version")
    .option("--dry-run", "Show what would be updated without making changes")
    .option("--project <name>", "Update only a specific project (partial name match)")
    .option("--list", "List all registered projects")
    .action(async (opts: { dryRun?: boolean; project?: string; list?: boolean }) => {
      const { updateCommand, listProjects } = await import("./update.js");
      if (opts.list) {
        listProjects();
      } else {
        await updateCommand(opts);
      }
    });

  // --- Restore command ---
  program
    .command("restore [backup]")
    .description("Restore .wolf from a backup (run in project dir). Without args, lists available backups.")
    .action(async (backup?: string) => {
      const { restoreCommand } = await import("./update.js");
      restoreCommand(backup);
    });

  // --- Design QC command ---
  program
    .command("designqc [target]")
    .description("Capture full-page screenshots for design evaluation by Claude Code")
    .option("--url <url>", "Dev server URL (auto-starts server if omitted)")
    .option("--routes <routes...>", "Specific routes to check")
    .option("--quality <n>", "JPEG quality 1-100 (lower = fewer tokens)", "70")
    .option("--max-width <n>", "Max capture width in px", "1200")
    .option("--desktop-only", "Skip mobile viewport captures")
    .action(async (target: string | undefined, opts: { url?: string; routes?: string[]; quality?: string; maxWidth?: string; desktopOnly?: boolean }) => {
      const { designqcCommand } = await import("./designqc-cmd.js");
      await designqcCommand(target, opts);
    });

  // --- Doctor command ---
  program
    .command("doctor")
    .description("Report .wolf/ health & footprint, then compact (daemon-independent)")
    .option("--dry-run", "Only report sizes/warnings; write nothing")
    .action(async (opts: { dryRun?: boolean }) => {
      const { doctorCommand } = await import("./doctor-cmd.js");
      await doctorCommand(opts);
    });

  // --- Export command ---
  program
    .command("export <what>")
    .description("Export .wolf data (sessions | bugs) as JSON or CSV")
    .option("--format <fmt>", "Output format: json or csv", "json")
    .option("--out <file>", "Write to a file instead of stdout")
    .action(async (what: string, opts: { format?: string; out?: string }) => {
      const { exportCommand } = await import("./export-cmd.js");
      exportCommand(what, opts);
    });

  // --- MCP server ---
  program
    .command("mcp")
    .description("Run an MCP server (recall/resume/memory-health) for Claude Desktop & other MCP clients")
    .option("--project <dir>", "Project directory to serve (default: $OPENWOLF_PROJECT_DIR or cwd)")
    .action(async (opts: { project?: string }) => {
      const { runMcpStdio } = await import("../mcp/server.js");
      const projectDir = opts.project || process.env.OPENWOLF_PROJECT_DIR || process.cwd();
      runMcpStdio({ projectDir, version: getVersion() });
    });

  // --- Recall command ---
  program
    .command("recall [query...]")
    .description("Keyword-search the .wolf knowledge files (STATUS, cerebrum, memory, buglog) + native memory")
    .option("--limit <n>", "Max results", "12")
    .option("--full", "Expand each hit to its full logical block (second disclosure layer)")
    .option("--id <id>", "Resolve a citation id to its full entry (no query needed)")
    .option("--json", "Output JSON")
    .action(async (query: string[], opts: { limit?: string; json?: boolean; full?: boolean; id?: string }) => {
      const { recallCommand } = await import("./recall-cmd.js");
      recallCommand(query, opts);
    });

  // --- Bug command ---
  const bug = program
    .command("bug")
    .description("Bug memory management");

  bug
    .command("search <term>")
    .description("Search buglog for matching entries")
    .action(async (term: string) => {
      const { bugSearch } = await import("./bug-cmd.js");
      bugSearch(term);
    });

  return program;
}
