# @wengine-ai/pi-session-handoff

Hand a self-contained task to **another local pi session** — from the terminal, from the desktop app, or between the two.

The recipient keeps its **own project, model and permissions**；the sender never gets to drive another project's tools or files. If the target session is busy, the message is queued behind its current turn instead of interrupting it.

## Install

```bash
pi install @wengine-ai/pi-session-handoff
```

> **Both sides need this plugin.** A session can only receive a handoff if it is running with the plugin loaded. In the desktop app it ships built in; in the terminal you install it as above.

After installing, restart pi (or run `/reload`) so the tool registers.

## What it does

| Capability | Detail |
|---|---|
| Deliver to any local session | GUI ↔ GUI, TUI ↔ TUI, TUI ↔ GUI |
| Recipient autonomy | Keeps its own project, model, permissions and memory scope |
| Busy target | Queued behind the current turn; never interrupts |
| Idempotency | A stable `idempotencyKey` prevents double delivery on retry |
| Disambiguation | Duplicate session names return candidates instead of guessing |
| Probe safety | Liveness probes use a dedicated route and do not consume queued work |

In the desktop app it can also reach a session that is currently **disconnected**, because the main process reconnects it before delivering.

## Usage

The model calls it as a tool. Typical flow:

1. `action: "list"` — discover candidate sessions (optionally scoped by `projectPath`)
2. `action: "send"` — deliver a self-contained message to one exact `sessionKey`

A handoff message must stand on its own: the recipient never saw the sending conversation. Include the findings, evidence, file paths and acceptance criteria.

## Notes

- A `queued` result means *accepted in memory*, not *completed*. Closing or reloading the receiver before it starts can cancel pending work.
- If a send times out or returns something unexpected, **inspect before retrying** — pass the same `idempotencyKey` so a retry cannot deliver twice.
- Sessions are addressed by their own identity; a session cannot hand off to itself.

## License

MIT
