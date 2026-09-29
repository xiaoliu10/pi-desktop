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

## 语音输入

语音输入使用独立配置的云端 ASR（语音识别）模型，不随会话的聊天模型切换。录音转写后只会**追加到输入框，不会自动发送**；检查文字后再手动发送。

### 配置与使用

1. 打开 **设置 → 语音输入 → 添加模型**，填写模型名称、接口地址、转写模型 ID 和 API key。
   - 接口地址填写服务的基础地址（包含所需的 `/v1` 等前缀），**不要附加** `/audio/transcriptions` 或 `/chat/completions`；客户端会拼接路由。新建时留空使用 `https://api.openai.com/v1`。
   - 模型名称仅用于显示；模型 ID 必须与服务商提供的音频识别模型一致。
   - 语言可填 `zh` 等 ISO-639-1 代码，留空自动检测。编辑已有模型时，API key 留空会保留已保存的密钥。
2. 根据服务实际支持的协议选择「调用方式」，保存后将模型设为「生效中」。可保存多个模型，转写只使用当前生效模型。
3. 点击输入框右下角的麦克风并允许系统麦克风权限，再次点击停止并转写。当前生效模型必须就绪；「就绪」只表示地址、模型 ID 和密钥满足本地检查，**不代表已验证远端接口或账号权限**。

配置示例（示意，不是服务可用性或套餐权限承诺）：

| 设置项 | OpenAI 转写端点示例 | Chat 多模态网关示例 |
| --- | --- | --- |
| 模型名称 | 我的转写模型 | 我的 Chat ASR |
| 接口地址 | `https://api.openai.com/v1` | `https://gateway.example.com/v1`（替换为实际地址） |
| 转写模型 ID | `whisper-1` | 服务商支持下述音频请求格式的 ASR 模型 ID |
| 调用方式 | OpenAI 转写端点 | Chat 多模态 |
| 语言 | `zh` 或留空 | `zh` 或留空 |
| API key | 对应服务的密钥 | 对应网关且有音频模型权限的密钥 |

### 两种调用方式与兼容范围

两种方式均使用 `Authorization: Bearer <API key>`，但请求与响应格式不同：

- **OpenAI 转写端点（`transcriptions`，默认）**：向基础地址下的 `POST /audio/transcriptions` 发送 multipart 表单，包含 `file`、`model`、`response_format=json`，以及非空时的 `language`；读取响应 JSON 的 `text`。
- **Chat 多模态（`chat`）**：向 `POST /chat/completions` 发送 JSON，包含 `model`、用户消息中的 `input_audio.data`（形如 `data:audio/wav;base64,…` 的 data URL），以及 `asr_options.language`（留空时为 `auto`）。读取 `choices[0].message.content`；支持字符串或带 `text` 的分段数组。

「兼容 Chat」不等于支持音频输入；网关和模型必须接受上述请求格式。MiMo 等服务也需分别确认**具体接口地址、模型、API key 和套餐的音频权限**；不能仅凭模型名称或 token-plan 地址判断一定可用。

### 404 自动回退与保存

- 仅当当前调用方式为 `transcriptions`，且 `/audio/transcriptions` 返回 **HTTP 404** 时，使用同一基础地址、模型、密钥、语言和音频，**自动尝试一次** Chat 多模态请求。
- Chat 返回成功响应且解析出非空文字后，本次转写成功并显示切换提示。若原模型未在请求期间被编辑或删除，会保存其调用方式为 `chat`；保存成功后，后续录音（包括应用重启后）直接走 Chat。
- 若请求期间原模型已编辑或删除，不覆盖当前设置；若保存失败，仍保留转写文字并提示手动选择 Chat 多模态。切换生效模型不会被这次回退撤销。
- Chat 尝试失败（包括空结果或超时）时，不更改调用方式，错误会说明两次尝试及检查方向。鉴权、参数、限流、其他非 404 HTTP 错误或网络错误不会触发自动切换；已选择 `chat` 时也不会反向回退。两次请求共用 120 秒超时预算。

### 音频限制与隐私

- 录音由浏览器采集，单次最长 **5 分钟**，到时自动停止并转写；上传音频字节上限为 **24 MiB**。服务端可能另有限制。
- 上传前尝试在本地转为 **16 kHz、单声道、16-bit PCM WAV**。若 `AudioContext` 不可用或解码/转码失败，会上传浏览器的原始录音格式（如 WebM 或 MP4）；因此不能保证每次上传都是 WAV，服务端仍可能拒绝格式。
- 录音会上传到当前生效模型配置的接口地址，并非离线识别。请选择可信接口，避免录入不应交给该服务的内容。
- 配置存于 Electron `userData` 下的 `voice.json`。主进程通过 Electron `safeStorage` 保存 API key；**系统加密不可用时会退回带 `plain:` 前缀的 Base64 存储，这不是加密**，需保护本地用户数据目录。
- 配置读取不向渲染进程回传已保存的密钥明文，只返回 `hasKey` 状态；新输入的密钥经设置表单交给主进程保存。删除模型也会删除该模型保存的密钥。

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
