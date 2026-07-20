/**
 * Deploys the compiled hook scripts into a project's `.wolf/hooks/`.
 *
 * `init` and `update` used to carry near-identical private copies of this, which had already
 * drifted (different candidate ordering comments, only one of them warning on failure). Both
 * now call this.
 *
 * Source of truth is `dist/hooks/` — the dedicated `tsconfig.hooks.json` build, which is also
 * what `test/logic.test.js` imports. Preferring it here keeps the artifact we test identical to
 * the artifact projects actually run. `dist/src/hooks/` (the main `tsc` emit of the same sources)
 * stays as a fallback for installs predating the split; the two differ only by a sourceMappingURL
 * comment.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { safeCopyFile } from "./fs-safe.js";
import { ensureDir } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The hook entry points — the scripts `.claude/settings.json` invokes directly. This list is what
 * `openwolf status` verifies; it is NOT the copy list. Everything in the compiled hooks directory is
 * deployed (see copyHookScripts), because these entry points import shared modules and a hardcoded
 * copy list silently omits any new one — which broke every hook in every project in 1.19.1 when
 * shared.js gained a `token-estimator.js` import that was never copied.
 */
export const HOOK_FILES = [
  "session-start.js",
  "pre-read.js",
  "pre-write.js",
  "post-read.js",
  "post-write.js",
  "post-bash.js",
  "stop.js",
  "precompact.js",
  "shared.js",
];

/** Resolve the compiled-hooks directory, most-preferred first. __dirname is `dist/src/utils`. */
function findHooksSourceDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "hooks"), // dist/hooks — tsconfig.hooks.json build (tested)
    path.resolve(__dirname, "..", "hooks"),       // dist/src/hooks — main tsc emit (fallback)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "shared.js"))) return candidate;
  }
  return "";
}

/**
 * Copy hooks into `<wolfDir>/hooks/`. Returns false (and warns) if no compiled hooks were found.
 *
 * NOTE: the hooks that actually run are these per-project copies — `.claude/settings.json` invokes
 * `$CLAUDE_PROJECT_DIR/.wolf/hooks/*.js`, not the globally installed package. A rebuild of the
 * package alone does not deploy anything; `openwolf update` does.
 */
export function copyHookScripts(wolfDir: string): boolean {
  const hooksDir = path.join(wolfDir, "hooks");
  ensureDir(hooksDir);

  const sourceDir = findHooksSourceDir();
  let copiedAny = false;
  if (sourceDir) {
    // Copy every compiled module, not just the entry points — a hook that imports a helper needs
    // that helper on disk too, and enumerating them by hand is how they go missing.
    let files: string[] = [];
    try {
      files = fs.readdirSync(sourceDir).filter((f) => f.endsWith(".js"));
    } catch { /* unreadable source dir — handled by the !copiedAny warning below */ }
    for (const file of files) {
      const src = path.join(sourceDir, file);
      try {
        if (!fs.statSync(src).isFile()) continue;
      } catch { continue; }
      safeCopyFile(src, path.join(hooksDir, file));
      copiedAny = true;
    }
  }

  if (!copiedAny) {
    console.warn("  ⚠ Could not find compiled hook scripts. Run 'pnpm build' and re-run.");
  }

  // Hooks are ESM regardless of what the host project declares.
  const hooksPkgPath = path.join(hooksDir, "package.json");
  fs.writeFileSync(hooksPkgPath, JSON.stringify({ type: "module" }, null, 2) + "\n", "utf-8");

  return copiedAny;
}
