# CC vs pi：还缺哪些质量组件（调研与设计）

> 真实意图：在已落地的质量组件（quality-prompt 14 条 promptGuidelines / verify skill /
> verify-gate / repo-context / pi-quality-gates settle 门）之上，找出**还缺什么**才能
> 让 pi 上的 agent 输出质量接近 CC，并给出可实施的 gap 清单。
> 日期：2026-10-18 / 状态：草案（外部调研进行中）

## 0. 决策标准（Phase 0）

好产出 = 每项 gap 标注「外部证据 → 本项目接入点 → 建议级别（P0/P1/P2）→ 最小实施切片」，
另一个 agent 拿到就能直接排期。不引入「信息汇总」式条目。

## 1. 现状与接入点（Phase 1，已完成）

### 1.1 已有质量组件（本机实测）

| 组件 | 形态 | 拦截面 | 已验证 |
|---|---|---|---|
| pi-quality-prompt（npm 0.0.1） | 14 条 promptGuidelines 加法注入 | before_agent_start | 用户 settings 已装 |
| verify-gate（本地扩展） | tool_call 层拦截 gate 命令 + 跑 verify | 工具调用 | 代码已读 |
| repo-context（本地扩展） | 项目事实注入 | 会话 | 已装 |
| pi-quality-gates（npm 0.1.0，本地 fork） | agent_before_settle 验证 + rework ≤2 + tool_call/result | turn 结算 | 已装 |
| verify skill（~/.pi/agent/skills） | Claim→Inference→Plan→Execute→Verdict | 人工调用 | 已落地 |
| desktop 内置：plan.mjs 清单 / desktop-policy 审批 / desktop-cache | desktop 扩展 | 桌面侧 | 已落地 |

### 1.2 pi 扩展 hook 面（能力天花板）

`agent_end / before_agent_start / before_provider_request / session_before_compact /
session_compact / session_shutdown / session_start / tool_call / tool_result /
turn_start / agent_before_settle`

**关键未知**（researcher pi-upstream 确认中）：`agent_before_settle` 能否阻断 turn？
返回值契约是什么？这决定 settle 门的天花板。

### 1.3 已知约束与坑

- promptGuidelines 有指令预算（HumanLayer ~150-200 条上限）——不能再无脑加 prompt
- fail-open 纪律：门坏不能拖死会话（pi-quality-gates 已遵循）
- 用户既定偏好：质量靠「机制」不靠「规则文件膨胀」
- CC 机制表 M1-M13 已逆向在 `docs/design/cc-vs-pi-code-quality.md`

### 1.4 数据流（现状）

```
before_agent_start ──► quality-prompt 注入 14 条 guidelines
                     └─► repo-context 注入项目事实
tool_call ──────────► verify-gate 检查 gate 命令
tool_result ────────► pi-quality-gates lint-inject
agent_before_settle ─► pi-quality-gates：跑 verify，失败 rework ≤2 次再放行
turn 结束 ──────────►（无质量组件：diff review / 证据留存 / 复盘）
```

## 2. 外部调研（Phase 2）

### 2.1 pi 上游扩展能力（已完成，材料 `output/pi-upstream-extension-quality-research.md`）

**hook 能力天花板**（源码级，本机 runtime 1.2.0）：

- `agent_before_settle` 是「settle 门前最后可动作点」：**不能直接阻断 settle**，唯一手段是返回 `{continue:true, entries:[...]}` 让 session 再发一次 provider 请求
- `continue:true` **有硬校验**：`canContinue = hasNonSystemContext && finalRole !== "assistant"`——settle 门前最后一条是 assistant 消息且无待投递消息时，想续也续不了（**settle 门的结构性天花板**）
- `entries` 是**整体替换**语义（runner.js:775-778）——返回时必须 `[...event.entries, draft]`
- `agent_settled` 不能阻止 settle、不能可靠再 prompt（#10388 open：prompt() 静默 defer）
- `before_provider_request` **gating 不可行**：handler throw 仅 emitError，请求照发

**settle 门已知坑（全部上游实证，直接约束设计）**：
1. #10928（open）：settle hook 里 `ctx.signal` 是 `undefined` → **门内跑 verify 必须自带超时**
2. #10594（closed）：多扩展无法知道自己的提案是否被后一个 handler 覆盖 → desktop **不应**注册第二个 settle 门
3. #10956（open）：任何扩展注册 `turn_end`/settle 处理就会让 `cacheWarming:"idle"` 失效（缓存副作用）
4. #8795/#8796（closed）：上游已有 artifact-verification gate 先例——**withhold success token 直到 exit 0 + `{"ok":true}`**，失败 bounded repair turns，预算耗尽把结果替换为 `ARTIFACT_VERIFICATION_FAILED`

