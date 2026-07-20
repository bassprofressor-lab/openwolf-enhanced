import * as path from "node:path";
import { readJSON, writeJSON } from "../utils/fs-safe.js";

interface BugEntry {
  id: string;
  timestamp: string;
  error_message: string;
  file: string;
  line?: number;
  root_cause: string;
  fix: string;
  tags: string[];
  related_bugs: string[];
  occurrences: number;
  last_seen: string;
}

interface BugLog {
  version: number;
  bugs: BugEntry[];
}

export function getBugLogPath(wolfDir: string): string {
  return path.join(wolfDir, "buglog.json");
}

export function readBugLog(wolfDir: string): BugLog {
  return readJSON<BugLog>(getBugLogPath(wolfDir), { version: 1, bugs: [] });
}

export function logBug(
  wolfDir: string,
  bug: {
    error_message: string;
    file: string;
    line?: number;
    root_cause: string;
    fix: string;
    tags: string[];
  }
): void {
  const bugLog = readBugLog(wolfDir);
  const now = new Date().toISOString();

  // Check for near-duplicate (score > 0.8)
  const similar = findSimilarBugs(wolfDir, bug.error_message);
  if (similar.length > 0 && similar[0].score > 0.8) {
    const existing = bugLog.bugs.find((b) => b.id === similar[0].bug.id);
    if (existing) {
      existing.occurrences++;
      existing.last_seen = now;
      writeJSON(getBugLogPath(wolfDir), bugLog);
      return;
    }
  }

  // Derive the id from the highest existing numeric id, not from bugs.length — entries get
  // removed by dedupe and by the retention trim in post-write.ts, after which length + 1
  // hands out an id that is already taken.
  const maxId = bugLog.bugs.reduce((m, b) => {
    const n = parseInt(String(b.id).replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const id = `bug-${String(maxId + 1).padStart(3, "0")}`;
  bugLog.bugs.push({
    id,
    timestamp: now,
    error_message: bug.error_message,
    file: bug.file,
    line: bug.line,
    root_cause: bug.root_cause,
    fix: bug.fix,
    tags: bug.tags,
    related_bugs: [],
    occurrences: 1,
    last_seen: now,
  });

  writeJSON(getBugLogPath(wolfDir), bugLog);
}

function normalize(text: string | undefined | null): string {
  // Tolerate entries missing fields (legacy / auto-detected / schema drift) — upstream #44.
  return String(text ?? "").toLowerCase().replace(/\d+/g, "N").replace(/[^\w\s]/g, " ").trim();
}

function tokenize(text: string): Set<string> {
  return new Set(normalize(text).split(/\s+/).filter((w) => w.length > 2));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

interface ScoredBug {
  bug: BugEntry;
  score: number;
}

export function findSimilarBugs(wolfDir: string, errorMessage: string): ScoredBug[] {
  const bugLog = readBugLog(wolfDir);
  const normalizedInput = normalize(errorMessage);
  const inputTokens = tokenize(errorMessage);
  const results: ScoredBug[] = [];

  for (const bug of bugLog.bugs) {
    let score = 0;

    // Exact substring match
    if (
      normalize(bug.error_message).includes(normalizedInput) ||
      normalizedInput.includes(normalize(bug.error_message))
    ) {
      score += 1.0;
    }

    // Word overlap (jaccard)
    const bugTokens = tokenize(bug.error_message);
    score += jaccardSimilarity(inputTokens, bugTokens) * 0.5;

    if (score > 0.3) {
      results.push({ bug, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function searchBugs(wolfDir: string, term: string): BugEntry[] {
  const bugLog = readBugLog(wolfDir);
  const lower = term.toLowerCase();
  // Null-safe across schema drift: any entry may miss a field, `tags` may be absent,
  // and some tooling records `files: string[]` instead of a singular `file` (upstream #44).
  const has = (v: unknown): boolean =>
    typeof v === "string" && v.toLowerCase().includes(lower);
  return bugLog.bugs.filter((b) => {
    const bug = b as BugEntry & { files?: unknown };
    const files = Array.isArray(bug.files) ? bug.files : bug.file != null ? [bug.file] : [];
    return (
      has(bug.error_message) ||
      has(bug.root_cause) ||
      has(bug.fix) ||
      (Array.isArray(bug.tags) && bug.tags.some((t) => has(t))) ||
      files.some((f) => has(f))
    );
  });
}
