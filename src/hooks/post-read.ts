import * as path from "node:path";
import { getWolfDir, ensureWolfDir, readJSON, writeJSON, readMarkdown, parseAnatomy, estimateFileTokens, getTokenRatios, readStdin, normalizePath, loadIgnore, isSecretFile } from "./shared.js";

interface SessionData {
  files_read: Record<string, { count: number; tokens: number; first_read: string; anatomy_had_description?: boolean }>;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  ensureWolfDir();
  const wolfDir = getWolfDir();
  const hooksDir = path.join(wolfDir, "hooks");
  const sessionFile = path.join(hooksDir, "_session.json");

  const raw = await readStdin();
  let input: { tool_input?: { file_path?: string; path?: string }; tool_output?: { content?: string } };
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
    return;
  }

  const filePath = input.tool_input?.file_path ?? input.tool_input?.path ?? "";
  const content = input.tool_output?.content ?? "";
  if (!filePath) { process.exit(0); return; }

  const normalizedFile = normalizePath(filePath);

  // Skip tracking for .wolf/ internal files — consistent with pre-read
  const projectDir = normalizePath(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const relToProject = normalizedFile.startsWith(projectDir)
    ? normalizedFile.slice(projectDir.length).replace(/^\//, "")
    : "";
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
        if (normalizedFile.endsWith(entryRelPath) || normalizedFile.endsWith("/" + entryRelPath)) {
          tokens = entry.tokens;
          break;
        }
      }
      if (tokens > 0) break;
    }
  }

  const session = readJSON<SessionData>(sessionFile, { files_read: {} });
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

  writeJSON(sessionFile, session);
  process.exit(0);
}

main().catch(() => process.exit(0));
