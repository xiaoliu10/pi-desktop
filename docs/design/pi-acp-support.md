# pi 支持 ACP（Agent Client Protocol）调研与设计

> 真实意图：让 pi 能被 ACP 客户端（Zed 等）当 agent 直接使用，接入 ACP 生态
> 日期：2026-11-16 / 状态：待评审
> 三个原始问题的答案：① Desktop 不支持 ACP（也不需要——Desktop 自身就是完整 UI client，走 pi 自定义 RPC mode）；② pi 原生不支持 ACP，且上游明确拒绝内置；③ 可以做，但**不是 pi 扩展（extension）**，正确形态是独立适配器进程（上游背书的唯一形态）。

## 1. 现状与接入点

### 1.1 三方角色澄清（事实，本地实证）

- **Desktop**（pi-desktop，Electron）：通过 pi 的 **RPC mode**（自定义 JSON-RPC，`docs/rpc.md`）驱动 pi，自绘完整 UI。ACP 的消费方是「编辑器等外部 client」——Desktop 不是 ACP client 也不是 ACP server，接 ACP 对它没有直接收益（`src/main/pi/rpc-client.ts` 即接入面）。
- **pi 原生**（@earendil-works/pi-coding-agent 1.5.2，本地 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`）：`dist/modes/` 只有 `interactive` / `json-event` / `print-mode` / `rpc`，docs 与 bin 均无 ACP 痕迹 → **不支持**。
- **上游态度**（earendil-works/pi，原 badlogic/pi-mono，122k★）：
  - issue #175「ACP Support」：badlogic「I currently have no need for ACP support... It should however be trivial to build an ACP adapter on top of RPC mode」，closed；
  - PR #241 / PR #836 两个 ACP mode 均被拒：「better done as a separate project, pulling in pi... in form of an adapter, instead of a mode in pi itself. I don't want to carry that baggage if ACP turns out to be a dud.」badlogic 还实测发现该 PR「sessions are not saved at all despite claiming loadSession」——capability 谎报是 ACP 适配的典型坑；
  - 上游 12 个 packages 无 acp 包（MCP 是唯一官方收编的互操作协议）；新贡献者 issue/PR 默认被 bot 自动关闭。
  - **结论：独立 adapter 项目是上游唯一背书形态，不存在「推上游原生支持」这条路。**

### 1.2 为什么不是「pi 扩展」（推断，依据扩展 API 面）

pi extension 的事件模型（input/agent_start/message_update/tool_call... + `registerCommand`/`registerTool`）寄生在 **pi 交互进程内**；而 ACP server 的生命周期是「client spawn agent 进程，进程入口即 ACP server，stdio 上跑行分隔 JSON-RPC」。pi 进程的 stdio 已被 TUI/RPC 占用，扩展 API 没有替换进程入口/传输层的能力。给 Zed 的配置面也只有 `command + args`（spawn 进程）——「扩展里开 TCP 端口」不合 Zed 的发现机制。故正确形态是**独立 bin 包**。

### 1.3 pi SDK 接入面（事实，`dist/index.d.ts` 实证）

in-process 方案的基座全部现成：

| pi SDK | ACP 对应物 |
|---|---|
| `createAgentSession({cwd,...})`（core/sdk.ts 导出） | session/new |
| `session.subscribe(AgentSessionEvent)` | session/update 通知流 |
| `message_update`（thinking delta / text delta） | agent_thought_chunk / agent_message_chunk |
| `tool_execution_start/update/end{toolCallId,...}` | tool_call / tool_call_update（含 locations、partialResult→流式） |
| `session.prompt(text,{images})` / `abort()` | session/prompt / session/cancel→stopReason:cancelled |
| SessionManager + session jsonl | session/load 历史回放 |
| compaction 事件 | compaction_update（需 client capability 声明） |
| session stats / contextUsage | usage_update |
| SlashCommandInfo | available_commands_update |

要自造的部分：**request_permission 闸门**（pi 无权限系统，要么不弹、要么适配层自定策略）、**edit/write 的 diff**（适配层快照前后文件生成 oldText/newText）、**sessionId↔pi session 映射**、**stopReason 判定**（见 §4 红线）。

## 2. 外部调研（要点）

### 2.1 协议（v1 稳定 = 唯一落地目标）

- 传输：**行分隔 JSON-RPC 2.0 over stdio**（非 LSP Content-Length 分帧）；agent 的 stdout 除 ACP 消息外 MUST NOT 有任何输出，stderr 可自由日志。
- 基线必做：initialize / session/new / session/prompt / session/cancel / session/update；session/load 由 `agentCapabilities.loadSession` 门控。
- session/update 14 个变体（v1 schema 逐个核对）；stopReason 五值：end_turn / max_tokens / max_turn_requests / refusal / **cancelled**（cancel 后即使底层抛异常也必须返回它）。
- v2 仍是 draft（删 session/load 改 resume、删 fs/terminal 委托、prompt 生命周期重设计）；Zed 生产走 v1。**只做 v1，v2 用版本协商挡住即可。**

### 2.2 社区实现（可抄作业，非无人区）

| 实现 | 路线 | 状态 | 借鉴点 |
|---|---|---|---|
| svkozak/pi-acp（npm pi-acp） | spawn `pi --mode rpc` 桥接 | **778★，Zed ACP Registry 收录**；MVP 定位、31 open issues、pi 1.x 跟进滞后（#159 开着无人回） | edit diff 快照法、session-map.json、usage 降级（pi 版本无 contextUsage 就不发） |
| agentclientprotocol/claude-agent-acp（2776★） | in-process 包 claude-agent-sdk | Zed 官方参考 | sdk-to-acp.ts 853 行映射表、messageId chunk 分组、transcript 尾读恢复 model |
| google-gemini/gemini-cli src/acp | in-process | 官方 | 35 行 stdio 传输样板；坑最多（load 不 await、compaction 后回放 400、输出不截断） |
| @openma/pi-acp、@automatalabs/pi-acp | **同为 createAgentSession in-process** | 5-7★ 小型先行者 | 证明路线可行；可对比映射细节 |

### 2.3 反面证据（进风险清单）

1. **stdout 污染**（claude-code-acp#69）：上游 CLI 一行非 JSON 输出 → 分帧破坏、会话死。入口第一件事做 stdout 纪律。
2. **compaction/abort → 假 end_turn**（pi-acp#148）：pi 内部 run 以 stopReason:error 收尾被适配层吞掉映射成 end_turn，用户看到假完成。**必须用 agent_settled（而非 agent_end）判定 turn 结束**，error→refusal 或自定义。
3. **capability 谎报**（badlogic 拒 PR #241 的实测理由）：loadSession 声明了就必须把回放做对（响应前先入队回放、live 与 replay 共用同一翻译函数）；不宣告 loadSession 只是 Zed 没历史 UI，是安全降级。
4. **SDK 无稳定性承诺**：changelog 多次 breaking 直接命中 createAgentSession 签名与事件形状（0.50/0.80.8/0.84/0.87/1.2.0/1.5.0），节奏约每月一次 → **pin 精确版本 + 事件映射回归测试**是生存条件（pi-acp#159 即滞后实例）。
5. **客户端分歧**：JetBrains 与 Zed 对 config option 语义有分歧（pi-acp#138）；Zed registry/npx 形态会静默自动升级（zed#66788）→ 每个 release 必须可用。
6. **pi 版本能力降级**：usage 依赖 get_session_stats.contextUsage，老 pi 没有就不发（pi-acp 的按版本降级先例）。

## 3. 方案对比与推荐

- **方案 A：直接用现成 pi-acp（零开发）**——Zed settings 配 `agent_servers.pi = {type:"custom", command:"npx", args:["-y","pi-acp"]}` 即可。优点：今天就可用、被 Zed Registry 收录。缺点：RPC 桥接拿不到 thinking 流、无权限桥、pi 1.x 兼容滞后且维护在别人手里。
- **方案 B（推荐）：自研独立 npm 包（in-process SDK）**——上游背书形态；`@agentclientprotocol/sdk` + `createAgentSession`；三家公共骨架可直接模板化（入口/stdout 纪律 → AgentSideConnection → Agent 类 → Session 包装（subscribe→翻译→串行 emit）→ 纯函数翻译层 → 权限桥 → 回放）。核心映射预计 500-800 行（issue #175 里 manmal 的原型约 400 行），加测试约 1-2 周。
- **不选「Desktop 集成 ACP」**：Desktop 是 standalone host，ACP 不解决它的任何问题；若未来要「用 Zed 连 Desktop 的会话」，正确方向反而是 Desktop 暴露 ACP server 形态——那是另一个需求，本文不展开。

**推荐：A 先行验证价值（一天内），价值确认后做 B。** B 的独立包建议放独立仓库（如 `pi-acp-server`），不在 pi-desktop 仓库内（发布 npm、可被 Zed Registry 收录；pi-desktop 只在需要时依赖它）。

## 4. 详细设计（方案 B 摘要）

- **包名/入口**：`pi-acp-server`（bin 同名）；依赖 `@agentclientprotocol/sdk`（v1 稳定入口）+ `@earendil-works/pi-coding-agent`（**精确 pin**）。
- **数据流**：Zed spawn bin → stdout 纪律（console 全部改道 stderr）→ ndJsonStream → AgentSideConnection → PiAcpAgent（initialize/newSession/loadSession/prompt/cancel/set_config_option）→ PiAcpSession（`session.subscribe → translate(event) → SessionUpdate[]` 串行 emit）。
- **翻译层**（纯函数，可快照测试）：message_update thinking→agent_thought_chunk、text→agent_message_chunk（同消息共享 messageId 防粘连）；tool_execution_start→tool_call（pi 工具名→ToolKind：read→read、bash/power-shell→execute、edit/write→edit/delete、grep/find→search）；update→tool_call_update（locations 绝对路径+1-based 行）；end→completed|failed；edit/write 结果→diff content（快照法）；agent_settled→stopReason（正常 end_turn、abort→cancelled、error→refusal，绝不假 end_turn）；compaction 事件→compaction_update（client 未声明则降级为普通消息）。
- **权限桥（最小可行）**：MVP 恒 allow + 文档声明；第二步用 pi 扩展 ctx.ui.confirm 桥到 session/request_permission（pi-acpinator 已验证桥法；pi-acpinator 是 Rust 实现，桥法思路可参考其 issue/源码）。
- **MVP 范围**：initialize + newSession + prompt + cancel；tool_call/update+diff+locations；message/thought chunk；session/load 回放；usage_update；available_commands_update。**推迟**：v2、session/list、fs/terminal 委托（pi 本地自足，声明不支持）、elicitation、subagents。
- **测试策略**：翻译层快照测试（事件序列→update 序列）；用 @agentclientprotocol/sdk 的 in-memory transport 做协议级集成测试（不依赖 Zed）；真实 Zed 手动验收清单（session/new、流式、工具 diff、cancel、load 回放）。
- **风险与回滚**：pi 升级 breaking → 每次上游发版跑映射回归（可挂进 pi-desktop 的每日上游跟踪）；Zed 端 bug → 幂等 replay + 进程自愈；发版纪律同 pi-desktop（双语 CHANGELOG、CI、Registry 提交）。

## 5. 盲区与待拍板

- @openma / @automatalabs 两个同路线包只读了 README 与目录，未逐行审源码；动手前应先 clone 细读，若 @openma 已足够好，可考虑贡献而非自研（省维护）。
- 是否给 svkozak/pi-acp 提 PR 补 pi 1.x 兼容（方案 A 的改进路径）——外部项目维护节奏不可控，不作为主路线。
- 权限桥的产品形态需要拍板：恒 allow（开发场景够用）还是 bash/edit 前弹审批（更安全，工作量+）。
- v2 不做；若 ACP 生态 future 迁移 v2，fs/terminal 删除反而利好 pi 本地自足模型，迁移成本低（推断）。
