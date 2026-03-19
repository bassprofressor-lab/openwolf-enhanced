[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)

# OpenWolf

**Persistent memory, token tracking, and context management for Claude Code.**
_Your Claude subscription shouldn't empty itself in a week._

## Why OpenWolf Exists

Most Claude Code users hit their subscription limits faster than expected. The reason: Claude re-reads files it already saw, forgets corrections between sessions, and scans entire directories when a summary would do. There is no built-in way to see where tokens go or why they're being spent.

Claude Code reads the same file three times in one session and doesn't notice. It forgets the correction you gave it yesterday. It loads your entire codebase to find one function. When the session ends, everything it learned, your naming conventions, the bug it just fixed, the architecture decision you explained, vanishes. Next session, it starts from zero. And you have no idea where your tokens went.

OpenWolf fixes the visibility problem. It tracks every token, remembers across sessions, and gives Claude the context it needs without redundant reads.

## What OpenWolf Does

OpenWolf is invisible middleware that hooks into Claude Code's lifecycle. It tracks every file read and write with token estimates. It maintains a learning file - `cerebrum.md` - that accumulates your preferences, corrections, and past mistakes across sessions. It keeps a project structure map - `anatomy.md` - so Claude navigates your codebase without scanning every file. All of this happens automatically through 6 hook scripts. You just type `claude` and work normally.

## Real Numbers

```
Tested across 20 projects on Windows 11 & Ubuntu 24.04.4 | 132+ sessions | Node v24.13

Average token reduction: 65.8%
Repeated reads caught: 71% of all read attempts (106/148 in one project)
```

These are numbers from real projects, not benchmarks. Your results will vary by project size and usage patterns.

## Quick Start

```bash
npm install -g openwolf
cd your-project
openwolf init
```

That's it. Use `claude` normally. OpenWolf is watching.

`openwolf init` creates a `.wolf/` directory:

```
.wolf/
├── OPENWOLF.md            Instructions Claude follows every session
├── cerebrum.md            Learns your preferences, remembers corrections
├── memory.md              Logs every action with token estimates
├── anatomy.md             Project file map - AI navigates without scanning
├── identity.md            Agent persona for this project
├── buglog.json            Remembers how bugs were fixed
├── token-ledger.json      Tracks every token spent
├── config.json            OpenWolf configuration
├── cron-manifest.json     Scheduled task definitions
├── cron-state.json        Task execution history
├── reframe-frameworks.md  UI framework selection guide (12 frameworks)
└── hooks/                 Claude Code lifecycle hooks (6 scripts)
```

## How It Works

When you ask Claude to read a file, OpenWolf checks if it was already read this session. If yes, it warns Claude. When Claude writes code, OpenWolf checks your `cerebrum.md` for known mistakes. After every write, it auto-updates the project map. When the session ends, it logs everything to the token ledger. You see none of this. It just happens.

```
You type a message
    ↓
Claude decides to read a file
    ↓
OpenWolf: "anatomy.md says this file is ~380 tokens. Description: Main entry point."
    ↓
Claude reads the file
    ↓
OpenWolf: logs the read, estimates tokens, checks for repeated reads
    ↓
Claude writes code
    ↓
OpenWolf: checks cerebrum.md - no known mistakes matched
    ↓
Claude finishes
    ↓
OpenWolf: updates anatomy.md, appends to memory.md, updates token ledger
```

## The .wolf/ Files

<details>
<summary><strong>cerebrum.md</strong> - the learning memory</summary>

This is the "wow" feature. Claude updates this file when you correct it, express a preference, or make a decision. The Do-Not-Repeat list prevents the same mistake across sessions.

```markdown
## Do-Not-Repeat

- 2026-03-10: Never use `var` - always `const` or `let`
- 2026-03-11: Don't mock the database in integration tests - use the real connection
- 2026-03-14: The auth middleware reads from `cfg.talk`, not `cfg.tts` - got burned twice

## User Preferences

- Prefers functional components over class components
- Always use named exports, never default exports
- Tests go in `__tests__/` next to the source file

## Key Learnings

- This project uses pnpm workspaces with strict hoisting
- The gateway WebSocket server runs on port 18789
- `tsdown` dead-code-eliminates process.env.NODE_ENV at build time
```

</details>

<details>
<summary><strong>anatomy.md</strong> - the project map</summary>

Every file gets a description and token estimate. Claude reads this instead of opening files when the summary is enough.

```markdown
## src/

- `index.ts` - Main entry point. Exports createProgram() for CLI. (~180 tok)
- `server.ts` - Express HTTP server with middleware chain. (~520 tok)

## src/api/

- `auth.ts` - JWT validation middleware. Reads from env.JWT_SECRET. (~340 tok)
- `users.ts` - CRUD endpoints for /api/users. Pagination via query params. (~890 tok)
```

