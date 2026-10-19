# desktop-policy 模块审计与拆分清单（2026-10-19）

## 背景与目标

用户提出「扩展都做成插件形式，desktop/cli 同时都能用」。本文档对
`extensions/desktop-policy/`（12 个文件，644 行）逐模块做依赖审计，给出
**按归属拆分**的清单。原则：

> 新能力默认做成 npm 插件包（两端自动共用）；只有必须访问 Electron API
> （窗口/UI/文件对话框）或依赖 Desktop 私有 IPC 协议的才留在 `extensions/`
> 内置；半通用的拆成 npm 包 + Desktop 用 env/props 注入宿主差异。

## 加载形态（现状，backend.ts:277-320）

```
-e policyPath                     → index.mjs（权限决策 + 系统提示注入）
-e .../mcp-bridge.mjs             → MCP 桥（仅 pi <0.99 旧版 CLI 生效）
-e .../retry-continuation.mjs     → 重试续跑握手（独立于 index.mjs 加载）
-e .../desktop-ask                → 条件（无第三方 ask 插件时）
-e .../desktop-schedule           → 定时任务
-e .../desktop-memory             → 条件（memoryAssist 开启）
-e .../desktop-codemode-nudge     → codemode 引导
-e .../desktop-cache              → 显式缓存断点
```

## 逐模块审计矩阵

| 模块 | 行数 | Electron API | Desktop IPC/env | pi 公共 API | 通用性判定 |
|---|---|---|---|---|---|
| `plan.mjs` | 13 | 无 | 无 | `registerTool` | **纯通用** |
| `policy.mjs` | 80 | 无 | 无（读 modeFile 路径由 env 传入） | 无（纯函数） | **纯通用** |
| `diagnostic-text.mjs` + `.d.mts` | 47 | 无 | 无 | 无 | **纯通用** |
| `network-diagnostics.mjs` | 36 | 无 | `PI_DESKTOP_PERMISSION` 存在性 | 无（包装 fetch） | **半通用**（触发条件 Desktop 化，逻辑通用） |
| `mcp-imports.cjs` | 119 | 无 | 无（读各家 MCP 配置文件） | 无 | **纯通用**（记忆已记录它被主进程 settings 页共用） |
| `mcp-client.cjs` | 56 | 无 | 无 | 无 | **纯通用**（MCP stdio/HTTP 客户端） |
| `mcp-bridge.mjs` | 58 | 无 | `PI_DESKTOP_*` 门控 | `registerTool` 等 | **半通用**（旧版 CLI 兼容层，pi≥0.99 自动禁用） |
| `model-refresh.mjs` | 61 | 无 | `PI_DESKTOP_GENERATION` 门控 | `registerCommand` + `ctx.modelRegistry` | **半通用**（命令形态通用，generation 握手是 Desktop 私契） |
| `retry-continuation.mjs` | 55 | 无 | `PI_DESKTOP_GENERATION` 门控 | `registerCommand` + `ctx.waitForIdle` | **半通用**（同上） |
| `index.mjs` | 119 | 无 | modeFile 控制文件 + 系统提示文案 | `on('tool_call')` + `ui.select`（RPC 通道） | **Desktop 绑定**（审批 UI 走 Desktop RPC） |
| （`diagnostic-text.d.mts`） | 3 | — | — | — | 类型声明，随行 |

## 拆分清单（三档）

### A 档：拆 npm 包（纯通用，CLI 立即受益，零风险）

| 新包 | 来源 | CLI 收益 | 说明 |
|---|---|---|---|
| `@wengine-ai/pi-plan-tool` | `plan.mjs` + `policy.mjs` 的 checklist 引导语 | 终端会话也有结构化任务清单；替代 CLI 里手工维护 | 13 行主体 + 引导语常量；`policy.mjs` 的 classify/resolveTarget 一并带入（自带权限决策，可独立于 Desktop 的 modeFile 工作） |
| `@wengine-ai/pi-mcp-imports` | `mcp-imports.cjs` + `mcp-client.cjs` | CLI 直接解析 claude-code/cursor/codex/opencode/claude-desktop 的 MCP 配置 | 已被主进程 settings 页 import（`src/main/pi/...`），拆包后两端共用同一实现；记忆里「MCP imports 加载」修复的正确沉淀位置 |

