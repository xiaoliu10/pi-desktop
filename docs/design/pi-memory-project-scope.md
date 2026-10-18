# pi 记忆插件「全局+项目级」调研与设计

> 真实意图：CLI 侧 pi-memory 的「项目级记忆」目前是 Desktop 用 env 注入（`memorySessionEnv`）强制实现的，插件本身不感知项目——用户在纯 CLI 下项目级查询不到。要找/做一个**原生支持全局+项目双层 scope** 的记忆方案，体验对齐 Claude Code 的 CLAUDE.md 分层。
> 日期：2026-10-14（Phase 1-2 完成草案） 状态：调研完成，待拍板

## 1. 现状与接入点（本项目 + 本机事实）

### 1.1 Desktop 现状（事实，代码来源）
- `src/main/pi/memory-bridge.ts:95 memorySessionEnv`：项目会话注入 `PI_MEMORY_DIR=<cwd>/.pi/memory` + `PI_MEMORY_QMD_UPDATE=off` + `PI_MEMORY_NO_SEARCH=1`（memory-bridge.ts:110-112）。**项目记忆无语义检索**（qmd 集合硬编码指向全局目录，避免跨项目串扰），只剩固定 4 文件注入（MEMORY/SCRATCHPAD/today/yesterday ≤16K）。
- 无项目会话：env 不设 = 插件默认全局根 `~/.pi/agent/memory/`。
- `KNOWN_MEMORY_PLUGINS`（memory-bridge.ts:21-28）已登记 7 个社区记忆插件名（含本文档候选），`detectMemoryPlugin` 按名字启发式识别。
- pi-memory 0.4.2 `resolveMemoryDir`（index.ts:52-69）：只认 `PI_MEMORY_DIR` env，**代码里 0 处 ctx.cwd**，结构上无项目概念。
- 本机 `~/.pi/agent/memory/` 全局混存 8KB MEMORY.md + 14 daily + 多个手工项目主题文件（litellm-*.md 等），靠文件名前缀区分。

### 1.2 pi 原生能力（事实，pi 1.2.0 docs + types）
- pi 原生「分层记忆」= **AGENTS.md context files**（configuration.md:41-47）：agent-dir + working-dir + 父目录三层发现、叠加进 systemPrompt、无需 trust。但只读静态，无写入/搜索/累积。
- 扩展运行时只有 `ctx.cwd` 可定位项目（ExtensionContext types.d.ts），无 agentDir/projectRoot getter。
- 跨会话持久化无官方 API——扩展自管外部文件（pi-memory 的做法）。
- `project_trust` 事件带 cwd；`before_agent_start` 可改 systemPrompt（注入点）。

### 1.3 Claude Code 参照（用户点名的体验）
- 全局 `~/.claude/CLAUDE.md` + 项目 `<repo>/CLAUDE.md`（+local）自动加载、`/memory` 编辑、`@import`、`#` 快捷添加。本质是「分层静态文件 + 轻量写入口」，语义检索非必需。

## 2. 外部调研（候选插件全景）

### 2.1 现役 pi-memory 上游（jayzeng/pi-memory，192★）
- **issue #33 就是 per-project 需求**（「How can I set up memory on a per-project basis and disable global memory?」）——用户的痛点是共性需求。
- **PR #36（mkaz/33-repo-memory）已实现 repo-scope**：`.pi/agent/memory/`（仓库根，随 git 提交）+ `~/.pi/agent/memory/` 双层；工具加 `scope` 参数（user/repository，自然语言线索自动选 scope）；注入双层标注、仓库优先；**每仓库独立 qmd 集合**（解决我们 env 注入方案里「项目无检索」的牺牲）；recovery 带 scope；198 tests。
- **但：mergeable_state=dirty、1 commit、maintainer 未合**；上游最后 push 2026-09-21，停滞 3 周+。PR 分支可直接审阅/借用设计（design.md + index.ts patch）。

### 2.2 候选对比（npm 实测源码，非 README 卖点）

