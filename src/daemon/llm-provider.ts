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

// Literal-IP private/link-local check (incl. cloud metadata 169.254.169.254). Hostnames that resolve
// to private IPs via DNS are NOT caught here — this guards the common SSRF sinks, not every case.
function isPrivateHost(host: string): boolean {
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Refuse an llm_base_url that would exfiltrate the API key or reach internal services. Since the URL
// comes from a project's config.json (which a cloned/untrusted repo can carry), require https except
// for explicit loopback (local models), and block private/link-local/metadata addresses.
export function assertSafeBaseUrl(baseUrl: string): void {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new Error(`invalid llm_base_url: ${baseUrl}`); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
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
export function buildLlmRequest(cfg: LlmConfig, apiKey: string, prompt: string, maxTokens = 2048): LlmRequest {
  assertSafeBaseUrl(cfg.baseUrl);
  const messages = [{ role: "user", content: prompt }];
  if (cfg.provider === "openai") {
    return {
      url: `${cfg.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages, stream: false }),
    };
  }
  return {
    url: `${cfg.baseUrl}/messages`,
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages }),
  };
}

// Extract the assistant text from either API's response shape — pure.
export function parseLlmResponse(provider: LlmProvider, data: unknown): string {
  if (provider === "openai") {
    const d = data as { choices?: Array<{ message?: { content?: string } }> };
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }
  const d = data as { content?: Array<{ type: string; text?: string }> };
  return d.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
}
