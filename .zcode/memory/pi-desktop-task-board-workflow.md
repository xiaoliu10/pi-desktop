---
name: pi-desktop-task-board-workflow
description: pi-desktop 仓库用共享任务板（docs/agent-task-board.md）协调多个并行 Agent；生产入口现为复刻 UI + window.localPi 后端
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi-desktop 仓库（/Users/jason/projects/opensource/pi-desktop）由用户通过 `docs/agent-task-board.md` 派发任务给多个并行 Agent：第一阶段 U01–U07（UI 复刻，参照 docs/ui-replica-spec.md）、第二阶段 P01–P10（接入本地 pi CLI RPC，依据 docs/coding-agent-workflow.md）。旧的 A 系列自研 AgentRuntime 路线已撤销——`src/main/agent`、`src/main/providers`、旧 `src/renderer/components` 是"旧原型"，保留只读，不再完善。

**架构现状（2026-09-20）：** 两条线已汇合。我（ZCode）完成 U01–U07 复刻 UI（`src/renderer/replica/` 契约驱动组件 + `src/renderer/preview/` 演示适配层，入口 `?preview=1`）；并行 Agent "Codex" 完成 P 系列 pi 后端（`src/main/pi/*`、契约 `src/shared/pi.ts`、桥 `window.localPi`，旧原型 IPC 通道已从主进程删除）。经用户批准，生产入口 `App.tsx` 已改挂 `src/renderer/pi/PiReplicaApp.tsx` + `adapter.ts`（复刻契约 ↔ window.localPi 映射）；Codex 的 `PiDesktop.tsx` 保留但不挂载。

**Why:** 用户明确指示"你不是唯一在代码库工作的 Agent"；Codex 会话并行改动主进程/测试/README，双方按文件所有权分工（P08 增补记录在任务板上）。

**How to apply:** 领取任务前先读任务板与规格文档；只改任务卡"负责文件"范围，跨范围先报告；完成后状态改"待验收"、写验收文档/截图，不主动 commit/push。渲染层新功能应做成 `window.localPi`（LocalPiApi）的消费者——不要给复刻组件加 window.pi（旧桥通道已失效）或假数据回退。相关：[[pi-desktop-network-mirrors]]

**运行/验收工具（2026-09-20 补充）：** 生产启动 `pnpm build && pnpm start`；UI 演示预览 `pnpm preview:ui` → http://127.0.0.1:5174/?preview=1（纯 fixtures，不走 Electron）。Codex 的 smoke 钩子：`PI_SMOKE=2 PI_SMOKE_SCREENSHOT=<png> pnpm exec electron .` 会启动窗口、输出渲染层文本快照并校验 `[data-pi-ready]`（生产根元素必须带此标记），适合无人工验证；`PI_SMOKE_CLICK` 现支持 `'sel1||sel2'` 多级点击（进设置二级页），快照含 `.pi-settings__back` 的 backRect、composer send 样式、`.pi-shortcuts` 表格统计；另有 Codex 加的 `PI_SMOKE_SETTINGS=1`（settings-smoke）。测试基线现为 98 通过（Codex 并行加了测试，注意数字会漂移，以 `pnpm test` 实时输出为准）。

**用户 UI 反馈：** 手绘图标要符合通行惯例——"设置"用齿轮（cog，已换 feather/lucide 风格路径），不要自创放射线/太阳形；图标统一走 `src/renderer/replica/Icons.tsx` 的线性 SVG。品牌标志同理：用户给了参考图（彩色 π），首页云形吉祥物 MascotMark 已删除，换成 `PiBrandMark`（Icons.tsx 内联 24×24 SVG，颜色逐像素采样自参考图：珊瑚红顶梁 #fd7359、蓝左腿 #45a6d8、黄右腿 #ffc83e，两腿底部向外弯脚；参考图在会话 image-cache 里，用 PIL 颜色掩码 + 48 格 IoU≈0.77 验证几何）。macOS 应用图标已完成（2026-09-20）：源图入库 `resources/icon.png`（1024×1024）+ `iconutil` 生成 `resources/icon.icns`；主进程 whenReady 里 `app.dock.setIcon()`（开发模式必须显式设，打包走 icns），BrowserWindow 传 `icon`（Linux/Win），package.json 已加 electron-builder `build` 段（appId works.pi.desktop、mac.icon 等）。改动图标/样式后需 `pnpm build` 并重启 Electron 用户才能看到（重启方式：pkill -f "Electron.app/Contents/MacOS/Electron ." 后 `pnpm start` 后台跑）。

