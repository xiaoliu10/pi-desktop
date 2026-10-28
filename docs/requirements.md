# PI Desktop 需求清单

**目的**：把"我们要什么"和"现状如何"固定下来。插件升级、pi/CCR/pi-subagents 版本改动、重构，都要回到这份清单逐项核对——能跑通不等于满足需求。每条需求写明验收标准与回归方式，不写空话。

**与各专项文档的关系**：本文是需求总表（What + Why + 验收）。实现细节（How）在各 `docs/*.md` 与代码注释里，需求条目里给出链接即可。

## 字段说明

- **ID**：`R-<域>-<序号>`，域分 `subagent`/`model`/`plan`/`render`/`session`/`io`/`deploy`/`automation`。
- **状态**：`满足` / `部分满足` / `不满足` / `待上游` / `风险`。
- **上游依赖**：若需求满足与否依赖第三方（pi 内核、pi-subagents、CCR、Electron），写明版本与 issue 链接。
- **回归触发**：什么时候要重新验证这条（升级/改某文件/发版前）。

---

## 子代理域（subagent）

### R-subagent-01　运行中子代理在主对话可见

**需求**：后台子代理运行时，用户在主对话界面能持续看到它在工作。形态对齐 ZCode：**对话流内的子代理工具卡片用机器人（bot）图标标识**（`chat.toolCall` 卡片 + bot 标识），不用额外横幅（用户 2026-10-16 指定，替代 0.1.24 的常驻横幅形态）。

**验收**：
- 主对话流里 subagent 工具调用渲染为带 bot 图标的工具卡片，运行中显示进行时状态。
- 不再渲染输入框上方的常驻横幅（`RunningSubagentBar` 已移除）。
- 面板与状态统计只计 running/queued，不含 completed/failed。
- **切换会话不拦截**（用户 2026-10-16 明确）：切换不杀进程、切回即见，可见性由对话内卡片负责。
- 全部子代理进入终态后，卡片状态随之收敛。
- **侧栏会话行的运行中标识覆盖子代理**（用户 2026-10-17 补充）：主 run 已结束但该会话仍有运行中子代理时，侧栏菊花不停——否则用户会误以为任务已结束。数据源为主进程异步运行目录 `async-subagent-runs/<runId>/status.json`（按 sessionId 归属，running/queued 计入，终态与 stale 排除）；旧 `agentDir/subagents/<sessionKey>_<callId>.json` 只补充无 async 记录的调用，不能覆盖 async 终态。主 run 空闲、切到别的会话后仍需持续更新。**运行状态是会话级属性，不聚合到项目行**（用户 2026-10-19 明确）：折叠项目时项目行保持文件夹图标，不显示任何菊花/进度指示——折叠项目 ≠ 项目在跑。

**状态**：部分满足（v0.1.24 #124 首版；v0.1.25+ 去弹窗、去横幅、换 bot 图标。异步子代理侧栏漏报已于 v0.1.30 修复（#141：有界异步 status 扫描 + dispose/reconnect 代际）；v0.1.30 曾把运行标识错误地聚合到项目行，已按用户反馈回退为会话级，待 PR 合并后验收）。

**回归触发**：改 `ChatView.tsx`（toolRowIcon/ToolCard 的 bot 图标与卡片渲染）、`adapter.ts`（selectSession/disconnectRun/liveSubagentCount/buildPiSidebar 的 busy 口径）、`subagents.ts`、主进程 `persistSubagentEvent`/`async-subagent-activity.ts` 快照扫描、backend 定时刷新生命周期；pi-subagents 升级（status 形态可能变）。

### R-subagent-02　子代理详情可读：运行中与完成态都看得到转录尾部

**需求**：点开任一子代理，能看到它的任务/状态/agent，并能在完成态读取子会话转录尾部（用户核对子代理做了什么）。运行中态至少显示状态，不永久转圈。

**验收**：
- single 与 workflow 两种模式、running/queued/completed/failed/interrupted 各状态，卡片都出现且状态正确刷新。
- 完成态点详情能读转录尾部；路径与身份校验通过才读，不读则明确提示，不假报"不可用"而实为解析失败。
- 第三形态（completions 结果）同样识别并读子会话，不因形态切换而卡片永久转圈。
- **计时真实**：详情面板的「已工作 / 用时」只用真实时间。子代理转录消息经脱敏后本身不带时间戳，但主进程从 status.json 快照读出的真实 `startedAt`（及终态 `updatedAt`）会经 recoverSubagents 轮询到达：运行中用它显示「已工作」，已结束用它显示「用时」。拿不到合法快照时间就不计时，**绝不把内部缓存版本号/当前时间/轮询时刻/工具调用时刻当起始或结束时间**（曾出现「已工作 497889 小时」；修那个 bug 时一度把时间戳整个留空导致计时条消失）。live 路径状态以会话文件 adapter 为准，磁盘仍 running 时其 lastUpdate 不是结束时刻、不得当 endedAt；**只有已验证 child 终态的真实 lastUpdate 才能当结束时刻**。PR #149 独立审查后补齐三条数据链缺陷（2026-10-20）：① 指针路径 async 单跑/工作流 record 通过身份/时间校验后必须透传真实 `startedAt`（否则主修复路径不显示计时）；② orphan 顶层 status 与指针路径同口径（已验证规范化状态，不再恒 unknown；幽灵降级仍不算完成），终态 orphan 才有真实用时；③ workflow 每个 child 只用自己 status.json 的已验证时钟（startedAt/终态 lastUpdate 附在 child 行上、adapter 透传），**无 child 时间就不显示，绝不拿父工作流时间兑底**；④ 逆序消息的非法 endedAt（< startedAt）显式移除而非原样渲染，且不 mutate executionTurns 共享 turnCache（epoch 只进 id）。零 assistant 消息时不声称已恢复计时（无 elapsed DOM，不造虚拟消息）。回归：`tests/subagent-elapsed-ssr.test.ts`（真实 recoverSubagents→projectSubagents→Transcript SSR 计时 DOM）、`tests/subagent-transcript-timing.test.ts`、`tests/subagents.test.ts`、`tests/subagent-snapshots.test.ts`。

