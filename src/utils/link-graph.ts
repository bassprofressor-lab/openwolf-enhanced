import * as fs from "node:fs";
import * as path from "node:path";
import { blocksFor, entryId } from "./recall.js";
import { nativeMemoryDir } from "../hooks/shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// The link graph over the knowledge base — who points at whom.
//
// [2026-08-20] Citations were a one-way street: `recall --id <id>` opens an entry, but
// "which entries lean on this decision?" had no answer at all, and `[[wikilinks]]` were
// written by hand and read by nobody. A note nobody links to and a note everybody links to
// looked exactly alike.
//
// Two kinds of reference, both already in the files:
//   [c-3f9a2b]   a citation id — content-addressed, points at one block
//   [[some-note]] a wikilink — points at a native-memory topic file by its slug
//
// Private content is handled upstream: `blocksFor` runs `blankPrivate`, so a reference that
// only exists inside a <private> block never enters the graph. That is deliberate — the graph
// is rendered in a dashboard and must not become a side channel.
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkNode {
  /** Citation id of the block, or `file:<slug>` for a whole topic file. */
  key: string;
  kind: "block" | "file";
  src: string;
  line: number;
  /** First line of the block, shortened — what a human recognizes it by. */
  title: string;
  /** Normalized slug, set on file nodes so a wikilink can resolve to it. */
  slug?: string;
  inbound: number;
  outbound: number;
}

export interface LinkEdge {
  from: string;
  to: string;
  kind: "id" | "wiki";
}

export interface DanglingRef {
  from: string;
  fromSrc: string;
  target: string;
  kind: "id" | "wiki";
}

export interface LinkGraph {
  nodes: LinkNode[];
  edges: LinkEdge[];
  /** References pointing at nothing. Named, not swallowed — a dead link is a finding. */
  dangling: DanglingRef[];
}

const ID_RE = /\[([scmbnx]-[0-9a-f]{6})\]/g;
const WIKI_RE = /\[\[([^\]|#]{1,120})(?:[|#][^\]]*)?\]\]/g;
/**
 * Markdown link to a local .md file — how MEMORY.md wires its index.
 *
 * [2026-08-20] The link text bound was 160 and silently missed everything: this project's index
 * uses whole descriptive sentences as link text, measured at 473 characters. A cap picked from
 * imagination rather than from the data reported the entire index as unlinked. Kept on one line
 * so a stray bracket cannot swallow half the file.
 */
const MDLINK_RE = /\[[^\]\n]{1,900}\]\(([^)\s]+\.md)\)/g;
/** Code spans and fences: `[[6,0,[taxId]]]` in an Odoo snippet is an array literal, not a link. */
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
/** A slug is words, digits, dashes, underscores, dots — nothing with commas, quotes or brackets. */
const SLUG_OK = /^[\w][\w.\-/]{1,119}$/;

/**
 * Normalize a slug so `-` and `_` are interchangeable and case does not matter.
 *
 * Needed because the two conventions drifted in practice: a topic file called
 * `orderflow_oi_fenster_2026_08_20.md` carries `name: orderflow-oi-fenster-2026-08-20` in its
 * frontmatter, and links are written both ways. Matching literally would report perfectly good
 * links as dead.
 */
export function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/\.md$/, "").replace(/[\s_-]+/g, "-");
}

/** Citation ids and wikilinks referenced by a piece of text. Deduplicated, order preserved. */
export function extractRefs(text: string): { ids: string[]; wikis: string[] } {
  // [2026-08-20] Blank out code first. Measured on this project's own knowledge base, 10 of 17
  // reported dead links were nested array literals from Odoo snippets (`[[6,0,[taxId]]]`) that the
  // wikilink pattern happily matched. A dead-link report full of false positives gets ignored,
  // which is worse than no report.
  const prose = text.replace(CODE_RE, (m) => " ".repeat(m.length));
  const ids: string[] = [];
  const wikis: string[] = [];
  ID_RE.lastIndex = 0;
  for (let m = ID_RE.exec(prose); m; m = ID_RE.exec(prose)) ids.push(m[1]);
  WIKI_RE.lastIndex = 0;
  for (let m = WIKI_RE.exec(prose); m; m = WIKI_RE.exec(prose)) {
    const t = m[1].trim();
    if (SLUG_OK.test(t)) wikis.push(t);
  }
  // Markdown links into .md files count too — that is how MEMORY.md wires its whole index, and
  // reading only wikilinks reported the index itself as an orphan.
  MDLINK_RE.lastIndex = 0;
  for (let m = MDLINK_RE.exec(prose); m; m = MDLINK_RE.exec(prose)) {
    const t = m[1].split("/").pop()!;
    if (SLUG_OK.test(t)) wikis.push(t);
  }
  return { ids: [...new Set(ids)], wikis: [...new Set(wikis)] };
}

