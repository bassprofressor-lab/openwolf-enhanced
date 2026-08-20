import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractImports, resolveImport, buildGraph, pageRank, toPercentile, importsSupported,
} from "../dist/src/scanner/import-graph.js";
import { rankFind } from "../dist/src/cli/find-cmd.js";

// [2026-08-20] Import graph, importance and `openwolf find`.
// The graph is only as good as its edges: an invented edge skews the ranking, and does it
// invisibly. So most of what follows pins down what must NOT become an edge.

test("extractImports reads all four TS forms, but only relative specifiers", () => {
  const src = `
    import { a } from "./a.js";
    import b from "../b";
    export { c } from "./c";
    const d = require("./d");
    const e = await import("./e");
    import "react";
    import x from "node:fs";
    import y from "@scope/pkg";
  `;
  const got = extractImports(src, ".ts").sort();
  assert.deepEqual(got, ["../b", "./a.js", "./c", "./d", "./e"]);
});

test("extractImports: package imports NEVER create an edge", () => {
  // They say nothing about the structure of THIS project and would flood the graph.
  assert.deepEqual(extractImports(`import fs from "node:fs"; import z from "zod";`, ".ts"), []);
});

test("extractImports understands relative Python imports including dot depth", () => {
  const src = "from .engine import run\nfrom ..utils.paths import p\nimport os\nfrom pkg import q\n";
  assert.deepEqual(extractImports(src, ".py").sort(), ["../utils/paths", "./engine"]);
});

test("importsSupported states honestly which languages are read", () => {
  assert.equal(importsSupported(".ts"), true);
  assert.equal(importsSupported(".py"), true);
  assert.equal(importsSupported(".go"), false, "unknown = leaf, not guessed");
});

test("resolveImport tries extensions and index files", () => {
  const known = new Set(["src/a.ts", "src/lib/index.ts", "src/mod/__init__.py", "src/b.tsx"]);
  assert.equal(resolveImport("./a", "src/main.ts", known), "src/a.ts");
  assert.equal(resolveImport("./lib", "src/main.ts", known), "src/lib/index.ts");
  assert.equal(resolveImport("./mod", "src/main.py", known), "src/mod/__init__.py");
  assert.equal(resolveImport("../b", "src/sub/x.ts", known), "src/b.tsx");
});

test("resolveImport: .js in TS sources means the .ts file (ESM convention)", () => {
  const known = new Set(["src/shared.ts"]);
  assert.equal(resolveImport("./shared.js", "src/main.ts", known), "src/shared.ts");
});

test("resolveImport returns null instead of inventing an edge", () => {
  assert.equal(resolveImport("./nope", "src/main.ts", new Set(["src/main.ts"])), null);
});

test("buildGraph invents no edges and allows no self-references", () => {
  const g = buildGraph({
    "src/main.ts": ["./shared.js", "./missing"],
    "src/shared.ts": ["./main"],
  });
  assert.deepEqual(g["src/main.ts"], ["src/shared.ts"], "unresolvable './missing' is dropped");
  assert.deepEqual(g["src/shared.ts"], ["src/main.ts"]);
});

test("pageRank: the heavily imported file ranks top, the leaf bottom", () => {
  const nodes = ["hub.ts", "a.ts", "b.ts", "c.ts", "lonely.ts"];
  const g = { "a.ts": ["hub.ts"], "b.ts": ["hub.ts"], "c.ts": ["hub.ts"], "hub.ts": [], "lonely.ts": [] };
  const r = pageRank(g, nodes);
  assert.equal(r["hub.ts"], 1, "most imported = 1 after normalization");
  assert.ok(r["hub.ts"] > r["a.ts"]);
  assert.ok(r["a.ts"] >= r["lonely.ts"]);
  // Deterministic: the same result twice, otherwise any ranking would be chance.
  assert.deepEqual(pageRank(g, nodes), r);
});

test("pageRank loses no probability mass to dangling nodes", () => {
  // Without redistributing dangling mass, every value shrinks on each iteration.
  const nodes = ["a.ts", "b.ts", "c.ts"];
  const r30 = pageRank({ "a.ts": ["b.ts"], "b.ts": [], "c.ts": [] }, nodes, { iterations: 30 });
  const r300 = pageRank({ "a.ts": ["b.ts"], "b.ts": [], "c.ts": [] }, nodes, { iterations: 300 });
  for (const n of nodes) assert.ok(Math.abs(r30[n] - r300[n]) < 1e-6, `${n} converges`);
});

test("toPercentile preserves the order and spreads the range", () => {
  const raw = { a: 0.058, b: 0.058, c: 0.06, d: 1.0 };
  const p = toPercentile(raw);
  assert.ok(p.d > p.c && p.c > p.a, "order preserved");
  assert.equal(p.a, p.b, "equal scores share a percentile");
  assert.equal(p.d, 1);
  assert.equal(p.a, 0.5 / 3, "average rank of the bottom two");
});

const INDEX = {
  files: [
    { path: "src/central.ts", description: "handles the widget lifecycle", tokens: 900, importance: 1.0 },
    { path: "src/rand/widget.ts", description: "", tokens: 300, importance: 0.05 },
  ],
  symbols: {
    "src/rand/widget.ts": [{ name: "widget", kind: "fn", startLine: 10, endLine: 40, tokens: 200 }],
  },
};

test("rankFind: an exact symbol name beats the important file with a description match", () => {
  // This is the core rule. If importance won, it would hide the very thing being searched for.
  const hits = rankFind("widget", INDEX);
  assert.equal(hits[0].path, "src/rand/widget.ts");
  assert.equal(hits[0].symbol, "widget");
  assert.equal(hits[0].startLine, 10);
  assert.ok(hits.some((h) => h.path === "src/central.ts"), "the description match still appears");
  assert.ok(hits.findIndex((h) => h.path === "src/central.ts") > 0, "but not first");
});

test("rankFind is case-insensitive and returns nothing for an empty query", () => {
  assert.equal(rankFind("WIDGET", INDEX)[0].symbol, "widget");
  assert.deepEqual(rankFind("   ", INDEX), []);
});

test("rankFind honours the limit", () => {
  assert.equal(rankFind("widget", INDEX, 1).length, 1);
});

test("rankFind uses importance ONLY as a tiebreak", () => {
  // Two hits of the same kind (both exact file names) — here and only here importance counts.
  const idx = { files: [
    { path: "a/thing.ts", description: "", tokens: 10, importance: 0.1 },
    { path: "b/thing.ts", description: "", tokens: 10, importance: 0.9 },
  ], symbols: {} };
  assert.equal(rankFind("thing", idx)[0].path, "b/thing.ts");
});

test("resolveImport refuses to walk out of the project root", () => {
  // [2026-08-20, review] `..` past the root used to be dropped silently, so `../../shared/util`
  // from src/a.ts collapsed to `shared/util` and could resolve onto an unrelated in-project file —
  // a phantom edge that skews PageRank invisibly.
  const known = new Set(["src/a.ts", "shared/util.ts"]);
  assert.equal(resolveImport("../../shared/util", "src/a.ts", known), null);
  assert.equal(resolveImport("../shared/util", "src/sub/a.ts", known), null,
    "one level out of src/ is still outside a root-relative path set");
});
