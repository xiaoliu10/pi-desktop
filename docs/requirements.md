# PI Desktop 需求清单

**目的**：把"我们要什么"和"现状如何"固定下来。插件升级、pi/CCR/pi-subagents 版本改动、重构，都要回到这份清单逐项核对——能跑通不等于满足需求。每条需求写明验收标准与回归方式，不写空话。

**与各专项文档的关系**：本文是需求总表（What + Why + 验收）。实现细节（How）在各 `docs/*.md` 与代码注释里，需求条目里给出链接即可。

## 字段说明

- **ID**：`R-<域>-<序号>`，域分 `subagent`/`model`/`plan`/`render`/`session`/`io`/`deploy`。
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

**状态**：满足（v0.1.24 #124 首版；v0.1.25+ 按用户反馈两轮定稿：去弹窗、去横幅、换 bot 图标）。

**回归触发**：改 `ChatView.tsx`（toolRowIcon/ToolCard 的 bot 图标与卡片渲染）、`adapter.ts`（selectSession/disconnectRun/liveSubagentCount）、`subagents.ts`；pi-subagents 升级（status 形态可能变）。

### R-subagent-02　子代理详情可读：运行中与完成态都看得到转录尾部

**需求**：点开任一子代理，能看到它的任务/状态/agent，并能在完成态读取子会话转录尾部（用户核对子代理做了什么）。运行中态至少显示状态，不永久转圈。

**验收**：
- single 与 workflow 两种模式、running/queued/completed/failed/interrupted 各状态，卡片都出现且状态正确刷新。
- 完成态点详情能读转录尾部；路径与身份校验通过才读，不读则明确提示，不假报"不可用"而实为解析失败。
- 第三形态（completions 结果）同样识别并读子会话，不因形态切换而卡片永久转圈。

**状态**：部分满足。
- single/workflow 转录：满足。
- completions 形态卡片恢复：满足（v0.1.24 #121）。
- **子会话 `sessionFile` 读取**：待上游。上游 `pi-subagents@0.78.0` async 路径不写子运行 `status.sessionFile`（`sessionFilesByFlatIndex` 全包无生产者，`async-execution.js:1079` 读空值）。Desktop 用父 workflow `steps[].sessionFile` 回退（v0.1.24 #122），治标。上游 main 今日（2026-10-16）在修同簇问题（#2915–#2920）但未发版。

**上游依赖**：`pi-subagents`（repo `nicobailon/pi-subagents`）。已提 issue #2921（2026-10-16，带 `sessionFilesByFlatIndex` 无生产者的代码证据）。相关 issue：#1441（fleet 转录读不到，信任根问题，CLOSED 2026-08-24，另一根因）、#2916（更新后 bg_wait 失效，CLOSED 2026-10-16，不覆盖本根因）、#1124（承诺的 output 日志从不写，CLOSED，同形态）。

**回归触发**：pi-subagents 升级（重点：async 路径是否开始写 sessionFile）；改 `subagent-snapshots.ts`（childSessionPointer）。

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

**pi 版本适配**：已测至 **1.3.0**（2026-10-16）：rpc-types.d.ts 与 1.2.0 零差异、rpc-mode.js 逐字节相同（33 命令面）、model-registry.js / extensions/runner.js / types.d.ts / sdk.js 全部相同；bundled runtime 与 `PI_MAX_TESTED` 均已升到 1.3.x。

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
- 大会话历史读取不全量重读：落盘会话走增量 tail 解析（session-index），运行中会话的 `get_entries(since=leafId)` 增量契约待接入（切片 2c）。

**状态**：大部分满足。切片 1（labelsFor 缓存，v0.1.24 #120）已修 memo 击穿；切片 2a/2b（history() 去全扫 + 增量 tail 解析，实测 421ms → 平均 6.3ms）已修（PR #128）；剩余：运行中会话改走 RPC get_entries（切片 2c）、可选虚拟化（切片 3）。

**回归触发**：改 `session-index.ts`（增量偏移/快路径）/`adapter.ts`/`PiReplicaApp.tsx`；pi RPC `get_entries` 增量契约变化。

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

**升级前必做**：读本文 → 对照"上游依赖"列出的 issue 状态 → 若上游已发新版，先在本机隔离测相关需求 → 通过才合并到 Desktop。
