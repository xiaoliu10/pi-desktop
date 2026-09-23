# PI Desktop

[English](./README.md) | **简体中文**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**AI 编程代理的桌面工作台。** 自带模型，打开任意本地项目，让代理干活——控制权始终在你手里。

PI Desktop 是一个以本地 **pi CLI 为内核** 的桌面工作台。UI 参考 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)，共享本机 pi 的模型配置、会话和已安装资源。

## 设置页功能

AI 默认行为、快捷键、指令、技能、MCP、扩展、子代理、连接与存储、导入、项目页面已接上实际功能。MCP 支持 stdio / Streamable HTTP 并注册到 pi 工具；子代理按本地定义作为独立 pi 会话运行。详细操作与边界见 [设置页面实现与验收](./docs/settings-implementation.md)。

## 当前开发方向

第二阶段本地 pi 接入已实现，生产入口使用 `pi --mode rpc`；第一阶段 UI 复刻仍在并行开发。现已支持：

- **CLI session 自动可见**：无需导入或添加项目，按 cwd 分组，自动跟随已落盘的历史。
- **桌面接续副本**：保留 CLI 原文件，通过本机 pi 发送消息、选择模型、排队、停止。
- **本地插件与资源**：静态发现全局/项目资源，显示实际命令，桥接标准 Extension UI。
- **工具逐次确认**：独立的 pi 扩展负责允许、拒绝与取消；不是操作系统沙箱。
- **真实 Review**：查看工作区相对 Git HEAD 的净变化，不冒充当前会话独占修改。
- **内置终端**：node-pty + xterm 的多 tab 终端面板（顶栏切换，会话后台保活），与 ZCode 侧板终端同级体验。
- **计划查看器**：计划模式下实时渲染计划文档与任务清单进度，支持快照回看与一键按计划执行。

本机已验证 pi **0.85.1+ / macOS**；未知版本执行禁用但历史可读。认证由 pi 自身管理，不复制到前端。Desktop 设置只保存路径。现有 CLI 会话默认只读，执行前显式创建副本。

- [第二阶段交付与验证](./docs/pi-integration-verification.md)：启动、截图、代码导航、测试及已知限制。
- [RPC 协议基线](./docs/pi-protocol-baseline.md) · [工具权限边界](./docs/pi-permission-boundary.md)。
- [UI 复刻规格](./docs/ui-replica-spec.md) · [本地 pi 内核流程](./docs/coding-agent-workflow.md) · [Agent 领取板](./docs/agent-task-board.md)。

以下“原型”章节仅作历史说明。旧循环、Provider、safeStorage 模型表单和旧模式未在当前生产入口启用；旧数据保留，尚未提供格式迁移 UI。

## 原型功能

- **项目 / 会话**：添加任意本地目录作为项目；会话支持置顶、归档、重命名、搜索、删除
- **三种工作模式**：`Agent`（直接干活）/ `Plan`（先研究并产出实施计划，批准后才能改文件）/ `Goal`（目标与验收标准优先）
- **多提供商模型**：OpenAI、Anthropic，以及任意 OpenAI 兼容 API（DeepSeek、Ollama、LM Studio、vLLM、各类网关）；每个会话可随时切换模型
- **流式输出**：SSE 流式渲染 Markdown（GFM、代码高亮），支持随时中断、运行中排队追问
- **权限系统**：读操作放行；编辑与命令执行默认询问（本次允许 / 本会话始终允许 / 拒绝），可按需切换为自动允许编辑或完全放行
- **内置工具**：`list_dir` / `read_file` / `grep` / `write_file` / `edit_file` / `run_command`，全部限制在项目根目录内
- **变更审查**：Review 面板汇总会话内所有文件改动（行级 diff）
- **@ 文件引用**：输入 `@` 模糊引用项目内文件
- **中英双语**：设置中一键切换

## 快速开始

环境要求：Node.js ≥ 20、pnpm ≥ 10（仓库使用 pnpm 11 开发）。

```bash
pnpm install

# 开发模式（Vite 热更新 + Electron）
pnpm dev

# 生产构建并启动
pnpm build
pnpm start

# UI 复刻预览（第一阶段交付；纯 Web，无需 Electron / 模型 Key / 用户文件）
pnpm preview:ui
# 打开 http://127.0.0.1:5174/?preview=1

# 校验
pnpm typecheck
pnpm test
```

> 若 Electron 二进制未随 `pnpm install` 下载（pnpm 10+ 默认拦截依赖构建脚本），执行：
> `pnpm rebuild electron`，或在 package.json 的 `pnpm.onlyBuiltDependencies` 中确认包含 `electron` 后重装。

