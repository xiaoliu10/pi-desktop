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
<tr><td><strong>0.1.34</strong></td><td><ul><li><strong>启动到会话列表出现从约 7 秒降到约 0.1 秒</strong>：新增持久化的「项目→会话标题」元数据快照（约 290KB），启动先读快照立即显示列表，后台只做文件指纹校验，未变文件不再重新解析；点开具体会话才按需加载完整内容。</li><li><strong>任务结束后计时器不再空转约两分钟</strong>：收到回合结束信号后立即向 pi 核实，确认真空闲就马上停止计时，不再只依赖易丢失的结算事件、干等 120 秒兜底。</li><li><strong>大会话点「更早的消息」补拉后不再被冲回</strong>：活跃会话的后台自动刷新此前会把你刚加载出的更早内容打回最后 500 条，现在会记住已展开的位置，补拉结果不丢、新消息照常追加。</li></ul></td></tr><tr><td><strong>0.1.33</strong></td><td><ul><li><strong>修复 0.1.32 重启后会话点开历史空白</strong>：索引 worker 的启动文件被错误打进了应用归档包，系统无法从归档内启动它，导致所有会话列表/历史读取超时。已改为目录级解包并修正消息通道语义，完整生产链路验证通过。</li></ul></td></tr>
<tr><td><strong>0.1.32</strong></td><td><ul><li><strong>打字/鼠标转圈的架构性根因已消除</strong>：会话索引（目录遍历、会话文件读取解析、搜索、大纲、子代理状态恢复）原先全部同步跑在主线程，目录一大主线程被占住，输入和鼠标就转圈。现在这些工作在独立进程里完成，主进程只保留两份有界镜像。同一台机器、同一份真实数据（367 个会话 / 1.1GB，最大单文件 210MB）实测：冷启动全量扫描仍在，但<strong>主线程最大事件循环延迟从整段阻塞降到 7.5ms</strong>；读最大会话一屏历史 14ms；200 次侧栏元数据同步读合计 1ms。</li><li><strong>每次 IPC 调用把业务干了两遍（自 0.1.30 起）</strong>：统一入口原先「先执行业务 → 再校验来源 → 校验通过后又执行一次」，合法的同步调用全部双跑（主进程开销直接翻倍，写操作也可能落地两次），而慢调用计时只覆盖第一次、日志看不出真实耗时。现在授权在任何业务执行前完成，业务严格只跑一次，四种返回语义原样保留。</li><li><strong>来源校验可被异步调用绕过（自 0.1.30 起）</strong>：旧入口对返回 Promise 的 handler 提前返回，永远走不到校验行，非主窗口来源的异步调用照样能拿到结果并产生副作用。现在非法来源一律在执行前拒绝，业务零执行。</li><li><strong>外部会话点进去不再停在旧内容</strong>：在终端里开始、之后在 Desktop 续聊过的会话有两份文件，此前只有「发送」会切到新副本，「打开」仍读原始快照——每次点进来都停在断开时的位置，上下翻页也拿不到后续内容。现在打开时就按同一套只读规则读最新副本或链尾，直接展示已有内容：不启动模型、不发消息、不改写会话文件。连接中的会话编辑重发后，历史读实际延续文件，发送后不会跳回旧快照；草稿不丢，双方都有未发送内容时合并保留。</li><li><strong>子代理详情「已工作 / 用时」恢复显示</strong>：0.1.31 修「已工作 49 万小时」时把时间戳整个留空，计时条随之消失。现在用主进程快照里的真实开始/结束时刻补齐：运行中显示「已工作」，已结束显示「用时」；拿不到合法时间仍不计时，绝不拿版本号或当前时间编造。</li><li><strong>子代理计时不再虚高或缺失</strong>：工作流会把父任务整体起点冒充每个子任务起点（兄弟任务各差数十秒）；孤儿终态任务丢失「用时」。现在每个子任务只用自己通过校验的时钟，普通异步卡片也能拿到真实起点。</li><li><strong>会话索引重复解析减少</strong>：会话目录里非 pi 的 .jsonl 内容未变时不再反复读取解析（实测热扫 449ms → 45ms）。</li></ul></td></tr>
<tr><td><strong>0.1.31</strong></td><td><ul><li><strong>聊天图片裂图与灯箱下载修好</strong>：blob URL 时代 CSP 只放行显示未放行读取——附件图片全部裂图、下载保存框都不弹，两条链路已恢复（只限渲染进程自建的内存 blob，不开放网络出口）。</li><li><strong>子代理「已工作 49 万小时」修好</strong>：计时只用消息真实时间戳，没有时间就不显示。</li><li><strong>子代理运行中能实时看执行过程</strong>：不再显示「转录不可用」，读取失败保留已显示记录。</li><li><strong>项目行不再跟着会话转</strong>：运行标识回归会话级，项目行只保留文件夹图标。</li><li><strong>启动台不再出现两个「PI Desktop」</strong>：打包中间产物自动兜底清理。</li><li><strong>大会话刷新更轻</strong>：历史响应不再重复携带界面不显示的工具图片 base64（实测 IPC 48–57ms → 约 1ms）。</li></ul></td></tr>
<tr><td><strong>0.1.30</strong></td><td><ul><li><strong>后台子代理不再误显“任务结束”</strong>：主任务等待子代理时会话行继续显示运行标识，项目折叠后项目行也保留提示，完成后自动消失。</li><li><strong>子代理轮询 CPU 尖峰/打字卡修复</strong>：每次轮询对每个 pinned 子代理重扫整条会话，117MB/3.2 万条会话实测 287ms/拍，改为一次扫描后 4ms。</li><li><strong>关闭所有窗口后重开不再丢失子代理进度提示</strong>。</li></ul></td></tr>
<tr><td><strong>0.1.29</strong></td><td><ul><li><strong>打字卡顿六层根治</strong>：实测打字延迟 p50 从 241ms 降到 29ms，流式期间主进程 CPU 从 100% 回到个位数（埋点驱动逐层定位）</li><li><strong>大会话内全文搜索 + 会话地图</strong>：顶栏搜索新增「会话内」结果区，点击命中直接跳转；侧栏新入口按轮次导航长会话</li><li><strong>钉钉机器人修复</strong>：启动竞态导致「配好了但完全没反应」，现失败自动重试 + 全程日志落盘（~/Library/Logs/PI Desktop/im-bot.log）</li><li><strong>任务清单修复</strong>：长任务的清单不再因渲染窗口裁剪消失，模型建清单引导强化</li><li><strong>内置 subagent 下线</strong>：子代理能力完全由你自装的扩展提供，设置页改为状态展示</li></ul></td></tr>
<tr><td><strong>0.1.28</strong></td><td><ul><li><strong>侧栏幽灵「正在运行」修好</strong>：子代理全跑完后计数会归零，死掉的子代理不再让会话永远显示运行中。</li><li><strong>工作流卡片不再假活</strong>：长会话里早已结束的工作流不再永远显示「运行中 · 等待工作流报告子任务」。</li><li><strong>大会话打字不卡了</strong>：折叠起来的工具/思考段不再白建（实测 HTML 体积 -39%），流式文本按块更新。</li><li><strong>大会话打开不再吃满 CPU</strong>：只传尾部一屏、按需补拉——主进程 CPU 从 99% 降到 14%，传输量 -73%。</li><li><strong>大会话图片内存下降</strong>：不再每次渲染重拼 base64（195MB 图片会话的 GC 压力大降）。</li><li><strong>任务清单所有模式都能建</strong>：不再限计划模式——任何访问模式都可创建/更新清单，侧栏「进程」实时显示。</li><li><strong>插件「编辑源码」一闪消失</strong>修好（读失败保留窗口显示原因 + 重试）。</li></ul></td></tr>
<tr><td><strong>0.1.27</strong></td><td><ul><li><strong>打字卡顿根治（大会话）</strong>：0.1.26 修的是主进程，这次修渲染侧——万条消息的会话每 150ms 的重算从 259ms 降到 10ms（22 倍）。</li><li><strong>侧栏菊花覆盖子代理</strong>：主任务结束了但子代理还在跑，运行中标识继续转，不再误判任务已完成。</li><li><strong>子代理进度不再丢</strong>：子代理调用超过 32 个时老的工作流卡片曾静默丢失（无进度无转录），已修。</li><li><strong>插件「编辑源码」能打开了</strong>：修好资源编号不一致；读取失败时保留窗口显示原因 + 重试，不再一闪就消失。</li><li><strong>钉钉通知能收到了</strong>：任务通知需要单独填群机器人 Webhook——配置页重做成分组卡片式，缺项时明确警告。</li><li><strong>副驾看得懂主会话</strong>：副驾现在收到主对话摘要背景，问「刚才说到哪」不用手动贴上下文；界面与主对话完全对齐。</li><li><strong>四个自研插件内置</strong>：子代理/项目记忆/质量提示词/质量闸门首次启动自动装，CLI 同样生效；已装同名插件时不擅自替换并提示。</li></ul></td></tr>
<tr><td><strong>0.1.26</strong></td><td><ul><li><strong>打字卡顿修复（大会话）</strong>：会话历史改为只解析新增尾部——103.7MB 会话从每次全量重解析 421ms 降到平均 0.18ms，历史读取也不再全扫（热 173ms / 冷 3.5s → 0ms）。</li><li><strong>手机发送不再延迟</strong>：消息先立刻上屏，不再等桌面端确认；失败会撤回并说明原因。</li><li><strong>手机不再一直弹确认框</strong>：过期审批卡修好了「只报错不消失、每点一次再弹一次」的死循环；断线期间漏掉的卡片重连时自动清理。</li><li><strong>手机页面缩放锁定</strong>：不会误触双指缩放，输入框聚焦也不再被 iOS 自动放大。</li><li><strong>手机可编辑重发消息</strong>：已发消息旁新增「编辑」，与桌面端同一套回退重发能力。</li><li><strong>子代理卡片显示任务主题</strong>：从抽象 key 改为实际在做什么；脱敏任务绝不反推。</li><li><strong>子代理标识改为 bot 图标卡片</strong>：撤掉常驻横幅，状态就在对话流里（对齐 ZCode）。</li></ul></td></tr>
<tr><td><strong>0.1.24</strong></td><td><ul><li><strong>子代理可见性</strong>：输入框上方常驻「N 个子代理正在工作」提示，点击开面板；切换/断开会话前先确认，不再误丢后台子代理。</li><li><strong>模型配置即时生效</strong>：保存后运行中会话当场重读配置并回读思考等级；忙碌时等安全空闲再刷，失败不假成功。</li><li><strong>任务计划只取最近一轮</strong>：长期会话不再显示旧任务的计划清单。</li><li><strong>completions 子代理卡片恢复</strong>：第三形态子代理回到卡片，子会话转录可读。</li><li><strong>长会话渲染提速</strong>：labels 模块级缓存，修复流式期间全树重渲染。</li></ul></td></tr>
<tr><td><strong>0.1.23</strong></td><td><ul><li><strong>/skill 只显示你的指令</strong>：技能全文折叠成一行按需展开，编辑重发保留上下文。</li><li><strong>任务清单合成计划文档</strong>：无计划文档时合成整页 Markdown 计划，可复制。</li><li><strong>提示缓存第二断点</strong>：长会话补显式断点提升命中、降成本（Anthropic 系，可关）。</li><li><strong>异步子代理卡片可见</strong>：single 工作流子代理回到卡片并可看子会话转录。</li><li><strong>斜杠候选键盘导航</strong>：↑↓ 循环、Enter 选中恢复；@文件 不丢 @ 前缀。</li></ul></td></tr>
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
