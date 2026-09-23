# PI Desktop 任务领取板：先复刻 UI，再接入 pi

修订：2026-09-20。UI 任务由用户委派 Agent 领取；用户已另行要求 Codex 实现第二阶段。**旧 A01～A10 已全部撤销，不得继续自研 Agent 循环或 Provider。** 历史任务见 [归档](./legacy-agent-task-board.md)。

当前依据：

- [UI 复刻规格](./ui-replica-spec.md)：首阶段交付，以参考项目的页面与交互为准。
- [本地 pi 内核流程](./coding-agent-workflow.md)：第二阶段交付，共享本地配置、资源和会话。

## 1. 领取规则

1. 阅读两份规格与本任务卡，只领取前置依赖已经完成的任务。
2. 由协调者确认负责人，再更新状态。共享 Markdown 不提供原子锁，同时领取由协调者裁定。
3. **你不是唯一在代码库工作的 Agent。保留其他人的改动，不要覆盖、回退或清理无关文件。** 当前仓库已有大量未提交实现，不得把所有未跟踪文件都视作自己的新增内容。
4. 修改范围以任务卡为准；跨范围改动先报告文件和原因，由协调者安排交接。
5. 公共入口和共享类型由专门任务负责，页面 Agent 使用独立组件和局部样式，避免同时修改 App.tsx、store.ts 和全局 CSS。
6. 完成后提供修改文件、测试结果、可复现步骤、截图（UI 任务）、已知限制，状态设为待验收；协调者验收后设为完成。
7. 本轮 UI 任务不得调用真实模型、读写用户认证、安装插件或改变本地 pi 配置；演示数据必须明确标记。
8. 未获用户要求不提交、推送、发布；此限制不影响必要的本地构建与验证。

状态：待领取 → 进行中 → 待验收 → 完成；无法继续时为阻塞。任何任务不得因“代码写完”直接跳过验收。

## 2. 第一阶段：UI 复刻

| ID | 任务 | 前置依赖 | 状态 | 负责人 |
| --- | --- | --- | --- | --- |
| U01 | 参考基线、设计变量、预览契约与入口 | 无 | 待验收 | ZCode（主会话，经用户指派） |
| U02 | 应用外壳、侧栏、项目和会话导航 | U01 | 待验收 | ZCode（主会话，经用户指派） |
| U03 | 首页、输入器、对话与工具卡 | U01 | 待验收 | ZCode（主会话，经用户指派） |
| U04 | 插件列表、市场预览与资源详情 | U01 | 待验收 | ZCode（主会话，经用户指派） |
| U05 | 全页面设置与模型配置预览 | U01 | 待验收 | ZCode（主会话，经用户指派） |
| U06 | 右侧工作面板、搜索和通知 | U01 | 待验收 | ZCode（主会话，经用户指派） |
| U07 | 页面集成、交互与视觉对照验收 | U02～U06 | 待验收 | ZCode（主会话，经用户指派） |

第一阶段已于 2026-09-20 由同一会话顺序完成 U01～U07：启动 `pnpm preview:ui` → `http://127.0.0.1:5174/?preview=1`；验收材料见 `docs/ui-replica-verification.md`（复现步骤、截图清单、检查结果与已知差异）与 `docs/ui-reference-baseline.md`。等待用户查看后再进入 pi 接入阶段。

先委派 U01；完成后 U02～U06 可按 Agent 数量分批并行。U07 完成并经用户查看后再进入 pi 接入阶段。

### U01：参考基线、设计变量、预览契约与入口

**负责文件：** 新增 `src/renderer/replica/tokens.css`、`src/renderer/replica/Icons.tsx`、`src/renderer/replica/contracts.ts`、`src/renderer/preview/fixtures.ts`、`src/renderer/preview/PreviewApp.tsx`；可改 `src/renderer/main.tsx`、`package.json`，维护 `docs/ui-reference-baseline.md`。

**工作：**

- 查看规格中的参考图，记录日期、可得的提交版本、截图视口和已观察页面，建立一致基线。
- 提取中性色、字重、间距、圆角、侧栏/输入器/面板尺寸变量，以及统一线性图标。
- 冻结页面 props 和事件契约：导航、会话、消息、模型、资源、工作面板、设置、演示状态；为消费者提供样例。
- 建立显式预览入口（建议 `?preview=1`）与清晰“界面预览”标记。预览不调用 window.pi；普通入口不静默退回假数据。
- 创建独立英文/中文演示数据和重置机制，包含空状态、长会话、工具输出、插件不同状态。
- 预览使用独立样式作用域，不能破坏旧原型；不要导入未完成的下游组件导致无法构建。

