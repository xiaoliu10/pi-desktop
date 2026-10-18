# 大会话输入卡顿 Phase 2：流式增量隔离方案

> 真实意图：用户反馈「对话框打字还是很卡」——切片 1（labelsFor，#120）上线后体感未改善，需要找出剩余根因并给出可落地的分阶段修复。
> 日期：2026-10-16 ｜ 状态：待评审 ｜ 前置：[input-lag.md](./input-lag.md)（根因 H1–H5 与外部调研，同日完成，本篇复用其结论不重复派发外部调研）

## 0. 先澄清一个事实

**用户当前运行的 0.1.25 不包含任何主进程修复**：切片 2a/2b（history() 去全扫 + 增量 tail 解析，实测 421ms→6.3ms、173ms→0ms）在 PR #128，review 中未合并发版。所以「还是很卡」符合预期——主进程侧的修复还没到用户手里。

但这**不能**解释全部：渲染侧存在与主进程无关、且完全未被修复的重渲染链（下文 R1–R3，全部代码实锤）。即使 #128 发版，流式期间的每 150ms 渲染长帧仍会卡输入。

## 1. 现状与接入点（全部代码实锤）

### 1.1 流式渲染链（改动前）

```
pi delta → (RPC 事件) → adapter.scheduleStreamFlush
  → 每 150ms flushStreamEvents(): set({ live: {...live}, toolProgress: {...toolProgress} })   [adapter.ts:1161-1167，每拍新引用]
  → PiReplicaApp usePiStore() 无 selector                                                        [PiReplicaApp.tsx:168] ★R1
  → 根组件全树重渲染
  → messages = useMemo(sentConversationMessages(...), [s.history, s.live, s.toolProgress, …])  [PiReplicaApp.tsx:252-255] ★R2
     live/toolProgress 每拍新引用 → 22719 条 entries 每 150ms 全量重建 ChatMessage 对象
     （historyToMessages 逐 entry new + segment 切片 + branchEntries 重建）
  → <ChatView messages={messages}> — memo 被 messages 新数组击穿                                 [ChatView.tsx:717]
  → 60 轮 <TurnArticle m={turn}> — memo 被 m 新引用击穿（turn 每拍重建）                          [ChatView.tsx:577] ★R3
     labels 已稳定（#120）救不了：m 本身每拍都是新对象
```

### 1.2 打字为什么卡（机制）

Composer 键入本地优先（`setLocalText`，200ms 防抖才上报 store，`ChatView.tsx:988-1030`）——**键入本身不触发渲染**。卡 = 键盘事件处理被主线程上正在跑的渲染长帧排队：R2 的全量重算（万级 entries 的对象重建）每 150ms 占用主线程几十 ms，加上 R1/R3 的 reconcile，帧预算被吃光 → 按键到上屏延迟数十至数百 ms 抖动。主进程阻塞（H1）再叠加：IPC 事件本身也挤在同一事件循环。

### 1.3 根因清单（本轮重新排序）

| # | 根因 | 状态 | 证据 |
|---|---|---|---|
| H1 | 主进程：history() 全扫 + dirty 全量重解析 | **已修（#128 未发版）** | 实测 421ms→6.3ms、173ms→0 |
| R1 | 根组件 usePiStore() 无 selector，每拍全树重渲染 | 未修 | PiReplicaApp.tsx:168 |
| R2 | messages 每 150ms 全量重算（万级 entry 对象重建） | 未修 | PiReplicaApp.tsx:252-255 + adapter.ts:367/144 |
| R3 | TurnArticle memo 被 m 新引用击穿，60 轮全重渲染 | 未修（R2 的下游） | ChatView.tsx:577 |
| H3 | 60 轮 DOM 驻留的 layout/paint 成本 | 未修（轻量解见 §3） | ChatView TAIL_WINDOW=60 |
| H5 | pi 子进程 O(n²) 流式解析 | 上游未修（#9265） | 只能缓解 |

## 2. 外部调研结论（复用 input-lag.md 同日调研）

- zustand：无 selector 的 `useStore()` 每次状态变化都重渲染（官方 README 原文，input-lag.md §H2 已引）——R1 的解法是 selector + 严格相等标量/`useShallow`。
- Electron：主进程阻塞直接表现为输入延迟（官方 performance.md，已引）——H1 修复（#128）有效但需发版。
- 同类聊天 UI：Open WebUI 用 `content-visibility: auto` + 尾部窗口；LobeChat 用 virtua VList 但反面证据明确（牵动选区/搜索/导航/图片灯箱，input-lag.md §切片 3）。
- 未新增外部调研的理由：问题定义与同日调研一致，变化在内部状态（切片 1 半成品 + R2 实锤）；按「先内后外、外部结论必须落地」原则，本轮预算花在内部实锤与分段语义上。