| 候选 | 版本/活跃 | scope 模型 | 检索 | 关键风险/代价 |
|---|---|---|---|---|
| **@yandy0725/pi-memory** | 2.5.1，10-14 仍 push，8★ | **原生双层**：`~/.pi/memory/git/<host__owner__repo>/`（git remote 推导，克隆/worktree 共享）+ `local/<abs-path>/`；index 每项目 200 行、注入窗口最新 50 行/16KiB | auto-surfacing 每轮 LLM side-query 选记忆注入 `<relevant_memories>`；`/dream` 整合（**必须配模型**，无默认值，session_start 缺模型直接报错不初始化） | ①模型硬依赖（dream/surfacing/extract 都要）②每会话 dream 必跑（token 成本）③与 Desktop 的 PI_MEMORY_DIR env 无对接（用自己的 memoryDir 配置）④8★ 生态小 |
| **@samfp/pi-memory** | 1.6.1，85★，10-09 push | 单一存储 + `projectSlug(cwd)` 维度标注（`project.*` key），注入按 slug 过滤 | FTS+embedding 选择性注入 | **反面证据实锤**：issue #36「project-scoped facts leak through embedding hits」、#37「project lessons 不按项目过滤」——项目隔离恰是弱项 |
| **@amaster.ai/pi-memory** | 0.1.26，81★，10-14 push | 全局 `~/memories`（MEMORY+USER 冻结快照）；**支持项目级 `.pi/settings.json` 覆盖 `dataDir`**（pi-shared loadPiSettings：global+configDir+project 三层 merge，project 需 trust）——即**全局+项目双层靠 pi 原生 settings 分层实现**，路径用户可控 | 无语义检索（写时 threat-patterns 安全扫描是亮点） | ①需每项目手写 `.pi/settings.json` 配 dataDir ②无检索 ③双层等于「多套独立根」而非「一次查询跨两层」 |
| **@henryqw/pi-memory** | 9.1.3，17★ | 明确**拒绝**项目记忆进 MEMORY.md（「Put them in the repository」），只做全局 user/memory | 有（capped stores + frozen snapshot） | 设计哲学相反，淘汰 |
| pi-memory-evolution / bambooye / @yishan-io | — | 未深查（前三已覆盖主要形态） | — | — |

### 2.3 Claude Code 式参照要点
- 用户的「好用」= ①分层自动加载（进项目自动带项目记忆）②写入有明确去处（说「记一下」知道进哪层）③不用配模型/向量库就能用。
- yandy0725 的 git-remote 推导比 cwd 路径推导更稳（worktree/克隆共享、fork 隔离）——值得借。
- samfp 的泄漏 issue 证明：**embedding 命中必须带 scope 过滤**，否则项目记忆串扰（我们 env 方案关掉项目检索正是绕开了这个坑）。

### 2.4 ZCode（zai-org/ZCode，7814★）开源记忆机制——重点参考
源码：`apps/zcode-cli/packages/core/src/memory/`，设计 spec：`docs/design/v2/memory/README.md`（909 行，v4）。

**scope 模型（与 pi 各候选均不同）**：项目记忆集中存储 `<cli-storage-root>/memories/projects/<slug>-<sha256前16>/memory/`，隔离键 = 规范化 workspacePath 哈希（`project-root.ts`；显式 workspaceIdentity 优先；Bash `cd` 不换 root）。**不进项目目录** → 无隐私文件进 git 的问题，代价是记忆不随仓库分发。

**文件协议**：`MEMORY.md` 短索引（无 frontmatter）+ 每事实一个小写 `.md` 文件（frontmatter：name/description/type=user|feedback|project|reference/originSessionId——写入边界只在 origin 缺失时补齐一次）。

**检索双分支（Core 常量互斥，不暴露配置）**：
- `default-index`（当前）：session 初始化读一次索引，非空则进首条 user message 的 `# agentsMd` 块（200 行/25K 字符截断，去 frontmatter/HTML 注释）。
- `semantic-recall`：Lite 模型 Selector（structured output，max_tokens=256）+ manifest（mtime 降序 ≤200 文件）+ `relevant_memory` mid-conversation 注入（≤5 项/项 200 行或 4KiB、stale>48h 警告、61,440 字符 gate、prefetch 异步不阻塞主请求）。

