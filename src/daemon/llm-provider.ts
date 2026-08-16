import * as net from "node:net";
import * as path from "node:path";
import { readJSON } from "../utils/fs-safe.js";

// Provider-agnostic config for the cron engine's AI tasks. OpenWolf historically hard-coded the
// Anthropic Messages API; this lets a project point those tasks at any Anthropic or OpenAI-compatible
// endpoint (OpenAI, Groq, Cerebras, Mistral, a local server…) via config.json — no code change.
//
// config.json → openwolf.cron:
//   "llm_provider": "anthropic" | "openai"   (default "anthropic")
//   "llm_base_url": "https://…/v1"           (default per provider)
//   "llm_model":    "model-id"               (default per provider)
//   "api_key_env":  "ENV_VAR_NAME"           (default ANTHROPIC_API_KEY for anthropic; required for openai)
//
// Everything defaults to the previous behaviour, so existing setups are unchanged.

export type LlmProvider = "anthropic" | "openai";

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;   // no trailing slash, no endpoint suffix
  model: string;
  apiKeyEnv: string; // name of the env var holding the key
}

const DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string; apiKeyEnv: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" },
};

interface CronCfg {
  llm_provider?: string;
  llm_base_url?: string | null;
  llm_model?: string | null;
  api_key_env?: string | null;
}

// Resolve LLM config from a raw openwolf.cron object (pure — injected by resolveLlmConfig).
export function llmConfigFrom(cron: CronCfg | undefined): LlmConfig {
  const provider: LlmProvider = cron?.llm_provider === "openai" ? "openai" : "anthropic";
  const d = DEFAULTS[provider];
  const baseUrl = (cron?.llm_base_url || d.baseUrl).replace(/\/+$/, "");
  return {
    provider,
    baseUrl,
    model: cron?.llm_model || d.model,
    apiKeyEnv: cron?.api_key_env || d.apiKeyEnv,
  };
}

export function resolveLlmConfig(wolfDir: string): LlmConfig {
  const cfg = readJSON<{ openwolf?: { cron?: CronCfg } }>(path.join(wolfDir, "config.json"), {});
  return llmConfigFrom(cfg.openwolf?.cron);
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Private/link-local check for an IPv6 LITERAL (brackets already stripped).
 *
 * The ranges are defined by the first 16-bit group, so that is what gets compared — as a number, not
 * as text:
 *   fe80::/10  link-local        → fe80 … febf   (the old `startsWith("fe80:")` missed fe81…febf,
 *                                                 so fe90::1 sailed through the guard) [bug-213]
 *   fc00::/7   unique local      → fc00 … fdff
 *
 * ::ffff:a.b.c.d maps an IPv4 address into v6 and is the classic way around a v4-only check, so it
 * is unwrapped and handed to the v4 rules. Both spellings have to be handled: WHATWG `new URL()`
 * rewrites ::ffff:127.0.0.1 into the hex form ::ffff:7f00:1 before this code ever sees it, so
 * matching only the dotted spelling would leave exactly the bypass this is meant to close.
 */
function isPrivateIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  const mapped = host.match(/^::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i);
  if (mapped) {
    if (mapped[1]) return isPrivateIpv4(mapped[1]);
    const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const head = parseInt(host.split(":")[0], 16);
  if (!Number.isFinite(head)) return false;
  return (head >= 0xfe80 && head <= 0xfebf) || (head >= 0xfc00 && head <= 0xfdff);
}

/**
 * Literal-IP private/link-local check (incl. cloud metadata 169.254.169.254). Hostnames that resolve
 * to private IPs via DNS are NOT caught here — this guards the common SSRF sinks, not every case.
 *
 * The prefix rules only apply to actual IP literals. They used to run against any string, so
 * `startsWith("fc")` / `startsWith("fd")` rejected every ordinary hostname beginning with those two
 * letters — fc2.com, fdisk.example.com, fd-api.vendor.io — as if it were an IPv6 ULA. [bug-212]
 */
function isPrivateHost(host: string): boolean {
  switch (net.isIP(host)) {
    case 4: return isPrivateIpv4(host);
    case 6: return isPrivateIpv6(host);
    default: return false;   // a name, not an address — DNS is out of scope here, see above
  }
}

// A loopback endpoint is a local model server (Ollama, llama.cpp, LM Studio). Two consequences:
// it may be reached over cleartext http, and it needs no API key — so there is no secret to leak.
export function isLocalEndpoint(baseUrl: string): boolean {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

// Local model servers accept (and ignore) any bearer token, so an unset key must not block the task.
// Remote providers still require one — a keyless request there is a guaranteed 401.
export function requiresApiKey(cfg: LlmConfig): boolean {
  return !isLocalEndpoint(cfg.baseUrl);
}

// Refuse an llm_base_url that would exfiltrate the API key or reach internal services. Since the URL
// comes from a project's config.json (which a cloned/untrusted repo can carry), require https except
// for explicit loopback (local models), and block private/link-local/metadata addresses.
export function assertSafeBaseUrl(baseUrl: string): void {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new Error(`invalid llm_base_url: ${baseUrl}`); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = isLocalEndpoint(baseUrl);
  if (u.protocol === "http:") {
    if (!isLoopback) throw new Error(`llm_base_url must use https:// for non-loopback hosts (got http://${host})`);
  } else if (u.protocol !== "https:") {
    throw new Error(`llm_base_url must be http(s), got ${u.protocol}`);
  }
  if (!isLoopback && isPrivateHost(host)) {
    throw new Error(`llm_base_url points at a private/link-local address (${host}) — refused to protect your API key`);
  }
}

export interface LlmRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// Build the HTTP request for a single-prompt completion — pure, so it's unit-testable offline.
// An empty apiKey emits no auth header at all (local servers reject nothing; sending "Bearer "
// with an empty value trips stricter ones).
// maxTokens defaults high because reasoning models charge their hidden reasoning against the same
// budget — 2048 was enough for a plain model's answer but can be spent entirely before Qwen3 says a word.
export function buildLlmRequest(cfg: LlmConfig, apiKey: string, prompt: string, maxTokens = 4096): LlmRequest {
  assertSafeBaseUrl(cfg.baseUrl);
  const messages = [{ role: "user", content: prompt }];
  if (cfg.provider === "openai") {
    return {
      url: `${cfg.baseUrl}/chat/completions`,
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages, stream: false }),
    };
  }
  return {
    url: `${cfg.baseUrl}/messages`,
    headers: { ...(apiKey ? { "x-api-key": apiKey } : {}), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages }),
  };
}