**状态**：部分满足。
- single/workflow 转录：部分满足。2026-10-19 现场确认 async single 运行中转录路径发布在 `steps[0].sessionFile`，顶层 `sessionFile` 常在结束后才出现；Desktop 原来只读顶层，造成“有 tokens/轮次但看不到过程”。修复分支按通过身份校验的唯一 step 回读，保留 containment/时间/调用身份约束；运行中、追加消息和完成态待发版验收。回归 `tests/subagent-snapshots.test.ts` 与 `tests/subagent-live-transcript.browser.cjs`。
- completions 形态卡片恢复：满足（v0.1.24 #121）。
- **子会话 `sessionFile` 读取**：待上游。上游 `pi-subagents@0.78.0` async 路径不写子运行 `status.sessionFile`（`sessionFilesByFlatIndex` 全包无生产者，`async-execution.js:1079` 读空值）。Desktop 用父 workflow `steps[].sessionFile` 回退（v0.1.24 #122），治标。上游 main 今日（2026-10-16）在修同簇问题（#2915–#2920）但未发版。

**上游依赖**：`pi-subagents`（repo `nicobailon/pi-subagents`）。已提 issue #2921（2026-10-16，带 `sessionFilesByFlatIndex` 无生产者的代码证据）。相关 issue：#1441（fleet 转录读不到，信任根问题，CLOSED 2026-08-24，另一根因）、#2916（更新后 bg_wait 失效，CLOSED 2026-10-16，不覆盖本根因）、#1124（承诺的 output 日志从不写，CLOSED，同形态）。

**回归触发**：pi-subagents 升级（重点：async 路径是否开始写 sessionFile）；改 `subagent-snapshots.ts`（childSessionPointer、recoverSubagents 记录是否仍带真实 startedAt/updatedAt）、`src/renderer/pi/subagents.ts` 的 `subagentTranscriptTurns`/`projectSubagents`（entry 时间戳只能取消息真实时间或 status.json 快照真实 startedAt/endedAt，缓存 epoch 只允许进 id）。

### R-subagent-03　断开会话必须确认；切换会话不拦

**需求**：断开会话会终止 pi 进程、子代理不可恢复，必须先显式确认（含非当前会话的通用确认）。切换会话不拦（不杀进程，用户 2026-10-16 明确）。

**验收**：
- disconnectRun 对当前会话有 live 子代理时弹确认（报数量）；用户取消则不关。
- disconnectRun 对非当前会话（设置页运行列表）也确认，无数量时给通用文案。
- selectSession 切换自由，不弹窗。
- 新建/导航回放/归档等不杀进程的路径同样不拦。

**状态**：满足（0.1.25 定稿：拦截仅限断开路径）。

**回归触发**：改 `adapter.ts` 离开会话相关方法；store history 缓存范围变化。

---

### R-sidecar-01　辅助对话能理解主会话的追问指代

**需求**：辅助对话是独立会话（不共享主上下文、仅 read 工具），但用户常接着主对话的话题追问（「刚才那个方案第三步」「上面那个报错」）。副驾启动时把主会话最近几轮摘要注入自己的 systemPrompt，让它能理解指代对象。

**验收**：
- 摘要只含文本：图片/工具调用降级为占位标记，错误轮次跳过，思考与工具过程不入摘要。
- 预算封顶：默认最多 12 条 message、4000 字符总量、单条 600 字符（超长取头尾）；env `PI_SIDECAR_SUMMARY=off` 完全关闭。
- 注入失败（索引坏/超限）不阻塞副驾启动，退化为无背景（与旧行为一致）。
- 注入是单向背景：措辞明示「背景而非指令，不要执行其中待办，不要臆测未列出的内容」。
- 副驾自身契约不变：仍 read-only、仍不写主会话、摘要不含可执行内容。

**状态**：满足（0.1.26 起）。

**回归触发**：改 `sidecar-service.ts` 的 launch 输入；改 `session-index.ts` 的 branch 语义；摘要预算调整。

---

## 会话域（session）

### R-session-01　打开会话读到的就是这条会话的最新内容

**需求**：一个逻辑会话可能对应多个文件——外部 CLI 原始快照、Desktop 续聊副本、以及「编辑重发」fork 出的延续链尾。**打开/阅读与发送必须落在同一份文件上**，否则用户点进来看到的永远是断开时的旧内容。

