# pi 0.99.x 适配方案

> **P0 已落地（2026-09-30）**：版本闸门 0.100.0、桥版本门（PI_DESKTOP_PI_VERSION 注入 + ≥0.99 整体让位）、mcp.json 迁移（mcpMigrate：覆盖层折叠/imports 物化/per-entry enabled/首次备份 .bak-pre099）、ChatView `mcp__server__tool` 展示、mcpSave 原生 enabled 语义（导入分支删除，物化后即普通条目）。
> **1.0.0 增量已落地（2026-10-02）**：闸门放宽到 [0.85.1, 1.1.0)（1.0.0 bundle 拆 chunks 目录，RPC 冒烟 get_state/get_available_models/set_model 与 0.99.x 逐字节同语义）；PR #9 内置运行时 retarget 0.99.1→1.0.0（连带带入 0.99.2：MCP 后台连接不阻塞首条消息、长会话提速、Z.AI CN 超限识别修复）；**generateImages 桌面化**（account-worker `generate` 操作 → `imageGenerate` IPC → 模型菜单「图像生成」区块 → 生图模式直连 ModelRuntime.generateImages，产物为本地时间线卡片不入会话历史；catalog 新增 `imageModels` 字段，mergeModelCatalog 同步到既有 provider；实测 openrouter 报 57 个图像模型）。
> **沙箱实测（pi 0.99.1 RPC + mcp list）**：同一份 mcp.json 被原生读取；未知 per-entry 字段（custom 等）与未知顶层键均容忍不报错；`enabled:false` 条目静默跳过；坏条目经 `extension_ui_request` notify 报告（desktop 可显示）；`pi mcp list` 确认 connected + 工具暴露（mcp__probe__echo）。
> 待办：P1（mcp_servers_change 状态行）、P2（截断提示、codemode 开关、模型目录刷新按钮）。真实生图调用（花额度）未实测，链路以单测+browser 夹具覆盖。

> 调研基准：本机 pi 0.87.0（desktop 当前兼容区间 [0.85.1, 0.90.0)）→ npm 最新 0.99.1（2026-09-29 发布，从 0.87.1 直接跳号到 0.99.0，无中间版本）。
> 调研方法：npm tarball 解包（npmmirror 镜像）+ bundle 源码比对 + CHANGELOG.md 逐条核对 desktop 集成面。

## 一、兼容面结论（源码级 diff）

| 面 | 结论 |
|---|---|
| RPC 命令 | **全部兼容**。desktop 用到的 get_state/get_messages/prompt/steer/follow_up/stop/set_model/compact/get_session_stats/get_commands 等在 0.99.1 全部存在，签名无破坏 |
| RPC 事件 | 核心事件（agent_start/settled、message_*、tool_execution_*、auto_retry_*、queue_update、extension_ui_request）全部保留；**新增 `mcp_servers_change`**（servers 列表变化时 emit，载荷 `{type, servers}`）与 `provider_stream_event`（仅扩展 API，不进 RPC） |
| RPC prompt/steer/follow_up 响应 | 新增 per-input disposition 字段（additive，desktop 现有解析不受影响）；`prompt` 可选 `streamingBehavior` 参数（可后续利用） |
| 工具结果结构 | bash/powershell 结构化结果上限 1MiB，新增 `truncated`、`full_output_path` 字段；空输出从 `(no output)` 改为 `""` |
| 内置扩展命名 | `<inline:name>`/`<builtin:name>` → **`builtin:<name>`**（错误、诊断、RPC source info） |
| 会话文件 | 修复 #10000：首条用户消息发出时才创建会话文件（desktop 自建 owned 文件路径传给 pi，不受影响） |
| 扩展 API | 新增 exposure/namespace/annotations/outputSchema/ctx.executeTool()/registerVirtualModel/registerMcpServer；同工具替换内置扩展会有警告 |
| 内置扩展 | **`builtin:mcp`（原生 MCP）、`builtin:codemode`、`builtin:tool-search` 默认加载**；`--no-extensions` 现在也会禁用它们（desktop 未传该参数，不受影响） |
| 模型目录 | GPT-6.1 Sol、Kimi K3 默认值等 —— 经 pi 自动跟随，desktop 无需改代码 |

## 二、核心冲突：MCP 原生化（方案的主战场）

### 现状
desktop 因为 pi 不支持 MCP，自建了一整套桥：
- `extensions/desktop-policy/mcp-bridge.mjs` + `mcp-client.cjs`：desktop 自己连 MCP 服务器、把工具注册进 pi
- `mcp-imports.cjs`：从 claude-code/cursor/claude-desktop/opencode/codex 配置导入
- `~/.pi/agent/mcp.json`（user）+ `<项目>/.pi/mcp.json`（project）为配置文件，带 `disabledServers`/`enabledServers` 覆盖列表、`imports` 键、per-entry `disabled: true`

