# Changelog

All notable changes to **OpenWolf Enhanced** are documented here.

This is a fork of [OpenWolf](https://github.com/cytostack/openwolf) by Cytostack
Pvt Ltd. Versions ≤ 1.0.4 refer to the upstream project; `1.1.0` is the first
release of this fork.

## [1.2.1] — 2026-07-09

More adopted upstream bug fixes.

### Fixed
- **`.gitignore` is now respected (#15 by @VimCommando).** Anatomy scanning and hook tracking
  honor `.gitignore` in addition to `.wolfignore`, so build output / generated / ignored files
  don't get indexed.
- **`init` no longer scaffolds `$HOME` (#20 by @shikyo13).** `findProjectRoot` stops at the home
  directory, so a stray marker (`.git` / `package.json`) in `$HOME` can't make `openwolf init`
  treat the whole home directory as a project.
- **Dashboard/daemon port collisions across projects (#20).** `init` bumps this project's ports
  if another registered project already uses them.

_Note: #45 (buglog available for de-dup before fixing) is already covered — the OPENWOLF.md
protocol instructs reading `.wolf/buglog.json` before fixing, and the pre-write hook surfaces
similar past bugs._

## [1.2.0] — 2026-07-09

Adopts a batch of security and correctness fixes that were reported/proposed upstream but
never merged (the upstream repo has been inactive since March 2026). Credit to the original
reporters and PR authors — issue/PR numbers refer to `cytostack/openwolf`.

### Security
- **Dashboard is no longer network-exposed.** The daemon now binds to `127.0.0.1` by default
  (was `0.0.0.0`) and requires a per-project token (`.wolf/dashboard-token`, `0600`) on every
  `/api/*` request and WebSocket connection — WS is rejected pre-upgrade. This closes an
  unauthenticated path to trigger arbitrary cron tasks. Token is threaded through
  `openwolf dashboard` and `openwolf cron run`. Configurable via `openwolf.dashboard.host`.
  (upstream #30 by @svanack404, #34 by @riverwolf67)
- **Command-injection surface removed.** All `execSync` string commands (PM2 start/stop/
  restart/logs, port/pid lookups) are now `execFileSync` with argument arrays, and the PM2
  process name derived from the project folder is sanitized. (upstream #34)
- **Path traversal blocked** in cron AI tasks: `context_files` that escape the project root
  (e.g. `../../etc/passwd`) are rejected before being read into the model prompt. (upstream #34)

### Fixed
- **CRLF data loss (#50 by @albertomenache; PRs #24 @fsener, #51).** `parseAnatomy` split on
  `\n`, leaving a trailing `\r` that broke the end-anchored entry regex — on Windows/autocrlf
  this dropped every entry and truncated `anatomy.md` to an empty skeleton. Now splits on
  `\r?\n` in both copies.
- **Secret files captured into the brain (#54 by @bryandent).** Only `.env*` was excluded;
  private keys, certs and keystores (`.pem`, `.key`, `.p8`, `.p12`, `.keystore`, `id_rsa`,
  `credentials`, …) leaked their first ~100 chars into `anatomy.md`. Now excluded everywhere
  (anatomy scan + post-write + post-read).
- **`bug search` crash on schema drift (#44 by @GordongWang).** `searchBugs` and the result
  display are null-safe and handle entries that use a `files: string[]` array instead of a
  singular `file`.
- **Repeated-read warning after edits (#41 by @1re2turn1).** `pre-read` now tracks file mtime
  and doesn't warn "already read" when the file changed during the session — a re-read after
  an edit is legitimate.
- **Files outside the project root (#56 by @goashem).** `post-write`/`post-read`/`pre-read` no
  longer track absolute paths outside the project (`../` escapes) in anatomy/memory/ledger.

## [1.1.0] — 2026-07-09

Based on upstream OpenWolf `1.0.4`. This release focuses on **bounded storage**,
**self-maintenance**, and **scoping** — the `.wolf/` directory no longer grows
without limit, and it can be kept healthy with a single command.

### Added
- **`openwolf doctor`** — a daemon-independent command that reports the `.wolf/`
  footprint and size warnings, then compacts everything: trims the token ledger,
  consolidates old `memory.md` sessions, de-duplicates and caps `buglog.json`,
  prunes old backups, rotates `daemon.log`, and clears stale `.tmp` files.
  Use `--dry-run` to report without writing.
- **`.wolfignore`** — gitignore-style file at the project root that scopes both
  anatomy scanning and hook tracking (dir names, path prefixes, `*.ext`, `**`).
- **`openwolf.retention` config block** — every storage limit is now tunable
  (`token_ledger_max_sessions`, `session_io_max`, `buglog_max_entries`,
  `backups_keep`, `memory_consolidate_after_days`, `memory_max_bytes`,
  `daemon_log_max_bytes`).
- **`openwolf status`** now reports the `.wolf/` footprint, per-file sizes, and
  warnings when a file exceeds its limit.
- Stop hook opportunistically consolidates `memory.md` when it exceeds
  `memory_max_bytes`, so maintenance happens even without a running daemon.

### Changed
- `openwolf update` now **deep-merges** `config.json` (user values win, new
  default keys are added) instead of overwriting it — tuned settings survive.
- Large files are trimmed for dashboard delivery, and the file watcher no longer
  re-reads/broadcasts `token-ledger.json` / `buglog.json` on every write.

### Fixed
- **Unbounded `token-ledger.json` growth.** `sessions[]` (each embedding full
  `reads[]`/`writes[]`) and `waste_flags[]` were never trimmed, so the ledger
  could grow into the tens of megabytes and make the stop hook's full-file
  rewrite quadratic. Now bounded by `openwolf.retention`.
- **Unbounded `buglog.json` growth and over-eager auto-detection.** The
  "significant diff" catch-all logged nearly every real refactor as a bug; the
  de-dup window was too short; IDs could collide after trimming. The catch-all
  was removed, the window widened, IDs are derived from the max existing ID, and
  the log is capped.
- **`anatomy.md` full rewrite on every write.** It is now skipped when a file's
  entry is unchanged, and the edited file is read only once per write.
- **Legacy bare-array `buglog.json`** (`[...]` instead of `{ version, bugs }`) is
  now read tolerantly and migrated on write without data loss — previously it
  could crash the pre-write hook and silently disabled auto-detection.

### Notes
- The CLI command remains `openwolf`, so this is a drop-in replacement.
- License unchanged: **AGPL-3.0**. See `LICENSE` and `NOTICE`.