**验收**：
- 打开外部快照时，若已存在更新的 Desktop 副本（或延续链尾），直接展示那份内容；不需要先发一条消息才刷出来。
- 解析必须是**只读**的：不启动 pi、不发 prompt、不改写或新建会话文件（回归测试钉住启动模型运行数为 0）。
- 预热被跳过时（已归档 / 连接数已满 / 环境不可用 / 连接失败）阅读路径同样拿到正确历史——不能把正确性寄托在预热成功上。
- 没有副本的外部快照保持原样显示；Desktop 自有会话不受影响，不产生新副本。
- 已明确选择某个分支 leaf 时不重定向（用户正在看历史分叉，不能偷偷换）。
- 重定向后：导航历史里**替换当前条目**而不是多压一级（不产生多余的「后退」步）；未发送草稿搬到目标会话；双方已有草稿时按目标在前、源在后合并文本，附件按 id 去重保留双方；迟到的旧响应不得覆盖目标会话内容或把用户从别的会话拽走。
- 已连接会话 fork 后保持原 runtime/event key，以显式 historyKey 别名读取真实链尾；打开源、打开链尾与继续发送均复用该 runtime，不靠断开或启动另一进程。
- 目标 key 幂等：副本自身是 owned 会话，不会再次进入重定向分支。
- 回归：`tests/session-history-target.test.ts`（store 层）、`tests/session-history-resolution.test.ts`（主进程只读解析）、`tests/session-history-active-fork.test.ts`（真实 backend/RPC fixture fork → store → 发送，非 Electron 端到端）、`tests/session-history-target.browser.cjs`（真实侧栏点击 + 重开）。

**状态**：待发版验收（本分支修复）。

**回归触发**：改 `backend.ts` 的 connect/副本选择逻辑、`session-continuations.ts` 的链解析、`adapter.ts` 的 selectSession/refreshHistory、`index.ts` 的 history handler。

---

## 模型域（model）

### R-model-01　模型配置保存后运行中会话即时生效

**需求**：在设置里改了模型/提供商/凭据/思考等级（如扩展 max）后，**已连接的运行中会话当场生效**，不需要新建会话或重启 app。

**验收**：
- 保存后同进程重读 `models.json`、重绑当前 provider/id 的模型、回读思考等级。
- 任务正在跑/排队/重试/交互等待时不安全态时延后到安全空闲再刷新，不打断当前请求。
- 失败或超时明确报错，不假报成功；回执不携带模型凭证。
- 手动"刷新模型列表"走真刷新而非只读快照。

**状态**：满足（v0.1.24 #122）。

**上游依赖**：pi 内核 `ModelRuntime.refresh({allowNetwork:false})` 可重读配置；`setModel` 重绑；`getSupportedThinkingLevels`（`@earendil-works/pi-ai`）。

**pi 版本适配**：v0.1.37 已验证 **1.4.0**（2026-10-27）：相对 1.3.0，`modes/rpc/rpc-mode.js`、`rpc-types.d.ts`、`model-registry.js`、`extensions/runner.js`、`extensions/types.d.ts` 相同；SDK 改用 client identity，`before_provider_headers` 不再看到部分 attribution 头，Desktop 自带扩展未使用该 hook。内置 pi 固定 1.4.0，本机兼容排他上界为 1.5.0；Windows 本机 CLI 仍不启用。两项 RPC 冒烟、typecheck、全量 1866 tests 通过。R-model-01/03、R-render-01、R-subagent-02、R-sidecar-01 的已有回归继续通过，原有部分满足项不提升状态。验证边界与证据见 [pi 1.4 适配记录](pi-1.4-adaptation.md)。上游 #11062/#11075 可能覆盖旧会话新增工具未激活问题，但不据 changelog 宣称 R-collab-01 现场问题已解决。

**冒烟（每次 pi 升级必跑，两条命令）**：
- `pnpm smoke:rpc`：裸 CLI + RPC，8 个命令（get_state / get_available_models / get_available_thinking_levels / set_model / set_thinking_level / get_entries / get_session_stats / set_session_name）+ 事件面。
- `pnpm smoke:rpc-full`：**Desktop 完整启动参数**（`-e` 扩展链 + `--session`/`--session-dir` + `--append-system-prompt` + `--tools` 白名单 + `--model`），起本地 OpenAI 兼容 server 让 prompt 真正跑通、transcript 落盘，再从 system prompt 的 `<tools>` 块断言激活工具集（必须含 read/grep/find/ls、不得含 bash/edit/write）；扩展链靠 entries/transcript 里的 `desktop-policy-audit` 自定义条目验证。

**冒烟自保（`tests/bundled-runtime-integrity.test.ts`）**：pi 的 bundle 用 `PI_PACKAGE_DIR` 覆盖自身包目录，任何 spawn 点若继承该变量，冒烟会静默跑到**全局 pi 安装**上（版本不符时「验证通过」是假的，且 `prepare-runtime.mjs` 版本自检会抛错）。故：所有 spawn 点（prepare-runtime.mjs / backend.ts / 两条冒烟）必须删除 `PI_PACKAGE_DIR` 与 `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`；两条冒烟必须在跑任何命令前先断言 `cli --version === resources/pi-runtime/package.json`。该测试真起子进程验证（污染确实生效 + 清理后恢复），并做破坏-恢复验证过。