**窗口标题栏避让（2026-09-20）：** 主窗口 macOS 用 `titleBarStyle:'hiddenInset'`，红绿灯浮在左上角会与渲染层内容重叠——设置页"返回应用"曾撞车。修法：PiReplicaApp 仅在设置视图、仅 macOS（navigator.userAgent 判断）包 `.pi-settings-wrap` + 顶部 38px `.pi-dragstrip`（`-webkit-app-region:drag`），浏览器 `?preview=1` 不受影响。以后在左上角放控件都要考虑红绿灯（逻辑坐标约 y10–28）。smoke 钩子新增 `PI_SMOKE_CLICK='<css selector>'` 环境变量，可在截图/测量前先点一个元素（用来验证设置等非首页视图）；返回快照也带 `.pi-settings__back` 的 backRect。

**侧栏项目会话折叠（2026-09-20）：** 用户反馈项目下会话太多——展开项目只显示最近 5 个（`SIDEBAR_SESSION_LIMIT=5` + 纯函数 `visibleSessions`，replica/shell/helpers.ts；列表本就按 updatedAt 倒序），底部"显示全部 N 个 / 收起"切换（Sidebar.tsx ProjectRow，收起项目时复位），中英文标签已入 SidebarLabels 契约（可选字段 showAllSessions/collapseSessions）。≤5 个不显示按钮；nav 搜索过滤仍作用于全部会话。

**用户产品反馈（2026-09-20）：** "诚实占位"不等于完成——数据在本机存在时，用户期望 Desktop 直接只读接出来（"pi cli 应该有配置页面的吧 desktop 把模型配置读出来就好了"），不要拿"由 pi 管理"当不实现的理由。已照此实现模型配置互通：`src/main/pi/model-catalog.ts` 的 `readModelCatalog()` 解析 `~/.pi/agent/`（settings.json → defaultProvider/defaultModel；models.json → 自定义提供商+模型列表；auth.json → 仅认证类型 api_key|oauth），**apiKey/token/headers 绝不进渲染层**；经 `LocalPiApi.modelCatalog()`（shared/pi.ts、preload、main/index.ts 均为对 Codex 文件的增量添加）暴露，渲染层在 `src/renderer/pi/adapter.ts`（catalog state + loadCatalog）和 PiReplicaApp 的 `ModelCatalogSection`/`modelCatalogSection` 契约插槽中消费。测试 `tests/pi-model-catalog.test.ts` 断言密钥不泄露。**（2026-09-21 更新：只读已升级为可写，见下方"模型配置可编辑"。）**

**Why:** 用户把"互通"当作 Desktop 与 pi 共存的核心价值；空占位会被质疑。安全边界（密钥不进前端、修改只在 pi 侧）是任务板文档的硬约束，实现时必须同时满足"真数据"与"不碰密钥"。

**How to apply:** 之后遇到类似"只读展示本地 pi 数据"的需求（如厂商账号、主题、MCP 配置），优先在 `src/main/pi/` 加只读 catalog 类能力 + LocalPiApi 增量方法，前端用契约插槽渲染；新增能力要配"密钥不泄露"测试；改动后更新任务板 P08 增补记录与 docs/ui-replica-verification.md。

**设置页空态问题已过时（2026-09-20 晚更新）：** Codex 的 `SettingsFeatures.tsx` 已为全部 12 个导航项提供真实页面（ai=AI 默认行为、instructions/skills/extensions/subagents=资源 CRUD、mcp、projects、workspace、import、shortcuts），生产设置页不再有空态；"接入本地 pi 后…"（emptyGenericHint）只剩 ?preview=1 演示模式的占位文案，无需再改。设置类需求先查 SettingsFeatures 是否已有页面。

**测试基线持续漂移：** 83→98→109→162→177（并行 Codex 不断加测试），数字仅作参考，以 `pnpm test` 实时输出为准。套件红但不属于自己的改动时，优先补齐其未完成的接线让套件回绿（如 pi-desktop-start.test 的 draftThinking：pickThinking 现在同时写 state.draftThinking + desktopPreferences，send 首连后按 `draftThinking ?? desktopPreferences.defaultThinkingLevel` 应用）。

