# Memory Index

- [pi-desktop 任务板协作流程](pi-desktop-task-board-workflow.md) — U/P 任务板、多 Agent 并行、旧原型只读、待验收流程；含 vitest OOM 排查法、队列操作、运行中模型/思考待生效切换、上下文圆环、加粗正在思考
- [pi 插件市场接入](pi-desktop-plugin-marketplace.md) — 扩展页列已装 npm 包（仅顶层依赖）+ 市场搜 npm registry 的 pi-package 包、pi install 安装、README 首图封面缩略图（jsdelivr 镜像链）；扩展页首次为空的自动扫描修复
- [ask_user_question 实现](pi-desktop-ask-user-question.md) — desktop-ask 内置扩展：ui.input 载荷通道富问题卡片（默认加载）；社区 ask 插件基于 ctx.ui.select，Desktop 原生兼容
- [pi 行为核查](pi-desktop-pi-behavior-verification.md) — 实现前先读 /opt/homebrew/.../dist 源码确认 RPC 命令/事件语义，已验证 set_model/get_session_stats/包加载口径
- [pi 版本同步](pi-desktop-runtime-version-sync.md) — 'auto' 默认优先本机 pi、兼容区间 [0.85.1,0.90.0) 替代硬白名单、pi update self 一键同步、本机升级 desktop 自动跟随
- [思考只显摘要根因](pi-desktop-thinking-summarized-rootcause.md) — pi 硬编码请求 display:"summarized"→CCR 返回摘要；desktop 改不了，用户定只报上游不动本地
- [ZCode UI 对齐指令](pi-desktop-zcode-ui-parity.md) — 常驻设计指令：所有 desktop UI 优先照 ZCode，能省的装饰就省（折叠符号/计时/箭头），存疑按 ZCode
- [GitHub 镜像与 Electron 安装](pi-desktop-network-mirrors.md) — 直连被墙用 jsdelivr/gh-proxy/npmmirror；pnpm 11 allowBuilds；npm 搜索必须走官方 registry（npmmirror 不支持 keywords 过滤，注意 429）
- [手机扫码看工作区](pi-desktop-mobile-view-plan.md) — 已实现：局域网只读 RemoteServer（token+SSE）+ 钉钉/飞书 webhook 通知；IM 双向待定平台
- [截图分析方法](pi-desktop-screenshot-analysis.md) — 模型无图像输入，用 wengine-visual OCR/analyze + sips 缩放间接读用户截图
- [壳层机制与排障](pi-desktop-settings-and-shell.md) — 归档设置保存后立即扫描；主进程探针坑（fs/promises、/tmp 符号链接被 safePath 拒、先 build）；侧栏拖宽 ResizeHandle；乐观发送反馈三段式（含 agent_start 空窗计时）；details 受控 open 防流式冲刷；完成态三段式收起（用时+结论）；队列带图缩略图；Spinner 菊花组件；模型页显示 provider id 区分同名；bash 输出剥命令回显；thinking 摘要剥 markdown 星号；FileIcon+行数统计；编辑文件可点开右侧栏（edits[] 解析 + live argumentsText）；queueEdit fire-and-forget；vitest 测试文件用 .test.ts（.tsx 会被跳过）；working bar 空窗兜底+auto_retry 接入；队列编辑召回输入框（parseContextPrompt 往返）；状态栏会话统计（get_session_stats→run.view.stats）
- [MCP imports 加载](pi-desktop-mcp-imports.md) — 桥+设置页原只读 mcp.json 直接 mcpServers、不解析 imports 是"CLI 配的 MCP desktop 没有"的根因；mcp-imports.cjs 共享解析器修复；pi RPC 无 MCP 列表命令
- [subagent 进度恢复](pi-desktop-subagent-recovery.md) — 父进程重启后子代理丢失的两层兼容：扩展 v2 持久化 onUpdate 到文件 + Desktop closed 时恢复合并；中断态正确标记 interrupted
