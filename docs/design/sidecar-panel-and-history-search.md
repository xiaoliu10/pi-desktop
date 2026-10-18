# 副驾面板（会话旁路）+ 历史知识检索 设计文档

> 功能意图：主会话之外提供一个不打扰、不污染主会话上下文的旁路对话（问澄清、做改写、查资料），并支持跨历史会话的知识检索（「上次那个问题怎么解决的」）。副驾产出的结论可一键送回主会话。
> 日期：2026-10-10 ｜ 状态：草案（待用户拍板 3 个决策点）

## 1. 现状与接入点（内部分析）

### 1.1 数据流（改动前）

```
用户输入 → composer → store.send() → IPC localPi.prompt()
  → main: PiBackend.prompt() → PiRpcClient → pi 子进程（每会话一个）
       ↘ 事件流 agent_update/agent_settled → emit → renderer store

会话数据：~/.pi/agent/sessions/{desktop,cli}/**/*.jsonl
  → SessionIndex（1.5s settle 循环 + fs.watch，stamp = ino:size:mtime:ctime）
  → history(key) = { session, entries, branch, leafId }
```

### 1.2 项目内同类实现（直接照形状做）

| 现有模块 | 可复用形态 |
|---|---|
| 计划侧板 `planOpen` + 子代理面板 `subagentPanel` | 右侧栏面板骨架、与 selectedKey 联动生命周期（PiReplicaApp 内 useState + useEffect 清理） |
| `RemotePane` 远程面板 | 副驾的「消息列表 + 迷你 composer」UI 结构 |
| `SessionIndex` | 副驾会话文件自动收录（owned 目录）、branch/leafId、stamp 指纹 |
| `connect({sourceKey})` | 副驾会话的接续（副驾自己也是一条 pi 会话链） |
| `MAX_SESSIONS=12` 满员腾位 | 副驾连接并入同一管理（副驾 idle 会话是合格的腾位候选） |
| prompt 历史/草稿的 ownerKey 模式（#76） | 副驾草稿独立 stash（`sidecar:<key>` 归属） |

### 1.3 契约层

- 会话清单/历史/发送的 IPC 已有（`src/shared/pi.ts` 的 PiRun/PiEvent/PiHistory）——副驾复用同一套通道，需要新增的只有「副驾域标记」与检索查询通道。
- 副驾会话与主会话在同一 SessionIndex 里共存：需要**分域展示**（侧栏主列表不出现副驾会话），用文件命名约定或 header 字段区分。

### 1.4 已知约束与坑（项目内）

- 大会话 get_messages 序列化风险（≥8MiB 跳过，`CONTEXT_BREAKDOWN_MAX_SESSION_BYTES`）——副驾注入「引用主会话」时同样受此约束。
- ashare 46MB 图片膨胀教训（上下文里 base64 永不淘汰）——**检索层严禁索引 base64/图片**。
- 连接上限 12：副驾常驻会多占一个连接名额；满员腾位逻辑已能处理（副驾 idle 可被腾位，点开即重连）。

## 2. 外部调研

### 2.1 同类开源实现

| 项目 | 核心事实（源码核对） | 取舍 |
|---|---|---|
| **Zed agent panel**（`crates/agent_ui/src/agent_panel.rs`） | 单活跃视图 + `retained_threads` 继续跑切走的运行中 thread；SQLite 持久化 thread（含 `parent_session_id`）；thread 可 `@mention` 引用进另一 thread | retained 模式、显式跨会话引用、parent 关联——都值得抄 |
| **Continue sidebar**（`gui/src/redux/thunks/session.ts`） | 上下文以 `contextItems` **挂在每条用户消息上**（非会话级共享）；会话=一 JSON 文件；恢复还原模型选择 | 「引用即附件」是防上下文泄漏的最好模式 |
| **Cline**（`newTask.ts` + `addToCline.ts`） | 每个 task 全新隔离；「Explain/Add to Cline」右键是显式注入入口 | 注入靠显式动作；入口动作的交互值得抄 |
| **Void**（`chatThreadService.ts`） | 全部 threads 序列化成**单个 JSON blob** | 反面教材：无界膨胀+格式漂移即坏（见 2.3） |
| Aide | 已归档闭源 | 只作产品形态参照 |

**关键发现：没有任何一家实现「主会话运行中、旁路只读观察并可反向注入」的真·旁路**。全部是形态 A（完全隔离 thread + 显式注入）。这是行业共识的安全边界，我们照做。

### 2.2 上游生态位（pi 本体）

- pi 内核**没有**内置会话内容检索（pi-mono 核心包只有 session-selector 标题过滤）→ FTS 层需要 desktop 自建，自建正当。
- pi-desktop 已有 `memory-bridge.ts` 管理 pi-memory 插件（MEMORY.md/daily/scratchpad 体系）→ **策展层知识不重建**，检索功能做「原始层」，两层互补。
- 上游已知 bug 中与我们相关的：CLI/非 TUI 模式 auto-compact 不启动（earendil-works/pi#10330）——副驾若长时间运行同样面临上下文增长，设计上要让副驾会话保持短命（一次性任务）或提示压缩。

