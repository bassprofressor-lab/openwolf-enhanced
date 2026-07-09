# Changelog

All notable changes to **OpenWolf Enhanced** are documented here.

This is a fork of [OpenWolf](https://github.com/cytostack/openwolf) by Cytostack
Pvt Ltd. Versions ≤ 1.0.4 refer to the upstream project; `1.1.0` is the first
release of this fork.

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
