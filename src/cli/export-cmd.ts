import * as fs from "node:fs";
import * as path from "node:path";
import { getWolfDir, readJSON, readBugLog } from "../hooks/shared.js";

// Flatten an array of records to CSV. Columns are the union of keys across rows (first-seen
// order), values are stringified; anything containing a comma/quote/newline is quoted with
// doubled inner quotes (RFC 4180). Arrays are joined with "; ".
export function toCSV(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s = Array.isArray(v) ? v.join("; ") : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

// Turn a .wolf data source into flat rows ready for CSV/JSON export.
export function collectRows(wolfDir: string, what: string): Array<Record<string, unknown>> {
  if (what === "sessions" || what === "ledger") {
    const led = readJSON<{ sessions?: Array<Record<string, unknown>> }>(
      path.join(wolfDir, "token-ledger.json"),
      {}
    );
    return (led.sessions ?? []).map((s) => {
      const totals = (s.totals as Record<string, unknown>) ?? {};
      return { id: s.id, started: s.started, ended: s.ended, ...totals };
    });
  }
  if (what === "bugs" || what === "buglog") {
    const bl = readBugLog(wolfDir) as { bugs: Array<Record<string, unknown>> };
    return (bl.bugs ?? []).map((b) => ({
      id: b.id,
      timestamp: b.timestamp,
      file: b.file,
      error_message: b.error_message,
      root_cause: b.root_cause,
      fix: b.fix,
      tags: Array.isArray(b.tags) ? (b.tags as unknown[]).join("; ") : b.tags,
      occurrences: b.occurrences,
      last_seen: b.last_seen,
    }));
  }
  throw new Error(`unknown export target "${what}" (use: sessions | bugs)`);
}

export function exportCommand(what: string, opts: { format?: string; out?: string }): void {
  const wolfDir = getWolfDir();
  if (!fs.existsSync(wolfDir)) {
    console.error("No .wolf/ in this project. Run `openwolf init` first.");
    process.exitCode = 1;
    return;
  }
  const fmt = (opts.format ?? "json").toLowerCase();
  if (fmt !== "csv" && fmt !== "json") {
    console.error(`Unknown format "${fmt}" (use: csv | json)`);
    process.exitCode = 1;
    return;
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = collectRows(wolfDir, what);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  const output = fmt === "csv" ? toCSV(rows) : JSON.stringify(rows, null, 2);
  if (opts.out) {
    fs.writeFileSync(opts.out, output.endsWith("\n") ? output : output + "\n");
    console.error(`Wrote ${rows.length} ${what} row(s) to ${opts.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}
