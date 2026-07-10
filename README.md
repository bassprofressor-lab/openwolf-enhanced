<p align="center">
  <img src="openwolf-icon.png" alt="OpenWolf Enhanced" width="120" />
</p>

<h1 align="center">OpenWolf Enhanced</h1>

<p align="center">
  <strong>A second brain for Claude Code — now with bounded storage and self-maintenance.</strong><br />
  Project intelligence, token tracking, and invisible enforcement through 6 hook scripts. Zero workflow changes.
</p>

<p align="center">
  🌐 <strong>English</strong> · <a href="docs/i18n/README.de.md">Deutsch</a>
</p>

<p align="center">
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

## Why OpenWolf Exists

Claude Code is powerful but it works blind. It doesn't know what a file contains until it opens it. It can't tell a 50-token config from a 2,000-token module. It reads the same file multiple times in one session without noticing. It has no index of your project, no memory of your corrections, and no awareness of what it already tried.

OpenWolf gives Claude a second brain: a file index so it knows what files contain before reading them, a learning memory that accumulates your preferences and past mistakes, and a token ledger that tracks everything. All through 6 invisible hook scripts that fire on every Claude action.

## What's Enhanced

Everything upstream does, plus — grouped by what it gives you:

| Area | Enhancement |
|------|-------------|
| 🩺 **Self-maintenance** | `openwolf doctor` reports the `.wolf/` footprint and compacts everything (ledger, memory, bug log, backups, logs, tmp), flags cross-project registry issues, and suggests `.wolfignore` entries for noisy dirs. `--dry-run` previews. |
| 📦 **Bounded, tunable storage** | Ledger, bug log, cron queues and waste flags are all capped — no runaway multi-MB files. Every limit lives in `openwolf.retention` and survives updates (config is deep-merged, not overwritten). |
| 🧭 **Smart session resume** | On session start a compact, token-bounded digest is injected — STATUS + Do-Not-Repeat inline, recent activity as a one-line headline, the rest as an *"Available on demand"* index — so the model continues without re-reading. |
| 🔎 **Searchable memory** | `openwolf recall <query>` keyword-searches STATUS / cerebrum / memory / buglog **and Claude's native Auto Memory**, returning a compact `file:line` index. A query interface with no database. |
| 🧠 **Native-memory interop** | Reads Claude Code's own Auto Memory (read-only): `doctor` flags its blind spots (files the `MEMORY.md` index never loads, the 200-line cutoff, dead links), a dashboard panel browses it, and an **MCP server** (`openwolf mcp`) exposes recall/resume to **Claude Desktop** and other MCP clients — so OpenWolf works beyond Claude Code. |
| 🔒 **Privacy** | `<private>…</private>` content in any `.wolf` file is kept out of the injected context and out of search. |
| 🗒 **Structured summaries** | Each session gets a `Did / Learned / Next / Files` scaffold, keeping memory consistent and greppable. |
| 📤 **Export** | `openwolf export <sessions\|bugs>` to JSON or CSV (RFC 4180). |
| 🎯 **`.wolfignore`** | gitignore-style scoping for anatomy scanning **and** hook tracking; `doctor` suggests what to add. |
| 📊 **Dashboard** | Deep-linkable panels, a cross-project **All Projects** view, jump-to-file from AI insights, a Design QC thumbnail grid + lightbox, and a daemon-down banner. |
| 🔒 **Security & correctness** | Dashboard bound to loopback and token-gated, no command injection / path traversal, secret-file exclusion (`.pem`/`.key`/`id_rsa`…), plus ~15 adopted upstream security & bug fixes the inactive upstream never merged. |
| 🚀 **Trusted releases** | Published to npm via GitHub OIDC — no long-lived token — with SLSA provenance; CI builds and tests on every push. |

Every change is versioned in the [CHANGELOG](CHANGELOG.md); attribution is in the [NOTICE](NOTICE).

## Quick Start

```bash
npm install -g openwolf-enhanced
```

> **Note:** this is the maintained fork. `npm install -g openwolf` installs the
> original `openwolf` (last released 1.0.4, March 2026, unmaintained) — a different
> package. Install `openwolf-enhanced` for the bounded-storage, self-maintenance and
> security work described above. Both provide the same `openwolf` command.

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
| `hooks/` | 6 Claude Code lifecycle hooks (pure Node.js) |
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
openwolf recall <query>       Keyword-search .wolf + Claude's native memory [--limit N] [--json]
openwolf export <what>        Export sessions|bugs as JSON or CSV [--format csv] [--out FILE]
openwolf mcp                  Run an MCP server (recall/resume/memory-health) [--project DIR]
openwolf scan                 Refresh the project structure map [--check]
openwolf dashboard            Open the real-time web dashboard
openwolf daemon <cmd>         start | stop | restart | logs — background task scheduler
openwolf cron <cmd>           list | run <id> | retry <id> — scheduled tasks
openwolf designqc             Capture full-page screenshots for design evaluation
openwolf bug search <term>    Search bug memory for known fixes
openwolf update               Update registered projects [--project NAME] [--dry-run] [--list]
openwolf restore [backup]     Restore .wolf/ from a timestamped backup
```

## Design QC

Capture full-page screenshots of your running app and let Claude evaluate the design.

```bash
openwolf designqc
```

Auto-detects your dev server, captures viewport-height JPEG sections of every route, and saves them to `.wolf/designqc-captures/`. Then tell Claude to read the screenshots and evaluate. Requires `puppeteer-core`.

## Use in Claude Desktop (MCP)

OpenWolf's search and resume tools also run as an **MCP server**, so they work in the Claude Desktop
app — and any MCP client — not just Claude Code. Add it to your `claude_desktop_config.json`:

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

It exposes three **read-only** tools: `openwolf_recall` (keyword-search this project's knowledge **and**
Claude's native Auto Memory), `openwolf_resume` (the resume digest), and `openwolf_memory_health`.
The hook-based auto-injection/auto-capture only applies inside Claude Code; here the tools are called
explicitly. OpenWolf never writes to Claude's native memory — it reads and surfaces it.

## Requirements

- Node.js 20+
- Claude Code CLI
- Windows, macOS, or Linux
- Optional: PM2 for persistent background tasks
- Optional: `puppeteer-core` for Design QC screenshots

## Limitations

- Claude Code hooks are a relatively new feature. OpenWolf falls back to `CLAUDE.md` instructions when hooks don't fire.
- Token tracking is estimation-based (character-to-token ratio), not exact API counts. Accurate to within ~15%.
- `cerebrum.md` depends on Claude following instructions to update it after corrections. Compliance is ~85–90%, not 100%.

## Credits

OpenWolf was created by [Cytostack Pvt Ltd](https://github.com/cytostack/openwolf) (Farhan Palathinkal Afsal). This enhanced fork is maintained by **[Krynex Labs](https://krynexlabs.de)** — AI engineering & automation. Huge thanks to the original authors for the design and the idea.

## License

**AGPL-3.0** — same as the original. See [LICENSE](LICENSE) and [NOTICE](NOTICE). As a derivative work under the AGPL, this fork preserves the original copyright and remains AGPL-3.0; if you run a modified version as a network service, you must make your source available to its users.
