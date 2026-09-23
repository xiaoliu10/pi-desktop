---
name: pi-desktop-mcp-imports
description: desktop MCP 只读 mcp.json 直接 mcpServers、不解析 imports 是"CLI 配的 MCP
  desktop 没加载"的根因；已加 mcp-imports.cjs 共享解析器修掉
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi 的 MCP 配置在 `~/.pi/agent/mcp.json`：`mcpServers`（直接配置，用户的为空）+ `imports: [cursor, claude-code, claude-desktop, codex, opencode]`（从其它工具的配置导入）。**用户的实际 MCP 全在导入源里**：`~/.claude.json` 的 `mcpServers`（zai-mcp-server/wengine/web-reader）、`~/.cursor/mcp.json`（mastergo）、`~/.codex/config.toml` 的 `[mcp_servers.*]`（TOML）、`~/.config/opencode/opencode.json`、claude-desktop 的 `claude_desktop_config.json`。pi CLI 原生解析 imports，所以 CLI 里 MCP 可用。

**根因（2026-09-22）**：desktop 的 `extensions/desktop-policy/mcp-bridge.mjs`（加载进 pi 的 MCP 桥，把 MCP server 注册成 pi 工具）和 `settings-service.ts` 的 snapshot 都**只读 `mcp.json` 直接 `mcpServers`**——为空 → 桥不加载、设置页 MCP 页不显示。旧代码甚至有诊断提示"本桌面桥仅执行 mcpServers 中显式配置的服务"。

**修复**：新增共享解析器 `extensions/desktop-policy/mcp-imports.cjs`（import 名→配置路径映射，JSON 源读 `mcpServers` key，codex 做轻量 TOML `[mcp_servers.NAME]` 扫描），① 桥里 `resolveImports(cfg.imports)` 并入服务（直接 mcpServers 同名优先），工具标签带来源 `wengine · claude-code / 工具名`；② settings-service snapshot 把导入服务并入 `McpServerRow[]`（新 `source?: string` 字段，id 用 `hash(源文件+name)`），`mcpTest` 对导入行用 resolveImports 取配置（codex TOML `readJson` 会失败）；③ UI 导入行显示"导入自 X"、禁用启用/禁用/移除（写 mcp.json 对导入无意义），保留"检测连接"。

**pi 侧行为（dist 实证）**：RPC **没有**任何 MCP 命令（get_state 不含工具列表、get_commands 只有扩展命令）——desktop 拿不到 pi 已加载的 MCP 列表，只能静态读配置。`~/.pi/agent/mcp-cache.json` 是"连过才有"的 tools 缓存（非完整注册表，不能当列表源）；`mcp-npx-cache.json` 缓存 npx 解析结果。`PI_OFFLINE=1`（desktop 启动 pi 时设置）只关启动网络操作（版本检查/包更新/遥测），不禁 MCP。

**Why:** 用户"CLI 配了 MCP、desktop 没加载"排查了一圈 UI 才发现桥和 snapshot 都绕过了 imports；pi 又不通过 RPC 暴露 MCP 列表，静态解析是唯一途径。

**How to apply:** 改 MCP 相关功能时，`extensions/desktop-policy/*.mjs|cjs` 是 pi 子进程内运行的扩展（bridge 用 ESM import、客户端是 .cjs），settings-service 用 `require(policyDir/...)`——新增共享逻辑放 policy 目录的 .cjs 两边都能用；发布包要记得 extensions/desktop-policy/ 整目录被拷进 resources。验证 MCP 是否加载：重连会话后让模型调 MCP 工具，或设置页"检测连接"。相关：[[pi-desktop-pi-behavior-verification]]、[[pi-desktop-settings-and-shell]]
