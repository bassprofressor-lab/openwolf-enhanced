import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bookInjection } from "../dist/hooks/shared.js";
import { netSavings } from "../dist/src/cli/report-cmd.js";

// [2026-08-20] Regression cover for injection accounting.
//
// Background: `estimated_savings_vs_bare_cli` counted only avoided reads and never what OpenWolf
// itself writes into the context. A one-sided balance is exactly the mechanism that kept the
// "898 million tokens saved" figure looking plausible for months (bug-210). These tests pin down
// both sides — and that a booking failure NEVER breaks a session.

function tmpWolf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-inject-"));
  fs.mkdirSync(path.join(dir, ".wolf"), { recursive: true });
  return path.join(dir, ".wolf");
}

const readLedger = (w) => JSON.parse(fs.readFileSync(path.join(w, "token-ledger.json"), "utf-8"));

test("netSavings subtracts what was injected from what was saved", () => {
  assert.deepEqual(netSavings({ estimated_savings_vs_bare_cli: 1000, injection_tokens_estimated: 300 }),
    { gross: 1000, injected: 300, net: 700 });
});

test("netSavings may go negative — that is the whole point of the number", () => {
  // A project that injects more than it saves MUST be able to see that. A value clamped at 0
  // would be the flattering one-sidedness this change exists to remove.
  const r = netSavings({ estimated_savings_vs_bare_cli: 200, injection_tokens_estimated: 950 });
  assert.equal(r.net, -750);
});

test("netSavings treats a legacy ledger without the field as 0 injected", () => {
  assert.deepEqual(netSavings({ estimated_savings_vs_bare_cli: 500 }),
    { gross: 500, injected: 0, net: 500 });
});

test("bookInjection accumulates across calls", () => {
  const w = tmpWolf();
  bookInjection(w, 120);
  bookInjection(w, 80);
  assert.equal(readLedger(w).lifetime.injection_tokens_estimated, 200);
});

test("bookInjection leaves existing ledger fields untouched", () => {
  const w = tmpWolf();
  fs.writeFileSync(path.join(w, "token-ledger.json"), JSON.stringify({
    version: 1,
    lifetime: { total_sessions: 7, estimated_savings_vs_bare_cli: 4200 },
    sessions: [{ id: "abc" }],
  }));
  bookInjection(w, 50);
  const lg = readLedger(w);
  assert.equal(lg.lifetime.total_sessions, 7, "unrelated counters stay put");
  assert.equal(lg.lifetime.estimated_savings_vs_bare_cli, 4200);
  assert.equal(lg.sessions.length, 1, "sessions[] must not be lost");
  assert.equal(lg.lifetime.injection_tokens_estimated, 50);
});

test("bookInjection ignores nonsense instead of corrupting the counter", () => {
  const w = tmpWolf();
  for (const bad of [0, -5, NaN, Infinity, undefined, null, "lots"]) bookInjection(w, bad);
  assert.equal(fs.existsSync(path.join(w, "token-ledger.json")), false,
    "no call with an invalid value may write at all");
  bookInjection(w, 10);
  assert.equal(readLedger(w).lifetime.injection_tokens_estimated, 10);
});

test("bookInjection never breaks a session when the ledger is corrupt", () => {
  // [2026-08-20, review] This test used to assert doesNotThrow and nothing else — so it passed
  // while the code rewrote the corrupt file as a two-field stub without `sessions[]`, which then
  // killed every later stop hook. Asserting "it did not crash" is not asserting "it did no harm".
  const w = tmpWolf();
  const corrupt = "{ this is not JSON";
  fs.writeFileSync(path.join(w, "token-ledger.json"), corrupt);
  assert.doesNotThrow(() => bookInjection(w, 42), "accounting must never crash a hook");
  assert.equal(fs.readFileSync(path.join(w, "token-ledger.json"), "utf-8"), corrupt,
    "a corrupt ledger is left alone, not replaced by a stub");
});

test("bookInjection creates a ledger the stop hook can still use", () => {
  // The stop hook does ledger.sessions.findIndex(...). A ledger without sessions[] makes it throw
  // on every future turn, and the throw is swallowed — so nothing would ever be recorded again.
  const w = tmpWolf();
  bookInjection(w, 10);
  const lg = readLedger(w);
  assert.ok(Array.isArray(lg.sessions), "sessions[] must exist");
  assert.ok(Array.isArray(lg.waste_flags) && Array.isArray(lg.daemon_usage));
  assert.ok(lg.optimization_report && typeof lg.optimization_report === "object");
  assert.equal(lg.lifetime.injection_tokens_estimated, 10);
});
