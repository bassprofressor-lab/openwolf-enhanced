# Changelog

All notable changes to **OpenWolf Enhanced** are documented here.

This is a fork of [OpenWolf](https://github.com/cytostack/openwolf) by Cytostack
Pvt Ltd. Versions ≤ 1.0.4 refer to the upstream project; `1.1.0` is the first
release of this fork.

## [1.19.0] — 2026-07-19

### Fixed

- **Maintenance operations now hold the file lock while they read-modify-write.** `compactLedger`,
  `consolidateMemory` and `dedupeAndCapBuglog` (run by `openwolf doctor`) and `markPushed` (run by
  `openwolf push`) wrote `token-ledger.json` / `memory.md` / `buglog.json` / `remote-pushed.json`
  without a lock, while the daemon and stop-hook write the same files *with* `withLock`. Running a
  compaction next to a live write could silently drop the concurrent update. All four now take the
  same lock, so each read-modify-write is atomic.
- **`writeCerebrumFromAi` no longer overwrites `cerebrum.md` when the backup write fails.** The
  pre-write backup sat in a `try/catch` that swallowed *every* error and then overwrote anyway — a
  failed backup (disk full, permissions) destroyed the original with no copy. The backup now runs
  outside the catch: if it throws, the overwrite never happens. Same data-loss class as bug-157.
- **`splitForContext` no longer cuts a multi-byte character in half.** The hard-cut path for an
  oversized single paragraph sliced by UTF-16 code units against a *byte* budget — it could exceed the
  budget and split a multi-byte char / surrogate pair into invalid UTF-8. It now accumulates whole code
  points up to the byte budget.

### Changed

- **Recall matching is anchored at the start of a word (prefix) instead of anywhere in it (substring).**
  A query `port` still matches `ports`/`portal` (prefix) but no longer spuriously matches `report`
  mid-word, which was distorting BM25 term frequencies. Tokenisation is now Unicode-aware, so umlauts
  stay inside a word.

## [Unreleased]

### Added

- **Semantic recall (`openwolf recall --semantic` / `--hybrid`).** Alongside the lexical BM25 search,
  recall can now rank by *meaning* using local embeddings — it finds conceptually related entries a
  keyword match misses. `--semantic` ranks purely by cosine similarity; `--hybrid` fuses BM25 and
  semantic rankings with Reciprocal Rank Fusion (no score-scale tuning). Embeddings come from any
  OpenAI-compatible `/embeddings` endpoint, defaulting to a **local LM Studio** server (keyless), so
  semantic memory stays local. The index is cached in `.wolf/recall-embeddings.json` and only
  new/changed entries are re-embedded. If the embeddings endpoint is unreachable, recall falls back
  to keyword search. Config under `openwolf.recall.embeddings` (base_url / model). A lightweight take
  on vector memory — no vector database, sized for a project's few hundred entries.

## [1.19.1] — 2026-07-20

### Fixed

- **The same file was estimated at three different char/token ratios depending on which hook ran.**
  `post-read.ts`, `post-write.ts` and `anatomy-scanner.ts` each carried their own extension table and
  they disagreed: `.rs`/`.go`/`.java`/`.c`/`.cpp` counted as "code" (3.5) on read but "mixed" (3.75) on
  write, and a `.md` write was charged the *code* ratio outright — three different numbers for one
  markdown file. The copies existed because `src/hooks/**` is compiled with its own tsconfig
  (`rootDir: src/hooks`) and cannot import from outside it. There is now a single classifier at
  `src/hooks/token-estimator.ts`, inside that rootDir, which `src/tracker/token-estimator.ts`
  re-exports for everything else.
- **`token_audit.chars_per_token_code` / `_prose` did nothing.** The keys shipped in the init template
  and were documented as tunable, but no estimator ever read them — every one hardcoded 3.5/4.0/3.75.
  They are now honoured (with validation; a missing or nonsensical value falls back to the default),
  and the "mixed" ratio is derived as the midpoint of the two configured ends.
- **MultiEdit writes were recorded as 0 output tokens.** MultiEdit carries its changes in
  `tool_input.edits[]`, not `old_string`/`new_string`, so the estimator saw an empty string. It now
  sums the replacement text of every edit.
- **A repeated read could wipe a file's token estimate.** A re-read often arrives with empty
  `tool_output.content`; with no anatomy entry to fall back on, the good first-read estimate was
  overwritten with 0 — deflating `input_tokens_estimated` and, because the repeat-savings figure
  multiplies by `(count - 1)`, silently zeroing that metric too. The estimate can no longer shrink.
- **Both of the waste detector's main patterns were unreachable.** "Repeated reads" counted duplicate
  array entries, but the ledger stores one entry per *unique* file, so the count could never exceed 1;
  "anatomy would have sufficed" keyed on a flag the Stop hook hardcoded to `false`. Read counts are now
  carried explicitly, and the anatomy flag is recorded from the hit the pre-read hook already computed.
- **Buglog IDs could collide.** New IDs were derived from `bugs.length + 1`, which repeats an existing
  ID after entries are removed by dedupe or the retention trim (e.g. `[bug-001, bug-003]` → `bug-003`).
  IDs now continue past the highest existing one — the approach already used by the other writer.
- **Every auto-detected null-safety bug got the same blank summary.** The summary interpolated
  `path.basename(path.basename(""))` — a hardcoded empty literal — so all of them collapsed into one
  dedupe bucket, since that text is what similar-bug matching compares. It now names the file.

## [1.18.2] — 2026-07-16

### Fixed

- **Dashboard showed stale data after a daemon restart.** On a WebSocket (re)connect the daemon only
  sent `daemon_started`, never the current `full_state` — and the frontend never requests it — so a
  page that reconnected after the daemon restarted kept showing pre-restart data until some `.wolf`
  file happened to change. The daemon now sends the full state to each newly-connected client.
- **"Recent Activity" showed the day's oldest entries instead of the newest.** Sessions were newest-
  first but entries within a session stayed oldest→newest, and the panel took the first few — so a
  long single-session day surfaced the morning's entries. It now takes the most recent entries.
- **"Usage Over Time" chart plots measured tokens.** It used the char-ratio estimate, which only
  counts Read/Edit tool use and reads 0 for shell-heavy work — leaving the chart empty. It now
  prefers the measured `real_usage` from the harness transcript (estimate as fallback) and keys the
  x-axis on each turn's end time so a single long session no longer collapses onto one point.
- **Docs link pointed at the upstream project.** The dashboard's "Docs" link now points to this
  fork's repo instead of openwolf.com.

## [1.18.1] — 2026-07-16

### Fixed

- **Multi-project dashboard port collisions.** Every project shipped the same default dashboard/daemon
  ports (18791/18790), so running several daemons meant only the first bound — a second project's
  `openwolf dashboard` saw the port "in use" and opened the *first* project's data. Now: `openwolf
  update` gives every registered project a unique port pair (reassigning only the ones that collide,
  written to their config.json); `openwolf dashboard` checks an unauthenticated `/api/whoami` and, if
  the configured port is held by a *different* project's daemon, relocates itself to a free port and
  persists it; and the daemon honours an `OPENWOLF_DASHBOARD_PORT` override so the dashboard can place
  it there. Ported from upstream cytostack/openwolf 2.0.1, adapted to this fork.

## [1.18.0] — 2026-07-16

> Upgrades ported from upstream `cytostack/openwolf` 2.0 (AGPL-3.0), adapted to this fork.

### Added

- **Compaction survival (PreCompact hook).** When Claude Code / Codex compacts the context window,
  the live session state on disk survives but nothing in the compacted context tells the model what
  already happened. A new `precompact.js` hook snapshots `_session.json`, and SessionStart — which
  fires with `source: "compact"` afterwards — now re-injects a digest that lists the files already
  modified this session, so the model doesn't re-read them from scratch. SessionStart also no longer
  resets the session on `compact`/`resume` (it only resets for a genuinely new session), which used to
  wipe read/write tracking and append a spurious memory.md header on every compaction.
- **Measured token usage (`openwolf report`).** The ledger was estimate-only (a char/token ratio). The
  Stop hook now reads the harness transcript (`transcript_path` in its payload) and sums the real
  `message.usage` — input, output, cache-read, cache-creation tokens, and API calls — deduped per
  message id. Numbers land per-session (`real_usage`) and in `lifetime.real_*`, tagged with the driving
  agent (`detectAgent`). `openwolf report` shows the estimate and the measured ground truth side by
  side. Sessions without a transcript (older harness, other agents) simply record no measured usage.
- **Symbol-level anatomy hints.** `openwolf scan` now extracts top-level symbols (functions, classes,
  interfaces) with 1-based line ranges for big files (≥500 est. tokens, TS/JS/PY/GO/RS) into a
  `anatomy-symbols.json` sidecar. When the agent is about to read such a file, the pre-read hook lists
  the symbols and their ranges — `parse (23-45), Engine (69-91)` — so it can read one function with
  `offset`/`limit` instead of the whole file. Heuristic (line-anchored regexes, symbol end = line
  before the next), which is enough for slice reads. This is the lightweight take on upstream's
  durable anatomy index: a sidecar, so our markdown `anatomy.md` pipeline is untouched.

## [1.17.0] — 2026-07-16

### Added

- **Local models (Ollama, llama.cpp, LM Studio) now actually work.** 1.15.0 made the provider
  configurable and 1.15.1 deliberately allowed `http://` for loopback so a local model could be used —
  but every call site still refused to run without an API key, which a local server does not have. The
  key is now required only for remote endpoints (`requiresApiKey()`); a loopback endpoint runs keyless,
  and a keyless request sends no `Authorization` header at all rather than an empty `Bearer `. Remote
  providers are unchanged and still demand a key.
- **`openwolf llm`** — shows which model the project's AI features (cron tasks, `consolidate`) will
  call, and `--test` sends a real prompt and times the round-trip. A misconfigured endpoint used to
  surface only as a cron task that failed hours later. Errors name the fix: a refused local connection
  suggests the `ssh -R` port-forward (with the port taken from your `llm_base_url`), a 404 shows how to
  list the ids the server actually serves.

### Changed

- **AI cron tasks now propose instead of overwrite.** The default output mode for `ai_task` is
  `"proposal"`: the model reads the project's knowledge files and writes its answer to
  `.wolf/proposals/<task>-<timestamp>.md`, touching nothing canonical. A human — or a stronger model in
  a session — decides what is adopted. The local model does the legwork; authority over what is true
  stays with the reader. `mode: "overwrite"` remains available, opt-in and guarded.
- **Oversized context files are split, not truncated.** `splitForContext()` cuts at paragraph
  boundaries and round-trips losslessly, so a model whose window is smaller than the file still reads
  **all** of it — in several passes. The old behaviour kept the last 20 KB and discarded the rest, which
  for a knowledge base is data loss with extra steps (it is exactly how the bug below happened).

### Fixed

- **An AI cron task could delete a project's entire knowledge base.** `runAiTask` caps each context file
  at 20 KB. The shipped `cerebrum-reflection` task feeds it `cerebrum.md`, tells the model to "return the
  cleaned file content only", and writes the answer straight back. On a project whose cerebrum had grown
  to 78 KB, the model therefore saw only the last quarter — and its tidy 3.9 KB "cleaned file" would have
  replaced all 78 KB, at 03:00 on a Sunday, with no backup: a 95% loss, silently. It had never fired only
  because `ANTHROPIC_API_KEY` was unset; pointing the task at a keyless local model removes that accidental
  safety net, so this became live the moment local models started working. Now: a file the model saw only
  a **slice** of is never rewritten from that slice; every overwrite of `cerebrum.md` leaves a timestamped
  backup beside it; and `callLlmDetailed()`/`wasTruncated()` reject an answer that was cut off mid-text —
  half a cerebrum still contains `# Cerebrum` and would otherwise have been written over the whole one.
  AI tasks also get a 16k token budget (a reasoning model spends thousands before the first character of
  the file it is meant to produce).
- **Reasoning models returned an empty answer that looked like a successful one.** Qwen3, o-series and
  friends bill their hidden reasoning tokens against the *same* `max_tokens` budget, so a small budget
  is spent before the model emits a single character — the server replies `HTTP 200` with
  `finish_reason: "length"` and empty content. `parseLlmResponse()` handed that back as `""`, which is
  indistinguishable from a legitimately empty answer: `consolidate` discarded every merge as
  "implausible merge output" and `llm --test` printed a green ✓ on nothing. A response truncated
  *before* it says anything is now an error that names the cause; truncated *after* some text is still
  returned. Measured: a two-line merge prompt spends 1,935 reasoning tokens, so the old 900-token
  budget could never have produced output.
- **Token budgets raised for reasoning models** — default 2048 → 4096, `consolidate` 900 → 3000 (and
  its timeout 60s → 120s), `llm --test` 256 → 2048.
- **Error hints were hard-wired to Ollama.** A refused connection always suggested forwarding port
  11434 and a 404 always suggested `ollama pull` — wrong for anyone on LM Studio (port 1234), who would
  have tunnelled a port nothing listens on. The port is now read from the configured `llm_base_url`,
  and the 404 hint is provider-neutral. A live tunnel with nothing behind it (LM Studio's server toggle
  left off) is now called out explicitly, because it presents as a connection error but is not one.
- **`openwolf recall` crashed on a malformed `buglog.json`.** `unitsFor()` wrapped only `JSON.parse` in
  its `try`; the very next line read `(raw).bugs`. For a file containing `null` (or a number, or a bare
  string) `raw` is not an object, so that access threw a `TypeError` *outside* the `try` and took the whole
  command down — reproducible in ten seconds with `printf null > .wolf/buglog.json`. It now returns no
  units for any non-object JSON, the same as an unparseable file. (Found by a local model, verified against
  the code.)
- **A consolidate whose backup failed still overwrote `cerebrum.md`.** The pre-write `copyFileSync` to
  `cerebrum.md.bak-pre-consolidate` was wrapped in a swallow-everything `catch`, so a full disk, a
  permission error, or a lock let the backup silently fail — and the rewrite proceeded anyway, leaving no
  way back. Same failure class as the 95%-loss bug: if the safety net fails, the dangerous step must not
  run. A failed backup is now a hard abort; `cerebrum.md` is left untouched.
- **Retry timers outlived `stop()`.** Failed tasks reschedule themselves with `setTimeout`, but `stop()`
  only cancelled the node-cron jobs — a pending retry fired after shutdown and ran against a daemon that
  believed it had stopped. Retry timers are now tracked and cleared in `stop()`.
- **Concurrent cron tasks could lose each other's execution logs.** The read-modify-write of
  `cron-state.json` (read state → append this run's entry → write) was unlocked, so two tasks finishing
  close together — or one process racing the stop hook — could each read the same snapshot and clobber the
  other's entry, corrupting execution logs and failure counts. Both the success and failure paths now do
  the read-modify-write under `withLock`, the same guard already used for the token ledger.

## [1.16.5] — 2026-07-13

### Fixed

- **The 1.16.4 fix was only half of one.** It told you the team workspace had no matches — but only
  when the local files *did* have matches. In the case where nothing was found anywhere, an earlier
  return still printed a bare "No matches", saying nothing about whether the workspace had even been
  asked. That is the case where the ambiguity hurts most: an empty answer and an unasked question look
  identical, and the user has no way to tell which one they are looking at. Both paths now say what
  happened.

## [1.16.4] — 2026-07-13

### Fixed

- **`recall --team` said nothing when the workspace had no matches.** Silence there is
  indistinguishable from "the workspace was never asked" — and the most likely reason for an empty
  answer is one the user can act on the moment they hear it: entries sitting in the approval queue do
  not appear in recall. It now says so.

## [1.16.3] — 2026-07-13

### Added

- **`openwolf link` / `openwolf push` / `openwolf recall --team` — an opt-in bridge to a remote
  OpenWolf workspace.** No endpoint is hardcoded: `--url` points at whichever workspace you run or
  subscribe to. A project can now offer what it has learned to a shared workspace and search
  that workspace alongside its own files. Everything is explicit: no background sync, no hook-time
  upload, no telemetry. Nothing is sent until someone types `push`.
  - `link` verifies the token against the live API *before* storing it — a link command that happily
    saves a typo and fails three days later at the first push is worse than no link command.
  - The token lives in `.wolf/remote-token` (0600), never in `config.json`, which gets committed.
  - `push` sends only durable knowledge: cerebrum Key Learnings → `learning`, Decision Log →
    `decision`, `buglog.json` → `bug`. `memory.md` is deliberately not a source (it is mostly
    mechanical file-write rows, and noise is what makes a shared brain go unread), and User
    Preferences are skipped unless `--with-preferences` — they describe how one person wants to be
    worked with, which is not the team's business by default. Auto-detected bugs are skipped too:
    they are pattern guesses, not findings.
  - Entries arrive as **needs-approval**. A machine may propose; a human decides what enters the
    team's memory.
  - `recall --team` prints local and workspace hits as **two lists**. The workspace ranks with a
    hybrid (full-text + trigram + semantic, fused, boosted by confirmed use); local recall uses BM25
    over markdown. Those numbers are not on the same scale, and interleaving them under one invented
    score would be a fabricated ordering dressed up as relevance.
  - Team citations are shown as `t-3f9a2b`. Both systems mint `c-…`-shaped ids from different hashes
    over different text, so the two namespaces can collide; models already invent citation ids, and
    handing them two colliding ones would make every citation unverifiable. `recall --id` resolves
    `t-…` against the workspace, and falls back to it for a `c-…` that no local file knows (that is
    someone pasting a citation from the web UI).
  - Outbound requests reuse `assertSafeBaseUrl()` from the LLM provider, so the SSRF hardening from
    1.15.1 (https-only unless loopback, no private/link-local/metadata hosts, `redirect: "error"`)
    covers this path too.

### Fixed

- **`.wolf/` had no `.gitignore`, and `dashboard-token` was sitting in it.** Committing `.wolf/` is
  the whole point of a shared brain, but the local dashboard token was never excluded — and a
  workspace token (write access to the team's memory) would now be there too. `init`, `update` and
  `link` all ensure `.wolf/.gitignore` now; it is written from code because npm silently drops files
  named `.gitignore` from published packages. `0600` protects against other users on the machine and
  does nothing whatsoever against `git add`.

## [1.16.2] — 2026-07-13

### Fixed

- **The other half of the blind spot: edits made through the shell were never counted.** 1.16.1 taught
  the Stop hook about writes in another working directory, but `post-write` only ever runs on
  `Write|Edit|MultiEdit`. A heredoc (`cat > f <<EOF`), a redirect, a `sed -i`, a `cp` — none of them
  reach it, so a session that edits through Bash still reported zero writes and every end-of-turn
  reminder stayed silent.

  `post-bash` now counts file-writing commands (`bash_writes`), and the Stop hook adds them to the
  STATUS.md, memory.md and buglog reminders. Same discipline as #56: the counter answers *whether* a
  file was written, never *which* — no path is parsed or stored. Commands that failed do not count
  (they wrote nothing), and neither do read-only inspection or scratch targets (`/dev/null`, `/tmp`).

  The counter runs **before** the `openwolf.capture.enabled` gate on purpose: `activity.log` is opt-in,
  but the reminders are not, and gating it would have left every default install as blind as before.

## [1.16.1] — 2026-07-12

### Fixed

- **The STATUS.md reminder was blind to work done in another working directory.** `post-write` drops
  any path outside the project root so foreign paths cannot leak into anatomy/memory (#56) — but it
  also dropped the *fact* that a write happened. In a session whose work lives in an additional
  working directory (Claude Code supports several), `files_written` therefore stayed empty, the Stop
  hook concluded nothing had happened, and neither the STATUS.md nor the memory.md reminder ever
  fired. Found the hard way: a handoff doc that sat eleven slices out of date while the hook designed
  to prevent exactly that stayed silent.

  External writes are now **counted, never named** — a bare integer (`external_writes`), no path, no
  filename — so #56 still holds while the reminders work again. The nudge says where the writes were
  ("all of them outside this project root"), and a session that wrote only elsewhere now leaves a
  line in memory.md instead of a gap exactly where the work was.

## [1.16.0] — 2026-07-11

Three requested features that build on the recent work: LLM-assisted memory consolidation, cross-project
recall, and a dashboard view for the Bash capture — plus a README reworked for discoverability.

### Added
- **`openwolf consolidate` — LLM-merge near-duplicate cerebrum entries.** `doctor` only *hints* at
  duplicate learnings; this command actually merges them using the configured provider (the same
  Anthropic/OpenAI-compatible abstraction as cron AI tasks — so it can run on a free provider). It finds
  near-duplicate pairs (Jaccard over content words), asks the model to merge each pair into one entry
  preserving every unique fact, then rewrites `cerebrum.md` (backup at `cerebrum.md.bak-pre-consolidate`).
  `--dry-run` previews, `--threshold`/`--max` tune it. Non-overlapping pairs only; implausible merge
  output is skipped. The apply step is a pure, unit-tested function.
- **`openwolf recall --all` — search across all registered projects.** Cross-project keyword search;
  hits are tagged `project:file:line` and ranked globally by BM25 score. `--id … --all` resolves a
  citation across projects too.
- **Dashboard "Command Log" panel.** Browses `.wolf/activity.log` (the opt-in Bash capture): per-command
  rows with timestamps, a failures-only filter and search, and an empty state that explains how to enable
  capture. Read-only.

### Changed
- The LLM call is now a shared `callLlm()` helper (with the 1.15.1 hardening: base-url validation, hard
  timeout, no redirect-following), used by both the cron engine and `consolidate`.

### Documentation
- README (en + de) reworked for discoverability and onboarding: a "works with Claude Code / Codex / Gemini /
  OpenCode" lead, a contents nav, and a **FAQ** (privacy, how it differs from upstream, multi-agent support,
  API-key needs, performance). Requirements updated for multi-agent. Broadened npm `keywords` and modernized
  the package `description`.

## [1.15.1] — 2026-07-11

Security hardening of the 1.14/1.15 surfaces, from an adversarial review. No feature changes.

### Security
- **SSRF / API-key exfiltration via `llm_base_url` (High).** A project's `config.json` (which an untrusted
  repo can carry) could point the cron engine's AI-task endpoint at any host and leak the API key. Base URLs
  are now validated: `https` required except for loopback (local models), and private/link-local/cloud-metadata
  addresses are refused. The request no longer follows redirects (`redirect: "error"`), so the key can't ride a
  3xx to another host.
- **Command injection in generated Codex hook commands (High).** The absolute project path was interpolated
  raw into the shell command written to `.codex/hooks.json`; a path with shell metacharacters could inject.
  Literal paths are now POSIX single-quote-escaped.
- **Wider secret redaction in Bash activity capture (Medium).** `redactSecrets` now also catches dash-bearing
  keys (`sk-ant-…`, `sk-proj-…`), `…PWD`/`…PASS`/`…PASSPHRASE`/`…CRED` env assignments, `user:pass@` URLs,
  `x-api-key:` headers, and `-u user:pass` — forms that previously reached `.wolf/activity.log` in cleartext.

### Fixed
- `openwolf update` no longer removes a user's own hook that happens to invoke a `.wolf/hooks/` script — only
  entries marked `_managedBy: "openwolf"` are replaced (all agents now set it).
- `.wolf/activity.log` writes are locked, so concurrent Bash hooks can't clobber each other.

## [1.15.0] — 2026-07-11

OpenWolf reaches beyond Claude, in two directions. **Models:** the cron engine's AI tasks now speak any
OpenAI-compatible endpoint (OpenAI, Groq, Cerebras, Mistral, Qwen, local) as well as Anthropic. **Agents:**
`init`/`update` auto-detect and register OpenWolf's hooks with Codex CLI, Gemini CLI and OpenCode alongside
Claude. Plus a German-localizable resume digest. Defaults are unchanged, so nothing shifts unless you opt in.

### Added
- **Beyond Claude Code: Codex CLI, Gemini CLI & OpenCode.** `openwolf init`/`update` now auto-detect which
  agents a project uses (their config dir exists) and register OpenWolf's hooks with each, alongside Claude:
  - **Codex CLI** (`.codex/hooks.json`) and **Gemini CLI** (`.gemini/settings.json`) share Claude's hook
    convention — command hooks, JSON stdin, `hookSpecificOutput.additionalContext` — so the same Node hook
    scripts run there unchanged; only event names (Gemini: `AfterTool`/`SessionEnd`) and tool matchers
    (Codex `apply_patch`/`Bash`; Gemini `write_file|replace`/`run_shell_command`) are mapped. The
    **session-start resume digest is injected** into both, and file/shell activity is captured.
  - **OpenCode** (`.opencode/plugin/openwolf.js`) gets a generated JS plugin adapter. OpenCode has no
    session-start injection hook, so the digest is injected at compaction and edits/shell are captured
    after each tool run — a documented, narrower integration.
  - Claude is always targeted and its config is byte-for-byte unchanged; the deploy merges into existing
    settings, preserving your own hooks. Hooks resolve the project via `OPENWOLF_PROJECT_DIR`, set in the
    generated commands, so they find the right `.wolf/` under any agent. New `src/utils/agent-hooks.ts`
    with unit-tested per-agent config generation. (Codex re-prompts to trust changed hook commands.)
- **Localized resume digest (`OPENWOLF_LANG`).** The session-start resume digest — the one substantial
  block OpenWolf injects into the model's context — can now render in German. Language resolves from
  `OPENWOLF_LANG` (`de*`/`en*`) → `openwolf.lang` in config → `en` default. Preamble and section headers
  are translated; English stays the default so nothing changes unless you opt in.
- **Model-agnostic cron AI tasks.** The background cron engine hard-coded the Anthropic Messages API; it
  now resolves an LLM provider from `openwolf.cron` config (`llm_provider`, `llm_base_url`, `llm_model`,
  `api_key_env`) and speaks either the **Anthropic** or an **OpenAI-compatible** API — so scheduled AI
  tasks can run on OpenAI, Groq, Cerebras, Mistral, or a local server, not just Claude. Substring/format
  handling and the 120s timeout are unchanged; defaults reproduce the previous Anthropic behaviour exactly,
  so existing projects keep running on Claude with no config change. Request/response building and config
  resolution are pure, unit-tested helpers (`src/daemon/llm-provider.ts`); verified end-to-end against a
  live non-Claude model.

## [1.14.0] — 2026-07-11

Sharper, citable, self-filling memory — and OpenWolf reaches Claude Desktop. `recall` gains stable
citation ids and BM25 ranking with a two-layer expand; a one-click `.mcpb` bundle installs the MCP
server in Claude Desktop; the dashboard rolls up native-memory health across projects; `doctor` flags
duplicate cerebrum entries; and an opt-in `PostToolUse:Bash` hook captures notable commands and failures
into the resume digest. All within the zero-infra, git-native model — no database, no background worker.

### Added
- **Opt-in passive Bash activity capture.** File edits were already journaled; a new `PostToolUse:Bash`
  hook (`post-bash.js`) now fills the gap — it appends notable commands (commits, package installs,
  test/build/deploy runs) **and any failed command** to an append-only, size-capped `.wolf/activity.log`,
  which the session-start resume digest surfaces as "Recent commands" so the next session sees what ran
  and what broke. Off unless you set `openwolf.capture.enabled`; secrets are redacted before write,
  trivial read-only commands (`ls`/`cat`/`grep`/`git status`…) are dropped, the log is capped in the
  write path, and it's excluded from backups. Redaction/filter/cap are pure, unit-tested helpers.
- **`recall` is now BM25-ranked.** Ranking upgraded from raw occurrence counts to Okapi BM25 — rare query
  terms are weighted higher (IDF) and long entries no longer dominate by sheer length. Matching stays
  substring-based, so `recall port` still finds `ports`; only the ordering got smarter. Zero infra (one
  extra in-memory pass over the same files, no index, no DB).
- **`openwolf doctor` hints at near-duplicate cerebrum entries.** cerebrum.md accretes learnings across
  sessions with no automatic consolidation, so two entries can drift into saying the same thing. Doctor now
  lists likely duplicate pairs (Jaccard over content words, above a threshold) for you to merge — read-only,
  it never edits. Reuses `recall`'s block splitter, so an "entry" is the same logical unit a citation points at.
- **Citations + two-layer `recall`.** Every `openwolf recall` hit now carries a stable, content-addressed
  citation id (e.g. `c-3f9a2b` — one-letter store prefix + hash of the entry's normalized text). It's the
  handle for progressive disclosure: `recall <query>` stays a compact index; `recall <query> --full`
  expands every hit to its full logical block; `recall --id <id>` re-opens a single entry (no query
  needed). Write `see [c-3f9a2b]` in a note to cite a fact and jump back to it later. Ids survive
  reordering and unrelated edits; they change only when that entry's own text changes. The `openwolf mcp`
  tool `openwolf_recall` surfaces ids and accepts an `id` arg too, so Claude Desktop gets citations as
  well. OPENWOLF.md now instructs citing ids and preferring `recall` over whole-file reads.
- **Cross-project Native Memory view.** The dashboard's Native Memory panel gains a
  **This project / All projects** toggle. "All projects" is a health rollup across every registered
  OpenWolf project — topic-file count, indexed vs. orphaned, MEMORY.md length with a 200-line-cutoff
  badge, dead links, and footprint — so you can spot at a glance which projects have unindexed memory
  that never loads at session start. "Open" switches the daemon to a project to browse its files.
  Backed by a read-only `/api/native-memory/aggregate` endpoint and a testable `aggregateNativeMemory()`
  helper (a project with no native memory or a vanished `.wolf/` degrades to `available:false`, never
  throws).
- **`openwolf.mcpb` — a one-click Claude Desktop Extension.** `pnpm build:mcpb` bundles the dependency-free
  `openwolf mcp` server (esbuild, ~8 KB, no `node_modules`) plus an MCPB `manifest.json` into a single
  `dist-mcpb/openwolf.mcpb`. Users download it from the release and open it — Claude Desktop installs the
  bundle and prompts for the project directory, no CLI install or `claude_desktop_config.json` editing.
  The manifest's tool list is derived from the server's `MCP_TOOLS` so it can't drift.

### Fixed
- **`.wolfignore` matcher source is grep-able again.** `makeIgnoreMatcher` used a literal NUL byte as its
  glob→regex sentinel (in `hooks/shared.ts` and its `utils/maintenance.ts` twin), which made both files
  register as *binary* to `grep`/`ripgrep` and silently hid every text match. Replaced with the `\u0000`
  escape — byte-identical at runtime, pure-ASCII on disk. No behavior change (matcher unit test still green).

### Documentation
- **Hero tagline widened** — OpenWolf's recall/resume now reach beyond Claude Code into Claude Desktop
  (and any MCP client), reflected in both the English and German README taglines.
- **README (en + de): one-click `.mcpb` install** documented alongside the manual `claude_desktop_config.json`
  registration.

## [1.13.0] — 2026-07-10

Interop with Claude Code's native Auto Memory (`~/.claude/projects/<slug>/memory/`) — OpenWolf reads
and surfaces it read-only instead of maintaining a competing store. It leaves writing/consolidation to
Claude's own Auto Dream. Plus an MCP server so this works in Claude Desktop, not just Claude Code.

### Added
- **`openwolf recall` also searches native Auto Memory.** Every topic file under the project's native
  memory directory is searched alongside `.wolf/`; native hits are labelled `native/<file>`. This makes
  the native memory searchable at all — natively you can only grep it by hand. `--limit`/`--json` apply;
  `<private>` still filtered. (`OPENWOLF_NATIVE_MEMORY_DIR` overrides the auto-resolved path; falls back
  to `.wolf/` when Auto Memory isn't present.)
- **`openwolf doctor` reports native-memory health.** Surfaces the blind spot the feature hides: how many
  topic files exist vs. how many the sub-200-line `MEMORY.md` index actually references (the rest never
  load at session start), a warning when `MEMORY.md` exceeds the 200-line auto-load cutoff, dead index
  links, footprint, and stale files. (On a real project: *447 topic files, only 94 indexed → 353 never
  surface on resume.*)
- **Session-start resume digest lists native memory** in its "Available on demand" index, pointing at
  `openwolf recall` to reach the topic files the native index leaves out.
- **Dashboard "Native Memory" panel.** Browse Claude's native memory: index-coverage stats (indexed vs
  orphaned), a warning when `MEMORY.md` exceeds the 200-line auto-load cutoff, dead-link and stale-file
  counts, and a searchable file list (size, modified, indexed/orphan badge) with click-to-view. Backed by
  read-only `/api/native-memory` and a path-validated `/api/native-memory/file` endpoint.
- **`openwolf mcp` — an MCP server for Claude Desktop and other MCP clients.** A dependency-free,
  spec-compliant JSON-RPC/stdio server exposing three read-only tools — `openwolf_recall`,
  `openwolf_resume`, `openwolf_memory_health` — so OpenWolf's search and resume work outside Claude Code
  (the hook lifecycle doesn't exist there; the tools are called explicitly). Serves one project via
  `--project` / `$OPENWOLF_PROJECT_DIR`. README documents `claude_desktop_config.json` registration.

## [1.12.1] — 2026-07-10

### Fixed
- **Dashboard sidebar shows the real version** instead of a hardcoded `v1.0.0` — the version is
  injected from `package.json` at build time (Vite `define`).

### Documentation
- **German README** added at `docs/i18n/README.de.md`, with language links from the English README.
- Compacted "What's Enhanced" into a single thematic table (per-version detail lives here in the
  CHANGELOG); refreshed the command list (`recall`, `export`) and added `STATUS.md` to the files table.

## [1.12.0] — 2026-07-10

Memory search, privacy, and a progressive-disclosure resume digest — all within OpenWolf's
zero-infra, git-native model (no database, no background LLM worker).

### Added
- **`<private>…</private>` exclusion** — content wrapped in these tags in any `.wolf` knowledge file
  is kept out of the session-start resume digest and out of `openwolf recall` results, so secrets or
  sensitive notes are never re-injected into the model. `recall` preserves accurate line numbers
  across removed blocks. Documented in OPENWOLF.md.
- **`openwolf recall <query>`** — keyword search across the flat knowledge files (STATUS.md,
  cerebrum.md, memory.md, buglog.json), ranked by term matches (bonus for hitting every term),
  returning a compact `file:line` index so you can Read the exact spot. `--limit`, `--json`. The
  query interface OpenWolf lacked — without a DB. Pure `recall()`, tested.
- **Structured session-summary scaffold** — the SessionStart hook now writes a
  `<!-- session summary … -->` comment under each session header (invisible when rendered), and
  OPENWOLF.md instructs replacing it at session end with `**Did:** … · **Learned:** … · **Next:** …
  · **Files:** …`. Consistent, greppable memory; feeds a cleaner resume headline.

### Changed
- **Session-start resume digest is now progressive-disclosure.** Curated, high-value knowledge
  (STATUS.md, cerebrum's Do-Not-Repeat) stays inline with a token-cost hint; recent activity collapses
  to a one-line headline instead of dumping every row; and an **"Available on demand"** index lists
  the remaining knowledge files with entry counts and token cost plus how to pull them (`Read` /
  `openwolf recall`). The model sees what exists without us pre-dumping it.

## [1.11.0] — 2026-07-10

Batched v1.10-cycle features.

### Added
- **`openwolf export <sessions|bugs>`** — export the token-ledger sessions or the bug log as JSON
  (default) or CSV (`--format csv`), to stdout or a file (`--out`). CSV flattens nested totals/tags
  and quotes per RFC 4180. Pure `toCSV`/`collectRows` helpers, covered by tests.
- **`.wolfignore` suggestions in `openwolf doctor`** — doctor now lists project directories that
  aren't ignored yet and either add real scanner load (many *scannable* text files) or are large
  enough to weigh on watching/space, so you can add the noisy ones to `.wolfignore`. Bytes from big
  binaries (which the scanner skips anyway) don't trigger the noise rule. Respects existing
  `.gitignore`/`.wolfignore` and default excludes; stats sizes only, bounded for huge trees.
- **Dashboard: hash routing & deep-linking** — panels are now addressable as `#<panel>` (with an
  optional query), so links are shareable and the browser back/forward buttons work. Foundation for
  the two features below.
- **Dashboard: All Projects view** — a new panel aggregating every registered OpenWolf project
  (sessions, tokens, tokens saved, open bugs, last activity), backed by a new `/api/aggregate`
  endpoint, with one-click switching to any project. Highlights the current project; flags missing ones.
- **Dashboard: jump-to-file from AI Insights** — file paths mentioned in AI insight items are now
  clickable and deep-link to the Anatomy Browser filtered to that file (`#anatomy?file=…`). Only
  real paths linkify (slash or known code extension), so version strings stay plain text.

## [1.10.0] — 2026-07-10

### Added
- **Session-start resume context.** The `SessionStart` hook now injects a compact, hard-capped digest
  as `additionalContext`, so the model resumes with the project's own handoff notes already in context
  instead of spending reads to reconstruct them. It assembles three high-signal sections — `STATUS.md`
  (the resume point), the `Do-Not-Repeat` section of `cerebrum.md`, and the most recent `memory.md`
  session block that has real entries — each individually clipped, with a hard total cap (default 6000
  chars ≈ 1.5k tokens). An unedited template `STATUS.md` is detected and skipped, and if nothing useful
  exists no context is injected. Configurable via `openwolf.session_context` (`enabled`, `max_chars`);
  `stdout` carries only this JSON, so the existing stderr reminders are unaffected. Covered by tests.

## [1.9.4] — 2026-07-10

### Added
- **Tokenless releases via npm Trusted Publishing (OIDC).** `.github/workflows/publish.yml` publishes
  from GitHub Actions on a `v*` tag push, authenticating with a short-lived, workflow-scoped OIDC
  credential instead of a stored `NPM_TOKEN`, and attaching a provenance attestation automatically.
  No long-lived publish token exists anymore; the one used to bootstrap the package on npm was
  revoked. Releasing is now: bump the version, tag `vX.Y.Z`, push.

### Changed
- **`packageManager` pinned to `pnpm@11.1.3`** so `pnpm/action-setup` resolves a version in CI.

## [1.9.3] — 2026-07-10

First release published to npm as [`openwolf-enhanced`](https://www.npmjs.com/package/openwolf-enhanced) — `npm install -g openwolf-enhanced`.

### Fixed
- **`prepublishOnly` no longer builds — it verifies.** It previously ran `pnpm build`, whose
  `prebuild` deletes `dist/`; since the global `openwolf` command symlinks into
  `dist/bin/openwolf.js`, a build failure mid-publish would take the installed CLI down with it, and
  a publish at the wrong moment could ship a stale `dist/`. `scripts/prepublish-guard.mjs` now
  refuses to publish unless `dist/` is present, no source is newer than the compiled CLI, the working
  tree is clean, and `package.json`'s version has a matching git tag on `HEAD`. Building is a
  deliberate, separate step. (This `prepublishOnly → prebuild-deletes-dist` trap was inherited
  verbatim from upstream 1.0.4.)

### Documentation
- README Quick Start leads with `npm install -g openwolf-enhanced`, notes that the bare `openwolf`
  package is the unmaintained upstream 1.0.4, and keeps the from-source build as a collapsible
  fallback.

## [1.9.2] — 2026-07-10

Three findings from the 1.9.1 investigation, fixed.

### Fixed
- **`openwolf update` now seeds user-data files a project never received.** `USER_DATA_FILES` are
  never overwritten — but that was implemented as *never touched*, so a project initialised before a
  file existed never got one. `STATUS.md` (added in 1.4.0) was the casualty: older projects had none,
  while `OPENWOLF.md` instructs the agent to read it first. Missing files are now copied from
  `src/templates/` with `{{PROJECT_NAME}}`/`{{DATE}}` substituted. Existing files are still never
  touched.
- **The hooks we test are now the hooks we ship.** `copyHookScripts()` picked `dist/src/hooks/`
  (the main `tsc` emit) while `test/logic.test.js` imported `dist/hooks/` (the dedicated
  `tsconfig.hooks.json` build). Same sources, two compilations — free to diverge. Deployment now
  prefers `dist/hooks/`, with `dist/src/hooks/` kept as a fallback for older installs. Verified
  behaviourally identical (the two artifacts differed only by a `sourceMappingURL` comment).

### Changed
- **`copyHookScripts()` extracted to `src/utils/hooks-deploy.ts`.** `init` and `update` each carried a
  private copy that had already drifted: different candidate ordering, and only `init` warned when no
  compiled hooks were found. One implementation now, and `init`'s unreachable "dev mode" branch —
  which looked for `.ts` files in a compiled output directory — is gone.
- **`detectProjectName()` and template placeholder substitution moved to `src/utils/seed.ts`**, shared
  by `init` and `update`.

### Documentation
- README documents two rebuild traps: `prebuild` deletes `dist/` (which the global `openwolf` symlink
  points into, so a failed build removes the CLI), and rebuilding the package deploys nothing — the
  hooks that run are per-project copies, so `openwolf update` is required.

## [1.9.1] — 2026-07-10

Backup retention — the ledger-growth fix (1.5.0) had a blind spot one layer up.

### Fixed
- **`openwolf update` no longer copies `token-ledger.json` into its backup.** The ledger is capped by
  *session count*, not bytes, so a mature project's ledger sits at a few MB — and every update snapshotted
  it. Twelve updates in one afternoon left 38 MB of backups in a 41 MB `.wolf/`, of which ~30 MB were
  redundant ledger copies. The ledger is regenerable telemetry: it is now excluded from `BACKUP_FILES`.
  `restoreCommand()` reads the backup directory directly, so an excluded file is simply left untouched on
  restore — rolling a project back no longer rolls back its usage telemetry either. Backups dropped from
  3.2 MB to 484 KB.
- **`createBackup()` now enforces `retention.backups_keep`.** `pruneBackups()` existed and knew the limit,
  but was only ever called from `openwolf doctor` — so repeated updates accumulated snapshots indefinitely
  and the limit only applied if you happened to run doctor. Pruning now runs immediately after each backup
  is written. Oldest-first, so the snapshot just created always survives.

### Notes
Together these took `orderflow/.wolf` from 41 MB → 9.0 MB with no loss of restorable state. The same class
of bug as 1.5.0's unbounded ledger: a bound that exists but is never enforced on the write path.

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
