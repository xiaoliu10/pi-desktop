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
<tr><td><strong>0.1.49</strong></td><td><ul><li><strong>Subagent internal sessions no longer flood the session list</strong>: hundreds of <code>subagent-code-reviewer-…</code> entries leaked into the sidebar and phone remote view as fake projects since v0.1.41 — the session header's branch pointer no longer cancels the subagent marker, and the detection now also covers the CLI-project layout. Your own branched/edited-resend sessions stay visible.</li></ul></td></tr><tr><td><strong>0.1.48</strong></td><td><ul><li><strong>Bundled pi upgraded to 1.5.1</strong>: shell credential commands (<code>pi auth login/logout</code>), idle prompt cache warming (up to 30 minutes between runs), Anthropic message threads that send only new messages per request, and several gateway compatibility flags. Both upstream breaking changes were reviewed and do not affect Desktop code paths.</li></ul></td></tr><tr><td><strong>0.1.47</strong></td><td><ul><li><strong>Subagent thinking is now readable on demand</strong>: omitted thinking blocks in the subagent detail panel can be clicked to load the real reasoning text — fetched per block only when you expand it (bounded, cached, with a truncation notice for very long thinking); the default collapsed view and payload are unchanged.</li><li><strong>Required plugins no longer vanish</strong>: the task-checklist plugin (<code>pi-plan-tool</code>) joins the built-in required package list; Desktop checks and auto-installs/registers at startup, and re-registers wiped packages right after a session process exits (a stale settings write-back could previously erase fresh registrations).</li><li><strong>Mobile remote page pins running projects on top</strong>: any project with a running/starting task stays above idle projects and the list re-sorts live as task state changes.</li></ul></td></tr><tr><td><strong>0.1.46</strong></td><td><ul><li><strong>Meeting recording mode</strong>: record a meeting from the Workbench in 5-minute segments (microphone only, up to 8 hours). Segments are saved before transcription, missing or silent parts stay visible instead of being folded into the minutes, and the minutes are generated per segment-ID anchors with unconfirmed owners left as <code>null</code>; export as Markdown.</li><li><strong>Markdown files preview in the right-hand panel again</strong>: delivered <code>.md</code> links render with headings, tables and code blocks plus a preview/source toggle; <code>file://</code> links default to this in-app preview with a "open in default app" fallback.</li><li><strong>Packaging can no longer silently drop the bundled pi runtime</strong>: the pre-pack architecture check is restored and a failed post-pack runtime copy now aborts the build instead of skipping silently.</li></ul></td></tr><tr><td><strong>0.1.45</strong></td><td><ul><li><strong>Fixed 0.1.44 Windows installers still missing the bundled pi runtime</strong>: packaging hooks now handle the Windows layout too; the installer is verified to contain the full bundled pi 1.5.0.</li></ul></td></tr><tr><td><strong>0.1.44</strong></td><td><ul><li><strong>Fixed 0.1.43 installers still missing the bundled pi runtime</strong>: the runtime is now placed before packaging and verified after; installers contain the full bundled pi 1.5.0. Installers 0.1.39–0.1.43 are affected — do not use them for fresh installs.</li></ul></td></tr><tr><td><strong>0.1.43</strong></td><td><ul><li><strong>Fixed a release accident where installers since 0.1.39 shipped without the bundled pi runtime</strong>: fresh installs (no local pi) could not start bundled pi. The runtime is restored and the packaging pipeline now self-checks it.</li></ul></td></tr><tr><td><strong>0.1.42</strong></td><td><ul><li><strong>Bundled pi upgraded to 1.5.0</strong>: extension update changelogs, faster streaming for large tool calls, custom self-update commands, and GPT-6.1 Terra with a 500K Codex context window.</li><li><strong>Local-CLI compatibility window widened to &lt;1.6.0</strong>: a locally installed pi 1.5.x is now detected and launched.</li></ul></td></tr><tr><td><strong>0.1.41</strong></td><td><ul><li><strong>The phone no longer loses your own branched sessions</strong>: sessions created by edit-and-resend, compaction or fork were misread as "internal subagent sessions" and vanished from the phone list; only real subagents are hidden now.</li><li><strong>No more blank confirmation box on the phone remote page</strong>: with a third-party <code>ask_user_question</code> plugin, a failed bridge left a raw request rendering as an unclickable "needs your confirmation" card; it is now recognised and cancelled.</li><li><strong>Web links in a conversation open in the sidebar browser</strong>: clicking one opens a new Workbench tab; right-click for "Open in system browser".</li><li><strong>Manual compaction no longer sticks on "Working for X"</strong>: when compaction times out or fails on a large session, the session now returns to idle, the timer freezes as "Took X", and Stop works again.</li></ul></td></tr><tr><td><strong>0.1.40</strong></td><td><ul><li><strong>Control your desktop from anywhere, not just the same Wi-Fi</strong>: a new public tunnel connects the desktop out to a self-hosted relay, so a phone on mobile data can reach it. Setup is two fields in Settings → Remote (relay address + key); once connected, the main pairing card switches to a public QR code that works on any network and refreshes itself every 50 seconds.</li><li><strong>The relay serves the phone page itself</strong>: scanning the QR opens a self-contained mobile page (embedded in the relay binary), where you can list sessions, open one, watch replies stream in live, send messages and stop a running task — no extra hosting needed.</li><li><strong>Windows: a locally installed <code>pi</code> (npm) now works</strong>: Desktop used to reject every Windows local CLI outright, so having <code>pi</code> installed globally made no difference. It now resolves the npm <code>.cmd</code> wrapper to the real <code>node.exe</code> + entry script and launches that directly, which also handles paths with spaces like <code>C:\Program Files\nodejs</code>.</li><li><strong>Handoffs no longer vanish when the target is busy</strong>: a queued handoff used to live only in the recipient's memory — invisible, lost on restart, and never delivered if that session stayed busy. Queued items are now saved immediately, restored and retried on the next start, deduplicated by key, and shown with a notification; the sender reports whether it was actually delivered.</li><li><strong>The handoff tool can no longer disappear</strong>: it is now part of the built-in package set, so a stale settings write-back can no longer leave sessions without <code>session_handoff</code>.</li></ul></td></tr>


<tr><td><strong>0.1.36</strong></td><td><ul><li><strong>Cross-session handoff (new desktop_handoff tool)</strong>: hand findings to the session responsible for another project — reuses that project's most recent unarchived session, starts immediately when idle, queues behind a busy turn, reconnects first when disconnected; project memory/permissions stay isolated. No more shuttling findings via temp files.</li><li><strong>Fixed full-app white-screen crash when a new version is detected</strong>: the update banner misused process.platform (main-process-only) and crashed the renderer on render; now uses browser platform detection, plus per-window navigation forensics so the rare "window full of source code" issue becomes diagnosable.</li></ul></td></tr>





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
