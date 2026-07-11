import React, { useMemo, useState } from "react";
import type { WolfData } from "../../hooks/useWolfData.js";

interface Row { time: string; cmd: string; failed: boolean }

// activity.log lines are "HH:MM  <redacted command>[  → error]" (written by the post-bash hook).
function parseActivity(log: string): Row[] {
  return log
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const failed = / → error$/.test(line);
      const body = line.replace(/ → error$/, "");
      const m = body.match(/^(\d{1,2}:\d{2})\s+(.*)$/);
      return m ? { time: m[1], cmd: m[2], failed } : { time: "", cmd: body, failed };
    })
    .reverse(); // newest first
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-2xl font-bold mt-1" style={{ color: accent ? "var(--danger)" : "var(--text-primary)" }}>{value}</p>
    </div>
  );
}

export function ActivityLog({ data }: { data: WolfData }) {
  const [search, setSearch] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const rows = useMemo(() => parseActivity(data.activityLog || ""), [data.activityLog]);
  const errorCount = rows.filter((r) => r.failed).length;
  const filtered = rows.filter(
    (r) => (!onlyErrors || r.failed) && (!search || r.cmd.toLowerCase().includes(search.toLowerCase()))
  );

  if (rows.length === 0) {
    return (
      <div className="rounded-xl p-6" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <h3 className="font-medium mb-2" style={{ color: "var(--text-secondary)" }}>No shell activity captured</h3>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Passive Bash capture is <strong>opt-in</strong>. Enable it in <code className="px-1 rounded text-xs" style={{ background: "var(--bg-base)" }}>.wolf/config.json</code> —
          set <code className="px-1 rounded text-xs" style={{ background: "var(--bg-base)" }}>openwolf.capture.enabled = true</code> — and notable commands
          (commits, installs, tests, builds) plus any failures land in <code>.wolf/activity.log</code>, redacted, and feed the next session's resume digest.
        </p>
      </div>
    );
  }

  const td = { color: "var(--text-secondary)", padding: "0.5rem 0.75rem", borderTop: "1px solid var(--border)" };
  const th = { color: "var(--text-muted)", fontWeight: 500 as const, textAlign: "left" as const, padding: "0.5rem 0.75rem" };

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
        <StatCard label="Captured commands" value={String(rows.length)} />
        <StatCard label="Failures" value={String(errorCount)} accent={errorCount > 0} />
        <StatCard label="Showing" value={String(filtered.length)} />
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input
          type="text" placeholder="Filter commands…" value={search} onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px] focus:outline-none"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
        />
        <button
          onClick={() => setOnlyErrors((v) => !v)}
          className="px-3 py-2 text-xs rounded-lg transition-colors"
          style={{
            background: onlyErrors ? "var(--danger-subtle)" : "var(--bg-surface)",
            border: "1px solid var(--border)",
            color: onlyErrors ? "var(--danger)" : "var(--text-muted)",
          }}
        >{onlyErrors ? "Showing failures only" : "Failures only"}</button>
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <div className="overflow-x-auto" style={{ maxHeight: 520 }}>
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 64 }}>Time</th>
                <th style={th}>Command ({filtered.length})</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i} style={{ background: r.failed ? "var(--danger-subtle)" : "transparent" }}>
                  <td style={{ ...td, color: "var(--text-faint)", whiteSpace: "nowrap" }}>{r.time || "—"}</td>
                  <td style={{ ...td, color: r.failed ? "var(--danger)" : "var(--text-primary)" }} className="font-mono">
                    {r.cmd}{r.failed && <span className="text-xs ml-2" style={{ color: "var(--danger)" }}>error</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs mt-3" style={{ color: "var(--text-faint)" }}>
        Secrets are redacted before capture; the newest commands feed the resume digest. Read-only view of <code>.wolf/activity.log</code>.
      </p>
    </div>
  );
}
