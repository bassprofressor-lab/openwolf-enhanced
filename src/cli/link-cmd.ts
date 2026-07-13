import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import {
  getRemoteConfig, setRemoteConfig, readRemoteToken, writeRemoteToken, clearRemoteToken,
  apiFetch, remoteTokenPath,
} from "../utils/remote.js";
import { ensureWolfGitignore } from "../utils/wolf-gitignore.js";

// `openwolf link` — connect this project to a remote OpenWolf workspace.
//
// The token is verified against the live API before anything is written. A link command that happily
// stores a typo and only fails three days later at the first push is worse than no link command.

interface LinkOpts { url?: string; token?: string; project?: string; status?: boolean; unlink?: boolean }

export async function linkCommand(opts: LinkOpts): Promise<void> {
  const wolfDir = path.join(findProjectRoot(), ".wolf");

  if (opts.unlink) {
    setRemoteConfig(wolfDir, { enabled: false });
    clearRemoteToken(wolfDir);
    console.log("Unlinked. Token deleted, remote disabled. Nothing was removed from the workspace.");
    return;
  }

  if (opts.status || (!opts.url && !opts.token)) {
    const cfg = getRemoteConfig(wolfDir);
    const token = readRemoteToken(wolfDir);
    if (!cfg || !token) {
      console.log("Not linked.\n\n  openwolf link --url https://wolfpack.example.com --token owp_…\n");
      console.log("Create a token in the workspace under Settings → Connectors.");
      return;
    }
    console.log(`Linked to ${cfg.baseUrl}`);
    console.log(`  project : ${cfg.project ?? "(default)"}`);
    console.log(`  enabled : ${cfg.enabled}`);
    console.log(`  token   : ${token.slice(0, 8)}… (${remoteTokenPath(wolfDir)}, 0600)`);
    const probe = await apiFetch(cfg, token, "/api/memory?limit=1");
    console.log(probe.ok ? "  status  : token accepted" : `  status  : NOT working — ${probe.error}`);
    return;
  }

  if (!opts.url || !opts.token) {
    console.error("Both --url and --token are required.");
    process.exitCode = 1;
    return;
  }
  if (!opts.token.startsWith("owp_")) {
    console.error("That does not look like a workspace token (expected it to start with 'owp_').");
    process.exitCode = 1;
    return;
  }

  const project = opts.project || path.basename(findProjectRoot());
  const cfg = { enabled: true, baseUrl: opts.url, project };

  // Verify BEFORE persisting. assertSafeBaseUrl (inside apiFetch) rejects http:// and private hosts.
  let probe;
  try {
    probe = await apiFetch(cfg, opts.token, "/api/memory?limit=1");
  } catch (e) {
    console.error(`Refused: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!probe.ok) {
    console.error(`Could not reach the workspace: ${probe.error}`);
    process.exitCode = 1;
    return;
  }

  setRemoteConfig(wolfDir, { enabled: true, base_url: opts.url, project });
  writeRemoteToken(wolfDir, opts.token);
  // The token exists as of this line — so the thing that keeps it out of git has to exist too, here,
  // not at the next `openwolf update`. 0600 is no defence against `git add .wolf`.
  ensureWolfGitignore(wolfDir);

  console.log(`Linked to ${opts.url} (project: ${project}).`);
  console.log(`Token stored at ${remoteTokenPath(wolfDir)} (0600) — not in config.json, which gets committed.`);
  console.log("\nNothing has been sent yet. `openwolf push --dry-run` shows what would go.");
}