**其它已修交互（2026-09-20/21）：** ①窗口拖动——hiddenInset 下复刻 UI 最初没声明拖拽区导致整窗拖不动；顶栏（topbar.css）与侧栏（sidebar.css）整条 `-webkit-app-region:drag`，内部 button/input/[role=button] 全部 no-drag。②聊天页顶部虚线横条的"重载扩展/释放内核"按钮已按用户要求移除（状态胶囊保留；释放能力在连接面板的"断开"）。③指向已删按钮的通知文案要同步改（resources-changed 通知不再提"重载扩展"）。

**UI 参照物是 ZCode（2026-09-20）：** 用户发 ZCode 截图当设计稿让照做，已落地两处——①输入框 Composer 重做成 ZCode 风格：白卡 16px 圆角、右侧"真实模型名胶囊 + 深色圆角方形发送键（30×30、radius 9、墨色底自动随主题反色，非圆形）"，权限胶囊完全访问时橙色 #e07b00 + 警示图标；新增 `hideReasoning` 契约字段——pi RPC 无推理档位接口，生产隐藏该胶囊，不做假控件。②快捷键设置页：ZCode 四列表格（命令/按键绑定/作用域/操作）+ kbd 芯片 + ✏️录制式改键（按下即存、Esc 取消、冲突提示）+ ↺全部恢复默认，组件 `src/renderer/pi/ShortcutsPane.tsx`（纯函数 bindingKeys/eventToBinding 已测）。
**文件所有权更新：** 设置页数据层（`SettingsFeatures.tsx`、`settings-service.ts`、settingsSnapshot/saveDesktopSettings）是 Codex 的，做设置类 UI 时只换渲染、复用其 act/busy 快照流程，勿动其数据逻辑；快捷键录制期间用 `document.body.dataset.shortcutRecording` 防全局热键误触发（PiReplicaApp onKey 已加守卫）。用户后续再发 ZCode 截图，优先按"ZCode 布局 + 我们已有数据层"组合实现。

**架构反馈（2026-09-20 晚，重要）：** 用户纠正了 IM 双向机器人的设计思路——"应该是做适配层，具体用钉钉还是飞书用户去选就好了，我们做好对接每种 IM 的适配"。教训：**做集成类功能时核心逻辑与具体厂商解耦，厂商差异收进各自 adapter 文件**，不要按单一渠道写死再扩展。Bot 命令引擎（bot/engine.ts，纯逻辑）+ BotActions 接口 + ImTransport 接口 + 每渠道一个 adapter 的结构即照此落地。遇到类似"支持多个第三方"的需求默认走 adapter 模式。设置→工作区的 RemotePane 现为"移动端远程控制（二维码卡片）+ Bot Channel 渠道卡片网格"两段式布局（参照 ZCode 截图）；不可用渠道如实置灰"暂不支持"，不做死链。并行代理还会改主进程（index.ts 多次出现并发编辑冲突），Edit 前务必重读文件。

**Electron 渲染进程无 window.prompt（2026-09-20）：** `window.prompt` 在 Electron 下直接抛 "prompt() is not supported"（sandbox:true，探针实测）——所有依赖它的交互都是静默失效的死功能。已把会话重命名（Sidebar SessionRow 行内编辑：标题原地变 input，回车存/Esc 取消/失焦保存，自动聚焦全选）和项目重命名（SettingsFeatures ProjectRow 行内表单）改掉；之后任何"弹窗输入"需求一律做行内编辑或自建 dialog，不用 window.prompt/prompt。会话重命名已持久化：`DesktopPreferences.sessionRenames`（saveDesktopSettings，主进程校验 ≤500 条），启动时从 settingsSnapshot 恢复到 store.renames，仅桌面显示不碰 pi 会话文件。

**已归档会话入口（2026-09-21）：** 用户反馈侧栏底部归档按钮不应与设置/扩展/通知平级——已移除；查询入口在 设置→工作区→已归档会话（新 SettingsNavId 'archived'，ArchivedSessions 组件支持 `embedded` 模式嵌入设置页，overlay 模式保留）。会话右键菜单里的单条"归档"不变。

