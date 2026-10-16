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

**需求**：后台子代理运行时，用户在主对话界面能持续看到"还有 N 个子代理在工作"，不需要主动展开面板。全部结束后提示消失。

**验收**：
- 有 running/queued 子代理时，输入框上方常驻提示条，显示数量与 agent 名（>3 个去重）。
- 点击提示条打开子代理面板；面板与提示条只计 running/queued，不含 completed/failed。
- 切换会话或断开会话时若有子代理在跑，先向用户确认；断开（不可逆）即使不是当前会话也先确认。
- 全部子代理进入终态后，提示条自动消失。

**状态**：满足（v0.1.24 #124）。断开守卫对非当前会话退化为通用确认（store 无其 history），是已知边界。

**回归触发**：改 `adapter.ts`（selectSession/disconnectRun/liveSubagentCount）、`subagents.ts`、`RunningSubagentBar.tsx`；pi-subagents 升级（status 形态可能变）。

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

### R-subagent-03　断开/切换会话不静默杀子代理

**需求**：用户离开当前会话（切换/断开/归档/新建）时，若当前会话有 running/queued 子代理，必须先显式确认。断开是终止 pi 进程、不可逆，优先级最高。

**验收**：
- selectSession/disconnectRun 对当前会话有 live 子代理时弹确认；用户取消则不离开。
- disconnectRun 对非当前会话（设置页运行列表）也确认，无数量时给通用文案。
- 不杀进程的路径（新建/导航回放/归档）不强制拦，但文案如实（切换不杀进程）。

**状态**：满足（v0.1.24 #124 + 后续 P1-1 修复）。新建/导航/归档路径不拦是已知边界（不杀进程，子代理仍可切回查看）。

**回归触发**：改 `adapter.ts` 离开会话相关方法；store history 缓存范围变化。

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
- `pnpm smoke:rpc-full`：**Desktop 完整启动参数**（6 个 `-e` 扩展 + `--session`/`--session-dir` + `--append-system-prompt` + `--tools` 白名单 + `--model`），验证扩展链靠 entries 里的 `desktop-policy-audit` 自定义条目（system prompt 不落 entries，别断言它）、增量契约用 `get_entries(since=leafId)`。

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
- 流式期间主进程单次同步阻塞 < 阈值（待定，当前主进程 1.06s 是已知缺陷）。
- 渲染层 memo 子组件不被每次 render 新建的对象击穿。
- `get_entries(since=leafId)` 增量契约被使用，不全量重读。

**状态**：部分满足。切片 1（labelsFor 模块级缓存，v0.1.24 #120）已修渲染层 memo 击穿；切片 2（主进程 1.06s 同步阻塞，嫌疑在 `session-index.ts:68/184`）待做。

**回归触发**：改 `session-index.ts`/`adapter.ts`/`PiReplicaApp.tsx`；pi RPC `get_entries` 增量契约变化。

---

## 升级回归总表

升级 pi / pi-subagents / CCR / Electron 前，按下表核对相关需求：

| 升级项 | 必须回归的需求 | 原因 |
|---|---|---|
| pi-subagents | R-subagent-02, R-subagent-01 | async 路径 status/sessionFile 形态可能变 |
| pi 内核 | R-model-01, R-model-03, R-render-01, R-subagent-02 | refresh/setModel 契约、get_entries 增量、subagent 事件。**必跑 `pnpm smoke:rpc`** |
| CCR | R-model-02, R-model-03 | provider 生命周期、思考等级字段 |
| Electron | 全部渲染/IO 需求 | 进程模型、IPC 行为 |

**升级前必做**：读本文 → 对照"上游依赖"列出的 issue 状态 → 若上游已发新版，先在本机隔离测相关需求 → 通过才合并到 Desktop。
