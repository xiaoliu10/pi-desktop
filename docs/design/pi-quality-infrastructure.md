# pi 质量基础设施建设方案（调研综合）

> 状态：**待用户拍板**。三路调研完成：CC 基线（cc-latest）、pi 内核扩展面（pi-ext-points）、业界先例（industry-quality，Cursor 部分；codex 部分超时未完成，不影响结论）。
> 素材：`docs/design/research/a-claude-code-v21301-delta.md`（199 行）、pi-ext-points researcher 产出（147 行，subagent-artifacts）、industry-quality output-0.log（Cursor hooks 一手材料）。

## 1. 背景与调研结论

用户体感「pi 质量不如 CC」。三路调研交叉验证后的核心事实：

1. **CC 侧**：最新 2.1.301（2026-10-15）相对 v2.1.300 **质量机制零增量**（字节级 diff：608 条 prompt 块全同，差异全是 minifier 改名）——v2.1.300 机制清单仍是最新基线，**别等 CC，精力放自身缺口**。
2. **pi 侧**：1.3.0 内核扩展面**完全够用**——`tool_call` 可拦可改可 block 且 fail-closed（handler 抛错=阻断）、`tool_result` 可改写结果并真实落库、`turn_end/agent_before_settle` 的 `continue:true` 是 CC Stop hook 强制返工的等价物且更强（可追加 custom_message / context_edit）。
3. **业界侧**：Cursor 19 事件 hooks（cloud 有裁剪）；社区 karanb192/claude-code-hooks（558★/1949 tests）四个高价值 hook——`format-code`、`protect-tests`（只拦删除/禁用测试，不拦写新测试）、`dead-rules-audit`（**CLAUDE.md 合规记分板：违反率>50% 且 ≥3 次的建议固化成 hook**）、`instructions-audit`（投毒检测）。
4. **反面证据（最值钱）**：CC #102649 hook 静默失效 23 分钟无感知（sandbox 清理误删 hooks）→ **门禁必须带存活心跳**；#102653 mod hook 被静默旁路；#102719 等「无视 claude.md 交付未测试代码」→ **纯软规则会被无视，必须软硬双轨**。
5. **pi 内核做不到的**（别指望上游）：provider 层 fail-closed（#9623/9624 拒绝采纳，1.3.0 仍 fail-open）、handler 优先级（#10363）、handler 超时/取消（#9910/10928 未修）→ **门禁自身必须 fail-fast + 自带超时 + 防御 stale ctx**。

## 2. 已有设施盘点（不重建，做升级）

| 设施 | 现状 | 升级方向 |
|---|---|---|
| quality-prompt | 全局扩展注入质量规则（软轨） | 改用官方 `prompt-customizer` 正解（改 `systemPromptOptions` 而非整体替换 `systemPrompt`——整体替换会打爆前缀缓存，issue #10024 实证重新计费） |
| verify-gate | 提交前闸门 | 升级为 **settle 前验证不过 → `continue:true` 自动续跑一轮修复**（P0-1） |
| repo-context | 按需注入仓库上下文 | 可下沉 `context` 事件每请求注入 |
| plan-mode | 计划审批 | 不动 |

## 3. 落地形态：pi 社区插件（npm pi-package），非 desktop 内置

**载体**：独立 npm 插件包（`keywords: ["pi-package"]` → pi 官方 gallery；desktop 插件市场已支持搜装）。pi 社区直接受益，desktop 用户从市场一键装；desktop 仓库不内置质量扩展。

**包规划**（新建 `/Users/jason/projects/opensource/pi-quality-gates`，与 pi-quality-prompt 同门）：

- **pi-quality-gates**（P0-1 + P0-2，共享 lint/tsc 执行器与预算契约）：
  - `settle-gate`：settle 前验证不过 → `continue:true` + custom_message 返工；连续 2 轮不过放行+显式报告
  - `lint-inject`：edit 后 tool_result 注入诊断（pi-lens 预算契约：读类 500ms、edit 类 10s 封顶）
