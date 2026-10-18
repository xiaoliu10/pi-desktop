# 缓存命中率优化调研

> 真实意图：Desktop 会话统计缓存命中率 90–93%，找出 miss 原因与可优化点 / 2026-10-14 / 数据分析完成（排查型产出）

## 1. 现状画像（本机三个大会话实证）

| 会话 | calls | 命中率 | zero-hit calls |
|---|---|---|---|
| pi-desktop 87MB | 5521 | 93.5% | 346 (6.3%) |
| ashare 151MB | 419 | 91.9% | 16 (3.8%) |
| litellm 40MB | 3331 | 93.3% | 234 (7.0%) |

**统计口径**（`src/shared/context-details.ts:14 cacheHitRateFromTotals`）：`cacheRead / (input + cacheRead + cacheWrite)`——
与智谱 `cached_tokens` 语义对齐，口径本身没有问题。

**关键特征：所有 miss call 的 `cacheWrite=0`**。上游智谱（bigmodel anthropic 兼容口）是**隐式自动缓存**：
未命中时不写缓存（无 cache_creation_input_tokens），与 Anthropic 显式 cache_control 语义完全不同——
意味着每次 miss 都是全额 input 计价，且**不存在「主动写缓存换后续命中」的机制**。

## 2. miss 归因（ashare 会话 16 个 zero-hit 逐条定位）

| 归因 | 数量 | 证据 |
|---|---|---|
| **闲置 TTL 过期** | 11/16 | miss 距上一请求 median 15min、max 3.5h；智谱隐式缓存 TTL 短（官方文档未公开数值，行业惯例 5–10min；我们 70–98s 的 quick-miss 说明实际可能更短或有多实例分片） |
| **compaction 重写历史** | 3/16 | 三个 compaction 事件后第一条请求全部 zero-hit——压缩重写消息数组，前缀全变必然全 miss |
| **模型切换** | 1/16 | ccr-opus→deepseek-flash，缓存键含模型 |
| 其余 quick-miss | 1 | 98s 内 input 1.5K→52K 突变，疑似中间发生了上下文改写 |

**请求构造侧已排除**（payload 实证 + 源码审查）：
- pi system prompt 无时间戳类 cache buster（35K system 里的日期全是记忆正文）
- CCR 已内置 cch= 稳定化（routes.ts:870）、system 消息前置去重（routes.ts:316）、pi 会话粘附头转 x-litellm-session-id（routes.ts:988）
- ccr-opus 模型层 `sendSessionAffinityHeaders:true` 在发（models.json 实证）；Desktop 侧无每请求变化注入

## 3. 可优化点（按收益排序）

### 3.1 闲置 TTL 过期（占 miss 的 69%）——**发版/闲置后首条消息全价**
- **不可完全避免**（隐式缓存无主动续期手段），但可以**观测+预算**：
- Desktop 改进 A（观测）：统计面板把「距上次请求间隔>5min 的请求」单列（`backend.ts` stats 已有 timestamps），让 90–93% 里的「结构性 miss」可见，不再笼统显示低命中率。
- Desktop 改进 B（预算提示）：会话闲置 >5min 后的首条发送，状态栏提示「缓存已过期，本条将全价计费」——用户可以选择先发小消息重建缓存。低优先级。

### 3.2 compaction 后全 miss（占 19%）——**结构性，但可减少 compaction 次数**
- compaction 频率直接乘进 miss 率。pi 的 compaction 由上下文占用触发；Desktop 侧可做的：
- 改进 C：`compact-phase-memory-plan` 上游在演进；保持 0.1.19 的 1.3.0 兼容窗口跟随升级即可。
- 改进 D（可选）：compaction 结束后 Desktop 自动发一条「缓存预热」小请求？——**不推荐**：同样全价计费且污染对话流，收益为零（那条请求自己也是 miss）。

### 3.3 真正的杠杆：**提高「会话内连续交互」密度**
- miss 集中在「闲置后第一条」：11/16 的 miss 之前都有 ≥5min 空窗。连续交互时（gap<60s）命中率实测 ≈99%+（ashare 会话连续段 cr 稳定递增）。
- 结论：**90–93% 是「人工作息 + 隐式短 TTL」下的自然稳态**，不是请求构造 bug。想显著超过 95% 需要上游支持显式缓存写（cache_control 长效缓存），这取决于智谱 API 而非 Desktop。

## 4. 上游机会（写给 CCR/智谱的后续动作）
- 智谱 anthropic 兼容口若支持 `cache_control` 显式标记（Anthropic 语义），Desktop/pi 侧已有 `supportsCacheControl*` compat 开关可即时接上（pi `packages/ai/src/providers/anthropic.ts` 已实现该协议面）。
- CCR 侧 `x-litellm-session-id` 粘附只对 LiteLLM 类网关有意义；直连智谱时无对应的实例亲和机制——若智谱多实例分片缓存，可向其反馈「按会话 ID 亲和路由」的需求。

## 5. 盲区与结论
- 智谱实际 TTL/实例分片策略未公开（官方文档无 TTL 字段；70s quick-miss 提示可能存在实例级缓存分片，未证实）。
- **结论：当前 90–93% 不是 Desktop 的 bug**。请求构造侧干净；miss 主体是隐式缓存 TTL + compaction 结构性代价。
- 建议动作：改进 A（miss 分类统计，让数字可解释）值得做；其余为上游侧机会。
