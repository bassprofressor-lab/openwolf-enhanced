import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stopHook = path.join(repoRoot, "dist", "hooks", "stop.js");

/**
 * The Stop hook fires once per TURN, not once per session — that is what session.stop_count counts.
 * Everything on _session.json (files_read, files_written, anatomy_hits) is cumulative for the whole
 * session, so a hook that adds those to lifetime on every stop books the same work again and again:
 * over N turns it counts 1+2+3+…+N instead of N.
 *
 * That was bug-210, and it was invisible in isolation — every single run looked right. It only shows
 * up when the hook runs SEVERAL times against the same session, which is why this test drives the
 * real compiled hook instead of a unit under it. Before the fix: 3 stops produced 3 session entries,
 * 7 reads instead of 3, and double the tokens.
 */
function runStops(turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwolf-stop-"));
  const sessionFile = path.join(dir, ".wolf", "hooks", "_session.json");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

  const session = {
    session_id: "session-test-0900",
    started: new Date().toISOString(),
    files_read: {},
    files_written: [],
    edit_counts: {},
    anatomy_hits: 0,
    anatomy_misses: 0,
    repeated_reads_warned: 0,
    cerebrum_warnings: 0,
    stop_count: 0,
  };

  for (const turn of turns) {
    const current = fs.existsSync(sessionFile)
      ? JSON.parse(fs.readFileSync(sessionFile, "utf8"))
      : session;
    turn(current);
    fs.writeFileSync(sessionFile, JSON.stringify(current));
    execFileSync("node", [stopHook], {
      cwd: repoRoot,
      input: "{}",
      encoding: "utf8",
      env: { ...process.env, OPENWOLF_PROJECT_DIR: dir },
    });
  }

  const ledger = JSON.parse(fs.readFileSync(path.join(dir, ".wolf", "token-ledger.json"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return ledger;
}

test("stop hook books each unit of work exactly once across turns [bug-210]", () => {
  const ledger = runStops([
    (s) => {
      s.files_read["a.ts"] = { count: 1, tokens: 100, first_read: "t" };
      s.files_read["b.ts"] = { count: 1, tokens: 200, first_read: "t" };
      s.files_written.push({ file: "a.ts", action: "Edit", tokens: 50, at: "t" });
      s.anatomy_hits = 2;
    },
    () => {},                                                    // turn with no new activity
    (s) => { s.files_read["c.ts"] = { count: 1, tokens: 300, first_read: "t" }; },
  ]);

  assert.equal(ledger.sessions.length, 1, "one entry per session, not per turn");
  assert.equal(ledger.lifetime.total_reads, 3);
  assert.equal(ledger.lifetime.total_writes, 1);
  assert.equal(ledger.lifetime.anatomy_hits, 2);
  assert.equal(ledger.lifetime.total_tokens_estimated, 650);     // 100 + 200 + 300 read, 50 written
});

test("a turn that adds nothing adds nothing to the ledger [bug-210]", () => {
  const once = runStops([
    (s) => { s.files_read["a.ts"] = { count: 1, tokens: 100, first_read: "t" }; },
  ]);
  const twice = runStops([
    (s) => { s.files_read["a.ts"] = { count: 1, tokens: 100, first_read: "t" }; },
    () => {},
  ]);
  assert.deepEqual(twice.lifetime, once.lifetime, "an idle turn must not move any lifetime counter");
});

test("the session entry carries the latest cumulative state, not the first [bug-210]", () => {
  const ledger = runStops([
    (s) => { s.files_read["a.ts"] = { count: 1, tokens: 100, first_read: "t" }; },
    (s) => { s.files_read["b.ts"] = { count: 1, tokens: 200, first_read: "t" }; },
  ]);
  assert.equal(ledger.sessions.length, 1);
  assert.equal(ledger.sessions[0].totals.reads_count, 2, "replaced, not left at the first turn's state");
});