// Run a single-prompt completion against the configured provider. Bundles the security hardening:
// base-url validation (via buildLlmRequest), a hard timeout, and redirect:"error" so the API key
// never follows a 3xx to another host. Used by the cron engine and `openwolf consolidate`.
export async function callLlm(cfg: LlmConfig, apiKey: string, prompt: string, opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  return (await callLlmDetailed(cfg, apiKey, prompt, opts)).text;
}

/**
 * Same call, but it also reports whether the model ran out of budget MID-ANSWER.
 *
 * `callLlm` cannot express that: it throws when a reasoning model produced nothing at all, but a
 * response cut off *after* some text is returned as a normal string. That is fine for a summary and
 * catastrophic for anything that overwrites a file — half a cerebrum.md still contains "# Cerebrum"
 * and would be persisted over the whole one. Callers that write files must check `truncated`.
 */
export async function callLlmDetailed(
  cfg: LlmConfig, apiKey: string, prompt: string, opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<{ text: string; truncated: boolean }> {
  const req = buildLlmRequest(cfg, apiKey, prompt, opts.maxTokens ?? 4096);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  // The timer has to survive until the BODY is read, not just until the headers arrive. fetch()
  // resolves as soon as the response head is in; response.json()/.text() pull the rest afterwards.
  // With clearTimeout in a finally around the fetch alone, a server that sends headers and then
  // stalls the body held the call forever — timeoutMs covered the handshake and nothing else.
  // [bug-211]
  try {
    const response = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${cfg.provider} API error (${cfg.model}) ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    return { text: parseLlmResponse(cfg.provider, data), truncated: wasTruncated(cfg.provider, data) };
  } catch (err) {
    // Also catches an abort during the body read, which is the case this fix is about.
    if ((err as Error).name === "AbortError") throw new Error(`${cfg.provider} API request timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Did the model stop because it hit max_tokens (rather than finishing its thought)? — pure. */
export function wasTruncated(provider: LlmProvider, data: unknown): boolean {
  if (provider === "openai") {
    return (data as { choices?: Array<{ finish_reason?: string }> }).choices?.[0]?.finish_reason === "length";
  }
  return (data as { stop_reason?: string }).stop_reason === "max_tokens";
}

export const TRUNCATED_BEFORE_ANSWER =
  "the model hit max_tokens before emitting any answer. Reasoning models (Qwen3, o-series, …) spend the " +
  "budget on hidden reasoning tokens first, so a small max_tokens yields an empty reply. Raise maxTokens.";

// Extract the assistant text from either API's response shape — pure.
//
// A reasoning model can burn the entire max_tokens budget on reasoning tokens and return HTTP 200 with
// EMPTY content (finish_reason "length"). Returning "" for that looked like a successful empty answer:
// `consolidate` skipped every merge as "implausible output" and `llm --test` printed a green ✓ on nothing.
// A response truncated before it said anything is an error, not an empty string. A merely malformed body
// still yields "" — only an explicit length/max_tokens stop is treated as failure.
export function parseLlmResponse(provider: LlmProvider, data: unknown): string {
  if (provider === "openai") {
    const d = data as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    const choice = d.choices?.[0];
    const text = choice?.message?.content?.trim() ?? "";
    if (!text && choice?.finish_reason === "length") throw new Error(TRUNCATED_BEFORE_ANSWER);
    return text;
  }
  const d = data as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  const text = d.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
  if (!text && d.stop_reason === "max_tokens") throw new Error(TRUNCATED_BEFORE_ANSWER);
  return text;
}
