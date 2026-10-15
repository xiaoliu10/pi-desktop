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
<tr><td><strong>0.1.21</strong></td><td><ul><li><strong>Scoped memory compatibility</strong>: recognizes the scoped plugin; summaries and browsing use centralized project storage instead of recreating project-local memory.</li><li><strong>Fold skill and Goal text</strong>: expandable one-line summaries without changing model context.</li><li><strong>Hide nested subagent sessions</strong>: async internal sessions stay out of desktop and mobile project lists.</li><li>Updated pi compatibility and bundled-runtime documentation.</li></ul></td></tr>
<tr><td><strong>0.1.20</strong></td><td><ul><li><strong>Lazy mobile history</strong>: only the latest 50 entries on open, earlier history pages in on scroll-up; huge sessions open instantly on entry, session switch and turn end.</li><li><strong>Keyboard-navigable skill list</strong>: arrow keys move the highlight, Enter selects; highlight resets when filtering.</li><li><strong>Automation no longer double-runs</strong>: busy sessions queue instead of spawning a second session; fixes mis-attributed user-turn settlements that caused a second execution.</li><li><strong>Mobile thinking stream collapses</strong>: a one-line "Thinking… (N chars)" expandable chip during streaming that auto-folds once the answer starts; jitter fixes (throttled render + smart follow-scroll).</li><li>Session-affinity option cards stack vertically instead of stretching super-wide.</li></ul></td></tr>
<tr><td><strong>0.1.19</strong></td><td><ul><li><strong>Bundled pi runtime 1.1.0 → 1.2.0</strong>: protocol verified command-by-command (RPC command set / events / signatures unchanged); local-CLI compatibility window widened.</li><li><strong>Send screenshots from mobile</strong>: the remote viewer gains image attachments (camera/library, up to 10) sent with your message; the connection line shows the desktop version.</li><li><strong>Stronger mobile filtering</strong>: archived/removed projects and internal subagent/sidecar sessions no longer appear in lists, history or live events (symlink aliases, instant removal, foreground refresh).</li><li><strong>dist keeps only the current installer</strong>: old artifacts are pruned automatically after packaging.</li></ul></td></tr>
<tr><td><strong>0.1.18</strong></td><td><ul><li><strong>Desktop version in the sidebar</strong>: the footer now shows both versions ("Desktop 0.1.18 · pi 1.1.0") instead of only the pi version.</li><li><strong>Remote control hides archived projects</strong>: the mobile viewer now filters archived sessions and removed projects exactly like the desktop sidebar.</li><li><strong>Session-affinity picker is visible</strong>: the three options became bordered cards, each showing the header it sends and when to use it.</li></ul></td></tr>
<tr><td><strong>0.1.17</strong></td><td><ul><li><strong>Session stats</strong>: the status bar gains output speed (t/s), cache hit rate and context usage in one row — model speed and context headroom at a glance (#97).</li><li><strong>Model session affinity</strong>: per-model sticky session routing (x-session-id / x-session-affinity) in the model editor for better prompt caching; auto-enabled on OpenRouter (#98).</li><li><strong>Workbench home</strong>: the side panel opens on a feature-picker page (changes / files / browser / auxiliary chat cards) with a new auxiliary-chat tab sharing the topbar session (#94).</li><li><strong>Auto-scroll on session switch</strong>: switching sessions now lands on the latest message instead of the oldest position (#95).</li></ul></td></tr>
<tr><td><strong>0.1.16</strong></td><td><ul><li><strong>Auxiliary chat panel</strong>: an auxiliary conversation beside the main chat — read-only tools, separate history, zero pollution of main-session context; conversations survive panel close, attention badge when input is needed (#86).</li><li><strong>In-app updates</strong>: automatic update checks with a green download badge in the sidebar; one click downloads, swaps and restarts (sha256 verification + rollback on failure) (#84/#85).</li></ul></td></tr>
<tr><td><strong>0.1.15</strong></td><td><ul><li><strong>Bundled pi runtime upgraded 1.0.4 → 1.1.0</strong> (#81), fully protocol-compatible.</li><li><strong>Keyboard-first ask/approval cards</strong>: ↓ moves into the custom-answer field for direct typing, ↑/Tab moves back to options, Enter submits exactly once; Shift+Enter for newlines on approval cards (#82).</li><li><strong>Coexistence with third-party ask_user_question plugins</strong>: rpiv et al. no longer crash pi at startup (sessions previously failed to open and thinking levels went missing); their questions render as rich cards (#83).</li></ul></td></tr>
<tr><td><strong>0.1.14</strong></td><td><ul><li><strong>Automations now reuse the project's latest idle session by default</strong> — context carries over and results land in the original conversation; opt into a fresh session per task (#79).</li><li><strong>Fold an entire running turn</strong> — click any execution-group header to collapse all tools/thinking into one summary row; narration stays in place while streaming, no more position jumping (#80).</li><li><strong>Session cap raised 6 → 12</strong> with LRU eviction of the safest idle session instead of rejecting connects (#75).</li><li><strong>Oversized sessions no longer vanish from the sidebar</strong> — limit raised to 512 MiB with metadata-visible degradation (#78).</li><li><strong>DingTalk one-click setup fixed</strong> (IPC channel mismatch, broken since #49) + actionable Chinese message for `/compact` truncation (#77).</li><li><strong>Unsent drafts kept per session</strong> (text + images/files survive switching); ↑↓ history recall restores all attachments (#76).</li></ul></td></tr>
<tr><td><strong>0.1.13</strong></td><td><ul><li><strong>`desktop_schedule` tool</strong> — agents can create/manage Desktop scheduled tasks (once/interval/cron), executed by the Desktop scheduler in dedicated sessions.</li><li><strong>DingTalk scan-to-configure</strong> (device flow auto-creates the app, #48/#49); <strong>WeChat channel</strong> with ServerChan/PushPlus push (#50).</li><li><strong>Mobile remote page redesigned</strong> as a ZCode-style project list (#47).</li><li>Editable reasoning-level chips (#54); renderer black-screen guard (#51); user bubble overflow fix (#52); compaction token accounting fix (#46).</li></ul></td></tr>
<tr><td><strong>0.1.12</strong></td><td><ul><li><strong>pi 1.0 adaptation</strong> — bundled runtime pi 1.0.0 / Node 22.23.3; <strong>direct image generation</strong> with session-side result cards (#15).</li><li><strong>Unified plugin marketplace</strong> — extensions merged into the marketplace with enable/update/source editing (#12/#14); MCP disable toggles + import (#3); memory UI badge (#2).</li><li>Notification dedup + independent scrolling; ZCode-aligned channel icons (#10/#11).</li></ul></td></tr>
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