**后台 Extraction**：成功 Main turn 后 fire-and-forget；one-running + latest-pending 双槽；cursor = durable message UUID（direct-write 跳过、error/abort 不推进）；限 5 model turns；session close 先 abort 再 60s 有界 drain；headless `-p` 内部注入 extractionEnabled=false（后台零请求）。**Dream**：handler 完整（lock PID 接管/50 turns/产 memory_update 一次性 attachment）但产品链路不自动触发。

**Desktop 集成边界（对 pi-desktop 最有参考价值）**：
- Desktop 只持有 app-global `memoryEnabled` kill switch（默认 false），经 runtime preference 在 **Runtime materialization 时冻结**下发——Desktop 永不接触记忆正文/Recall 状态/Extraction cursor（「不成为新的事实来源」）。
- Settings viewer 只读：本地 Host service 按需读文件 catalog（文件名/类型/大小/mtime，正文选中才读，5MiB 预览上限），三级导航，显式刷新，无 watcher/缓存服务。
- Web Remote/Mobile 只有开关、不读 catalog（提示去本地桌面端看）。
- 权限：root containment + 敏感路径段黑名单（`memory-file-path.ts` SENSITIVE_MEMORY_PATH_SEGMENTS）+ 仅小写 .md 自动放行；Plan mode 仍可写记忆。

**对我们设计的直接影响**：①「Desktop 只传布尔、不碰正文」的对齐形态现成可抄；②哈希键集中存储 vs 项目内 `.pi/memory` 要重新权衡——现有 memory-bridge 的 `<cwd>/.pi/memory` 有误提交进 git 的隐私风险，但随仓库分发给团队共享是哈希键方案没有的能力；③Extraction 的「本 turn 直接写过记忆则跳过」+ cursor 语义比 samfp 的每轮无条件提取省 token；④检索双分支可用常量控制：先 default-index（零模型成本），后开 semantic-recall，与「无检索也可用」底线一致。

## 3. 方案对比与推荐

**方案 A：推上游 #36 落地（换/升 pi-memory）**
- 内容：给 jayzeng/pi-memory 的 PR #36 review+push（dirty 状态需要 rebase），或 fork 自维护。
- 优点：与现有 memory-bridge 契约最贴近（同为 MEMORY/SCRATCHPAD/daily/qmd 形态，KNOWN_MEMORY_PLUGINS 已登记）；repo 记忆进 git 可提交。
- 缺点：上游停滞，落地周期不可控；#36 与 Desktop env 注入路径（PI_MEMORY_DIR 指到项目）语义重叠，需协调（env 指根 vs 插件自找 repo 根）。

**方案 B（推荐）：装 @yandy0725/pi-memory 做全局+项目双层，Desktop 让出 env 注入**
- CLI：`pi install npm:@yandy0725/pi-memory` + 配 `defaults.model`（用 ccr 三模型之一，如 `anthropic/claude-...`）即得：全局层（personal/feedback）+ 项目层（git/local 目录），auto-surfacing 每轮按 prompt 拉相关记忆，`/dream` 定期整合。
- Desktop 改动（小）：`memorySessionEnv`（memory-bridge.ts:95）对已装 yandy 的情形**不再注入 PI_MEMORY_DIR/NO_SEARCH**（KNOWN_MEMORY_PLUGINS 已能识别它），让插件自治；Desktop 的自动摘要链（PI_DESKTOP_MEMORY*，写 daily）保留不动。
- 缺点： dream 每会话必跑的 token 成本（模型配 ccr 便宜档可控）；surfacing 每 turn 一次 side-query 延迟。

