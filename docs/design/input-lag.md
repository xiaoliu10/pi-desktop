# 大会话输入卡顿：定位与修复设计

> 真实意图：用户反馈「时间久一点的 session 就很卡——打字卡、输入卡」。找出根因并给出分阶段修复（最小切片优先）。
> 日期：2026-10-16 ｜ 状态：定位完成，待拍板切片顺序 ｜ 调研：3 路子代理（Electron 官方机制 / 同类聊天 UI / pi 内核契约）+ 本机实测

## 1. 规模证据（本机实测）

| 会话文件 | read | parse | 消息数 | 图片 |
|---|---|---|---|---|
| 201MB / 2345 行 | 666ms | 396ms | 1334（u53/a1281） | 117 张 base64 |
| 144MB / 4537 行 | 1292ms | 384ms | 2454 | 83 |
| 95MB / 20122 行 | 257ms | 344ms | **12930** | 136 |
| 52MB / 8939 行 | 117ms | 208ms | 6238 | 96 |

275 个 session；`MAX_SESSION = 512MB`。附加实测：`v8.serialize` 60ms + `deserialize` 85ms（IPC 结构化克隆下界），解析后对象堆 ~422MB。

## 2. 根因排序（外部证据交叉后修正）

### H1（第一嫌疑）主进程同步阻塞 ≈1.06s/次
- **Electron 官方原文**（docs/tutorial/performance.md §3）：主进程 "also houses the UI thread… Under no circumstances should you block this process"；"When the operating system tells your app about a mouse click, **it'll go through the main process before it reaches your window**" → 主进程阻塞直接表现为输入延迟。
- 触发面（pi-side 实读代码确认）：每次 `message_end`/`agent_settled`/`sessions-changed`/**窗口聚焦**都走 `history()` IPC；`history()` 先 `scan()` 全扫 275 会话，流式期间还**同步重解析 dirty 文件**（`session-index.ts:184`），把 DEFER_PARSE 节流完全抵消。
- 官方建议：CPU 重活用 worker threads、同步 I/O 换异步。

### H2（第二）renderer 全树重渲染：memo 形同虚设
- **zustand 官方 README**：无 selector 的 `useStore()` "will cause the component to update on **every state change**"——`PiReplicaApp.tsx:154` 正是此模式。
- 150ms streamFlush → `set({live, toolProgress})` → 根组件重渲染 → `messages` useMemo 依赖 `s.live/s.toolProgress` 引用失效 → 全量重算 → ChatView 收新数组。
- **memo 击穿链**：`labels={t.chat}`（labelsFor 每次 render 新建对象，`PiReplicaApp.tsx:94/182`）→ ChatView memo 比较失败 → 60 个 TurnArticle 重渲染。
- React memo 文档原文："memoization is a performance optimization, not a guarantee"。

### H3（第三）DOM 长期驻留（**已降级**）
- ChatView 已有 `TAIL_WINDOW=60` 轮窗口 + 补载锚点保持（`ChatView.tsx:836`）——DOM 已受控，但 60 轮含工具卡/图片/markdown 仍可能远超 web.dev 1400 节点阈值，且 136 张 base64 图常驻堆 ~422MB。
- chat-virt 明确：「不能独立证明 DOM 比全量 IPC/main parse 更主要」。

### H4（第四）IPC 全量 200MB
- Electron PR #52920 实测 4MB IPC ≈ 9-14ms；200MB 外推数百 ms 级（**反面证据**：该 PR 只覆盖 4MB，外推不准，仅作量级参考）。

### H5（第五）pi 子进程 O(n²) 流式解析（上游 bug，只能缓解）
- pi issue #9265（open）：openai-completions 每 delta 全量重解析 tool-call JSON，"1 MB → ~1,400 ms"；bundled 1.2.0 与上游 main 均未修。冻的是 pi 子进程，但事件淤积后集中爆发，加剧流式卡顿（与已观察到的「进度卡住后集中刷出」互证）。

### 打字为什么卡（机制澄清）
Composer 键入本地优先（200ms 防抖才写 store，`ChatView.tsx:980` 注释"键入不碰全局状态"）——**卡不是按键触发 store，而是按键撞上正在进行的 150ms 全树重渲染 / 秒级 history 长帧**。

## 3. 修复方案（按 ROI 排序，每步可独立验证）

### 切片 1（最小，renderer，半天）：拆 selector + 稳定引用 — 治 H2
- `PiReplicaApp.tsx:154` 无 selector `usePiStore()` → 按字段订阅（或 `useShallow`）。
- `labelsFor` 结果 `useMemo([s.lang])` 固定引用（消除 ChatView memo 击穿的直接开关）。
- `messages` useMemo 把 `s.live/s.toolProgress` 依赖隔离：turn 列表本体不订阅 live，流式气泡由子组件订阅。
- 验证：流式期间 ChatView render 计数（console.log）应远低于每 150ms 一次；打字延迟下降。

### 切片 2（main，1-2 天）：history 增量 + 解析移出主进程 — 治 H1/H4
- **运行中会话**改走 RPC `get_entries(since=leafId)`（pi 子进程 SessionManager 直出，不碰磁盘、免 1s 解析）——pi RPC 已有此契约（rpc-commands.md："pass the last entry id you have seen as `since` to get only entries strictly after it"），**desktop 一直没用**。
- **落盘会话**：`parseFile` 移 worker_threads（官方首选；electron#18540 老版本崩溃史，现代版本 OK）+ 缓存 entries 按字节偏移增量 tail 解析。
- `history()` handler 去掉每次 `scan()` 全扫（改缓存 + 变更通知驱动）。
- 验证：main `history()` 包 console.time，聚焦/消息结束应 <50ms。

### 切片 3（可选，renderer）：虚拟化或 content-visibility — 治 H3
- 轻量先试：`TurnArticle` 容器 `content-visibility: auto`（Open WebUI 路线：尾部 8 条 + 向上增补 + content-visibility）。
- 彻底方案：virtua `VList`（LobeChat 同款），必须同时处理：图片预留尺寸（virtua README 明确 lazy loading 不能替代）、prepend 只在该帧启用 `shift`、流式行/选区行 keepMounted、跟随状态机（`atBottom && isGenerating && !isScrolling`）。
- 反面证据：虚拟化牵动选区/搜索/导航/图片灯箱生命周期，只换 `.map()` 不够；react-window 动态高度效率低。
- Blob URL 非自动省内存（保留 base64 再建 Blob 反而多一份）。

### 切片 4（观测，0.5 天）：埋点
- renderer `PerformanceObserver({type:'longtask'})` + Event Timing（`durationThreshold:16` 取 `processingStart-startTime` = 输入延迟）。
- 可选 Electron `contentTracing` 出 Perfetto。

### 切片 5（上游）：pi issue #9265
- 根治需上游修 O(n²) 解析；desktop 侧缓解 = 别在主进程同步消化爆发事件（切片 2 天然覆盖）。

## 4. 验证基线（先埋后改）
1. 打开 201MB 会话，打字 30 秒，记录 longtask 数量/总时长 + INP。
2. 流式期间 ChatView render 计数。
3. main `history()` 耗时 console.time。
4. 对照实验：只做切片 1 再测——若打字卡消失即定位 renderer 侧；若「聚焦/消息结束时仍整秒冻结」即 main 侧（切片 2）。

## 5. 盲区与待拍板
- **未在真机 trace 验证**：根因排序基于代码走读 + 本机 parse 实测 + 官方机制，未做 CDP/Perfetto 实机对比。建议先埋切片 4 再改。
- IPC 200MB 外推数据不准（#52920 只到 4MB）。
- pi #9265 上游未修，切片 2 只缓解。
- **待拍板**：① 切片顺序（我建议 1→2→4→3，即先半天拿 renderer 收益，再动 main）；② 切片 2 走 worker_threads 还是 RPC get_entries 优先（建议：运行中会话先走 get_entries，落盘会话后走 worker）；③ 要不要现在开 PR（一个 PR 一个切片，按仓库纪律）。