### 2.3 反面证据与坑（全部带 issue 链接）

| 坑 | 来源 | 我们的对策 |
|---|---|---|
| 重启后面板活跃会话消失 | zed#52143、cline#12239 | 副驾活跃态落盘（last-active per 主会话） |
| 重开 task 排队 prompt 丢失 | cline#12226 | 副驾排队输入随会话持久化（复用 deferredQueue 语义） |
| `@` 引用另一 thread 内容根本没发给模型（静默失败） | zed#59350 | 注入必须校验 payload；引用块在发送前后都有可见回执 |
| 单 blob 存储 thread 无界膨胀 | void#chatThreadService + zed#52143 族 | 一 session 一 jsonl（本项目天然如此） |
| FTS 滑动窗口（只索引最近 N 条）导致旧会话消失 | cline#14739 | **全量索引**，FTS5 便宜 |
| 索引出错后无法重建 | continue#5617 | 重建路径一等公民（设置里给「重建索引」按钮） |
| 索引显示成功但检索不出 | continue#12583 | 对账自检：FTS 行数 vs 会话文件数 |
| schema 演进打废旧索引 | continue#2026 | 索引表带 schema_version，升级自动重建 |
| 本地 embedding 模型 OOM | gpt-researcher#1380 | embedding 模型进程绝不进 Electron 主进程（二期再说） |

### 2.4 外部做法 → 本项目接入点（翻译层）

| 外部做法 | 本项目落点 |
|---|---|
| Zed retained_threads（切走继续跑） | 副驾 = 独立 pi 子进程，天然后台跑；面板关闭仅 UI 收起，进程与 jsonl 保留 |
| Continue 消息级 contextItems | 副驾 prompt 的「引用主会话」= 附加只读快照块（带来源标注 `[主会话 · N 条 · 截止 <leafId 前 8 位>]`） |
| Cline addToCline 入口动作 | 主会话消息/代码块 hover 菜单加「在副驾中讨论」 |
| Zed thread @mention / markdown 导出 | 副驾结论 →「插入主会话 composer」（引用块格式），MVP 不做自动 apply |
| Cline session-history-search（FTS5+BM25） | `src/main/pi/session-search.ts`，数据源换 `SessionIndex`，workspaceRoot 换 `session.cwd` |
| kotaemon hybrid 默认值 | 二期 embedding 与 FTS 融合而非替代 |
| Claude Code auto memory 分层 | 策展层（memory 插件）与原始层（FTS）UI 分开呈现 |

## 3. 方案对比与推荐

### 方案 A（推荐）：隔离 pi 子进程副驾 + FTS5 检索

- 副驾 = 独立 pi 会话（独立 jsonl，desktop owned 目录，命名 `sidecar-` 前缀或 header 标记），spawn 参数可裁剪工具集（无编辑权限，chat-only）。
- UI：右侧栏第四个面板（与计划/子代理/文件面板同级），hover 主会话消息可「在副驾中讨论」。
- 检索：主进程 SQLite FTS5（`node:sqlite` 内置模块，零原生依赖），索引= 每消息一行+会话 metadata 行，跳过 base64/图片/reasoning。
- 改动面：新增 3 文件（`sidecar-service.ts`、`session-search.ts`、`SidecarPanel.tsx`）+ 4 处接线（SessionIndex 分域、PiReplicaApp 面板、preload 通道、设置重建按钮）。
- 风险：中。副驾连接并入 12 上限管理；FTS 与 SessionIndex 指纹联动增量。

### 方案 B：副驾复用主会话进程（`/` 命令或隐藏分支）

- 同一 pi 进程内开「影子分支」（leafId 分支），UI 左右分栏。
- 优点：零新增进程、天然共享文件上下文。
- 否决理由：① 上下文隔离靠 pi 内核分支语义，上游无「旁路模式」支持（查证过 pi-mono 无此能力）；② 主会话 running 时旁路 prompt 只能排队，做不到「不打扰」；③ 分支操作会写主会话 jsonl，违背「旁路无痕」。**侵入 pi 内核语义，风险最高**。

### 为什么不用更简单的替代

- 「直接新开一个普通会话当副驾」：没有分域展示、没有引用注入入口、没有「送回主会话」动作——用户会迷失在会话列表里。副驾的本质是**工作流绑定**（每个主会话一个随时可唤出的旁路），不是又一个会话。

## 4. 详细设计（方案 A）

### 4.1 数据流（改动后）

```
主会话消息 hover →「在副驾中讨论」
  → SidecarService.ensure(key) → 副驾 pi 子进程（sourceKey=副驾自己上次会话）
       注入 = prompt 文本 + 引用附件块（主会话最近 N 条只读快照，标注来源）
  → 副驾回复流式渲染在 SidecarPanel
  → 「送回主会话」→ 引用块插入主 composer（用户确认后自己发送）

历史检索：SessionIndex settle 循环 → session-search.ts 增量 reconcile（stamp 指纹）
  → composer `/` 命令或 SidecarPanel 检索框 → IPC localPi.searchSessions(query, {cwd})
  → FTS5 bm25（title×8）→ best-hit-per-session 去重 → snippet 高亮 → 点击跳转会话
```

