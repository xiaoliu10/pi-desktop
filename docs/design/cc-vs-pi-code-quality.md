# CC vs pi 代码质量差距：逆向与设计

> 真实意图：定位 Claude Code 内置 prompt 里「提升代码质量」的机制，与 pi 逐条 diff，产出可借鉴落点。
> 日期：2026-10-15 ｜ 状态：已落地（quality-prompt 扩展 + verify skill）｜ 调研：CC v2.1.300 二进制逆向 + Piebald 社区镜像交叉验证（零差异）

## 1. 现状与接入点（pi 基线）

pi 的 system prompt 仅 7 段：1 句 preamble、工具列表、rules（= 各工具 toolGuidelines + promptGuidelines + 「Be concise」「Show file paths」）、docs 指针、addendum、AGENTS.md、skills。**零**质量类指令（规划/验证/惯例/范围/根因）。
接入点：`before_agent_start` 改 `systemPromptOptions.promptGuidelines`（加法式）；skills 按需加载；AGENTS.md；上游 pi issue（compact prompt）。

## 2. 外部调研（逆向 + 交叉验证）

### 2.1 逆向方法与可信度
- 二进制 `/opt/homebrew/.../claude-code/bin/claude.exe`（v2.1.300，249MB Bun Mach-O），prompt 以 UTF-16-LE 嵌入；**同一 bundle 有两份副本**（85.3M/205.6M），统计须去重。
- 交叉验证：`Piebald-AI/claude-code-system-prompts`（12,918★，版本精确对齐 v2.1.300，934 个 prompt 文件）与二进制逐字零差异 → 可直接引用社区镜像。
- **过期材料警示**：`# Proactiveness`/`# Following conventions`/`# Code style` 三个老 dump 经典 header 在 v2.1.300 **0 命中**；引用它们的分析已失效。

### 2.2 CC 质量机制清单（verbatim 摘录，偏移可复核）
| # | 机制 | 代表原文 | 出处 |
|---|---|---|---|
| M1 | 反过度工程 | "Don't add features… **Three similar lines is better than a premature abstraction.** No half-finished implementations." | 85350240 |
| M2 | 反冗余错误处理 | "Only validate at system boundaries… Don't use feature flags or backwards-compatibility shims." | 85350576 |
| M3 | 注释 WHY-only | "Default to writing no comments… Don't reference the current task, fix, or callers… **rot as the codebase evolves**." | 85350872/85351140 |
| M4 | 惯例遵循 | "**Write code that reads like the surrounding code: match its comment density, naming, and idiom.**" | outcome-first 段 |
| M5 | 功能级验证 | "Type checking and test suites verify code correctness, **not feature correctness**… if you can't test the UI, **say so explicitly**." | 85351428 |
| M6 | verified vs assumed | "Do not assert assumptions as facts."（紧邻 A/B flag `tengu_verified_vs_assumed`） | 85353496 |
| M7 | 禁兼容墓碑 | "If you are certain that something is unused, you can delete it completely." | 85353244 |
| M8 | 探索性问题不动手 | "respond in 2-3 sentences… **Don't implement until the user agrees.**" | 85352948 |
| M9 | Plan mode 硬闸 | "MUST NOT make any edits… **This supercedes any other instructions**… You cannot leave plan mode yourself." | 85346612 |
| M10 | 复用优先+fan-out 上限 | "Actively search for existing functions… **minimum number of agents necessary (usually just 1)**." | plan 5-phase |
| M12 | Verify skill | "The evidence is stdout/stderr/exit code." + Claim→Inference→Plan→Execute→Verdict + "What FAIL looks like" | skill（按需） |
| M13 | review 三态投票 | 每 finding 过独立 verifier → CONFIRMED/PLAUSIBLE/REFUTED，留前两者 | skill（按需） |
| M14 | conventions 只认可引用 | "Only flag a violation when you can **quote the exact rule and the exact line**… If no CLAUDE.md applies, return nothing." | skill（按需） |
| M15 | AGENTS.md 反模板化 | 禁通用开发实践/禁编造章节/禁罗列可发现结构 | /init agent |
| M18 | 不可逆+忠实报告 | "Before deleting or overwriting, **look at the target**… if tests fail, say so with the output." | 85398826 |
| M19 | OWASP 具名 | command injection/XSS/SQL injection 具名 + 自纠义务 | 85352684 |
| 机制1/6/8/9/12 | 验证强制/完成闸门/范围纪律/不过度自纠/推进纪律 | "prove the code works, don't just confirm it exists" / "Never mark completed if tests failing" / "don't quietly narrow, widen, or transform" / "don't add apologies" / "size of a task is not a reason to check in first" | coordinator/TaskUpdate/CLI/Corrections |