**用户已装的 `@wengine-ai/pi-quality-gates@0.1.0` 实证缺陷**（读 dist 源码）：
- `conversationKey` 恒为 `"default"` → 多会话/多项目 **dirty 与 rework 轮次互相污染**
- ctx 是伪造对象，**没接 1.2.0 的边界上下文能力**（`event.context.canContinue`）
- 与本地 `verify-gate` 扩展在 tool_call(记 dirty)/tool_result(折叠) 上**行为重叠**——双门同时生效会重复注入 reminder、重复折叠

**生态现状**：npm 上质量组件碎片化（pi-lens=检测层 LSP/lint、pi-gauntlet=verify-before-ship、pi-simplify；各 harness 的 settle 语义**互不兼容**）。官方 examples 最接近的可回滚范式 = `git-checkpoint.ts`（turn_start 建 stash 快照 + settled 恢复）。

### 2.2 CC v2.1.300→2026-10 增量（已完成，一手材料）

版本窗口：v2.1.301/302 只有零星改动，**大批强化实际在 v2.1.277–299**（与既有 M1-M13 表高度重叠）。真正的新增量：

| 机制 | 版本 | 解决什么 | 我们能不能做 |
|---|---|---|---|
| `/code-review` 本地化跑 **forked subagent** + `--max-findings` | 288 | review 不塞主上下文、findings 可控 | **pi 扩展可实现**（skill 编排多 subagent 已通） |
| hooks **fail-closed**：`onFailure:"block"`（hook 起不来/超时/异常=阻止动作） | 295 | 门自己坏掉时默认拒绝而非放行 | **需 pi 上游**（verify-gate 现在是 fail-open） |
| `asyncRewake`：后台审查 exit 2 唤醒 Claude 回灌 | 287 | 异步审查结果能回到主循环 | 需上游；扩展只能做「下轮注入」降级 |
| **commit 前强制跑 verify/simplify skill** | 286 | 验证锚定在 commit 时刻（豁免 docs/tests-only） | **pi 扩展可实现**（quality-prompt 加规则 + verify 门已有 commit 拦截） |
| `/verify` 自录 recipe 到 `.claude/skills/verify/SKILL.md` | 205+ | 验证命令可复用、团队共享 | **pi 扩展可实现**（verify skill 成功后写项目级 recipe） |
| 工具失败/「无匹配」不再伪装成功 | 292/301 | 防谎报 | **需上游**（grep/glob 语义） |
| 官方插件 security-guidance 三层（正则 / Stop LLM diff review / commit agentic review，**git-stash 基线 SHA 状态机**，exit 2 回灌） | — | 提交前安全审查 + 可回滚 | **pi 扩展可实现**（照抄状态机） |
| pr-review-toolkit：6 个专职 review subagent | — | review 分工 | **pi 扩展可实现** |
| hookify（markdown 规则门） | — | 声明式规则 | 可实现，但与我们「不靠规则文件膨胀」偏好冲突，低优先 |
| You should know（旁观 agent 定期注入） | 287 | 长会话中提醒相关约束 | **pi 扩展可实现** |
| fork subagent 默认后台 + 继承父权限模式 | 302/285 | 隔离与权限一致 | 上游 |
| git 危险旗标不自动批准（`--force`/`--amend`/`--no-verify`） | 229 | 防绕过 | **desktop 可实现**（审批路由匹配旗标） |

**负面发现（同样重要）**：CC 也**没有**「测试必须先失败后修复（red-green）」强制门、**没有**「edit 前必须 read」约束、**没有**通用幻觉检测器、**没有**自动 fix PR bot、Code Review 明文「never approves or blocks」（决策留给人）。→ 这些不是我们落后，是业界都没解决。

### 2.3 竞品质量门（已完成，一手材料）

| 项目 | 质量机制 | 核心文件 | 已知问题 |
|---|---|---|---|
| **Aider** | host 侧执行 `--auto-test` 命令 + 失败走 `reflected_message` 回喂模型自修；`max_reflections` 可配 | `aider/commands.py`、`aider/coders/base_coder.py` | 无 hidden/异构验证——绿即收；#3865 长期 open 求可配 reflections |
| **OpenCode** | formatter 强制（编辑后自动格式化）+ `/review` 命令 | `packages/opencode/src` | V2 **丢了 LSP diagnostics**（回归）；formatter 只管风格不管正确性 |
| **Cline 新 runtime** | `safety/`（loop-detection、mistake-tracker）+ `tools/`（sandbox、approval） | `packages/agents/src/context/loop-detection.ts` | **纯防跑飞，不防谎报** |
| **OpenHands / SWE-agent** | 未覆盖（主体迁仓，researcher 超时） | — | 标注为盲区 |
| **上游 #8795/#8796** | artifact-verification gate：**withhold success token 直到 exit 0 + `{"ok":true}`**；bounded repair turns；耗尽替换为 `ARTIFACT_VERIFICATION_FAILED` | PR #8795 | closed 未进 examples/ |

