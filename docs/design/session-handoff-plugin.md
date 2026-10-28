# GUI / TUI 会话交接插件

目标：让 Desktop 与普通 pi TUI 的既有会话互相交接，自包含上下文投递为 user 回合，忙时 followUp 排队；无需依赖 Desktop 才能进行 TUI → TUI 交接。

## 现状与接入点

现有 extensions/desktop-handoff/index.mjs 注册 desktop_handoff，使用保留 ui.input 通道 desktop-handoff 请求 Desktop。src/main/pi/backend.ts 拦截该通道，src/main/pi/handoff-bridge.ts 负责查找 Desktop 自有、未归档、非副驾目标及重连。普通 TUI 没有这条桥。

现有路径：desktop_handoff → RPC ui.input → HandoffService → backend.prompt(followUp)。

新增独立插件位于 extensions/session-handoff/，自带 package.json、零运行时依赖。session_handoff 使用本机按会话注册的通信端点发送到既有进程，接收方用 pi.sendUserMessage(..., {deliverAs:'followUp', expandPromptTemplates:false}) 保持自身项目、模型、权限。GUI 未连接目标仍可经现有 Desktop bridge 重连。desktop_handoff 保留兼容。

契约：新增 session_handoff 工具（list/send）；不改现有 IPC、权限和 sidecar 规则。Desktop 启动参数按安装状态选择全局插件或随包插件，避免重复注册；electron-builder 打包整个插件目录。

风险：多进程身份、旧 descriptor、重复投递、reload 资源释放、取消和不确定回执、接收时上下文已切换、读取大小界限。测试必须真实连本机端点并检验投递结果，不能靠源码包含字符串证明功能。

## 候选与上游核对

候选 A：独立轻量插件，每个活跃会话一个 loopback endpoint，按需发现，无后台 broker、无轮询；保持 Desktop 续接桥。候选 B：pi-intercom（现成独立 broker、会话 roster、send/ask/reply、收据和多种协调策略）。本任务只需有界交接，A 保持依赖及迁移范围较小；B 功能更完整但引入独立 broker 和另一套消息策略。后续核对资料、实现和验收结果补充于下。

## 实现中暴露并修掉的三个真实缺陷（红→绿证据：/tmp/pi-handoff-plugin-proof/）

1. **注册表必须是单一共享位置**。初版 `registry(registryDir)` 按调用方目录解析，A 的 send 在 A 的临时目录里找 B，谁都发现不了谁。改为从 `PI_CODING_AGENT_DIR`（缺省 `~/.pi/agent`）推导唯一的 `<agentDir>/handoff/descriptors/`；测试用 `beforeEach` 把 `PI_CODING_AGENT_DIR` 指到临时目录，避免污染真实注册表。
2. **探活不能走 `/send`**。用 `/send` 探活会把 ping 当成真实投递送进 `receive`，被插件层拒绝后 `probe` 判 stale 并删描述符——活 peer 全部消失。改为专用 `/ping`，只回 `{ok, instanceId}`，不触达会话。
3. **端口复用会让死 peer 伪装成活 peer**。`close()` 后 OS 可立即把端口分配给同进程里下一个 `startPeer`，`/ping` 照样 200。描述符与 `/ping` 应答都带上 `instanceId`（`randomUUID`，必须在 listener 创建前生成——初版放在 `peer` 对象里导致闭包读到 `undefined`，活 peer 全被判 stale），探活只有回显同一 `instanceId` 才算 live。

另外修正一处测试断言错误：transport 层不排除自身（排除是插件 `execute()` 的职责），原断言 `list() === []` 把「只剩自己」误判成失败。
