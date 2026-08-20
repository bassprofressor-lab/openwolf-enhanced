import React, { useEffect, useMemo, useRef, useState } from "react";
import { authedFetch } from "../../lib/auth.js";

// [2026-08-20] The knowledge base was a bag of notes: one nobody links to and one everybody
// links to looked exactly alike, and "who leans on this decision?" had no answer at all.
//
// Two things are shown here, and only two, because they are the ones that change a decision:
// which notes carry the structure (inbound links), and which references point at nothing.
// The graph is at FILE level — the block-level graph is ~16k nodes and answers nothing a human
// asked. The server reduces it before it ships.

interface GraphNode { key: string; title: string; src: string; in: number; out: number }
interface GraphEdge { from: string; to: string }
interface Dangling { from: string; fromSrc: string; target: string; kind: string }
interface GraphData {
  available: boolean;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  dangling?: Dangling[];
  stats?: { blocks: number; files: number; edgesTotal: number };
  error?: string;
}

/**
 * Force layout, deterministic on purpose: the same knowledge base must draw the same picture
 * twice, otherwise you cannot tell a changed graph from a re-rolled one. Seeded start positions,
 * fixed iteration count, no animation loop.
 */
function layout(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number) {
  const idx = new Map(nodes.map((n, i) => [n.key, i]));
  const n = nodes.length;
  const x = new Float64Array(n), y = new Float64Array(n);
  // Seeded ring start — spreads the graph and keeps runs comparable.
  for (let i = 0; i < n; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);      // golden angle
    const r = Math.sqrt((i + 0.5) / n) * Math.min(w, h) * 0.42;
    x[i] = w / 2 + Math.cos(a) * r;
    y[i] = h / 2 + Math.sin(a) * r;
  }
  const links = edges
    .map((e) => [idx.get(e.from), idx.get(e.to)] as [number | undefined, number | undefined])
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined);

  const ITER = 220;
  for (let step = 0; step < ITER; step++) {
    const cool = 1 - step / ITER;
    // Repulsion, approximated on a grid instead of all-pairs: at a few hundred nodes the exact
    // version is fine, but this keeps it honest if a knowledge base grows.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i] - x[j], dy = y[i] - y[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = (i - j) || 1; dy = 1; }
        if (d2 > 90000) continue;                   // far apart: ignore
        const f = (420 / d2) * cool;
        const d = Math.sqrt(d2);
        x[i] += (dx / d) * f; y[i] += (dy / d) * f;
        x[j] -= (dx / d) * f; y[j] -= (dy / d) * f;
      }
    }
    for (const [a, b] of links) {
      const dx = x[b] - x[a], dy = y[b] - y[a];
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = ((d - 72) * 0.02) * cool;
      x[a] += (dx / d) * f; y[a] += (dy / d) * f;
      x[b] -= (dx / d) * f; y[b] -= (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      x[i] = Math.max(14, Math.min(w - 14, x[i]));
      y[i] = Math.max(14, Math.min(h - 14, y[i]));
    }
  }
  return { x, y, idx };
}