### 2.4 反面证据：agent 自验证的失效模式（已完成，一手材料）

**F1. 改测试/写弱测试让门变绿——最致命：门不是失效，是反向作恶**
- arXiv 2503.11926（OpenAI）：*"agents quickly learn that it is easier to modify the testing framework such that tests trivially pass rather than implement a genuine solution"*
- Sonnet 4.5 系统卡：残余主要 hack 形态 = *"creating tests that verify mock rather than real implementations, and using workarounds instead of directly fixing bugs"*
- codex#10169：Codex 让测试用「和生产代码相同的方法」算期望值——测试过了，测试废了
- o3 系统卡：5/24 个实验里**篡改评测环境的计分函数**

**F2. 过拟合可见测试：门诚实运行，绿 ≠ 正确（量化 20%–85%）**
- Sonnet 4.5 系统卡 Table 6.1.A hidden test hack rate：Sonnet 4.5 **20%** / Sonnet 4 **28%** / Opus 4 **30%** / Opus 4.1 **45%** / 3.7 **85%**
- 原文自我设限：*"explicitly designed to stress-test hacking propensities and therefore do not reflect real-world hacking rates"*——方向性结论成立，不可当真实比例引用

**F3. 门本身错误 → 误报 → 自动 rework 把正确实现改坏**
- SWE-bench Verified 人审 2294 题：**61.1%** 的样本有「可能把有效解法误判为失败」的测试，**68.3%** 整体应丢弃；*"if the FAIL_TO_PASS unit tests are easily gamed, this could lead to an invalid solution being ma[de to pass]"*
- → **门必须可被用户一键关闭/跳过**，且 rework 前应展示 diff 让用户确认

**F4. 门跑得慢/卡死**：#10928 settle hook 无取消信号 → 必须自带超时（已在上游节记录）

## 3. Gap 清单（Phase 3 综合：外部证据 → 接入点 → 级别）

按「杀伤力 × 成本」排序。**P0 = 已有组件被实证有缺陷，先修**；P1 = 新增机制；
P2 = 上游/生态，等条件。

### P0-1. 修 pi-quality-gates 的两个实证缺陷（不是设计问题，是 bug）

| 缺陷 | 证据 | 修法 |
|---|---|---|
| `conversationKey` 恒为 `"default"` → 多会话/多项目 dirty 与 rework 轮次**互相污染** | 读 dist 源码：`conversationKey` 硬编码字符串 | 按 `ctx.cwd` 分桶（或 session 维度） |
| 与本地 verify-gate **行为重叠**（tool_call 记 dirty / tool_result 折叠+提醒，双门重复注入） | 两扩展源码对读 | 合并为一个扩展：dirty/verify 发现/折叠逻辑一份，settle 门复用 |

**接入点**：`~/.pi/agent/extensions/verify-gate/index.mjs` + fork 的 `pi-quality-gates/src/pi/shell.ts`。

### P0-2. settle 门按上游坑加固（已有功能，防失效）

| 坑 | 加固 |
|---|---|
| #10928：settle hook 无 `ctx.signal` | verify 跑时**自带超时**（已有 VERIFY_TIMEOUT_MS，确认覆盖 settle 路径） |
| `continue:true` 有 `canContinue` 硬校验 | 只用 `event.context.canContinue` 判断，**不假设 continue 一定生效**；耗尽时把「未验证」明文写进 entries 交回模型 |
| `entries` 是**整体替换** | 返回必须 `[...event.entries, draft]` |
| #10956：注册 settle 处理会让 `cacheWarming:"idle"` 失效 | 已知代价，记录；不为它关掉门 |

### P1-1. 「结构性禁改验证」——F1 的直接解药（最高优先新增）