**验收：** 可单独启动预览、看到基础外壳；无 Key、无 Electron bridge 也可打开；网络与代码检查证明不访问真实模型和用户文件。类型检查通过，提供所有下游需要的契约说明。

### U02：外壳、侧栏、项目和会话导航

**负责文件：** 新增 `src/renderer/replica/shell/` 和 `src/renderer/preview/shell.test.ts`。不改 PreviewApp、全局 CSS 或 shared 类型。

**工作：**

- 复刻折叠按钮、Sessions/Projects 分组、选中会话、项目展开、底部设置/插件/通知入口和版本位置。
- 主区顶部包含标题、新会话、搜索和工作面板入口。
- 以 props 控制导航与选中态，回调交给预览容器处理，不直接访问旧 store。
- 处理长标题、空项目、侧栏收起、窄窗口以及 macOS 原生标题栏安全区域。

**验收：** 与首页截图对照；导航、折叠和切换回调正确；键盘和可访问名称齐全；三个规定视口无溢出。交付组件截图和集成示例。

### U03：首页、输入器、对话与工具卡

**负责文件：** 新增 `src/renderer/replica/chat/`、`src/renderer/preview/chat.test.ts`。

**工作：**

- 复刻留白首页、中心欢迎区域、底部圆角输入器及其完整工具行。
- 模型菜单放输入器内，提供 `/` 命令、`@` 文件选择；菜单读取 U01 契约数据。
- 复刻对话 Markdown、用户消息、可展开工具详情、错误和模拟运行状态。
- 对话导航条可定位消息；发送、停止和队列只是预览回调，不触发真实代理。
- Enter/Shift+Enter/中文输入法、多行高度、空输入禁用与菜单键盘导航可用。
- 所有模式、权限和工具结果明确处于演示环境；未实现附件上传不假装成功。

**验收：** 空状态与长对话均有截图；工具展开、消息定位和选择模型可操作；输入法组合不误发送；不调用旧 AgentRuntime。

### U04：插件列表、市场预览与资源详情

**负责文件：** 新增 `src/renderer/replica/plugins/`、`src/renderer/preview/plugins.test.ts`。

**工作：**

- 查看并复刻 Installed/Marketplace、搜索、更新提示、插件分组行、范围选择和详情展开。
- 状态覆盖需关注、可更新、活跃、关闭、空列表、无匹配结果；示例包和版本明确为演示数据。
- 演示安装、开关和更新仅触发适配层事件，不执行系统命令。
- 组件数据保留来源和资源类型，未来可用 pi packages / extensions 替换。
- 不把参考项目的 .piplug 市场与本地 pi 资源系统混为一谈。

**验收：** 两种标签页、搜索、详情和开关可操作；异常文本和长包名不破坏布局；界面没有冒充本地加载状态。

### U05：全页面设置和模型配置预览

**负责文件：** 新增 `src/renderer/replica/settings/`、`src/renderer/preview/settings.test.ts`。

**工作：**

- 复刻左侧返回/搜索/分组导航，右侧标题和浅灰设置行；采用全页面而非旧居中弹窗。
- 首批包括 General、Models 和扩展相关列表/空状态、Info。
- 主题、语言、字体与字号选择通过事件作用到预览；模型编辑保存到预览数据。
- 代理/认证表单仅为演示，不写真实配置；未实现设置禁用并说明。
- 为后续替换成 pi 模型目录保留受控组件边界。

**验收：** 与 settings-live 和 settings-models 对照；返回、导航、搜索、主题与语言可操作；模型表单校验错误可见；刷新是否保留演示配置有明确说明。

### U06：工作面板、搜索与通知

**负责文件：** 新增 `src/renderer/replica/workbench/`、`src/renderer/replica/overlays/`、`src/renderer/preview/workbench.test.ts`。

**工作：**

- 参考截图实现 Review / Files / Browser 的标签、空状态、开关和宽度适配。
- Review 显示演示 diff，Files 支持选中文件，Browser 使用本地预览或说明性空状态。
- 全局搜索覆盖演示会话、页面、设置项和命令，支持 Cmd/Ctrl+K 与 Escape。
- 通知列表含普通通知和待处理请求，不模拟真实系统任务完成。
- 焦点管理与菜单关闭正常，窄视口面板不挤占全部主区。

**验收：** 面板切换与文件/diff 展示正常；搜索选中可导航；全程没有访问真实文件系统或远程任意页面；键盘操作和焦点恢复可复现。

### U07：集成、视觉对照与第一阶段交付

