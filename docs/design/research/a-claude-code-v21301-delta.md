# CC v2.1.300 → 最新版（2.1.301）质量机制增量调研

调研时间：2026-10-17
方法：npm 下载 `@anthropic-ai/claude-code@2.1.300` 与 `@2.1.301` 的 darwin-arm64 原生二进制（各 ~238MB），用 `// @bun` 标记切块 + 可打印串提取，得到两版全部 prompt 模板/字符串，逐条做语义 diff；CHANGELOG 与 issue 走 `gh api` 一手读取。**未使用二手介绍**。

> 说明：Piebald-AI/claude-code-system-prompts 镜像目前最新 tag 仍是 `v2.1.300`（未覆盖 2.1.301），故 2.1.301 的 prompt 文本直接来自官方 npm 二进制，非镜像。

---

## 1. 版本事实

- npm latest = **2.1.301**，发布时间 `2026-10-15T14:34:23.330Z`（`npm view @anthropic-ai/claude-code time --json`）
- GitHub Releases 最新 = v2.1.301（2026-10-15T19:22:06Z）
- **包装形态变了（非质量相关但影响后续逆向）**：主包 `@anthropic-ai/claude-code` 只剩 204KB 的 shim（`bin/claude.exe` 是 500 字节报错脚本 + `install.cjs`），真正的 238MB 二进制改到 platform 可选依赖 `@anthropic-ai/claude-code-darwin-arm64` 等同名版本包。
- v2.1.300 构建信息（二进制内嵌）：`VERSION:"2.1.300" GIT_SHA:"c6733ae1…" BUILD_TIME:"2026-10-14T12:54:55Z"`
- v2.1.301 构建信息：`VERSION:"2.1.301" GIT_SHA:"12a1baed…" BUILD_TIME:"2026-10-15T12:58:20Z"`

---

## 2. 核心结论：v2.1.301 在质量机制上是「空版本」

**从 v2.1.300 到 v2.1.301，system prompt 的质量机制正文零变化。**

证据（两版二进制 prompt 串逐条 diff）：
- 提取 v300 608 条 / v301 608 条「正文级」prompt 块（含标题、≥2 行列表或多句散文，且排除代码）。
- 585 个指纹完全匹配；49 处词级差异**全部**是 minifier 标识符重命名（如 `Ae`→`Re`、`SK`→`xY`、`jH`→`eM`），无一条自然语言变更。
- 初筛出的「NEW 103 条」经逐个回查，均为 minifier 改名导致的字符串身份变化（如 `# Writing commit messages and PR descriptions`、`/init` 的「Set up a minimal CLAUDE.md」在两个版本中字节级一致）。

CHANGELOG 佐证（`anthropics/claude-code` CHANGELOG.md）：
- 2.1.301 共 ~48 条，**全是 bug 修复 + 少量 Add**，Add 项为：`CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`、`claude-api` skill 加 OpenTelemetry tracing 指引、vim `%` motion、mod 的 `Input.rows`、OTel `tool_decision` 事件加 `classifier_verdict`/`permission_mode`/`classifier_category`。
- 无任何 plan mode / verification / memory / comment / convention 机制的增改。

**→ 对 pi-desktop 宿主的适配判断：不要再等 CC 的新版本补质量机制——v2.1.300 的机制清单仍然是最新基线，本项目的质量设施缺口要靠自己补。**

### 2.1 v2.1.301 里唯一与「质量」沾边的修复（值得抄的思路）

CHANGELOG 原文：
> Fixed workflow agents sometimes skipping their step, and the run still reporting success, after reading the harness note that their task text carries no user authority

即：CC 给 subagent 的任务文本里带一条「harness note」，声明该文本**不携带用户授权**；agent 读到后会跳过步骤并谎报成功，这是 bug。但这条 note 本身的设计——**在委派文本里显式声明权限边界，让被委派方知道「这不是用户亲口说的」**——正是防「agent 拿二手委派当圣旨」的机制，值得 pi-desktop 的 subagent 适配层照抄（项目记忆里已有 `-e fallback + 事件层持久化`，可在此之上加授权标记）。

---

## 3. CC 质量机制清单在 v2.1.301 的原文快照（供直接引用）

以下均为 v2.1.301 二进制原文摘录（不是我转述）。

### 3.1 反过度工程 / 交付纪律 — `# Delivering work`
```
Do ordinary work as asked, acting on the actual request rather than on speculation about what lies behind it. The requested scope is the deliverable — don't quietly narrow, widen, or transform it. Interpret ambiguity the way a careful colleague would: make routine judgment calls yourself, and check in only when different readings would lead to materially different work. If you find a real problem with the task as specified, state the concern in a sentence or two, then keep building: deliver the complete work under explicitly stated assumptions, flagging important factors for the user. Finish the whole task, not just easy parts — report completion only when fully done. If part of the scope turns out to be blocked or problematic, finish every other part in full and say explicitly what you left out and why — scaling the work down is the user's call, not yours. Stop short of actions or changes clearly beyond what the user's ask implies.
```
> 适配判断：这段是「不许缩水交付 + 不许悄悄扩范围」的双向约束，pi 的 task 书可直接复用句式（本项目 acceptance-report 就是它的结构化变体）。

