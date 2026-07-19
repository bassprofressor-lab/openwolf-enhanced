import * as fs from "node:fs";
import * as path from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { readJSON, writeJSON, readText, writeText, withLock } from "../utils/fs-safe.js";
import { scanProject } from "../scanner/anatomy-scanner.js";
import { detectWaste } from "../tracker/waste-detector.js";
import { resolveLlmConfig, callLlmDetailed, requiresApiKey } from "./llm-provider.js";

export interface AiTaskParams {
  prompt: string;
  context_files: string[];
  /**
   * "proposal" (default) — write the answer to .wolf/proposals/, touch nothing else.
   * "overwrite"          — legacy full-file rewrite of cerebrum.md. Opt-in, and guarded; see bug-157.
   */
  mode?: "proposal" | "overwrite";
  /** Bytes per chunk when a context file exceeds the model's context window. */
  chunk_bytes?: number;
}

/**
 * Split text into chunks that fit a context window — at paragraph boundaries, never mid-sentence.
 *
 * The old code did `content.slice(-MAX)`: it kept the tail and threw the rest away. For a knowledge
 * base that is not a size limit, it is data loss with extra steps — the model then "cleans" a quarter
 * of the file and the other three quarters cease to exist. Splitting keeps every byte; the model just
 * reads it in several passes.
 */
