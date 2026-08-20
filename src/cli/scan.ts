import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { scanProject, buildAnatomy } from "../scanner/anatomy-scanner.js";
import { writeText } from "../utils/fs-safe.js";

export async function scanCommand(options: { check?: boolean }): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  if (options.check) {
    const { content: newContent } = buildAnatomy(wolfDir, projectRoot);

    const anatomyPath = path.join(wolfDir, "anatomy.md");
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(anatomyPath, "utf-8");
    } catch {
      // File doesn't exist — anatomy is out of date
    }

    // Strip the timestamp line before comparing, since it changes every scan
    const stripTimestamp = (s: string): string =>
      s.replace(/^> Auto-maintained by OpenWolf\. Last scanned: .+$/m, "");

    if (stripTimestamp(existingContent) === stripTimestamp(newContent)) {
      console.log("Anatomy is up to date");
      return;
    } else {
      console.log("Anatomy is out of date. Run `openwolf scan` to update.");
      process.exit(1);
    }
  }

  console.log("Scanning project...");
  const startTime = Date.now();
  const fileCount = scanProject(wolfDir, projectRoot);

  // Follow-up pass: replace the regex-guessed symbol ranges with the real ones from the syntax
  // tree, when tree-sitter is installed (optionalDependencies). Only here, because the pass is
  // async and the hooks are meant to stay synchronous.
  const symbolsPath = path.join(wolfDir, "anatomy-symbols.json");
  try {
    const store = JSON.parse(fs.readFileSync(symbolsPath, "utf-8")) as
      { version: number; files: Record<string, import("../scanner/symbol-extractor.js").SymbolEntry[]> };
    const { refineSymbols } = await import("../scanner/treesitter-extractor.js");
    const { SYMBOL_MAX_COUNT } = await import("../scanner/symbol-extractor.js");
    const res = await refineSymbols(store.files, (rel) => {
      try { return fs.readFileSync(path.join(projectRoot, rel), "utf-8"); } catch { return null; }
    }, SYMBOL_MAX_COUNT);
    if (res.refined > 0) {
      // [2026-08-20, review] writeText -> writeAtomic (tmp + rename), like every other .wolf
      // writer. A pre-read hook firing mid-write would otherwise read truncated JSON and lose all
      // symbol hints for that turn.
      writeText(symbolsPath, JSON.stringify(store, null, 2));
      console.log(`  ✓ ${res.refined} files with exact symbol ranges (tree-sitter)`);
    } else if (res.reason) {
      // Say WHY it did not run, instead of quietly keeping the guessed ranges.
      console.log(`  · tree-sitter not used: ${res.reason}`);
      console.log("    Symbol ranges stay estimated (regex). Optional: pnpm add web-tree-sitter@^0.24.7 tree-sitter-wasms");
    }
  } catch { /* no symbol sidecar or no tree-sitter — the scan itself stays valid */ }
  const elapsed = Date.now() - startTime;
  console.log(`  ✓ Anatomy scan complete: ${fileCount} files indexed in ${elapsed}ms`);
}