**回归触发**：pi 升级（refresh/setModel 契约）；改 `model-refresh.mjs`/`backend.ts`（modelsSafe/performModelRefresh）。

### R-model-02　思考等级配置不丢

**需求**：用户给模型配的思考等级映射（如 `ccr-opus` 的 `{max:'max'}`）在 restart、disable→enable、provider 改名迁移等生命周期中不丢。

**验收**：
- 普通刷新/重读：自定义字段保留。
- restart（disable→enable 等价生命周期）：字段保留。
- provider 改名迁移：旧 provider 的自定义字段搬迁到新 provider，不删旧即建新。

**状态**：部分满足。普通刷新已被上游 CCR #69 修复；disable→enable 生命周期与 legacy 改名迁移仍丢（CCR Issue #76 已提，等上游）。

**上游依赖**：`claude-code-router-next`（CCR）。Issue #76：https://github.com/xiaoliu10/claude-code-router-next/issues/76

**回归触发**：CCR 升级；改 CCR `client-integrations.ts` 的 provider 生命周期。

### R-model-03　思考等级六档语义

**需求**：`thinkingLevelMap:{max:'max'}` 表示默认五档（off~high）保留 + 扩展 max，共六档。映射是翻译表，null 才是禁用。

**验收**：配置 `{max:'max'}` 时，UI 与运行时都呈现 off/minimal/low/medium/high/max 六档；不因没写 xhigh 而禁基础档；不替用户加 xhigh 或白名单化。

**状态**：满足（用户心智模型已明确，记忆 `pi-thinking-level-max-only.md`）。

**回归触发**：改 `thinking-level-chips.tsx`/`model-draft.ts`；CCR 思考等级字段语义变化。

---

### R-model-04　有效输出恢复后重试状态条退场

**需求**：模型在同一用户轮内恢复有效输出（文本、思考或工具调用）后，隐藏「Desktop 重试 / 等待模型响应」状态条；恢复输出不等于任务完成，不得重置组数或提前释放排队任务。

**验收**：
- 空流开始、错误事件、用户消息、工具结果不算恢复；非空 assistant delta / snapshot 才算。
- Desktop 第 2–10 组和 CLI 内部重试均适用；主进程快照带恢复事实，切回会话不会复活横幅。
- 再次内部重试或等待下一组时重新显示状态条；组数和退避预算不变。
- 重试期间当前轮模型错误卡继续隐藏；最终 failed/exhausted 显示错误详情，上一轮错误和工具错误不误删，原始日志不改。

**状态**：修复已测试，待审查 / 发版验收。

**回归触发**：改 `src/shared/model-output.ts`、`retry-groups.ts`、`model-retry.ts`；pi 流式事件形态变化。测试：`tests/model-output.test.ts`、`tests/retry-groups{,-backend,-renderer}.test.ts`、`tests/retry-groups-ui.browser.cjs`。

---

## 计划域（plan）

### R-plan-01　任务清单只显示最近一轮

**需求**：会话跨多个任务时，计划面板只显示"最近一轮"的计划。新一轮还没建清单时显示空，不复活旧任务的清单。

**验收**：
- 以最后一条用户消息划分轮次边界，只在其后扫描 `desktop_update_plan` 结果。
- 同轮内取最后一次成功结果，progress→result 收敛语义不变。
- 无用户消息（纯工具续跑）退回整段，保持可用。
- `saved` 集合只从当前轮收集，不跨轮误判。

**状态**：满足（v0.1.24 #123）。

**回归触发**：改 `conversation-plan.ts`；pi 的 `desktop_update_plan` 工具结果形态变化。

---

## 渲染域（render）

### R-render-01　长会话流式输出不卡顿

**需求**：大会话流式输出（150ms 一拍 delta）期间，输入与界面不卡。