**运行中切换访问模式（2026-09-21，重要架构变化）：** 用户要求任务运行中能直接切成完全访问。原实现靠"关 pi 进程重启"改模式（PI_DESKTOP_PERMISSION 环境变量启动时固定），故强制 idle。现已改为动态：backend.launch 给每个会话写控制文件 `ownedRoot/.mode-<key>`（env PI_DESKTOP_MODE_FILE 传给扩展），`extensions/desktop-policy/index.mjs` 的 `getMode()` 每次 tool_call / before_agent_start 用 mtime 缓存重读，`setAccessMode` 改为直接写文件 + 更新 view（不再重启，运行中下一个工具调用即生效）；切换写入 desktop-policy-audit 审计；审批弹窗挂起时若切到 fullAccess 自动放行该审批；有未处理 dialog 时仍拒绝切换。前端 AccessModeMenu 仅 connecting 时禁用。UI 层加 `disabled` 前先查后端是否真有限制——之前的限制纯粹是旧实现（重启）的产物。

**设置导航分组改名（2026-09-21）：** 用户要求设置页第一组"偏好"改为"基础设置"（英文 Preferences→General）。两处：`src/renderer/replica/settings/SettingsPage.tsx` 的 demoNavFromLabels + `src/renderer/preview/fixtures.ts` 的 demoSettingsNav（?preview=1 演示数据），改导航文案时两处都要同步。

**AI 设置页去重（2026-09-21）：** 用户指出 AI 页的"提供商 ID/模型 ID"输入框与模型设置页重复——已删除；默认模型只在 设置→模型（ModelCatalogSection）管理。AI 页保留推理级别/自动压缩/自动重试，标题改"推理与运行行为"，加指引文字。原则：同一配置不要在两个设置页出现手填入口，重复项删除并留指引。测试基线最新 190/201 通过（仍在漂移）。

**发送按钮变形交互 + 流式渲染限流（2026-09-21，重要性能教训）：** ①Composer 发送键改为 ZCode 式单按钮变形：空闲=发送箭头；运行中且输入框空=停止方块；运行中且有内容=变回发送箭头（排队追问，悬浮提示"发送追问（运行中排队）"）——不要并排两个方块按钮。②"很卡、按钮要切屏才变"的根因是适配层每条流式事件（message_update/tool_execution_update，每秒几十条）直接 setState → 整树重渲染 → 主线程饿死，按键画不出来。修复：adapter `handleRpcEvent` 把流式 delta 缓冲进 pendingLive/pendingTools Map，150ms 批量 flush（message_end/agent_settled 立即冲刷），并给 ChatView 包 `React.memo`。之后任何高频事件流进 store 都要限流批刷 + 重列表 memo；ChatView 的 memo 闭合括号注意函数实际结束位置（ChatView 与 Composer 同在 ChatView.tsx，别把 `});` 加到 Composer 结尾）。测试基线 196/208（漂移中）。

**运行中追加 prompt 的可见性（2026-09-21）：** 用户报"追加 prompt 之后不见了、不在队列中"。用真实 pi 探针（spawn `pi --mode rpc` 收 stdout）+ fake-pi 测试桩双层验证：pi 确实会入队并广播 `queue_update`（入队 f:1、消费后 f:0），桌面后端管线（backend `onEvent` queue_update → view.pending → run 事件）也完全正确——问题是**可见性时序**：文本从输入框清掉到 pi 确认事件绕回来之间（以及消息在回合边界被快速消费后），界面无处显示它。修复：adapter `send` 在 run 处于 running/starting 时**乐观更新**——立即把 `{text: message, behavior}` 加进 run.queue/pending（pi 的权威 queue_update 到达后整体替换，不会重复）。队列展示两处：工作指示器"· N 排队" + 输入框上方 `pi-prompt-queue` details（追问队列 · N，列出每条内容和类型）。教训：异步确认类操作（入队/发送/归档）要做乐观 UI，否则"发出去就没了"；定位这类问题先做真实进程探针再怀疑管线。fake-pi.mjs 现支持 `/long`（保持 streaming）+ `/endlong` + streaming 期间的 queue_update 语义，可测排队全链路。

**执行折叠区切分规则（2026-09-21，已被 segments 模型取代，见下条）：** 初版修复是"折叠区只放 tool+thinking，text/error 全在折叠区外"——但用户随即指出这仍破坏时间顺序（工具调用和中间结论没有先后关系）。

