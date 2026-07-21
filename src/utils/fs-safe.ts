import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export function readJSON<T = unknown>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Shared tmp+rename write. Never throws (hooks must not kill a session over a failed journal
// write), but a total failure is REPORTED on stderr instead of vanishing — a silently dropped
// write once hid that the semantic-recall index never persisted at all (bug-183).
function writeAtomic(filePath: string, serialize: () => string): boolean {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let content: string;
  try {
    content = serialize();
  } catch (e) {
    // Serialization failed (e.g. JSON.stringify past V8's max string length) — there is nothing
    // to write, and retrying with the same data cannot succeed.
    process.stderr.write(`[openwolf] write to ${path.basename(filePath)} failed: ${(e as Error).message}\n`);
    return false;
  }
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    // On Windows, rename can fail transiently while another process holds a handle — retry briefly
    // before giving up on atomicity.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return true;
      } catch (e) {
        if (attempt >= 2) throw e;
      }
    }
  } catch {
    // Last resort: non-atomic direct write, so the data still lands even if replace is impossible.
    try { fs.unlinkSync(tmp); } catch {}
    try {
      fs.writeFileSync(filePath, content, "utf-8");
      return true;
    } catch (e) {
      process.stderr.write(`[openwolf] write to ${path.basename(filePath)} failed: ${(e as Error).message}\n`);
      return false;
    }
  }
}

export function writeJSON(filePath: string, data: unknown): boolean {
  return writeAtomic(filePath, () => JSON.stringify(data, null, 2));
}

export function readText(filePath: string, fallback: string = ""): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

export function writeText(filePath: string, content: string): boolean {
  return writeAtomic(filePath, () => content);
}

// Best-effort advisory lock around a read-modify-write cycle (M1). Duplicated from
// hooks/shared.ts (separate build roots). Never blocks for long — waits up to ~1s, steals a
// stale lock (>5s), and runs unlocked if it can't acquire, so it can't wedge a process.
function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}
export function withLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = targetPath + ".lock";
  const MAX_WAIT_MS = 1000;
  const STALE_MS = 5000;
  const start = Date.now();
  let held = false;
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try { fs.writeSync(fd, String(process.pid)); } catch { /* ignore */ }
      fs.closeSync(fd);
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } }
  }
}

// Copy a file via read+write instead of fs.copyFileSync. copyFileSync uses the
// copy_file_range syscall on Linux, which fails with EPERM on WSL2 9P mounts whose
// destination sits under an EFS-encrypted NTFS directory — a plain read()+write() works
// in the same conditions (upstream #33).
export function safeCopyFile(src: string, dest: string): void {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(src));
}

export function appendText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, content, "utf-8");
}