**验收**：
- 流式期间主进程单次同步阻塞 < 50ms（实测修复前：history() 每次 scan() 热 173ms/冷 3.5s，103.7MB 会话 dirty 全量重解析 421ms）。
- 渲染层 memo 子组件不被每次 render 新建的对象击穿。
- Desktop 历史 IPC 不重复传输界面未消费的 toolResult 顶层图片 base64；只做传输投影，内部历史、fork/续接、用户图片和工具 details 必须无损。回归：`tests/renderer-history.test.ts`；真实 Electron 对照：`tests/renderer-history-ipc.electron.cjs`。
- **主进程不得持有会话索引的文件系统工作**：目录遍历、会话文件读取/解析、分支维护、全文搜索、大纲聚合、子代理状态恢复与 fork 副本写盘全部在独立 utility process（`index-worker-entry.ts`）内完成；主进程只保留有界镜像——会话元数据列表 + 每个已订阅 key 最近至多 256 条/4MB 的分支尾窗（`index-client.ts`；投影图片/超长文本并标记，至少保留 64 条身份骨架，单条异常超限则窗口不可用）。同步镜像读要么满足所请求的尾窗，要么抛 `IndexUnavailableError` 走既有 fail-closed 路径，**不得返回静默截断或崩溃前冻结的数据**。`compaction_end` / `agent_settled` / 自动重试 / 哨兵结算等事件时刻读取必须走 `branchTailAsync` 的 owner 增量解析真值，不得将 120ms 推送镜像当成落盘真值。不变量：**全量无损 entries 永不跨进程回主进程**（historyAsync = 尾窗 + 传输投影；remotePage = 分页；search/outline/recoverSubagents 在 worker 内算完只回有界结果；forkCopySource 在 worker 内落盘只回路径）。缺省 history 在 worker 边界收敛为 tail 500（带 truncated），entries 始终与 branch 同窗；用量统计在 worker 内聚合后回传。窗口创建不等待索引冷扫，首个 sessions IPC 保持渲染层既有加载态，快照就绪后广播补刷新。worker 意外退出按 200ms/1s/3s 退避最多重启 3 次，重启窗口清空尾窗镜像、保留元数据到新快照原子替换，新 worker ready 且订阅恢复后才 flush 全部 `ready()` waiter；fatal/close 也必须唤醒所有 waiter。重启窗口内 owner 请求立即 fail-closed，60s 无应答判死并有界重启；超限才置 fatal 并留痕；主动 `close()` 永不重启。回归：`tests/index-worker-client.test.ts`。
- 2026-10-20 实测（同机、真实数据 367 会话/1.1GB、最大单文件 210MB，`/tmp/pd-worker-proof.mjs` 跨进程探针）：冷扫 6.7s 工作量仍在，但主线程最大事件循环延迟 7.5ms（旧架构为整段同步阻塞）；热扫 449ms → 45ms（拒绝 stamp 缓存）；读最大会话一屏历史 14ms；200 次元数据同步读合计 1ms。**证据边界**：这证明主线程不再被索引工作阻塞，不等于端到端输入 p90 已达标——仍需在真实 app 里用 `__piPerf.report()` 与 main-perf.log 时间戳对照复测（2026-10-19 的 p90=520ms/max=2909ms 是聚合值，非因果对齐样本）。方案与选项见 `docs/design/input-lag-multicore.md`。
- 大会话历史读取不全量重读：落盘会话走增量 tail 解析（session-index），运行中会话的 `get_entries(since=leafId)` 增量契约待接入（切片 2c）。
- 非 pi `.jsonl` 已成功读取但没有有效会话头时，按真实路径及 `ino/size/mtime/ctime` 缓存拒绝结果；全扫、watch 与轮询不重复读取/解析未变内容。追加补齐（包括未完整 header）、同尺寸改写、替换、截断后重新识别，删除后清理；瞬态读取错误可重试，旧 history/dirty/branch/plan/outline 不残留。保留原兜底扫描频率、嵌套可见性及 sidecar 语义。回归：`tests/session-rejected-files.test.ts`。该优化只消除已拒绝文件的重复解析，不代表冷扫描或多秒端到端输入卡顿已根治。
- **统一 IPC 入口（`local-pi:*` 唯一注册点）必须先校验来源、再执行业务，且严格一次**：不得为
  「先跑一遍拿返回值、跑完再校验、校验通过后又跑一遍」的形态。旧入口（d4f7d94）正是如此：
  合法同步调用业务执行两遍——每次 IPC 的主进程开销翻倍，`history()` / `sessions()` / `scan()`
  这类同步热路径直接双倍阻塞主进程（与本条「单次同步阻塞 < 50ms」的验收口径冲突）；异步 handler
  在提前 `return promise` 处根本走不到校验行，未授权调用照样拿到结果。修复后：授权在任何业务
  执行之前，同步值 / Promise 返回 / throw / rejection 四种语义原样透传，慢调用计时每次调用恰记录
  一次（含失败路径）且记录失败被就地吞掉——观测不得影响业务，也不得制造 unhandled rejection。
  回归：`tests/ipc-entry.test.ts`（授权先于业务、非法 sender/frame/窗口缺失时业务零执行、四条
  返回语义、计时恰一次、记录抛错不外溢、`index.ts` 接入约束——helper 不得变成孤岛）。

**状态**：大部分满足。**主进程冷扫描/解析的 worker 隔离已实现**（2026-10-20，`IndexPort` + utility process，实测主线程最大 loop 延迟 7.5ms，见上条证据与边界）；非 pi `.jsonl` 的重复解析已消除（热扫 449ms → 45ms）；统一 IPC 入口的业务双执行与异步绕过授权已修。切片 1（labelsFor 缓存，v0.1.24 #120）已修 memo 击穿；切片 2a/2b（history() 去全扫 + 增量 tail 解析，实测 421ms → 平均 6.3ms）已修（PR #128）；**渲染侧热路径（Phase 2，实测 sentConversationMessages 热路径 259ms/拍 → 流式 tick 10-12ms，22×）：anchorOf/indexById O(1) 化 + 排序锚值预计算 + segment 整段缓存（branch 数组身份隔离，live/tools 内容签名穿透）+ ChatView queue/scrollRequest props 稳定化**；**统一 IPC 入口的「业务双执行 + 异步绕过授权」已修**（自 0.1.30 计时埋点 `a1c4f7c` 引入：它把原本「先校验 → `return fn(...args)`」的入口包成「先跑业务 → 校验 → 再跑业务」；修复即恢复该语义并保留埋点——提取 `src/main/ipc-entry.ts`，`index.ts` 的 `handle` 改为 `createIpcHandle`，123 个通道注册点逐字不变；合法同步调用的主进程工作量减半，未授权同步/异步调用一律零业务执行）；剩余：运行中会话改走 RPC get_entries（切片 2c）、可选虚拟化（切片 3）、活动段/历史段 useMemo 拆分（A1，若剩余 10ms/拍仍感知卡再做）。

