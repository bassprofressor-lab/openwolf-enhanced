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

export interface LlmRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// Build the HTTP request for a single-prompt completion — pure, so it's unit-testable offline.
export function buildLlmRequest(cfg: LlmConfig, apiKey: string, prompt: string, maxTokens = 2048): LlmRequest {
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