### 2.3 反面证据（保留）
- **堆 prompt 不根治偷工**：三个社区项目专治 CC——lobotomized（de-bloat）、unnerfcc（un-nerf）、claude-proxy（"fix corner-cutting behavior"）。即 CC 有全套质量规则仍被观察到偷工。
- **质量是买来的**：Ultracode 明写 "token cost is not a constraint"。
- **硬性 todo 曾产噪声**：reminder 自带 "ignore if not applicable"，官方主动降级为 nudge。
- **金句仍在 A/B**：`tengu_verified_vs_assumed` 等 flag 紧贴质量规则 → 连 Anthropic 都未定论。
- **无基准数据**：「CC 比 pi 好」目前仅用户主观 + prompt 结构差异支撑，无公开 benchmark（本轮缺口）。

## 3. 方案对比与推荐

- **方案 A 整包替换**（社区 `@ryan_nookpi/pi-extension-cc-system-prompt`）：仅 `claude-*` 模型生效 + 丢 pi 工具接线 → **否**。
- **方案 B 全量搬运 934 文件**：反面证据证明臃肿本身是病（de-bloat 项目存在）→ **否**。
- **方案 C（推荐，已落地）分层移植**：
  - 常驻层：~14 句高密度硬规则 → `quality-prompt` 扩展（promptGuidelines 加法式，模型无关，`PI_QUALITY_PROMPT=off` 可关）。
  - 按需层：长流程 → skills（`verify` skill = M12；code-review 三态 = 后续）。
  - 机械层：已有 `verify-gate`（提交闸门/backpressure）+ `repo-context`（symbol map/JIT 惯例）。
  - 治理层：AGENTS.md 生成采用 M15 禁止清单（对位已有 playbook「不靠规则膨胀」）。
- **为什么不用更简单的「往 AGENTS.md 加规则」**：AGENTS.md 是 user-message 层、无强制保证且用户可能不写；promptGuidelines 进 rules 段更稳；且惯例/验证类需每次会话都在。

## 4. 已落地清单
| 落点 | 内容 | 状态 |
|---|---|---|
| `~/.pi/agent/extensions/quality-prompt/` | 14 条常驻硬规则（M1–M8/M18/M19 + 验证/完成闸门/范围/根因/推进/自纠），加法式、可关、5 单测 | ✅ |
| `~/.pi/agent/skills/verify/SKILL.md` | M12 Claim→Verdict + What FAIL looks like + run-don't-read + 「测不了就明说」 | ✅ |
| `~/.pi/agent/extensions/verify-gate/` | 提交闸门 + backpressure（机械层） | ✅（前轮） |
| `~/.pi/agent/extensions/repo-context/` | symbol map + JIT 目录惯例（机械层） | ✅（前轮） |
| code-reviewer agent | 已有 adversarial contract；M13 三态投票 = 后续增强 | ⏳ |
| pi 上游 issue | compact/summary prompt 加入「保留代码变更/错误修复/文件路径」结构（机制7） | ⏳ |
| plan-mode 扩展 | 补 M9 supercession 措辞 + 「只有用户能退出」语义 | ⏳ |

## 5. 盲区与待拍板
- **无基准数据**：若「CC 质量 > pi」对决策承重，需另派一轮专攻 SWE-bench/Terminal-Bench/内部 V1 题库对比。
- **A/B 不确定性**：部分金句（M6 等）Anthropic 仍在实验，抄录时应知非定论。
- **两个设计原则比句子更值钱**（已注入）：① 强制必须配合法出口（M5「测不了就明说」）；② 惯例检查必须可引用（M14「无原文可引就闭嘴」）——后者尚未落到 pi 的 review 链路，是 code-reviewer 下一步增强点。
- 待拍板：是否把 M13 三态投票进 code-reviewer；是否向上游 pi 提 compact prompt issue。
