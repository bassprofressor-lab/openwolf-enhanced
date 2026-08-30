import { useState, useEffect, useCallback } from "react";
import { WolfClient } from "../lib/wolf-client.js";
import { authedFetch } from "../lib/auth.js";
import { parseAnatomy, parseMemory, parseCerebrum } from "../lib/file-parsers.js";
import type { AnatomyEntry, MemorySession, CerebrumData } from "../lib/file-parsers.js";

interface TokenLedger {
  lifetime: {
    total_tokens_estimated: number;
    total_reads: number;
    total_writes: number;
    total_sessions: number;
    anatomy_hits: number;
    anatomy_misses: number;
    repeated_reads_blocked: number;
    estimated_savings_vs_bare_cli: number;
    /** What OpenWolf ITSELF injects (resume digest, reminders). Absent on ledgers before 1.21.0. */
    injection_tokens_estimated?: number;
  };
  sessions: any[];
  waste_flags: any[];
}

interface CronState {
  engine_status: string;
  last_heartbeat: string | null;
  execution_log: any[];
  dead_letter_queue: any[];
}

interface BugLog {
  bugs: any[];
}

interface CronManifest {
  tasks: any[];
}

interface DesignQCReport {
  captured_at: string | null;
  captures: any[];
  total_size_kb: number;
  estimated_tokens: number;
}

interface Health {
  status: string;
  uptime_seconds: number;
}

interface ProjectMeta {
  name: string;
  description: string;
  root: string;
}

export interface WolfData {
  anatomy: { entries: AnatomyEntry[]; metadata: { files: number; hits: number; misses: number } };
  cerebrum: CerebrumData;
  memory: MemorySession[];
  tokenLedger: TokenLedger;
  cronState: CronState;
  cronManifest: CronManifest;
  buglog: BugLog;
  activityLog: string;
  suggestions: any;
  designqcReport: DesignQCReport | null;
  health: Health;
  identity: { name: string; role: string };
  project: ProjectMeta;
  loading: boolean;
  connected: boolean;
  client: WolfClient | null;
  retry: () => void;
}

/**
 * Every .wolf/*.json the dashboard renders is written by an agent mid-session, and the panels index
 * straight into the arrays inside them (`buglog.bugs.filter`, `cronState.execution_log.filter`,
 * `tokenLedger.sessions.map`). JSON.parse was already guarded — what was not guarded is the SHAPE:
 * a file that parses fine but is `{}`, or `[]`, or was caught half-written, produced `undefined`
 * where an array was expected, and React unmounts the whole tree on a render throw. One truncated
 * write and the dashboard is a white page.
 *
 * So the shape is enforced once, here at ingest, instead of at every use site.
 */
function parseJson(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const asObject = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};