</details>

<details>
<summary><strong>token-ledger.json</strong> - the receipt</summary>

Every session gets a line item. Lifetime totals tell you if OpenWolf is actually saving tokens.

```json
{
    "lifetime": {
        "total_tokens_estimated": 142800,
        "total_reads": 287,
        "total_writes": 94,
        "total_sessions": 44,
        "anatomy_hits": 198,
        "anatomy_misses": 89,
        "repeated_reads_blocked": 106,
        "estimated_savings_vs_bare_cli": 34200
    }
}
```

</details>

<details>
<summary><strong>buglog.json</strong> - the bug memory</summary>

Before fixing anything, Claude checks if the fix is already known. After fixing, it logs the solution.

```json
{
    "id": "bug-012",
    "error_message": "TypeError: Cannot read properties of undefined (reading 'map')",
    "file": "src/components/UserList.tsx",
    "root_cause": "API response was null when users array was expected",
    "fix": "Added optional chaining: data?.users?.map() and fallback empty array",
    "tags": ["null-check", "api-response", "react"]
}
```

</details>

## Commands

```
openwolf init              Initialize .wolf/ and register hooks
openwolf status            Show health, stats, file integrity
openwolf scan              Refresh the project structure map
openwolf scan --check      Verify anatomy matches filesystem (exits 1 if stale)
openwolf dashboard         Open the real-time web dashboard
openwolf daemon start      Start background task scheduler via PM2
openwolf daemon stop       Stop the scheduler
openwolf daemon restart    Restart the scheduler
openwolf daemon logs       View scheduler logs
openwolf cron list         Show all scheduled tasks
openwolf cron run <id>     Trigger a task manually
openwolf cron retry <id>   Retry a dead-lettered task
openwolf designqc          Capture full-page screenshots for design evaluation
openwolf bug search <term> Search bug memory for known fixes
openwolf update            Update all registered projects to latest version
openwolf restore [backup]  Restore .wolf/ from a timestamped backup
```

## Design QC

Capture full-page screenshots of your running app and let Claude evaluate the design - no separate API key needed.

```bash
openwolf designqc
```

OpenWolf auto-detects your dev server (or starts one from `package.json`), captures viewport-height JPEG sections of every route, and saves them to `.wolf/designqc-captures/`. Then tell Claude to read the screenshots and evaluate. Requires `puppeteer-core` (`npm install puppeteer-core`).

## Reframe

Ask Claude to help you pick a UI framework. OpenWolf ships a curated knowledge base of 12 frameworks (shadcn/ui, Aceternity, Magic UI, DaisyUI, HeroUI, Chakra, Flowbite, Preline, Park UI, Origin UI, Headless UI, Cult UI) with battle-tested migration prompts. No CLI command needed - Claude reads `.wolf/reframe-frameworks.md`, asks you a few questions, and executes the migration with the right prompt for your project.

## How OpenWolf Compares

OpenWolf is a `.wolf/` directory with 6 hook scripts and a learning protocol. It doesn't run your AI for you. It doesn't replace your workflow. It gives Claude Code two things it doesn't have: a memory that survives between sessions, and a budget you can see. If you want an AI operating system, look elsewhere. If you want your AI assistant to stop re-reading the same file four times and forgetting what you told it yesterday, this is that.

## Requirements

- Node.js 20+
- Claude Code CLI
- Windows, macOS, or Linux
- Optional: PM2 for persistent background tasks
- Optional: `puppeteer-core` for Design QC screenshots

## Limitations

- Claude Code hooks are a relatively new feature. `PreToolUse`/`PostToolUse` have had reliability issues in some Claude Code versions. OpenWolf falls back to `CLAUDE.md` instructions when hooks don't fire.
- Token tracking is estimation-based (character-to-token ratio), not exact API counts. Accurate to within ~15%.
- `cerebrum.md` depends on the AI following instructions to update it after corrections. Compliance is ~85-90%, not 100%.
- This is v1.0.0. Things may break. [File issues](https://github.com/cytostack/openwolf/issues).

## Origin Story

We were building products with Claude Code at Cytostack when we noticed something off. Sessions were eating through tokens faster than they should. When we dug in, we found Claude re-reading the same files multiple times, forgetting corrections from an hour ago, and scanning entire directories to find one function. There was no way to see where tokens went or why. So we built the tooling we wished existed — a persistent memory layer, a project map that eliminates redundant reads, and a ledger that tracks every token. That became OpenWolf.

## License

[AGPL-3.0](LICENSE)

## Author

Built by Farhan Palathinkal Afsal - [Cytostack](https://github.com/cytostack)
