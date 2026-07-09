# Changelog

All notable changes to **OpenWolf Enhanced** are documented here.

This is a fork of [OpenWolf](https://github.com/cytostack/openwolf) by Cytostack
Pvt Ltd. Versions ≤ 1.0.4 refer to the upstream project; `1.1.0` is the first
release of this fork.

## [1.9.0] — 2026-07-09

Dashboard & CLI quick wins — usability and self-diagnosis, verified headless (Chromium).

### Added
- **Daemon-down banner (dashboard).** When the daemon is unreachable, panels used to render empty —
  indistinguishable from a genuinely empty project. The dashboard now shows a dismissable warning
  banner (with a "retry" button that re-fetches + reconnects) whenever the WebSocket is disconnected
  after load. `useWolfData` exposes a `retry()` action for this.
- **Design QC image thumbnails + lightbox.** The Design QC panel showed only capture *filenames*.
  It now renders each capture as a thumbnail grid; clicking one opens a full-size lightbox. Served by
  a new path-safe, token-gated daemon route `GET /api/designqc/capture/:file` (with
  `dotfiles: "allow"` — captures live under the `.wolf/` dotdir, which Express 5's `sendFile` ignores
  by default).
- **`openwolf doctor` cross-project checks.** Doctor now reports registry health: **dead entries**
  (registered project whose path no longer exists) and **dashboard-port collisions** (multiple
  projects sharing a `dashboard.port`, whose daemons would collide). Exactly the failure modes that
  bit a multi-project setup — now surfaced with the fix hint.

### Fixed
- **Chart tooltips are theme-aware.** `TokenUsage` tooltips hard-coded dark colors (`#1a1a1a`), making
  them unreadable in light mode. They now use the theme's CSS variables.

### Notes
- Verified with a headless Chromium harness: Design QC thumbnails render and load, the lightbox opens,
  and the daemon-down banner appears when the daemon is killed — with zero page/console errors. The
  capture route returns `200 image/png`; path traversal (`../config.json`) is rejected. Doctor
  correctly reports both a healthy 5-project registry and an injected port collision.

## [1.8.0] — 2026-07-09

Dependency currency pass (dev + runtime majors) plus a latent file-watcher fix surfaced by the chokidar bump.

### Fixed
- **File-watcher `ignored` never fired (latent since the chokidar 4 adoption).** chokidar 4+ dropped
  glob-string support in the `ignored` option — a glob like `**/token-ledger.json` is treated as a
  literal path and never matches, so the watcher was silently re-reading and broadcasting the full
  contents of `token-ledger.json` / `buglog.json` / `*.tmp` / `*.lock` on every write — the exact
  waste the ignore list was meant to prevent. Replaced the glob array with a `(path) => boolean`
  predicate so the exclusions actually apply. Verified with an isolated chokidar test (glob strings
  let `junk.tmp` and `token-ledger.json` through; the predicate correctly ignores them).

### Changed
- **Dev-dependency majors:** TypeScript 5.9 → 7.0, Vite 6 → 8, `@vitejs/plugin-react` 4 → 6,
  recharts 2 → 3, `@types/node` 22 → 26, `@tailwindcss/vite` → 4.3. Build (main + hooks +
  dashboard) and the 8-test suite stay green.
  - `tsconfig.hooks.json` now sets `"types": ["node"]` explicitly — TypeScript 7's `@types`
    auto-discovery behaves differently for the hooks project's `rootDir: "src/hooks"`.
- **Runtime-dependency majors:** chokidar 4 → 5, commander 12 → 15, node-cron 3 → 4, open 10 → 11,
  puppeteer-core 24 → 25. Smoke-tested: CLI (`--version`/`--help`) under commander 15, and the
  daemon boots and serves HTTP with node-cron 4 (all cron tasks scheduled), chokidar 5 (watcher),
  express 5, and ws.
  - node-cron 4 moved `ScheduledTask` from a namespace (`cron.ScheduledTask`) to a named type
    export — updated the import in `cron-engine.ts` accordingly.

### Removed
- **`chalk`** — it was declared but never imported anywhere in `src/`; dropped rather than upgraded.
- **`@types/node-cron`** — node-cron 4 ships its own type definitions, so the separate `@types`
  package is now redundant (and would conflict).

### Notes
- Audit is unchanged at 0 vulnerabilities (`pnpm audit --prod`); these bumps are currency/maintenance.
- The Claude API call in `cron-engine.ts` was reviewed: `anthropic-version: 2023-06-01` is the current
  stable API version header and `claude-haiku-4-5-20251001` is a current, active model ID — no change
  needed.

## [1.7.0] — 2026-07-09

Hardening and quality pass from the self-audit.

### Added
- **File locking for the token ledger (M1).** The read-modify-write of `token-ledger.json` in the
  stop hook and the cron token report is now wrapped in a best-effort advisory lock, so two
  sessions ending at once (or a session plus the cron report) can't clobber each other. The lock
  never blocks a hook for long — it waits up to ~1s, steals a stale lock (>5s), and proceeds
  unlocked rather than risk a hook timeout. `.lock` files are ignored by the watcher and scanner.
- **Test suite.** `pnpm test` runs `node --test` over the core logic — retention/ledger caps,
  buglog legacy-array migration + de-dup, the `.gitignore`/`.wolfignore` matcher, secret-file
  detection, CRLF-tolerant anatomy parsing, and config/retention defaults (8 tests).

### Security
- **`/api/switch` only accepts registered projects.** Previously any authenticated request could
  point the daemon at an arbitrary directory containing a `.wolf/`; it now must match a project in
  the registry.

### Notes
- The package is npm-publish ready (`npm pack` ships only `dist/`, templates and license/docs) —
  publishing under `openwolf-enhanced` would enable `npm i -g openwolf-enhanced`.

## [1.6.1] — 2026-07-09

Security patch — resolves all advisories reported by `pnpm audit` (found in a self-audit).

### Security
- **`ws` → 8.21.0** — fixes a high-severity memory-exhaustion DoS and a moderate uninitialized
  memory disclosure in the WebSocket server (a direct, network-facing dependency).
- **`express` → 5.2.1** plus pinned overrides forcing patched transitive deps — `path-to-regexp`
  (≥8.4.0, DoS/ReDoS on the HTTP router), `qs` (≥6.15.2, DoS in query parsing), and, for
  cleanliness, `basic-ftp`/`ip-address` (via the optional `puppeteer-core` chain) and `uuid`
  (via `node-cron`). `pnpm audit --prod` now reports **0 vulnerabilities**.

### Fixed
- **AI API calls can no longer hang forever.** `runViaApi` now aborts after 120s (the old
  `claude` subprocess path had a 120s timeout; `fetch` had none), so a stuck request can't
  wedge a cron task.

### Changed
- `pnpm build` runs end-to-end again (`allowBuilds: esbuild: true` in `pnpm-workspace.yaml`),
  so the dashboard builds without a manual `pnpm rebuild esbuild`.

## [1.6.0] — 2026-07-09

Completes upstream PR #4 — the larger dashboard sub-features, adapted to this fork's
authenticated, per-project dashboard.

### Added
- **In-place project switcher (#4, bug 7).** A dropdown in the dashboard header lists your
  registered projects and hot-swaps to one via `POST /api/switch` — the daemon stops and
  restarts the cron engine and file watcher for the new project and broadcasts its state over
  the existing WebSocket, with no process restart. The dashboard token is per-daemon, so an
  authenticated session survives the switch. Verified: switching from project A to B swaps the
  served project while the token keeps working.
- **Design QC works on deployed URLs and can be run from the dashboard (#4, bug 4).** A new
  `detectDeployedUrl()` reads the target URL from `package.json` `homepage`, env files, or
  `vercel.json`; a "Run Capture" button posts to `POST /api/designqc/run`; and the capture engine
  now writes `designqc-report.json` so the panel shows the result.
- **AI Insights shows a copy-able prompt (#4, bug 2 client).** Since a background daemon can't
  drive the interactive CLI, the panel offers a ready-to-paste prompt for a Claude Code session
  instead of a button that opened the desktop app.

### Changed
- **Honest status indicators (#4, bug 6).** The always-green "Healthy" sidebar badge is gone; the
  header's "Live" indicator now reflects the real WebSocket connection (it can genuinely drop under
  this fork's auth or during a project switch), and the overview uses the real cron `engine_status`.
- All new dashboard endpoints (`/api/projects`, `/api/switch`, `/api/designqc/run`, `/api/config`)
  are behind the dashboard-token auth, and every new client call uses the authenticated fetch.

## [1.5.0] — 2026-07-09

Adopts the core of upstream PR #4 (dashboard fixes by @MyEditHub), adapted to this fork's
authenticated dashboard.

### Fixed
- **"Run Now" now works and gives feedback (#4).** The button posts to `/api/cron/run/:id`
  (via the authenticated fetch — a plain fetch would 401 under this fork's dashboard auth); the
  endpoint returns `202` and runs the task in the background, and a permanent failure is broadcast
  as `task_error` so the UI shows the real error instead of resetting silently.
- **AI tasks no longer try to launch the desktop app (#4).** A background daemon can't drive the
  interactive `claude` CLI; AI cron tasks now call the Anthropic API directly when
  `ANTHROPIC_API_KEY` is set, and fail with a clear, actionable message when it isn't. Context
  files are capped at 20 KB.
- **Cron execution log is written again (#4).** A partial `cron-state.json` (missing
  `execution_log`) used to make every successful run look like a failure via an uncaught
  `TypeError`; `readState` now merges stored state over complete defaults.
- **Token graph shows date *and* time (#4);** the token-comparison chart uses only real tracked
  numbers (no fabricated "OpenClaw" bar), with honest labels, a transparent bar background and
  readable tooltips.
- **`openwolf` binary keeps its execute bit (#4)** — `build` and a `postinstall` hook `chmod +x`
  the CLI, which `tsc` otherwise strips on every build.

_Deferred to a follow-up: the larger sub-features of #4 — Design QC on deployed URLs, the
"Live"/health badge cleanup, and the in-place project switcher — which touch this fork's auth and
multi-project handling and warrant their own pass._

## [1.4.0] — 2026-07-09

### Added
- **`STATUS.md` — a session handoff document (#40 by @meketreve).** `openwolf init` now creates
  `.wolf/STATUS.md` with sections for what's done (✅), the next quest (🚀), active architecture
  (📁), pending items (⚠️) and useful commands (🔧). Reading it first when resuming a session
  restores context in a single read instead of stitching it together from several files. The
  protocol and rules instruct reading it first and updating it when a quest ends; the stop hook
  nudges (once per session, via `additionalContext`) if it's missing or stale after real code
  changes. `STATUS.md` is treated as user data — never overwritten by `update`, included in backups.

## [1.3.1] — 2026-07-09

### Changed
- **Stop-hook reminders no longer repeat every turn.** Each reminder type (missing buglog,
  stale cerebrum, no memory summary) is now surfaced at most once per session — tracked in
  `_session.json` — so it nudges once instead of re-firing on every turn.

## [1.3.0] — 2026-07-09

Adopts a batch of upstream pull requests (never merged upstream), adapted to this fork.

### Added
- **End-of-turn reminders now reach Claude (#55 by @JarrodAI).** The stop hook's reminders
  (files edited 3+ times without a buglog entry, stale `cerebrum.md`, and — new — no
  meaningful `memory.md` summary) were written to stderr, which Claude Code never surfaces to
  the model. They're now emitted via the `additionalContext` stdout channel, so they actually
  land in the next context window.
- **Dart support (#10 by @levnikmyskin).** `.dart` files are treated as code for token
  estimation (description extraction already existed).

### Changed
- **Hook entries are tagged `_managedBy: "openwolf"` (#32 by @mann1x).** `init`/`update` mark
  the `.claude/settings.json` entries they own, so they can be cleanly replaced/removed even if
  a user relocates the hook script — while leaving unrelated hooks untouched.

### Fixed
- **`EPERM` on WSL2 9P + EFS (#33 by @WeathermanTony).** `init`/`update`/`restore` now copy
  files with a `safeCopyFile` read+write shim instead of `fs.copyFileSync`, whose
  `copy_file_range` fast path fails on WSL2 mounts under EFS-encrypted NTFS directories.

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