**方案 C（保底/自研）：把 Desktop env 注入方案补全「双层合并」**
- memory-bridge 改为：项目 env 注入保持，但额外把全局 MEMORY.md 以「Global memory」段拼进注入（或注入时双层拼接）；项目检索缺失保持现状。
- 优点：零新依赖，Desktop 内闭环；缺点：仍是 env hack，CLI 裸跑无 Desktop 时依旧没有项目级——**不解决用户的原始问题**，只修 Desktop 侧显示。

**方案 D：借 ZCode 形态做 pi-memory 增量（或自研轻扩展）**
- 内容：照 ZCode 设计给 pi-memory（或 fork #36 分支）加「中央哈希键存储 + default-index 注入 + 后台 Extraction（cursor + 双槽）」，Desktop 集成对齐「只传 memoryEnabled 布尔 + 只读 Settings viewer」。
- 优点：CLI 裸跑原生双层（治本，同 B）；Desktop 集成边界最干净（比现在的 env 注入正文路径干净）；无 yandy 的模型硬依赖（default-index 分支零模型成本）。
- 缺点：工作量最大（无现成包），需要维护 fork。

**推荐更新（2026-10-14 用户意向：自建插件，方案 D 细化为主推）**：
D 是用户意向方向（借 ZCode 形态自建一个 pi 插件）。可行性已核实（见 §4b），B 降级为「D 交付前的过渡」或直接跳过；A（催上游 #36）保持顺手推（上游若合入可直接受益其双 qmd 集合设计）。C 不推荐（不治本）。

## 4. 落地步骤（方案 B）
1. 试装：`pi install npm:@yandy0725/pi-memory`；`~/.pi/agent/config`（或其 memory.json）配 `defaults.model` 指向 ccr 通道模型；开一个 pi-desktop 项目会话验证：全局层写入、项目层按 git remote 建目录、surfacing 注入。
2. 与 Desktop 协调：memory-bridge.ts `KNOWN_MEMORY_PLUGINS` 已识别 `@yandy0725/pi-memory`；在 `memorySessionEnv` 里对检测到该插件时跳过 PI_MEMORY_DIR 注入（保留 PI_DESKTOP_MEMORY* 摘要链）；设置页 hint 文案同步。
3. 数据迁移：现有 `~/.pi/agent/memory/MEMORY.md` 的全局条目可手工挑重要项导入 yandy 的 personal 目录（一次性，非必须）。
4. 回滚：`pi remove npm:@yandy0725/pi-memory` + Desktop env 注入恢复（无残留）。


## 4b. 方案 D 细化：自建 pi 记忆插件（借 ZCode 形态，2026-10-14 补）

### 可行性核实（官方扩展 API 能力，全部有现成模板）

| ZCode 能力 | pi 对应实现点 | 依据 |
|---|---|---|
| MEMORY.md 索引进首条 user message | `before_agent_start` 返回 `{ systemPrompt }`（pi-memory 现役注入路径 index.ts:1540）或系统提示拼接 | pi-memory 0.4.2 已跑通；官方模板 `examples/extensions/claude-rules.ts`（ctx.cwd 扫项目目录→注入） |
| 后台 Extraction（嵌套 LLM 调用） | `ctx.modelRegistry.complete(model, {messages}, {reasoningEffort, cacheRetention, sessionId})` | 官方 `summarize.ts:181`；pi-memory `generateExitSummary`（自设超时防 shutdown 挂起，index.ts:530 注释） |
| 项目 root 哈希键 | `ctx.cwd` → `resolve()+sha256[:16]+basename-slug`（直接移植 ZCode `project-root.ts`，30 行纯函数） | ZCode 源码已验证该算法 |
| 会话生命周期 | `session_start` / `session_shutdown` / `agent_settled`（Extraction 触发点）/ `session_before_compact` | pi-memory 全部在用 |
| 写记忆工具 | `pi.registerTool`（memory_write/memory_read/memory_search 可先只做 grep 级关键词，不上 qmd） | pi-memory 同款 |
| Desktop kill switch | `PI_DESKTOP_MEMORY_ENABLED=0/1` env（Desktop 已有 env 通道 memory-bridge.ts:216），或读 `memory.use` 同款配置 | 无需新协议 |