**聊天输出改为时间顺序分段（2026-09-21，最终形态）：** 用户要求完全和 ZCode 一样：任务进行中按顺序输出过程，中间结论之后的工具调用要显示在结论之后，结束后过程折叠、最终结果可见。`execution.ts` 的 `executionTurns` 现产出 `segments: ChatSegment[]`（kind 'steps'|'text' 按时间顺序）——**一条文本结论会切断当前执行组，其后的工具开新组**；`steps`/`answer` 保留为派生兼容字段。ChatView 回合渲染按 segments 顺序：ExecutionGroup 加 `parts`/`showElapsed` 参数（running=最后回合最后一段才展开；非运行的最后一段显示"用时 X"，其余组显示"执行过程 · N 步"）；文本片段始终可见。pi-execution.test.ts 有顺序语义测试锁定（工具→结论→工具→最终文本 = 四段）。教训：转写类 UI 的时间顺序是硬需求，分组聚合会破坏它。

**测试基线最新：** 207 通过/219（2026-09-21，含模型配置写入 7 条新测试），仍持续漂移。 ①SessionRow 支持 `onContextMenu` 弹操作菜单（位置随鼠标、屏幕边界收敛；"⋯"按钮打开同一菜单）。菜单只放有真实能力的项：重命名任务/归档任务/在 Finder 中打开（新 `LocalPiApi.revealPath(path)` IPC → `shell.showItemInFolder`）/复制路径(cwd)/复制日志路径(会话 .jsonl)/复制会话 ID；ZCode 有但我们无数据支撑的（置顶/未读/分屏/调用轨迹）**不放假入口**。`SessionNavItem` 契约补了 `cwd`/`path` 字段（buildPiSidebar 从 pi 会话带出）。②会话运行中行首显示旋转加载圈（`.pi-sidebar__spinner`，纯 CSS 旋转边框圆环 + `@keyframes pi-sidebar-spin`），替代原静态 circle 图标；busy 判定扩展为 running+starting。Icons.tsx 新增 `copy` 图标。

**模型配置可编辑、双向共享（2026-09-21，重要架构升级）：** 用户明确要求 Desktop 直接改 pi 的模型配置文件（"两边共享配置，desktop 支持配置去修改pi的模型配置文件就好了"）——之前的"Desktop 只读、修改去 CLI"边界被用户推翻。实现：`model-catalog.ts` 新增三个原子写入（tmp+rename）：`writeDefaultModel`（settings.json 只动 defaultProvider/defaultModel，其他字段保留）、`writeModelProvider`（models.json 增改提供商；**更新时 apiKey 留空=保留已存密钥**，文件 0600）、`removeModelProvider`（只删 models.json 条目，auth/oauth 不碰）。经 `modelDefaultSave/modelProviderSave/modelProviderRemove`（host→IPC→preload）暴露，全部返回刷新后的 catalog。UI（ModelCatalogSection 重写）：默认模型下拉选择器（按提供商 optgroup 分组）、提供商卡片编辑/删除按钮（仅 source==='models.json'）、添加提供商表单（模型列表每行 `ID | 名称 | 上下文k | 推理y`，宽松解析）。OAuth 提供商仍只读（凭据归 pi login）。校验失败拒绝写入且原文件不动。教训：**"只读边界"不是永久约束，用户要共享配置时就写同一份文件**——但密钥仍不回显到前端（编辑表单 key 留空保持语义）；写含密钥文件必须 0600+原子写。测试新增写入链路 7 条（settings 合并/密钥保留/非法草稿拒绝/删除范围）。

**数据统计页（2026-09-21 新增）：** 用户要求把 ZCode 设置页的数据统计功能搬过来。`src/main/pi/usage-stats.ts` 的 `computeUsageStats(sessions)` 直接遍历 pi 会话 .jsonl，从每条 assistant 消息自带的 `usage`（input/output/cacheRead/cacheWrite/totalTokens + cost.total）和 model/provider/timestamp 聚合——与 CLI 同一数据源，Desktop 不记账、无外发。`UsageStatsService` 60s 缓存；经 `LocalPiApi.usageStats()` 暴露。UI：`UsagePane.tsx`（设置→工作区→数据统计，新 SettingsNavId 'usage'）：汇总卡片（会话/用户消息/模型调用/总Tokens/总费用）、token 细分、近 14 天 CSS 柱状图、按模型表、按项目表（费用全 0 时自动隐藏费用列）。实测真实数据：121 会话、7721 次调用、5.08 亿 tokens、$79.78。

