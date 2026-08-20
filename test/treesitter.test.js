import { test } from "node:test";
import assert from "node:assert/strict";

import { extractSymbolsTS, treeSitterSupports, treeSitterUnavailableReason, refineSymbols }
  from "../dist/src/scanner/treesitter-extractor.js";

// [2026-08-20] tree-sitter is an OPTIONAL dependency (~52 MB of grammars). These tests therefore
// have to skip cleanly when it is absent — a red test would be a false alarm here. What ALWAYS
// runs are the cases that do not need the dependency.

const TS_SRC = `
export interface Cfg { a: number }
export function one(x) {
  return x + 1;
}
const SIDE = [1, 2, 3];
export class Thing {
  method() { return 1; }
}
`;

const available = (await extractSymbolsTS("export function f(){}", ".ts", 10)) !== null;

test("treeSitterSupports names only extensions with a known grammar", () => {
  assert.equal(treeSitterSupports(".ts"), true);
  assert.equal(treeSitterSupports(".rs"), true);
  assert.equal(treeSitterSupports(".txt"), false);
});

test("extractSymbolsTS returns null for an unknown extension — null means 'not measured'", async () => {
  // The difference from an empty list matters: empty means "measured, nothing there".
  assert.equal(await extractSymbolsTS("anything", ".txt", 10), null);
});

test("refineSymbols keeps the regex results when tree-sitter returns nothing", async () => {
  const symbols = { "a.txt": [{ name: "x", kind: "fn", startLine: 1, endLine: 9, tokens: 5 }] };
  const res = await refineSymbols(symbols, () => "content", 30);
  assert.equal(res.refined, 0);
  assert.equal(symbols["a.txt"][0].endLine, 9, "nothing overwritten");
});

test("refineSymbols names a reason when nothing was refined", async () => {
  const res = await refineSymbols({}, () => null, 30);
  assert.equal(res.refined, 0);
  // reason may be null when tree-sitter IS there and there was simply nothing to do — but it must
  // never be undefined, or the caller cannot tell the cases apart.
  assert.ok(res.reason === null || typeof res.reason === "string");
});

test("tree-sitter gives the REAL symbol end, not 'the line before the next one'",
  { skip: available ? false : `tree-sitter not installed (${treeSitterUnavailableReason()})` },
  async () => {
    const syms = await extractSymbolsTS(TS_SRC, ".ts", 30);
    const fn = syms.find((s) => s.name === "one");
    assert.ok(fn, "function found");
    // `one` ends on line 5; the regex path would have counted up to the line before `Thing` and
    // swallowed the SIDE constant along the way.
    assert.equal(fn.endLine, 5);
    assert.ok(!syms.some((s) => s.name === "SIDE"), "a constant is not a symbol range");
  });

test("tree-sitter finds methods INSIDE a class",
  { skip: available ? false : "tree-sitter not installed" },
  async () => {
    const syms = await extractSymbolsTS(TS_SRC, ".ts", 30);
    assert.ok(syms.some((s) => s.name === "Thing" && s.kind === "class"));
    assert.ok(syms.some((s) => s.name === "method"), "precisely what the regex version cannot do");
  });

test("tree-sitter honours the cap",
  { skip: available ? false : "tree-sitter not installed" },
  async () => {
    const many = Array.from({ length: 40 }, (_, i) => `export function f${i}() {}`).join("\n");
    assert.equal((await extractSymbolsTS(many, ".ts", 5)).length, 5);
  });

test("refineSymbols MERGES — a symbol only the regex extractor found must survive", async () => {
  // [2026-08-20, review] Replacing wholesale deleted 9 real symbols on this repo after a scan,
  // e.g. `export const f = () => {}` forms the tree-sitter walk did not reach. An unfindable
  // symbol defeats the entire point of `openwolf find`.
  const symbols = {
    "x.ts": [
      { name: "one", kind: "fn", startLine: 1, endLine: 99, tokens: 10 },   // tree-sitter knows it
      { name: "onlyRegex", kind: "fn", startLine: 50, endLine: 60, tokens: 7 },
    ],
  };
  const res = await refineSymbols(symbols, () => TS_SRC, 30);
  const names = symbols["x.ts"].map((s) => s.name);
  assert.ok(names.includes("onlyRegex"), "regex-only symbol survives the merge");
  if (available) {
    assert.equal(res.refined, 1);
    const one = symbols["x.ts"].find((s) => s.name === "one");
    assert.equal(one.endLine, 5, "tree-sitter wins on names it knows");
  }
});