**负责文件：** `src/renderer/preview/PreviewApp.tsx`、新增 `src/renderer/preview/adapter.ts`；必要时改 `src/renderer/main.tsx`、`package.json`、`scripts/preview-ui.mjs`；维护 README、`docs/ui-replica-verification.md`，可新增 `tests/ui-preview.spec.ts`。下游组件缺陷交回原负责人修正，不直接大改其目录。

**工作：**

- 接入 U02～U06，在统一演示适配层实现导航、选择、发送演示、搜索、主题和资源状态变化。
- 以参考浅色主题完成首页、对话、插件、设置、Review 的截图对照，再验收深色和窄窗口。
- 收集品牌图形、字体、未支持控件等差异，不宣称未测量的像素级一致。
- 保留普通应用入口，不让预览数据进入真实用户存储；提供一条明确的启动命令或链接。
- 跑类型检查、必要交互测试和构建，记录截图路径与复现步骤。

**验收：** 用户可无需模型配置直接浏览完整 UI；主要页面与交互符合规格；1600×1067、1440×900、1024×768 无重大缺陷；没有真实模型/插件执行。UI 完成后交用户查看，再安排第二阶段。

## 3. 第二阶段：本地 pi 接入

用户于 2026-09-20 明确要求执行第二阶段，已提前实现本地 pi 接入。负责人：Codex（本会话）。本次真实工作台使用独立 `src/renderer/pi/`，保留其他 Agent 并行开发的 UI 预览；最终视觉组件融合仍需 U07 验收。实现与验证见 [第二阶段交付](./pi-integration-verification.md)。

| ID | 任务 | 前置依赖 | 状态 | 负责人 |
| --- | --- | --- | --- | --- |
| P01 | pi 安装发现、版本验证和后端契约 | U07 + UI 审阅 | 待验收 | Codex（本会话） |
| P02 | JSONL RPC 传输与进程管理 | P01 | 待验收 | Codex（本会话） |
| P03 | pi 事件到桌面状态的映射 | P02 | 待验收 | Codex（本会话） |
| P04 | 本地资源目录与刷新机制 | P01 | 待验收 | Codex（本会话） |
| P05 | CLI session 自动可见、历史跟随与交接 | P01 | 待验收 | Codex（本会话） |
| P06 | Extension UI 请求桥接 | P03 | 待验收 | Codex（本会话） |
| P07 | 工具权限桥接与模式冲突处理 | P03、P06 | 待验收 | Codex（本会话） |
| P08 | 接入桌面入口和已验收 UI | P04、P05、P07 | 待验收 | Codex（本会话） |
| P09 | 真实工作区 Review | P08 | 待验收 | Codex（本会话） |
| P10 | CLI/桌面联动和插件整体验收 | P09 | 待验收 | Codex（本会话） |

> **P08 增补（2026-09-20，ZCode / 主会话，经用户批准）**：生产入口界面已切换为第一阶段验收的复刻 UI。`src/renderer/App.tsx` 改挂新增的 `src/renderer/pi/PiReplicaApp.tsx` + `adapter.ts`（复刻契约 ↔ `window.localPi` 的映射：会话/历史/流式事件/模型/资源/Review/Extension UI 弹窗/接续副本连接框）；原 `PiDesktop.tsx` 保留不再挂载。pi 后端（P01–P07、P09 的 host/backend/index/review）零改动，仅消费。新增映射测试 `tests/pi-replica-adapter.test.ts`（10 例）。等待与 Codex 会话联合验收。

### P01：安装发现、版本与后端契约

**负责：** 新增 `src/main/pi/environment.ts`、`src/shared/pi.ts`、`tests/pi-environment.test.ts`、`docs/pi-protocol-baseline.md`。经协调可调整 Node/Electron 版本约束。

检测显式路径、PATH、平台候选及 agentDir/sessionDir；基线为本机 0.85.1，支持范围必须明确。冻结 Desktop 自有 PiBackend、资源视图、会话视图和交互事件类型。定义按会话和进程代际路由、模型脱敏信息、启动诊断。不加载插件来冒充静态扫描，不读取认证内容到前端。

**验收：** pi 不存在、路径含空格、未知版本、覆盖配置目录有测试；当前有效安装可识别；记录关键 RPC 和结束语义，给所有后续任务提供假后端。

### P02：RPC 传输与进程管理

**负责：** 新增 `src/main/pi/rpc-client.ts`、`process-manager.ts`、`tests/pi-rpc.test.ts`、`tests/fixtures/fake-pi.mjs`。

