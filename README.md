# PI Desktop

**English** | [简体中文](./README.zh-CN.md)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**The desktop workspace for AI coding agents.** Bring your own model. Open any local project. Let agents work — while you stay in control.

PI Desktop is a desktop workbench powered by your local **pi CLI**. The UI takes inspiration from [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) and shares your machine's pi model configuration, sessions, and installed resources.

> Development docs under [`docs/`](./docs) are written in Chinese.

## Settings, wired to real features

AI default behavior, shortcuts, commands, skills, MCP, extensions, subagents, connection & storage, import, and project pages are all backed by real functionality. MCP supports stdio / Streamable HTTP and registers tools into pi; subagents run as standalone pi sessions based on local definitions. See [设置页面实现与验收](./docs/settings-implementation.md) (Chinese) for details and boundaries.

## Current focus

Phase 2 — local pi integration — is implemented, with `pi --mode rpc` as the production entry; the Phase 1 UI replica continues in parallel. Shipped today:

- **CLI sessions appear automatically**: no import needed; grouped by cwd and follow on-disk history.
- **Desktop continuation copies**: the CLI original stays untouched; send messages, switch models, queue, and stop through your local pi.
- **Local plugins & resources**: statically discovers global/project resources, shows real commands, bridges the standard Extension UI.
- **Per-action tool confirmation**: a dedicated pi extension handles allow / deny / cancel — this is not an OS sandbox.
- **Real Review**: inspect the net workspace diff against Git HEAD; it never claims another session's changes as its own.
- **Integrated terminal**: a multi-tab terminal panel (node-pty + xterm) toggled from the top bar; sessions stay alive in the background — on par with ZCode's side-pane terminal.
- **Plan viewer**: in plan mode the plan document and checklist progress render live, with snapshot recall and one-click "execute plan".

Verified locally against pi **0.85.1+ on macOS**; unknown versions are disabled for execution but remain readable. Authentication stays inside pi — never copied to the frontend. Desktop settings only store paths. Existing CLI sessions are read-only by default; a continuation copy is created explicitly before executing.

- [Phase 2 delivery & verification](./docs/pi-integration-verification.md): startup, screenshots, code navigation, tests, known limitations. (Chinese)
- [RPC protocol baseline](./docs/pi-protocol-baseline.md) · [Tool permission boundary](./docs/pi-permission-boundary.md). (Chinese)
- [UI replica spec](./docs/ui-replica-spec.md) · [Local pi kernel flow](./docs/coding-agent-workflow.md) · [Agent task board](./docs/agent-task-board.md). (Chinese)

The "prototype" sections below are historical. The legacy loop, providers, safeStorage model forms, and legacy modes are not enabled in the current production entry; old data is preserved but there is no migration UI yet.

## Prototype features

- **Projects / sessions**: add any local directory as a project; pin, archive, rename, search, and delete sessions
- **Three work modes**: `Agent` (get it done) / `Plan` (research first, produce an implementation plan, file edits gated on approval) / `Goal` (objective & acceptance criteria first)
- **Multi-provider models**: OpenAI, Anthropic, and any OpenAI-compatible API (DeepSeek, Ollama, LM Studio, vLLM, gateways); switch models per session at any time
- **Streaming output**: SSE-rendered Markdown (GFM, code highlighting), interrupt anytime, queue follow-ups while running
- **Permission system**: reads allowed; edits and command execution ask by default (allow once / always for this session / deny), switchable to auto-edit or full access
- **Built-in tools**: `list_dir` / `read_file` / `grep` / `write_file` / `edit_file` / `run_command`, all confined to the project root
- **Change review**: the Review panel aggregates all file changes within a session (line-level diff)
- **@ file references**: type `@` to fuzzy-reference files in the project
- **Bilingual UI**: switch between Chinese and English in settings

## Quick start

Requirements: Node.js ≥ 20, pnpm ≥ 10 (the repo is developed on pnpm 11).

```bash
pnpm install

# Dev mode (Vite HMR + Electron)
pnpm dev

# Production build and run
pnpm build
pnpm start

# UI replica preview (Phase 1 deliverable; pure web, no Electron / model keys / user files)
pnpm preview:ui
# Open http://127.0.0.1:5174/?preview=1

# Checks
pnpm typecheck
pnpm test
```

