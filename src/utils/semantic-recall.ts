import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { collectUnits, entryId, recall, type RecallHit } from "./recall.js";
import { readJSON, writeJSON } from "./fs-safe.js";
import { embedTexts, cosine, type EmbedConfig } from "./embeddings.js";

// Semantic recall: embed each memory unit, search by cosine similarity, and fuse with the lexical
// (BM25) recall. The index is split across two files in .wolf/: recall-embeddings.json holds unit
// metadata, recall-embeddings.vec the raw Float32 vectors. Vectors must NOT live in the JSON — on
// a large knowledge base (20k+ units × 768 dims) the pretty-printed floats exceed V8's maximum
// string length, so JSON.stringify throws and the index silently never persists. The binary
// sidecar is ~7× smaller and needs no parsing. Only new/changed units are re-embedded per run.

const META_FILE = "recall-embeddings.json";
const VEC_FILE = "recall-embeddings.vec";
const hashText = (t: string) => crypto.createHash("sha1").update(t).digest("hex").slice(0, 16);

interface MetaEntry { src: string; line: number; blockStart: number; text: string; hash: string; id: string; }
interface Meta { version: 2; model: string; dims: number; entries: MetaEntry[]; }

export interface EmbeddingIndex { entries: MetaEntry[]; dims: number; vectors: Float32Array; }

/** Vector of entry i, as a zero-copy view. All-zero = not (yet) embedded. */
const vecOf = (idx: EmbeddingIndex, i: number): Float32Array =>
  idx.vectors.subarray(i * idx.dims, (i + 1) * idx.dims);

function isZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
  return true;
}

// tmp+rename like fs-safe.writeJSON, but for bytes — and failures propagate instead of being
// swallowed: a recall index that silently fails to persist re-embeds everything on every query.
function atomicWriteBytes(filePath: string, bytes: Uint8Array): void {
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

function loadIndex(wolfDir: string, model: string): EmbeddingIndex | null {
  const meta = readJSON<Meta | null>(path.join(wolfDir, META_FILE), null);
  if (!meta || meta.version !== 2 || meta.model !== model || !meta.dims || !Array.isArray(meta.entries)) return null;
  try {
    const buf = fs.readFileSync(path.join(wolfDir, VEC_FILE));
    if (buf.byteLength !== meta.entries.length * meta.dims * 4) return null; // stale sidecar
    // Copy: a Buffer's byteOffset into its pool is not guaranteed 4-byte aligned.
    const vectors = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return { entries: meta.entries, dims: meta.dims, vectors };
  } catch {
    return null;
  }
}

function saveIndex(wolfDir: string, model: string, idx: EmbeddingIndex): void {
  // Vectors first: if we crash between the writes, the meta/sidecar length check fails on the next
  // load and the index rebuilds, instead of pairing new metadata with old vectors.
  atomicWriteBytes(path.join(wolfDir, VEC_FILE), new Uint8Array(idx.vectors.buffer, 0, idx.vectors.byteLength));
  writeJSON(path.join(wolfDir, META_FILE), { version: 2, model, dims: idx.dims, entries: idx.entries } satisfies Meta);
}

/** Ensure an up-to-date embedding index: reuse cached vectors for unchanged text, embed the rest. */
export async function buildOrUpdateIndex(wolfDir: string, cfg: EmbedConfig): Promise<EmbeddingIndex> {
  const units = collectUnits(wolfDir);
  const prev = loadIndex(wolfDir, cfg.model);

  const cache = new Map<string, Float32Array>();
  if (prev) prev.entries.forEach((e, i) => {
    const v = vecOf(prev, i);
    if (!isZero(v)) cache.set(e.hash, v);
  });

  const entries: MetaEntry[] = units.map((u) => ({
    src: u.src, line: u.line, blockStart: u.blockStart, text: u.text,
    hash: hashText(u.text), id: entryId(u.src, u.blockText),
  }));
  const pending = entries.map((e, i) => i).filter((i) => !cache.has(entries[i].hash));

  // Vector width comes from the cache, or from the first embedding response.
  let dims = prev?.dims ?? 0;
  const BATCH = 64;
  let firstVecs: number[][] = [];
  if (dims === 0) {
    if (pending.length === 0) return { entries, dims: 0, vectors: new Float32Array(0) };
    firstVecs = await embedTexts(cfg, pending.slice(0, BATCH).map((i) => entries[i].text));
    dims = firstVecs[0].length;
  }

  const idx: EmbeddingIndex = { entries, dims, vectors: new Float32Array(entries.length * dims) };
  entries.forEach((e, i) => {
    const cached = cache.get(e.hash);
    if (cached) idx.vectors.set(cached, i * dims);
  });
  firstVecs.forEach((v, j) => idx.vectors.set(v, pending[j] * dims));
  let done = firstVecs.length;

  // Embed the rest in batches. The index is checkpointed periodically and on failure — un-embedded
  // entries stay all-zero, which the cache treats as absent, so an interrupted build resumes where
  // it stopped instead of re-embedding everything.
  const CHECKPOINT_EVERY = 20 * BATCH;
  const verbose = pending.length > 2 * BATCH;
  try {
    for (let i = done; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH);
      const vecs = await embedTexts(cfg, chunk.map((k) => entries[k].text));
      vecs.forEach((v, j) => idx.vectors.set(v, chunk[j] * dims));
      done = i + chunk.length;
      if (done % CHECKPOINT_EVERY < BATCH) saveIndex(wolfDir, cfg.model, idx);
      if (verbose) process.stderr.write(`\rembedding memory index: ${done}/${pending.length}`);
    }
  } catch (e) {
    saveIndex(wolfDir, cfg.model, idx);
    if (verbose) process.stderr.write("\n");
    throw new Error(`${(e as Error).message} (partial index saved — rerun to resume)`);
  }
  if (verbose) process.stderr.write("\n");
  saveIndex(wolfDir, cfg.model, idx);
  return idx;
}

