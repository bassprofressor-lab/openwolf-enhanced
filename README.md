<p align="center">
  <img src="openwolf-icon.png" alt="OpenWolf Enhanced" width="120" />
</p>

<h1 align="center">OpenWolf Enhanced</h1>

<p align="center">
  <strong>A second brain for your coding agent.</strong><br />
  A file index it consults before opening anything, a memory of your corrections that survives
  <code>/clear</code>, and a token ledger that counts <em>both</em> sides. Through invisible hooks —
  no workflow changes.
</p>

<p align="center">
  🌐 <strong>English</strong> · <a href="docs/i18n/README.de.md">Deutsch</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openwolf-enhanced"><img src="https://img.shields.io/npm/v/openwolf-enhanced?color=CB3837&logo=npm&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/openwolf-enhanced"><img src="https://img.shields.io/npm/dm/openwolf-enhanced?color=CB3837&label=downloads" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-green.svg" alt="Node.js" /></a>
  <a href="https://github.com/cytostack/openwolf"><img src="https://img.shields.io/badge/fork%20of-cytostack%2Fopenwolf-lightgrey.svg" alt="Fork of cytostack/openwolf" /></a>
  <a href="https://www.krynexlabs.de/en/openwolf-enhanced"><img src="https://img.shields.io/badge/by-Krynex%20Labs-6D28D9.svg" alt="by Krynex Labs" /></a>
</p>

---

