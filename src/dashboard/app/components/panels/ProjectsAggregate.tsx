import React, { useEffect, useState } from "react";
import { authedFetch } from "../../lib/auth.js";
import { relativeTime, formatTokens } from "../../lib/utils.js";
import type { WolfData } from "../../hooks/useWolfData.js";

interface ProjectRow {
  name: string;
  root: string;
  exists: boolean;
  total_sessions: number;
  total_tokens_estimated: number;
  estimated_savings: number;
  open_bugs: number;
  last_activity: string | null;
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-2xl font-bold mt-1" style={{ color: accent ? "var(--accent)" : "var(--text-primary)" }}>{value}</p>
    </div>
  );
}

export function ProjectsAggregate({ data }: { data: WolfData }) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentRoot = data.project.root;

  useEffect(() => {
    let cancelled = false;
    authedFetch("/api/aggregate")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!cancelled) setRows(j.projects || []); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);

  const switchTo = (root: string) => {
    authedFetch("/api/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    }).then((r) => { if (r.ok) location.reload(); });
  };

  if (error) {
    return <p className="text-sm" style={{ color: "var(--danger)" }}>Could not load projects: {error}</p>;
  }
  if (!rows) {
    return <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading projects…</p>;
  }

  const sorted = [...rows].sort((a, b) => (b.last_activity || "").localeCompare(a.last_activity || ""));
  const totals = rows.reduce(
    (acc, r) => ({
      sessions: acc.sessions + r.total_sessions,
      saved: acc.saved + r.estimated_savings,
      bugs: acc.bugs + r.open_bugs,
    }),
    { sessions: 0, saved: 0, bugs: 0 }
  );

  const th = { color: "var(--text-muted)", fontWeight: 500 as const, textAlign: "left" as const, padding: "0.5rem 0.75rem" };
  const td = { color: "var(--text-secondary)", padding: "0.5rem 0.75rem", borderTop: "1px solid var(--border)" };

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Projects" value={String(rows.length)} />
        <StatCard label="Total Sessions" value={String(totals.sessions)} />
        <StatCard label="Tokens Saved" value={`~${formatTokens(totals.saved)}`} accent />
        <StatCard label="Open Bugs" value={String(totals.bugs)} />
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Project</th>
                <th style={{ ...th, textAlign: "right" }}>Sessions</th>
                <th style={{ ...th, textAlign: "right" }}>Tokens</th>
                <th style={{ ...th, textAlign: "right" }}>Saved</th>
                <th style={{ ...th, textAlign: "right" }}>Bugs</th>
                <th style={th}>Last activity</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const isCurrent = currentRoot && r.root === currentRoot;
                return (
                  <tr key={r.root} style={{ background: isCurrent ? "var(--bg-surface-hover)" : "transparent" }}>
                    <td style={td}>
                      <div className="flex items-center gap-2">
                        <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{r.name}</span>
                        {isCurrent && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "#fff" }}>current</span>}
                        {!r.exists && <span className="text-xs" style={{ color: "var(--danger)" }}>missing</span>}
                      </div>
                      <div className="text-xs truncate" style={{ color: "var(--text-faint)", maxWidth: 320 }} title={r.root}>{r.root}</div>
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{r.total_sessions}</td>
                    <td style={{ ...td, textAlign: "right" }}>{formatTokens(r.total_tokens_estimated)}</td>
                    <td style={{ ...td, textAlign: "right", color: "var(--accent)" }}>~{formatTokens(r.estimated_savings)}</td>
                    <td style={{ ...td, textAlign: "right", color: r.open_bugs > 0 ? "var(--text-primary)" : "var(--text-faint)" }}>{r.open_bugs}</td>
                    <td style={{ ...td, color: "var(--text-muted)" }}>{r.last_activity ? relativeTime(r.last_activity) : "—"}</td>
                    <td style={td}>
                      {!isCurrent && r.exists && (
                        <button
                          onClick={() => switchTo(r.root)}
                          className="text-xs px-2 py-1 rounded-md transition-colors"
                          style={{ background: "var(--bg-base)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                        >
                          Open
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs mt-3" style={{ color: "var(--text-faint)" }}>
        Aggregated across all registered OpenWolf projects. "Open" switches the daemon to that project.
      </p>
    </div>
  );
}