### 4.2 文件级改动清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/main/pi/sidecar-service.ts` | 新增 | 副驾生命周期：ensure/注入/送回；spawn 参数裁剪（chat-only 工具集）；活跃态持久化 |
| `src/main/pi/session-search.ts` | 新增 | FTS5 索引与查询；stamp 指纹增量；schema_version 管理；对账自检 |
| `src/renderer/pi/SidecarPanel.tsx` | 新增 | 副驾面板 UI（消息流+composer+引用注入+送回按钮+检索框） |
| `src/shared/pi.ts` | 修改 | PiSession 加 `sidecarOf?: string`（副驾归属主会话 cwd 域）；检索结果类型 |
| `src/main/pi/session-index.ts` | 修改 | 识别副驾会话文件（命名/header 标记），主列表过滤 |
| `src/main/index.ts` + `src/preload/index.ts` | 修改 | 新 IPC：`sidecarEnsure/sidecarSend/searchSessions/rebuildSearchIndex` |
| `src/renderer/pi/PiReplicaApp.tsx` | 修改 | 面板挂载与 selectedKey 联动（照 planOpen 形状） |
| `src/renderer/replica/chat/chat.css` 或独立 css | 修改 | 面板样式（复用现有面板变量） |

### 4.3 契约变更与兼容

- `PiSession` 新增可选字段 `sidecarOf?: string`——旧数据无此字段即非副驾，向后兼容。
- 新 IPC 通道走 `local-pi:` 前缀 helper（#77 的 ipc-channel-alignment 测试自动覆盖）。
- FTS 索引库放 `app.getPath('userData')/search-index.db`；丢失/损坏可全量重建（对账自检发现行数缺口自动触发）。

### 4.4 分阶段实施（每步可独立验证）

1. **切片 1：副驾面板 MVP**——`SidecarService.ensure/send`（无注入、无送回），面板渲染副驾消息流。验证：开副驾问一个独立问题，主会话上下文不受影响（token 计数对比）。
2. **切片 2：引用注入 + 送回**——「在副驾中讨论」hover 动作（最近 N 条快照注入，校验 payload 含引用块——防 zed#59350）；「插入主 composer」引用块。验证：注入后副驾能准确回答主会话内容；主会话 jsonl 无旁路写入。
3. **切片 3：历史检索**——FTS5 增量索引 + 检索框 + 结果跳转。验证：跨会话关键词检索命中、跳转正确；46MB 图片会话只索引 metadata 行；重建按钮可用。
4. **切片 4（可选二期）**：embedding 融合、副驾工具集定制 UI、`@` 跨会话引用。

### 4.5 测试策略

- 单测：`sidecar-service`（生命周期/注入 payload 组装/送回格式）、`session-search`（索引增量/指纹跳过/图片跳过/bm25 权重/重建对账）——fake-pi fixture 扩展副驾分支。
- 集成：ipc-channel-alignment 自动覆盖新通道。
- Browser 回归：面板开合与会话切换联动（照 turn-timer-top.browser.cjs 骨架）、检索交互。
- fixture 注意：测试 ID 全局唯一（messageCache 污染前科×3）；`node:sqlite` 在 vitest 环境可用性需先验证（见盲区）。

### 4.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 副驾挤占连接上限 | 并入 12 上限管理，副驾 idle 可腾位；上限可配置 | 关闭面板入口即功能下线，副驾会话文件留存 |
| FTS 索引膨胀/损坏 | schema_version + 对账自检 + 一键重建 | 删 db 文件即回初始态 |
| 注入块过大（大会话快照） | 快照条数上限 + 8MiB 会话只注入摘要行（复用 sessionStub） | 注入条数可配置调小 |
| pi 上游 #10330（副驾长会话不压缩） | 副驾会话引导短命（一次性任务）；超长提示新开副驾 | — |

## 5. 盲区与待拍板

1. **副驾 spawn 参数**：pi CLI 是否支持「禁用编辑类工具」的 flag 未验证（需读 pi-mono 的 launch 参数文档/源码）；若不支持，副驾仍全工具但权限模式用 ask 兜底。
2. **`node:sqlite` 在 Electron main 的可用性**：Node 22+ 内置但 Electron 33 的 Node 版本需实测；不行则评估 better-sqlite3（引入原生依赖重编译，electron-builder 需处理 ABI）。
3. **副驾会话在侧栏的分域展示**：完全隐藏（副驾只在面板内可见）还是侧栏分组「副驾」折叠区？**需要你拍板**。
4. **历史检索的范围**：仅当前项目（cwd 过滤）还是全部项目默认？**需要你拍板**（cline 用 workspace 过滤，默认当前项目，可切全局）。
