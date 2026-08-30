import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Per-project dashboard token. The daemon binds to loopback and requires this token on
// every /api/* request and WebSocket connection, so a page in the user's browser (or
// another local user) can't drive the dashboard — including triggering cron tasks
// (upstream #30 / #34).

export function dashboardTokenPath(wolfDir: string): string {
  return path.join(wolfDir, "dashboard-token");
}

// Read the token, creating a fresh one (0600) if it doesn't exist yet.
export function ensureDashboardToken(wolfDir: string): string {
  const p = dashboardTokenPath(wolfDir);
  try {
    const existing = fs.readFileSync(p, "utf-8").trim();
    if (existing) {
      // A token created before this check — or restored from a backup, or copied with a umask that
      // let the group bits through — kept whatever mode it had, and 0600 was only ever applied to
      // files this function CREATED. A token readable by other local users is a token they can use.
      //
      // Repaired in place, never rotated: this is the token a live dashboard tab is already
      // holding, and rotating it would log the user out to fix a permission bit.
      try {
        if ((fs.statSync(p).mode & 0o077) !== 0) fs.chmodSync(p, 0o600);
      } catch { /* no chmod on this platform, or a race — the token is still valid */ }
      return existing;
    }
  } catch { /* fall through to create */ }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(p, token, { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* best effort on platforms without chmod */ }
  } catch { /* best effort */ }
  return token;
}

// Read the token without creating it (returns "" if absent).
export function readDashboardToken(wolfDir: string): string {
  try {
    return fs.readFileSync(dashboardTokenPath(wolfDir), "utf-8").trim();
  } catch {
    return "";
  }
}

// Constant-time comparison to avoid leaking the token via timing.
export function tokenMatches(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
