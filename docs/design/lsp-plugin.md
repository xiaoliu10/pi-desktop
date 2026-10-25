# LSP 插件选型：pi-lens vs 自研

> 真实意图：给 pi 会话加语言智能（定义跳转/引用/诊断/符号搜索），弥补 Grep 对同名符号与间接引用的盲区。用户问：用 pi-lens 还是自己写。
> 日期：2026-10-22 · 状态：已决策——**不内置，用户自装**（Desktop 自定义插件机制已覆盖，保持零默认负担）

## 结论（TL;DR）

**用 pi-lens（`pi install npm:pi-lens`），不自研；且不做 Desktop 内置**——Desktop 的自定义插件机制已覆盖安装/管理，内置反而把「资源与行为开关」的默认值问题强加给所有用户。用户自行安装（2026-10-22 决策）。若未来发现 packages-repair 自愈会误删用户自装包，再评估把「用户自装包」纳入保护范围。

## 1. 现状与接入点

- pi 内核（本机 runtime，当前 1.3.0）：扩展通过 packages 机制挂载；`pi install npm:<pkg>` 是官方安装路径
- Desktop 内置包先例：pi-memory（`src/main/index.ts:405-408`：`packageInstall(DEFAULT_MEMORY_SOURCE)` + `packageRegister`，settings 页 + 每次 pi 会话 launch 前自愈补回，见 packages-repair）
- 契约层：`src/shared/pi.ts` 的包管理 IPC；扩展页「Desktop 内置扩展」区块（src/renderer）
- 关键约束：① MCP 63 进程/3GB 的教训——进程膨胀敏感，任何会起 LSP server 池的组件必须默认关；② Desktop 走 RPC 模式跑 pi（非 TUI）

## 2. 外部调研（pi-lens v4.4.4，github.com/apmantza/pi-lens）

### 功能与成熟度（来源：README/docs/源码）
- 47 个语言服务器定义、45+ runner、35+ 文件类型；LSP 诊断/导航 + ast-grep/tree-sitter 结构规则 + `symbol_search` 词索引 + 影响级联 + 诊断分诊（false-positive/suppress/defer）+ read-guard/git-guard + `/lens-map` 依赖图 + MCP server（实验）
- 工程：MIT、2026-03 起活跃（modified 2026-10-19）、周下载 11,436 / 月 88,751、certified host 清单、stryker 变异测试
- 依赖：`vscode-jsonrpc`、`@ast-grep/cli|napi`，要求 node ≥22.19、pi ≥0.86.1（Desktop 当前 pi 1.3.0 ✓）

### 资源画像（docs/dependencies.md）
- **40+ 外部工具全自动安装**，按 gate 分级：config-gated（项目表明在用才装）/ flow-language-gated / prewarm / GitHub release（装到 `~/.pi-lens/bin/`）；pip 走 pipx→私有 venv→user 前缀，绝不碰系统 prefix
- LSP client 池有**空闲驱逐**（docs/lsp-idle-eviction.md）+ breaker 降级台账（/lens-health）
- 风险仍在：一个 TS 项目至少拉 typescript-language-server + tsc + biome/prettier + ast-grep + knip + jscpd + madge——**必须默认不启用，由用户显式开启**

### Desktop（RPC 模式）兼容性（clients/extension-mode.ts:1-60）
- pi-lens 一等公民感知运行模式：`rpc` 下**不挂 TUI widget**（只 tui 挂），但 `hasUI:true`（对话框走协议）、`ui.notify` 开启、**agent 工具与 turn-end findings 注入全部工作**
- 上游 #478（planned，schema 已定）：`pilens:rpc:*` 请求/响应 + `PilensDiagnosticsPayload` 推送——Desktop 未来可在 RPC 事件流接诊断展示，本次不做

### 自研对比
- 最小可用（TS/Python 双语言、definition/references/diagnostics 工具）≈ 1500-2500 行 + server 生命周期管理 + 测试；到 pi-lens 鲁棒度（多语言定义/驱逐/breaker/新鲜度门控）是人月级
- 自研唯一优势是「轻」；pi-lens 的 gate + 驱逐机制已覆盖该诉求 → 不自研 LSP 本体

### 反面证据
- read-guard/git-guard **改变 agent 行为**（未读过就编辑会被拦、findings 未决时压住 commit/push）——这是行为干预不只是加工具；有 config deny/策略开关，Desktop 集成时必须在设置页暴露
- npm v12 下 `@ast-grep/cli` postinstall 需要批准（allowScripts 已声明）——Desktop 的包安装流程要处理

## 3. 落地设计（推荐方案）

1. **settings → 插件/扩展页**新增「pi-lens（代码智能）」卡片：一键安装/卸载 + 启用开关 + 行为开关透传（read-guard、git-guard、auto-format 默认关）
2. 走现有 `packageInstall('npm:pi-lens')` 通道；加入 packages-repair 期望列表（会话 launch 前自愈）；扩展页徽标标「Desktop 可选装」
3. **默认不装**；安装动作显式征询（含磁盘/进程提示：`~/.pi-lens/` 工具缓存、按语言起 server）
4. 不改 RPC 协议；诊断进 Desktop UI 等上游 #478 落地后另立项

## 4. 分阶段

- 第一步（最小切片）：settings 卡片 + 安装/卸载/开关 + 一个「装后在 RPC 会话确认 lsp 工具出现」的探针测试
- 第二步：行为开关透传（pi-lens config deny 列表）+ 设置页提示文案
- 第三步（可选，等上游）：#478 诊断推送接到 Desktop 侧栏

## 5. 盲区与待拍板

- read-guard 默认开还是关：影响 agent 编辑行为，需用户拍板（建议默认关，与 pi 原生行为一致）
- 「内置可一键装」vs「仅文档推荐」：前者要进 packages-repair 自愈列表，卸载语义要处理好
- pi-lens 升级节奏与 pi host 兼容矩阵的跟随责任在 Desktop（certified hosts 清单需在发版前核对）
