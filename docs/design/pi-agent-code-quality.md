# pi CLI 代码质量优化：全局视野与项目习惯遵循

> 真实意图：pi 干活时「上来就改局部、不先建全局视野、不遵循项目既有习惯」→ 产出与代码库脱节、返工多。要一套让 agent 先看后写、照惯例写的可落地优化。
> 日期：2026-10-15 ｜ 状态：待评审 ｜ 调研：3 路并行（官方 best practices / 竞品机制 / 反面证据）

## 0. 一句话结论

**「全局视野」和「习惯遵循」都不靠往规则文件塞更多内容解决。** 证据（ETH Zurich arXiv:2602.11988）：仓库概览类内容对 agent 定位文件**无帮助**且成本 +20%；而「指令」本身遵循率其实不差。真正有效的三件事：**(a) 让 agent 读对的代码**（指向代码内范例，而非背规则）；**(b) 探索-实现分离的工作流纪律**（plan mode）；**(c) 机械闸门**（lint/typecheck/test 移出 prompt，用确定性工具闭环）。规则文件只放「与默认不同的少数例外 + 指针」。

## 1. 现状与接入点（Phase 1）

### 你已有的资产（比想象中全）
- 15 个 prompt templates：`implement`（scout→planner→worker 链）、`scout-and-plan`、`implement-and-review`、`repo-start`
- plan-mode 扩展（只读探索 + bash 白名单）
- 14 个自定义 agents（code-reviewer、planner、desktop-scout…）
- 全局 `~/.pi/agent/AGENTS.md`：流程偏好（中文、codemode 批量、review 纪律、git 规范）

### 诊断出的缺口
1. **默认路径无强制**：上述全是手动斜杠命令，日常对话不触发
2. **项目惯例无沉淀**：AGENTS.md 只有流程偏好，没有「代码惯例」区块；每项目每次靠模型现翻代码归纳
3. **失效模板（bug）**：`implement.md`/`scout-and-plan.md`/`implement-and-review.md` 引用 `"scout"/"worker"/"reviewer"` agent，但 agents 目录实际叫 `desktop-scout`/（无 worker）/`code-reviewer`——**这条链名字对不上，可能从未跑通**
4. **无机械闸门约定**：风格/格式问题全堆到 review 环节

### pi 机制面（可落点）
| 机制 | 强度 | 用途 |
|---|---|---|
| 项目 AGENTS.md（逐级发现，兼容 CLAUDE.md） | 上下文注入（user message 层，**无强制保证**） | 惯例区块主载体 |
| `.pi/SYSTEM.md` / `APPEND_SYSTEM.md` | **真 system prompt**（比 CLAUDE.md 强） | 最关键 2-3 条惯例升层（慎用，受指令预算约束） |
| extension hooks（before_agent_start / 工具拦截 / 会话收尾） | 可执行 | 机械闸门落点 |
| skills | 按需加载 | progressive disclosure |
| prompt templates | 手动触发 | 工作流纪律固化 |
| 自定义 subagents | fresh context | 对抗式 review |

## 2. 外部调研要点（Phase 2，三路收敛）

### 2.1 官方（Claude Code）
- CLAUDE.md = **context, not enforced configuration**；硬约束必须走 hook（官方明文）
- 推荐结构：bash 命令 / **与默认不同的**代码风格 / 测试指令 / 仓库礼仪 / 架构决策 / 环境怪癖 / 常见坑；**<200 行**，逐行自问「删掉会犯错吗」
- **明确不写**：模型能从代码读出的、标准语言惯例、API 文档（给链接）、逐文件描述、"write clean code" 空话
- 全局视野 = plan mode 四阶段（Explore 只读 → Plan → Implement → Commit）；官方：「跳过探索直接写码会解错问题」
- 习惯遵循 = **指向代码内范例**：「look at how existing widgets are implemented… follow the pattern」
- 警告：「Bloated CLAUDE.md files cause Claude to ignore your actual instructions!」

