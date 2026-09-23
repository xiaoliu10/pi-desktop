---
name: pi-desktop-thinking-summarized-rootcause
description: pi 请求思考时硬编码 display:"summarized"→CCR 返回摘要而非完整推理；desktop 改不了，须上游修
metadata:
  node_type: memory
  type: reference
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

desktop 里思考块只显示短摘要标题（如 `**Investigating SDK support**`）而非完整推理——**不是 desktop 显示 bug，是 pi 请求侧硬编码**。

**根因**（pi 0.86/0.87 dist 实证 + 走代理 clone `github.com/zai-org/ZCode` 对照）：
- pi 的内置 anthropic SDK（`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/anthropic-messages-MYU5ZMRF.js`，bedrock-converse-stream.js 同理）发请求时：
  `let display = options.thinkingDisplay ?? "summarized"; params.thinking = {type:"enabled", budget_tokens, display}`（adaptive 分支同理 `display: options?.thinkingDisplay ?? "summarized"`）。
- `display` 是 CCR（claude code router）扩展字段：`"summarized"`→返回思考摘要；`"expanded"`→完整推理。
- ZCode 源码（packages/services、apps/zcode-cli）里**完全没有** `thinkingDisplay`/`"summarized"` 字眼——ZCode 的 SDK 不发 `display`，CCR 收到无 display 就返回完整思考。同一模型因此 ZCode 全、pi 摘要。

**ZCode 对照源码位置**（`github.com/zai-org/ZCode`，走 [[pi-desktop-network-mirrors]] 的 7897 代理 clone；apps/zcode-cli/packages/adapters/src/model/anthropic-stream-compat.ts 只处理 thinking 签名兼容，全库无 display 字段）。

**desktop 改不了的依据**：`thinkingDisplay` 在 pi 全代码库只在两个 SDK 请求块被读、从不被赋值；不在 settings（只有 thinkingBudgets）、不在 model-config compat（有 forceAdaptiveThinking/supportsMidConvoEffort 但无 thinkingDisplay）、不在 RPC（只有 set_thinking_level）、无 env。硬编码默认 "summarized"，无配置入口。desktop 只拿 pi 存的数据。

**用户 2026-09-22 决定**：只报上游（让 pi 加 thinkingDisplay 配置项或改默认 "expanded"），**不动本地 pi 安装**。本地补丁方案（改 chunk 默认值）已否决——会因 pi update self 覆盖、且改 homebrew 安装文件。

**已提上游 issue**：earendil-works/pi#9905（英文，bug 模板，引用源码 `packages/ai/src/api/anthropic-messages.ts` L179/L1156/L1164 与 #3313 先例；按 CONTRIBUTING 规矩附了 AI 协助声明评论）。关键新证据：`AnthropicThinkingDisplay` 类型只有 `"summarized" | "omitted"`——AI 包层面就没有"完整"选项；不发字段（ZCode 行为）正是 CCR 场景拿完整思考的值。上游修复后：pi update self 升级 → desktop 'auto' 自动跟随 → 思考即完整。#3313 是最接近的旧 issue（同样诉求，被错关为无关 #3315 的 dup），可一起关注。

会话文件佐证：`~/.pi/agent/sessions/desktop/1790054748635_*.jsonl` 的 thinking 块全是 24-34 字符短标题（`**Checking delegate availability**` 等）；旧会话 `1789954236678_*` 多为 584-2934 字符完整推理夹杂个别短摘要。

相关：[[pi-desktop-pi-behavior-verification]]（pi 行为先读 dist 核查）、[[pi-desktop-network-mirrors]]（github 直连被墙走 7897 代理）。
