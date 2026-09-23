---
name: pi-desktop-mobile-view-plan
description: 手机看工作区已全量实现（2026-09-20）：局域网扫码只读 RemoteServer + IM 适配层架构双向机器人（钉钉Stream/飞书长连接/TG轮询，渠道与命令引擎解耦）
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

2026-09-20 用户确认"做方案一 + IM机器人两个方式吧 和zcode一样"，两者已实现并验证：

**A. 局域网手机查看（已上线）**：`src/main/pi/remote-server.ts` 的 `RemoteServer`——opt-in 启动、绑 0.0.0.0、随机 32-hex token（timingSafeEqual 校验）、**严格只读**（仅 GET 路由）。端点：`/view`（内嵌单文件移动页，vanilla JS + SSE）、`/api/state`、`/api/history?session=key`、`/api/events`（SSE，复用 broadcast() 分流，上限 8 客户端）。渲染层 `src/renderer/pi/RemotePane.tsx`（设置→工作区顶部，与 ConnectionPane 并列），二维码用 `qrcode` 包渲染层动态 import。UI 按 ZCode 参考图重做过：大二维码卡片（等待手机连接/已连接 N 台设备，viewers 3s 轮询）+ 复制链接/刷新二维码(重生成 token)/停止 + Bot Channel 渠道卡片网格。smoke 钩子 `PI_SMOKE_REMOTE=<port>`（保活 60s 供 curl）。curl 实测 401/只读边界全过。

**B. IM 机器人（已上线，双向）**：**用户纠正过架构——必须做适配层，渠道与核心解耦，用户在 UI 选渠道**（不要写死单一渠道）：
- `src/main/pi/bot/engine.ts`：渠道无关纯命令引擎（/帮助 /状态 /新建(=/clear) /项目 /模型 /模式 /思考 /回复 /bind + 自由文本=发到当前任务），per-chat bindings（cwd+mode）持久化在 ImConfig.bindings
- `src/main/pi/bot/actions.ts`：`createBotActions(host, settings)` 把命令映射到 pi 能力；机器人建的会话默认 permission 'ask'，工具确认留在桌面端
- `src/main/pi/bot/transport.ts`：ImTransport 接口（start(ctx)/stop）
- 三个适配器：`dingtalk-stream.ts`（Stream：网关 openConnection→WSS→逐条 ackFrame(200/500)→心跳→断线重连，回复走 sessionWebhook POST）、`feishu-longconn.ts`（飞书长连接，标注实验性）、`telegram-polling.ts`（长轮询，仅 BotFather token）
- `im-bot.ts` 的 ImBot：actions 参数是**惰性工厂**（host 在 whenReady 才存在）；`syncTransport()` 按 config 变更键启停传输，save() 自动调用；通知推送 fireOnce 按 generation 去重、best-effort
- UI：RemotePane 渠道卡片 钉钉(双向+通知)/飞书(双向·实验)/Telegram(双向,需能访问TG)/微信(置灰暂不支持)；钉钉填 AppKey/AppSecret+双向开关，TG 填 botToken
- 主进程：index.ts `imBot.syncTransport()` on whenReady 自动恢复；before-quit `stopTransport()`

**验证**：153 tests 全过。新增 bot-engine.test.ts（命令路由/绑定）+ bot-transports.test.ts（**假网关端到端**：真 http+ws 服务器，收消息→验 ack→sessionWebhook 回复）。钉钉签名=HmacSHA256(secret, `${ts}\n${secret}`) 后 encodeURIComponent 进 URL；飞书签名 key=`${ts}\n${secret}` 空 message。

**遗留**：双向连接需用户在钉钉开放平台建企业内部应用（Stream 模式）实测全链路；`/回复` 详细程度未实现；外网访问（cloudflared/Tailscale）未做。
**Why:** 用户想要 ZCode 式远程查看/控制但开源无中转服务器；"桌面自身即服务端 + 出站连接"零自建基础设施；适配层让加新 IM 只需一个 adapter 文件。
**How to apply:** 改动时保持只读/出站边界、token 失效语义、渠道-引擎解耦（新渠道只写 adapter）；测试渠道协议用假网关注入。相关：[[pi-desktop-task-board-workflow]]
