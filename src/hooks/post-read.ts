import * as path from "node:path";
import { getWolfDir, ensureWolfDir, updateSession, readMarkdown, parseAnatomy, estimateFileTokens, getTokenRatios, readStdin, normalizePath, loadIgnore, isSecretFile, matchesAnatomyEntry, relativeToProject, sessionFileFor } from "./shared.js";
import { standDown } from "./engine.js";

interface SessionData {
  files_read: Record<string, { count: number; tokens: number; first_read: string; anatomy_had_description?: boolean }>;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  // Stand down when another engine owns this session (OPENWOLF_ENGINE). Before any
  // .wolf/ work: a cfetch session must not get a knowledge base created behind its back.
  if (standDown()) return;
  ensureWolfDir();
  const wolfDir = getWolfDir();
  const hooksDir = path.join(wolfDir, "hooks");

  const raw = await readStdin();
  let input: { session_id?: string; tool_input?: { file_path?: string; path?: string }; tool_output?: { content?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }
  const sessionFile = sessionFileFor(hooksDir, input.session_id);

  const filePath = input.tool_input?.file_path ?? input.tool_input?.path ?? "";
  const content = input.tool_output?.content ?? "";
  if (!filePath) { process.exit(0); return; }

  const normalizedFile = normalizePath(filePath);

  // Skip tracking for .wolf/ internal files — consistent with pre-read
  const projectDir = normalizePath(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  // Shared with pre-read: separator-anchored, with a realpath second opinion so a project reached
  // through a symlink is not silently dropped from tracking.
  const relToProject = relativeToProject(filePath, projectDir);
  // Don't track reads of files outside the project root (upstream #56). relToProject is ""
  // both when the path is outside projectDir and when it equals the root itself — neither
  // is a trackable project file.
  if (!relToProject) { process.exit(0); return; }

  if (relToProject.startsWith(".wolf/") || relToProject.startsWith(".wolf\\")) {
    process.exit(0);
    return;
  }

  // Skip anything matched by .gitignore / .wolfignore — don't track ignored reads.
  if (loadIgnore(projectDir)(relToProject)) { process.exit(0); return; }

  // Never track secret-bearing files in the ledger (#54).
  if (isSecretFile(normalizedFile)) { process.exit(0); return; }

  let tokens = content ? estimateFileTokens(content, filePath, getTokenRatios(wolfDir)) : 0;

  // Fallback: if tool_output had no content, use anatomy token estimate
  if (tokens === 0) {
    const anatomyContent = readMarkdown(path.join(wolfDir, "anatomy.md"));
    const sections = parseAnatomy(anatomyContent);
    for (const [sectionKey, entries] of sections) {
      for (const entry of entries) {
        const entryRelPath = normalizePath(path.join(sectionKey, entry.file));
        if (matchesAnatomyEntry(normalizedFile, entryRelPath)) {
          tokens = entry.tokens;
          break;
        }
      }
      if (tokens > 0) break;
    }
  }

  updateSession<SessionData>(sessionFile, { files_read: {} }, (session) => {
    if (session.files_read[normalizedFile]) {
      // Never let a re-read shrink the estimate to zero. A repeat read often arrives with an
      // empty tool_output.content, and if the file has no anatomy entry the fallback above
      // cannot recover a number — overwriting unconditionally would wipe the good first-read
      // estimate. That deflates inputTokens in stop.ts and, because savedFromRepeats multiplies
      // by (count - 1), silently zeroes the repeat-savings metric too.
      const prev = session.files_read[normalizedFile].tokens ?? 0;
      session.files_read[normalizedFile].tokens = Math.max(prev, tokens);
    } else {
      session.files_read[normalizedFile] = {
        count: 1,
        tokens,
        first_read: new Date().toISOString(),
      };
    }
  });
  process.exit(0);
}

main().catch(() => process.exit(0));