### 冲突（已逐一核实）
1. **同一个文件**：desktop 的 user 级 mcp.json 就是 `~/.pi/agent/mcp.json`，project 级就是 `.pi/mcp.json` —— 与 pi 0.99 原生 MCP 读的路径完全一致。
2. **双连接**：升级到 0.99 后 `builtin:mcp` 默认加载，会和 desktop 桥**同时**连同一个服务器、注册两套工具（pi 原生命名 `mcp__<server>__<tool>`，桥是自命名）→ 模型看到重复工具 + 连接数翻倍。
3. **禁用语义失效**：desktop 写 per-entry `disabled: true`；pi 0.99 只认 `enabled: false`（`disabledServers` 顶层键 pi 完全不认识，0 命中）。即 desktop 里"已禁用"的服务器会被 pi 照连。
4. **导入键被忽略**：`imports` 键 pi 不解析（现状由 desktop 桥运行时解析），但不会报错。

### 迁移设计
**连接权交给 pi 原生 MCP（builtin:mcp），desktop 保留配置面与状态面：**

1. **桥条件化退役**：mcp-bridge 仅在 `pi < 0.99` 时注册（兼容区间内旧 CLI 仍无原生 MCP）；≥0.99 时桥不加载、不注册工具。desktop-policy 的权限管控部分不动。
2. **mcp.json 写入改为 pi 原生格式**：
   - 启停从覆盖列表/per-entry `disabled` 改为 **per-entry `enabled: false`**（pi 原生语义）
   - **一次性迁移**：settings-service 快照时若发现 `disabledServers`/`enabledServers` 顶层键 → 折算成 per-entry `enabled` 标志后删除覆盖键（否则 pi 会照连用户已禁用的服务器）；`imports` 键同样**物化**为 mcpServers 里的真实条目（沿用 normalizeServerPaths 解析相对 cwd）后删除
   - 源工具（claude/cursor/codex）原文件依旧只读，不回写
3. **状态面升级**：监听 RPC `mcp_servers_change` 事件 → 设置页 MCP 行加连接状态（已连接/失败/需登录 + 工具数）；「检测连接」按钮保留现有探测实现
4. **工具命名对齐**：UI 层识别 `mcp__<server>__<tool>` 前缀展示为「server / tool」（chat 工具行、workbench）；desktop 桥旧命名仅存在于 <0.99 会话

## 三、版本闸门与环境

- `src/main/pi/environment.ts`：`PI_MAX_TESTED` 从 `'0.90.0'` → `'0.100.0'`（保持"逐版复核"的排他上界模式）。PI_MIN_VERSION 不动（0.85.1–0.98 继续兼容，桥在旧版上照常工作）
- 捆绑 runtime 刷新到 0.99.1（runtime:prepare 快照本机 pi；先 `pi update self`）

## 四、次要适配项（P2，可分期）

1. **bash 截断提示**：ToolCard 检测结果 details 里的 `truncated`/`full_output_path` → 显示「输出已截断，完整输出：<路径>」（可点开工作台）
2. **发送反馈**：prompt/steer 响应新增的 disposition 可用于更精确的"已排队/已开始"反馈（现有乐观 UI 已够用，暂不动）
3. **codemode 开关**：0.99 的 `defaultTools: ["+codemode"]` 可在设置页暴露（默认关，不阻塞本次）
4. **同工具替换内置警告**：desktop 扩展工具名均为 `desktop_*` 前缀，与 builtin 无冲突，仅关注诊断展示

## 五、明确不做

- 系统主题/OKHSL/TUI 相关（desktop 自有渲染）
- MCP OAuth 登录 UI（第一期只展示"需登录"状态，用户去 CLI `pi mcp login`；后续可视需求做内嵌登录流）
- `provider_stream_event`、虚拟模型 UI、分类器模型

## 六、实施顺序与测试

**P0（一次 PR）**：版本闸门 bump + 桥条件化（pi>=0.99 不注册）+ mcp.json 迁移（enabled 语义/覆盖键折叠/imports 物化）+ `mcp__` 工具名 UI 识别 + mcp_servers_change 状态行
**P1**：捆绑 runtime 刷新、工作台/设置页状态完善
**P2**：截断提示、codemode 开关

测试计划：
- environment：0.99.1 过闸、0.85.0/0.100.0 拒绝（现测试文件扩展）
- mcp-disable：改写为 enabled 语义 + 迁移用例（旧覆盖键 → per-entry 标志 + 键删除）
- mcp-imports：物化后格式符合 pi 规范（command/args 拆分、`enabled:false`、无 imports 键残留）
- 桥条件化：mock pi 版本 ≥0.99 → 不注册任何 mcp 工具；<0.99 → 照旧
- 实机（PI_SMOKE 沙箱 + 真实 mcp.json）：0.99.1 下无重复工具、禁用即不连、computer-use 强制启用场景复测
- 回归：retry-ui/设置页/会话历史全量 vitest + 打包清单

## 七、风险

| 风险 | 缓解 |
|---|---|
| 迁移写坏用户 mcp.json | mergeJson 保留 revision 冲突检测；迁移前把原文件复制 `.bak-pre099` |
| pi 0.99 对 mcp.json 内未知 per-entry 字段的容忍度未实测 | 实施前用沙箱探针先验证 `disabled:true`/`exposure` 等字段不报错 |
| bundled runtime 与系统 pi 版本差带来的行为漂移 | 桥按版本条件化已是双保险；捆绑刷新到同版本消除主要差异 |
| 0.99 改了流式 CPU 行为/会话树 API 但未进 RPC 面 | 已核对 RPC 面无变化；上线后观察 get_messages 大会话性能 |
