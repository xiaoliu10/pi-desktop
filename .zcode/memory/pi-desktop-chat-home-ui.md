---
name: pi-desktop-chat-home-ui
description: 聊天导航条（一轮问答一刻度+悬浮结论摘要）与新建任务页固定 agent 预设（AgentPreset 可绑定 pi skill）的实现要点
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi-desktop 聊天区/主页 UI 两个机制（2026-09-22 实现）：

- **消息导航条（MessageNav/railEntries，ChatView.tsx）**：一个刻度 = 一轮完整问答（用户提问 + 其触发的整段执行合并；`executionTurns` 会把连续助手消息并入上一回合，只有会话开头的助手内容才是独立刻度）。悬浮提示两行：上行=用户提问（firstText），下行=**该轮结论（lastText，最后一段文本）**而非开场白——用户报过"悬浮全是固定文案"，根因就是取第一条文本 + 会话里大量重复「继续」；重复提问靠各自的实际结论区分。无文本结论回退「N 步工具调用」。测试 tests/rail-entries.test.ts 含"重复提问摘要必须不同"。
- **新建任务页固定 agent 预设**：`shared/settings.ts` 的 `AgentPreset { id, label, icon, skill?, prompt }` + `DEFAULT_AGENT_PRESETS`（周报总结/报错修复/PPT 制作/闲时任务），存 desktopPreferences.agentPresets（saveDesktopSettings 通道已通，尚无编辑 UI）。点击预填 prompt；带 `skill` 时自动加「使用 <skill> 技能。」前缀——`~/.pi/agent/skills` 放技能后把预设 skill 指过去即"默认调用固定 skill"。HomeView 底部胶囊行 `pi-home__presets`，问候语按时段动态（早上好/晚上好）。

**Why:** 用户对照 ZCode 要"大块总结"导航和固定 agent 快捷入口；悬浮摘要取错文本位置（开场白 vs 结论）曾让他以为功能坏了。

**How to apply:** 改导航条摘要逻辑先跑 rail-entries 测试；加预设编辑 UI 只差纯 UI 工作（数据通道已通）；执行组计时与 working 行计时互斥（steps 出现即交接），别加回双计时。队列编辑的召回输入框实现见 [[pi-desktop-settings-and-shell]]（parseContextPrompt 往返）。相关：[[pi-desktop-settings-and-shell]]、[[pi-desktop-zcode-ui-parity]]
