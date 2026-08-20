import * as fs from "node:fs";
import { writeText } from "./fs-safe.js";

// [2026-08-20] Context files belonging to other harnesses (AGENTS.md for Codex and OpenCode,
// GEMINI.md for Gemini CLI) are the user's. OpenWolf manages exactly one delimited block inside
// them and leaves everything outside it byte for byte alone.
//
// Before this, our fork did not write these files AT ALL: on Codex our hooks fired, but the
// protocol never reached the model — it reads AGENTS.md, not CLAUDE.md.

export const MARKER_BEGIN = "<!-- openwolf:begin -->";
export const MARKER_END = "<!-- openwolf:end -->";

export interface UpsertResult {
  /** true when the file actually changed (idempotent: a second run returns false). */
  changed: boolean;
  /** Set when nothing was written even though it would have been needed. */
  refused?: string;
}

/**
 * Insert or replace the OpenWolf block in a markdown context file.
 *
 * Rules that matter more here than convenience:
 *  - Everything outside the markers stays untouched. That is user content.
 *  - With no markers present, the block is prepended (the way init.ts handles CLAUDE.md) and the
 *    existing text is preserved below it.
 *  - If the markers are broken (END before BEGIN, or BEGIN without END), NOTHING is written and
 *    the reason is returned. Repairing a half-written foreign file is more dangerous than leaving
 *    it alone.
 */
export function upsertMarkerBlock(filePath: string, content: string): UpsertResult {
  const block = `${MARKER_BEGIN}\n${content.trim()}\n${MARKER_END}`;

  let existing = "";
  try {
    existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  } catch (e) {
    return { changed: false, refused: `not readable: ${(e as Error).message}` };
  }

  if (existing === "") {
    return { changed: writeText(filePath, block + "\n") };
  }

  const b = existing.indexOf(MARKER_BEGIN);
  const e = existing.indexOf(MARKER_END);

  if (b === -1 && e === -1) {
    const next = `${block}\n\n${existing.replace(/^\n+/, "")}`;
    return next === existing ? { changed: false } : { changed: writeText(filePath, next) };
  }
  if (b === -1 || e === -1 || e < b) {
    return {
      changed: false,
      refused: "markers incomplete or swapped — file left untouched",
    };
  }

  const next = existing.slice(0, b) + block + existing.slice(e + MARKER_END.length);
  return next === existing ? { changed: false } : { changed: writeText(filePath, next) };
}

/**
 * The protocol text for non-Claude harnesses. Deliberately WITHOUT Claude's `@file` include:
 * Codex does not understand it, and a reference that silently does nothing is worse than an
 * instruction to read the file.
 */
export const AGENTS_SNIPPET = `## OpenWolf

This project uses OpenWolf for context management. Its knowledge lives in \`.wolf/\`.

1. **Read \`.wolf/STATUS.md\` first** — current quest, open points, decisions.
2. **Check \`.wolf/anatomy.md\` before opening any file.** If the description there answers
   your question, do not read the file.
3. **Read \`.wolf/cerebrum.md\` before generating code** — especially \`## Do-Not-Repeat\`.
4. **Check \`.wolf/buglog.json\` before fixing an error** — the fix may already be known.
5. **After significant actions**, append one line to \`.wolf/memory.md\`; after adding,
   deleting or renaming files, update \`.wolf/anatomy.md\`.

Wrap anything secret in \`<private>…</private>\` — those blocks stay out of the resume
digest, out of \`openwolf recall\`, and out of anything OpenWolf sends elsewhere.`;
