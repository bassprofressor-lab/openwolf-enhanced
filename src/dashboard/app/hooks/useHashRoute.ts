import { useCallback, useEffect, useState } from "react";

// Hash-based routing so panels are deep-linkable and the browser back/forward buttons work.
// A route is `#<panel>` with an optional query, e.g. `#anatomy?file=src/app.ts`. The query
// carries per-panel deep-link params (used by Jump-to-file).
export interface HashRoute {
  panel: string;
  params: URLSearchParams;
  navigate: (panel: string, params?: Record<string, string>) => void;
}

function parseHash(defaultPanel: string): { panel: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#/, "");
  const qIndex = raw.indexOf("?");
  const panel = (qIndex === -1 ? raw : raw.slice(0, qIndex)) || defaultPanel;
  const query = qIndex === -1 ? "" : raw.slice(qIndex + 1);
  return { panel, params: new URLSearchParams(query) };
}

export function useHashRoute(defaultPanel: string): HashRoute {
  const [route, setRoute] = useState(() => parseHash(defaultPanel));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(defaultPanel));
    window.addEventListener("hashchange", onHashChange);
    // Normalise an empty hash to the default panel so the first entry is a real route.
    if (!window.location.hash) window.location.replace(`#${defaultPanel}`);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [defaultPanel]);

  const navigate = useCallback((panel: string, params?: Record<string, string>) => {
    const query = params && Object.keys(params).length
      ? "?" + new URLSearchParams(params).toString()
      : "";
    const next = `#${panel}${query}`;
    // Setting location.hash fires `hashchange`, which updates state — no manual setRoute.
    if (window.location.hash !== next) window.location.hash = next;
    else setRoute(parseHash(defaultPanel)); // same hash → re-sync (e.g. re-click a jump link)
  }, [defaultPanel]);

  return { panel: route.panel, params: route.params, navigate };
}
