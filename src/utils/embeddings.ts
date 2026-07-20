import * as path from "node:path";
import { readJSON } from "./fs-safe.js";
import { isLocalEndpoint } from "../daemon/llm-provider.js";

// Embeddings for semantic recall. Provider-agnostic: talks to any OpenAI-compatible /embeddings
// endpoint. Defaults to a local LM Studio server (keyless), so semantic memory stays local — the
// same angle as the keyless local chat models.

export interface EmbedConfig {
  enabled: boolean;
  baseUrl: string;   // OpenAI-compatible, e.g. http://localhost:1234/v1
  model: string;
  apiKeyEnv: string;
}

const DEFAULTS = {
  baseUrl: "http://localhost:1234/v1",
  model: "text-embedding-nomic-embed-text-v1.5",
  apiKeyEnv: "OPENWOLF_EMBED_API_KEY",
};

interface WolfCfg {
  openwolf?: { recall?: { embeddings?: Partial<EmbedConfig> } };
}

export function resolveEmbedConfig(wolfDir: string): EmbedConfig {
  const cfg = readJSON<WolfCfg>(path.join(wolfDir, "config.json"), {});
  const e = cfg.openwolf?.recall?.embeddings ?? {};
  return {
    enabled: e.enabled ?? false,
    baseUrl: (e.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    model: e.model || DEFAULTS.model,
    apiKeyEnv: e.apiKeyEnv || DEFAULTS.apiKeyEnv,
  };
}

/** Embed a batch of texts. Loopback endpoints run keyless; remote ones require the configured key. */
export async function embedTexts(cfg: EmbedConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const key = process.env[cfg.apiKeyEnv] ?? "";
  if (!key && !isLocalEndpoint(cfg.baseUrl)) {
    throw new Error(`${cfg.apiKeyEnv} is not set — a remote embeddings endpoint needs a key. Point openwolf.recall.embeddings.base_url at a local server (LM Studio http://localhost:1234/v1) to run keyless.`);
  }
  const res = await fetch(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`embeddings HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
  if (!data.data || data.data.length !== texts.length) {
    throw new Error(`embeddings response returned ${data.data?.length ?? 0} vectors for ${texts.length} inputs`);
  }
  // Preserve input order (OpenAI returns an `index` field).
  return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** Cosine similarity of two equal-length vectors. Returns 0 for a zero vector or a length mismatch. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