function toHit(e: MetaEntry, score: number): RecallHit {
  return { file: e.src, line: e.line, text: e.text, score: Math.round(score * 1000) / 1000, id: e.id, blockLine: e.blockStart };
}

/** Pure semantic ranking by cosine similarity to the query embedding. */
export async function semanticRecall(wolfDir: string, query: string, cfg: EmbedConfig, limit = 12): Promise<RecallHit[]> {
  const idx = await buildOrUpdateIndex(wolfDir, cfg);
  if (idx.entries.length === 0 || idx.dims === 0) return [];
  const [qv] = await embedTexts(cfg, [query]);
  return idx.entries
    .map((e, i) => ({ e, sim: cosine(qv, vecOf(idx, i)) }))
    .filter(({ sim }) => sim !== 0) // zero vector = not embedded (or degenerate) — never rank it
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit)
    .map(({ e, sim }) => toHit(e, sim));
}

/**
 * Hybrid recall: fuse lexical (BM25) and semantic rankings with Reciprocal Rank Fusion. RRF combines
 * two rankings by summing 1/(K + rank) per list, so it needs no score-scale tuning — an item ranked
 * high by either method rises, and one ranked high by both wins.
 *
 * K defaults to 2, not the textbook 60: with only two lists and a small candidate pool, K=60 lets an
 * item that is mediocre in both lists (2/80) outscore the top hit of one list (1/61). Measured on a
 * 14-query set over a 22k-unit knowledge base: K≤2 gives MRR 0.845 vs 0.627 at K=60, beating both
 * BM25 (0.726) and pure semantic (0.714) alone. Override via openwolf.recall.rrf_k in config.json.
 */
export async function hybridRecall(wolfDir: string, query: string, cfg: EmbedConfig, limit = 12): Promise<RecallHit[]> {
  const tuning = readJSON<{ openwolf?: { recall?: { rrf_k?: number } } }>(path.join(wolfDir, "config.json"), {});
  const K = tuning.openwolf?.recall?.rrf_k ?? 2;
  const lexical = recall(wolfDir, query, { limit: 50 });
  const semantic = await semanticRecall(wolfDir, query, cfg, 50);
  const fused = new Map<string, { hit: RecallHit; score: number }>();
  const add = (list: RecallHit[]) => list.forEach((hit, rank) => {
    const key = `${hit.file}:${hit.line}`;
    const s = 1 / (K + rank);
    const cur = fused.get(key);
    if (cur) cur.score += s; else fused.set(key, { hit, score: s });
  });
  add(lexical);
  add(semantic);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 1000) / 1000 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-project semantic recall.
