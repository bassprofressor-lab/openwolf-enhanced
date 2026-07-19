import * as fs from "node:fs";
import * as path from "node:path";
import { readJSON, writeJSON, withLock } from "./fs-safe.js";
import { blocksFor, entryId } from "./recall.js";
import { assertSafeBaseUrl } from "../daemon/llm-provider.js";

// Client for a remote OpenWolf workspace — any server that speaks this API. No endpoint is baked in:
// `openwolf link --url …` points at whichever workspace you run or subscribe to.
//
// Everything here is OPT-IN and explicit: nothing is sent unless the user ran `openwolf link` and
// then `openwolf push`. There is no background sync, no telemetry, and no hook-time upload — a
// local-first tool that quietly ships your notes somewhere is not a local-first tool.
//
// Two invariants worth stating out loud:
//  1. <private> blocks never leave the machine. blocksFor() blanks them before we ever see the text.
//  2. The token is never written into config.json (which people commit) — it lives in
//     .wolf/remote-token at 0600, mirroring the dashboard-token precedent.

export interface RemoteConfig {
  enabled: boolean;
  baseUrl: string;
  /** Project name to file entries under in the workspace. Defaults to the local project name. */
  project?: string;
}

export function remoteTokenPath(wolfDir: string): string {
  return path.join(wolfDir, "remote-token");
}

export function readRemoteToken(wolfDir: string): string {
  try {
    return fs.readFileSync(remoteTokenPath(wolfDir), "utf-8").trim();
  } catch {
    return "";
  }
}

export function writeRemoteToken(wolfDir: string, token: string): void {
  const p = remoteTokenPath(wolfDir);
  fs.writeFileSync(p, token, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort on platforms without chmod */ }
}

export function clearRemoteToken(wolfDir: string): void {
  try { fs.unlinkSync(remoteTokenPath(wolfDir)); } catch { /* already gone */ }
}

/** Raw shape in config.json — snake_case, like every other section (log_max_bytes, llm_base_url…). */
interface RawRemote { enabled?: boolean; base_url?: string; project?: string }

// Read openwolf.remote from config.json. Returns null when the project was never linked.
export function getRemoteConfig(wolfDir: string): RemoteConfig | null {
  const cfg = readJSON<{ openwolf?: { remote?: RawRemote } }>(path.join(wolfDir, "config.json"), {});
  const r = cfg.openwolf?.remote;
  if (!r || !r.base_url) return null;
  return { enabled: r.enabled !== false, baseUrl: String(r.base_url), project: r.project };
}

// Persist the link. The token is NOT written here — config.json gets committed to git.
export function setRemoteConfig(wolfDir: string, remote: RawRemote): void {
  const p = path.join(wolfDir, "config.json");
  const cfg = readJSON<{ openwolf?: Record<string, unknown> }>(p, {});
  cfg.openwolf = { ...(cfg.openwolf ?? {}), remote: { ...remote } };
  writeJSON(p, cfg);
}

