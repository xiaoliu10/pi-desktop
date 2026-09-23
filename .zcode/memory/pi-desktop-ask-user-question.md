---
name: pi-desktop-ask-user-question
description: desktop-ask 内置扩展实现 ask_user_question 富问题卡片（ui.input 载荷通道）；pi 生态的社区 ask 插件基于 ctx.ui.select，Desktop 原生兼容
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi Desktop 自带 `extensions/desktop-ask/index.mjs`，注册 `ask_user_question` 工具（ZCode AskUserQuestion 风格：1-4 问、每问 2-4 选项带描述、可选多选），随桌面会话默认以 `-e` 加载（打包进 extraResources `desktop-ask`），计划模式白名单与 desktop-policy classify 均显式放行。

**关键机制：** pi 的 RPC UI 只有纯文本 `select/confirm/input`（无描述/多选），desktop-ask 把问题 JSON 编码进保留标题 `desktop-ask` 的 `ctx.ui.input` 请求，渲染层 ExtensionDialog 识别该标题后渲染富问题卡片、以 JSON 字符串经普通 `extension_ui_response` 回答——完整复用取消/停止语义。CLI 里可输选项序号（`1` 或 `1,3`）兜底。

**生态现状（2026-09-21 核实）：** npm 上有一批社区 ask 插件（`@henryqw/pi-ask-question`、`@ssk_dev/rpiv-ask-user-question-lean`、`@pi-atelier/rpiv-ask-user`、`@mammothb/pi-ask` 等），全部基于标准 `ctx.ui.select/input` 实现——Desktop 现有通用对话框原生兼容，装上即用（单问、无独立描述、无真多选）。与内置 desktop-ask 可共存，用户倾向社区版时可从插件市场一键安装。

**How to apply:** 改 ask 相关交互时先看 `extensions/desktop-ask/index.mjs` 与 `ExtensionDialog` 的 `parseAskPayload`/`AskQuestionCard`；不要绕开 dialog 通道另造 IPC（会失去取消/停止语义）。

**富卡片已完成（2026-09-21）：** AskQuestionCard 支持「其他」自由输入项（OTHER=`__other__`，行内输入 300 字上限，提交时映射为答案文本）、header 徽章、✓ 选项卡、多选标注、停止任务/取消/提交 footer，未选完提交置灰；`parseAskPayload` 与 `AskQuestionCard` 均从 PiReplicaApp.tsx export 供测试用（tests/ask-card.test.ts）。typecheck + 257 测试 + build 全过，应用已重启生效。

**关键坑：execute 签名是 5 参（2026-09-22 修复）**：pi 工具签名是 `execute(toolCallId, params, signal, onUpdate, ctx)`（pi dist `core/tools/tool-definition-wrapper.js` 核实）。desktop-ask 之前写成 3 参 `execute(_id, args, ctx)`，ctx 拿到的是 AbortSignal → `Cannot read properties of undefined (reading 'input')`，工具一调即崩。已改为 5 参并用对位置；tests/desktop-ask.test.ts 同步 5 参调用（abort 用例传 signal 到第 3 位）。运行中的 pi 进程不热加载扩展，改完要断开重连/新会话才生效。RPC 模式下 ctx.ui 存在（rpc-mode.js `createExtensionUIContext` 含 select/confirm/input），工具 ctx.ui 由 runner.createContext() 的 getter 提供。
