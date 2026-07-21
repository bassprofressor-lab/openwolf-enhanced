import * as fs from "node:fs";
import * as path from "node:path";
import { getWolfDir } from "../hooks/shared.js";
import { recallAcross, resolveId, type ProjectHit } from "../utils/recall.js";
import { getRegisteredProjects } from "./registry.js";
import {
  getRemoteConfig, readRemoteToken, teamRecall, teamResolve, teamId, type TeamEntry,
} from "../utils/remote.js";
import { resolveEmbedConfig } from "../utils/embeddings.js";
import { semanticRecall, hybridRecall } from "../utils/semantic-recall.js";

interface RecallCliOpts { limit?: string; json?: boolean; full?: boolean; id?: string; all?: boolean; team?: boolean; semantic?: boolean; hybrid?: boolean }

interface Target { name?: string; wolfDir: string }

// The projects to search: just this one, or every registered project when --all.
function targets(all: boolean | undefined): Target[] {
  if (!all) return [{ wolfDir: getWolfDir() }];
  return getRegisteredProjects(true)
    .map((p) => ({ name: p.name, wolfDir: path.join(p.root, ".wolf") }))
    .filter((t) => fs.existsSync(t.wolfDir));
}

// "project:file" when searching across projects, plain "file" otherwise.
const label = (t: Target, file: string) => (t.name ? `${t.name}:${file}` : file);

// The linked workspace, if this project has one AND the user asked for it (--team is never implicit:
// a recall must not make a network call behind the user's back).
function teamSource(opts: RecallCliOpts) {
  if (!opts.team) return null;
  const wolfDir = getWolfDir();
  const cfg = getRemoteConfig(wolfDir);
  const token = readRemoteToken(wolfDir);
  if (!cfg || !cfg.enabled || !token) return null;
  return { cfg, token };
}

function printTeamHits(entries: TeamEntry[], full: boolean | undefined): void {
  for (const e of entries) {
    const loc = [e.project, e.type].filter(Boolean).join(":");
    const used = e.uses ? `  ·  cited ${e.uses}×` : "";
    console.log(`  [${teamId(e.cite)}] team  ${loc}${used}`);
    const text = e.title ? `${e.title}\n${e.body}` : e.body;
    if (full) {
      console.log(text.split("\n").map((l) => `       │ ${l}`).join("\n"));
    } else {
      const one = text.replace(/\s+/g, " ");
      console.log(`       ${one.length > 120 ? one.slice(0, 117) + "…" : one}`);
    }
  }
}