//
// [2026-08-20] `--all` used to fall back to keyword search with a one-line note, so the strongest
// retrieval this tool has stopped at the repo boundary — the "per-repo silo" critique in its most
// concrete and most fixable form.
//
// Two things had to be true before it could be turned on:
//
//   1. It must not build indexes behind the user's back. `semanticRecall` builds on demand, which
//      is right for one project and wrong for twelve: `recall --all --semantic` would have fired
//      off an embedding run for every registered project. Projects without an index are skipped
//      and NAMED, so "not in the results" never silently means "never searched".
//   2. It must not invent a common ranking. Cosine similarities from separately built indexes are
//      on nominally the same scale, but their distributions are not — a small corpus concentrates
//      high similarities. So the per-project lists are fused by RANK (the same RRF already used
//      for hybrid), which is what rank fusion exists for. A single project keeps its native
//      scores; there is nothing to fuse.
// ─────────────────────────────────────────────────────────────────────────────

export interface CrossTarget { wolfDir: string; name?: string }

export interface CrossHit extends RecallHit { wolfDir: string; project?: string }

export interface CrossResult {
  hits: CrossHit[];
  /** Projects that were actually searched. */
  searched: string[];
  /** Projects skipped for want of an embeddings index — named, never silently dropped. */
  skipped: string[];
  /**
   * Projects that HAVE an index but whose search failed, with the reason.
   *
   * [2026-08-20] Kept apart from `skipped` deliberately: the first run reported "skipped 5 without
   * an embeddings index" while one of the five had a 24,855-entry index and had merely failed to
   * reach the embedding endpoint. Two very different problems, one message, and the user would
   * have gone looking for the wrong one.
   */
  failed: Array<{ project: string; reason: string }>;
  /** True when scores are RRF ranks rather than the mode's native score. */
  fused: boolean;
}

/** Is there a usable index for this model, without building one? */
export function hasEmbeddingIndex(wolfDir: string, model: string): boolean {
  const meta = readJSON<Meta | null>(path.join(wolfDir, META_FILE), null);
  return Boolean(meta && meta.version === 2 && meta.model === model
    && Array.isArray(meta.entries) && meta.entries.length > 0);
}

export function fuseByRank(lists: CrossHit[][], limit: number, K: number): CrossHit[] {
  const fused = new Map<string, { hit: CrossHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.wolfDir}:${hit.file}:${hit.line}`;
      const s = 1 / (K + rank);
      const cur = fused.get(key);
      if (cur) cur.score += s; else fused.set(key, { hit, score: s });
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 1000) / 1000 }));
}

export async function semanticRecallAcross(
  targets: CrossTarget[],
  query: string,
  mode: "semantic" | "hybrid",
  limit: number,
  resolveCfg: (wolfDir: string) => EmbedConfig,
  /**
   * May a missing index be built on the spot? True for a single-project recall, where building on
   * demand has always been the behaviour. False for `--all`: firing off an embedding run for every
   * registered project as a side effect of one query is exactly the surprise this must not create.
   */
  allowBuild = true,
): Promise<CrossResult> {
  const searched: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ project: string; reason: string }> = [];
  const lists: CrossHit[][] = [];

  for (const t of targets) {
    const cfg = resolveCfg(t.wolfDir);
    const name = t.name ?? "this project";
    if (!allowBuild && !hasEmbeddingIndex(t.wolfDir, cfg.model)) { skipped.push(name); continue; }
    try {
      const raw = mode === "hybrid"
        ? await hybridRecall(t.wolfDir, query, cfg, limit)
        : await semanticRecall(t.wolfDir, query, cfg, limit);
      searched.push(name);
      lists.push(raw.map((h) => ({ ...h, wolfDir: t.wolfDir, project: t.name })));
    } catch (e) {
      // One unreachable project must not sink the whole query — but it is reported as a failure
      // with its reason, not quietly folded in with the ones that simply have no index.
      failed.push({ project: name, reason: (e as Error).message });
    }
  }

  if (lists.length === 0) return { hits: [], searched, skipped, failed, fused: false };
  if (lists.length === 1) return { hits: lists[0].slice(0, limit), searched, skipped, failed, fused: false };

  const tuning = readJSON<{ openwolf?: { recall?: { rrf_k?: number } } }>(
    path.join(targets[0].wolfDir, "config.json"), {});
  const K = tuning.openwolf?.recall?.rrf_k ?? 2;
  return { hits: fuseByRank(lists, limit, K), searched, skipped, failed, fused: true };
}