**迁移方式**：`extensions/desktop-policy/` 里保留 `import { registerDesktopPlan } from '@wengine-ai/pi-plan-tool'` 薄封装（或 backend 的 `-e` 换成 settings.json 的 `packages` 声明），Desktop 行为零变化。

### B 档：半通用——拆包 + Desktop env 注入（收益大但要适配）

| 模块 | 拆分形态 | 关键适配点 |
|---|---|---|
| `network-diagnostics.mjs` + `diagnostic-text` | `@wengine-ai/pi-net-diag` | 去掉 `PI_DESKTOP_PERMISSION` 门控，改为参数 `install(pi, { enabled })`；CLI 可用 `PI_NET_DIAG=1` 开启 |
| `model-refresh.mjs` | `@wengine-ai/pi-model-refresh` | `PI_DESKTOP_GENERATION` → 通用 `PI_MODEL_REFRESH_TOKEN`（宿主注入任意握手令牌）；命令名由令牌派生，避免多宿主冲突 |
| `retry-continuation.mjs` | `@wengine-ai/pi-retry-continuation` | 同上（握手令牌泛化）；`waitForIdle` 是 pi 公共 API，CLI 可用 |
| `mcp-bridge.mjs` | `@wengine-ai/pi-mcp-bridge` | pi≥0.99 有原生 MCP，此包对 CLI 价值有限；建议**不拆**，随 desktop-policy 寿终（见 D 档） |

### C 档：留 Desktop 内置（不要拆）

| 模块 | 理由 |
|---|---|
| `index.mjs`（tool_call 权限链 + 系统提示 + 审批 UI） | 审批走 `ctx.ui.select` 的 Desktop RPC 通道（ZCode 五选项），modeFile 控制文件由主进程写；CLI 没有等价宿主。拆出去只会得到一个「人人都用不了的半个权限系统」 |

### D 档：寿终/合并（减少面）

| 对象 | 处置 |
|---|---|
| `mcp-bridge.mjs` + `mcp-client.cjs` | pi≥0.99 原生 MCP 已覆盖（`hasNativeMcp()` 就是自停开关）。当内置 runtime 升到 ≥0.99 且不再支持旧版时删；`mcp-imports.cjs` 先拆 A 档（settings 页还要用） |
| `diagnostic-text.d.mts` | 随 A/B 档搬迁，或直接内联（3 行声明） |

## 收益量化

- **CLI 立即可得**：任务清单（我现在 CLI 会话里手工维护计划的方式被替代）、MCP imports 解析
- **Desktop 瘦身**：`desktop-policy` 从 12 文件 644 行 → 4 文件（index + policy 引导 + bridge + 过渡封装）
- **可维护性**：通用能力进 npm 后有独立版本/CHANGELOG/测试（对齐 pi-quality-gates 模式）
- **生态**：A 档两个包对社区直接有用（plan 工具 + MCP imports 是通用刚需）

## 风险与对策

| 风险 | 对策 |
|---|---|
| `-e` 加载顺序/依赖路径变化 | 过渡期用 `import from` 薄封装（不删文件只改内容），asar 验证字符串 |
| plan 工具名 `desktop_update_plan` 已写进 116MB 历史会话 | 包内保持同名（兼容旧会话渲染），新名字只作 alias |
| npm 包加载失败导致 Desktop 会话起不来 | backend 已有「缺失不阻塞会话」模式（ask/schedule/memory 同款条件加载） |
| CLI 与 Desktop 同时加载同一工具冲突 | plan 工具用 settings.json packages 声明（pi 自己去重），不用 `-e` |

## 建议执行顺序

1. **A 档先行**（低风险高收益）：`pi-mcp-imports` → `pi-plan-tool`，各带测试 + 发版
2. **B 档跟进**：`pi-net-diag` → `pi-retry-continuation` → `pi-model-refresh`
3. **D 档收尾**：runtime 升 ≥0.99 后删 mcp-bridge，desktop-policy 只留 index.mjs + policy 引导

## 待拍板

- A 档两个包的 scope/命名是否认可（`@wengine-ai/pi-plan-tool` / `@wengine-ai/pi-mcp-imports`）？
- plan 工具是否保持 `desktop_update_plan` 名（兼容旧会话）还是借拆分机会改名（会丢历史渲染）？