### v1 范围（对齐 ZCode default-index 分支，零模型成本）

- **项目形态**：独立新仓库（pi 生态惯例：npm 包 + `pi.extensions` 清单 + `pi install npm:<pkg>` 安装，参照 pi-memory/yandy 的打包形态；不放进 pi-desktop 仓库——插件要在 CLI 裸跑时独立工作，Desktop 只是消费者）。建议名 `pi-scoped-memory`（npm 查重后定）。
- 存储：
  - 全局层沿用 `~/.pi/agent/memory/`（MEMORY.md/SCRATCHPAD.md/daily/ 原样兼容现有 pi-memory 数据）；
  - 项目层新建 `~/.pi/agent/memory-projects/<slug>-<hash16>/`（slug+sha256[:16] 移植 ZCode `project-root.ts`；不进 cwd）。
- **注入结构（对齐 ZCode 多 source 标注渲染）**：systemPrompt 记忆段按「全局记忆 → 项目记忆」顺序分段、各带 source 标注；索引各 ≤200 行/25K 字符截断；与 pi 原生 AGENTS.md 分层叠加（AGENTS.md 是更稳定的指令层，记忆层在其后）。
- **写入路由**：`memory_write(target=global|project)`——默认规则：type=user|feedback（用户偏好/协作方式）→ global；type=project|reference → project；模型/用户可显式指定覆盖默认。共享兜底提示：跨项目复用的稳定记忆建议沉淀进 `~/.pi/agent/AGENTS.md`（pi 原生全局层，插件在 read 结果中提示）。
- 写入边界：frontmatter（name/description/type/originSessionId）只在 origin 缺失时补一次；索引 pointer 行同步（`- [Title](file.md) — hook`）。
- 提取：v1 **不做**后台 Extraction（先验证注入/写入闭环），`agent_settled` 触发点留给 v2。
- 与现有 pi-memory 的关系：**替代安装**（同名工具 memory_write/memory_read/memory_search 冲突会崩，见 third-party-ask.ts 同款问题）——Desktop 的 detectMemoryPlugin 会把新插件识别为 extension 并让 PI_MEMORY_DIR 注入；安装时 `pi remove npm:pi-memory`。
- Desktop：`memorySessionEnv` 检测到本插件时不再注入 PI_MEMORY_DIR/NO_SEARCH（保留 PI_DESKTOP_MEMORY* 自动摘要链）；KNOWN_MEMORY_PLUGINS 加名字；设置页 hint 更新。

### v2 范围（对齐 semantic-recall + Extraction，需配模型）
- Extraction：`agent_settled` 后 fire-and-forget（双槽+cursor+direct-write skip+5 turns+60s drain，全部照抄 ZCode 语义）；模型经 ccr 便宜通道。
- 检索：关键词 grep 起步 → qmd（每项目独立集合，解决 #36 的 embedding 泄漏问题——ZCode 用 scope 过滤同理）。
- `/memory` 命令 + Settings viewer 只读 catalog（5MiB 上限）。

### 风险与代价
- 工作量：v1 约 1 个 PR 量级（插件 ~300 行 + Desktop 让位 ~20 行）；v2 是长期演进。
- 维护责任在自己（vs B 用现成的）；但 ZCode spec 可作实现对照，且形态完全可控。
- pi 上游若未来出官方 memory API，可能需要一次迁移（存储是纯 Markdown，迁移成本低）。

## 5. 盲区与待拍板
- yandy 的 dream 每会话必跑：token 成本未实测（ccr glm 通道便宜但延迟未知）→ 装后跑一个会话观察。
- yandy 8★/生态小，长期维护风险 → 若担心，A（上游 #36）并行催 merge。
- Desktop「记忆」设置页当前语义（memoryAssistStatus 的 hint）需要跟着改，具体文案未写。
- **需用户拍板**：①选 B 还是 A；②若 B，dream/surfacing 用哪个模型（建议 ccr glm-5.3-flash 档）；③现有全局 MEMORY.md 是否迁移。