function title(blockText: string, max = 90): string {
  const first = blockText.split("\n")[0].replace(/^[#>\s*-]+/, "").trim();
  return first.length > max ? first.slice(0, max - 1) + "…" : first || "(ohne Titel)";
}

const DEFAULT_SOURCES = ["STATUS.md", "cerebrum.md", "memory.md", "buglog.json"];

/**
 * Build the graph from the same files `recall` searches, so an id in the graph is the same id
 * `recall --id` resolves. One index, not two — two indexes over one corpus drift apart.
 */
export function buildLinkGraph(
  wolfDir: string,
  opts: { sources?: string[]; includeNative?: boolean; nativeDir?: string | null } = {}
): LinkGraph {
  const nodes = new Map<string, LinkNode>();
  const edges: LinkEdge[] = [];
  const dangling: DanglingRef[] = [];
  const bySlug = new Map<string, string>();

  // The .wolf sources get a file node too, so a link like `[…](cerebrum.md)` from a topic file
  // resolves instead of being reported dead. They are real files; only their kind differs.
  const files: Array<{ label: string; abspath: string; slug?: string }> = (opts.sources ?? DEFAULT_SOURCES)
    .map((src) => ({ label: src, abspath: path.join(wolfDir, src), slug: normalizeSlug(src) }));

  if (opts.includeNative !== false) {
    const nd = opts.nativeDir !== undefined ? opts.nativeDir : nativeMemoryDir(path.dirname(wolfDir));
    if (nd) {
      let entries: string[] = [];
      try { entries = fs.readdirSync(nd); } catch { /* unreadable */ }
      for (const name of entries) {
        if (!name.endsWith(".md") || name.includes(".bak")) continue;
        files.push({ label: `native/${name}`, abspath: path.join(nd, name), slug: normalizeSlug(name) });
      }
    }
  }

  // Pass 1: every block becomes a node; every topic file additionally becomes a file node so a
  // wikilink has something to land on.
  const blocksByFile: Array<{ label: string; blocks: Array<{ start: number; text: string }> }> = [];
  for (const f of files) {
    let content: string;
    try { content = fs.readFileSync(f.abspath, "utf-8"); } catch { continue; }
    const blocks = blocksFor(f.label, content).map((b) => ({ start: b.start, text: b.text }));
    blocksByFile.push({ label: f.label, blocks });

    if (f.slug) {
      // [2026-08-20] The key is the FILE LABEL, not the slug. Keying by slug collided:
      // `.wolf/memory.md` and `native/MEMORY.md` both normalize to "memory", so one silently
      // replaced the other and MEMORY.md lost every one of its ~200 outgoing index links.
      const key = `file:${f.label}`;
      // The frontmatter `name:` wins when present — that is what links are written against.
      const fm = content.match(/^---[\s\S]*?\bname:\s*([^\n]+)/);
      const slug = normalizeSlug(fm ? fm[1] : f.slug);
      nodes.set(key, { key, kind: "file", src: f.label, line: 1, title: f.label.replace("native/", ""), slug, inbound: 0, outbound: 0 });
      // Wikilinks target topic files, so a native file wins a slug it shares with a .wolf source.
      const isNative = f.label.startsWith("native/");
      for (const alias of new Set([slug, f.slug])) {
        if (isNative || !bySlug.has(alias)) bySlug.set(alias, key);
      }
    }
    for (const b of blocks) {
      const key = entryId(f.label, b.text);
      if (!nodes.has(key)) {
        nodes.set(key, { key, kind: "block", src: f.label, line: b.start, title: title(b.text), inbound: 0, outbound: 0 });
      }
      // [2026-08-20] Bug records are referenced by id from cerebrum and memory (`[[bug-209]]`), so
      // they need an address of their own. Without one, `lint` reported live bug ids as dead links
      // on its very first run — 10 of them, all present in buglog.json. A checker whose false
      // positives point at the checker is worse than no checker.
      const idm = f.label.endsWith(".json") ? b.text.match(/^([a-z]+-\d{2,})[\s—:-]/i) : null;
      if (idm) {
        const s = normalizeSlug(idm[1]);
        if (!bySlug.has(s)) bySlug.set(s, key);
      }
    }
  }

  // Pass 2: edges. Only now, because a reference may point forward to a file read later.
  for (const { label, blocks } of blocksByFile) {
    for (const b of blocks) {
      const from = entryId(label, b.text);
      const { ids, wikis } = extractRefs(b.text);
      for (const id of ids) {
        if (id === from) continue; // a block citing itself is noise, not a link
        if (nodes.has(id)) edges.push({ from, to: id, kind: "id" });
        else dangling.push({ from, fromSrc: label, target: id, kind: "id" });
      }
      for (const w of wikis) {
        const target = bySlug.get(normalizeSlug(w));
        if (target && target !== from) edges.push({ from, to: target, kind: "wiki" });
        else if (!target) dangling.push({ from, fromSrc: label, target: w, kind: "wiki" });
      }
    }
  }

  // Degrees, after deduplicating parallel edges of the same kind.
  const seen = new Set<string>();
  const unique: LinkEdge[] = [];
  for (const e of edges) {
    const k = `${e.from}>${e.to}:${e.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
    const f = nodes.get(e.from); if (f) f.outbound++;
    const t = nodes.get(e.to); if (t) t.inbound++;
  }

  return { nodes: [...nodes.values()], edges: unique, dangling };
}

/** Who points at this node. The question citations could not answer before. */
export function backlinksFor(graph: LinkGraph, key: string): LinkNode[] {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  return graph.edges
    .filter((e) => e.to === key)
    .map((e) => byKey.get(e.from))
    .filter((n): n is LinkNode => Boolean(n));
}

/**
 * Nodes nothing points at and that point nowhere. Not a defect by itself — most blocks are
 * plain notes — but among *topic files* an orphan is usually one that was never wired in.
 */
export function orphans(graph: LinkGraph, kind?: LinkNode["kind"]): LinkNode[] {
  return graph.nodes.filter((n) => n.inbound === 0 && n.outbound === 0 && (!kind || n.kind === kind));
}
