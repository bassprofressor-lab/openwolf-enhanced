#!/usr/bin/env node
/**
 * Hook latency benchmark — Phase 0 of the V2 plan.
 *
 * Two rules this harness exists to enforce, both learned the hard way:
 *
 * 1. NEVER measure against a live .wolf. The hooks cannot tell a synthetic tool event from a real
 *    one, so benchmarking a project's own OpenWolf writes fake edits into its token-ledger and
 *    session state, and the Stop hook then reports work that never happened (bug-353). This
 *    harness copies the fixture into a throwaway directory and measures there.
 *
 * 2. Report the runtime baseline next to every number. A hook is a process start plus OpenWolf's
 *    own work, and those two have completely different fixes. Quoting the total alone is how you
 *    end up building a daemon to shave the smaller half.
 *
 * Usage:
 *   node bench/hook-bench.mjs [--runtime node|bun] [--runs 30] [--fixture <path to a .wolf>]
 *   node bench/hook-bench.mjs --compare            # node vs bun, same fixture, same runs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = path.join(REPO, "dist", "hooks");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[pos];
}

/** A disposable project: real fixture content, but nothing anyone will read afterwards. */
function makeProject(fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wolf-bench-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const target = path.join(root, "src", "subject.py");
  // ~30 KB of plausible source, so anatomy/token estimation does comparable work to a real file.
  fs.writeFileSync(target, Array.from({ length: 700 }, (_, i) =>
    `def handler_${i}(payload, ctx=None):\n    """Stage ${i} of the pipeline."""\n    return {"stage": ${i}, "ok": True}\n`).join("\n"));
  if (fixture && fs.existsSync(fixture)) {
    fs.cpSync(fixture, path.join(root, ".wolf"), { recursive: true });
  } else {
    fs.mkdirSync(path.join(root, ".wolf", "hooks"), { recursive: true });
  }
  return { root, target };
}

function payloads(project, sessionId) {
  const f = project.target;
  const base = { session_id: sessionId, cwd: project.root };
  return {
    "pre-read":     { ...base, tool_name: "Read",  tool_input: { file_path: f } },
    "post-read":    { ...base, tool_name: "Read",  tool_input: { file_path: f }, tool_response: { file: { numLines: 700 } } },
    "pre-write":    { ...base, tool_name: "Edit",  tool_input: { file_path: f, old_string: "ok", new_string: "fine" } },
    "post-write":   { ...base, tool_name: "Edit",  tool_input: { file_path: f, old_string: "ok", new_string: "fine" }, tool_response: {} },
    "post-bash":    { ...base, tool_name: "Bash",  tool_input: { command: "pytest -q" }, tool_response: { stdout: "12 passed\n" } },
    "session-start":{ ...base, source: "startup" },
    "stop":         { ...base },
  };
}

/**
 * One timed run — and it MUST fail loudly.
 *
 * spawnSync does not throw when the runtime is missing: it returns { error: ENOENT } and, with
 * stdio ignored, looks exactly like a very fast success. The first version of this file happily
 * reported "0.9 ms, 0.0 ms davon OpenWolf" for a runtime that does not exist, which is the same
 * silent-measurement-error class as bug-353 — in the harness written to prevent it.
 */
function runOnce(runtime, args, input) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(runtime, args, input === undefined
    ? { stdio: "ignore" }
    : { input, stdio: ["pipe", "ignore", "ignore"] });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.error) throw new Error(`${runtime}: ${r.error.code ?? r.error.message} — Runtime nicht startbar (PATH?)`);
  if (r.signal) throw new Error(`${runtime} ${args[0]}: durch Signal ${r.signal} beendet`);
  if (r.status !== 0) throw new Error(`${runtime} ${args[0]}: exit ${r.status} — der Hook ist gescheitert, die Zeit ist wertlos`);
  return ms;
}

function timeOnce(runtime, script, input) {
  return runOnce(runtime, [script], input);
}