// A linked project must have BOTH a base url and a token — either alone is a half-configured state
// that would fail at the first request with a confusing error.
export function isLinked(wolfDir: string): boolean {
  const cfg = getRemoteConfig(wolfDir);
  return !!cfg && cfg.enabled && !!readRemoteToken(wolfDir);
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

// One hardened request. Reuses assertSafeBaseUrl() from the LLM provider — the SSRF fix from 1.15.1
// (https-only unless loopback, no private/link-local/metadata hosts) applies here for free, and
// redirect:"error" keeps a 3xx from carrying the bearer token to another host.
export async function apiFetch<T = unknown>(
  cfg: RemoteConfig,
  token: string,
  route: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<ApiResult<T>> {
  assertSafeBaseUrl(cfg.baseUrl);
  const url = cfg.baseUrl.replace(/\/+$/, "") + route;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ac.signal,
      redirect: "error",
    });
    let data: unknown = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const msg =
        res.status === 401 ? "invalid or revoked token" :
        res.status === 402 ? "workspace plan limit reached (Free = 1 project)" :
        res.status === 403 ? "this token is read-only" :
        (data as { error?: string } | null)?.error || `HTTP ${res.status}`;
      return { ok: false, status: res.status, data: null, error: msg };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
    return { ok: false, status: 0, data: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Reading the team's memory ───────────────────────────────────────────────

/** One entry as the workspace returns it (GET /api/memory → { entries: [...] }). */
export interface TeamEntry {
  cite?: string | null;
  type: string;
  project: string | null;
  title: string | null;
  body: string;
  tags?: string[];
  author?: string | null;
  uses?: number;
}

// Team citation ids are shown with a `t-` prefix.
//
// Both systems mint ids of the shape `c-3f9a2b`, from DIFFERENT hashes over DIFFERENT text — so a
// local `c-3f9a2b` and a team `c-3f9a2b` can coexist and mean unrelated things. Models already
// invent citation ids; handing them two colliding namespaces would make every citation unverifiable.
// One prefix, and the ambiguity is gone.
export function teamId(cite: string | null | undefined): string {
  const suffix = (cite ?? "").replace(/^c-/, "");
  return suffix ? `t-${suffix}` : "t-?";
}

/**
 * `t-3f9a2b` → `c-3f9a2b` (what the workspace knows it as).
 * Also accepts a bare `c-…` — that is what someone pastes from the workspace's web UI, and
 * blindly prefixing it would ask the server for `c-c-3f9a2b`, which exists nowhere.
 */
export function teamCiteFromId(id: string): string {
  return "c-" + id.replace(/^[tc]-/, "");
}

export async function teamRecall(
  cfg: RemoteConfig, token: string, query: string, limit: number
): Promise<TeamEntry[]> {
  const qs = new URLSearchParams({ q: query, limit: String(limit) });
  if (cfg.project) qs.set("project", cfg.project);
  const res = await apiFetch<{ entries?: TeamEntry[] }>(cfg, token, `/api/memory?${qs}`);
  if (!res.ok) throw new Error(res.error || "recall failed");
  return res.data?.entries ?? [];
}

export async function teamResolve(
  cfg: RemoteConfig, token: string, id: string
): Promise<TeamEntry | null> {
  const qs = new URLSearchParams({ cite: teamCiteFromId(id) });
  const res = await apiFetch<{ entries?: TeamEntry[] }>(cfg, token, `/api/memory?${qs}`);
  if (!res.ok) return null;
  return res.data?.entries?.[0] ?? null;
}

// ─── What is worth sending ───────────────────────────────────────────────────

/** A workspace entry type. Mirrors the remote's `memory_entries.type`. */
export type RemoteType = "learning" | "decision" | "bug" | "note";

export interface Candidate {
  /** Local citation id (content-addressed) — used to remember what we already pushed. */
  localId: string;
  type: RemoteType;
  title: string;
  body: string;
  tags: string[];
}

// Which cerebrum sections map to which remote type.
//
// memory.md is deliberately NOT a source: it is mostly mechanical ("Edited foo.ts, 3→5 lines").
// Pushing that into a shared brain is noise, and noise is what makes people stop reading it.
// User Preferences are also skipped by default — they describe how *this person* wants to be worked
// with, which is not the team's business unless they say so (--with-preferences).
const SECTION_MAP: Array<{ match: RegExp; type: RemoteType; tag: string; personal?: boolean }> = [
  { match: /^#+\s*Key Learnings/i, type: "learning", tag: "key-learning" },
  { match: /^#+\s*Decision Log/i, type: "decision", tag: "decision" },
  { match: /^#+\s*Do-Not-Repeat/i, type: "learning", tag: "do-not-repeat" },
  { match: /^#+\s*User Preferences/i, type: "note", tag: "preference", personal: true },
];

/** First line of a block, stripped of markdown noise, as a title. */
export function titleFor(blockText: string): string {
  const first = blockText.split("\n")[0] || "";
  return first
    .replace(/^[-*]\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/\*\*/g, "")
    .trim()
    .slice(0, 120);
}

/** Cerebrum entries, grouped by the section they live under. */
export function cerebrumCandidates(content: string, opts: { withPreferences?: boolean } = {}): Candidate[] {
  const lines = content.split(/\r?\n/);
  // blocksFor() already blanks <private> regions, so private text can never reach a candidate.
  const blocks = blocksFor("cerebrum.md", content);
  const out: Candidate[] = [];

  for (const b of blocks) {
    // Which section is this block under? Walk backwards to the nearest heading.
    let section: (typeof SECTION_MAP)[number] | undefined;
    for (let i = b.start - 1; i >= 0; i--) {
      const line = lines[i] ?? "";
      if (!/^#+\s/.test(line)) continue;
      section = SECTION_MAP.find((s) => s.match.test(line));
      break; // nearest heading decides, even if it maps to nothing
    }
    if (!section) continue;
    if (section.personal && !opts.withPreferences) continue;
    // The heading itself is a block — don't push the heading as an entry.
    if (/^#+\s/.test(b.text)) continue;

    const text = b.text.trim();
    if (text.length < 40) continue; // one-liners are rarely worth a team entry

    out.push({
      localId: entryId("cerebrum.md", b.text),
      type: section.type,
      title: titleFor(text),
      body: text,
      tags: ["openwolf", section.tag],
    });
  }
  return out;
}

interface BugEntry {
  id?: string;
  error_message?: string;
  file?: string;
  root_cause?: string;
  fix?: string;
  tags?: string[];
}

/** buglog.json entries → type "bug". Auto-detected ones are skipped: they are guesses, not knowledge. */
export function buglogCandidates(raw: unknown): Candidate[] {
  const bugs: BugEntry[] = Array.isArray(raw)
    ? (raw as BugEntry[])
    : ((raw as { bugs?: BugEntry[] } | null)?.bugs ?? []);
  const out: Candidate[] = [];

  for (const b of bugs) {
    const tags = b.tags ?? [];
    if (tags.includes("auto-detected")) continue; // pattern guesses from the write hook, not real findings
    if (!b.error_message || !b.fix) continue;

    const body = [
      b.error_message,
      b.file ? `File: ${b.file}` : "",
      b.root_cause ? `Root cause: ${b.root_cause}` : "",
      `Fix: ${b.fix}`,
    ].filter(Boolean).join("\n");

    out.push({
      localId: entryId("buglog.json", body),
      type: "bug",
      title: titleFor(b.error_message),
      body,
      tags: ["openwolf", "bug", ...tags.slice(0, 5)],
    });
  }
  return out;
}

// ─── Remembering what we already sent ────────────────────────────────────────

// Without this, every `openwolf push` would re-send the whole cerebrum and the workspace would fill
// with duplicates awaiting approval. Keyed by local citation id, which is content-addressed: edit an
// entry and it becomes a new id, i.e. an edited learning is offered again (correct — it changed).
interface PushState { pushed: string[] }

export function pushStatePath(wolfDir: string): string {
  return path.join(wolfDir, "remote-pushed.json");
}

export function readPushed(wolfDir: string): Set<string> {
  const s = readJSON<PushState>(pushStatePath(wolfDir), { pushed: [] });
  return new Set(s.pushed ?? []);
}

export function markPushed(wolfDir: string, ids: string[]): void {
  // Lock the push-state file so two concurrent `openwolf push` runs can't drop each other's ids
  // (read-modify-write must be atomic, or a whole batch reappears as duplicates next push).
  withLock(pushStatePath(wolfDir), () => {
    const cur = readPushed(wolfDir);
    for (const id of ids) cur.add(id);
    writeJSON(pushStatePath(wolfDir), { pushed: [...cur] });
  });
}
