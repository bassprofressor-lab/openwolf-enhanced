import * as path from "node:path";
import { readJSON, writeJSON } from "../utils/fs-safe.js";

interface ReadEntry {
  file: string;
  tokens_estimated: number;
  /** How often this file was read in the session. Absent on entries written before 1.20.0. */
  read_count?: number;
  was_repeated: boolean;
  anatomy_had_description: boolean;
}

interface WriteEntry {
  file: string;
  tokens_estimated: number;
  action: string;
}

interface SessionTotals {
  input_tokens_estimated: number;
  output_tokens_estimated: number;
  reads_count: number;
  writes_count: number;
  repeated_reads_blocked: number;
  anatomy_lookups: number;
}

interface SessionEntry {
  id: string;
  started: string;
  ended: string;
  reads: ReadEntry[];
  writes: WriteEntry[];
  totals: SessionTotals;
}

interface Lifetime {
  total_tokens_estimated: number;
  total_reads: number;
  total_writes: number;
  total_sessions: number;
  anatomy_hits: number;
  anatomy_misses: number;
  repeated_reads_blocked: number;
  estimated_savings_vs_bare_cli: number;
}

interface TokenLedger {
  version: number;
  created_at: string;
  lifetime: Lifetime;
  sessions: SessionEntry[];
  daemon_usage: unknown[];
  waste_flags: unknown[];
  optimization_report: {
    last_generated: string | null;
    patterns: unknown[];
  };
}

export function getLedgerPath(wolfDir: string): string {
  return path.join(wolfDir, "token-ledger.json");
}

export function readLedger(wolfDir: string): TokenLedger {
  return readJSON<TokenLedger>(getLedgerPath(wolfDir), {
    version: 1,
    created_at: new Date().toISOString(),
    lifetime: {
      total_tokens_estimated: 0,
      total_reads: 0,
      total_writes: 0,
      total_sessions: 0,
      anatomy_hits: 0,
      anatomy_misses: 0,
      repeated_reads_blocked: 0,
      estimated_savings_vs_bare_cli: 0,
    },
    sessions: [],
    daemon_usage: [],
    waste_flags: [],
    optimization_report: { last_generated: null, patterns: [] },
  });
}

// NOTE: writeLedger/incrementSessions/addSessionToLedger were removed — they had ZERO callers
// and silently diverged from the real writer in hooks/stop.ts (no lock, hardcoded caps instead of
// config retention, missing anatomy_misses/real_usage). Anyone reaching for them would have
// corrupted the very stats stop.ts maintains. The stop hook is the single ledger writer.
