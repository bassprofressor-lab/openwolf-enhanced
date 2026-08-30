import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private logFile: string | null;
  private level: LogLevel;

  constructor(logFile: string | null, level: LogLevel = "info") {
    this.logFile = logFile;
    this.level = level;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!this.logFile) return;
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Point the logger at another project's .wolf/daemon.log.
   *
   * The daemon can hot-switch projects without restarting, and the logger was the one binding that
   * never moved: after a switch, project B's cron runs, task failures and LLM errors kept appending
   * to project A's daemon.log, under A's log level. `openwolf daemon logs` in B then showed nothing
   * at all, which reads like a daemon that stopped working.
   */
  retarget(logFile: string | null, level: LogLevel = this.level): void {
    this.logFile = logFile;
    this.level = level;
    this.ensureDir();
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private format(level: LogLevel, message: string): string {
    const ts = new Date().toISOString();
    return `[${ts}] [${level.toUpperCase()}] ${message}`;
  }

  private write(level: LogLevel, message: string): void {
    if (!this.shouldLog(level)) return;
    const line = this.format(level, message);
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
    if (this.logFile) {
      fs.appendFileSync(this.logFile, line + "\n", "utf-8");
    }
  }

  debug(msg: string): void { this.write("debug", msg); }
  info(msg: string): void { this.write("info", msg); }
  warn(msg: string): void { this.write("warn", msg); }
  error(msg: string): void { this.write("error", msg); }
}
