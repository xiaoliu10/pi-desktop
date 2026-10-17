# PI Desktop

[English](./README.md) | **简体中文**

[![Release](https://img.shields.io/github/v/release/xiaoliu10/pi-desktop?display_name=tag&sort=semver)](https://github.com/xiaoliu10/pi-desktop/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![pi](https://img.shields.io/badge/pi-0.85.1%20to%20%3C1.3.0-4c1)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)

**[pi 编码代理](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)的桌面工作台——过程全程可见，动作逐个确认，掌控权始终在你手里。**

PI Desktop 把本地的 **pi CLI** 装进一个真正的桌面应用：流式对话完整展示代理过程（思考、工具调用、子代理、计划进度），行级变更审查，内置终端，还能用手机远程控制。模型自带——认证留在 pi 内部，前端永不接触。

| 全过程可见的对话 | 手机远程控制 |
| --- | --- |
| ![对话视图](./docs/images/hero-chat.png) | ![远程控制](./docs/images/remote-control.png) |

## 为什么选 PI Desktop

- **过程全部可见。** 思考流式输出、工具调用、子代理活动、计划清单、甚至上下文压缩——代理做的每件事都实时呈现在时间线上，带用时统计和一键复制的代码块。
- **受监督的自治。** 每次文件编辑和命令执行都先询问（仅此一次 / 本会话总是允许 / 拒绝），可按任务切换为自动编辑或完全访问。Review 面板展示相对 Git HEAD 的净变更 diff——绝不把别的会话的改动算作自己的。
- **自愈式运行。** 结算确认丢失、「假运行」卡死——代理 UI 永远转圈的两大经典病因——都被自动检测并恢复，错误直接在会话内渲染，而不是一条死路横幅。
- **不打断心流。** 任务运行中也能编辑已发送的消息（转为排队追问或立即转向）、排队后续输入、随时打断，多个会话跨项目并存。
- **离开电脑也能用。** 扫二维码在局域网内用手机操控当前工作区——看实时对话、审批工具调用、停止任务。或接入 Bot 渠道（钉钉 / 飞书 / Telegram）进行更长时间的会话和群通知。
- **是工作台，不只是聊天框。** 多标签终端（node-pty + xterm）后台保活，计划模式实时清单视图，`@` 文件引用，图片附件，可选语音输入。
- **模型自带。** 供应商配置与认证由 pi 管理：OpenAI、Anthropic、订阅登录，或任意 OpenAI 兼容端点（DeepSeek、Ollama、LM Studio、vLLM、网关）。会话中随时切换模型；语音用独立 ASR 模型。
- **中英双语。** 界面在设置中一键切换，另有明暗主题与字体选择。

## 快速开始

> 前置要求：已在终端安装并验证 [pi CLI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（认证与模型由 pi 自身管理）；源码构建需 Node.js ≥ 20。

从 [Releases](https://github.com/xiaoliu10/pi-desktop/releases/latest) 下载对应平台的安装包：

- macOS（Apple Silicon）：`PI.Desktop-<version>-arm64.dmg`
- Windows：`PI.Desktop.Setup.<version>.exe`

或从源码运行：

```bash
pnpm install
pnpm dev        # Vite HMR + Electron
# 或
pnpm build && pnpm start
```

> 若 `pnpm install` 时未下载 Electron 二进制（pnpm 10+ 默认拦截依赖构建脚本），运行 `pnpm rebuild electron`。

### 首次使用

1. 启动 PI Desktop——已有的 CLI 会话自动出现在左侧，按项目分组。
2. 任意会话只读浏览；点击「在桌面端继续」创建接续副本，CLI 原件保持不动。
3. 新建会话，选择项目信任与工具权限模式，挑选模型，发出第一个任务。

已在 macOS 与 Windows 上对 pi **0.85.1 至 1.3.0（不含）** 完成本地验证，内置运行时为 1.2.0。未知版本保持可读但禁止执行，此时回退使用内置运行时。

## 工作原理

```
┌─────────────── PI Desktop (Electron) ───────────────┐
│  渲染进程    React UI：对话 · 审查 · 终端 ·        │
│             计划 · 插件 · 设置 · 远程               │
├────────────── contextBridge（类型化 IPC）────────────┤
│  主进程      会话发现 · 自愈 RPC 看门狗 ·           │
│             权限 · safeStorage                      │
└──────────────────────┬──────────────────────────────┘
                       │ pi --mode rpc
┌──────────────────────▼──────────────────────────────┐
│  pi CLI：代理循环 · 工具 · 供应商 · 认证            │
│  （会话、模型与技能都留在 pi）                      │
└─────────────────────────────────────────────────────┘
```

PI Desktop 通过 pi 的 RPC 模式驱动本地 pi。CLI 会话从磁盘发现并实时跟随，不做导入也不复制。桌面设置只存路径与界面偏好——API key 与订阅凭证永远不离开 pi。

## 功能一览

- **CLI 会话自动出现**——按 cwd 分组、跟随磁盘历史；接续副本保证原件只读。
- **逐动作工具确认**——专用 pi 扩展实现允许 / 拒绝 / 取消对话框，支持会话级记忆授权；权限模式在输入框随时切换（这是应用层确认，不是操作系统沙箱）。
- **真实审查**——Review 面板聚合会话内文件变更的净 diff（行级），改动一目了然。
- **内置终端**——顶栏开关的多标签终端面板；会话在后台保活。
- **计划模式**——代理执行时计划文档与清单进度实时渲染，支持快照回看与一键「执行计划」。
- **子代理**——本地定义子代理；它们作为独立 pi 会话运行，活动卡片实时嵌入对话。
- **MCP**——stdio 与 Streamable HTTP 服务器向 pi 注册工具，设置界面统一管理。
- **插件与技能市场**——统一页面发现、安装、管理 pi 资源（指令、技能、扩展）。
- **记忆**——经 pi-memory 扩展可选启用长期/项目记忆，设置中可浏览可编辑。
- **去重通知**——队列、转向、结算事件只提醒一次，绝不刷屏。
- **语音输入**——云端 ASR（OpenAI 转写端点或 Chat 多模态网关，404 自动回退），转写只追加到输入框、绝不自动发送。配置细节见[语音输入配置](./docs/voice-input.md)。
- **双语界面与主题**——中英一键切换，明暗主题，字体可选。

## 📅 最近版本变化

<table>
<thead><tr><th>版本</th><th>发布内容</th></tr></thead>
<tbody>
<tr><td><strong>0.1.27</strong></td><td><ul><li><strong>打字卡顿根治（大会话）</strong>：0.1.26 修的是主进程，这次修渲染侧——万条消息的会话每 150ms 的重算从 259ms 降到 10ms（22 倍）。</li><li><strong>侧栏菊花覆盖子代理</strong>：主任务结束了但子代理还在跑，运行中标识继续转，不再误判任务已完成。</li><li><strong>子代理进度不再丢</strong>：子代理调用超过 32 个时老的工作流卡片曾静默丢失（无进度无转录），已修。</li><li><strong>插件「编辑源码」能打开了</strong>：修好资源编号不一致；读取失败时保留窗口显示原因 + 重试，不再一闪就消失。</li><li><strong>钉钉通知能收到了</strong>：任务通知需要单独填群机器人 Webhook——配置页重做成分组卡片式，缺项时明确警告。</li><li><strong>副驾看得懂主会话</strong>：副驾现在收到主对话摘要背景，问「刚才说到哪」不用手动贴上下文；界面与主对话完全对齐。</li><li><strong>四个自研插件内置</strong>：子代理/项目记忆/质量提示词/质量闸门首次启动自动装，CLI 同样生效；已装同名插件时不擅自替换并提示。</li></ul></td></tr>
<tr><td><strong>0.1.26</strong></td><td><ul><li><strong>打字卡顿修复（大会话）</strong>：会话历史改为只解析新增尾部——103.7MB 会话从每次全量重解析 421ms 降到平均 0.18ms，历史读取也不再全扫（热 173ms / 冷 3.5s → 0ms）。</li><li><strong>手机发送不再延迟</strong>：消息先立刻上屏，不再等桌面端确认；失败会撤回并说明原因。</li><li><strong>手机不再一直弹确认框</strong>：过期审批卡修好了「只报错不消失、每点一次再弹一次」的死循环；断线期间漏掉的卡片重连时自动清理。</li><li><strong>手机页面缩放锁定</strong>：不会误触双指缩放，输入框聚焦也不再被 iOS 自动放大。</li><li><strong>手机可编辑重发消息</strong>：已发消息旁新增「编辑」，与桌面端同一套回退重发能力。</li><li><strong>子代理卡片显示任务主题</strong>：从抽象 key 改为实际在做什么；脱敏任务绝不反推。</li><li><strong>子代理标识改为 bot 图标卡片</strong>：撤掉常驻横幅，状态就在对话流里（对齐 ZCode）。</li></ul></td></tr>
<tr><td><strong>0.1.25</strong></td><td><ul><li><strong>切换会话不再弹确认</strong>：子代理提示条照常常驻，切换不被打断；「断开」确认照旧。</li><li><strong>内置 pi 1.3.0</strong>：修复继续会话后子代理工具失效；本机 pi 1.3.x 可直选。</li></ul></td></tr>
<tr><td><strong>0.1.24</strong></td><td><ul><li><strong>子代理可见性</strong>：输入框上方常驻「N 个子代理正在工作」提示，点击开面板；切换/断开会话前先确认，不再误丢后台子代理。</li><li><strong>模型配置即时生效</strong>：保存后运行中会话当场重读配置并回读思考等级；忙碌时等安全空闲再刷，失败不假成功。</li><li><strong>任务计划只取最近一轮</strong>：长期会话不再显示旧任务的计划清单。</li><li><strong>completions 子代理卡片恢复</strong>：第三形态子代理回到卡片，子会话转录可读。</li><li><strong>长会话渲染提速</strong>：labels 模块级缓存，修复流式期间全树重渲染。</li></ul></td></tr>
<tr><td><strong>0.1.23</strong></td><td><ul><li><strong>/skill 只显示你的指令</strong>：技能全文折叠成一行按需展开，编辑重发保留上下文。</li><li><strong>任务清单合成计划文档</strong>：无计划文档时合成整页 Markdown 计划，可复制。</li><li><strong>提示缓存第二断点</strong>：长会话补显式断点提升命中、降成本（Anthropic 系，可关）。</li><li><strong>异步子代理卡片可见</strong>：single 工作流子代理回到卡片并可看子会话转录。</li><li><strong>斜杠候选键盘导航</strong>：↑↓ 循环、Enter 选中恢复；@文件 不丢 @ 前缀。</li></ul></td></tr>
<tr><td><strong>0.1.22</strong></td><td><ul><li><strong>子代理卡片恢复</strong>：新版异步工作流派发的子代理重新出现在右侧卡片并持续刷新状态，主对话空闲不再被误标为中断。</li><li><strong>工作区记忆页对齐集中存储</strong>：存储目录显示真实位置，开关与链路说明改为准确描述。</li></ul></td></tr>
<tr><td><strong>0.1.21</strong></td><td><ul><li><strong>双层记忆兼容</strong>：识别 scoped 插件，摘要与浏览使用集中项目目录，不再创建项目内记忆。</li><li><strong>技能/Goal 长文本折叠</strong>：一行摘要、按需展开，模型上下文保持完整。</li><li><strong>子代理会话隐藏</strong>：新版异步子会话不再混入桌面或手机项目列表。</li><li>pi 兼容窗口与内置版本说明同步。</li></ul></td></tr>
<tr><td><strong>0.1.20</strong></td><td><ul><li><strong>手机端历史懒加载</strong>：进会话只拉最近 50 条，更早历史上滑按需翻页；大会话进会话/切会话/回合结束都秒开。</li><li><strong>技能列表键盘操作</strong>：↑↓ 移动光标、Enter 选中，搜索过滤时高亮重置。</li><li><strong>自动化任务不再重复执行</strong>：忙碌会话排队等待而非另开新会话；修复用户回合结算误判导致的二次执行。</li><li><strong>手机端思考流折叠</strong>：流式一行「思考中…（N 字）」可展开，正文开始自动收起；渲染抖动治理（节流+智能滚底）。</li><li>模型编辑器「会话亲和」卡片上下堆叠，不再超宽。</li></ul></td></tr>
<tr><td><strong>0.1.19</strong></td><td><ul><li><strong>内置 pi 运行时升级 1.1.0 → 1.2.0</strong>：协议面逐一核对（RPC 命令集/事件面/签名无变化），本地 CLI 兼容窗口同步放宽。</li><li><strong>手机端发送截图</strong>：远程页新增图片附件（相册/拍摄，≤10 张），随消息发给模型；连接行显示桌面端版本。</li><li><strong>手机端过滤强化</strong>：归档/已移除项目、子代理与副驾内部会话不再出现在列表、历史与实时事件（含符号链接别名、移除即时生效、回前台刷新）。</li><li><strong>dist 只保留当前版本安装包</strong>：打包后自动清理历史版本产物（prune-dist）。</li></ul></td></tr>
<tr><td><strong>0.1.18</strong></td><td><ul><li><strong>侧栏显示 Desktop 版本号</strong>：底部从单一 pi 版本改为「Desktop 0.1.18 · pi 1.1.0」两段，桌面端版本一目了然。</li><li><strong>手机远控过滤已归档项目</strong>：与桌面侧栏同口径过滤归档会话与已移除项目，归档删除的项目不再出现在手机端。</li><li><strong>模型会话亲和选项可点可见</strong>：三选一从纯文字改为描边卡片，每个选项各自发送的头与用途常显。</li></ul></td></tr>
<tr><td><strong>0.1.17</strong></td><td><ul><li><strong>会话统计三指标</strong>：状态栏新增输出速度（t/s）、缓存命中率、上下文占用一行，模型出字快慢和上下文水位一眼看清（#97）。</li><li><strong>模型会话亲和</strong>：模型编辑器可为供应商配置按会话粘连路由（x-session-id / x-session-affinity），提升提示缓存命中；OpenRouter 自动开启（#98）。</li><li><strong>工作台首页改版</strong>：右侧面板打开即功能选择页（变更/文件/浏览器/辅助对话卡片），新增「辅助对话」tab 与顶栏按钮共享会话（#94）。</li><li><strong>切换会话自动贴底</strong>：修复切换会话后停在最早位置、要手动点「回到最新」的问题（#95）。</li></ul></td></tr>
<tr><td><strong>0.1.16</strong></td><td><ul><li><strong>辅助对话面板</strong>：主对话旁的独立辅助对话——只读、独立历史，不打扰不污染主会话上下文；关闭面板对话保留，待确认亮角标（#86）。</li><li><strong>应用内更新</strong>：自动检查新版本，侧栏亮绿色下载标；点一下自动下载换包重启（sha256 校验 + 失败回滚）（#84/#85）。</li></ul></td></tr>
<tr><td><strong>0.1.15</strong></td><td><ul><li><strong>内置 pi 运行时升级 1.0.4 → 1.1.0</strong>（#81），协议面完全兼容。</li><li><strong>提问/审批卡键盘直达</strong>：↓ 移到「自定义回答」输入行可直接键入，↑/Tab 移回选项，Enter 恰好提交一次；审批卡 Shift+Enter 换行（#82）。</li><li><strong>第三方 ask_user_question 插件共存</strong>：装了 rpiv 等提问插件不再同名冲突崩溃（此前 pi 进程启动即退出、会话打不开、思考等级选不到），第三方提问自动渲染成富问题卡片（#83）。</li></ul></td></tr>
<tr><td><strong>0.1.14</strong></td><td><ul><li><strong>自动化任务默认复用项目会话执行</strong>：任务触发时在项目最近空闲会话里跑，上下文连续、结论出现在原对话；可显式选「独立新会话」（#79）。</li><li><strong>运行中过程整轮折叠</strong>：点击任一「执行过程」组头把整轮工具/思考收成一条汇总，点开恢复逐段视图；过程叙述流式期间按时间线原位可见，不再来回跳变（#80）。</li><li><strong>会话连接上限 6 → 12</strong>：满员自动断开最久空闲会话腾位（历史无损，点开即重连），不再直接拒绝（#75）。</li><li><strong>超大会话不再从侧栏消失</strong>：96MB 会话跨过旧 64MiB 上限导致整个会话从列表蒸发；上限提至 512MiB + 超限降级为「元数据可见」（#78）。</li><li><strong>钉钉一键配置修复</strong>（IPC 通道名错配，#49 起即坏）+ `/compact` 摘要截断改可执行中文文案（#77）。</li><li><strong>未发送草稿按会话保留</strong>（文字+图片/文件/附件切换不丢）；↑↓ 历史召回原样还原全部附件（#76）。</li></ul></td></tr>
<tr><td><strong>0.1.13</strong></td><td><ul><li><strong>`desktop_schedule` 定时任务工具</strong>：agent 可创建/管理 Desktop 定时任务（一次性/周期/cron），由 Desktop 调度器在独立会话执行。</li><li><strong>钉钉扫码一键配置</strong>：device flow 自动建应用并回填凭据（#48/#49）；<strong>微信渠道上线</strong>：扫码绑定 + 任务通知推送（Server酱/PushPlus）（#50）。</li><li><strong>手机远程页改版</strong>：ZCode 式项目列表 + 二级对话视图（#47）。</li><li>模型编辑器推理等级改 ZCode 式可编辑 chips（#54）；渲染层黑屏防护（#51）；用户气泡溢出修复（#52）；压缩 token 口径修正（#46）。</li></ul></td></tr>
</tbody>
</table>

> 仅保留最近版本摘要，完整变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 开发

```bash
pnpm install
pnpm dev            # 开发编排（Vite + tsc + Electron）
pnpm typecheck      # 主进程 + 渲染进程
pnpm test           # vitest 单元 + 浏览器测试
pnpm preview:ui     # 纯 Web UI 预览（无 Electron / 模型密钥 / 用户文件）
```

真实进程隔离测试（无外部模型调用）：

```bash
PI_TEST_EXECUTABLE=/opt/homebrew/bin/pi pnpm exec vitest run tests
```

[`docs/`](./docs) 下的开发文档为中文：[RPC 协议基线](./docs/pi-protocol-baseline.md) · [工具权限边界](./docs/pi-permission-boundary.md) · [设置页面实现](./docs/settings-implementation.md) · [Phase 2 交付与验证](./docs/pi-integration-verification.md)。

## 与参考项目的差异

界面形态参考 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)（LGPL-3.0，未复用代码）。该项目以 Electron 配 Rust 宿主核心；PI Desktop 是聚焦 pi CLI 集成的独立纯 Node 实现：Node 主进程承担宿主核心职责，无需 Rust 工具链。

## 参与贡献

欢迎 Issue 与 PR。请先开 Issue 讨论方案；提交前确保 `pnpm typecheck && pnpm test` 通过。

## 致谢

- [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)——本工作台驱动的代理内核
- 产品形态与架构思路参考 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)（LGPL-3.0）；未复用代码
- [Electron](https://www.electronjs.org/) · [React](https://react.dev/) · [Vite](https://vite.dev/) · [zustand](https://zustand.docs.pmnd.rs/) · [react-markdown](https://github.com/remarkjs/react-markdown) · [highlight.js](https://highlightjs.org/)

## 许可证

[Apache License 2.0](./LICENSE) 授权。