- **rules-promotion**（P1-1，后续独立包）：软规则违反记分板 → 建议固化硬门禁
- **permission-tier**（P1-2，后续独立包）：annotations 分级确认
- **既有三扩展收编**：quality-prompt（已有独立项目，发布 npm）、verify-gate/repo-context 迁入插件化（全局扩展退役）

### ve（pi-virtual-employee）适配

**ve 不能直接装插件**：ve 的 engine 直接包装 pi-agent-core 的 `Agent`（src/engine/engine.ts），绕过 pi-coding-agent 扩展系统（无 tool_call/tool_result/turn_end 事件链，仅有 CustomAgentMessages 扩展点）。

**复用方式**：gate 决策与执行器抽成宿主无关的 core 模块（纯函数），pi 插件壳与 ve engine 都调它。ve 接入是独立 PR（在其 Agent 工具包装层调 core 实现 lint-inject、turn 循环外实现 settle-gate）。

### 包结构

### P0-1 settle 验证闸 + 自动返工（最大缺口，pi 内核已全支持）
- **做法**：verify-gate 扩展 `agent_before_settle` 返回 `{continue:true}` + `custom_message`（告知哪条验证失败）；验证命令自带 timeout（⚠️ #10928 settle 边界拿不到取消信号）。
- **验收**：模型声称完成但 `tsc`/测试红时，自动续跑修复而非假完成；连续 2 轮不过则放行并显式报告（防死循环）。

### P0-2 tool_result lint-after-edit（抄 pi-lens 满血先例）
- **做法**：edit/write 后 `tool_result` 事件跑 lint/tsc 诊断，把问题**注入工具结果**（模型立刻看到，不用等 settle）；预算契约照抄 pi-lens：读类工具 500ms 绝不等、edit 类 10s 封顶、被 block 的调用没有 tool_result 需退役计数。
- **验收**：引入语法错误的那次 edit，模型下一轮就收到诊断，而不是提交时才失败。

### P1-1 dead-rules-audit 式软规则→硬门禁晋升通道
- **做法**：审计扩展统计 AGENTS.md 各规则被违反次数（读 transcript/审计 entry）；违反率>50% 且 ≥3 次 → 建议用户把它固化成 P0-2/P0-1 的硬门禁（报审计 entry，不自动改）。
- **验收**：同一规则反复违反时出现「建议固化为 hook」的审计记录。

### P1-2 annotations 驱动分级确认（官方文档示例直接可抄）
- **做法**：permission 扩展按 `readOnlyHint/destructiveHint` 分级：只读放行、破坏性弹确认（RPC dialog 带 timeout 不会卡死）。
- **验收**：`rm -rf` 类确认弹窗、读类零打扰。

### P2（观察项，暂不做）
- **hook 存活心跳**（#102649 教训）：门禁扩展自检（session_start 注册 + agent_end 校验 handler 仍挂载）。
- `instructions-audit` 投毒检测、`user_bash` 接管（桌面端 `!` 命令目前不受 tool_call 闸门管）。
- `registerTool` 同名覆盖换带 lint 的 edit/write（tool_result 通道已够，先不做重注册）。

## 4. 实施边界（防「能跑就好」兜底）

- 所有门禁 **fail-closed 但 fail-fast**：handler 内部异常 → 阻断该次工具 + 审计 entry（继承 pi 内核语义），但自身不带长阻塞逻辑。
- 每个新扩展带**破坏-恢复验证**的测试（真起子进程断言 block/continue 行为，不做源码文本 grep）。
- 动态 `setActiveTools` 慎用（#10024 重新计费）；质量规则优先 promptGuidelines / systemPromptOptions 增量通道。

## 5. 需求映射（docs/requirements.md 增补候选）

- `R-quality-01`（settle 验证闸 + 返工）：P0-1。
- `R-quality-02`（edit 即时 lint 注入）：P0-2。
- `R-quality-03`（软规则→硬门禁晋升审计）：P1-1。
- `R-quality-04`（分级确认）：P1-2。
