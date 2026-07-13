import * as fs from "node:fs";
import * as path from "node:path";

// .wolf/.gitignore — keep local secrets out of the repository.
//
// The .wolf directory is meant to be committed: that is the whole point of a shared brain. But two
// files in it must never be, and one of them now grants write access to a team workspace. 0600 file
// permissions protect against other users on the machine; they do nothing against `git add .wolf`.
//
// Written from code, not from src/templates/: npm silently drops files named .gitignore from the
// published package, so a template would exist in the repo and be missing in every install.
const ENTRIES: Array<{ pattern: string; why: string }> = [
  { pattern: "dashboard-token", why: "bearer token for the local dashboard API" },
  { pattern: "remote-token", why: "workspace token — grants write access to the team's memory" },
  { pattern: "remote-pushed.json", why: "per-machine push bookkeeping, not shared state" },
];

const HEADER = "# Managed by OpenWolf — local secrets and machine-local state, never commit these.";

/** Create or extend .wolf/.gitignore. Idempotent: only missing lines are appended. */
export function ensureWolfGitignore(wolfDir: string): "created" | "updated" | "ok" {
  const p = path.join(wolfDir, ".gitignore");

  let existing = "";
  try { existing = fs.readFileSync(p, "utf-8"); } catch { /* not there yet */ }

  // Compare against the PATTERN, not the raw line: we write `remote-token    # why`, so a naive
  // line-equality check never matches and every update would append the block again.
  const present = new Set(
    existing.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)
  );
  const missing = ENTRIES.filter((e) => !present.has(e.pattern));
  if (existing && missing.length === 0) return "ok";

  const block = missing.map((e) => `${e.pattern}    # ${e.why}`).join("\n");

  if (!existing) {
    fs.writeFileSync(p, `${HEADER}\n${block}\n`, "utf-8");
    return "created";
  }

  const sep = existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(p, `${sep}${HEADER}\n${block}\n`, "utf-8");
  return "updated";
}
