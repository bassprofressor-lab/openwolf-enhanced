import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON } from "../utils/fs-safe.js";
import {
  getRemoteConfig, readRemoteToken, apiFetch, cerebrumCandidates, buglogCandidates,
  readPushed, markPushed, type Candidate,
} from "../utils/remote.js";

// `openwolf push` — offer this project's durable knowledge to the linked workspace.
//
// Everything goes through /api/seed, which files entries as needs_approval: a machine may propose,
// a human decides what enters the team's memory. That is also why this is a manual command and not
// a hook — an automatic uploader would turn the approval queue into a firehose nobody reads.

interface PushOpts { dryRun?: boolean; limit?: string; withPreferences?: boolean }

const BATCH = 50; // the remote's documented seed batch size

export async function pushCommand(opts: PushOpts): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  const cfg = getRemoteConfig(wolfDir);
  const token = readRemoteToken(wolfDir);
  if (!cfg || !cfg.enabled || !token) {
    console.error("Not linked. Run `openwolf link --url … --token owp_…` first.");
    process.exitCode = 1;
    return;
  }

  // Collect. blocksFor() (inside cerebrumCandidates) blanks <private> regions, so private notes
  // cannot leave the machine even if someone pushes the whole file.
  let cerebrum = "";
  try { cerebrum = fs.readFileSync(path.join(wolfDir, "cerebrum.md"), "utf-8"); } catch { /* none */ }
  const buglog = readJSON<unknown>(path.join(wolfDir, "buglog.json"), null);

  const all: Candidate[] = [
    ...cerebrumCandidates(cerebrum, { withPreferences: opts.withPreferences }),
    ...buglogCandidates(buglog),
  ];

  const already = readPushed(wolfDir);
  let fresh = all.filter((c) => !already.has(c.localId));
  const limit = parseInt(opts.limit || "0", 10);
  const capped = limit > 0 && fresh.length > limit;
  if (capped) fresh = fresh.slice(0, limit);

  console.log(`OpenWolf push → ${cfg.baseUrl} (project: ${cfg.project ?? "default"})`);
  console.log(`  ${all.length} candidate(s) found, ${already.size} already pushed, ${fresh.length} to send.`);
  if (!opts.withPreferences) console.log("  User Preferences skipped (personal) — add --with-preferences to include them.");
  // A silent cap reads as "we sent everything". Say what was left behind.
  if (capped) console.log(`  NOTE: capped at --limit ${limit}; ${all.length - already.size - limit} candidate(s) left for the next run.`);

  if (fresh.length === 0) { console.log("\nNothing new to send."); return; }

  const byType = fresh.reduce<Record<string, number>>((m, c) => { m[c.type] = (m[c.type] || 0) + 1; return m; }, {});
  console.log(`  types: ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", ")}`);

  if (opts.dryRun) {
    console.log("\n--dry-run — nothing sent. What would go:\n");
    for (const c of fresh.slice(0, 20)) {
      console.log(`  [${c.type}] ${c.title}`);
    }
    if (fresh.length > 20) console.log(`  … and ${fresh.length - 20} more`);
    return;
  }

  let sent = 0;
  const sentIds: string[] = [];
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH);
    const res = await apiFetch<{ inserted?: number; skipped?: number }>(cfg, token, "/api/seed", {
      method: "POST",
      body: {
        candidates: batch.map((c) => ({
          type: c.type,
          title: c.title,
          body: c.body,
          tags: c.tags,
          author: "openwolf",
          project: cfg.project,
        })),
      },
    });
    if (!res.ok) {
      console.error(`\nBatch ${i / BATCH + 1} failed: ${res.error}`);
      if (sentIds.length) markPushed(wolfDir, sentIds); // keep what did land — never re-send it
      process.exitCode = 1;
      return;
    }
    const inserted = res.data?.inserted ?? batch.length;
    sent += inserted;
    sentIds.push(...batch.map((c) => c.localId));
    process.stdout.write(`  sent ${Math.min(i + BATCH, fresh.length)}/${fresh.length}\r`);
  }

  markPushed(wolfDir, sentIds);
  console.log(`\n\n${sent} entr(ies) sent — all waiting for approval in the workspace.`);
  console.log("Nothing is visible to the team until someone approves it there.");
}