参数数组启动，按 LF 分帧，正确处理 UTF-8 跨块、请求关联、异步事件、stderr、超时和进程退出。每个活动会话独立进程；取消和退出清理 pending 请求；不自动重放任务。启动传入正确 cwd 与配置环境，不默认批准所有项目资源。

**验收：** 使用假子进程测试乱序响应、多个事件、断流、非协议输出、大帧限制、Unicode 分隔符、空格路径；退出无悬挂 Promise，失败能诊断。

### P03：事件映射与运行状态

**负责：** 新增 `src/main/pi/backend.ts`、`event-mapper.ts`、`tests/pi-backend.test.ts`。

将 pi 的消息、工具进度、重试、压缩、队列和错误映射为统一界面事件。prompt 接收与完成分开，0.85.1 完成依据 agent_settled；停止清队列再 abort；保留结构化工具结果。不得调用旧自研 Provider，也不另外实现模型循环。

**验收：** 事件回放覆盖工具多轮、重试后完成、队列继续、取消、会话替换；不会收到 agent_end 就错误显示全部完成；单条用户输入仅发送一次。

### P04：本地资源发现与刷新

**负责：** 新增 `src/main/pi/resource-catalog.ts`、`resource-watcher.ts`、`tests/pi-resources.test.ts`、`tests/fixtures/pi-resources/`。

识别全局/项目/显式路径/npm/Git packages 的资源元数据和过滤规则，与 get_commands 等实际证据合并。区分发现、安装、加载未确认、可调用、失败、TUI 不兼容。资源变更标记待刷新，空闲后请求重启，不假定存在 reload_extensions RPC。

**验收：** 用隔离资源树覆盖多来源、禁用/过滤、重复路径、损坏 manifest、无命令扩展和项目不可信；页面只扫描时不执行插件。完整运行态未知必须标为未知。

### P05：CLI session 自动可见、历史跟随与交接

**优先级：** pi 接入阶段的核心用户场景。P01 完成即可启动，不依赖 RPC 传输或真实模型；先交付只读发现与历史展示数据源，再完善写入接续。

**负责：** 新增 `src/main/pi/session-index.ts`、`session-watcher.ts`、`session-access.ts`、`tests/pi-sessions.test.ts`、`tests/fixtures/pi-sessions/`。由 P08 接入 IPC 和页面，避免与其修改公共入口冲突。

**工作：**

- 启动时自动发现 CLI 已有会话，不要求导入、复制或先在 Desktop 添加项目；按会话头 cwd 自动分组。
- 支持默认与配置覆盖的 sessionDir、用户选择的额外目录；显示来源与失效项目目录。
- 监听 CLI 新建及追加，防抖增量更新；低频重扫处理漏报，处理替换、截断、删除和损坏尾行。
- 保留 pi 原生消息、工具结果、分支、压缩与扩展条目；不同分支不得串成一段聊天。
- 浏览是纯只读：不启动第二个代理，不调用会自动迁移写回的 API，不修改源文件。
- 只显示已落盘记录与同步时间；不把磁盘变化等同于逐 token 流式或准确运行状态。
- “在 Desktop 继续”是独立动作。管理 Desktop 内部占用，无法确认外部 CLI 写入者时只读或分叉，不以私有锁宣称全局互斥。

**验收：** 隔离目录内模拟 CLI：既有会话启动可见；Desktop 开着时新会话自动出现；完整记录追加后目标 2 秒内更新；未完整尾行补齐后只出现一次；缺失项目仍能看历史；监听失效重扫可恢复；查看前后源文件字节和修改时间不变，且没有新 pi 进程或模型调用。另测自定义目录、分支和顺序交接。

### P06：Extension UI 桥接

**负责：** 新增 `src/main/pi/extension-ui.ts`、`src/renderer/pi/ExtensionUIHost.tsx`、`src/renderer/pi/extension-ui.css`、`tests/pi-extension-ui.test.ts`。复用 UI 阶段的可用基础控件，不改公共 App。

支持 select/confirm/input/editor 的请求响应，notify/status/widget/title/editor text 的单向更新。按会话+进程代际+请求 ID 路由；处理取消、超时、失效、后台请求和重启清理；安全展示 ANSI 文本。TUI custom 和工厂 widget 明确降级，输入预填不得自动发送。

**验收：** 测试扩展无需模型即可逐项触发 UI；返回值正确；旧弹窗无法回答新进程；通知不乱回包；界面切换不丢后台请求。

### P07：权限桥接与模式冲突处理

**负责：** 新增 `extensions/desktop-policy/`、`src/main/pi/policy.ts`、`tests/pi-policy.test.ts`，维护 `docs/pi-permission-boundary.md`。