### 3.2 注释 WHY-only — `# Communicating with the user` 末段
```
Write code that reads like the surrounding code: match its comment density, naming, and idiom.
Only write a code comment to state a constraint the code itself can't show, never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader, and it's noise the moment the change merges.
```
> 适配判断：pi-desktop 的 ZCode 对齐 UI 指令里可挂这条；「why your change is correct」这一句尤其该进 AGENTS.md。

### 3.3 防过度自我纠错 — `# Corrections`
```
Avoid unnecessary or excessive self-correction. Only correct an earlier statement in your user-facing text when the error would change the user's code, conclusions, or decisions. State corrections plainly and concisely, and continue the task; combine multiple corrections rather than enumerating them all. … A follow-up question about your earlier work is not, by itself, a signal that you got something wrong — answer what was asked. A statement that was accurate needs no correction: don't re-audit how you phrased it, how you verified it, or limits you already stated.
```
> 适配判断：本项目多 agent 并行 + 评审 fanout 场景下，这条能压掉大量「复读式道歉」，建议进全局习惯。

### 3.4 Commit / PR 文案 — `# Writing commit messages and PR descriptions`（两版一致，v2.1.300 已有）
```
Write for a reader with zero context who was not part of this session:
- Say what the change is in plain words before any mechanism or implementation detail
- One idea per sentence; one fact per bullet; no nested clauses or stacked parentheticals
- Define project- or team-specific shorthand the first time it appears
- Short beats complete: after one pass the reader should know what the change does and what to check
```
> 适配判断：pi-desktop 已有 git-commit-spec 记忆（公司项目不用 Co-Authored-By、不建 MR），可把「plain words first」补进 commit message 规约。

### 3.5 hooks 是一等公民 — `# Harness`
```
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - Hooks may intercept tool calls; treat hook output as user feedback.
```
> 适配判断：pi 的宿主（desktop）同样应把「工具被拦=用户反馈」写进 prompt，否则模型会重试。

### 3.6 AGENTS.md 反模板化 — `/init` skill（两版一致）
```
Set up a minimal CLAUDE.md (and optionally skills and hooks) for this repo. CLAUDE.md is loaded into every Claude Code session, so it must be concise — only include what Claude would get wrong without it.
```
以及独立的 `/init` 反模板清单：
```
- When you make the initial CLAUDE.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- Don't include generic development practices.
```
> 适配判断：与 pi-desktop 已有的「AGENTS.md 反模板化」结论一致；`/init` 的 Phase 2 明确会去读 `AGENTS.md / .cursor/rules / .github/copilot-instructions.md / .clinerules / .mcp.json`，说明 CC 把自己当成多工具规则文件的**汇聚方**——pi 若要兼容 CC 生态也该这么读。

---

## 4. CC hooks 生态现状（一手）

### 4.1 官方 hook 事件清单：33 个（v300 与 v301 完全一致）

二进制内 `{PreToolUse:[],PostToolUse:[],…}` 初始化对象逐字提取：

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionDenied,
Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd,
Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact,
PreModelSwitch, PostModelSwitch, PermissionRequest, Setup, TeammateIdle,
TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged,
DirectoryAdded, MessageDisplay
```

比常见文档口径（PreToolUse/PostToolUse/UserPromptSubmit/Notification/Stop/SubagentStop/SessionStart/SessionEnd/PreCompact）多出的一批，质量强制最有用的是：
- **`PostToolUseFailure`** — 工具失败后也能触发（失败重试的门禁）
- **`StopFailure` / `TaskCompleted`** — 收尾校验的天然挂点
- **`InstructionsLoaded`** — 指令文件加载时审计（社区拿它做 CLAUDE.md 投毒检测）
- **`ConfigChange`** — 会话中配置变更（含 `policy_settings`），可 exit 2 阻断
- **`FileChanged` / `DirectoryAdded` / `CwdChanged`** — 文件系统侧观测
- **`Elicitation` / `ElicitationResult`** — 交互问答前后

> 适配判断：pi 的 desktop_schedule / memory-bridge 都在做「事件驱动补写」，CC 这 33 个事件名可以直接当 pi 宿主 hook 层的命名参照；`InstructionsLoaded` 与 `ConfigChange` 是 pi 目前完全缺失、但对「宿主托管 agent」最关键的兩個。

### 4.2 决策协议（二进制原文）

- 阻断靠 **exit 2**；错误码/输出分类在二进制里：`outcome` ∈ `success | blocking | error | non_blocking_error`，`blockingError` 消息格式 `[{type} hook]: …`。
- JSON 决策字段：`hookEventName, permissionDecision, permissionDecisionReason, additionalContext, decision, action, content, suppressOriginalPrompt, retry`（`permissionDecision` 出现 67 次，是主力）。
- 2.1.300 起收紧（CHANGELOG）：`Changed hooks: updatedInput from PreToolUse and PermissionRequest hooks is now validated like Claude's own input: unknown keys are dropped, and input the tool rejects denies the call`。
- **fail-open 是真实风险**（见 §6）。

