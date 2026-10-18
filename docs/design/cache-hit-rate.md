# Desktop 缓存命中率优化——调研与设计

> 真实意图：Desktop 会话命中率不稳定（观测 93.8%），对照 ZCode 的高命中率找可借鉴机制，落到可实施改进。
> 日期：2026-10-15 · 状态：待评审
> 数据基线：本会话（1790689…jsonl，6088 次成功 assistant 调用，ccr-opus 经 CCR→智谱）

## 0. 结论（TL;DR）

**Desktop 侧的显式缓存与会话亲和已经存在且开着**（本机 mock-fetch 实证，见 §1.3）——不是「Desktop 没做」。
**本会话不同 `responseModel` 的命中率相差最多 13.6 个百分点**（glm-5.3-flash 94.6% vs qwen 96.9% vs glm-5.2 88.8%），
低命中样本**约 42% 相邻响应模型没变**（122/211），说明不能把所有低命中归因于上游切换；也有约 42% 伴随模型切换（89/211），
符合 CCR 官方口径「模型不可用时才切换」。因此本节不再给「可节省 token」估计，而是给出**可证实、可归因**的改进：
面板增加按响应模型分组的缓存命中拆解，把「谁在低、什么时候低」变成可验证事实，再决定是否治理。

## 1. 现状与接入点（事实：代码路径/本机数据/mock 请求实证）

### 1.1 命中率量化（本会话，6088 次成功调用）

- 累计：`input=79,936,479`、`cacheRead=1,207,652,460`、`cacheWrite=0` → 加权命中率 **93.79%**。
- 短间隔(<300s)低读样本 211 次中，**相邻 `responseModel` 未变 122 次（57.8%）**、变化 89 次（42.2%）。
  （口径：成功且用量为正；`responseModel` 缺失记为 '(unreported)'；历史配置不回溯推断。）
- 按响应模型的加权命中率差异明显（详见 §4.1 表），是「低命中到底是谁贡献的」最直接的线索。

### 1.2 统计口径与可达性

- 面板命中率 = `cacheRead ÷ (input + cacheRead + cacheWrite)`（`ConversationStatusPanel.tsx:152`，tooltip 已写口径）。
- **当前面板只有会话累计值**，没有「最近 miss / 按模型拆分」，用户无法判断 93.8% 是被哪类调用拉低的。
- 跨产品对比必须统一口径：ZCode 日志的 `inputTokens` 已含 cacheRead（`glm/zcode.cjs:2031 u8r`），
  直接套 pi 公式会把 97.58% 算成 49.39%；本报告统一用 `cacheRead ÷ (input + cacheRead + cacheWrite)`。

### 1.3 Desktop/pi 侧已存在的能力（纠正初版误判）

| 能力 | 证据 | 现状 |
|---|---|---|
| 会话亲和 header | 本机 `~/.pi/agent/models.json` 中 ccr 三个模型 `compat.sendSessionAffinityHeaders=true`；pi-ai `anthropic-messages.js:818-821` 据此发 `x-session-affinity`（非 openrouter 格式）；mock-fetch 实证 header 值 = 传入稳定 sessionId | **已开启** |
| 显式 cache_control | pi-ai `anthropic-messages.js:31-38 getCacheControl` 默认 `cacheRetention="short"` → `{type:"ephemeral"}`；`:1226-1234` 把它加到「最后一条 user/system」；`:1323` 加到 tools 末项；mock 请求实测 1 个标记 | **默认开启**（无显式 `PI_CACHE_RETENTION`） |
| 1h TTL | `:31-38`：`retention==="long"` 且 `supportsLongCacheRetention` 才加 `ttl:"1h"`；env `PI_CACHE_RETENTION=long` 可切 | 未启用（GLM 兼容口是否支持未证实） |
| ZCode 对照 | `glm/zcode.cjs:14618` 会话初始化快照；system 3 段各带 `cache_control`（376 个标记）；工具 122 个顺序稳定；消息 append-only（5,758 条重叠 0 正文改写） | 借鉴对象 |

- **desktop-policy 每轮返回 systemPrompt 的风险链**（上游 #10489/#10024）：`agent-session.js:1316-1322` 的 forced-prompt 投影会把
  system 折叠为「forced 文本 + 当前 tools」的头部。访问模式不变时文本不变、不产生新 diff，**当前不是已证实的 miss 主因**；
  但每次模式切换（plan↔执行）都会改写该头部——值得在面板分组后验证，而不是先改。

## 2. 外部调研要点（只记与决策相关）

