import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// A missing file is normal (first run) and silently yields the fallback. An EXISTING file that
// fails to parse is a different situation: whatever it held is about to be treated as empty, and
// a read-modify-write caller would then overwrite it with defaults. That must at least be visible.
export function readJSON<T = unknown>(filePath: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // The caller is about to treat this file as empty and, in a read-modify-write, overwrite it
    // with defaults — so a corrupt token-ledger.json meant months of usage history vanished on the
    // next Stop hook, with one line on stderr as the only trace. Move it aside first. Recovery is
    // then a possibility rather than a hope, and because the path no longer exists, the next read
    // takes the ordinary "missing file" branch instead of warning forever.
    quarantineCorrupt(filePath);
    process.stderr.write(`[openwolf] ${path.basename(filePath)} was not valid JSON — moved aside, using defaults (${(e as Error).message})\n`);
    return fallback;
  }
}

/** Rename a corrupt file to <name>.corrupt-<stamp>. Best-effort: never throws, never blocks a read. */
function quarantineCorrupt(filePath: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(filePath, `${filePath}.corrupt-${stamp}`);
  } catch { /* unwritable directory, race with another process — defaults still apply */ }
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

// Advisory lock around a read-modify-write cycle (M1). Duplicated from hooks/shared.ts (separate
// build roots) — keep the two in step. Waits with a fast backoff, steals a lock left behind by a
// dead process (>5s), and FAILS rather than proceeding unlocked; see the long note in
// hooks/shared.ts for why running the callback anyway made the lock meaningless for everyone.
export class LockTimeoutError extends Error {
  constructor(public readonly targetPath: string, public readonly waitedMs: number) {
    super(`could not acquire the lock on ${path.basename(targetPath)} within ${waitedMs}ms — update skipped`);
    this.name = "LockTimeoutError";
  }
}

/**
 * The lock could not be taken for a reason that waiting will not fix — a missing directory we
 * could not create, a read-only filesystem, no permission. Extends LockTimeoutError on purpose:
 * every caller already treats that as "skip the update and say so".
 */
export class LockUnavailableError extends LockTimeoutError {
  constructor(targetPath: string, public readonly code: string) {
    super(targetPath, 0);
    this.message = `could not acquire the lock on ${path.basename(targetPath)} (${code}) — update skipped`;
    this.name = "LockUnavailableError";
  }
}

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}

/**
 * Is the lock file old enough to be considered abandoned?
 *
 * Age only. A pid liveness check was tried here and REMOVED on purpose: pids are recycled, so a
 * lock left behind by a dead process whose number now belongs to an unrelated one would never be
 * reclaimable again — a permanent lockout in exchange for a clock-skew problem nobody measured.
 * Losing a lock occasionally beats never getting it back. The real defect was that reclaiming was
 * not atomic; that is fixed at the call site.
 */
function isStaleLock(lockPath: string, staleMs: number): boolean {
  return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
}

export function withLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = targetPath + ".lock";
  const MAX_WAIT_MS = 1500;
  const STALE_MS = 5000;
  // Same bound as the hook copy: without it any unanticipated error turns the retry into a
  // busy-loop that saturates a core for the whole budget and then fails anyway (bug-352).
  const MAX_IMMEDIATE_RETRIES = 8;
  const start = Date.now();
  let held = false;
  let backoff = 2;
  let immediateRetries = 0;
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try { fs.writeSync(fd, String(process.pid)); } catch { /* ignore */ }
      fs.closeSync(fd);
      held = true;
      break;
    } catch (openErr) {
      const code = (openErr as NodeJS.ErrnoException)?.code;

      // EEXIST is the only failure that means "somebody else holds it" — the one case where
      // waiting helps. Everything else is a property of the filesystem, not of a competitor, and
      // will still be true in 1500ms.
      if (code !== "EEXIST") {
        if (code === "ENOENT" && immediateRetries < MAX_IMMEDIATE_RETRIES) {
          immediateRetries++;
          try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); continue; } catch { /* fall through */ }
        }
        throw new LockUnavailableError(targetPath, code ?? "UNKNOWN");
      }
      try {
        if (isStaleLock(lockPath, STALE_MS)) {
          // Claim the stale lock ATOMICALLY. `unlink` + create is not: B stats the old lock, A
          // removes it and creates a fresh one, B then removes A's FRESH lock and creates its own
          // — and both run the critical section. Measured with 20 processes and one stale lock
          // left behind: 12 lost updates in 8 rounds, and 0 without it. Only the process whose
          // rename succeeds may remove the file; everyone else falls through and waits.
          const claim = `${lockPath}.stale-${process.pid}-${Date.now()}`;
          try { fs.renameSync(lockPath, claim); fs.unlinkSync(claim); }
          catch { /* somebody claimed it first */ }
          continue;
        }
      } catch {
        // Lock vanished between open and stat — retry at once, but never unboundedly.
        if (immediateRetries < MAX_IMMEDIATE_RETRIES) { immediateRetries++; continue; }
        sleepSync(backoff);
        backoff = Math.min(backoff * 2, 50);
        continue;
      }
      sleepSync(backoff);
      backoff = Math.min(backoff * 2, 50);
    }
  }
  if (!held) throw new LockTimeoutError(targetPath, Date.now() - start);
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

/**
 * withLock for a caller that returns a value and has a sensible "did not run" answer.
 * The skip is reported, never silent — a maintenance pass that quietly did nothing reads exactly
 * like a maintenance pass that found nothing to do.
 */
export function withLockOr<T>(targetPath: string, onSkip: () => T, fn: () => T): T {
  try {
    return withLock(targetPath, fn);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      process.stderr.write(`[openwolf] ${e.message}\n`);
      return onSkip();
    }
    throw e;
  }
}

/** withLock for callers that must not throw. Reports a lost update instead of hiding it. */
export function tryWithLock(targetPath: string, fn: () => void): boolean {
  try {
    withLock(targetPath, fn);
    return true;
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      process.stderr.write(`[openwolf] ${e.message}\n`);
      return false;
    }
    throw e;
  }
}

// Copy a file via read+write instead of fs.copyFileSync. copyFileSync uses the
// copy_file_range syscall on Linux, which fails with EPERM on WSL2 9P mounts whose
// destination sits under an EFS-encrypted NTFS directory — a plain read()+write() works
// in the same conditions (upstream #33).
/**
 * Copy atomically: write a sibling temp file, then rename over the destination.
 *
 * `writeFileSync` truncates first. `openwolf update` walks every registered project while sessions
 * in those projects are spawning hook processes on every tool call — a hook that starts inside the
 * truncate window imports a half-written `shared.js` and dies with a SyntaxError. A rename is
 * atomic on POSIX and on Windows (ReplaceFile semantics for same-volume renames), so a reader sees
 * either the old file or the new one.
 */
export function safeCopyFile(src: string, dest: string): void {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, fs.readFileSync(src));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

export function appendText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, content, "utf-8");
}
