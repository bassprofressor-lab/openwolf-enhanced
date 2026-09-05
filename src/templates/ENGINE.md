# Which knowledge system owns this session

This project can be driven by more than one knowledge system. **Exactly one owns a session.**
The choice is made at startup through the `OPENWOLF_ENGINE` environment variable, and the
SessionStart hook states the outcome at the top of the session.

| `OPENWOLF_ENGINE` | Owner    | Protocol that applies                          |
|-------------------|----------|------------------------------------------------|
| unset, or `wolf`  | OpenWolf | `.wolf/OPENWOLF.md` (the default)              |
| `cfetch`          | cfetch   | cfetch's own protocol — **not** `OPENWOLF.md`  |

How to read this:

- The SessionStart hook names the active engine. **That statement wins over this file.**
- If no such statement appeared, OpenWolf is active — that is the default, and an unrecognised
  value falls back to it rather than leaving the session with no memory at all.
- While cfetch owns the session, OpenWolf's hooks stand down: they write nothing, and `.wolf/`
  is not updated. Do not record that session's work there. `.wolf/OPENWOLF.md` may still be in
  context because CLAUDE.md imports it statically — ignore it; it does not apply.

This file states the **rule**, never the current state. That is deliberate: a file rewritten on
every session start would be wrong for a second session running beside it in the same project.

To switch:

```
claude                          # OpenWolf (default)
OPENWOLF_ENGINE=cfetch claude   # cfetch owns the session
```
