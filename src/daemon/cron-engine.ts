import * as fs from "node:fs";
import * as path from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { readJSON, writeJSON, readText, writeText, withLock } from "../utils/fs-safe.js";
import { scanProject } from "../scanner/anatomy-scanner.js";
import { detectWaste } from "../tracker/waste-detector.js";
import { resolveLlmConfig, callLlm } from "./llm-provider.js";
import type { Logger } from "../utils/logger.js";

interface CronAction {
  type: string;
  params?: Record<string, unknown>;
}

interface CronTask {
  id: string;
  name: string;
  schedule: string;
  description: string;
  action: CronAction;
  retry: { max_attempts: number; backoff: string; base_delay_seconds: number };
  failsafe: { on_failure: string; dead_letter?: boolean; alert_after_consecutive_failures?: number };
  enabled: boolean;
}

interface CronManifest {
  version: number;
  tasks: CronTask[];
}

interface ExecutionEntry {
  task_id: string;
  status: "success" | "failed";
  timestamp: string;
  duration_ms: number;
  error?: string;
}

interface CronState {
  last_heartbeat: string | null;
  engine_status: string;
  execution_log: ExecutionEntry[];
  dead_letter_queue: Array<{ task_id: string; error: string; timestamp: string; attempts: number }>;
  upcoming: unknown[];
}

export class CronEngine {
  private wolfDir: string;
  private projectRoot: string;
  private logger: Logger;
  private broadcast: (msg: unknown) => void;
  private scheduledTasks: ScheduledTask[] = [];
  private failureCounts = new Map<string, number>();

  constructor(
    wolfDir: string,
    projectRoot: string,
    logger: Logger,
    broadcast: (msg: unknown) => void
  ) {
    this.wolfDir = wolfDir;
    this.projectRoot = projectRoot;
    this.logger = logger;
    this.broadcast = broadcast;
  }

  start(): void {
    const manifest = this.readManifest();
    for (const task of manifest.tasks) {
      if (!task.enabled) continue;
      if (!cron.validate(task.schedule)) {
        this.logger.warn(`Invalid cron schedule for ${task.id}: ${task.schedule}`);
        continue;
      }
      const scheduled = cron.schedule(task.schedule, () => {
        this.executeTask(task).catch((err) => {
          this.logger.error(`Task ${task.id} failed: ${err}`);
        });
      });
      this.scheduledTasks.push(scheduled);
      this.logger.info(`Scheduled task: ${task.name} (${task.schedule})`);
    }
  }

  stop(): void {
    for (const task of this.scheduledTasks) {
      task.stop();
    }
    this.scheduledTasks = [];
  }

  async runTask(taskId: string): Promise<void> {
    const manifest = this.readManifest();
    const task = manifest.tasks.find((t) => t.id === taskId);
    if (!task) {
      this.logger.warn(`Task not found: ${taskId}`);
      return;
    }
    await this.executeTask(task);
  }

  private readManifest(): CronManifest {
    return readJSON<CronManifest>(
      path.join(this.wolfDir, "cron-manifest.json"),
      { version: 1, tasks: [] }
    );
  }

  private readState(): CronState {
    // Merge stored state over complete defaults so array fields (execution_log, dead_letter_queue)
    // are always present — a partial cron-state.json used to crash task logging (upstream #4, bug 8).
    const defaults: CronState = { last_heartbeat: null, engine_status: "running", execution_log: [], dead_letter_queue: [], upcoming: [] };
    const stored = readJSON<Partial<CronState>>(path.join(this.wolfDir, "cron-state.json"), {});
    return { ...defaults, ...stored };
  }

  private writeState(state: CronState): void {
    writeJSON(path.join(this.wolfDir, "cron-state.json"), state);
  }

