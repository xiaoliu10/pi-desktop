# 大会话性能治理（renderer 51% CPU / RSS 3.3G）调研与设计

> 真实意图：用户 0.1.27 重启后仍「卡卡的」，明天验收。/ 日期：2026-10-18 / 状态：已实施（PR #138 后段）

## 1. 现状与量化（内部分析，全部实测）

**问题会话**：`1790689427762_*.jsonl`，105MB / 27219 条 / 8421 toolCall / 2414 thinking / 143 图 37MB（用户当前活跃、流式输出中）。

逐层测量（vitest + 真实会话数据，`路径:行` 为实现位置）：

| 层 | 实测 | 判定 |
|---|---|---|
| 数据层 `sentConversationMessages` + `executionTurns(limit)` | 6-10ms/拍 | ✅ 预算内（此前 PR 已修） |
| 全部 16879 个 tool 参数 JSON.parse | 13ms | 非瓶颈 |
| **ChatView 60-turn 窗口 SSR** | **289-379ms/拍，HTML 2.3MB** | **真凶** |
| sample 主线程（pid 91927） | 40% 字体光栅化（fontations_ffi/BridgeBitmapGlyph）+ ArrayBuffer 风暴 | 与上互证：巨量文本节点布局 |

根因机制：`<details>` 折叠是**浏览器**行为，React 此前**无条件构建**折叠子树——
`ExecutionGroup`（组级 steps）→ `ToolCard`（detailLines/pre/diff）→ `ExecutionNote`（思考正文）
三层全部如此。60 turn 窗口里每拍创建几十万个 element。

## 2. 外部调研（两个 researcher，均超时但产出可用材料）

### 2.1 上游 pi v1.3.0（源码核对，earendil-works/pi）
- `get_entries` 有 `since` 游标（`rpc-mode.ts:636-647`，entry id 即 durable cursor），**无分页参数**（27 个命令通读）——desktop 的 SessionIndex 文件直读（`src/main/pi/session-index.ts`）是唯一可行路径，保留 ✓
- **`entry_appended` 推送事件**：活跃会话可用推送替代文件 watch+256KB defer 轮询（后续优化项）
- desktop 未用 `get_entries`（初始全量必超 16MB 帧上限）——不是重复造轮子

### 2.2 VSCode 聊天面板（transcript 抢救，chatMarkdownContentPart.js）
- **incremental morpher**：`tryIncrementalUpdate`/`tryMorph` append-only 更新，流式期间不重渲染整个 markdown；按 stream-rate 估算喂 morpher buffer
- 对本项目的适配：完整 morpher 改动大；**等价降级 = 解析频率与 delta 频率解耦**（StreamMarkdown 节流），已实施

### 2.3 反面证据
- 「折叠 details 仍含 body」是 React 生态常见盲区（测试全绿但 DOM 全量）——6 个既有测试正是钉着这个反契约

## 3. 已实施（PR #138 后两个 commit）

| 修复 | 位置 | 效果 |
|---|---|---|
| tail 传输分页（{tail}/{before,count}） | session-index.ts `fromCache`、adapter.ts | 传输 205→55MB；**主进程实测 99.5%→14.1%**（用户环境） |
| 三级折叠门控 + ToolCard memo | ChatView.tsx（组级/ToolCard/ExecutionNote） | HTML 2.30→1.40MB（-39%）；折叠层零构建 |
| StreamMarkdown 流式节流 | ChatView.tsx（≥400ms 才重渲染 live 文本） | 长输出期间 markdown 重解析频率 150→400ms+ |

**契约变化**：折叠 details 的 body 不再进 DOM（6 测试反向钉住）；ToolCard/ExecutionNote 增 `defaultOpen` 测试口子。

## 4. 后续（未排期，按收益排序）

1. **`entry_appended` 推送**替代活跃会话文件轮询（省 watch/defer 解析；上游现成能力）
2. VSCode 式 morpher（append-only markdown 增量渲染）——若 400ms 节流的「分块出现」观感不满意再做
3. 图片按 id 懒加载（branch 里放 ref 占位，点开才拉原图）——尾部 500 条仍有 29 张 ≈48MB
4. `get_entries since` 用于断线重连后的增量补齐（当前全量刷新）

## 5. 盲区

- StreamMarkdown 的 400ms 延迟会让流式文本「分块出现」——观感需用户验收拍板
- RSS 3.3G 的完整构成未做 heap snapshot（CDP 未开）；三级门控预计显著降低（DOM/element 减半以上），但 s.history 的 195MB base64 字符串仍常驻（第 3 项后续才能根治）
- 折叠态 body 不进 DOM 对「页面内搜索（⌘F）」不可见——浏览器原生搜索找不到折叠内容（原行为折叠也不可见，无回归）
