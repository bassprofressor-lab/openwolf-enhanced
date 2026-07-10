/**
 * Seeding user-data files from templates.
 *
 * `USER_DATA_FILES` are never overwritten — but "never overwrite" was implemented as "never
 * touch", so a project initialised before a file was introduced never received it at all. The
 * concrete casualty was `STATUS.md` (added in 1.4.0): projects created earlier had none, while
 * `OPENWOLF.md` instructed the agent to read it first.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readText, writeText, safeCopyFile } from "./fs-safe.js";

/** Best-effort project name from the usual manifests, falling back to the directory name. */
export function detectProjectName(projectRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
    if (pkg.name) return pkg.name;
  } catch {}
  for (const manifest of ["Cargo.toml", "pyproject.toml"]) {
    try {
      const text = fs.readFileSync(path.join(projectRoot, manifest), "utf-8");
      const m = text.match(/^name\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    } catch {}
  }
  return path.basename(projectRoot);
}

/** Substitute `{{PROJECT_NAME}}` / `{{DATE}}` in an already-written template file. */
export function applyTemplatePlaceholders(filePath: string, projectRoot: string): void {
  if (!fs.existsSync(filePath)) return;
  const projectName = detectProjectName(projectRoot);
  const date = new Date().toISOString().slice(0, 10);
  const content = readText(filePath)
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{DATE\}\}/g, date);
  writeText(filePath, content);
}

/**
 * Copy any `files` that are missing from `wolfDir` out of `templatesDir`, then substitute
 * placeholders. Existing files are left strictly alone. Returns the names actually seeded.
 */
export function seedMissingUserData(
  wolfDir: string,
  projectRoot: string,
  templatesDir: string,
  files: string[]
): string[] {
  const seeded: string[] = [];
  for (const file of files) {
    const dest = path.join(wolfDir, file);
    if (fs.existsSync(dest)) continue;
    const src = path.join(templatesDir, file);
    if (!fs.existsSync(src)) continue; // no template for this one (e.g. designqc-report.json)
    safeCopyFile(src, dest);
    applyTemplatePlaceholders(dest, projectRoot);
    seeded.push(file);
  }
  return seeded;
}
