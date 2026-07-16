import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { resolveLlmConfig, callLlm, requiresApiKey, isLocalEndpoint, type LlmConfig } from "../daemon/llm-provider.js";

// `openwolf llm` — show which model the project's AI features (cron tasks, consolidate) will call,
// and optionally prove the endpoint answers. Without this, a misconfigured llm_* only surfaces as a
// failed cron task hours later; a local model server adds a second failure mode (nothing listening).

interface LlmOpts { test?: boolean; prompt?: string }

// The port is read back out of the configured base_url — hard-coding Ollama's 11434 sent LM Studio
// users (port 1234) to forward a port nothing was listening on.
function endpointPort(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return "1234";
  }
}

// Turn a fetch/HTTP failure into the one line that actually tells the user what to do next.
export function explainLlmError(cfg: LlmConfig, err: Error): string {
  const msg = err.message || String(err);
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  const port = endpointPort(cfg.baseUrl);
  if (cause === "ECONNREFUSED" || /ECONNREFUSED|fetch failed|Empty reply|socket hang up/i.test(msg)) {
    return isLocalEndpoint(cfg.baseUrl)
      ? `Nothing is listening on ${cfg.baseUrl}. If the model runs on another machine, forward the port to this one:\n` +
        `    ssh -N -R ${port}:localhost:${port} <user>@<this-host>   (run on the machine with the model)\n` +
        `  If the tunnel is already up, the model server itself is not running — LM Studio serves only while\n` +
        `  the Developer tab's server toggle is "Running" (\`lms server start\`); Ollama serves via \`ollama serve\`.`
      : `Cannot reach ${cfg.baseUrl} — ${msg}`;
  }
  if (/\b404\b/.test(msg) && isLocalEndpoint(cfg.baseUrl)) {
    return `Endpoint answered 404 — the server is up but does not know the model "${cfg.model}".\n` +
      `  Check the exact id it serves:  curl ${cfg.baseUrl}/models\n` +
      `  Then load it (LM Studio: load the model or enable JIT loading; Ollama: ollama pull ${cfg.model}).`;
  }
  if (/max_tokens/.test(msg)) {
    return msg; // already the actionable reasoning-model explanation from parseLlmResponse
  }
  if (/\b401\b|\b403\b/.test(msg)) {
    return `Rejected (auth). ${requiresApiKey(cfg) ? `Check that $${cfg.apiKeyEnv} holds a valid key.` : "The local server demands a key — set one in $" + cfg.apiKeyEnv + "."}`;
  }
  return msg;
}

export async function llmCommand(opts: LlmOpts): Promise<void> {
  const wolfDir = path.join(findProjectRoot(), ".wolf");
  const cfg = resolveLlmConfig(wolfDir);
  const keyed = !!process.env[cfg.apiKeyEnv];
  const local = isLocalEndpoint(cfg.baseUrl);

  console.log("OpenWolf LLM — used by cron AI tasks and `openwolf consolidate`\n");
  console.log(`  provider   ${cfg.provider}${local ? "  (local model server — no API key needed)" : ""}`);
  console.log(`  endpoint   ${cfg.baseUrl}`);
  console.log(`  model      ${cfg.model}`);
  console.log(`  api key    ${keyed ? `$${cfg.apiKeyEnv} is set` : requiresApiKey(cfg) ? `$${cfg.apiKeyEnv} is NOT set — remote providers need one` : "not required"}`);

  if (!opts.test) {
    console.log("\nRun `openwolf llm --test` to send a real prompt and time the round-trip.");
    return;
  }

  const prompt = opts.prompt || "Reply with exactly one word: OK";
  console.log(`\n  → ${JSON.stringify(prompt)}`);
  const started = Date.now();
  try {
    // 2048, not 256: a reasoning model spends the budget on thinking before it answers, and 256 was
    // gone before Qwen3 emitted a single character — the test then "passed" with an empty reply.
    const reply = await callLlm(cfg, process.env[cfg.apiKeyEnv] ?? "", prompt, { maxTokens: 2048, timeoutMs: 120_000 });
    const secs = (Date.now() - started) / 1000;
    if (!reply) {
      // An empty answer is a failure. Reporting ✓ on 0 chars is how this stayed hidden.
      console.error(`\n  ✗ the endpoint answered in ${secs.toFixed(1)}s but returned no text.\n` +
        `    The server is reachable, so this is a model/response problem, not a connection one.`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ← ${reply.replace(/\n/g, "\n    ")}`);
    console.log(`\n  ✓ ${secs.toFixed(1)}s round-trip (${reply.length} chars)`);
    // A local 20B+ model on CPU answers at single-digit tokens/s — usable for a cron job that runs
    // nightly, not for anything a human waits on. Say so instead of letting them find out in prod.
    if (local && secs > 30) console.log(`  ⚠ that is slow — fine for nightly cron tasks, painful for interactive use.`);
  } catch (err) {
    console.error(`\n  ✗ ${explainLlmError(cfg, err as Error)}`);
    process.exitCode = 1;
  }
}