**验证技巧教训（2026-09-21）：** ①多分区设置导航里 `.pi-settings__navitem:nth-of-type(14)` 不起作用——nth-of-type 按各自父节点计数，后面的项匹配不到；应点击目标分区内的序号（如 `.pi-settings__section:nth-of-type(3) .pi-settings__navitem:nth-of-type(5)`）或用独立 electron 探针按文本找按钮。②独立 electron 探针脚本（`electron /tmp/xxx.mjs` 加载 dist/preload）**测不了 IPC handler**——没有真主进程注册 handler，invoke 必报 "No handler registered"；IPC 全链路只能起真应用走 PI_SMOKE=2 验证。③smoke 的 innerText 快照已放宽到 1400 字符（原 250 截断看不全面板内容）。④并行 Codex 会话在同一文件留下过重复的流式限流实现和损坏的 JSX（`onJumpToMessage={noop}>` 后跟 `/>`），遇到 typecheck 突然爆出不属于自己改动的错误，先看是否并行编辑半成品，做最小修复不要大动。

**测试基线最新：** 211 通过/3 跳过（2026-09-21）。并行会话已开始做 'automations' 视图（PiReplicaApp 出现新 view 分支与 AutomationsPage），ChatView 契约新增 `queue`/`onOpenToolFile` 等 props，改动 ChatView/adapter 前先重读文件。

**vitest worker OOM 排查法（2026-09-21）：** 套件曾报 "Worker exited unexpectedly / heap out of memory" 但表面 211 passed——实际 bot-transports 的 9 个测试全丢。定位法：每个测试文件单独用 `NODE_OPTIONS=--max-old-space-size=512` 跑，自己就能爆的就是泄漏源。根因：mock 的 Telegram getUpdates 瞬间返回空数组（真实长轮询会挂起 50s），`while(!stopped)` 微任务空转 200 万次把堆撑爆——**mock 长轮询必须加 sleep 模拟阻塞**。同文件还掩盖两个真 bug：①ESM 下 `import WebSocket from 'ws'` 默认导出不带 `.Server`，要用命名导出 `WebSocketServer`；②dingtalk-stream 的 `message` 监听挂在 `await open` 之后，握手响应与数据帧同 TCP 包到达时帧被同步丢弃——监听从 `new WebSocket` 后立即挂上。教训：测试套件"通过"但 worker 崩溃时，崩溃文件的结果会被静默吞掉，先看 Errors 计数。

**追问队列可操作化（2026-09-21）：** 用户要求队列行加"立即/编辑/删除"（ZCode 样式）。pi RPC 只有整体 `clear_queue` 无单条操作——后端 `backend.queueEdit(key, op)`（op: remove/edit/now + index）实现为"清空 + 按需重排剩余项"，'now' 把目标条目以 steer 注入当前运行；权威状态仍由 pi 的 queue_update 回刷，adapter 侧做乐观更新。UI：ChatView 的 QueueRow 卡片行（拖拽柄 grip 图标 + 单行截断文本 + ↑立即/铅笔/垃圾桶按钮），编辑为行内 input（Enter 存/Esc 取消/失焦存），自动保留 `\n\n用户选择的上下文` 后缀。Icons.tsx 新增 grip/arrow-up。接线链：shared PiQueueOp → main/index.ts handle('queueEdit') → preload → adapter queueEdit action → Composer props onQueueNow/Edit/Remove（demo 无回调时按钮不渲染）。fake-pi.mjs 的 clear_queue 已修正为忠实语义（只清队列+广播空 queue_update，不动 streaming）。

