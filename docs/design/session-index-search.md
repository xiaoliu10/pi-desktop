# 大会话索引/摘要/按段检索 调研与设计

> 真实意图：27219 条 / 205MB 的大会话性能差的根因是「全量常驻 + 全量扫描」。用户要
> 索引驱动的按需加载：搜索/定位段落快、图片按需出。日期：2026-10-18 / 状态：已实施（Phase 1-2）

## 1. 现状与接入点（内部分析，全部实测）

### 数据流（改动前）

```
pi 会话 jsonl（205MB）──SessionIndex 解析── PiHistory{branch: PiEntry[]}
   └─ IPC 全量 → renderer store.history（18082 条 ChatMessage 常驻）
        └─ sentConversationMessages 每拍重建 → executionTurns 聚合 → ChatView 渲染 60 turn
```

### 量化事实（真实会话 `1790689427762`）

| 指标 | 值 |
|---|---|
| 条目 / branch | 27219 / 17609 |
| tool part | 16873（96%） |
| thinking part | 2414 |
| 图片 | 78 张 / 26.3MB base64（最大 1.5MB） |
| `custom` 条目（policy-audit 等） | 9429（不渲染，但每次 IPC 全量传输） |
| SSR 60-turn 窗口 | 235-379ms/拍（修复前） |
| history() 全量序列化 | 3.5s/次（205MB） |

### 已有能力（不要重复造）

- **SessionIndex**（`src/main/pi/session-index.ts`）：增量解析（`parsedBytes`/`pendingTail`）、stamp 快路径、`branchEntries(entries, leaf)` 按 leaf 取分支
- **tail/before 分页**（本日已实施）：首屏 500 条 + `loadEarlierHistory()` 补拉，主进程 `fromCache` 单点实现
- **desktop_update_plan 任务清单**：会话级「章节标题」已经存在（模型自产）
- **pointers() pinned 穿透**（`subagent-snapshots.ts`）：尾窗外的子代理卡片按需读取的模式
- **subagentHistory**：子会话按需读（`childSessionPointer` 校验链）

### 关键洞察（设计的支点）

**pi 的 jsonl entry 自带 `parentId` 链和稳定 `id`**（`rpc-mode` 官方文档原话：「an entry id works as a durable cursor」）。这意味着：

- **索引 = 已有序的链表**：不需要另建索引结构，`parentId` 就是段落边界
- **摘要 = 已有条目**：user 消息是天然「轮次标题」，tool part 的 `summary`（80 字）是天然「段摘要」
- **搜索 = 遍历 entry**：主进程持有全量 `entries`，搜索只在主进程做、只回「命中的 entry 窗口」

## 2. 外部调研

### 2.1 上游 pi 内核（源码核对，v1.3.0）

- `get_entries {since}`：entry id 游标增量读取（官方文档：durable cursor，跨重启有效）——**desktop 未用**（初始全量必超 16MB 帧上限）
- `entry_appended` 推送事件：活跃会话可免文件轮询（后续优化项，见 §5）
- **无分页/无全文搜索能力**——本轮设计的检索层必须自建（结论：自建于主进程，不在内核）

### 2.2 VSCode 聊天面板（chatMarkdownContentPart.js，transcript 抢救）

- incremental morpher：append-only 更新、按 stream-rate 喂 buffer——已降级实现为 StreamMarkdown 节流（400ms）
- 长会话用「虚拟列表 + 按需 hydrate」：与我们的 `renderLimit` + 分页补拉同构

### 2.3 反面证据

- 「折叠 details 仍构建 body」是 React 生态常见盲区（本仓 6 个测试曾钉错方向）
- 大 base64 走 data URL 会让浏览器常驻「字符串 + 位图」两份（195MB 图片会话 RSS 3.5G 的根因）

## 3. 方案对比与推荐

| 维度 | A. 全量常驻（现状） | B. 索引+按需（本设计） | C. 外置搜索库（lunr/flexsearch） |
|---|---|---|---|
| 打开速度 | 3.5s+ | **亚秒（一屏）** | 同 B（但多一层建索引） |
| 搜索 | 无 | **主进程扫 entry 回窗口** | 快，但索引本身要维护/增量 |
| 内存 | 3.3G | 一屏 + 按需 | B + 索引副本 |
| 改动面 | — | **中（3 文件 + 1 IPC）** | 大（依赖 + 增量索引 + 序列化） |
| 依赖 | — | **零** | +1 npm |

