import React, { useState, Suspense, lazy } from "react";
import { Sidebar } from "./components/layout/Sidebar.js";
import { Layout } from "./components/layout/Layout.js";
import { Header } from "./components/layout/Header.js";
import { useWolfData } from "./hooks/useWolfData.js";
import { useTheme } from "./hooks/useTheme.js";

const ProjectOverview = lazy(() => import("./components/panels/ProjectOverview.js").then(m => ({ default: m.ProjectOverview })));
const ActivityTimeline = lazy(() => import("./components/panels/ActivityTimeline.js").then(m => ({ default: m.ActivityTimeline })));
const TokenUsage = lazy(() => import("./components/panels/TokenUsage.js").then(m => ({ default: m.TokenUsage })));
const CronStatus = lazy(() => import("./components/panels/CronStatus.js").then(m => ({ default: m.CronStatus })));
const CerebrumViewer = lazy(() => import("./components/panels/CerebrumViewer.js").then(m => ({ default: m.CerebrumViewer })));
const MemoryViewer = lazy(() => import("./components/panels/MemoryViewer.js").then(m => ({ default: m.MemoryViewer })));
const AnatomyBrowser = lazy(() => import("./components/panels/AnatomyBrowser.js").then(m => ({ default: m.AnatomyBrowser })));
const BugLog = lazy(() => import("./components/panels/BugLog.js").then(m => ({ default: m.BugLog })));
const AISuggestions = lazy(() => import("./components/panels/AISuggestions.js").then(m => ({ default: m.AISuggestions })));
const DesignQC = lazy(() => import("./components/panels/DesignQC.js").then(m => ({ default: m.DesignQC })));

const panelTitles: Record<string, string> = {
  overview: "Overview",
  activity: "Activity Timeline",
  tokens: "Token Intelligence",
  cron: "Cron Control Center",
  cerebrum: "Cerebrum",
  memory: "Memory Browser",
  anatomy: "Anatomy Browser",
  bugs: "Bug Log",
  suggestions: "AI Insights",
  designqc: "Design QC",
};

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 rounded-lg w-48" style={{ background: "var(--bg-surface)" }} />
      <div className="h-40 rounded-xl" style={{ background: "var(--bg-surface)" }} />
      <div className="grid grid-cols-3 gap-4">
        <div className="h-24 rounded-xl" style={{ background: "var(--bg-surface)" }} />
        <div className="h-24 rounded-xl" style={{ background: "var(--bg-surface)" }} />
        <div className="h-24 rounded-xl" style={{ background: "var(--bg-surface)" }} />
      </div>
    </div>
  );
}

export default function App() {
  const [activePanel, setActivePanel] = useState("overview");
  const data = useWolfData();
  const { theme, toggleTheme } = useTheme();

  if (data.loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ background: "var(--bg-base)" }}>
        <div className="text-center">
          <div className="text-4xl mb-4">🐺</div>
          <p style={{ color: "var(--text-muted)" }}>Loading OpenWolf...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-base)" }}>
      <Sidebar
        activePanel={activePanel}
        onNavigate={setActivePanel}
        projectName={data.project.name || data.identity.name}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <Layout>
        <Header title={panelTitles[activePanel] || "OpenWolf"} theme={theme} onToggleTheme={toggleTheme} currentProject={data.project.root} connected={data.connected} />
        {!data.connected && !data.loading && (
          <div
            className="rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3"
            style={{ background: "var(--danger-subtle)", border: "1px solid rgba(220,38,38,0.3)" }}
          >
            <div className="flex items-center gap-2 text-sm">
              <span style={{ color: "var(--danger)" }}>⚠</span>
              <span style={{ color: "var(--danger)" }} className="font-medium">Daemon nicht erreichbar</span>
              <span style={{ color: "var(--text-muted)" }}>— angezeigte Daten können veraltet sein. Läuft der Daemon? <code className="px-1 rounded text-xs" style={{ background: "var(--bg-base)" }}>openwolf daemon start</code></span>
            </div>
            <button
              onClick={data.retry}
              className="px-3 py-1 text-sm rounded-lg whitespace-nowrap transition-colors"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              Erneut versuchen
            </button>
          </div>
        )}
        <Suspense fallback={<Skeleton />}>
          {activePanel === "overview" && <ProjectOverview data={data} />}
          {activePanel === "activity" && <ActivityTimeline data={data} />}
          {activePanel === "tokens" && <TokenUsage data={data} />}
          {activePanel === "cron" && <CronStatus data={data} />}
          {activePanel === "cerebrum" && <CerebrumViewer data={data} />}
          {activePanel === "memory" && <MemoryViewer data={data} />}
          {activePanel === "anatomy" && <AnatomyBrowser data={data} />}
          {activePanel === "bugs" && <BugLog data={data} />}
          {activePanel === "suggestions" && <AISuggestions data={data} />}
          {activePanel === "designqc" && <DesignQC data={data} />}
        </Suspense>
      </Layout>
    </div>
  );
}