export function splitForContext(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n\n+/)) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (current && Buffer.byteLength(candidate, "utf-8") > maxBytes) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  // A single paragraph bigger than the window still has to be cut somewhere — but it is the only
  // case where anything is cut, and it is cut into pieces rather than thrown away.
  return chunks.flatMap((c) => {
    if (Buffer.byteLength(c, "utf-8") <= maxBytes) return [c];
    // maxBytes is a BYTE budget, but a naive c.slice(i, i+maxBytes) slices by UTF-16 code units and
    // would cut a multi-byte char (or surrogate pair) in half → invalid UTF-8. Iterate by code point
    // (for…of yields whole code points) and flush whenever the next char would push the piece over
    // the byte budget, so a char is never split across chunks.
    const out: string[] = [];
    let piece = "";
    for (const ch of c) {
      if (piece && Buffer.byteLength(piece + ch, "utf-8") > maxBytes) {
        out.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    if (piece) out.push(piece);
    return out;
  });
}
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
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
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
    // Retries are scheduled with setTimeout, not node-cron, so task.stop() above doesn't touch them.
    // Left alone, a pending retry fires after shutdown and runs against a daemon that thinks it stopped.
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
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
      await this.runAction(task.action, task.id);
      const duration = Date.now() - startTime;

      // Log success. Re-read under a lock and write immediately: a concurrent task (or its long LLM
      // await) could otherwise read the same snapshot and clobber this entry on write — lost logs.
      withLock(path.join(this.wolfDir, "cron-state.json"), () => {
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
      });

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
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          this.executeTask(task).catch(() => {});
        }, delay);
        this.retryTimers.add(timer);
      } else {
        // Dead letter or skip. Same lock as the success path — read-modify-write under it so a
        // concurrent task cannot overwrite this failure record with its own stale snapshot.
        withLock(path.join(this.wolfDir, "cron-state.json"), () => {
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
        });
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

  private async runAction(action: CronAction, taskId = "ai_task"): Promise<void> {
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
        await this.runAiTask(action.params as unknown as AiTaskParams, taskId);
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

  /**
   * Run a model over the project's own knowledge files.
   *
   * Default output is `mode: "proposal"`: the model NEVER writes a canonical file. It reads, and it
   * writes its answer to `.wolf/proposals/<task>-<stamp>.md`, which a human — or a stronger model in a
   * session — reviews before anything is adopted. The local model does the legwork; authority over what
   * is true stays with the reader.
   *
   * This is not caution for its own sake. With `mode: "overwrite"` (opt-in, still supported), this exact
   * path was one Sunday away from replacing a 78 KB cerebrum.md with a 3.9 KB "cleaned" version — see
   * writeCerebrumFromAi.
   *
   * Files larger than the model's context are SPLIT, not truncated. Cutting a knowledge base to its tail
   * and asking for "the cleaned file" is how the 95%-loss bug happened; reading it in pieces means the
   * model actually sees all of it, just not at once.
   */
  private async runAiTask(params: AiTaskParams, taskId: string): Promise<void> {
    const mode = params.mode ?? "proposal";
    const chunkBytes = params.chunk_bytes ?? 20 * 1024;
    const rootPrefix = path.resolve(this.projectRoot) + path.sep;

    const files: Array<{ name: string; chunks: string[] }> = [];
    for (const file of params.context_files) {
      const filePath = path.resolve(this.projectRoot, file);
      // Reject paths that escape the project root (e.g. "../../etc/passwd") — the file
      // contents are fed to the model, so traversal would exfiltrate arbitrary files (#34).
      if (filePath !== path.resolve(this.projectRoot) && !filePath.startsWith(rootPrefix)) {
        files.push({ name: file, chunks: ["(rejected: outside project root)"] });
        continue;
      }
      try {
        files.push({ name: file, chunks: splitForContext(fs.readFileSync(filePath, "utf-8"), chunkBytes) });
      } catch {
        files.push({ name: file, chunks: ["(not found)"] });
      }
    }

    // A background daemon can't drive the interactive `claude` CLI (it delegates auth to the
    // desktop app and fails headless). Use a direct API key instead, with a clear error if it's
    // missing — the dashboard then shows a copy-able prompt to run inside a session (upstream #4, bug 2).
    // The provider/model/endpoint are config-driven (openwolf.cron.llm_*), defaulting to Anthropic.
    const llm = resolveLlmConfig(this.wolfDir);
    const apiKey = process.env[llm.apiKeyEnv] ?? "";
    if (!apiKey && requiresApiKey(llm)) {
      throw new Error(
        `${llm.apiKeyEnv} is not set. AI tasks require a direct API key when running as a background daemon. ` +
        `Set it in your shell profile: export ${llm.apiKeyEnv}=… — or point openwolf.cron.llm_base_url at a ` +
        `local model server (LM Studio on http://localhost:1234/v1, Ollama on http://localhost:11434/v1), which needs no key.`
      );
    }

    const totalChunks = files.reduce((n, f) => n + f.chunks.length, 0);
    const sections: string[] = [];
    for (const f of files) {
      for (const [i, chunk] of f.chunks.entries()) {
        const part = f.chunks.length > 1 ? ` (part ${i + 1}/${f.chunks.length})` : "";
        const fullPrompt = `${params.prompt}\n\n---\nContext — ${f.name}${part}:\n${chunk}`;
        // 16k, not the 4k default: a reasoning model spends thousands of tokens thinking before the
        // first character of its answer. Too small a budget does not fail loudly — it returns HALF a
        // file, which still looks like a valid result to any writer downstream.
        const { text, truncated } = await callLlmDetailed(llm, apiKey, fullPrompt, { maxTokens: 16000, timeoutMs: 600_000 });
        if (truncated) throw new Error(`The model hit max_tokens mid-answer on ${f.name}${part} — the result is an incomplete fragment, so it is discarded rather than used.`);
        const fence = text.match(/```[\w]*\n([\s\S]*?)\n```/);
        sections.push(`## ${f.name}${part}\n\n${(fence ? fence[1] : text).trim()}`);
      }
    }
    const result = sections.map((s) => s.replace(/^## .*\n\n/, "")).join("\n\n").trim();

    // JSON answers keep going to suggestions.json — that file is a proposal by definition, nothing
    // canonical is at risk.
    try {
      const parsed = JSON.parse(result);
      writeJSON(path.join(this.wolfDir, "suggestions.json"), { generated_at: new Date().toISOString(), ...parsed });
      return;
    } catch { /* not JSON — prose, handled below */ }

    if (mode === "overwrite") {
      if (result.includes("## User Preferences") || result.includes("## Key Learnings") || result.includes("# Cerebrum")) {
        this.writeCerebrumFromAi(result, totalChunks > files.length ? new Set(["cerebrum.md"]) : new Set());
      }
      return;
    }

    this.writeProposal(taskId, llm.model, files, totalChunks, sections);
  }

  /** Park the model's output where it can be reviewed — never where it can overwrite something. */
  private writeProposal(
    taskId: string, model: string,
    files: Array<{ name: string; chunks: string[] }>, totalChunks: number, sections: string[],
  ): void {
    const dir = path.join(this.wolfDir, "proposals");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const file = path.join(dir, `${taskId}-${stamp}.md`);
    const header = [
      `# Proposal — ${taskId}`,
      ``,
      `> Written by \`${model}\` on ${new Date().toISOString()}. **Nothing was changed.**`,
      `> Read this, keep what is right, and apply it by hand — or ask a session to.`,
      `> Sources: ${files.map((f) => `\`${f.name}\`${f.chunks.length > 1 ? ` (${f.chunks.length} parts, read in full)` : ""}`).join(", ")}`,
      totalChunks > files.length
        ? `> The file did not fit the model's context, so it was **split and read in pieces** — not truncated. Each section below covers one piece.`
        : ``,
      ``,
      `---`,
      ``,
    ].filter((l) => l !== undefined).join("\n");
    fs.writeFileSync(file, header + sections.join("\n\n---\n\n") + "\n", "utf-8");
    this.logger.info(`Proposal written: .wolf/proposals/${path.basename(file)} — review it; nothing was overwritten.`);
  }

  /**
   * Overwrite cerebrum.md with a model's rewrite — but only when that is actually safe.
   *
   * This path destroyed a real project's knowledge base in a dry run: cerebrum.md was 78 KB, the
   * context cap fed the model only the LAST 20 KB (74% missing), the prompt said "return the cleaned
   * file content only", and the model dutifully returned a tidy 3.9 KB file. Writing it would have
   * erased 95% of everything the project had learned — silently, at 03:00 on a Sunday, with no backup.
   * It never fired only because ANTHROPIC_API_KEY was unset; pointing the task at a keyless local
   * model removed that accidental safety net.
   *
   * Two hard rules now:
   *   1. A file the model saw only a SLICE of is never rewritten from that slice.
   *   2. Nothing overwrites cerebrum.md without a timestamped backup sitting next to it.
   */
  private writeCerebrumFromAi(result: string, truncatedFiles: Set<string>): void {
    const cerebrumPath = path.join(this.wolfDir, "cerebrum.md");
    if (truncatedFiles.has("cerebrum.md")) {
      throw new Error(
        `Refusing to overwrite cerebrum.md: it is larger than the ${20}KB context cap, so the model only saw ` +
        `its tail. Rewriting the whole file from a fragment would delete everything above the cut. ` +
        `Either shrink cerebrum.md (\`openwolf consolidate\`) or change this task to emit JSON suggestions ` +
        `instead of a full-file rewrite.`
      );
    }
    // Read the current file (if any). A missing file is fine — the first write has nothing to lose.
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(cerebrumPath, "utf-8");
    } catch {
      existing = null;
    }
    // If a file exists it MUST be backed up before we overwrite it. Crucially, a *failed* backup
    // (disk full, permissions) must abort the overwrite — otherwise we'd destroy the original with
    // no copy, the exact data-loss class bug-157 guarded against. So the backup is NOT in a try/catch:
    // if it throws, the throw propagates and writeText below never runs.
    if (existing !== null) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const backupDir = path.join(this.wolfDir, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, `cerebrum-${stamp}.md`), existing, "utf-8");
    }
    writeText(cerebrumPath, result);
  }

}
