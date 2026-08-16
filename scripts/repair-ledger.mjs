#!/usr/bin/env node
/**
 * Repariert einen token-ledger.json, der von bug-210 aufgeblaeht wurde.
 *
 * Der Stop-Hook feuerte pro Turn und addierte jedes Mal die KUMULIERTEN Session-Werte in
 * `lifetime`. Ueber N Turns wurde damit 1+2+3+…+N gebucht statt N, und `sessions[]` bekam pro Turn
 * einen weiteren Eintrag unter derselben id. Der Hook ist gefixt; diese Datei raeumt auf, was er
 * hinterlassen hat.
 *
 * Was das Skript tut:
 *   1. `sessions[]` nach id dedupliziert — es bleibt der LETZTE Eintrag je Session, denn der traegt
 *      den vollstaendigen kumulativen Stand.
 *   2. Die betroffenen `lifetime`-Zaehler auf 0 gesetzt und mit `counting_since` datiert.
 *   3. Die alten Werte unter `lifetime_before_repair` aufgehoben und eine Notiz hinterlegt.
 *
 * WARUM NULLSETZEN UND NICHT NEU BERECHNEN: `sessions[]` ist auf
 * `retention.token_ledger_max_sessions` (Standard 200) gekappt. Im echten Fall deckten die
 * erhaltenen Eintraege 13 von 142 Sessions ab — eine Neuberechnung daraus ergab `total_reads = 3`
 * neben `total_sessions = 142`. Das ist zwar belegbar, liest sich aber wie ein Defekt und laedt zur
 * Fehlinterpretation ein. Ein Zaehler, der seit einem BEKANNTEN Datum zaehlt, ist interpretierbar;
 * eine Untergrenze aus 9 % der Historie ist es nicht. Der alte Wert bleibt in der Datei stehen,
 * damit nichts verschwindet.
 *
 *   node scripts/repair-ledger.mjs <pfad/zu/token-ledger.json>            # nur rechnen
 *   node scripts/repair-ledger.mjs <pfad/zu/token-ledger.json> --apply    # schreiben (mit Backup)
 */
import * as fs from "node:fs";
import * as path from "node:path";

const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) {
  console.error("Pfad zur token-ledger.json fehlt.");
  process.exit(2);
}

const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
const sessions = Array.isArray(ledger.sessions) ? ledger.sessions : [];

// Letzter Eintrag je id gewinnt: er hat den hoechsten kumulativen Stand.
const byId = new Map();
for (const s of sessions) byId.set(s?.id ?? "(ohne id)", s);
const unique = [...byId.values()];

const t = (s) => s?.totals ?? {};
const sum = (pick) => unique.reduce((acc, s) => acc + (Number(pick(s)) || 0), 0);

// Zur Einordnung ausgewiesen, NICHT geschrieben: was die erhaltenen Eintraege noch hergeben.
const floor = {
  total_reads: sum((s) => t(s).reads_count),
  total_writes: sum((s) => t(s).writes_count) + sum((s) => t(s).unnamed_writes),
  total_tokens_estimated: sum((s) => t(s).input_tokens_estimated) + sum((s) => t(s).output_tokens_estimated),
};

// Die von bug-210 aufgeblaehten Zaehler. total_sessions steht im session-start-Hook und war nie
// betroffen — der bleibt.
const CORRUPTED = [
  "total_reads", "total_writes", "total_tokens_estimated", "anatomy_hits", "anatomy_misses",
  "repeated_reads_blocked", "estimated_savings_vs_bare_cli", "real_input_tokens", "real_output_tokens",
  "real_cache_read_tokens", "real_cache_creation_tokens", "real_api_calls",
];
const today = new Date().toISOString().slice(0, 10);
const recomputed = { ...ledger.lifetime };
for (const k of CORRUPTED) if (k in recomputed) recomputed[k] = 0;
recomputed.counting_since = today;

const before = ledger.lifetime ?? {};
console.log(`Datei: ${file}`);
console.log(`sessions[]: ${sessions.length} Eintraege → ${unique.length} eindeutige Sessions`);
console.log("");
console.log("Kennzahl                        vorher            nachher");
for (const k of [...CORRUPTED, "total_sessions"]) {
  if (!(k in before) && !(k in recomputed)) continue;
  console.log(`${k.padEnd(30)} ${String(before[k] ?? 0).padStart(14)} → ${String(recomputed[k] ?? 0).padStart(14)}`);
}
console.log("");
console.log(`Zur Einordnung — aus den ${unique.length} erhaltenen Sessions liessen sich noch belegen:`);
console.log(`  total_reads ${floor.total_reads} · total_writes ${floor.total_writes} · tokens ${floor.total_tokens_estimated}`);
console.log("  (nicht geschrieben: deckt nur die nicht weggekappten Sessions ab und laese sich wie ein Defekt)");
console.log("");
console.log("total_sessions bleibt unveraendert — der Zaehler steht im session-start-Hook und war nie betroffen.");

if (!apply) {
  console.log("\nNur gerechnet, nichts geschrieben. Mit --apply schreiben.");
  process.exit(0);
}

const backup = `${file}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
fs.copyFileSync(file, backup);

ledger.sessions = unique;
ledger.lifetime_before_repair = before;
ledger.lifetime = recomputed;
ledger.lifetime_note =
  `Zaehler am ${today} auf 0 gesetzt und ab diesem Datum neu gezaehlt (siehe counting_since). Grund: ` +
  "bug-210 — der Stop-Hook feuert pro Turn und buchte jedes Mal die KUMULIERTEN Session-Werte erneut, " +
  "ueber N Turns also 1+2+3+…+N statt N. Der Altbestand ist nicht rekonstruierbar, weil sessions[] " +
  "durch die Retention gekappt ist. Die alten, aufgeblaehten Werte stehen unter lifetime_before_repair. " +
  "total_sessions war nie betroffen (session-start-Hook) und blieb unveraendert.";

fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + "\n");
console.log(`\nGeschrieben. Backup: ${path.basename(backup)}`);
