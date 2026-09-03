// Regression test for bug-352.
//
// withLock used to treat EVERY openSync failure as "somebody else holds the lock". For a missing
// parent directory that is wrong twice over: openSync throws ENOENT (not EEXIST), so the stale
// check's statSync throws too, and the bare `continue` in its catch skipped the sleep. The result
// was ~174k iterations of a hot loop over the full 1500ms budget, followed by a guaranteed
// LockTimeoutError and a silently dropped update.
//
// Calibrated against the broken build: it took 1500ms and pegged a core. The assertions below
// fail on that build and pass on the fixed one.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as shared from "../dist/hooks/shared.js";
const { withLock, LockTimeoutError } = shared;
// Namespace import on purpose: against the pre-fix build this export does not exist, and a named
// import would fail the whole FILE at load time — which would "fail" without ever exercising the
// behaviour. This way the timing assertions below are what actually calibrates the test.
const LockUnavailableError = shared.LockUnavailableError;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wolf-lock-"));
}

test("withLock creates a missing parent directory instead of spinning until timeout", () => {
  const root = tmpdir();
  const target = path.join(root, "does", "not", "exist", "state.json");
  const started = Date.now();
  const result = withLock(target, () => {
    fs.writeFileSync(target, '{"ok":true}');
    return "ran";
  });
  const elapsed = Date.now() - started;

  assert.equal(result, "ran", "the callback must actually run");
  assert.ok(fs.existsSync(target), "the callback's write must have landed");
  assert.ok(elapsed < 250, `must not burn the lock budget: took ${elapsed}ms (broken build: ~1500ms)`);
  assert.ok(!fs.existsSync(target + ".lock"), "the lock file must be released");
  fs.rmSync(root, { recursive: true, force: true });
});

test("withLock fails fast on an unrecoverable filesystem error rather than looping", () => {
  const root = tmpdir();
  // A path whose parent is a FILE, not a directory: mkdir cannot fix this, so waiting is pointless.
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "i am a file");
  const target = path.join(blocker, "state.json");

  const started = Date.now();
  assert.throws(
    () => withLock(target, () => "never"),
    (err) => {
      assert.ok(LockUnavailableError, "LockUnavailableError must be exported");
      assert.ok(err instanceof LockUnavailableError, "must raise LockUnavailableError");
      assert.ok(err instanceof LockTimeoutError, "must stay a LockTimeoutError so tryWithLock catches it");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `must fail fast, not spin: took ${elapsed}ms (broken build: ~1500ms)`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("withLock still waits for a genuinely held lock, then times out", () => {
  const root = tmpdir();
  const target = path.join(root, "state.json");
  // A fresh lock held by nobody we can see: not stale (STALE_MS is 5000), so this is real contention.
  fs.writeFileSync(target + ".lock", "99999");

  const started = Date.now();
  assert.throws(() => withLock(target, () => "never"), LockTimeoutError);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1400, `contention must still be waited out: took only ${elapsed}ms`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("withLock takes over a stale lock", () => {
  const root = tmpdir();
  const target = path.join(root, "state.json");
  const lock = target + ".lock";
  fs.writeFileSync(lock, "1");
  const old = Date.now() - 10_000;              // older than STALE_MS
  fs.utimesSync(lock, old / 1000, old / 1000);

  const started = Date.now();
  assert.equal(withLock(target, () => "ran"), "ran");
  assert.ok(Date.now() - started < 250, "a stale lock must be reclaimed immediately");
  fs.rmSync(root, { recursive: true, force: true });
});
