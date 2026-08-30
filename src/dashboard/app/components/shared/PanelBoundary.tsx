import React from "react";

interface Props {
  /** Panel name, shown in the message and used by App to reset the boundary on navigation. */
  panel: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Contain a render error to the panel that caused it.
 *
 * Every panel renders data an agent wrote to .wolf/ mid-session. useWolfData now normalises the
 * shape of those files on ingest, which removes the known crash, but the dashboard had no boundary
 * at all: any throw during render unmounted the entire React tree and left a blank page with no
 * message, no sidebar and no way back — indistinguishable from a dead daemon.
 *
 * A boundary is the difference between "the Bug Log panel is broken" and "the dashboard is gone".
 */
export class PanelBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The daemon does not collect browser errors, so the console is the only record. Keep it.
    console.error(`[openwolf] panel "${this.props.panel}" failed to render`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    // Navigating to another panel clears the error, so one broken panel does not wedge the UI.
    if (prev.panel !== this.props.panel && this.state.error) this.setState({ error: null });
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="rounded-xl px-4 py-4"
        style={{ background: "var(--danger-subtle)", border: "1px solid rgba(220,38,38,0.3)" }}
      >
        <div className="font-medium mb-1" style={{ color: "var(--danger)" }}>
          Dieses Panel konnte nicht dargestellt werden
        </div>
        <p className="text-sm mb-3" style={{ color: "var(--text-muted)" }}>
          Meist steht in einer <code>.wolf/*.json</code> etwas anderes, als das Panel erwartet — etwa weil
          gerade geschrieben wurde. Der Rest des Dashboards läuft weiter.
        </p>
        <pre
          className="text-xs overflow-x-auto p-2 rounded mb-3"
          style={{ background: "var(--bg-base)", color: "var(--text-secondary)" }}
        >
          {this.state.error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="px-3 py-1 text-sm rounded-lg transition-colors"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
        >
          Erneut versuchen
        </button>
      </div>
    );
  }
}
