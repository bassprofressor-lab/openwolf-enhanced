import * as path from "node:path";
import { getWolfDir, ensureWolfDir, readJSON, writeJSON, readStdin, timestamp } from "./shared.js";

// PreCompact hook — compaction survival.
//
// Fires just before Claude Code / Codex compacts the context window. The in-flight session state
// (_session.json) survives on disk, but nothing in the compacted context tells the model what
// already happened. This hook snapshots that state; after compaction SessionStart fires with
// source "compact" and the session-start hook re-injects a digest (incl. the files already
// modified) via additionalContext. That pair is the survival mechanism.

async function main(): Promise<void> {
  ensureWolfDir();
  const wolfDir = getWolfDir();
  const hooksDir = path.join(wolfDir, "hooks");

  let input: { trigger?: string; session_id?: string } = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {}

  try {
    const session = readJSON<Record<string, unknown>>(path.join(hooksDir, "_session.json"), {});
    writeJSON(path.join(hooksDir, "_precompact-snapshot.json"), {
      at: timestamp(),
      trigger: input.trigger ?? "unknown",
      session,
    });
  } catch {}

  process.exit(0);
}

main().catch(() => process.exit(0));
