// Dashboard auth token handling. `openwolf dashboard` opens the page with ?token=<token>;
// we read it once, keep it in sessionStorage, strip it from the address bar, and attach it
// to every API request (header) and the WebSocket URL (query).

const STORAGE_KEY = "openwolf_dashboard_token";

function readToken(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
      // Remove the token from the visible URL / history.
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      return fromUrl;
    }
    return sessionStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export const DASHBOARD_TOKEN = readToken();

export function authHeaders(): Record<string, string> {
  return DASHBOARD_TOKEN ? { "X-OpenWolf-Token": DASHBOARD_TOKEN } : {};
}

export function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...(init?.headers || {}), ...authHeaders() },
  });
}

export function withToken(wsUrl: string): string {
  if (!DASHBOARD_TOKEN) return wsUrl;
  const sep = wsUrl.includes("?") ? "&" : "?";
  return `${wsUrl}${sep}token=${encodeURIComponent(DASHBOARD_TOKEN)}`;
}