export function useWolfData(): WolfData {
  const [loading, setLoading] = useState(true);
  const [anatomy, setAnatomy] = useState<WolfData["anatomy"]>({ entries: [], metadata: { files: 0, hits: 0, misses: 0 } });
  const [cerebrum, setCerebrum] = useState<CerebrumData>({ preferences: [], learnings: [], doNotRepeat: [], decisions: [], lastUpdated: "" });
  const [memory, setMemory] = useState<MemorySession[]>([]);
  const [tokenLedger, setTokenLedger] = useState<TokenLedger>({ lifetime: { total_tokens_estimated: 0, total_reads: 0, total_writes: 0, total_sessions: 0, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_blocked: 0, estimated_savings_vs_bare_cli: 0, injection_tokens_estimated: 0 }, sessions: [], waste_flags: [] });
  const [cronState, setCronState] = useState<CronState>({ engine_status: "unknown", last_heartbeat: null, execution_log: [], dead_letter_queue: [] });
  const [cronManifest, setCronManifest] = useState<CronManifest>({ tasks: [] });
  const [buglog, setBuglog] = useState<BugLog>({ bugs: [] });
  const [activityLog, setActivityLog] = useState<string>("");
  const [suggestions, setSuggestions] = useState<any>(null);
  const [designqcReport, setDesignqcReport] = useState<DesignQCReport | null>(null);
  const [health, setHealth] = useState<Health>({ status: "unknown", uptime_seconds: 0 });
  const [identity, setIdentity] = useState({ name: "Wolf", role: "AI development assistant" });
  const [project, setProject] = useState<ProjectMeta>({ name: "", description: "", root: "" });
  const [client, setClient] = useState<WolfClient | null>(null);
  const [connected, setConnected] = useState(false);

  const processFiles = useCallback((files: Record<string, string>) => {
    if (files["anatomy.md"]) setAnatomy(parseAnatomy(files["anatomy.md"]));
    if (files["cerebrum.md"]) setCerebrum(parseCerebrum(files["cerebrum.md"]));
    if (files["memory.md"]) setMemory(parseMemory(files["memory.md"]));
    if (files["token-ledger.json"]) {
      const v = parseJson(files["token-ledger.json"]);
      if (v) setTokenLedger((prev) => ({
        ...prev, ...v,
        lifetime: { ...prev.lifetime, ...asObject(v.lifetime) },
        sessions: asArray(v.sessions),
        waste_flags: asArray(v.waste_flags),
      }));
    }
    if (files["cron-state.json"]) {
      const v = parseJson(files["cron-state.json"]);
      if (v) setCronState((prev) => ({
        ...prev, ...v,
        engine_status: typeof v.engine_status === "string" ? v.engine_status : prev.engine_status,
        execution_log: asArray(v.execution_log),
        dead_letter_queue: asArray(v.dead_letter_queue),
      }));
    }
    if (files["cron-manifest.json"]) {
      const v = parseJson(files["cron-manifest.json"]);
      if (v) setCronManifest({ ...v, tasks: asArray(v.tasks) });
    }
    if (files["buglog.json"]) {
      const v = parseJson(files["buglog.json"]);
      if (v) setBuglog({ ...v, bugs: asArray(v.bugs) });
    }
    if (typeof files["activity.log"] === "string") setActivityLog(files["activity.log"]);
    if (files["suggestions.json"]) {
      const v = parseJson(files["suggestions.json"]);
      if (v) setSuggestions(v);
    }
    if (files["designqc-report.json"]) {
      const v = parseJson(files["designqc-report.json"]);
      if (v) setDesignqcReport({
        captured_at: typeof v.captured_at === "string" ? v.captured_at : null,
        captures: asArray(v.captures),
        total_size_kb: Number(v.total_size_kb) || 0,
        estimated_tokens: Number(v.estimated_tokens) || 0,
      });
    }
    if (files["identity.md"]) {
      const nameMatch = files["identity.md"].match(/\*\*Name:\*\*\s*(.+)/);
      const roleMatch = files["identity.md"].match(/\*\*Role:\*\*\s*(.+)/);
      if (nameMatch || roleMatch) {
        setIdentity({
          name: nameMatch?.[1]?.trim() || "Wolf",
          role: roleMatch?.[1]?.trim() || "AI development assistant",
        });
      }
    }
  }, []);

  // REST snapshot fetch — also the "retry" action for the daemon-down banner.
  const refresh = useCallback(() => {
    authedFetch("/api/files")
      // A 401 (wrong or missing dashboard token) has a JSON body too — `{"error":"unauthorized"}`.
      // Without this check it was fed to processFiles as if it were the file map, which contains
      // no known keys, so nothing was set and the UI rendered its empty initial state: a dashboard
      // that looks like an idle project rather than one that says "not authorised".
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(files => {
        processFiles(files);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    authedFetch("/api/health")
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(h => setHealth({ status: String(h?.status ?? "unknown"), uptime_seconds: Number(h?.uptime_seconds) || 0 }))
      .catch(() => {});

    authedFetch("/api/project")
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(p => setProject({ name: String(p?.name ?? ""), description: String(p?.description ?? ""), root: String(p?.root ?? "") }))
      .catch(() => {});
  }, [processFiles]);

  const retry = useCallback(() => {
    setLoading(true);
    refresh();
    client?.connect();
  }, [refresh, client]);

  useEffect(() => {
    // Initial fetch
    refresh();

    // WebSocket
    const wsClient = new WolfClient();
    wsClient.onStatusChange(setConnected);
    wsClient.connect();
    setClient(wsClient);

    wsClient.onMessage((msg) => {
      if (msg.type === "file_changed") {
        processFiles({ [msg.file]: msg.content });
      }
      if (msg.type === "full_state" && msg.files) {
        processFiles(msg.files);
      }
      if (msg.type === "project_switched") {
        if (msg.project) setProject(msg.project);
        if (msg.files) processFiles(msg.files);
      }
      if (msg.type === "health") {
        setHealth({ status: msg.status, uptime_seconds: msg.uptime });
      }
    });

    return () => wsClient.disconnect();
  }, [refresh]);

  return { anatomy, cerebrum, memory, tokenLedger, cronState, cronManifest, buglog, activityLog, suggestions, designqcReport, health, identity, project, loading, connected, client, retry };
}
