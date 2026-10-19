# desktop-policy 模块审计与拆分清单（2026-10-19）

## 背景与目标

用户提出「扩展都做成插件形式，desktop/cli 同时都能用」。本文档对
`extensions/desktop-policy/`（12 个文件，644 行）逐模块做依赖审计，给出
**按归属拆分**的清单。原则：

> 新能力默认做成 npm 插件包（两端自动共用）；只有必须访问 Electron API
> （窗口/UI/文件对话框）或依赖 Desktop 私有 IPC 协议的才留在 `extensions/`
> 内置；半通用的拆成 npm 包 + Desktop 用 env/props 注入宿主差异。

**范围边界（2026-10-19 用户修正）**：只拆**质量相关**能力（agent 产出质量：
任务纪律、验证门、审查）。Desktop 宿主便利功能（模型热刷新、网络诊断增强、
重试续跑握手）即使结构上可拆也**不拆**——CLI 没有这些需求，泛化握手令牌是
纯开销，违反「聚焦质量基础设施」的初衷。

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

## 拆分清单（收窄后：只做质量相关）

### A 档：拆 npm 包

| 新包 | 来源 | 为什么拆（质量收益） |
|---|---|---|
| `@wengine-ai/pi-plan-tool` | `plan.mjs` + checklist 引导语 | **任务纪律是质量基础设施的核心**：多步任务强制建清单、一步一更、完成即验证。CLI 会话（日常干活的形态）现在完全没有这个约束，是最直接的收益 |

### 留 Desktop 内置（不拆）

| 模块 | 理由 |
|---|---|
| `index.mjs`（tool_call 权限链 + 系统提示 + 审批 UI） | 审批走 `ctx.ui.select` 的 Desktop RPC 通道（ZCode 五选项），modeFile 控制文件由主进程写；CLI 没有等价宿主。拆出去只会得到一个「人人都用不了的半个权限系统」 |
| `model-refresh.mjs` | **宿主便利功能，非质量问题**：运行中热刷新模型是 Desktop 特有需求（改设置不用重启会话），CLI 改模型本来就是重启。`PI_DESKTOP_GENERATION` 握手留着即可 |
| `retry-continuation.mjs` | 同上：重试续跑是 Desktop 的重试组机制配套，CLI 无此概念 |
| `network-diagnostics.mjs` | 诊断增强纯属 Desktop 排障便利（代理网络环境），与产出质量无关 |
| `mcp-bridge.mjs` + `mcp-client.cjs` | pi≥0.99 原生 MCP 已覆盖（`hasNativeMcp()` 就是自停开关）。随 desktop-policy 寿终，见 D 档 |

### 附带记录（非质量，仅结构问题，可选）

| 对象 | 现状问题 |
|---|---|
| `mcp-imports.cjs` | 主进程 settings 页直接 `import` 扩展目录内的 `.cjs`（`src/main/pi/...`），跨层引用别扭。拆 `pi-mcp-imports` 是结构修正，但**不带来质量收益**——CLI 用户自己配 MCP 不需要这层兼容。列为可选，不做默认动作 |

## 收益量化（收窄后）

- **CLI 立即可得**：任务清单纪律——多步任务强制建计划、一步一 in_progress、
  完成即验证、不标记未验证项。这是整套质量基础设施里**唯一 CLI 完全没有**的
  一环（quality-gates / quality-prompt / code-review skill 都已在 agentDir）
- **Desktop 零变化**：薄封装或 packages 声明，行为不变
- **维护**：plan 工具进 npm 后有独立版本/CHANGELOG/测试（对齐 pi-quality-gates 模式）

## 风险与对策

| 风险 | 对策 |
|---|---|
| `-e` 加载顺序/依赖路径变化 | 过渡期用 `import from` 薄封装（不删文件只改内容），asar 验证字符串 |
| plan 工具名 `desktop_update_plan` 已写进 116MB 历史会话 | 包内保持同名（兼容旧会话渲染），新名字只作 alias |
| npm 包加载失败导致 Desktop 会话起不来 | backend 已有「缺失不阻塞会话」模式（ask/schedule/memory 同款条件加载） |
| CLI 与 Desktop 同时加载同一工具冲突 | plan 工具用 settings.json packages 声明（pi 自己去重），不用 `-e` |

## 建议执行顺序

1. `pi-plan-tool`：13 行主体 + 引导语常量，带测试，发版后 settings.json 声明
   `npm:@wengine-ai/pi-plan-tool`，Desktop 的 `-e` 改薄封装
2. （可选，非质量）`pi-mcp-imports` 修主进程跨层 import 的结构问题
3. D 档：runtime 升 ≥0.99 后删 mcp-bridge，desktop-policy 只留 index.mjs
   + 引导语

## 待拍板

- plan 工具是否保持 `desktop_update_plan` 名（兼容旧会话）还是借拆分机会改名
  （会丢历史渲染）？