**回归触发**：改 `session-index.ts`（增量偏移/快路径、拒绝 stamp 缓存及 scan/watch/poll 失效一致性）/`adapter.ts`（sentConversationMessages 及其 segment 缓存）/`PiReplicaApp.tsx`（ChatView props 稳定性）/`src/main/index.ts` 的 `handle` 工厂与 `src/main/ipc-entry.ts`（统一入口的授权顺序、执行次数与计时语义）；pi RPC `get_entries` 增量契约变化。缓存正确性由 `tests/sent-conversation-cache.test.ts` 钉住（同 id live 内容增长/历史身份恒定/late progress 穿透/refresh 追加）。

### R-render-02　聊天图片可显示、可下载（blob URL 与 CSP/主进程契约一致）

**需求**：会话里的图片（用户附件、生图结果）必须能显示、也能从灯箱下载原图。图片 URL 由 `image-url.ts` 用 `URL.createObjectURL` 生成 blob: URL（为压 base64 常驻内存，见该文件注释里的 195MB 大会话实测），因此上下游两处契约必须同时成立：CSP 的 `img-src` 放行 `blob:`，下载链路把 blob: 归一化成主进程认的 data URL。

**验收**：
- `src/renderer/index.html` 的 `img-src` 含 `blob:`（同时保留 `'self'` / `data:` / `https:`，不能为了修一个丢其他）。
- `connect-src` 必须显式含 `blob:` 与 `'self'`：灯箱下载用 `fetch(blob:)` 读回内存字节，CSP 的 fetch 走 `connect-src` 而非 `img-src`；缺省时回退 `default-src 'self'` 会被拒（真实 Electron 实测 `Failed to fetch`）。不得顺带放开 `http:`/`https:`/`*` 出口。
- `script-src` 保持 `'self'` 单值（不得引入 `unsafe-inline` / `unsafe-eval` 兜底）。
- 附件图片缩略图与灯箱大图、生图结果网格都能正常显示（不出现 CSP 裂图）。
- **灯箱「下载原图」端到端可用**：附件图片的 blob: URL 必须先归一化成 `image-file.ts` 的 `imageDataUrl` 认的 data URL 再过 IPC（主进程无法解析 blob: 协议）。
- 回归测试：`tests/renderer-csp.test.ts` 断言真实源文件的 `img-src` 允许 `blob:` 且其余来源未丢、`connect-src` 含 `blob:` 但无网络出口；`tests/image-download.test.ts` 断言归一化输出能通过主进程同一套校验（不是「看起来像 data URL」）；`tests/csp-blob.electron.cjs`（`npm run smoke:csp-blob`）在真实 Electron 里钉住图片显示 + `fetch(blob:)` + XHR 三者同时可用且 0 CSP 违规。

**状态**：待发版验收（本分支修复同根因三处缺陷，均自 0.1.28 `fe11050` 引入 blob URL 起存在：① `img-src` 不含 `blob:`，Console 刷 "Refused to load the image 'blob:file:///...'"，附件图片全部裂图而 UI 侧无异常；② 下载把 blob: URL 直接传给只认 data URL 的主进程；③ 归一化改用 `fetch(blob:)` 后，`connect-src` 未放行 blob:，真实 Electron 下 fetch/XHR 均被 CSP 拒——②③任一不修，保存对话框都不弹，用户只看到通用「图片保存失败」。2026-10-19 Electron 33 探针实测：仅 `img-src blob:` 时 img=ok、fetch/xhr=error；补 `connect-src 'self' blob:` 后三者全 ok 且无新增网络出口）。

**回归触发**：改 `src/renderer/index.html`（CSP）、`image-url.ts`（若换回 data URL 或改用自定义协议）、`shared/image-download.ts`（下载归一化）、`main/pi/image-file.ts`（下载校验）、Electron 升级（webSecurity / CSP 处理变化）。

---

## 自动化域（automation）

### R-automation-01　定时任务默认跑在项目原会话；重复指令不重复执行

**需求**：定时任务（desktop_schedule 工具 / 自动化页）默认（sessionMode=reuse）必须执行在项目下最近活跃的原会话——会话正忙（running）按 followUp 排队、同项目并发的多个自动化 run 在同一会话串行投递；只有创建时明确选「独立新会话」（fresh）才开新会话。完全相同的创建指令（同名、同 prompt、同 schedule、同项目）不得落第二个任务。

**背景**：2026-10-23 实测一个请求落了两个同名任务，到点 6ms 内先后触发——一个接上原会话、另一个撞上旧的「同项目已有自动化在跑→新建隔离」互斥分支开了独立会话，用户看到两份执行。

