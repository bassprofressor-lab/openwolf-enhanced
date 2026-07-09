<p align="center">
  <img src="openwolf-icon.png" alt="OpenWolf Enhanced" width="120" />
</p>

<h1 align="center">OpenWolf Enhanced</h1>

<p align="center">
  <strong>A second brain for Claude Code — now with bounded storage and self-maintenance.</strong><br />
  Project intelligence, token tracking, and invisible enforcement through 6 hook scripts. Zero workflow changes.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-green.svg" alt="Node.js" /></a>
  <a href="https://github.com/cytostack/openwolf"><img src="https://img.shields.io/badge/fork%20of-cytostack%2Fopenwolf-lightgrey.svg" alt="Fork of cytostack/openwolf" /></a>
  <a href="https://krynexlabs.de"><img src="https://img.shields.io/badge/by-Krynex%20Labs-6D28D9.svg" alt="by Krynex Labs" /></a>
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

Everything from upstream still works. On top of that:

| Area | Enhancement |
|------|-------------|
| 🩺 **Self-maintenance** | New `openwolf doctor` — a daemon-independent command that reports the `.wolf/` footprint and compacts everything (ledger, memory, bug log, backups, logs, tmp). `--dry-run` to preview. |
| 📦 **Bounded storage** | `token-ledger.json`, `buglog.json`, cron dead-letter queue and waste flags are all capped. No more runaway multi-MB files. |
| 🎯 **`.wolfignore`** | gitignore-style scoping for anatomy scanning **and** hook tracking. Stop indexing `vendor/`, generated code, or `*.log`. |
| ⚙️ **Tunable retention** | New `openwolf.retention` config block — every limit is user-adjustable. |
| 🔁 **Non-destructive updates** | `openwolf update` now **deep-merges** `config.json` instead of overwriting it, so your settings survive. |
| 🧹 **Less churn** | `anatomy.md` isn't rewritten when nothing changed; the daemon no longer re-broadcasts large files on every write; auto bug-detection no longer flags ordinary refactors. |
| 📏 **Visibility** | `openwolf status` now shows the `.wolf/` footprint and size warnings. |

### Security & correctness hardening (1.2.0)

This fork also adopts security and bug fixes that were reported/proposed upstream but never
merged (the upstream repo has been inactive since March 2026):

- 🔒 **Dashboard is no longer network-exposed** — binds to `127.0.0.1` (was `0.0.0.0`) and
  requires a per-project token on every API request and WebSocket connection, closing an
  unauthenticated path to trigger cron tasks. *(upstream #30, #34)*
- 🔒 **No command injection** — shell command strings replaced with argument arrays
  (`execFileSync`); the PM2 process name is sanitized. *(upstream #34)*
- 🔒 **No path traversal** — cron AI tasks can't read files outside the project root. *(upstream #34)*
- 🛡 **No secret leakage** — private keys, certs and keystores (`.pem`, `.key`, `.p8`,
  `.keystore`, `id_rsa`, `credentials`…) are excluded from the brain, not just `.env`. *(upstream #54)*
- 🐛 **CRLF no longer wipes `anatomy.md`** — the entry parser tolerates `\r\n`, so Windows /
  `git autocrlf` repos don't get their file map truncated. *(upstream #50)*
- 🐛 **`bug search` won't crash** on entries with missing fields or a `files[]` array. *(upstream #44)*
- 🐛 **Re-reads after edits aren't flagged** — a file that changed during the session can be
  re-read without a "already read" warning. *(upstream #41)*
- 🐛 **No off-project tracking** — files outside the project root never enter anatomy/memory. *(upstream #56)*
- 🐛 **Saner auto bug-detection** — the noisy "any big diff is a bug" heuristic was removed. *(upstream #28)*
- 🐛 **`.gitignore` is respected** — anatomy scanning and hook tracking honor `.gitignore` (not just `.wolfignore`), so ignored/build files aren't indexed. *(upstream #15)*
- 🐛 **`init` won't scaffold `$HOME`** — `findProjectRoot` stops at the home directory, and multi-project port collisions are avoided. *(upstream #20)*

### Adopted upstream PRs (1.3.x)

Useful upstream pull requests that were never merged, adapted to this fork:

- 💬 **End-of-turn reminders actually reach Claude** — the stop hook's reminders (unlogged bug
  fixes, stale `cerebrum.md`, missing session summary) were written to stderr, which the model
  never sees; they now use the `additionalContext` stdout channel, and each fires **at most
  once per session** instead of nagging every turn. *(upstream #55)*
- 🖥 **Works on WSL2 / EFS** — file copies use a read+write shim, fixing `EPERM` on WSL2 mounts
  under EFS-encrypted directories. *(upstream #33)*
- 🏷 **Cleaner hook management** — `.claude/settings.json` entries are tagged `_managedBy:
  "openwolf"`, so `init`/`update` can replace/remove only their own hooks. *(upstream #32)*
- 🎯 **Dart support** — `.dart` files are recognized for token estimation. *(upstream #10)*

Full details in the [CHANGELOG](CHANGELOG.md) and [NOTICE](NOTICE).

## Quick Start

Not published to a package registry — install from source:

```bash
git clone https://github.com/bassprofressor-lab/openwolf-enhanced.git
cd openwolf-enhanced
pnpm install
pnpm build            # builds CLI, hooks, and dashboard
npm install -g .      # installs the `openwolf` command globally
```

Then, in any project:

```bash
cd your-project
openwolf init
```

That's it. Use `claude` normally. OpenWolf is watching.

> **Upgrading the tool?** The hooks that actually run are **per-project copies** in
> `<project>/.wolf/hooks/`, not the global package. After rebuilding/reinstalling, run
> `openwolf update` (or `openwolf update --project <name>`) to copy the new hooks into your
> projects — a global reinstall alone does not update them. `openwolf update` with no
> `--project` updates **all** registered projects.

## What It Creates

`openwolf init` creates a `.wolf/` directory in your project:

| File | Purpose |
|------|---------|
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
openwolf init              Initialize .wolf/ and register hooks
openwolf status            Show health, stats, .wolf/ footprint, size warnings
openwolf doctor            Report + compact .wolf/ (daemon-independent) [--dry-run]
openwolf scan              Refresh the project structure map
openwolf scan --check      Verify anatomy matches filesystem (exits 1 if stale)
openwolf dashboard         Open the real-time web dashboard
openwolf daemon start      Start background task scheduler
openwolf daemon stop       Stop the scheduler
openwolf daemon restart    Restart the scheduler
openwolf daemon logs       View scheduler logs
openwolf cron list         Show all scheduled tasks
openwolf cron run <id>     Trigger a task manually
openwolf cron retry <id>   Retry a dead-lettered task
openwolf designqc          Capture full-page screenshots for design evaluation
openwolf bug search <term> Search bug memory for known fixes
openwolf update            Update registered projects (deep-merges config)
openwolf restore [backup]  Restore .wolf/ from a timestamped backup
```

## Design QC

Capture full-page screenshots of your running app and let Claude evaluate the design.

```bash
openwolf designqc
```

Auto-detects your dev server, captures viewport-height JPEG sections of every route, and saves them to `.wolf/designqc-captures/`. Then tell Claude to read the screenshots and evaluate. Requires `puppeteer-core`.

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