## 3. 方案对比

### 方案 A（推荐）：流式增量隔离——历史段与活动段分离

把「每 150ms 都在变的」与「几乎不变的」在数据层切开，让 memo 重新生效：

- **A1 messages 两段化**：`sentConversationMessages` 拆为
  - 历史段 `historyTurns = useMemo(…, [s.history, s.sends(已确认部分)])`——流式期间**引用与内容都稳定**；
  - 活动段 `activeTurns = useMemo(…, [s.live, s.toolProgress, s.sends(未确认)])`——只含最后一轮（几十条 entry），每拍重算成本小三个数量级；
  - 渲染 `[...historyTurns, ...activeTurns]`：数组每拍新建无害，turn 对象引用稳定后 R3 自然消失。
- **A2 根组件拆 selector**：PiReplicaApp 不再整树订阅 `live/toolProgress`；活动段的下沉到尾部流式组件（或以 selector 传入）。
- **A3 尾部隔离**：正在流出的最后一轮单独组件承载 live 订阅，中间轮次零渲染。

改动面：`adapter.ts`（sentConversationMessages 拆分，segment() 已按 owner 切好，历史段=确认边界前）、`PiReplicaApp.tsx`（selector + 两段拼接）、`ChatView.tsx`（props 微调）。**不动 IPC 契约、不动主进程。**

风险：分段语义（sends 锚定、confirmed 边界、late-result 归属）必须与现行为一致——1494 个测试兜底 + 现有 sentConversationMessages 测试可搬。

### 方案 B（辅助）：content-visibility

TurnArticle 容器 `content-visibility: auto; contain-intrinsic-size: auto 220px;`——离屏轮次跳过 layout/paint。一行 CSS 级改动，可独立回滚。不解决 JS 重算，只治 paint；作为 A 的补充。

### 方案 C（不推荐现在做）：virtua 虚拟化

反面证据充分（选区/搜索/导航/灯箱生命周期），等 A+B 落地后仍有感知卡顿再评估。

### 方案 D（推迟）：2c 运行中会话走 RPC get_entries(since)

H1 被 #128 大幅缓解（421ms→6.3ms）后边际收益变小；且动 RPC 消费链，放最后。

**为什么不用更简单的替代**：只做 B（CSS）不碰 A——paint 只占长帧的一部分，R2 的 JS 重算（万级对象重建）是主线程大头，CSS 治不了；只做 A1 不做 A2——根组件仍每拍重渲染，虽然 memo 能挡住子树，根组件自身的 element 树重建（上百个组件的 createElement）依然每拍发生，A2 是把这部分也省掉。

## 4. 分阶段实施（每步可独立验证、独立发版）

| 步 | 内容 | 验证 | 规模 |
|---|---|---|---|
| 1 | **A1 两段化**：adapter 导出 `splitConversation(branch, sends)` → `{historySource, activeSource}`；PiReplicaApp 两个 useMemo；拼接处保持现 id/顺序 | 计时打点：流式 60s，messages 重算耗时从每拍几十 ms → 活动段 <1ms；ChatView render 次数从 ~每拍一次 → 仅 history 变化时；全部既有对话测试过 | 1 天 |
| 2 | **A2+A3 selector 下沉**：根组件按字段订阅；live/toolProgress 只进尾部组件 | React Profiler：流式期间非尾部 TurnArticle 零渲染 | 1 天 |
| 3 | **B content-visibility** + 滚动锚点回归 | 视觉回归 + 滚动/选区/查找手测 | 半天 |
| 4 | 合并发版 #128（主进程） + 上述内容 → 0.1.26 | 用户体感 + 打字延迟打点（keydown→上屏 P95） | — |

测试策略：现有 sentConversationMessages 单测搬一半到 splitConversation；新增「流式期间历史段引用稳定」断言（防回归的的关键不变式）；浏览器冒烟打字延迟对比（0.1.25 vs 修复后，同一大会话 fixture）。

风险与回滚：分段切错的表现是「消息丢失/顺序错乱/optimistic 气泡归属错误」——全部有单测覆盖面；任一步出问题可独立 revert（三步互不阻塞）。

## 5. 盲区与待拍板

- **未做端到端帧级 profiling**：R1–R3 的推断链完整（代码+机制），但没有 CDP 实测「每拍渲染占主线程多少 ms」的分布。若需要精确基线，实施第 1 步时先加 performance.mark 顺带产出。
- **conversationMessages 的 live 合并语义**（savedMessages/turnId 归属）在活动段拆分中的边界需要实现时逐条对照，测试搬移可能发现新分支。
- **待拍板**：三步是连做（一个 0.1.26）还是分开发版？推荐：步骤 1+2 合一个 PR（同一主题的完整闭环），B 单独小 PR，#128 优先合并。