### 2.2 竞品机制
- **Aider repo map**（唯一自动化的「全局视野」）：tree-sitter 提取符号 → 依赖图 → 带 personalization 的 PageRank → 二分裁剪到 token 预算（默认 1024，聊天无文件时 ×8）。坑：语言覆盖不全静默降级、大仓首扫卡死
- **Codex**：root→cwd 拼接、32KiB 硬顶、`AGENTS.override.md`；无 JIT（issue #12115 被催更）
- **Gemini CLI**：**JIT 目录级注入**（工具访问某目录才读该目录 GEMINI.md）+ Auto Memory（转录挖掘 → patch/SKILL.md 草稿 → **inbox 人工审批**才生效）
- **Cursor**：四态规则（always/description/glob/@）；最佳实践「<500 行、**引用文件不复制内容**、只在 agent 反复犯同一错误时才加规则」

### 2.3 反面证据（最关键，决定方案取舍）
| 做法 | 证据 | 判定 |
|---|---|---|
| 仓库概览/大全套惯例塞规则文件 | ETH arXiv:2602.11988：概览无助于定位文件、成功率不升、成本 +20%；LLM 生成物与已有文档冗余 | **有害** |
| LLM 自动生成惯例文档直接用 | ETH：成功率 -0.5~-2%（不显著）、成本 +20-23%；「更强模型生成的并不更好」 | **不划算**，仅作草稿+人审 |
| 违规后加粗/重申/追加规则（prompt 军备竞赛） | claude-code #33603：连续 4 会话违反且「measurably worse with each iteration」 | **已证无效** |
| 用规则文件承载硬性流程强制令 | 官方「context not enforced」+ #2544 | **无效**，走 hook |
| 同上下文给 reviewer 加检查指令 | #72206：「does not fix this」，根因是独立性不是知识 | **无效**，需 fresh-context |
| 客户端 git hook 当闸门 | #90887：agent 用 `--no-verify`/stash 绕过，「advisory to an agent that controls the shell」 | **可绕过**，闸门做在 harness 工具层 |
| 指令超预算 | HumanLayer：前沿模型可靠遵循 ~150-200 条，CC 系统 prompt 已占 ~50；超预算**均匀劣化所有指令**；IFScale 500 条→68% | 规则文件必须短 |

### 2.4 对本项目的适配判断（逐条）
- 惯例区块 → **项目 AGENTS.md**（不进全局，防跨项目污染 + 预算）；只写「与默认不同的例外」+ `file:line` 指针
- 「先看」→ 模板措辞补「先找同类实现并跟随其模式」（零机制成本，官方同款）+ plan-mode 纪律
- 机械闸门 → 项目 `verify.sh`（run_silent 风格：通过只出 ✓，失败才 dump）+ 模板收尾「跑 verify 直到 ✓」；**不做**客户端 git hook
- review 假通过 → code-reviewer 已是 fresh-context（pi subagents 天然满足），补 run-don't-read 契约 + 「只报影响正确性/需求的 gap」+ 验收标准前置
- repo map / JIT 注入 / Auto Memory 挖掘 → **备选**（见 §5），非主方案

## 3. 方案对比与推荐

**方案 A（推荐）：配置层优化，零代码**
- 修失效模板 agent 名（bug 修复）
- 项目 AGENTS.md 惯例区块模板（<200 行、例外+指针）
- worker/scout 模板补「先找范例跟随模式」+「跑 verify 直到 ✓」收尾
- code-reviewer 契约升级（run-don't-read、correctness-only、验收标准前置）
- 改动面：~5 个配置文件；风险：极低；侵入度：0

**方案 B：extension 机械闸门**
- 会话收尾/工具调用后跑 verify.sh，失败喂回（harness 工具层，不可被 --no-verify 绕过）
- 改动面：1 个扩展；风险：中（需界定 autofix 安全范围）；侵入度：中

**方案 C（备选，实验）：repo map / JIT 注入扩展**
- Aider 式符号图或 Gemini 式目录级 JIT；治「全局视野」的机械面
- 改动面：1 个扩展 + tree-sitter 依赖；风险：中高（首扫性能、语言覆盖）；**且 ETH 证据表明概览类内容收益存疑**——符号索引≠概览，但仍需实测

**推荐 A**：证据最强、成本最低、直接命中两个痛点。B 作为 A 验证后的加固。C 仅在 A/B 后「全局视野」仍不足时实验。
**为什么不用更简单的「往全局 AGENTS.md 加惯例」**：预算论 + 跨项目污染 + ETH 证明概览无效——已被三路证据否证。

