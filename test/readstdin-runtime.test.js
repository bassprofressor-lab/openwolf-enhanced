// readStdin has a Bun fast path (see shared.ts). It exists because the Node stream shim cost Bun
// ~15ms per hook and cancelled its entire startup advantage. These tests run under Node and fake
// the Bun global, so the branch is covered without needing Bun installed in CI.
import { test } from "node:test";
import assert from "node:assert";
import { readStdin } from "../dist/hooks/shared.js";

function withFakeBun(impl, fn) {
  const had = "Bun" in globalThis;
  const prev = globalThis.Bun;
  globalThis.Bun = { stdin: { text: impl } };
  return Promise.resolve(fn()).finally(() => {
    if (had) globalThis.Bun = prev; else delete globalThis.Bun;
  });
}

test("readStdin uses Bun.stdin.text() when running under Bun", async () => {
  let called = 0;
  const out = await withFakeBun(async () => { called++; return '{"tool_name":"Read"}'; },
    () => readStdin());
  assert.equal(called, 1, "the Bun fast path must be taken");
  assert.equal(out, '{"tool_name":"Read"}');
});

test("readStdin falls back to valid JSON when Bun hands back an empty payload", async () => {
  const out = await withFakeBun(async () => "", () => readStdin());
  assert.equal(out, "{}", "callers JSON.parse this; an empty string would throw");
  JSON.parse(out);
});

test("readStdin never rejects when the Bun read fails", async () => {
  const out = await withFakeBun(async () => { throw new Error("stdin exploded"); }, () => readStdin());
  assert.equal(out, "{}", "a hook that rejects here takes the tool call with it");
});

test("readStdin ignores a Bun global that has no stdin.text", async () => {
  // Some environments define globalThis.Bun for feature detection. Taking the fast path on a
  // shape we cannot call would hang the hook.
  const had = "Bun" in globalThis;
  const prev = globalThis.Bun;
  globalThis.Bun = { version: "1.0.0" };
  try {
    const p = readStdin();
    process.stdin.push?.(null);            // close the Node stream path
    assert.ok(p instanceof Promise, "must fall through to the Node path, not crash");
  } finally {
    if (had) globalThis.Bun = prev; else delete globalThis.Bun;
  }
});