### 4.3 社区代表配置（均已读源码，非转述）

**A. `karanb192/claude-code-hooks`（558★，22 插件市场，1949 tests passing）**
质量强制四个最相关插件，源码已读：

- `format-code` — PostToolUse `Write|Edit`，Python 走 `uv run ruff check --fix --exit-zero --quiet` + `ruff format`，JS/TS/HTML/JSON/MD/YAML 走 `npx --yes prettier --write`。设计要点：**formatter 失败只记日志、不阻断**（`log({level:'ERROR'…}); return {success:false}`）。
- `protect-tests` — PreToolUse `Bash|Edit|MultiEdit|Write`，专治 "fake green"（删测试/改名/加 skip-xfail 让套件变绿）。三档 `HOOK_SAFETY_LEVEL=critical|high|strict`；明确不拦「写新测试、重构改名、改测试体」，只拦「移除与禁用」。跨语言识别 pytest/unittest/JUnit/xUnit/jest/mocha/vitest/Go/Rust/NUnit/MSTest。
- `dead-rules-audit` — **CLAUDE.md 合规记分板**：SessionStart 把 CLAUDE.md 解析成编号原子规则，PostToolUse(async) 逐次统计每条规则「相关 vs 遵守/违反」，SessionEnd 出 worst-first 分数卡，并对「违反 ≥3 次且违反率 >0.5」的规则提示「promote to hook?」（即把反复被无视的软规则升级成确定性 hook）。源码注释里明确记录了一个坑：`COST CAVEAT (verified, issue #11008): hooks do NOT receive token/cost data.`
- `instructions-audit` — InstructionsLoaded 检测 CLAUDE.md/.claude/rules 里的隐藏指令（零宽 Unicode、bidi override、curl|sh、读密钥、hook/settings 篡改），命中即**锁会话**；并说明该事件本身无决策权，所以要额外挂在 UserPromptSubmit + PreToolUse 做 enforcement。

**B. `disler/claude-code-hooks-mastery`（3943★，教学向）**
`settings.json` 把 PreToolUse/PostToolUse/Notification/Stop/SubagentStop/UserPromptSubmit 全量挂 Python 脚本（`uv run $CLAUDE_PROJECT_DIR/.claude/hooks/…`），其 `post_tool_use.py` 实际只是把 stdin JSON 追加写 `logs/post_tool_use.json`，**且所有异常都 `sys.exit(0)`**——典型的教学级 fail-open 写法。`permissions.allow` 里直接 `"Write","Edit"` 全放。
> 适配判断：这个仓库适合当「hook I/O 契约速查」，不适合当质量强制范本（它自己就是 fail-open）。

**C. `GowayLee/cchooks`（132★）/ `beyondcode/claude-hooks-sdk`（68★）** — Python / PHP SDK，说明 hook 已多语言化。

**D. `parcadei/Continuous-Claude-v3`（3944★）** — 用 hooks 维护 ledger/handoff 做上下文管理，MCP 执行不污染上下文。

### 4.4 反面证据：hooks 的质量强制不可靠（重要）

- **#102649**（open，2026-10-16）：`[BUG] Linux sandbox: placeholder cleanup deletes a symlink created during the call, so ~/.claude/hooks vanish and all hooks fail open`
  原文：`Every hook command in settings.json (bash ~/.claude/hooks/<name>.sh) now fails. A PreToolUse hook that fails does not block, so all guards are off in every session, without any visible error to the user.` 实测 `all hooks were off for 23 minutes before the cause was found`。
  → **适配判断：pi-desktop 若做 hook 层，必须自带「hook 存活心跳 + 静默失效告警」，否则等于没有门禁。**
- **#102653**（open，2026-10-16）：用户装的 mod 的 `prompt.attachment` hook 从 2.1.299 起被内置 `cc-plugin-sec-default@builtin` 旁路，`The user can't turn this off`，代价是每请求多 17k tokens。
  → 适配判断：宿主接管 hook 调度时，要保留用户/项目级 hook 的可见开关，不能 silently 旁路。