- Anthropic：缓存前缀顺序 `tools → system → messages`，层级失效；默认 5min TTL、命中免费续期；显式断点 ≤4 个。
- GLM：仅隐式缓存文档，无 TTL/粒度公开；建议前缀 ≥500 token；命中约 5 折；观察命中片段均为 64 的倍数（64-token 块，推断）。
- Claude Code：断点放 system 尾部/末条消息；system 按 cacheScope 分区；`cache_touch` 心跳仅第一方直连+1h 订阅，走 CCR 强制关闭（不可借鉴）。
- CCR：`concurrency-router.ts` 的会话粘连 = `sessionId:family:scenario` 绑定，**只有绑定模型不可用才换**；另一条路径是
  `Router.enableConcurrencyPriority` 的并发溢出（达到 in-flight 阈值也会把新 session 分到 fallback 模型）。
  pi 的 `models.json` 未配 `enableConcurrencyPriority`（本机 config 无该键），因此当前以「不可用才换」为主。

## 3. 方案对比与推荐

| 方案 | 改动面 | 风险 | 收益可证性 |
|---|---|---|---|
| A. 面板加「按响应模型分组的命中率 + 最近低读样本」 | Desktop 渲染层 + 已有 session 解析 | 低（只读统计） | **高**：直接回答「谁在低」 |
| B. 强制 cacheRetention=long / 1h TTL | pi 请求参数（env 或 provider 配置） | 中：GLM 兼容口未承诺支持；写贵 | 需 A/B 实测 |
| C. 改 CCR fallback/并发阈值 | 用户本机 CCR 配置 | 中：影响其他客户端 | 需 A 先证实切换占比 |
| D. desktop-policy 去每轮 systemPrompt | Desktop 扩展 | 低-中 | 待 A 验证模式切换是否贡献低读 |

**推荐 A**：它不猜根因，只把已有数据（session jsonl 里每条 assistant 都有 `responseModel`+usage）变成可见事实；
B/C/D 都等 A 的数字再决定。理由：本会话 57.8% 的低读样本模型未变，先动路由/参数是在没有归因的情况下优化。

## 4. 详细设计（推荐方案 A）

### 4.1 数据流（改动后）

```
session jsonl（已有，无需新采集）
  → 主进程按 key 解析：assistant 成功调用 → {responseModel, input, cacheRead, cacheWrite, ts}
  → 聚合：{累计命中率, 按模型: {calls, hitRate}, 最近N条低读: {ts, model, input, cacheRead}}
  → 面板「缓存命中率」行 tooltip 展开 + 新增「按模型」小表
```

### 4.2 文件级改动清单

- `src/main/pi/session-size.ts`（或同级统计模块）：新增纯函数 `cacheBreakdown(entries)` → 上述聚合结构（无 IO）。
- `src/shared/pi.ts`：`PiSessionStats` 增加可选 `cacheByModel` / `cacheLowReads`（可选字段，旧客户端忽略）。
- `src/main/pi/backend.ts`：stats 聚合处填充新字段（复用现有 usage 累加路径）。
- `src/renderer/pi/ConversationStatusPanel.tsx`：命中率 title 改为含「按模型」明细；`title` 里给 top 3 模型命中率。
- 测试：`tests/*.test.ts` 新增 `cacheBreakdown` 单测（含 responseModel 缺失、用量为 0、错误消息不计入）。

### 4.3 分阶段实施

1. **最小切片**：只做 tooltip 文本聚合（不碰 IPC/类型），先让「按模型命中率」可见。
2. 第二步：`cacheByModel` 进 stats + 面板小表（可折叠）。
3. 第三步（可选）：低读样本列表（最近 20 条 + 时间 + 模型 + 未命中占比），用于后续验证 B/C/D。

### 4.4 测试策略

- 纯函数单测为主（构造 session entries fixture：多模型/缺失字段/0 用量/错误消息）。
- 不引入浏览器测试（面板为纯展示，逻辑在纯函数）。

### 4.5 风险与回滚

- 统计口径漂移：新字段必须复用同一公式；在 tooltip 明示口径。
- 大会话解析开销：聚合在已有 stats 遍历里完成，不新增 IO；低读样本限长。
- 回滚 = 去掉新字段渲染，纯函数保留无副作用。

## 5. 盲区与待拍板

- **未证实**：低读样本的成因（上游切换 vs 前缀改写 vs TTL）——本报告刻意不给占比结论，等 A 落地后用数据说话。
- **未复算**：ZCode 93.7% 对照值来自调研引用，本报告只独立复算了 ZCode 自身样本（97.58%）。
- **待拍板**：是否先实施 A（推荐）？B（1h TTL）是否值得在 A 之后做小样本 A/B？C/D 是否等 A 的数字？