**变更列表计入未跟踪文件（2026-09-21）：** 用户发现同一项目 pi-desktop 变更页只有 2 个文件而参照应用有 24 个——根因：本仓库除 .gitignore/README.md 外 222 个文件全是未跟踪状态，`git diff HEAD` 天然不含未跟踪文件，主进程查出的 untracked 路径被渲染层丢弃。修复：workspace-review.ts 新增 `untrackedFiles: {path, lines}[]`（逐文件读内容计行数，跳过二进制/>512KiB/>300 条），PiReview 契约加可选字段；adapter 新增 `reviewDiffEntries(review)` 把未跟踪合并为 created 条目（+N 行数、按路径去重）。教训：对比"同一列表两边数量不同"先查数据源口径（tracked-only vs 含 untracked）。

**工作指示器去重（2026-09-21）：** 底部转圈行不再显示"已工作 X 分"（与执行过程摘要行的计时重复），只留 spinner + "N 已排队"（有排队时）+ 光标。

**运行中切换模型/思考等级——待生效队列（2026-09-21，重要架构模式）：** 用户要求运行中也能切换，且"到下次模型调用开始之后正式切换"。关键事实：pi 的 `set_model` 会**立即**改写 agent 状态并顺带按新模型重置思考等级（直接下发会导致 UI 提前显示已切换+思考等级被悄悄改）。实现：`PiRun` 加 `pendingModel`/`pendingThinking`，backend 的 model()/thinking() 在 running/starting 时只挂起（校验仍当场做，无效值立即报错）；在边界统一下发——assistant `message_end`（一次模型调用刚结束、下一次未开始，同时兼顾真实流式中的下一次调用）或 `agent_settled`（收尾后直接应用）。下发顺序 model 先 thinking 后（set_model 会重置思考，用户选择要赢）。渲染层放开了 modelDisabled/ThinkingMenu 的运行中禁用，待生效时模型胶囊与思考下拉显示"待生效"小标签（ComposerLabels.pendingSwitch）。fake-pi 补了 set_thinking_level、get_available_thinking_levels（applyModel 依赖）、`/boundary`（发 assistant message_end 且保持 streaming）。教训：**对"立即改内部状态"的第三方 RPC，桌面端按语义边界做延迟下发层**。

**上下文占用圆环对齐 ZCode（2026-09-21）：** 用户红框指出 ZCode 工具栏模型胶囊左侧有个圆环。已有 ContextUsageChip（圆环+%，warn≥80%/danger≥95%）但位置错（leftSlot 访问模式旁）且只在 agent_settled 后才有数据。现改为 ComposerProps 新增 `statusSlot`（渲染在 pi-composer__right、模型胶囊之前），chip 用 compact 模式（只圆环，tooltip 显示 tokens 数）；数据刷新三处：connect 完成后、message_end 边界、agent_settled。真实 pi `get_session_stats` 本就返回 `contextUsage`，之前只是没在恰当时机拉。

**加粗"正在思考"指示（2026-09-21）：** ExecutionGroup 摘要行在 running 且最新 part 是 thinking 时显示加粗「正在思考」（`.pi-execution__thinking`，600 字重），开始出文本/工具自动消失，下轮推理再出现。判定就是 `parts.at(-1)?.kind === 'thinking'`，无需新事件。

**消息导航条悬浮摘要（2026-09-21，最终形态）：** 用户报悬浮提示全是固定文案。复现排查（拿真实会话 JSONL 走 historyToMessages+executionTurns 链路打印标签）发现标签本身各不相同——观感"固定"的真实原因：①悬浮摘要取回合**第一条**文本=开场白（"我来看下…"），加上会话里大量重复「继续/jixu」提问，多个刻度看起来一样；②此前"提问"和"执行"各占一刻度。最终：`ChatView.railEntries()` 一个刻度=一轮问答（用户回合+随后的执行回合合并），悬浮两行=你的提问（小字）+ 该组**最后一段**正式回答即结论（60 字符，重复「继续」也能区分）；无文本回退"N 步工具调用"；会话开头无提问的助手内容（分支摘要）独立刻度。tests/rail-entries.test.ts 锁定"重复提问摘要必须不同"。

**用真实 pi 会话数据复现渲染层逻辑（2026-09-21）：** 怀疑"界面上都一样"类问题时，别猜数据形状——直接拿 `~/.pi/agent/sessions/desktop/*.jsonl` 喂真实转换链验证。`node --experimental-strip-types` 会因源码的无扩展名相对导入失败；可行做法是写临时 vitest 测试（tests/tmp-*.test.ts，`SESSION_FILE=... pnpm vitest run`），跑完删除。