export function LinkGraph() {
  const [data, setData] = useState<GraphData | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    authedFetch("/api/link-graph")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ available: false, error: "not reachable" }));
  }, []);

  // [2026-08-20] Drawing every connected note produced a hairball: 324 dots and 711 lines in one
  // canvas, labels on top of each other, no structure visible. A graph that shows everything shows
  // nothing. So: the load-bearing core only — the 90 best-connected notes — and the rest is
  // counted in the caption. The number stays honest, the picture becomes readable.
  const CORE = 90;
  const linked = useMemo(() => (data?.nodes ?? []).filter((n) => n.in + n.out > 0), [data]);
  const connected = useMemo(
    () => [...linked].sort((a, b) => (b.in + b.out) - (a.in + a.out)).slice(0, CORE),
    [linked]
  );
  const shownKeys = useMemo(() => new Set(connected.map((n) => n.key)), [connected]);
  const shownEdges = useMemo(
    () => (data?.edges ?? []).filter((e) => shownKeys.has(e.from) && shownKeys.has(e.to)),
    [data, shownKeys]
  );
  const isolated = (data?.nodes?.length ?? 0) - linked.length;

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data?.available || connected.length === 0) return;
    const W = cv.width, H = cv.height;
    const { x, y, idx } = layout(connected, shownEdges, W, H);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(148,163,184,0.22)";
    ctx.lineWidth = 1;
    for (const e of shownEdges) {
      const a = idx.get(e.from), b = idx.get(e.to);
      if (a === undefined || b === undefined) continue;
      ctx.beginPath();
      ctx.moveTo(x[a], y[a]);
      ctx.lineTo(x[b], y[b]);
      ctx.stroke();
    }
    const maxIn = Math.max(1, ...connected.map((n) => n.in));
    connected.forEach((node, i) => {
      const r = 3 + Math.sqrt(node.in / maxIn) * 9;
      ctx.beginPath();
      ctx.arc(x[i], y[i], r, 0, Math.PI * 2);
      ctx.fillStyle = node.key === sel ? "#fbbf24" : node.in > 0 ? "#34d399" : "#64748b";
      ctx.fill();
    });
    // Only the strongest few get a label — everything labelled is nothing readable.
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.font = "11px ui-monospace, monospace";
    [...connected].sort((a, b) => b.in - a.in).slice(0, 8).forEach((node) => {
      const i = idx.get(node.key)!;
      ctx.fillText(node.title.replace(/\.md$/, "").slice(0, 26), x[i] + 10, y[i] + 4);
    });
  }, [data, connected, shownEdges, sel]);

  if (!data) return <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>;
  if (!data.available) {
    return (
      <div className="rounded-xl p-5 text-sm" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
        No link graph available{data.error ? ` — ${data.error}` : ""}.
      </div>
    );
  }

  const top = [...(data.nodes ?? [])].sort((a, b) => b.in - a.in).filter((n) => n.in > 0).slice(0, 12);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="font-medium" style={{ color: "var(--text-secondary)" }}>Link graph</h3>
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
            {connected.length} of {linked.length} linked shown · {isolated} isolated · {data.edges?.length ?? 0} links
          </span>
        </div>
        <canvas ref={canvasRef} width={760} height={460} className="w-full rounded-lg"
          style={{ background: "var(--bg-base)", border: "1px solid var(--border)" }} />
        <p className="mt-3 text-xs" style={{ color: "var(--text-faint)" }}>
          The {CORE} best-connected notes; dot size follows how often a note is referenced. Drawing
          all {linked.length} produced a hairball, so the rest is counted rather than drawn —
          {data.stats?.blocks.toLocaleString("en-US")} blocks sit behind these {data.stats?.files} files.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
          <h3 className="mb-3 font-medium" style={{ color: "var(--text-secondary)" }}>Most referenced</h3>
          {top.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Nothing links to anything yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {top.map((n) => (
                <li key={n.key}>
                  <button
                    onClick={() => setSel(n.key === sel ? null : n.key)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-white/5"
                    style={{ color: n.key === sel ? "var(--accent)" : "var(--text-primary)" }}
                  >
                    <span className="font-mono text-xs tabular-nums" style={{ color: "var(--text-faint)" }}>
                      {String(n.in).padStart(2, " ")}
                    </span>
                    <span className="truncate">{n.title.replace(/\.md$/, "")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
          <h3 className="mb-1 font-medium" style={{ color: "var(--text-secondary)" }}>
            Dead references {data.dangling?.length ? `(${data.dangling.length})` : ""}
          </h3>
          <p className="mb-3 text-xs" style={{ color: "var(--text-faint)" }}>
            A link whose target does not exist. Named rather than swallowed — each one is a note
            that was meant to be written, or a link that was mistyped.
          </p>
          {(data.dangling?.length ?? 0) === 0 ? (
            <p className="text-sm" style={{ color: "var(--accent)" }}>None. Every reference resolves.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {data.dangling!.slice(0, 12).map((d, i) => (
                <li key={i} className="leading-snug">
                  <code className="text-xs" style={{ color: "#f87171" }}>{d.target}</code>
                  <div className="text-xs" style={{ color: "var(--text-faint)" }}>
                    from {d.fromSrc.replace(/^native\//, "")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
