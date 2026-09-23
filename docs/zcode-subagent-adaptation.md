# 子代理目录、详情与生命周期：ZCode → pi Desktop

## 源码研究

ZCode 参考版本 `872ad960de7ec172591f7e1952f7849229f94521`：

- `packages/ui/src/hooks/useSessionSubagents.ts`：按父会话查询运行中和结束的子任务，revision 刷新、分页、过期请求隔离。
- `packages/ui/src/app-shell/SubagentDirectorySidePane.tsx`：任务目录、状态图标、选择子会话。
- `packages/ui/src/app-shell/SubagentSessionSidePane.tsx`：右侧复用只读 SessionPane，不抢占主任务。
- `packages/services/src/zcode-agent/repairSubagentTaskIndex.ts`：child 身份关联，避免子会话混入主任务目录。

ZCode 有内核级 childSessionId。pi 的子代理由扩展实现，不能仅凭工具名把任意插件当成相同协议。

## 首个适配对象

选用内置 `@earendil-works/pi-coding-agent@0.86.0/examples/extensions/subagent`（官方示例）。它支持 single、parallel、chain；`details` 包含 agentScope、projectAgentsDir、results；子结果包含 task、messages、usage、exitCode、stopReason、step。

也阅读了 nicobailon/pi-subagents 0.70.1：它有 runId/index、持久后台任务、控制通道、独立会话文件及 bg_wait 完成记录，属于另一协议，未混入本次适配。

## 数据流

pi RPC tool_execution_update/end → 保留结构化 details → ToolPart.resultDetails → 官方协议适配器 → 父会话子任务目录 → 右侧只读转录。

历史 toolResult.details 走同一投影。身份为父会话范围内 toolCallId + child index，重复 agent 名称不会覆盖。持久结果优先于迟到的进度事件。

官方示例以 --no-session 启动子进程，无法提供可独立恢复的 childSessionId。因此只读详情使用父会话保存的子消息。中途退出且未落盘的进度无法在重启后恢复；不编造完成状态。

生命周期：等待执行、执行中/等待汇总、完成、失败、中断、状态未确认、未执行。官方示例运行中 exitCode 初始为 0，不能据此宣告完成。结束结果确定最终状态；串行链已进入下一步时，前一步可确定已完成。父任务已停止但没有终态记录时显示状态未确认。第一版无独立子进程停止按钮；停止操作明确为停止父任务及其子代理。

UI 目录支持筛选和分批显示，详情展示任务、模型、用量、消息、思考和工具输入/输出。切换父会话关闭面板。新适配器应返回统一 SubagentChild，而不是修改 UI 去猜测别的插件格式。

## 使用

设置 → 子代理 → 启用官方子代理插件。安装入口从内置 SDK 导入官方实现，添加不覆盖既有定义的 desktop-scout，只需启用一次。新建会话后请求“使用 subagent 调用 desktop-scout 检查项目”。此动作未在开发过程中替用户启用，避免同名插件冲突。

现有 npm 配置或扩展目录里发现 subagent 插件时拒绝重复安装。当前启用入口依赖内置 SDK 0.86，安装后的包装文件引用本机内置资源路径；移动应用后重新启用可刷新路径。

官方子进程不具备 Desktop 审批通道，因此包装器在 Desktop 中只允许 fullAccess，不自动提升权限。运行中从 fullAccess 切换到其他模式时向官方插件传播取消信号。CLI 没有 Desktop 权限环境变量时遵循官方插件原有行为。

## 验证

纯投影测试覆盖并行同名代理、运行中 exitCode=0、混合终态、跳过链步骤、迟到事件和不匹配插件协议。

真实集成测试在临时目录启用官方插件，使用内置 pi 和本机 SSE 模型服务实际启动子进程、完成任务，并从父会话 JSONL 恢复子代理转录；无外部模型费用、不读取用户凭证。
