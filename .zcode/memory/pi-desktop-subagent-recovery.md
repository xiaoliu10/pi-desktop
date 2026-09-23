---
name: pi-desktop-subagent-recovery
description: pi subagent 父进程重启后丢失进度的兼容方案——扩展持久化 onUpdate 到文件 + Desktop 恢复合并
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi 的 subagent 扩展（`examples/extensions/subagent/index.ts`）为每次调用 spawn 独立 `pi --mode json --no-session` 子进程。进度靠 stdout JSON 事件回传给父进程的 `onUpdate`，塞进工具 `details`。**父进程崩溃/重启后**：stdout 管道断（子进程收到 EPIPE 可能死或变孤儿），父会话文件里的 `details` 停在最后快照，子进程**没有 session 文件**（`--no-session`），Desktop `projectSubagents()` 从会话文件读到的只是空/半截快照。

**两层兼容方案（2026-09-23 已实现）**：

**第一层：中断态正确标记**——`subagents.ts` 的 `projectSubagents()` 改为：父会话已断开（`!parentRunning`）且工具未完成（`!terminal`）→ `interrupted`（原来停在 `unknown`/`running`，用户看不出"丢了"）。`ChildState` 新增 `'recovered'`，`SubagentPanel` labels 加「已从磁盘恢复」。

**第二层：onUpdate 持久化**——`desktop-official-subagent` 扩展升 v2（marker `// PI Desktop official-subagent adapter v2`）：
- 每次 `execute()` 前：从 `PI_DESKTOP_MODE_FILE` 提取 sessionKey，在 `~/.pi/agent/subagents/{sessionKey}_{callId}.json` 写初始状态 `{callId, startedAt, status:'running', details:undefined}`
- 包装 `onUpdate` 回调：每次进度更新时写 `{callId, status:'running', details: partial?.details}` 到文件
- 正常完成：写 `{status:'completed', details: result?.details}`，5s 后删文件（会话文件是 source of truth）
- 异常退出：文件残留 = Desktop 可恢复
- 主进程 `recoverSubagents(agentDir, sessionKey)`：读残留文件，completed 的删掉（已落盘），running 的返回
- adapter `onEvent 'closed'`：调 `recoverSubagents` 存入 `recoveredSubagents` state
- `projectSubagents()` 第三参数 `recovered?: RecoveredSubagent[]`：会话文件没有的 callId 追加为 `recovered` 状态子代理，展示最后快照的 messages/usage

**关键文件**：`src/main/pi/official-subagent.ts`（v2 生成器 + recoverSubagents + cleanupSubagents）、`src/renderer/pi/subagents.ts`（中断标记 + 恢复合并）、`src/renderer/pi/adapter.ts`（closed 时恢复 + state）、`~/.pi/agent/extensions/desktop-official-subagent/index.ts`（v2 扩展文件，手动写入磁盘）。

`enableOfficialSubagent()` 会自动从 v1 升级到 v2（检测 `startsWith(MARKER_V1)` → 覆盖写入）。`officialSubagentStatus()` 返回 `{installed, outdated}`，v1 = outdated=true。

**未做（第三层孤儿进程感知）**：扫描 `pi --mode json` 孤儿进程并提示用户。如果 v2 持久化 + 恢复不够用再考虑。

相关：[[pi-desktop-pi-behavior-verification]]（pi 行为先读 dist 核查）、[[pi-desktop-settings-and-shell]]。
