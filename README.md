# PI Desktop

**English** | [简体中文](./README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/xiaoliu10/pi-desktop?display_name=tag&sort=semver)](https://github.com/xiaoliu10/pi-desktop/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![pi](https://img.shields.io/badge/pi-0.85.1%20to%20%3C1.3.0-4c1)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)

**The desktop workbench for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — see every step, approve every action, and stay in charge.**

PI Desktop wraps your local **pi CLI** in a real desktop app: streaming conversations with the full agent process on display (thinking, tool calls, subagents, plan progress), line-level change review, a built-in terminal, and remote control from your phone. Bring your own models — authentication stays inside pi, never in the frontend.

| Chat with full process disclosure | Remote control from your phone |
| --- | --- |
| ![Chat view](./docs/images/hero-chat.png) | ![Remote control](./docs/images/remote-control.png) |

## Why PI Desktop

- **Nothing hidden.** Thinking streams, tool calls, subagent activity, plan checklists, even context compaction — everything the agent does renders as a live timeline, with elapsed-time badges and code blocks you can copy with one click.
- **Supervised autonomy.** Every file edit and command asks before it runs (allow once / always for this session / deny), switchable per task to auto-edit or full access. The Review panel shows the net workspace diff against Git HEAD — it never claims another session's changes as its own.
- **Self-healing runs.** Lost settlement confirmations and "fake running" states — the classic ways agent UIs hang forever — are detected and recovered automatically, with in-chat error rendering instead of dead-end banners.
- **Stay in flow.** Edit a sent message while the task is running (it becomes a queued follow-up or an immediate steer), queue follow-ups, interrupt anytime, and keep several sessions alive across projects.
- **Away from desk.** Scan a QR code to drive the current workspace from your phone on the LAN — watch the live conversation, approve tool calls, stop tasks. Or connect a Bot channel (DingTalk / Feishu / Telegram / WeChat notifications) for longer sessions with group notifications.
- **A workbench, not a chat box.** Multi-tab terminal (node-pty + xterm) that survives in the background, plan mode with a live checklist viewer, `@` file references, image attachments, and optional voice input.
- **Bring your own model.** pi owns provider config and auth: OpenAI, Anthropic, subscription login, or any OpenAI-compatible endpoint (DeepSeek, Ollama, LM Studio, vLLM, gateways). Switch models mid-session; separate ASR models for voice.
- **Bilingual UI.** Chinese and English, switchable in settings.

## Quick start

> Requirements: [pi CLI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) installed and verified in a terminal (auth and models are managed by pi itself), Node.js ≥ 20 if building from source.

**Download** the installer for your platform from [Releases](https://github.com/xiaoliu10/pi-desktop/releases/latest):

- macOS (Apple Silicon): `PI.Desktop-<version>-arm64.dmg`
- Windows: `PI.Desktop.Setup.<version>.exe`

Or run from source:

```bash
pnpm install
pnpm dev        # Vite HMR + Electron
# or
pnpm build && pnpm start
```

> If the Electron binary wasn't downloaded during `pnpm install` (pnpm 10+ blocks build scripts by default), run `pnpm rebuild electron`.

### First run

1. Start PI Desktop — your existing CLI sessions appear on the left automatically, grouped by project.
2. Browse any session read-only, then click **Continue in Desktop** to create a continuation copy; the CLI original stays untouched.
3. Start a new session, pick the project trust and tool permission mode, choose a model, and send your first task.

Verified against pi **0.85.1 up to (not including) 1.3.0 on macOS and Windows** — the bundled runtime ships 1.2.0. Unknown versions stay readable but are disabled for execution; the app falls back to the bundled runtime.

## How it works

```
┌─────────────── PI Desktop (Electron) ───────────────┐
│  Renderer   React UI: chat · review · terminal ·    │
│             plans · plugins · settings · remote     │
├────────────── contextBridge (typed IPC) ────────────┤
│  Main        session discovery · self-healing RPC   │
│              watchdog · permissions · safeStorage   │
└──────────────────────┬──────────────────────────────┘
                       │ pi --mode rpc
┌──────────────────────▼──────────────────────────────┐
│  pi CLI: agent loop · tools · providers · auth      │
│  (sessions, models and skills stay in pi)           │
└─────────────────────────────────────────────────────┘
```

PI Desktop drives your local pi through its RPC mode. CLI sessions are discovered on disk and followed live; nothing is imported or duplicated. Desktop settings store only paths and UI preferences — API keys and subscriptions never leave pi.

## Feature tour

- **CLI sessions appear automatically** — grouped by cwd, following on-disk history; continuation copies keep the original read-only.
- **Per-action tool confirmation** — a dedicated pi extension implements allow / deny / cancel dialogs with session-wide grants; permission modes switchable in the composer (this is app-level confirmation, not an OS sandbox).
- **Real review** — the Review panel aggregates the net diff of file changes within a session (line-level), so you see exactly what changed.
- **Integrated terminal** — a multi-tab terminal panel toggled from the top bar; sessions stay alive in the background.
- **Plan mode** — the plan document and checklist progress render live while the agent works, with snapshot recall and one-click "execute plan".
- **Subagents** — define subagents locally; they run as standalone pi sessions with live activity cards in the conversation.
- **MCP** — stdio and Streamable HTTP servers register tools into pi, managed from the settings UI.
- **Plugins & skills marketplace** — discover, install and manage pi resources (commands, skills, extensions) from a unified page.
- **Memory** — optional long-term/project memory via the pi-memory extension, browsable and editable in settings.
- **Notifications with dedup** — queue, steering and settlement events surface once, never spam.
- **Voice input** — cloud ASR (OpenAI transcriptions endpoint or chat-multimodal gateways, with 404 auto-fallback), transcription appended to the composer, never auto-sent. See [Voice input setup](./docs/voice-input.md) for configuration details.
- **Bilingual UI & theming** — Chinese/English switchable, light/dark themes, font choice.

## 📅 Recent releases

<table>
<thead><tr><th>Version</th><th>Highlights</th></tr></thead>
<tbody>
<tr><td><strong>0.1.28</strong></td><td><ul><li><strong>Ghost "running" sessions fixed</strong>: the sidebar count settles to zero once subagents finish, and dead subagents no longer pin a session as running forever.</li><li><strong>Workflow cards stop faking activity</strong>: long-session workflows that finished long ago no longer show "running · waiting for workflow children".</li><li><strong>Typing no longer lags on huge sessions</strong>: collapsed tool/thinking sections are no longer built (HTML size -39%), and streaming text updates in chunks.</li><li><strong>Huge sessions stop pinning a CPU core</strong>: only the tail screen is transferred with on-demand paging — main-process CPU 99% → 14%, transfer -73%.</li><li><strong>Lower memory for image-heavy sessions</strong>: base64 is no longer re-concatenated on every render (195MB of images: much less GC pressure).</li><li><strong>Task checklists work in every mode</strong>: no longer plan-mode-only — create/update checklists in any access mode, live progress in the sidebar.</li><li><strong>Extension "edit source" flash-close fixed</strong>: read failures keep the window open with the reason and a retry.</li></ul></td></tr>
<tr><td><strong>0.1.27</strong></td><td><ul><li><strong>Typing lag rooted out (huge sessions)</strong>: 0.1.26 fixed the main process, this fixes the renderer — the per-150ms recompute on 10k-message sessions dropped from 259ms to 10ms (22×).</li><li><strong>Sidebar spinner covers subagents</strong>: when the main task ends but subagents still run, the busy indicator keeps spinning instead of looking finished.</li><li><strong>Subagent progress no longer lost</strong>: workflow cards silently vanished (no progress, no transcript) once a session passed 32 subagent calls.</li><li><strong>Extension “edit source” opens again</strong>: fixed a resource-id mismatch; read failures keep the window open with the reason and a retry instead of flashing away.</li><li><strong>DingTalk notifications work</strong>: task notices need the group bot Webhook — the config page is now grouped cards with explicit warnings when it is missing.</li><li><strong>Sidecar understands the main session</strong>: it now receives a summary of what the main conversation is doing; the UI is fully aligned with the main chat.</li><li><strong>Four in-house plugins built in</strong>: subagents / project memory / quality prompt / quality gates install automatically on first launch (CLI too); an existing same-capability package is never replaced without notice.</li></ul></td></tr>
<tr><td><strong>0.1.26</strong></td><td><ul><li><strong>Typing lag fixed on huge sessions</strong>: history parsing now reads only the appended tail — a 103.7MB session went from 421ms full re-parse to 0.18ms on average, and history reads no longer full-scan (173ms hot / 3.5s cold → 0ms).</li><li><strong>Mobile sends instantly</strong>: your message appears right away instead of waiting for the desktop to confirm; failures retract it with a reason.</li><li><strong>Mobile approval cards stop looping</strong>: an expired card that only showed an error now reconciles against the desktop before disappearing, and cards missed while offline are cleaned up on reconnect.</li><li><strong>Mobile zoom locked</strong>: no accidental pinch-zoom, and the input no longer triggers iOS auto-zoom.</li><li><strong>Edit & resend on mobile</strong>: sent messages get an edit button wired to the same fork-based rewind as the desktop.</li><li><strong>Subagent cards show their task</strong>: workflow children display what they are doing instead of an abstract key; redacted tasks never get reverse-engineered.</li><li><strong>Bot-icon subagent cards</strong>: the persistent banner is gone; subagent state lives in the conversation flow (ZCode parity).</li></ul></td></tr>
<tr><td><strong>0.1.25</strong></td><td><ul><li><strong>No more confirm on session switch</strong>: the running-subagents bar stays, switching is uninterrupted; disconnect keeps its confirmation.</li><li><strong>Bundled pi 1.3.0</strong>: fixes subagent tools missing after continue; a local pi 1.3.x is now accepted directly.</li></ul></td></tr>
<tr><td><strong>0.1.24</strong></td><td><ul><li><strong>Subagent visibility</strong>: a persistent "N subagents working" bar above the composer opens the panel on click; switching or disconnecting a session now asks for confirmation first.</li><li><strong>Model config applies live</strong>: connected sessions reload models.json, rebind the model and re-read thinking levels right after save; busy runs defer to a safe idle point, failures never fake success.</li><li><strong>Plan shows only the latest turn</strong>: long-lived sessions no longer display checklists from finished tasks.</li><li><strong>Completions subagent cards restored</strong>: third-shape children return to the card with readable transcripts.</li><li><strong>Smoother long sessions</strong>: module-level labels cache fixes full-tree re-renders while streaming.</li></ul></td></tr>
<tr><td><strong>0.1.23</strong></td><td><ul><li><strong>/skill shows only your instruction</strong>: the skill body collapses to one expandable line; edit-resend keeps skill context.</li><li><strong>Checklist becomes a plan document</strong>: synthesizes a full-page Markdown plan (progress + status table) when no plan doc exists, copyable.</li><li><strong>Second prompt-cache breakpoint</strong>: long sessions add an explicit breakpoint at the previous write point to raise cache hits (Anthropic-family only, toggleable).</li><li><strong>Async subagent cards visible</strong>: single-workflow children return to the card with on-demand child transcript tail.</li><li><strong>Slash/skill keyboard nav</strong>: ↑↓ cycle and Enter select restored; @file keeps its @ prefix.</li></ul></td></tr>
<tr><td><strong>0.1.22</strong></td><td><ul><li><strong>Subagent cards restored</strong>: children of the new async workflow mode show again in the side card with live statuses, and are no longer marked interrupted when the parent goes idle.</li><li><strong>Memory page aligned with centralized storage</strong>: the storage directory shows the real location; switch and pipeline descriptions now match actual behavior.</li></ul></td></tr>
<tr><td><strong>0.1.21</strong></td><td><ul><li><strong>Scoped memory compatibility</strong>: recognizes the scoped plugin; summaries and browsing use centralized project storage instead of recreating project-local memory.</li><li><strong>Fold skill and Goal text</strong>: expandable one-line summaries without changing model context.</li><li><strong>Hide nested subagent sessions</strong>: async internal sessions stay out of desktop and mobile project lists.</li><li>Updated pi compatibility and bundled-runtime documentation.</li></ul></td></tr>
<tr><td><strong>0.1.20</strong></td><td><ul><li><strong>Lazy mobile history</strong>: only the latest 50 entries on open, earlier history pages in on scroll-up; huge sessions open instantly on entry, session switch and turn end.</li><li><strong>Keyboard-navigable skill list</strong>: arrow keys move the highlight, Enter selects; highlight resets when filtering.</li><li><strong>Automation no longer double-runs</strong>: busy sessions queue instead of spawning a second session; fixes mis-attributed user-turn settlements that caused a second execution.</li><li><strong>Mobile thinking stream collapses</strong>: a one-line "Thinking… (N chars)" expandable chip during streaming that auto-folds once the answer starts; jitter fixes (throttled render + smart follow-scroll).</li><li>Session-affinity option cards stack vertically instead of stretching super-wide.</li></ul></td></tr>
<tr><td><strong>0.1.19</strong></td><td><ul><li><strong>Bundled pi runtime 1.1.0 → 1.2.0</strong>: protocol verified command-by-command (RPC command set / events / signatures unchanged); local-CLI compatibility window widened.</li><li><strong>Send screenshots from mobile</strong>: the remote viewer gains image attachments (camera/library, up to 10) sent with your message; the connection line shows the desktop version.</li><li><strong>Stronger mobile filtering</strong>: archived/removed projects and internal subagent/sidecar sessions no longer appear in lists, history or live events (symlink aliases, instant removal, foreground refresh).</li><li><strong>dist keeps only the current installer</strong>: old artifacts are pruned automatically after packaging.</li></ul></td></tr>
</tbody>
</table>

> Only recent releases are listed here. See [CHANGELOG.md](./CHANGELOG.md) for the full history.

## Development

```bash
pnpm install
pnpm dev            # dev orchestration (Vite + tsc + Electron)
pnpm typecheck      # main + renderer
pnpm test           # vitest unit + browser tests
pnpm preview:ui     # pure-web UI preview (no Electron / model keys / user files)
```

Real process-isolation test run (no external model calls):

```bash
PI_TEST_EXECUTABLE=/opt/homebrew/bin/pi pnpm exec vitest run tests
```

Development docs under [`docs/`](./docs) are written in Chinese: [RPC protocol baseline](./docs/pi-protocol-baseline.md) · [Tool permission boundary](./docs/pi-permission-boundary.md) · [Settings implementation](./docs/settings-implementation.md) · [Phase 2 delivery & verification](./docs/pi-integration-verification.md).

## Differences from the reference project

The UI takes inspiration from [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) (LGPL-3.0, no code reused). That project pairs Electron with a Rust host core; PI Desktop is an independent, Node-only implementation focused on the pi CLI integration: a Node main process carries the host-core responsibilities, so there is no Rust toolchain to build.

## Contributing

Issues and PRs are welcome. Please open an issue to discuss the approach first; make sure `pnpm typecheck && pnpm test` passes before submitting.

## Acknowledgements

- [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — the agent kernel this workbench drives
- Product shape and architecture ideas reference [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) (LGPL-3.0); no code was reused
- [Electron](https://www.electronjs.org/) · [React](https://react.dev/) · [Vite](https://vite.dev/) · [zustand](https://zustand.docs.pmnd.rs/) · [react-markdown](https://github.com/remarkjs/react-markdown) · [highlight.js](https://highlightjs.org/)

## License

Licensed under the [Apache License 2.0](./LICENSE).