  private async executeTask(task: CronTask): Promise<void> {
    const startTime = Date.now();
    this.logger.info(`Executing task: ${task.name}`);

    try {
      await this.runAction(task.action);
      const duration = Date.now() - startTime;

      // Log success
      const state = this.readState();
      state.execution_log.push({
        task_id: task.id,
        status: "success",
        timestamp: new Date().toISOString(),
        duration_ms: duration,
      });
      // Keep last 100 entries
      if (state.execution_log.length > 100) {
        state.execution_log = state.execution_log.slice(-100);
      }
      this.writeState(state);

      this.failureCounts.set(task.id, 0);
      this.broadcast({
        type: "cron_executed",
        task_id: task.id,
        status: "success",
        duration_ms: duration,
      });
      this.logger.info(`Task ${task.name} completed in ${duration}ms`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      const failures = (this.failureCounts.get(task.id) ?? 0) + 1;
      this.failureCounts.set(task.id, failures);

      this.logger.error(`Task ${task.name} failed (attempt ${failures}): ${errorMsg}`);

      if (failures < task.retry.max_attempts) {
        // Retry with backoff
        const delay = this.calculateDelay(task.retry.backoff, task.retry.base_delay_seconds, failures);
        this.logger.info(`Retrying ${task.name} in ${delay}ms`);
        setTimeout(() => {
          this.executeTask(task).catch(() => {});
        }, delay);
      } else {
        // Dead letter or skip
        const state = this.readState();
        state.execution_log.push({
          task_id: task.id,
          status: "failed",
          timestamp: new Date().toISOString(),
          duration_ms: duration,
          error: errorMsg,
        });

        if (task.failsafe.dead_letter) {
          state.dead_letter_queue.push({
            task_id: task.id,
            error: errorMsg,
            timestamp: new Date().toISOString(),
            attempts: failures,
          });
          // Keep the dead-letter queue bounded (execution_log is already capped elsewhere).
          if (state.dead_letter_queue.length > 100) {
            state.dead_letter_queue = state.dead_letter_queue.slice(-100);
          }
        }

        this.writeState(state);
        this.failureCounts.set(task.id, 0);
        // Notify the dashboard that this task permanently failed (upstream #4, bug 1).
        this.broadcast({ type: "task_error", task_id: task.id, error: errorMsg });
      }

      this.broadcast({
        type: "cron_executed",
        task_id: task.id,
        status: "failed",
        duration_ms: duration,
      });
    }
  }

  private calculateDelay(backoff: string, baseSec: number, attempt: number): number {
    const baseMs = baseSec * 1000;
    switch (backoff) {
      case "exponential":
        return baseMs * Math.pow(2, attempt - 1);
      case "linear":
        return baseMs * attempt;
      default:
        return 0;
    }
  }

  private async runAction(action: CronAction): Promise<void> {
    switch (action.type) {
      case "scan_project":
        scanProject(this.wolfDir, this.projectRoot);
        break;

      case "consolidate_memory":
        this.consolidateMemory(action.params?.older_than_days as number ?? 7);
        break;

      case "generate_token_report":
        this.generateTokenReport();
        break;

      case "ai_task":
        await this.runAiTask(action.params as { prompt: string; context_files: string[] });
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  private consolidateMemory(olderThanDays: number): void {
    const memoryPath = path.join(this.wolfDir, "memory.md");
    const content = readText(memoryPath);
    if (!content) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const lines = content.split("\n");
    const result: string[] = [];
    let inOldSession = false;
    let oldSessionLines: string[] = [];
    let currentSessionDate: Date | null = null;

    for (const line of lines) {
      const sessionMatch = line.match(/^## Session: (\d{4}-\d{2}-\d{2})/);
      if (sessionMatch) {
        // Flush previous old session
        if (inOldSession && oldSessionLines.length > 0) {
          const actionCount = oldSessionLines.filter((l) => l.startsWith("|") && !l.startsWith("|--") && !l.startsWith("| Time")).length;
          result.push(`> Consolidated session (${actionCount} actions)`);
          result.push("");
        }

        currentSessionDate = new Date(sessionMatch[1]);
        if (currentSessionDate < cutoff) {
          inOldSession = true;
          oldSessionLines = [];
          result.push(line); // Keep the header
        } else {
          inOldSession = false;
          result.push(line);
        }
        continue;
      }

      if (inOldSession) {
        oldSessionLines.push(line);
      } else {
        result.push(line);
      }
    }

    // Flush last old session
    if (inOldSession && oldSessionLines.length > 0) {
      const actionCount = oldSessionLines.filter((l) => l.startsWith("|") && !l.startsWith("|--") && !l.startsWith("| Time")).length;
      result.push(`> Consolidated session (${actionCount} actions)`);
      result.push("");
    }

    writeText(memoryPath, result.join("\n"));
  }

  private generateTokenReport(): void {
    const flags = detectWaste(this.wolfDir);
    const ledgerPath = path.join(this.wolfDir, "token-ledger.json");
    // Lock the read-modify-write — the stop hook writes the same ledger from another process (M1).
    withLock(ledgerPath, () => {
      const ledger = readJSON<Record<string, unknown>>(ledgerPath, {});
      // Keep waste_flags bounded (defensive — detectWaste could in principle return many).
      (ledger as { waste_flags: unknown[] }).waste_flags =
        flags.length > 200 ? flags.slice(-200) : flags;
      (ledger as { optimization_report: { last_generated: string; patterns: unknown[] } }).optimization_report = {
        last_generated: new Date().toISOString(),
        patterns: flags.map((f) => f.pattern),
      };
      writeJSON(ledgerPath, ledger);
    });
  }

  private async runAiTask(params: { prompt: string; context_files: string[] }): Promise<void> {
    // Cap each context file so one large file can't blow up the prompt.
    const MAX_CONTEXT_BYTES = 20 * 1024;
    const contextParts: string[] = [];
    const rootPrefix = path.resolve(this.projectRoot) + path.sep;
    for (const file of params.context_files) {
      const filePath = path.resolve(this.projectRoot, file);
      // Reject paths that escape the project root (e.g. "../../etc/passwd") — the file
      // contents are fed to the model, so traversal would exfiltrate arbitrary files (#34).
      if (filePath !== path.resolve(this.projectRoot) && !filePath.startsWith(rootPrefix)) {
        contextParts.push(`--- ${file} --- (rejected: outside project root)`);
        continue;
      }
      try {
        let content = fs.readFileSync(filePath, "utf-8");
        if (Buffer.byteLength(content, "utf-8") > MAX_CONTEXT_BYTES) {
          content = "...[truncated — showing most recent]\n" + content.slice(-MAX_CONTEXT_BYTES);
        }
        contextParts.push(`--- ${file} ---\n${content}`);
      } catch {
        contextParts.push(`--- ${file} --- (not found)`);
      }
    }

    const fullPrompt = `${params.prompt}\n\n---\nContext:\n${contextParts.join("\n\n")}`;

    // A background daemon can't drive the interactive `claude` CLI (it delegates auth to the
    // desktop app and fails headless). Use a direct API key instead, with a clear error if it's
    // missing — the dashboard then shows a copy-able prompt to run inside a session (upstream #4, bug 2).
    // The provider/model/endpoint are config-driven (openwolf.cron.llm_*), defaulting to Anthropic.
    const llm = resolveLlmConfig(this.wolfDir);
    const apiKey = process.env[llm.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `${llm.apiKeyEnv} is not set. AI tasks require a direct API key when running as a background daemon. ` +
        `Set it in your shell profile: export ${llm.apiKeyEnv}=…`
      );
    }
    let result = await callLlm(llm, apiKey, fullPrompt);

    const fenceMatch = result.match(/```[\w]*\n([\s\S]*?)\n```/);
    if (fenceMatch) result = fenceMatch[1].trim();

    // Write result to suggestions.json if it's JSON, otherwise treat as a cerebrum update.
    try {
      const parsed = JSON.parse(result);
      writeJSON(path.join(this.wolfDir, "suggestions.json"), { generated_at: new Date().toISOString(), ...parsed });
    } catch {
      if (result.includes("## User Preferences") || result.includes("## Key Learnings") || result.includes("# Cerebrum")) {
        writeText(path.join(this.wolfDir, "cerebrum.md"), result);
      }
    }
  }

}