## 4. 详细设计（方案 A）

### 4.1 修失效模板（bug）
`implement.md` / `scout-and-plan.md` / `implement-and-review.md` 的 agent 名改为实际存在：`scout`→`desktop-scout`、`worker`→`fullstack-developer`、`reviewer`→`code-reviewer`。

### 4.2 项目 AGENTS.md 惯例区块模板（新建，每项目一份，<200 行）
```markdown
## 代码惯例（只写与默认不同的例外）
- 命令：build/test/lint 的确切命令（模型猜不到的）
- 风格差异：仅列与语言默认不同的（如「用 ES modules 不用 CommonJS」）
- 参考实现：改 X 前先看 <file:line>（canonical example，指针不复制代码）
- 仓库礼仪：分支命名/commit/PR 约定
- 常见坑：环境怪癖、历史教训
```
**纪律**：逐行自问「删掉会犯错吗」；违规时**不加规则**而是加 gate 或修模板；引用文件路径不复制内容（防 stale）。

### 4.3 模板措辞升级
- scout/worker 模板开头加：「先找出代码库内同类/相邻实现，读取 1-2 个 canonical example，新代码跟随其模式（命名/错误处理/结构）」
- worker 模板收尾加：「完成后跑 `<verify 命令>` 直到通过；只消费 ✓/✗ 与失败输出」

### 4.4 code-reviewer 契约升级
- fresh context 只看 diff + 验收标准（不带实现者推理）——pi subagents 已满足
- **run-don't-read**：行为/数值断言必须跑命令取证，不许读代码下结论
- **只报影响正确性/需求的 gap**，不报风格偏好（防 over-engineering 返工）
- 验收标准前置：任务书里写明「检查什么、对照什么计划、什么算 finding」

## 5. 盲区与待拍板
- **未覆盖**：repo map / JIT 注入 / Auto Memory 挖掘（备选 C，需实测收益）；手机端/多设备一致性
- **证据不足**：「惯例区块模板」本身的有效性无定量研究（ETH 只证伪了概览类与自动生成类）——需 A 落地后观察返工率
- **需用户拍板**：
  1. 是否立即落地方案 A（我可直接改 ~/.pi/agent 的 templates + 给你项目 AGENTS.md 模板）？
  2. 是否要方案 B 的 verify.sh 机械闸门扩展（需界定 autofix 范围）？
  3. 失效模板的 `worker` 映射到 `fullstack-developer` 是否符合你的分工预期？

## 6. 落地记录（2026-10-15，A/B/C 全做）

- **A**：见 §4（templates 修名+措辞、agents-init、code-reviewer 契约）
- **B = `~/.pi/agent/extensions/verify-gate/`**（harness 工具层闸门，7 单测）：
  - gate：`tool_call` 拦截 `git commit/push`——dirty（有 edit/write 未过 verify）时同步跑 verify，失败 `block:true` 并把输出尾部回传模型自修；通过则放行并清 dirty。**不是 git hook，无法被 --no-verify 绕过**
  - backpressure：verify/test/build/lint 类 bash 成功时输出折叠成一行 ✓（失败保留全文）
  - reminder：edit/write 后每轮追加一次「收尾前跑 verify」
  - verify 命令发现：`PI_VERIFY_CMD` → `./verify.sh` → `./.pi/verify.sh`；都没有则 no-op
- **C = `~/.pi/agent/extensions/repo-context/`**（5 单测）：
  - symbol map：首轮 `before_agent_start` 正则抽顶层符号（ts/py/go/rs，剪枝 node_modules/dist，≤400 文件 ≤4k 字符）追加进 `appendSystemPrompt`——给「带符号的目录图」而非概览散文（ETH 证明后者无效）
  - JIT 惯例：read/edit/write 首触子目录时向上找最近 AGENTS.md/CONVENTIONS.md（不含根，根已加载）追加进该次 tool_result（Gemini 同款按需加载）
  - 开关：`PI_REPO_CONTEXT=off|map|jit`；`PI_VERIFY_GATE=off`；全部 fail-open
- 两扩展均 colocated `test.mjs`（node:test），12/12 通过