> **This is an enhanced fork of [OpenWolf](https://github.com/cytostack/openwolf)** by Cytostack Pvt Ltd.
> The original is a great idea; in long-lived projects its `.wolf/` directory could grow
> without bound (multi-megabyte token ledgers, an ever-growing bug log, full-file rewrites
> on every edit). This fork keeps everything the original does and makes storage **bounded,
> self-maintaining, and scopeable**. The CLI is still `openwolf`, so it's a drop-in replacement.
> See [what's enhanced](#whats-enhanced) and the [CHANGELOG](CHANGELOG.md).

**Works with [Claude Code](https://claude.com/claude-code), [OpenAI Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli) and [OpenCode](https://github.com/sst/opencode)** — plus Claude Desktop and any MCP client. Persistent project memory, searchable citations, and context injection through invisible hooks. Git-native, no database, no cloud.

**Contents:** [See it](#see-it) · [Why](#why-openwolf-exists) · [What's Enhanced](#whats-enhanced) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Commands](#commands) · [Claude Desktop / MCP](#use-in-claude-desktop-mcp) · [FAQ](#faq)

## See it

Find where something lives, without a repo-wide grep — and read only that slice:

```console
$ openwolf find pageRank

  1 hit(s) for "pageRank"

  ▆ src/scanner/import-graph.ts:106-147
      fn pageRank  ·  ~380 tok

  ▁…█ = importance in the import graph (how often, and from how central a file).
```

Ask what it actually cost you — including what OpenWolf itself put into the context:

```console
$ openwolf report

  Estimated (char-ratio heuristic)
    Total tokens:           1,204,880
    Reads avoided:            412,300
    OpenWolf injected:         88,140   (resume digests, reminders)
    Net savings:              324,160
```

That third line is the one most tools leave out. It can go negative, and it is meant to.

## Why OpenWolf Exists

Claude Code is powerful but it works blind. It doesn't know what a file contains until it opens it. It can't tell a 50-token config from a 2,000-token module. It reads the same file multiple times in one session without noticing. It has no index of your project, no memory of your corrections, and no awareness of what it already tried.

OpenWolf gives Claude a second brain: a file index so it knows what files contain before reading them, a learning memory that accumulates your preferences and past mistakes, and a token ledger that tracks everything. All through 7 invisible hook scripts that fire on every Claude action.

## What's Enhanced

Everything upstream does, plus the following. Details for each live in the
[docs](docs/index.md) and the [CHANGELOG](CHANGELOG.md).

**Finding things**

| | |
|---|---|
| 🔎 **`openwolf find`** | Symbol and file lookup from the existing index — with exact line ranges, so you read one function instead of the file. Also `--json` and the MCP tool `openwolf_find`. |
| 🧭 **Import-graph importance** | Ties break on PageRank over your own imports, stored as a rank percentile. The biggest file is rarely the most important one. |
| 🌳 **tree-sitter ranges** *(optional)* | Real symbol boundaries from the syntax tree instead of "the line before the next one" — which was wrong for 97 % of symbols. Optional dependency; falls back cleanly and says why. |
| 🧠 **Searchable memory** | `recall <query>` over STATUS / cerebrum / memory / buglog **and** Claude's native Auto Memory, BM25-ranked, each hit with a stable citation id. `--semantic` ranks by meaning via local embeddings; `--hybrid` fuses both. `--all` extends either across every registered project — fusing the per-project lists by rank, skipping (and naming) projects without an index rather than quietly building one. |

**Keeping it honest**

| | |
|---|---|
| ✅ **`openwolf lint`** | Checks the knowledge base against the protocol it promises — the four sections, dated Do-Not-Repeat entries, buglog records carrying `root_cause` and `fix`, references that resolve — and prints an item-weighted compliance percentage. Exit code for pre-commit and CI (`--strict`). On its first run here it found 8 duplicate bug ids, each making one of two records unreachable. |
| 🧪 **`openwolf distill`** | A cerebrum that grew for a year drifts: 52 headings, 47 % of the file past the last section the template knows. This files it back under the four — **moving text, never rewriting it**, and refusing to write at all if a single content line would change. |
| ⏳ **Entry maturity** | Content-addressed ids make "how long has this been true?" answerable, so settled knowledge stops looking as provisional as yesterday's note. |

**Knowing what it costs**

| | |
|---|---|
| 📊 **Both sides of the ledger** | `report` shows reads avoided, **what OpenWolf itself injected**, and the net. The net may go negative — a metric that cannot look bad measures nothing. |
| 📦 **Bounded storage** | Ledger, bug log, cron queues and waste flags are all capped. No runaway multi-MB files. Every limit lives in `openwolf.retention` and survives updates. |
| 🩺 **Self-maintenance** | `doctor` reports the `.wolf/` footprint and compacts it, flags registry issues, suggests `.wolfignore` entries, and hints at near-duplicate cerebrum entries — `consolidate` LLM-merges them. |
| 📤 **Export** | `export <sessions\|bugs>` to JSON or CSV (RFC 4180). |

**Working across agents**

| | |
|---|---|
| 🐝 **Codex, Gemini, OpenCode** | `init`/`update` detect them and register the hooks there too, including the `AGENTS.md` protocol block they actually read — one delimited block, everything outside it untouched. |
| 🔌 **Claude Desktop / MCP** | `openwolf mcp` exposes recall, resume, find and memory-health to any MCP client. |
| 🔌 **Model-agnostic AI tasks** | The cron engine's AI tasks point at any OpenAI-compatible endpoint — OpenAI, Groq, Cerebras, Mistral, a local server. No code change. |

**Session hygiene**

| | |
|---|---|
| 🧭 **Smart resume** | A token-bounded digest on session start: STATUS and Do-Not-Repeat inline, the rest as an *"available on demand"* index — so the model continues without re-reading. |
| 📓 **Activity capture** *(opt-in)* | Notable shell commands **and failures** appended to a capped log that feeds the next resume. Secrets redacted, trivial reads dropped. Off by default. |
| 🗒 **Structured summaries** | Each session gets a `Did / Learned / Next / Files` scaffold, so memory stays greppable. |
| 🎯 **`.wolfignore`** | gitignore-style scoping for both anatomy scanning and hook tracking. |
| 🌍 **Localized digest** | The resume digest can render in German via `openwolf.lang`. |

**Trust**

| | |
|---|---|
| 🔒 **Privacy** | `<private>…</private>` in any `.wolf` file stays out of the injected context, out of search, and out of anything sent elsewhere. |
| 🛡 **Security & correctness** | Dashboard on loopback and token-gated, no command injection or path traversal, secret-file exclusion — plus ~15 security fixes from upstream pull requests that were never merged into the 1.x line this fork is based on. |
| 🚀 **Trusted releases** | Published to npm via GitHub OIDC — no long-lived token — with SLSA provenance. CI builds and tests on every push. |
| 📈 **Dashboard** | Deep-linkable panels, a cross-project view, a command log, Design QC grid, and a daemon-down banner. |

Every change is versioned in the [CHANGELOG](CHANGELOG.md); attribution is in the [NOTICE](NOTICE).

## Quick Start

```bash
npm install -g openwolf-enhanced
```

> **Note — two different packages.** `npm install -g openwolf` installs
> [cytostack/openwolf](https://github.com/cytostack/openwolf), which is **actively developed**
> (2.x line, current as of August 2026). This package is a **separate lineage**: it forked the
> 1.x codebase in 2026 and never adopted the 2.x rewrite, so the two have diverged in
> architecture as well as features. Both still provide the same `openwolf` command, which means
> they cannot be installed side by side. Pick this one for the bounded-storage, self-maintenance
> and security work described above; pick upstream for the 2.x feature line.

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/bassprofressor-lab/openwolf-enhanced.git
cd openwolf-enhanced
pnpm install
pnpm build            # builds CLI, hooks, and dashboard
npm install -g .      # installs the `openwolf` command globally
```
</details>

Then, in any project:

```bash
cd your-project
openwolf init
```

That's it. Use `claude` normally. OpenWolf is watching.

### Rebuilding an installed copy

Two things to know before you re-run `pnpm build` on a copy you have already installed globally:

- **`prebuild` deletes `dist/` before compiling**, and the global `openwolf` command is a symlink
  into `dist/bin/openwolf.js`. If the build then fails, the CLI is gone until you build again. Back
  `dist/` up first if you are mid-change, or build in a clean checkout.
- **A rebuild does not deploy anything.** The hooks that actually run are per-project copies under
  `<project>/.wolf/hooks/`, invoked by `.claude/settings.json` — not the installed package. Run
  `openwolf update` afterwards to push new hooks into your projects (it touches *every* registered
  project; scope it with `--project <name>`).

> **Upgrading the tool?** The hooks that actually run are **per-project copies** in
> `<project>/.wolf/hooks/`, not the global package. After rebuilding/reinstalling, run
> `openwolf update` (or `openwolf update --project <name>`) to copy the new hooks into your
> projects — a global reinstall alone does not update them. `openwolf update` with no
> `--project` updates **all** registered projects.

## What It Creates

`openwolf init` creates a `.wolf/` directory in your project:

| File | Purpose |
|------|---------|
| `STATUS.md` | Single-source-of-truth handoff — current quest, next steps, gotchas; read first on resume |
| `anatomy.md` | Project file map with descriptions and token estimates |
| `cerebrum.md` | Learned preferences, corrections, Do-Not-Repeat list |
| `memory.md` | Chronological action log with token estimates |
| `buglog.json` | Bug fix memory, searchable, prevents re-discovery |
| `token-ledger.json` | Lifetime token tracking and session history |
| `hooks/` | 8 lifecycle hooks (pure Node.js), deployed to every detected agent |
| `anatomy-symbols.json` | Symbol line ranges for larger files — what `find` returns and what turns a read into a slice |
| `anatomy-graph.json` | Import-graph importance per file, used to order otherwise equal hits |
| `config.json` | Configuration with sensible defaults (incl. `retention`) |
| `identity.md` | Agent persona for this project |
| `OPENWOLF.md` | Instructions Claude follows every session |

## How It Works

Before Claude reads a file, OpenWolf tells it what the file contains and how large it is. If Claude already read that file this session, OpenWolf warns it. Before Claude writes code, OpenWolf checks your `cerebrum.md` for known mistakes. After every write, it auto-updates the project map and logs token usage. You see none of this. It just happens.

```
You type a message
    ↓
Claude decides to read a file
    ↓
OpenWolf: "anatomy.md says this file is ~380 tokens. Description: Main entry point."
    ↓
Claude reads the file → OpenWolf logs the read, checks for repeated reads
    ↓
Claude writes code → OpenWolf checks cerebrum.md for known mistakes
    ↓
Claude finishes → OpenWolf updates anatomy.md, appends to memory.md, updates the ledger
```

## Keeping `.wolf/` Healthy

The `.wolf/` directory is designed to stay small, but on very active projects you can compact it any time — no daemon required:

```bash
openwolf doctor --dry-run   # report footprint + warnings, change nothing
openwolf doctor             # compact ledger, consolidate memory, dedup buglog,
                            # prune backups, rotate logs, clear tmp
```

`openwolf status` shows the current footprint and warns before anything gets large.

### Tuning limits

Edit the `openwolf.retention` block in `.wolf/config.json` (defaults shown):

```json
{
  "openwolf": {
    "retention": {
      "token_ledger_max_sessions": 200,
      "session_io_max": 100,
      "buglog_max_entries": 200,
      "backups_keep": 10,
      "memory_consolidate_after_days": 7,
      "memory_max_bytes": 262144,
      "daemon_log_max_bytes": 524288
    }
  }
}
```

These survive `openwolf update` (config is deep-merged, not overwritten).

### Scoping with `.wolfignore`

Create a `.wolfignore` at your project root to exclude paths from anatomy scanning and hook tracking (gitignore-style):

```
vendor/
dist/
**/*.generated.ts
*.log
```

## Commands

```
openwolf init                 Initialize .wolf/ and register hooks
openwolf status               Show health, stats, .wolf/ footprint, size warnings
openwolf doctor               Report + compact .wolf/, suggest .wolfignore [--dry-run]
openwolf consolidate          LLM-merge near-duplicate cerebrum entries [--dry-run] [--threshold N]
openwolf lint                 Check the knowledge base against the protocol; prints a measured
                              compliance number [--strict] [--json] [--skip-links]
openwolf distill              File a drifted cerebrum.md back under its four sections [--dry-run]
openwolf recall <query>       Keyword-search .wolf + native memory; ids per hit [--limit N] [--full] [--all] [--json]
                              [--semantic] rank by meaning (local embeddings) · [--hybrid] fuse keyword + semantic
                              both work with [--all]: rank-fused across projects that already have an index
openwolf recall --id <id>     Expand a citation id to its full entry (second disclosure layer)
openwolf find <query>         Locate a symbol or file — ranked, with exact line ranges [--limit N] [--json]
openwolf link                 Link to a remote workspace [--url URL --token TOKEN] [--status] [--unlink]
openwolf push                 Offer learnings, decisions and bugs to the linked workspace [--dry-run]
openwolf export <what>        Export sessions|bugs as JSON or CSV [--format csv] [--out FILE]
openwolf mcp                  Run an MCP server (recall/resume/find/memory-health) [--project DIR]
openwolf scan                 Refresh the project structure map [--check]
openwolf dashboard            Open the real-time web dashboard
openwolf daemon <cmd>         start | stop | restart | logs — background task scheduler
openwolf cron <cmd>           list | run <id> | retry <id> — scheduled tasks
openwolf designqc             Capture full-page screenshots for design evaluation
openwolf bug search <term>    Search bug memory for known fixes
openwolf update               Update registered projects [--project NAME] [--dry-run] [--list]
openwolf unregister [path]    Drop a project from the registry, keeping its .wolf/ [--prune] [--dry-run]
openwolf restore [backup]     Restore .wolf/ from a timestamped backup
```

## Sharing a brain with a team (optional)

OpenWolf is local-first and stays that way: `.wolf/` is yours, on your disk, and nothing is uploaded
anywhere. If you *do* run a shared workspace — your own server, or a hosted one — a project can be
linked to it explicitly.

```bash
openwolf link --url https://workspace.example.com --token <token>
openwolf push --dry-run        # what would be offered
openwolf push                  # offer it
openwolf recall "csp" --team   # search your files AND the workspace
```

Ground rules, because a local-first tool that quietly ships your notes somewhere is not local-first:

- **Opt-in and explicit.** No background sync, no hook-time upload, no telemetry. Nothing leaves
  until you type `push`.
- **`<private>` blocks never leave the machine.** They are stripped before a candidate is even built.
- **Only durable knowledge is offered:** cerebrum Key Learnings, Decision Log, and `buglog.json`.
  `memory.md` is not a source — it is mostly mechanical file-write rows. User Preferences are skipped
  unless you pass `--with-preferences`; auto-detected bugs are skipped as pattern guesses.
- **The workspace decides.** Pushed entries arrive as needs-approval. A machine may propose; a human
  decides what enters the team's memory.
- **The token lives in `.wolf/remote-token` (0600), never in `config.json`** — which is committed.
  `init`/`update`/`link` keep `.wolf/.gitignore` in place so it cannot be committed by accident.
- **Local and team hits are shown as two lists, not merged.** A workspace ranks differently than a
  BM25 scan of markdown; interleaving the two under one invented score would be a fabricated
  ordering, not relevance. Team citations carry a `t-` prefix so they can never be confused with
  local ones.

No endpoint is hardcoded. `--url` points wherever you want.

## Design QC

Capture full-page screenshots of your running app and let Claude evaluate the design.

```bash
openwolf designqc
```

Auto-detects your dev server, captures viewport-height JPEG sections of every route, and saves them to `.wolf/designqc-captures/`. Then tell Claude to read the screenshots and evaluate. Requires `puppeteer-core`.

## Use in Claude Desktop (MCP)

OpenWolf's search and resume tools also run as an **MCP server**, so they work in the Claude Desktop
app — and any MCP client — not just Claude Code.

**One-click install (Desktop Extension).** Download `openwolf.mcpb` from the
[latest release](https://github.com/bassprofressor-lab/openwolf-enhanced/releases/latest) and open it —
Claude Desktop installs the bundle and prompts you to pick your project directory. No Node install, no
config editing; the bundle is self-contained (~8 KB). To build it yourself: `pnpm build && pnpm build:mcpb`
→ `dist-mcpb/openwolf.mcpb`.

**Manual (any MCP client).** Or, if you already have the `openwolf` CLI installed, register it by hand in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openwolf": {
      "command": "openwolf",
      "args": ["mcp", "--project", "/path/to/your/project"]
    }
  }
}
```

Either way it exposes three **read-only** tools: `openwolf_recall` (keyword-search this project's knowledge **and**
Claude's native Auto Memory), `openwolf_resume` (the resume digest), and `openwolf_memory_health`.
The hook-based auto-injection/auto-capture only applies inside Claude Code; here the tools are called
explicitly. OpenWolf never writes to Claude's native memory — it reads and surfaces it.

## FAQ

**Does OpenWolf send my code or memory anywhere?**
No. Everything lives in a local `.wolf/` directory in your project — plain Markdown and JSON, git-native, no database and no cloud. Nothing leaves your machine. (The only outbound calls are optional: the background cron AI tasks and `openwolf consolidate`, which you point at a provider of your choice.)

**How is this different from the original `openwolf`?**
They are separate lineages now, not a maintained fork of an abandoned project. This package forked upstream's **1.x** code in 2026; upstream has since shipped a **2.x rewrite** and is actively developed. Neither tracks the other. What this fork adds on top of the 1.x base: bounded/self-maintaining storage, BM25 memory search with citations, an MCP server, model-agnostic AI tasks, multi-agent support, and ~15 security fixes — while staying a drop-in replacement for the same `openwolf` command. If you want upstream's 2.x work, install `openwolf`.

**Does it work with anything other than Claude Code?**
Yes. `init`/`update` auto-detect **Codex CLI**, **Gemini CLI** and **OpenCode** and register the same hooks there. The `openwolf mcp` server also exposes recall/resume to **Claude Desktop** and any MCP client.

**Do I need an API key?**
Not for the core — the hooks, memory, recall and `doctor` are all deterministic and run offline. An API key is only needed for the optional background AI tasks and `openwolf consolidate`, and those work with any Anthropic- or OpenAI-compatible provider (including free ones).

**Will it slow down my coding sessions?**
No. Hooks are small Node scripts with short timeouts; they update the index and memory in the background and inject a compact, token-bounded digest at session start.

## Requirements

- Node.js 20+
- An agent CLI: **Claude Code**, **Codex CLI**, **Gemini CLI**, or **OpenCode** (Claude Code is the primary target)
- Windows, macOS, or Linux
- Optional: PM2 for the persistent background daemon/dashboard
- Optional: an Anthropic- or OpenAI-compatible API key for cron AI tasks and `openwolf consolidate`
- Optional: `puppeteer-core` for Design QC screenshots

## Limitations

- Claude Code hooks are a relatively new feature. OpenWolf falls back to `CLAUDE.md` instructions when hooks don't fire.
- Token tracking is estimation-based (character-to-token ratio), not exact API counts. Accurate to within ~15%.
- `cerebrum.md` depends on Claude following instructions to update it after corrections, so it drifts.
  Run `openwolf lint` for a measured number instead of a guess: it checks the conventions that are
  mechanically checkable (the four sections, dated Do-Not-Repeat entries, buglog records that carry
  `root_cause` and `fix`, references that resolve) and reports an item-weighted percentage. On this
  project's own year-old knowledge base it reads **86.7%**. What it cannot see is whether the right
  thing was learned — that stays unmeasurable, and the output says so.
- Structure erodes with age rather than at birth: a young project still matched the template exactly
  while a year-old one had grown to 52 headings with 47% of the file past the last section the
  template knows. `openwolf distill` files it back — moving text and never rewriting it.

## Credits

OpenWolf was created by [Cytostack Pvt Ltd](https://github.com/cytostack/openwolf) (Farhan Palathinkal Afsal). This enhanced fork is maintained by **[Krynex Labs](https://krynexlabs.de)** — AI engineering & automation. Huge thanks to the original authors for the design and the idea.

## License

**AGPL-3.0** — same as the original. See [LICENSE](LICENSE) and [NOTICE](NOTICE). As a derivative work under the AGPL, this fork preserves the original copyright and remains AGPL-3.0; if you run a modified version as a network service, you must make your source available to its users.