**验收**：
- reuse 模式下，同项目已有自动化 run 在跑时，后续 run 投进同一会话并在其收尾后串行投递（会话锁保护 waiter/stepGuard 单槽），不新建隔离会话；事件归因始终指向持锁投递的 run。
- bridge create 幂等：已存在同项目+同名+同 prompt+同 schedule 的 enabled 任务时，直接返回既有任务（`duplicate: true`），不重复落库；schedule 或 prompt 不同则正常新建。
- fresh 模式仍新开独立会话并应用任务配置；等锁期间被停止的 run 不投递任何步骤。

**状态**：实现与测试通过，待审查 / 发版验收。

**回归触发**：改 `automation-service.ts`（resolveSession/execute/onPiEvent）、`automation-bridge.ts`、`extensions/desktop-schedule/index.mjs`。测试：`tests/pi-automation.test.ts`（2d 同会话串行）、`tests/desktop-schedule.test.ts`（幂等创建/文案）。

### R-render-07　压缩中拒发完全静默，正文退回输入框

**需求**：发送被 pi 内核以「压缩进行中」拒绝（`Cannot submit a prompt while compaction is in progress`）时，**不做任何错误呈现**——不写全局错误横幅、不写对话内错误卡；输入内容退回输入框，压缩结束后由用户自行重发（用户 2026-10-27 先要求进对话流，2026-10-28 进一步要求「都取消好了」）。

**验收**：
- 分类口径集中在 `src/shared/send-error.ts#classifyTransientSendError`，**只**匹配内核 compaction 拒发文案；连接数满、模型刷新中、停止未确认、进程退出、鉴权、网络等其他失败**一律走全局错误横幅**，不得被静默吞掉（审查 P1）。
- 命中 compaction 时：`send` 的 catch 不得写 `error`/`errorKey`、不得写任何对话流提示状态、不得留下 `sends`/`sentAt`/`pendingPrompt` 痕迹；草稿与附件按归属会话还原（不覆盖用户新输入）。
- 真实失败仍走全局横幅并还原草稿/附件（既有行为不变）。
- 回归：`tests/inline-send-error.test.ts`（分类边界/静默无痕迹/真实失败走横幅）、`tests/silent-compaction-reject.browser.cjs`（真实浏览器：无 `.pi-banner--error`、无 `.pi-send-error`、对话流不显示拒发原因与 IPC 前缀、草稿可重发）。

**状态**：实现与浏览器验证通过，待发版验收。

**回归触发**：改 `adapter.ts` 发送 catch 与 `send-error.ts` 匹配口径；pi 内核新增/改写拒发文案时必须同步分类表，且扩大「静默」范围前先证明它确实是「无需用户动作、重试即可」的临时状态。

---

### R-render-03　对话中的文件引用可在右侧查看

**需求**：消息中的内联代码文件路径和 Markdown 本地文件链接可点击，在右侧工作台查看当前文件，而不触发主窗口导航。

**验收**：
- 相对路径按当前会话项目目录解析；支持绝对路径、`文件:行号[:列号]` 和 `#L行号`，定位到对应行。
- 复用文件预览 IPC 与工作台，消息引用优先展示完整文件内容，不强制跳到 Git diff；原有工具卡的历史修改预览保持不变。
- 只在用户点击时读取；代码块、URL、命令和普通标识符不误识别，不嵌套交互元素；按钮可键盘操作。
- 缺失文件明确提示；晚到的旧请求不得覆盖新选择、跳到别的会话或重新打开用户已关闭的面板。

**状态**：实现与浏览器验证通过，待审查 / 发版验收。

**回归触发**：改 `ChatMarkdown`、`file-references.ts`、`PiReplicaApp.tsx` 文件预览入口。测试：`tests/chat-file-references.test.ts`、`tests/chat-file-preview.browser.cjs`、既有 `pi-file-preview/pi-tool-file-preview` 回归。

### R-render-04　设置 → 关于显示真实 Desktop 版本

**需求**：设置页「关于」展示的版本必须是主进程 `app.getVersion()` 的真实版本，不得保留任何硬编码占位串。

**验收**：
- `SettingsPage` 的版本字段来自 `SettingsProps.appVersion`，由 `PiReplicaApp` 传 `s.env.desktopVersion`（主进程 `withAppVersion` 注入）；preview/demo 未传时降级为 `—`，不显示假版本。
- 回归：`tests/settings-version.browser.cjs`（显示 0.1.36 且不含 `0.1.0-desktop`）。

**状态**：满足（v0.1.37，issue #168；浏览器红/绿与全量测试通过）。

**回归触发**：改 `SettingsPage` InfoPane、`SettingsProps`、PiReplicaApp 的设置页接线、版本注入链路（host.withAppVersion / environment.desktopVersion）。

---

### R-render-05　聊天 file:// 交付文件链接可打开（非死链）

**需求**：assistant 消息中以 `[名称](file:///绝对路径)` 形式交付的本地产物（PNG/PDF/HTML 等）必须可点击打开；http(s) 链接继续走系统浏览器，任何链接点击都不得触发主窗口顶层导航。