### 首次使用

1. 先在终端确认本地 pi 可用；认证和模型使用 pi 自己的配置。
2. 启动 Desktop，左侧自动出现 CLI 会话；选择即可只读查看。
3. 点击“在 Desktop 接续副本”或“新建 pi 会话”，选择项目信任与工具权限。
4. 选择 pi 模型后发送任务；插件页可查看本地资源，输入 `/` 可查看实际命令。
5. 如未发现安装，使用“连接设置”指定 pi 路径与目录。

真实进程隔离联调（无外部模型调用）：

```bash
PI_TEST_EXECUTABLE=/opt/homebrew/bin/pi pnpm exec vitest run tests
```

## 现有原型架构（待迁移）

```
┌────────────── Renderer（React + Vite + Tailwind，无 Node）──────────────┐
│  Sidebar │ TopBar │ ChatView │ Composer │ ReviewPanel │ Settings        │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ contextBridge（window.pi，类型化 IPC）
┌───────────────────────────▼ Preload ────────────────────────────────────┐
└───────────────────────────┬────────────────────────────────────────────┘
┌───────────────────────────▼ Electron Main ──────────────────────────────┐
│  Store          settings / models / projects / sessions(JSONL)          │
│  AgentRuntime   流式循环 · 工具执行 · 队列 · 中断 · 计划模式状态机        │
│  Permissions    ask / autoEdit / fullAccess · 会话级授权 · 计划门控      │
│  Providers      OpenAI 兼容 / Anthropic（SSE 流式，增量工具调用解析）     │
└─────────────────────────────────────────────────────────────────────────┘
```

- **渲染层**：`src/renderer` — React 18 + zustand，事件驱动（主进程推送 `agent` / `permission` 事件）
- **共享层**：`src/shared` — IPC 协议与领域类型（`types.ts`、`api.ts`）、纯函数 diff 工具
- **主进程**：`src/main` — 宿主核心与 Agent 运行时；窗口通过 `contextIsolation + sandbox` 加固

### 数据落盘位置（Electron userData）

```
settings.json                    应用设置
models.json                      提供商与模型（API Key 经 safeStorage 加密）
projects.json                    项目注册表
sessions/<projectId>/<sessionId>/
  meta.json                      会话元数据（标题/置顶/归档/模型/模式/计划状态）
  events.jsonl                   追加式会话记录（消息、工具调用、结果、diff）
```

## 现有原型与参考项目的差异

参考项目（vastsa/PI-Desktop）采用 Electron + Rust 宿主核心 + pi Agent Harness 的多进程架构，并包含插件市场、MCP、子代理、会话导入等完整生态。本项目是其核心体验的独立精简实现：以 Node 主进程承担宿主核心职责（无 Rust 工具链依赖），自研 Agent 循环与工具协议，聚焦"打开项目 → 配置模型 → 授权监督下的代理编程"这条主路径。插件系统、MCP、会话导入等可作为后续方向。

## 项目结构

```
pi-desktop/
├── scripts/dev.mjs          # 开发编排（Vite + tsc + Electron）
├── src/
│   ├── shared/              # 类型协议、PiApi、diff
│   ├── main/                # Electron 主进程
│   │   ├── index.ts         # 入口：窗口、菜单、IPC 注册
│   │   ├── store.ts         # 本地持久化（JSON / JSONL）
│   │   ├── secrets.ts       # safeStorage 密钥加密
│   │   ├── agent/           # 运行时、工具、权限、提示词
│   │   └── providers/       # OpenAI 兼容 / Anthropic 流式
│   ├── preload/             # contextBridge 桥接
│   └── renderer/            # React UI
├── tests/                   # vitest 单元测试
├── LICENSE                  # Apache-2.0
└── NOTICE
```

## 参与贡献

欢迎 Issue 和 PR。提交前请先开 Issue 讨论方案；`pnpm typecheck && pnpm test` 通过后再提交。

## 致谢

- 产品形态与架构思路参考 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)（LGPL-3.0），本项目未复用其代码
- [Electron](https://www.electronjs.org/) · [React](https://react.dev/) · [Vite](https://vite.dev/) · [Tailwind CSS](https://tailwindcss.com/) · [zustand](https://zustand.docs.pmnd.rs/) · [react-markdown](https://github.com/remarkjs/react-markdown) · [highlight.js](https://highlightjs.org/)

## 许可证

本项目基于 [Apache License 2.0](./LICENSE) 开源。
