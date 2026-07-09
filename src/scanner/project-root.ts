import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Makefile",
  "CMakeLists.txt",
  "build.gradle",
  "pom.xml",
  "composer.json",
  "Gemfile",
  ".project",
  "deno.json",
];

export function findProjectRoot(from?: string): string {
  const start = path.resolve(from ?? process.cwd());
  let dir = start;
  const root = path.parse(dir).root;
  const home = os.homedir();
  let depth = 0;

  while (depth < 10) {
    // Never treat $HOME (or anything at/above it) as a project root when reached by walking
    // up — otherwise a marker in $HOME (a stray .git / package.json) makes `init` scaffold
    // the whole home directory (upstream #20). If cwd itself is $HOME, the fallback below
    // still returns it.
    const atOrAboveHome = dir === home || home.startsWith(dir + path.sep);
    if (!atOrAboveHome) {
      for (const marker of MARKERS) {
        if (fs.existsSync(path.join(dir, marker))) {
          return dir;
        }
      }
      // Fallback: .wolf/ directory
      if (fs.existsSync(path.join(dir, ".wolf"))) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || parent === root || dir === home) break;
    dir = parent;
    depth++;
  }

  // Default to the starting directory
  return start;
}