function measure(runtime, script, input, runs, warmup = 3) {
  for (let i = 0; i < warmup; i++) timeOnce(runtime, script, input);
  const s = Array.from({ length: runs }, () => timeOnce(runtime, script, input)).sort((a, b) => a - b);
  return { p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), min: s[0], max: s[s.length - 1] };
}

function baseline(runtime, runs) {
  const t0 = () => runOnce(runtime, ["-e", ""]);
  for (let i = 0; i < 3; i++) t0();
  const s = Array.from({ length: runs }, t0).sort((a, b) => a - b);
  return { p50: quantile(s, 0.5), p95: quantile(s, 0.95) };
}

function assertRuntime(runtime) {
  const r = spawnSync(runtime, ["-e", "process.exit(0)"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error(`\nABBRUCH: "${runtime}" laeuft nicht (${r.error?.code ?? "exit " + r.status}).`);
    console.error(`Ohne lauffaehige Runtime sind alle Zahlen erfunden — deshalb wird hier nicht gemessen.`);
    process.exit(2);
  }
}

function runSuite(runtime, runs, fixture) {
  assertRuntime(runtime);
  const project = makeProject(fixture);
  const base = baseline(runtime, runs);
  const rows = [];
  let n = 0;
  for (const [hook, payload] of Object.entries(payloads(project, `bench-${runtime}`))) {
    const script = path.join(HOOKS, `${hook}.js`);
    if (!fs.existsSync(script)) continue;
    // A fresh session id per hook keeps one hook's bookkeeping out of the next one's measurement.
    const input = JSON.stringify({ ...payload, session_id: `bench-${runtime}-${n++}` });
    const m = measure(runtime, script, input, runs);
    rows.push({ hook, ...m, own: Math.max(0, m.p50 - base.p50) });
  }
  fs.rmSync(project.root, { recursive: true, force: true });
  return { runtime, base, rows };
}

function print(res) {
  console.log(`\n=== ${res.runtime} ===  (Prozessstart-Referenz: p50 ${res.base.p50.toFixed(1)} ms, p95 ${res.base.p95.toFixed(1)} ms)`);
  console.log("hook".padEnd(16) + "p50".padStart(8) + "p95".padStart(8) + "p99".padStart(8) + "max".padStart(8) + "  davon OpenWolf");
  for (const r of res.rows) {
    console.log(r.hook.padEnd(16) + r.p50.toFixed(1).padStart(8) + r.p95.toFixed(1).padStart(8)
      + r.p99.toFixed(1).padStart(8) + r.max.toFixed(1).padStart(8) + `${r.own.toFixed(1)} ms`.padStart(16));
  }
}

const runs = Number(arg("runs", "30"));
const fixture = arg("fixture", "");
if (has("compare")) {
  const a = runSuite("node", runs, fixture);
  const b = runSuite("bun", runs, fixture);
  print(a); print(b);
  console.log(`\n=== node vs bun (p50) ===`);
  console.log("hook".padEnd(16) + "node".padStart(9) + "bun".padStart(9) + "Ersparnis".padStart(12));
  for (const r of a.rows) {
    const o = b.rows.find((x) => x.hook === r.hook);
    if (!o) continue;
    const d = r.p50 - o.p50;
    console.log(r.hook.padEnd(16) + r.p50.toFixed(1).padStart(9) + o.p50.toFixed(1).padStart(9)
      + `${d >= 0 ? "-" : "+"}${Math.abs(d).toFixed(1)} ms`.padStart(12));
  }
  const d = a.base.p50 - b.base.p50;
  console.log("(Prozessstart)".padEnd(16) + a.base.p50.toFixed(1).padStart(9) + b.base.p50.toFixed(1).padStart(9)
    + `${d >= 0 ? "-" : "+"}${Math.abs(d).toFixed(1)} ms`.padStart(12));
} else {
  print(runSuite(arg("runtime", "node"), runs, fixture));
}