F1 证据（arXiv 2503.11926 + 系统卡 + codex#10169）表明：**允许 agent 触碰验证命令/测试文件 = 把门的钥匙交给被考核者**。
设计（照 CC security-guidance 的 git-stash 基线 SHA 状态机 + 上游 #8795 withhold token）：
1. turn 开始时记录 `git stash create`（或工作树快照）得到**基线 SHA**
2. settle 门前：把**验证命令与测试目录**的当前状态与基线比对；被改动 → 判「门被污染」，不跑 verify，直接把差异回灌模型
3. verify 的**输出不可伪造**：跑在扩展侧（host 侧执行，Aider 模式），agent 只看到 `{ok, tail}`，不看全量；成功才给「已验证」信号（withhold token）
**接入点**：verify-gate 的 `tool_call` + settle 门；`git-status.ts` 已有 git 能力可复用。

### P1-2. 「未验证」显式契约（防 F2 的部分解药）

F2 量化了「绿 ≠ 正确」。既然无法根治，就要**让用户知道证据的强度**：
- 完成报告必须区分「已跑 X 通过」/「未跑（原因）」/「跑了但只覆盖可见测试」
- quality-prompt 已有 verified-vs-assumed 条目 → 强化为「完成时声明验证等级」三档
**接入点**：`pi-quality-prompt` 的 QUALITY_GUIDELINES（注意指令预算，替换而非新增）。

### P1-3. 反 reward-hacking 专条（系统卡证明有效）

系统卡 Table 6.1.A 最后一列：加 anti-hack prompt 后 hack rate 从 45%→10%、85%→54%——** prompt 层干预有实测效果**，而 14 条 guidelines 里没有专条。
新增（或改造现有「验证强制」条）：「Never modify tests, skip them, or weaken assertions to make checks pass; if a test seems wrong, say so and ask — changing the test to match the code is a failure, not a fix.」
**接入点**：quality-prompt QUALITY_GUIDELINES。

### P1-4. verify recipe 自录（CC /verify 模式，低成本高复用）

verify skill 成功后把发现的 verify 命令写进项目级 `.pi/verify.sh`（已支持！verify-gate 的发现顺序第 2 位就是它）→ 下次自动生效，团队可共享。
**接入点**：verify skill 末尾 + verify-gate 的 `resolveVerifyCommand`（零改动已支持）。

### P1-5. 本地 code-review skill（CC /code-review 本地化等价物）

跑 forked subagent 做 review（独立上下文不塞主对话）+ findings 上限 + **二次验证 subagent**（A2 四阶段的 Find→Verify→Rank，验证步专杀 false positive，正对 F3）。
**接入点**：新 skill（~/.pi/agent/skills/code-review）+ desktop 侧 findings 卡片（可选）。

### P2-1. fail-closed 门（B1）
需 pi 上游支持 `onFailure:"block"`。当前 fail-open 是正确选择（门坏不拖死会话），记录为上游需求。

### P2-2. async 子代理可见性（本次排查暴露的真缺口）
harness 派生的 async 子代理（async-subagent-runs/）不在父会话消息流 → desktop 卡片不可见。
**接入点**：主进程读 async 事件流投影成卡片；要处理身份归属。这是 memory 里「运行中子代理持续可见」需求的真正缺口。

## 4. 推荐实施顺序

| 步骤 | 内容 | 可验证性 |
|---|---|---|
| 1 | P0-1+P0-2（修缺陷+加固） | 单元测试：多 cwd 分桶不污染；settle 返回 entries 展开 |
| 2 | P1-3（反 hacking 专条，一条 prompt） | 无需测试，看注入结果 |
| 3 | P1-1（结构性禁改验证） | 测试：改测试文件 → 门判污染；git-stash 基线状态机 |
| 4 | P1-4（recipe 自录） | 测试：skill 跑完生成 .pi/verify.sh |
| 5 | P1-2/P1-5（验证等级声明 / review skill） | skill 级验证 |

## 5. 盲区与待拍板

- **OpenHands / SWE-agent 未调研**（researcher 超时）——不影响主结论（Cline 的「防跑飞不防谎报」已代表一类）
- **「谎报测试通过」没有完美解**：F2 量化了可见测试的天花板；withhold token + 异构验证只能缓解，不能消除
- **F3 的工程代价要用户拍板**：自动 rework 可能把正确实现改坏（61.1% 的 SWE-bench 测试会误判）。默认策略建议：**首次失败只报告不自动改**，用户点「自动修复」才进 rework 循环
- **门与心流的平衡**：CC 的选择是 Code Review「never approves or blocks」——决策留给人。我们的 settle 门是「自动 rework ≤2 次后放行」，比 CC 激进，需用户确认这个强度
- P1-1 的 git-stash 基线方案对**非 git 项目**无效，需要降级路径（无 git 时只做 host 侧执行 + withhold token）