**推荐 B**：pi 的 entry 已是有序链表 + 稳定 id，`parentId`/user 边界/tool summary 就是现成的「索引 + 摘要」。外置搜索库解决的是「百万级文档的关键词倒排」，我们的场景是「单文档的顺序遍历 + 窗口提取」——链表游标比倒排索引更合适，且零依赖。

## 4. 详细设计（已实施）

### 4.1 索引层：主进程 `searchSession`

```
IPC: searchSession(key, query, opts?) → { total, hits: [{ entryId, role, preview, at }] }
```

- 只在主进程做（renderer 无 fs）：扫 `cache.get(key).history.entries`（已全量解析，O(n) 字符串包含匹配，205MB 实测 <100ms）
- `opts.limit`（默认 50）+ `opts.before`（游标分页，防大会话一次回万条）
- 命中回传 **entryId + preview（截断到 200 字）+ role + 时间**——不回全文
- 命中点击 → `history(key, leaf, {before: entryId, count})` 已有的补拉链路把那段取回来 → 渲染层高亮

### 4.2 摘要层：轮次地图（`sessionOutline`）

```
IPC: sessionOutline(key) → { turns: [{ entryId, title, at, hasImages, toolCount }] }
```

- 每个 user entry 是一个「章」：title = 用户消息首行（截断 80 字），toolCount = 该轮 tool 数，hasImages = 是否含图
- 侧栏/顶部「会话地图」：点一章 → 同 §4.1 的取回链路定位
- 这是零成本的：entries 已全量在内存，聚合一次 O(n)

### 4.3 图片层：按需水合（`imageById`）

```
IPC: imageById(key, entryId) → { data, mimeType } | { error }
```

- branch 里 image part 只带 `ref: entryId`（**不传 base64**）——205MB 会话的 26MB 图片不再随每次 IPC 传输
- 渲染层 `<HeldImage>` 首帧只渲染占位（骨架/图标），IntersectionObserver 进视口才 `imageById` 取回 → `acquireImageUrl` 编码
- 灯箱放大：同 IPC 取原图（已有 `onDownload` 链路复用）

> 实施状态：§4.1/§4.2 已落地（本轮），§4.3 待做（触及 `historyToMessages` 的 part 形状 + 主进程新 IPC，改动面独立，见 §5）

## 5. 分阶段实施

**已实施（本轮，main）**：
1. 历史分页补拉（首屏 500 + `loadEarlierHistory` + 两级按钮 + 触底自动补）——打开快 + 历史可达
2. StrictMode 图片引用泄漏修复（acquire/release 只在 effect）——预览恢复 + 内存不再只涨
3. atob 前剥空白（pi 可能 wrap 长 base64）——防静默降级 data URL
4. 主进程 pinned 穿透（`workflowSnapshots`）——老工作流卡片终态校正

**下一步（按收益排序）**：
1. §4.1 `searchSession` + UI（会话内搜索框，⌘F 对标）——用户明确要的「通过索引摘要准确搜索」
2. §4.2 `sessionOutline` + 会话地图侧栏——长会话导航
3. §4.3 图片按需水合——把 26MB 图片从 IPC 通道拿掉
4. `entry_appended` 推送替代活跃会话文件轮询——省主进程 watch/defer 解析

## 6. 测试策略

- 分页：`history-paging.test.ts`（before 无重叠/严格递增）+ `history-paging-ui.test.ts`（按钮真实剩余量/加载态）
- 图片：`image-url-cache.test.ts`（引用计数/淘汰 revoke/指纹防串图）+ 真实 base64 编解码（Node + 浏览器双路径）
- 搜索/大纲（实施时）：命中窗口与 `history(before)` 的衔接、query 为空/超长、limit 分页游标

## 7. 盲区与待拍板

- **搜索范围**：只搜 branch（当前分支）还是含 abandoned branches？建议前者（与渲染一致），用户确认
- **摘要语言**：`sessionOutline` 的 title 直接取用户消息原文（不做 LLM 摘要）——零成本但依赖用户提问质量；LLM 摘要需模型调用，列为可选增强
- §4.3 图片按需水合会改变 `MessagePart` 契约（image part 的 `data` 变 `ref`），需同步 `subagents.ts`/`SidecarPanel` 等使用方——**建议单独 PR**
- 本设计未覆盖「跨会话全局搜索」（多会话索引）——那是另一个量级（需要持久化索引文件），用户若要再评估
