import React from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell, Legend } from "recharts";
import { formatTokens } from "../../lib/utils.js";
import type { WolfData } from "../../hooks/useWolfData.js";

export function TokenUsage({ data }: { data: WolfData }) {
  const { tokenLedger } = data;
  const lt = tokenLedger.lifetime;

  // Build chart data from sessions. Prefer the MEASURED tokens from the harness transcript
  // (real_usage) — the char-ratio estimate only counts Read/Edit tool use and reads 0 for
  // shell-heavy work. X-axis uses the turn's `ended` time (distinct per turn) so a long single
  // session doesn't collapse onto one point.
  const chartData = tokenLedger.sessions.map((s: any) => ({
    date: (s.ended || s.started || "").slice(0, 16).replace("T", " "),
    input: s.real_usage?.input_tokens ?? s.totals?.input_tokens_estimated ?? 0,
    output: s.real_usage?.output_tokens ?? s.totals?.output_tokens_estimated ?? 0,
  }));
  const anyMeasured = tokenLedger.sessions.some((s: any) => s.real_usage);

  // Comparison data — only real tracked numbers, no fabricated estimates (upstream #4, bug 5).
  //
  // [2026-08-20] This used to show ONLY the gross savings — what was avoided, without the cost of
  // avoiding it. `openwolf report` and `status` have gone net since 1.21.0; the dashboard kept
  // showing the flattering number, the same one-sidedness in a third place. Same arithmetic here
  // now, and the percentage MAY go negative: a metric that cannot look bad measures nothing.
  //
  // [2026-08-20, review] The first cut subtracted the injection from the WRONG bar. "Without
  // OpenWolf" is a bare-CLI baseline that injects nothing, so the injection belongs on the WITH
  // side — and `total_tokens_estimated` does not contain it. Subtracting it from the baseline
  // overstated the saving (gross 1.0M / injected 400k / tracked 600k read as 50 % instead of 37 %)
  // and, worse, a real net LOSS clamped to a green "saved ~0% net" pill.
  const totalTracked = lt.total_tokens_estimated;
  const grossSavings = lt.estimated_savings_vs_bare_cli ?? 0;
  const injected = lt.injection_tokens_estimated ?? 0;
  const savings = grossSavings - injected;
  const withWolf = totalTracked + injected;          // what OpenWolf actually costs
  const withoutWolf = totalTracked + grossSavings;   // the bare-CLI baseline, unchanged
  const savingsPercent = withoutWolf > 0 ? Math.round((savings / withoutWolf) * 100) : 0;
  // Show the panel as soon as EITHER side has a number — a project that only injects must be
  // able to see that, otherwise the panel hides precisely the bad case.
  const hasComparisonData = grossSavings > 0 || injected > 0;
  // Before 1.21.0 nothing injected was counted — then the number is gross and has to say so.
  const injectionTracked = injected > 0;

  const comparisonData = [
    { name: "Without OpenWolf (est.)", tokens: withoutWolf, fill: "#fbbf24" },
    { name: "With OpenWolf (actual)", tokens: withWolf, fill: "#34d399" },
  ];

  return (
    <div>
      {/* Usage over time */}
      <div className="rounded-xl p-5 mb-6" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <h3 className="font-medium mb-4" style={{ color: "var(--text-secondary)" }}>Usage Over Time</h3>
        {chartData.length === 0 ? (
          <div className="text-sm py-8 text-center" style={{ color: "var(--text-muted)" }}>No session data yet.</div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
              <XAxis dataKey="date" tick={{ fill: "var(--text-muted)", fontSize: 12 }} />
              <YAxis tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickFormatter={(v) => formatTokens(v)} />
              <Tooltip contentStyle={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-primary)" }}
                itemStyle={{ color: "var(--text-primary)" }} labelStyle={{ color: "var(--text-secondary)" }} />
              <Area type="monotone" dataKey="input" name="Input tokens" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
              <Area type="monotone" dataKey="output" name="Output tokens" stackId="1" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.3} />
            </AreaChart>
          </ResponsiveContainer>
        )}
        <p className="text-xs mt-3" style={{ color: "var(--text-faint)" }}>
          {anyMeasured
            ? "Measured from harness transcripts where available, otherwise char-ratio estimate."
            : "Char-ratio estimate (counts Read/Edit tool use; shell-only work reads 0). Measured numbers appear once sessions record transcript usage."}
        </p>
      </div>

      {/* Comparison */}
      <div className="rounded-xl p-5 mb-6" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium" style={{ color: "var(--text-secondary)" }}>Token Comparison</h3>
          {hasComparisonData && (
            <span className="px-3 py-1 rounded-full text-sm font-medium"
              style={savingsPercent >= 0
                ? { background: "var(--accent-subtle)", color: "var(--accent)" }
                : { background: "rgba(248,113,113,0.15)", color: "#f87171" }}>
              {savingsPercent >= 0
                ? `OpenWolf saved ~${savingsPercent}% net`
                : `OpenWolf cost ~${Math.abs(savingsPercent)}% net`}
            </span>
          )}
        </div>
        {hasComparisonData && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 mb-4 text-xs" style={{ color: "var(--text-muted)" }}>
            <span>Reads avoided: <b style={{ color: "var(--text-secondary)" }}>{formatTokens(grossSavings)}</b></span>
            <span>OpenWolf injected: <b style={{ color: "var(--text-secondary)" }}>{formatTokens(injected)}</b></span>
            <span>Net: <b style={{ color: savings >= 0 ? "var(--accent)" : "#f87171" }}>
              {savings < 0 ? "-" : ""}{formatTokens(Math.abs(savings))}</b></span>
            {!injectionTracked && <span style={{ color: "var(--text-faint)" }}>
              (injection accounting starts with 1.21.0 — earlier sessions are gross only)</span>}
          </div>
        )}
        {!hasComparisonData ? (
          <div className="text-sm py-6 text-center" style={{ color: "var(--text-muted)" }}>
            No savings data yet. The comparison appears once OpenWolf has tracked repeated-read savings across sessions.
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={comparisonData} layout="vertical">
                <XAxis type="number" tick={{ fill: "var(--text-muted)", fontSize: 12 }} tickFormatter={(v) => formatTokens(v)} />
                <YAxis type="category" dataKey="name" tick={{ fill: "var(--text-secondary)", fontSize: 12 }} width={220} />
                <Tooltip contentStyle={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-primary)" }}
                itemStyle={{ color: "var(--text-primary)" }} labelStyle={{ color: "var(--text-secondary)" }} cursor={{ fill: "transparent" }} formatter={(v: number) => [formatTokens(v) + " tokens", ""]} />
                <Bar dataKey="tokens" radius={[0, 4, 4, 0]} background={{ fill: "transparent" }}>
                  {comparisonData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs mt-3" style={{ color: "var(--text-faint)" }}>Based on repeated-read blocks tracked by OpenWolf across your sessions.</p>
          </>
        )}
      </div>

      {/* Waste alerts */}
      {tokenLedger.waste_flags.length > 0 && (
        <div className="rounded-xl p-5" style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}>
          <h3 className="font-medium mb-3" style={{ color: "var(--text-secondary)" }}>Waste Alerts</h3>
          <div className="space-y-3">
            {tokenLedger.waste_flags.map((flag: any, i: number) => (
              <div key={i} className="rounded-lg p-4" style={{ background: "var(--warning-subtle)", border: "1px solid rgba(217, 119, 6, 0.2)" }}>
                <div className="flex items-start gap-2">
                  <span style={{ color: "var(--warning)" }} className="mt-0.5">⚠</span>
                  <div>
                    <p className="text-sm font-medium" style={{ color: "var(--warning)" }}>{flag.pattern}</p>
                    <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>{flag.description}</p>
                    <p className="text-xs mt-2" style={{ color: "var(--text-faint)" }}>{flag.suggestion}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