**验收**：
- `ChatMarkdown` 通过 `markdownUrlTransform` 保留 file:// href（react-markdown 默认 `defaultUrlTransform` 的 safeProtocol 白名单不含 file，会把 href 剥成空串）。
- 点击 file:// 链接经 `fileUrlToPath` 解码（中文、%20、Windows 盘符；拒绝远程 host/非 file 协议/NUL）后走 `openLocalFile` IPC：文档型扩展名（图片/PDF/HTML/Markdown/文本等白名单）用系统默认应用打开，目录在文件管理器打开，**可执行载荷与未知类型（.app/.command/.exe/无扩展名等）只在 Finder 显示**，不因一次点击变成执行入口；文件不存在明确报错。
- 其他非 http(s) 协议一律 preventDefault，不出现「有下划线但点了没反应」的死链，也不允许 about:blank 导航。
- 回归：`tests/chat-file-url.test.ts`（URL 解码/安全过滤）、`tests/open-local-file.test.ts`（打开 vs 显示的安全门）、`tests/chat-file-link-click.browser.cjs`（真实点击 → openLocalFile 收到解码路径、http 行为不变、无导航）；既有 `tests/chat-link-click.browser.cjs` 必须保持绿。

**状态**：本分支实现，浏览器与单测验证通过，待审查 / 发版验收。

**回归触发**：改 `ChatMarkdown`（components.a / urlTransform）、`file-url.ts`、`open-local-file.ts`、`openLocalFile` IPC 与 preload 暴露；react-markdown 升级（默认 URL 过滤策略变化）。

---

### R-render-06　工作台 HTML 文件可渲染预览，渲染/源码由用户选择

**需求**：文件预览对 `.html/.htm` 交付文件默认展示渲染效果，用户可一键切回源码查看；不强制单一视图。

**验收**：
- 默认渲染：iframe `sandbox="allow-scripts"`（opaque origin，无同源权限）+ `srcDoc` 内联渲染当前磁盘内容；不为主任务放宽全局 CSP。
- 「源码」切回既有高亮源码视图；切换预览文件时回到渲染视图。
- 「系统打开」按钮（runtime 具备 `openLocalFile` 时显示）交系统默认应用处理交互式页面。
- 回归：`tests/workbench-html-preview.browser.cjs`（默认渲染/sandbox/srcdoc、切源码、切回渲染、系统打开）；`tests/workbench-home.browser.cjs` 保持绿。

**状态**：本分支实现，浏览器与全量测试通过，待审查 / 发版验收。

**回归触发**：改 `WorkbenchPanel.tsx`（files 渲染分支）、`workbench.css` 预览样式、`openLocalFile` IPC 面；react/CSP 策略变化（sandbox iframe 行为）。

---

## 会话协作域（collaboration）

### R-collab-01　跨会话交接：投递到目标项目的既有会话

**需求**：会话 A 可通过 `desktop_handoff` 把自包含的排查/任务上下文投递给**另一个项目**的既有会话 B——项目级记忆/MCP/权限随 B 的项目隔离，不新建孤立会话、不把内容灌进 A。默认目标 = 目标项目下未归档、非副驾、Desktop 自建的最近活跃会话（已连接的活跃 run 优先）；也可显式指定 sessionKey。

**验收**：
- B 空闲：立即以一个带交接信头的 user 回合开始；B 运行中：按 followUp 排队，不打断当前回合；B 未连接：按其记忆的访问模式重连后投递。
- 已归档、副驾、其他项目、超限会话不得被默认选中；目标与源会话相同必须拒绝（防自触发循环）。
- 幂等键去重：同键重试/并发只投递一次，失败后允许同键重试。
- 目标不存在/项目目录无效/消息超长时返回明确错误，不静默新建会话。
- 可先用 action=list 查询项目候选及连接状态。

**状态**：实现与测试通过（模型工具 v1，无 UI），待审查/发版验收。

**回归触发**：改 `handoff-bridge.ts`、`extensions/desktop-handoff/index.mjs`、backend 的 `desktop-handoff` 拦截与扩展加载、打包 extraResources。测试：`tests/handoff-bridge.test.ts`。

---

## 升级回归总表

升级 pi / pi-subagents / CCR / Electron 前，按下表核对相关需求：

| 升级项 | 必须回归的需求 | 原因 |
|---|---|---|
| pi-subagents | R-subagent-02, R-subagent-01 | async 路径 status/sessionFile 形态可能变 |
| pi 内核（fork/会话条目） | R-sidecar-01 | message 条目形状、parentId 链/branch 语义、--append-system-prompt |
| pi 内核 | R-model-01, R-model-03, R-render-01, R-subagent-02 | refresh/setModel 契约、get_entries 增量、subagent 事件。**必跑 `pnpm smoke:rpc`** |
| CCR | R-model-02, R-model-03 | provider 生命周期、思考等级字段 |
| Electron | 全部渲染/IO 需求 | 进程模型、IPC 行为 |
| Electron / 改 CSP | R-render-02, R-render-01 | webSecurity 与 img-src 处理变化（blob URL 图片会静默裂图） |

**升级前必做**：读本文 → 对照"上游依赖"列出的 issue 状态 → 若上游已发新版，先在本机隔离测相关需求 → 通过才合并到 Desktop。
