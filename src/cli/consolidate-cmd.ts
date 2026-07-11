import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { findDuplicateEntries } from "../utils/maintenance.js";
import { blocksFor } from "../utils/recall.js";
import { resolveLlmConfig, callLlm } from "../daemon/llm-provider.js";

interface Merge { aStart: number; aEnd: number; bStart: number; bEnd: number; mergedText: string }

// Rewrite `content`: for each merge, replace block A's lines with the merged entry and delete block
// B's lines. Pure + bottom-up so line indices don't shift. (1-based start/end from blocksFor.)
export function applyConsolidations(content: string, merges: Merge[]): string {
  const lines = content.split(/\r?\n/);
  const ops: Array<{ start: number; end: number; repl: string[] }> = [];
  for (const m of merges) {
    ops.push({ start: m.aStart, end: m.aEnd, repl: m.mergedText.split("\n") });
    ops.push({ start: m.bStart, end: m.bEnd, repl: [] }); // delete the duplicate
  }
  ops.sort((x, y) => y.start - x.start); // bottom-up
  for (const op of ops) lines.splice(op.start - 1, op.end - op.start + 1, ...op.repl);
  return lines.join("\n");
}

const MERGE_PROMPT = (a: string, b: string) =>
  `You are consolidating a software project's knowledge base (cerebrum.md). Merge these TWO near-duplicate entries into ONE. ` +
  `Preserve every unique fact and detail; remove only redundancy. Keep the exact markdown shape of the originals (a single "- " bullet, ` +
  `keeping any leading **[date]**/label). Output ONLY the merged entry text — no preamble, no code fences, no explanation.\n\n` +
  `Entry A:\n${a}\n\nEntry B:\n${b}`;

interface ConsolidateOpts { dryRun?: boolean; threshold?: string; max?: string }

export async function consolidateCommand(opts: ConsolidateOpts): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");
  const cerebrumPath = path.join(wolfDir, "cerebrum.md");
  if (!fs.existsSync(cerebrumPath)) { console.log("No cerebrum.md — nothing to consolidate."); return; }

  const threshold = Math.min(0.95, Math.max(0.3, parseFloat(opts.threshold || "0.5") || 0.5));
  const maxPairs = Math.max(1, parseInt(opts.max || "8", 10) || 8);
  const pairs = findDuplicateEntries(wolfDir, { sources: ["cerebrum.md"], threshold, limit: maxPairs });
  if (pairs.length === 0) {
    console.log(`cerebrum.md: no near-duplicate entries (threshold ${threshold}). Nothing to consolidate.`);
    return;
  }

  const content = fs.readFileSync(cerebrumPath, "utf-8");
  const blocks = blocksFor("cerebrum.md", content);
  const byStart = new Map(blocks.map((b) => [b.start, b]));

  console.log(`OpenWolf Consolidate — ${pairs.length} near-duplicate pair(s) in cerebrum.md (threshold ${threshold})\n`);

  // Resolve the LLM once (consolidation needs it). Clear guidance if unconfigured.
  const llm = resolveLlmConfig(wolfDir);
  const apiKey = process.env[llm.apiKeyEnv];
  if (!apiKey) {
    console.error(`${llm.apiKeyEnv} is not set — consolidation needs an LLM. Set it, or point openwolf.cron.llm_* at a provider (e.g. a free OpenAI-compatible one). Provider: ${llm.provider}/${llm.model}.`);
    process.exitCode = 1;
    return;
  }

  const merges: Merge[] = [];
  const consumed = new Set<number>();
  for (const p of pairs) {
    if (consumed.has(p.aLine) || consumed.has(p.bLine)) continue; // no overlapping edits
    const a = byStart.get(p.aLine), b = byStart.get(p.bLine);
    if (!a || !b) continue;
    process.stdout.write(`  ${Math.round(p.similarity * 100)}%  lines ${p.aLine} ↔ ${p.bLine} … `);
    let merged = "";
    try {
      merged = (await callLlm(llm, apiKey, MERGE_PROMPT(a.text, b.text), { maxTokens: 900, timeoutMs: 60000 })).trim();
      merged = merged.replace(/^```[\w]*\n?|\n?```$/g, "").trim(); // strip stray fences
    } catch (e) {
      console.log(`skipped (LLM error: ${(e as Error).message.slice(0, 60)})`);
      continue;
    }
    if (merged.length < 10 || merged.length > a.text.length + b.text.length + 200) {
      console.log("skipped (implausible merge output)");
      continue;
    }
    consumed.add(p.aLine); consumed.add(p.bLine);
    merges.push({ aStart: a.start, aEnd: a.end, bStart: b.start, bEnd: b.end, mergedText: merged });
    console.log("merged");
    if (opts.dryRun) {
      console.log(`     └─ ${merged.replace(/\s+/g, " ").slice(0, 140)}${merged.length > 140 ? "…" : ""}`);
    }
  }

  if (merges.length === 0) { console.log("\nNothing applied."); return; }
  if (opts.dryRun) {
    console.log(`\n(dry run) ${merges.length} pair(s) would be merged. Run without --dry-run to apply.`);
    return;
  }

  // Back up, then rewrite.
  try { fs.copyFileSync(cerebrumPath, cerebrumPath + ".bak-pre-consolidate"); } catch { /* best-effort */ }
  fs.writeFileSync(cerebrumPath, applyConsolidations(content, merges), "utf-8");
  console.log(`\nDone. Merged ${merges.length} pair(s) → cerebrum.md (backup: cerebrum.md.bak-pre-consolidate). Review the diff.`);
}
