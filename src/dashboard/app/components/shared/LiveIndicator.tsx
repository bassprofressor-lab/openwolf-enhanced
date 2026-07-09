import React from "react";

// Honest connection indicator — reflects the real WebSocket state. With this fork's dashboard
// auth the socket can legitimately fail (bad token, daemon restart, project switch), so this
// is meaningful rather than always-green.
export function LiveIndicator({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
        <span className="w-2 h-2 rounded-full bg-emerald-400 pulse-green" />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
      <span className="w-2 h-2 rounded-full bg-zinc-500" />
      Reconnecting…
    </span>
  );
}
