import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { hasEmbeddingIndex, fuseByRank, semanticRecallAcross }
  from "../dist/src/utils/semantic-recall.js";

// [2026-08-20] `recall --all` used to fall back to keyword search with a one-line note, so the
// strongest retrieval this tool has stopped at the repo boundary.

const wolf = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ow-xrecall-"));
  const w = path.join(d, ".wolf");
  fs.mkdirSync(w, { recursive: true });
  return w;
};

const writeMeta = (w, over = {}) => fs.writeFileSync(
  path.join(w, "recall-embeddings.json"),
  JSON.stringify({ version: 2, model: "m1", dims: 4, entries: [{ src: "a.md", line: 1, text: "x", id: "c-1" }], ...over }));

test("hasEmbeddingIndex answers without building anything", () => {
  const w = wolf();
  assert.equal(hasEmbeddingIndex(w, "m1"), false, "no file, no index");
  writeMeta(w);
  assert.equal(hasEmbeddingIndex(w, "m1"), true);
  assert.equal(hasEmbeddingIndex(w, "m2"), false, "an index for another model is not usable");
  writeMeta(w, { entries: [] });
  assert.equal(hasEmbeddingIndex(w, "m1"), false, "an empty index is not an index");
  writeMeta(w, { version: 1 });
  assert.equal(hasEmbeddingIndex(w, "m1"), false, "an old format is not usable");
});

test("SAFETY: --all never builds an index behind the user's back", async () => {
  // The reason this is a test and not a comment: `semanticRecall` builds on demand, so without the
  // guard one `recall --all --semantic` would fire an embedding run for every registered project.
  // Nothing here has an index, so nothing may reach the network — if the guard breaks, this hangs
  // or throws instead of returning cleanly.
  const a = wolf(), b = wolf();
  const res = await semanticRecallAcross(
    [{ wolfDir: a, name: "alpha" }, { wolfDir: b, name: "beta" }],
    "anything", "semantic", 5,
    () => ({ enabled: true, baseUrl: "http://127.0.0.1:1", model: "m1", apiKeyEnv: "NONE" }),
    false,
  );
  assert.deepEqual(res.searched, []);
  assert.deepEqual(res.skipped, ["alpha", "beta"]);
  assert.deepEqual(res.failed, [], "a missing index is not a failure");
  assert.equal(res.hits.length, 0);
});

test("a project without an index is named, never silently dropped", async () => {
  const a = wolf();
  const res = await semanticRecallAcross(
    [{ wolfDir: a, name: "alpha" }], "q", "semantic", 5,
    () => ({ enabled: true, baseUrl: "http://127.0.0.1:1", model: "m1", apiKeyEnv: "NONE" }),
    false,
  );
  assert.deepEqual(res.skipped, ["alpha"]);
});

// ── rank fusion ───────────────────────────────────────────────────────────────

const hit = (wolfDir, file, line) => ({ wolfDir, file, line, text: `${file}:${line}`, score: 1, id: `x-${line}` });

test("fuseByRank rewards being top of one list over mediocre in both (K=2)", () => {
  const top = hit("/p1", "a.md", 1);
  const midA = hit("/p2", "b.md", 2);
  const midB = { ...midA };
  const out = fuseByRank([[top, midA], [midB, top]], 5, 2);
  // top: 1/2 + 1/3 = 0.833 · mid: 1/3 + 1/2 = 0.833 — tie here by construction; make it decisive:
  const out2 = fuseByRank([[top, midA], [top, midA]], 5, 2);
  assert.equal(out2[0].file, "a.md");
  assert.ok(out2[0].score > out2[1].score);
  assert.equal(out.length, 2, "the same entry from two lists is fused, not duplicated");
});

test("the same path in two projects stays two entries", () => {
  // Both projects have a cerebrum.md:12. Keying on file:line alone would merge two unrelated
  // entries into one and attribute the fused rank to whichever arrived first.
  const out = fuseByRank([[hit("/p1", "cerebrum.md", 12)], [hit("/p2", "cerebrum.md", 12)]], 5, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((h) => h.wolfDir).sort(), ["/p1", "/p2"]);
});

test("fuseByRank respects the limit", () => {
  const lists = [[hit("/p", "a.md", 1), hit("/p", "b.md", 2), hit("/p", "c.md", 3)]];
  assert.equal(fuseByRank(lists, 2, 2).length, 2);
});
