import * as path from "node:path";
import { recall, resolveId } from "../utils/recall.js";
import { buildResumeDigest, nativeMemoryDir } from "../hooks/shared.js";
import { nativeMemoryHealth } from "../utils/maintenance.js";

// A minimal, dependency-free MCP server (JSON-RPC 2.0 over newline-delimited stdio) that exposes
// OpenWolf's read-only capabilities to any MCP client — notably the Claude Desktop app, which has
// no Claude Code hook lifecycle. It serves one project directory (its .wolf/ + Claude's native
// Auto Memory). Nothing but JSON-RPC goes to stdout; logs must go to stderr.

const PROTOCOL_VERSION = "2025-06-18";

export interface McpOpts { projectDir: string; version: string; }

interface JsonRpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export const MCP_TOOLS = [
  {
    name: "openwolf_recall",
    description:
      "Keyword-search this project's OpenWolf knowledge (STATUS.md, cerebrum.md, memory.md, buglog.json) AND Claude's native Auto Memory. Returns a ranked list; each hit has a stable citation id like [c-3f9a]. Pass that id back (as `id`) to expand it to its full entry — cheap index first, full text on demand.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (omit when resolving an `id`)" },
        limit: { type: "number", description: "Max results (default 12)" },
        id: { type: "string", description: "A citation id from a previous result — returns that entry's full block" },
      },
    },
  },
  {
    name: "openwolf_resume",
    description:
      "Return OpenWolf's resume digest for this project: the STATUS handoff, Do-Not-Repeat notes, recent activity, and an index of what else is available to pull on demand.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "openwolf_memory_health",
    description:
      "Report the health of Claude's native Auto Memory for this project: how many topic files exist vs. how many the MEMORY.md index actually references (unreferenced ones never load), the 200-line cutoff, dead links, and stale files.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function text(id: JsonRpc["id"], body: string) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: body }], isError: false } };
}
function rpcError(id: JsonRpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function callTool(name: string, args: Record<string, unknown>, projectDir: string): string {
  const wolfDir = path.join(projectDir, ".wolf");
  if (name === "openwolf_recall") {
    // Targeted second layer: expand a citation id to its full entry.
    const wantId = String(args.id ?? "").trim();
    if (wantId) {
      const entry = resolveId(wolfDir, wantId);
      return entry ? `[${entry.id}] ${entry.file}:${entry.line}\n${entry.text}` : `No entry with id "${wantId}".`;
    }
    const q = String(args.query ?? "").trim();
    if (!q) return "Provide a `query` (or an `id` to expand).";
    const hits = recall(wolfDir, q, { limit: Math.max(1, Number(args.limit) || 12) });
    if (hits.length === 0) return `No matches for "${q}".`;
    const body = hits.map((h) => `[${h.id}] (${h.score}) ${h.file}:${h.line}\n    ${h.text.slice(0, 160)}`).join("\n");
    return `${hits.length} match(es) for "${q}" — pass an id back to expand it:\n${body}`;
  }
  if (name === "openwolf_resume") {
    return buildResumeDigest(wolfDir, 6000) ?? "No resume context available for this project.";
  }
  if (name === "openwolf_memory_health") {
    const nd = nativeMemoryDir(projectDir);
    if (!nd) return "No native Auto Memory found for this project.";
    const h = nativeMemoryHealth(nd);
    return [
      `${h.topicFiles} topic files; MEMORY.md ${h.indexLines} lines, ${h.indexedCount} referenced, ${h.orphanCount} not indexed (never auto-load at session start).`,
      h.indexCutoffExceeded ? "WARNING: MEMORY.md exceeds 200 lines — only the first 200 load at session start." : "",
      h.deadLinks.length ? `${h.deadLinks.length} dead index link(s): ${h.deadLinks.slice(0, 5).join(", ")}` : "",
      h.staleCount ? `${h.staleCount} files untouched in 90+ days.` : "",
    ].filter(Boolean).join("\n");
  }
  throw new Error(`unknown tool: ${name}`);
}

// Pure dispatch: returns the JSON-RPC response object, or null for notifications (no reply).
export function handleMcpMessage(msg: JsonRpc, opts: McpOpts): object | null {
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: (msg.params?.protocolVersion as string) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "openwolf", version: opts.version },
        },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      try {
        return text(msg.id, callTool(name, args, opts.projectDir));
      } catch (e) {
        // Tool-level failures come back as an error-flagged text result, not a protocol error.
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true } };
      }
    }
    default:
      return msg.id !== undefined ? rpcError(msg.id, -32601, `Method not found: ${msg.method}`) : null;
  }
}

// stdio transport: newline-delimited JSON-RPC. Keeps the process alive until stdin closes.
export function runMcpStdio(opts: McpOpts): void {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpc;
      try { msg = JSON.parse(line); } catch { continue; }
      const resp = handleMcpMessage(msg, opts);
      if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
