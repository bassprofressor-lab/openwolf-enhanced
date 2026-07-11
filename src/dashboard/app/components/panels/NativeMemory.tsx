import React, { useEffect, useState } from "react";
import { authedFetch } from "../../lib/auth.js";
import { relativeTime } from "../../lib/utils.js";
import type { WolfData } from "../../hooks/useWolfData.js";

interface Health {
  topicFiles: number;
  indexLines: number;
  indexCutoffExceeded: boolean;
  indexedCount: number;
  orphanCount: number;
  deadLinks: string[];
  staleCount: number;
  footprintBytes: number;
}
interface FileRow {
  name: string;
  bytes: number;
  mtime: string;
  indexed: boolean;
}
interface Payload {
  available: boolean;
  health?: Health;
  files?: FileRow[];
}
interface AggregateRow {
  name: string;
  root: string;
  available: boolean;
  health: Health | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-2xl font-bold mt-1" style={{ color: accent ? "var(--accent)" : "var(--text-primary)" }}>{value}</p>
    </div>
  );
}

const STALE_MS = 90 * 24 * 60 * 60 * 1000;

// --- Scope switch: this project vs. all registered projects -----------------

type Scope = "project" | "all";

function ScopeToggle({ scope, setScope }: { scope: Scope; setScope: (s: Scope) => void }) {
  const opts: Array<{ id: Scope; label: string }> = [
    { id: "project", label: "This project" },
    { id: "all", label: "All projects" },
  ];
  return (
    <div className="inline-flex rounded-lg mb-4 p-0.5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => setScope(o.id)}
          className="text-sm px-3 py-1.5 rounded-md transition-colors"
          style={{
            background: scope === o.id ? "var(--accent)" : "transparent",
            color: scope === o.id ? "#fff" : "var(--text-muted)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NativeMemory({ data }: { data: WolfData }) {
  const [scope, setScope] = useState<Scope>("project");
  return (
    <div>
      <ScopeToggle scope={scope} setScope={setScope} />
      {scope === "project" ? <ProjectNativeMemory data={data} /> : <AllProjectsNativeMemory data={data} />}
    </div>
  );
}

// --- Single-project detail (browse + health) --------------------------------

function ProjectNativeMemory(_props: { data: WolfData }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<{ name: string; content: string } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authedFetch("/api/native-memory")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!cancelled) setPayload(j); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);

  const view = (name: string) => {
    setLoadingFile(true);
    setOpen({ name, content: "" });
    authedFetch(`/api/native-memory/file?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setOpen({ name, content: j.content ?? "" }))
      .catch(() => setOpen({ name, content: "(could not load file)" }))
      .finally(() => setLoadingFile(false));
  };

  if (error) return <p className="text-sm" style={{ color: "var(--danger)" }}>Could not load native memory: {error}</p>;
  if (!payload) return <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</p>;
  if (!payload.available) {
    return (
      <div className="rounded-xl p-6" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <h3 className="font-medium mb-2" style={{ color: "var(--text-secondary)" }}>No native memory found</h3>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          Claude Code's native Auto Memory isn't present for this project (expected at
          <code className="px-1 mx-1 rounded text-xs" style={{ background: "var(--bg-base)" }}>~/.claude/projects/&lt;project&gt;/memory/</code>).
          It appears once Auto Memory has written notes. OpenWolf falls back to its own <code>.wolf/</code> memory.
        </p>
      </div>
    );
  }

  const h = payload.health!;
  const now = Date.now();
  const files = (payload.files ?? []).filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase()));

  const td = { color: "var(--text-secondary)", padding: "0.5rem 0.75rem", borderTop: "1px solid var(--border)" };
  const th = { color: "var(--text-muted)", fontWeight: 500 as const, textAlign: "left" as const, padding: "0.5rem 0.75rem" };

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard label="Topic files" value={String(h.topicFiles)} />
        <StatCard label="In index" value={`${h.indexedCount}`} accent />
        <StatCard label="Not indexed" value={String(h.orphanCount)} />
        <StatCard label="Footprint" value={fmtBytes(h.footprintBytes)} />
      </div>

      {(h.indexCutoffExceeded || h.orphanCount > 0 || h.deadLinks.length > 0) && (
        <div className="rounded-xl px-4 py-3 mb-4 text-sm space-y-1"
          style={{ background: "var(--danger-subtle)", border: "1px solid rgba(220,38,38,0.3)", color: "var(--text-secondary)" }}>
          {h.indexCutoffExceeded && (
            <div>⚠ <strong>MEMORY.md is {h.indexLines} lines</strong> — only the first 200 load at session start; the rest is invisible until trimmed.</div>
          )}
          {h.orphanCount > 0 && (
            <div>⚠ <strong>{h.orphanCount} topic files aren't in the index</strong> → they never surface on resume. They're still searchable via <code>openwolf recall</code> and below.</div>
          )}
          {h.deadLinks.length > 0 && (
            <div>⚠ <strong>{h.deadLinks.length} dead index link(s)</strong>: {h.deadLinks.slice(0, 5).join(", ")}{h.deadLinks.length > 5 ? "…" : ""}</div>
          )}
        </div>
      )}

      <input
        type="text" placeholder="Filter topic files…" value={search} onChange={(e) => setSearch(e.target.value)}
        className="w-full mb-3 rounded-lg px-3 py-2 text-sm focus:outline-none"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
      />

      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <div className="overflow-x-auto" style={{ maxHeight: 460 }}>
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Topic file ({files.length})</th>
                <th style={th}>Index</th>
                <th style={{ ...th, textAlign: "right" }}>Size</th>
                <th style={th}>Modified</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const stale = now - new Date(f.mtime).getTime() > STALE_MS;
                return (
                  <tr key={f.name} style={{ cursor: "pointer" }} onClick={() => view(f.name)}>
                    <td style={{ ...td, color: "var(--text-primary)" }} className="font-mono">{f.name}</td>
                    <td style={td}>
                      {f.indexed
                        ? <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}>indexed</span>
                        : <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--bg-base)", color: "var(--text-faint)" }}>orphan</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{fmtBytes(f.bytes)}</td>
                    <td style={{ ...td, color: stale ? "var(--text-faint)" : "var(--text-muted)" }}>{relativeTime(f.mtime)}{stale ? " · stale" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setOpen(null)}>
          <div className="rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>{open.name}</span>
              <button onClick={() => setOpen(null)} className="text-sm px-2 py-1 rounded" style={{ color: "var(--text-muted)" }}>✕</button>
            </div>
            <pre className="text-xs px-4 py-3 overflow-auto whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
              {loadingFile ? "Loading…" : open.content}
            </pre>
          </div>
        </div>
      )}

      <p className="text-xs mt-3" style={{ color: "var(--text-faint)" }}>
        Read-only view of Claude Code's native Auto Memory. OpenWolf never writes here — Claude's own Auto Dream owns consolidation.
      </p>
    </div>
  );
}

// --- Cross-project rollup ----------------------------------------------------

function AllProjectsNativeMemory({ data }: { data: WolfData }) {
  const [rows, setRows] = useState<AggregateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentRoot = data.project.root;

  useEffect(() => {
    let cancelled = false;
    authedFetch("/api/native-memory/aggregate")
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

  if (error) return <p className="text-sm" style={{ color: "var(--danger)" }}>Could not load projects: {error}</p>;
  if (!rows) return <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading projects…</p>;

  const withMemory = rows.filter((r) => r.available && r.health);
  // Projects that have native memory first, most topic files first; the rest (no memory) trail.
  const sorted = [...rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (b.health?.topicFiles ?? 0) - (a.health?.topicFiles ?? 0);
  });
  const totals = withMemory.reduce(
    (acc, r) => ({
      topics: acc.topics + (r.health!.topicFiles),
      orphans: acc.orphans + (r.health!.orphanCount),
      footprint: acc.footprint + (r.health!.footprintBytes),
    }),
    { topics: 0, orphans: 0, footprint: 0 }
  );

  const th = { color: "var(--text-muted)", fontWeight: 500 as const, textAlign: "left" as const, padding: "0.5rem 0.75rem" };
  const td = { color: "var(--text-secondary)", padding: "0.5rem 0.75rem", borderTop: "1px solid var(--border)" };

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="With native memory" value={`${withMemory.length}/${rows.length}`} />
        <StatCard label="Total topic files" value={String(totals.topics)} accent />
        <StatCard label="Total orphaned" value={String(totals.orphans)} />
        <StatCard label="Total footprint" value={fmtBytes(totals.footprint)} />
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Project</th>
                <th style={{ ...th, textAlign: "right" }}>Topic files</th>
                <th style={{ ...th, textAlign: "right" }}>Indexed</th>
                <th style={{ ...th, textAlign: "right" }}>Orphaned</th>
                <th style={th}>MEMORY.md</th>
                <th style={{ ...th, textAlign: "right" }}>Footprint</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const isCurrent = currentRoot && r.root === currentRoot;
                const h = r.health;
                return (
                  <tr key={r.root} style={{ background: isCurrent ? "var(--bg-surface-hover)" : "transparent" }}>
                    <td style={td}>
                      <div className="flex items-center gap-2">
                        <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{r.name}</span>
                        {isCurrent && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--accent)", color: "#fff" }}>current</span>}
                        {!r.available && <span className="text-xs" style={{ color: "var(--text-faint)" }}>no native memory</span>}
                      </div>
                      <div className="text-xs truncate" style={{ color: "var(--text-faint)", maxWidth: 320 }} title={r.root}>{r.root}</div>
                    </td>
                    <td style={{ ...td, textAlign: "right", color: h ? "var(--text-primary)" : "var(--text-faint)" }}>{h ? h.topicFiles : "—"}</td>
                    <td style={{ ...td, textAlign: "right", color: "var(--accent)" }}>{h ? h.indexedCount : "—"}</td>
                    <td style={{ ...td, textAlign: "right", color: h && h.orphanCount > 0 ? "var(--text-primary)" : "var(--text-faint)" }}>{h ? h.orphanCount : "—"}</td>
                    <td style={td}>
                      {h ? (
                        h.indexCutoffExceeded
                          ? <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--danger-subtle)", color: "var(--danger)" }} title="Only the first 200 lines load at session start">{h.indexLines} lines · over cutoff</span>
                          : <span className="text-xs" style={{ color: "var(--text-muted)" }}>{h.indexLines} lines</span>
                      ) : <span className="text-xs" style={{ color: "var(--text-faint)" }}>—</span>}
                      {h && h.deadLinks.length > 0 && (
                        <span className="text-xs ml-2" style={{ color: "var(--danger)" }} title={h.deadLinks.slice(0, 8).join(", ")}>{h.deadLinks.length} dead</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "var(--text-muted)" }}>{h ? fmtBytes(h.footprintBytes) : "—"}</td>
                    <td style={td}>
                      {!isCurrent && r.available && (
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
        Native Auto Memory health across all registered OpenWolf projects. "Open" switches the daemon to that project — then "This project" browses its files. Read-only.
      </p>
    </div>
  );
}