export async function recallCommand(query: string[], opts: RecallCliOpts): Promise<void> {
  const searchTargets = targets(opts.all);
  const team = teamSource(opts);
  if (searchTargets.length === 0) {
    console.error(opts.all ? "No registered projects with a .wolf/ found." : "No .wolf/ in this project. Run `openwolf init` first.");
    process.exitCode = 1;
    return;
  }

  // --- Targeted second layer: resolve a citation id to its full block (searches every target). ---
  if (opts.id) {
    // A `t-…` id is a team entry by construction — don't scan local files for it.
    if (!opts.id.startsWith("t-")) {
      for (const t of searchTargets) {
        const entry = resolveId(t.wolfDir, opts.id);
        if (entry) {
          if (opts.json) { process.stdout.write(JSON.stringify({ ...entry, project: t.name }, null, 2) + "\n"); return; }
          console.log(`[${entry.id}]  ${label(t, entry.file)}:${entry.line}\n`);
          console.log(entry.text);
          return;
        }
      }
    }

    // Team lookup: always for `t-…`, and as a fallback for a `c-…` that no local file knows — that
    // is usually someone pasting a citation from the workspace's web UI, which mints `c-` ids too.
    const remote = getRemoteConfig(getWolfDir());
    const rtoken = readRemoteToken(getWolfDir());
    if (remote?.enabled && rtoken) {
      const entry = await teamResolve(remote, rtoken, opts.id);
      if (entry) {
        if (opts.json) { process.stdout.write(JSON.stringify({ ...entry, id: teamId(entry.cite), remote: remote.baseUrl }, null, 2) + "\n"); return; }
        console.log(`[${teamId(entry.cite)}]  team · ${remote.baseUrl}${entry.project ? ` · ${entry.project}` : ""}\n`);
        if (entry.title) console.log(entry.title + "\n");
        console.log(entry.body);
        return;
      }
    }

    if (opts.json) process.stdout.write("null\n");
    else console.log(`No entry with id "${opts.id}".`);
    process.exitCode = 1;
    return;
  }

  const q = (query || []).join(" ").trim();
  if (!q) {
    console.error("Usage: openwolf recall <query> [--full] [--all]  |  openwolf recall --id <id>");
    process.exitCode = 1;
    return;
  }
  const limit = Math.max(1, parseInt(opts.limit || "12", 10) || 12);

  // Semantic / hybrid recall runs against the primary project only (embeddings index per .wolf/).
  // It gracefully falls back to keyword search if the embeddings endpoint isn't reachable.
  let hits: ProjectHit[];
  if (opts.semantic || opts.hybrid) {
    const primary = searchTargets[0];
    const cfg = resolveEmbedConfig(primary.wolfDir);
    try {
      const raw = opts.hybrid
        ? await hybridRecall(primary.wolfDir, q, cfg, limit)
        : await semanticRecall(primary.wolfDir, q, cfg, limit);
      hits = raw.map((h) => ({ ...h, wolfDir: primary.wolfDir }));
      if (opts.all) console.error("Note: --semantic/--hybrid search only this project (not --all).");
    } catch (e) {
      console.error(`Semantic recall unavailable (${(e as Error).message}). Falling back to keyword search.`);
      hits = recallAcross(searchTargets, q, { limit });
    }
  } else {
    hits = recallAcross(searchTargets, q, { limit });
  }

  // Team hits are fetched but NOT merged into the local ranking. The workspace ranks with a hybrid
  // (full-text + trigram + semantic, reciprocal-rank-fused, boosted by confirmed use); local recall
  // ranks with BM25 over markdown. Those numbers are not on the same scale, and interleaving them by
  // a made-up common score would be a fabricated ordering dressed up as relevance. Two lists, honest.
  let teamHits: TeamEntry[] = [];
  let teamError = "";
  if (team) {
    try {
      teamHits = await teamRecall(team.cfg, team.token, q, limit);
    } catch (e) {
      teamError = (e as Error).message;
    }
  } else if (opts.team) {
    teamError = "not linked — run `openwolf link --url … --token owp_…`";
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      local: hits.map(({ wolfDir, ...h }) => h),
      team: teamHits.map((e) => ({ ...e, id: teamId(e.cite) })),
      ...(teamError ? { team_error: teamError } : {}),
    }, null, 2) + "\n");
    return;
  }
  if (hits.length === 0 && teamHits.length === 0) {
    // Say the workspace was asked. "No matches" alone leaves the user unable to tell whether the
    // remote was queried and came back empty, or was never queried at all — the same ambiguity the
    // branch further down exists to remove, and this is the case where it bites hardest.
    const where = opts.all ? " across all projects" : "";
    const team_ = teamError
      ? ` Team workspace: ${teamError}.`
      : opts.team
        ? " The team workspace was searched too and had nothing. (Entries awaiting approval do not appear in recall.)"
        : "";
    console.log(`No matches for "${q}"${where}.${team_}`);
    return;
  }
  console.log(`${hits.length} match(es) for "${q}"${opts.all ? ` across ${searchTargets.length} projects` : ""}:\n`);
  for (const h of hits) {
    const loc = h.project ? `${h.project}:${h.file}` : h.file;
    console.log(`  [${h.id}] ${String(h.score).padStart(3)}  ${loc}:${h.line}`);
    if (opts.full) {
      const entry = resolveId(h.wolfDir, h.id);
      const body = entry ? entry.text : h.text;
      console.log(body.split("\n").map((l) => `       │ ${l}`).join("\n"));
    } else {
      const snippet = h.text.length > 120 ? h.text.slice(0, 117) + "…" : h.text;
      console.log(`       ${snippet}`);
    }
  }
  if (teamHits.length > 0) {
    console.log(`\nTeam workspace — ${teamHits.length} match(es), ranked by the workspace, not comparable to the scores above:\n`);
    printTeamHits(teamHits, opts.full);
  } else if (teamError) {
    console.log(`\nTeam workspace: ${teamError}`);
  } else if (opts.team) {
    // Say so. Silence here is indistinguishable from "the workspace was never asked", and the most
    // likely reason for an empty answer — everything still sitting in the approval queue — is one the
    // user can act on the moment they know about it.
    console.log("\nTeam workspace: no matches. (Entries awaiting approval do not appear in recall.)");
  }

  console.log(opts.full
    ? `\nCite an entry as [id]; re-open it later with \`openwolf recall --id <id>${opts.all ? " --all" : ""}\`.`
    : `\nExpand: \`openwolf recall "${q}" --full${opts.all ? " --all" : ""}\`  ·  one entry: \`openwolf recall --id <id>${opts.all ? " --all" : ""}\``);
}
