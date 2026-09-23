---
name: pi-desktop-pi-behavior-verification
description: 实现 pi 相关功能前先读真实 pi dist 源码确认 RPC 命令/事件语义，不要凭猜测
metadata:
  node_type: memory
  type: reference
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi CLI 是全局 npm 包，dist 可直接读：`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/`。`pi --version` 当前 0.86.x。关键模块：`modes/rpc/rpc-mode.js`（RPC 命令分发，如 set_model/get_session_stats 的 case）、`modes/rpc/rpc-types.d.ts`（命令名与返回类型声明）、`core/agent-session.js`（setModel/getSessionStats/getContextUsage 等实现）、`core/package-manager.js`（包安装/解析/auto-discovery 逻辑）、`cli/args.js`（子命令 help：install/remove/uninstall/update/list/config）。当前版本 0.87.x（desktop 经 [[pi-desktop-runtime-version-sync]] 'auto' 模式优先用本机 CLI）。`pi update [source|self|pi]` 是 pi 自带升级命令（update self 升自身、update pi 升模型目录、update <source> 升扩展）。

**已验证的真实行为（非凭空猜测）：**
- `set_model` 立即改写 `agent.state.model`，正在流式的那次调用不受影响、下一轮迭代自然用新模型；会顺带按新模型重置思考等级（所以 desktop 运行中切换要挂起，在 assistant message_end 边界统一下发）。
- `get_session_stats` 返回 `{userMessages,assistantMessages,toolCalls,tokens,cost,contextUsage}`，`contextUsage` 来自 `getContextUsage()`（需 model.contextWindow>0）。`get_state` **不**暴露工具列表。
- 队列管理 RPC 只有 `clear_queue`（无单条删除/编辑/提升）——队列编辑 = clear + 按原 behavior 重排剩余项；立即执行 = clear + steer 该条 + 重排。
- **RPC 模式扩展 UI 只有 `select/confirm/input/notify`**（纯字符串，select 单选、无描述无多选；`custom` 组件是 TUI-only）。富 UI（如 ZCode AskUserQuestion）的可行模式：桌面自带扩展注册工具（`pi.registerTool`），载荷编码进保留标题的 `ctx.ui.input`，渲染层识别标题渲染富卡片、按普通 extension_ui_response 回 JSON——复用取消/停止/超时全部现有机制。
- 扩展用 `-e <path>` 强制加载；`registerTool` 注册的工具可进 `--tools` 白名单；policy 的 `classify` 对非内置工具默认 ask（plan 直接 deny），新桌面工具要在 policy.mjs 显式放行。
- 包管理 `resolve()` 只加载 `settings.packages` 登记的来源；`addAutoDiscoveredResources` 扫 extensions/skills/prompts/themes 目录但**不**自动加载 npm 根里未登记的包。
- npm 包顶层口径：pi 的 npm 根 `package.json` 的 dependencies 才是顶层安装包（见 [[pi-desktop-plugin-marketplace]] 的传递依赖陷阱）。
- `ws` 包在 ESM 下默认导出**没有** `.Server`，要用命名导出 `WebSocketServer`；ws 客户端的 message 监听必须在 `await open` 之前挂上，否则握手同包数据帧会丢。

**Electron smoke 探针技巧：** 直接 shell 启动 Electron 时 console.log 不可见——探针结果写 `userData/` 下的文件再读；`executeJavaScript` 会 await promise（可直接调 window.localPi.*）；UI 点击选择器按按钮文本匹配比 CSS 类名稳。

**Why:** pi 没有给 desktop 的 RPC 文档；凭猜测实现的"运行中切换模型立即生效""clear_queue 会结束运行"等都和真实行为不符，导致 bug。读源码 5 分钟能省掉来回试错。

**How to apply:** 任何"pi 是否支持 X 命令/某事件何时触发/某字段叫什么"的问题，先 `grep` 上述 dist 路径确认，再写代码；写完用 `tests/fixtures/fake-pi.mjs` 加对应 case 镜像真实语义（如 set_thinking_level 改状态、message_end 作边界、clear_queue 只清队列不结束运行）。相关：[[pi-desktop-task-board-workflow]]
