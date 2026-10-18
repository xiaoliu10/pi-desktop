---
name: code-review
description: "提交前对当前改动做多视角代码审查：并行子代理分工审查（正确性/安全/范围），二次验证子代理复核每条 finding 消灭误报，最后按严重程度输出清单。当用户要求 code review / 审查改动 / review 一下 / 提交前检查时使用。"
argument-hint: "[目标分支，默认自动识别主干；或 --max-findings N]"
builtin: true
---

# 本地 Code Review（forked subagent 多视角 + 二次验证）

对标 Claude Code `/code-review` 的本地化形态：**跑在 forked subagent 里**（不占主对话上下文）、**多视角分工**、**每条 finding 二次验证后才进报告**（SWE-bench Verified 人审数据：61.1% 的测试会把有效解法误判为失败——审查同理，未经复核的 finding 大量是误报，浪费的不仅是时间还有信任）。

## 阶段 1：Find（并行子代理，≤3 个）

先确定 diff 范围：`$1` 指定目标分支时用它作基线，否则自动识别主干（main/master，用 `git symbolic-ref refs/remotes/origin/HEAD` 或常见名）。diff 超过 2000 行时先按 commit 或目录拆成多轮，每轮 ≤2000 行。

并行派发子代理（每个都带完整 diff 或让其自己 `git diff <base>...HEAD` 取）：

1. **正确性审查员**：逻辑错误、边界条件、错误处理、并发/时序、回归风险
2. **安全审查员**：注入（命令/SQL/XSS）、密钥硬编码、路径穿越、不可逆操作、依赖风险
3. **范围与惯例审查员**：超出任务范围的改动、与周围代码风格不一致、缺失的测试、半成品实现

每个子代理的指令模板：

> 审查这个 diff（基线 `<base>`）。只报告你能**指出具体触发路径**的问题：问题描述、文件:行号、什么输入/操作会触发、为什么是错的。不报告风格偏好、不报告你推测但没有证据的问题。每条 finding 附置信度（high/medium/low）。

## 阶段 2：Verify（二次验证，串行 1 个）

对阶段 1 的每条 finding（默认上限 10 条，`--max-findings` 可调），派发**验证子代理**（fresh context，看不到原审查结论，只看代码）：

> 有人报告 `<文件:行号>` 存在这个问题：`<描述>`。读相关代码判断：这是真问题还是误报？给出 verdict=confirmed / refuted / uncertain，以及支撑 verdict 的最小证据（引用具体代码行）。不确定时给 uncertain，不要猜测。

**只有 confirmed 的 finding 进最终报告**。refuted 的丢弃但计数（"审查员报告 N 条，验证后 M 条成立"——这个比例本身是对审查员的校准）。

## 阶段 3：Rank 与输出

按严重程度排序：**blocker**（会坏/不安全/丢数据）> **major**（明确错误或有隐患）> **minor**（小问题或改进建议）。

输出格式：

```markdown
## Code Review：<base>...<branch>（+X −Y，N 个 commit）

审查员报告 K 条 → 验证后 M 条成立。

### Blocker
- [文件:行号](路径) 问题描述
  - 触发：什么操作会触发
  - 修复：建议怎么改

### Major
…

### Minor
…

### 已排除
- <问题> — 验证子代理判定误报（<一句话理由>）
```

## 纪律

- **没有坐实的问题就明说**："审查员报告 8 条，验证后 0 条成立"是合法输出；为凑数虚构问题比空报告更糟
- **不自动修**：本技能只出报告，改不改由用户决定（对标 CC Code Review 的 "never approves or blocks"）
- **报告里区分事实与推断**：confirmed 的 finding 必须带触发路径；不确定的写进"待人工确认"
- 子代理用 fork/fresh context（`subagent_type: "fork"` 或派发时指定 fresh），审查员的推理过程不进主对话

## 降级路径

- 无子代理可用时：主会话内按三视角自查，仍执行「每条 finding 找具体触发路径」和输出格式（少了二次验证，报告里注明"未经二次验证"）
- 非 git 项目：无法取 diff 时直接说明，不猜测改动范围