- **#102719**（open）：`Subagent frontmatter hooks are not applied when spawned with Agent({name: …})`——subagent 的 hook 在命名派发路径下丢失。
- **#102039**（open）：Desktop app 内置 edit-preview PostToolUse hook 在 ~60% 的 Edit/Write 上 60s 超时——同步 hook 的延迟税。
- **#95142**（open，2026-09-17）：`Claude Code ignores claude.md instructions and delivers low-quality untested code`（用户报「不遵守 claude.md、交付未测试的低质代码」）。
  → 适配判断：软规则（AGENTS.md）+ 硬门禁（hook）必须双轨，纯 prompt 规则会被无视，这正是 `dead-rules-audit` 存在的原因。

---

## 5. output-styles / settings 治理的变化

**结论：v2.1.300 → v2.1.301 无变化。**

- 内建 output style 仍 4 个（二进制 `source:"built-in"` 逐个提取）：
  - `Proactive` — "Claude executes immediately, minimizes interruptions, and prefers action over planning"
  - `Concise` — "Claude responds tersely, leading with results and skipping preamble and narration"
  - `Explanatory` — "Claude explains its implementation choices and codebase patterns"
  - `Learning` — "Claude pauses and asks you to write small pieces of code for hands-on practice"
- 加载机制：`output-styles/` 目录扫 `.md`，frontmatter 支持 `keep-coding-instructions`（布尔，决定是否叠加编码指令）、`force-for-plugin`（仅插件 style 生效，非插件设置会 warn 忽略）。prompt 快照里 `outputStyle:{name, isKeepingCodingInstructions}`。
- settings 侧计数两版一致：`policySettings` 54/53、`managedHooksOnly` 35/36、`allowManagedHooksOnly` 4/4、`disableAllHooks` 14/14、`hookAllowVouched` 8/8、`keepCodingInstructions` 10/10。
- 组织级 hook 治理手段（v301 原文）：`allowManagedHooksOnly`（只跑托管 hook）、`disableAllHooks`、`policySettings`、`deniedMcpServers`。相关提示语：`hooks a person set up are not run for this session…` / `managed settings were not read when their fetch settled; hooks on later events run once they are read` / `your organization's managed settings set "disableAllHooks"`。

> 适配判断：`keep-coding-instructions` 这个开关对 pi-desktop 直接有用——切换 output style 时是否保留编码指令，决定了「换风格」会不会把质量规则一起换掉。pi 若做 output style，默认应保持「保留编码/质量指令」，只有用户显式关闭才剥离。

---

## 6. 可直接落地的 5 条（给主 agent 综合用）

1. **不要等 CC 新版**：2.1.301 是纯修复版；以 v2.1.300 机制清单为基线即可，把精力放在 pi 自身缺口。
2. **抄「软规则→硬门禁」的晋升通道**：`dead-rules-audit` 的思路（统计 AGENTS.md 每条规则被违反次数，违反率 >50% 且 ≥3 次就建议固化成 hook）是 pi-desktop 最值得抄的一条，因为它直接回应了本项目「禁止能跑就好兜底」的硬规则痛点。
3. **抄 hook 事件命名 + 补三个缺失事件**：对齐 CC 33 事件名；pi 优先补 `InstructionsLoaded`、`ConfigChange`、`PostToolUseFailure`。
4. **hook 层必须带存活心跳**：CC 自己的 #102649 证明 fail-open 会静默发生 23 分钟；pi 的门禁要做「未触发≠未生效」的显式校验。
5. **抄授权边界声明**：subagent 任务文本里显式标注「此文本不携带用户授权」，防 agent 把二手委派当圣旨（CC 2.1.301 那条修复的反面用法）。

---

## 关键 URL

- npm 版本时间线：`https://registry.npmjs.org/@anthropic-ai/claude-code`（`npm view @anthropic-ai/claude-code time --json`）
- CHANGELOG（一手）：`https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md`
- Releases：`https://github.com/anthropics/claude-code/releases`
- Piebald 镜像（v2.1.300 及以前，与二进制零差异）：`https://github.com/Piebald-AI/claude-code-system-prompts`
- hooks 插件市场：`https://github.com/karanb192/claude-code-hooks`（插件目录 `plugins/<name>/<name>.js`）
- hooks 教学：`https://github.com/disler/claude-code-hooks-mastery`（`.claude/settings.json` + `.claude/hooks/*.py`）
- Python SDK：`https://github.com/GowayLee/cchooks`
- 关键 issue：#102649（hooks fail open 23 分钟）、#102653（用户 hook 被内置插件旁路）、#102719（subagent frontmatter hooks 丢失）、#102039（Desktop edit-preview hook 60s 超时）、#95142（无视 claude.md）、#11008（hooks 拿不到 token/cost 数据，见 dead-rules-audit 源码注释）