> If the Electron binary was not downloaded during `pnpm install` (pnpm 10+ blocks dependency build scripts by default), run `pnpm rebuild electron`, or confirm `electron` is listed in `pnpm.onlyBuiltDependencies` in package.json and reinstall.

### First run

1. Verify local pi works in a terminal first; auth and models are managed by pi itself.
2. Start Desktop — CLI sessions appear on the left automatically; select one to browse read-only.
3. Click "Continue in Desktop" or "New pi session", choosing project trust and tool permissions.
4. Pick a pi model and send a task; the plugins page lists local resources, and `/` shows real commands.
5. If the installation is not detected, point to your pi path and directory in "Connection settings".

Real process-isolation test run (no external model calls):

```bash
PI_TEST_EXECUTABLE=/opt/homebrew/bin/pi pnpm exec vitest run tests
```

## Prototype architecture (legacy, pending migration)

```
┌────────────── Renderer (React + Vite + Tailwind, no Node) ──────────────┐
│  Sidebar │ TopBar │ ChatView │ Composer │ ReviewPanel │ Settings        │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ contextBridge (window.pi, typed IPC)
┌───────────────────────────▼ Preload ────────────────────────────────────┐
└───────────────────────────┬────────────────────────────────────────────┘
┌───────────────────────────▼ Electron Main ──────────────────────────────┐
│  Store          settings / models / projects / sessions(JSONL)          │
│  AgentRuntime   streaming loop · tools · queue · interrupt · plan FSM   │
│  Permissions    ask / autoEdit / fullAccess · session grants · plan gate│
│  Providers      OpenAI-compatible / Anthropic (SSE, incremental tools)  │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Renderer**: `src/renderer` — React 18 + zustand, event-driven (main process pushes `agent` / `permission` events)
- **Shared**: `src/shared` — IPC protocol & domain types (`types.ts`, `api.ts`), pure-function diff utilities
- **Main**: `src/main` — host core & agent runtime; windows hardened with `contextIsolation + sandbox`

### On-disk layout (Electron userData)

```
settings.json                    app settings
models.json                      providers & models (API keys encrypted via safeStorage)
projects.json                    project registry
sessions/<projectId>/<sessionId>/
  meta.json                      session metadata (title/pin/archive/model/mode/plan state)
  events.jsonl                   append-only session log (messages, tool calls, results, diffs)
```

## Differences from the reference project

The reference project (vastsa/PI-Desktop) uses Electron + a Rust host core + the pi Agent Harness in a multi-process architecture, with a plugin marketplace, MCP, subagents, session import, and more. This project is an independent, minimal implementation of its core experience: a Node main process carries the host-core responsibilities (no Rust toolchain), with a self-built agent loop and tool protocol, focused on the main path of "open project → configure model → supervised agent coding". Plugins, MCP, and session import are potential future directions.

## Project structure

```
pi-desktop/
├── scripts/dev.mjs          # dev orchestration (Vite + tsc + Electron)
├── src/
│   ├── shared/              # type protocol, PiApi, diff
│   ├── main/                # Electron main process
│   │   ├── index.ts         # entry: window, menu, IPC registration
│   │   ├── store.ts         # local persistence (JSON / JSONL)
│   │   ├── secrets.ts       # safeStorage key encryption
│   │   ├── agent/           # runtime, tools, permissions, prompts
│   │   └── providers/       # OpenAI-compatible / Anthropic streaming
│   ├── preload/             # contextBridge bridge
│   └── renderer/            # React UI
├── tests/                   # vitest unit tests
├── LICENSE                  # Apache-2.0
└── NOTICE
```

## Contributing

Issues and PRs are welcome. Please open an issue to discuss the approach first; make sure `pnpm typecheck && pnpm test` passes before submitting.

## Acknowledgements

- Product shape and architecture ideas reference [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) (LGPL-3.0); no code was reused
- [Electron](https://www.electronjs.org/) · [React](https://react.dev/) · [Vite](https://vite.dev/) · [Tailwind CSS](https://tailwindcss.com/) · [zustand](https://zustand.docs.pmnd.rs/) · [react-markdown](https://github.com/remarkjs/react-markdown) · [highlight.js](https://highlightjs.org/)

## License

Licensed under the [Apache License 2.0](./LICENSE).