基于当前 pi 扩展 API 核实工具调用钩子和阻止行为，再桥接桌面确认。明确内置工具、扩展工具和直接 Node 调用的覆盖差异，未知工具不能未经定义自动放行。项目资源信任独立管理。不让旧 Plan/Goal 状态与用户 plan-mode 重复管理。

**验收：** 内置和测试扩展工具的允许/拒绝/取消可测；直接 Node 行为不被误称受沙箱保护；没有通过验证的权限模式不能显示为已生效。

### P08：接入桌面与替换原型主链路

**负责：** `src/main/index.ts`、`src/main/store.ts`、`src/shared/api.ts`、`src/preload/index.ts`、`src/renderer/App.tsx`、`src/renderer/store.ts`；新增 `src/renderer/pi/adapter.ts`。公共组件如需调整交回原负责人。

将已验收 UI 接上 PiBackend、资源页、会话索引和扩展交互。模型直接来自 pi，认证不复制到前端；旧会话保持只读，旧循环/Provider 不再参与新会话。清晰区分真实模式与演示预览；关闭或隐藏未接通的控件。安装变更、项目切换、版本异常和资源加载问题可诊断。

**验收：** 真实入口与预览入口均可启动；首先验证 CLI 会话无需导入直接可见、历史自动更新，查看不启动代理；使用本地 pi 配置建立会话；本地资源和命令可展示；新消息只经过 pi；不会破坏旧记录或 UI 验收结果。

### P09：真实工作区 Review

**负责：** 新增 `src/main/pi/workspace-review.ts`、`tests/pi-review.test.ts`，调整 `src/renderer/pi/adapter.ts`；需要 IPC 新方法时与 P08 负责人交接后修改。

建立明确的 Git 或文件基线，发现 pi 内置/扩展/命令造成的改动；显示累计净变化、新建/删除和还原，不依赖旧工具 diff。区分已有用户修改与会话修改的归属限制；非 Git、二进制和大文件有策略。

**验收：** 连续编辑两次、还原、命令生成文件可正确展示；不修改或清理用户文件；无法精确归因时准确说明。

### P10：整体联动和插件验收

**负责：** 新增 `tests/pi-integration.test.ts`、`examples/pi-desktop-ui-demo/`、`docs/pi-integration-verification.md`；维护 README 和当前架构状态，必要时修改测试脚本配置。

用临时 agentDir、临时项目和测试扩展验证发现、调用、UI 交互、刷新和会话交接。将本地 plan-mode 作为真实兼容案例，未经测试不得称完整支持。真实模型验收单独记录，不能用预设回复冒充智能结果。最后验证构建、桌面启动、进程清理与 UI 回归。

**验收：** 终端安装一次资源，Desktop 可发现并使用标准交互；配置和会话可顺序联动；TUI 限制可见；测试不污染用户环境；所有验证均记录版本和结果。

## 4. 可直接委派的提示词

```text
请在 /Users/jason/projects/opensource/pi-desktop 中领取 U01。

先阅读 docs/ui-replica-spec.md、docs/coding-agent-workflow.md
和 docs/agent-task-board.md，确认任务未被领取且前置条件满足。
经协调者确认后更新状态与负责人，按任务卡负责文件和验收标准实施。

本阶段先复刻 vastsa/PI-Desktop 的 UI；不要开发旧 A 系列自研内核。
你不是唯一修改代码的 Agent，请保留他人改动，不覆盖、回退无关文件，
不把整个未提交工作区纳入自己的变更。跨负责文件的修改先报告并协调。

UI 预览必须明确使用演示数据，不读取或修改 ~/.pi，
不调用真实模型、不安装插件。完成后提供截图、操作步骤、
测试结果和已知差异，并将任务标为待验收。
不要提交或推送，除非我另行要求。
```

第二阶段委派时替换任务编号及 UI 阶段限制，改为按任务卡仅在隔离目录测试，真实配置接入由用户明确安排。不要把上面的 UI 限制原样作为永久禁止 pi 接入的规则。


## 设置页功能补齐（2026-09-20）

用户要求将所有生产设置占位页实现。Codex 已完成 AI 默认行为、可自定义快捷键、指令/技能/扩展编辑与启停、MCP 配置和工具桥、独立子代理、工作区连接配置、原生会话导入和项目登记。状态：待用户验收。

验证：92 项测试、全量类型检查、生产构建及 Electron 13 页交互 smoke 通过。详见 [设置页实现与验收](./settings-implementation.md)。未改变 UI 任务其他负责人的验收状态。
