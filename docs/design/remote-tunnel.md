# 公网远程控制（内网穿透 + 自建云端中转）调研与设计

> **真实意图**：现在手机只能在同一 WiFi 下访问 `http://<局域网IP>:<port>/view?token=…`，出门就断。
> 需要让手机在任意公网（4G/5G/异地 WiFi）打开同一个远控页，且接入"傻瓜式"——不要求用户配路由器、不要求懂 NAT/端口映射。
> **日期**：2026-10-29
> **状态**：草案（外部调研进行中，第 2、3 节待补）

---

## 1. 现状与接入点（Phase 1，已完成）

### 1.1 现有远控实现

**文件**：`src/main/pi/remote-server.ts`（1252 行）

```
手机浏览器 ──HTTP──> RemoteServer (http.createServer, bind 0.0.0.0:随机端口)
                        │
                        ├── GET /view?token=…     静态页（内联 HTML/CSS/JS）
                        ├── GET /api/state        项目 + 会话列表（走 remote-visibility 过滤）
                        ├── GET /api/history      会话历史分页
                        ├── GET /api/events       SSE 长连接（服务端→手机实时推送）
                        ├── POST /api/prompt      发送消息（可带图，≤10MiB）
                        ├── POST /api/stop        停止当前回合
                        ├── POST /api/respond     审批应答（allow/deny）
                        └── POST /api/edit        编辑题面
```

**鉴权**（`remote-server.ts:177-185`）：

```ts
private authorize(req, url): boolean {
  const candidates = [url.searchParams.get('token') ?? ''];
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) candidates.push(header.slice(7));
  for (const supplied of candidates) {
    if (supplied.length && supplied.length === this.token.length &&
        crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) return true;
  }
  return false;
}
```

- token 是 `crypto.randomBytes(16).toString('hex')`，**每次 `start()` 重新生成**（`remote-server.ts:135`）
- 出现在 URL query 里，手机扫码即得
- 无过期、无轮换（除重启远控）、无速率限制、无失败锁定

**生命周期**：`start(preferredPort=0)` → 绑 `0.0.0.0`；`stop()` 关闭所有 SSE 连接后关服务。IPC 入口 `remoteStart`/`remoteStop`/`remoteStatus`（`src/main/index.ts:448-450`、`src/shared/pi.ts:210-212`、`src/preload/index.ts:124`）。

**局域网地址生成**（`remote-server.ts:163-175`）：遍历 `os.networkInterfaces()` 取非 internal IPv4，拼 `http://<ip>:<port>/view?token=<token>`。

### 1.2 关键事实（决定设计的硬约束）

| 事实 | 影响 |
|---|---|
| 服务是 **HTTP + SSE**，不是 WebSocket | 隧道必须支持「长连接单向流 + 短请求」；不能简单当 TCP 管道硬套 WebSocket-only 设计 |
| 绑 `0.0.0.0`，无 Host 校验、无 Origin 校验 | 公网暴露后可直接被任意 Host 访问，**穿透层必须自带防护** |
| token 在 URL query 里 | 会进浏览器历史、Referer、可能的日志；公网暴露后泄漏面变大 |
| 无速率限制 / 无失败锁定 | 公网扫描器可无限次猜 token（虽然 128bit 熵不可爆破，但可打 DoS） |
| `start()` 每次换 token | 隧道重连不能依赖 token 不变；也不能把 token 写死进云端配置 |
| 无现有隧道代码 | 全仓 grep `tunnel|ngrok|cloudflare|frp|relay` 无相关实现，需从零接入 |

### 1.3 要动的文件清单（预估）

| 文件 | 改动 |
|---|---|
| `src/main/pi/remote-server.ts` | 可能需支持「只绑 127.0.0.1」（隧道客户端本地连接），以及可选的 Host/Origin 校验 |
| `src/main/pi/tunnel-client.ts`（新建） | 隧道客户端：主动外连云端、注册端点、转发双向流量、重连退避 |
| `src/main/index.ts` | 生命周期挂载、IPC 通道注册、退出清理 |
| `src/shared/pi.ts` | `RemoteStatus` 扩公网 URL 字段；新增隧道状态类型 |
| `src/preload/index.ts` | 透出新 IPC |
| `src/renderer/pi/*`（远控设置页） | 展示公网地址 + 二维码，配置开关 |
| 新仓库 `pi-tunnel-server` | 云端中转服务（独立部署） |

### 1.4 已知约束与坑（项目内）

- `sync-release.mjs` 用 cwd 相对路径；打包在 worktree 里跑会写到 worktree 自己的 `release/`
- 远控页的可见性过滤走 `remote-visibility.ts`，已归档/子代理/副驾会话不可见（本次移动端看不到 pi-virtual-employee 即此规则所致）
- Electron 主进程无内置 WebSocket 客户端依赖限制，Node 22 有原生 `WebSocket`（客户端），服务端需 `ws` 或纯 TCP 实现

---

## 2. 外部调研

### 2.1 关键发现（会改变方案的三条）

**① Cloudflare Quick Tunnel 明文不支持 SSE——直接淘汰。**
官方原文（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/）：
> "Quick Tunnels create a temporary trycloudflare.com URL … **do not support Server-Sent Events (SSE)** … **no uptime guarantee** … up to 200 in-flight requests."

pi-desktop 的 `/api/events` 就是 SSE，且是实时推送的唯一通道。这条让「零配置免费隧道」的最优选项出局。

**② 现有 token 放在 URL query 里，违反 RFC 6819 对策。**
RFC 6819 §4.6.7 原文：
> "If access tokens are sent via URI query parameters, such tokens may leak to log files and the HTTP 'referer'. Countermeasures: **Use Authorization headers or POST parameters instead of URI request parameters** … reduced by **limiting scope and duration** and by enforcing **one-time token usage**."

现状：`remote-server.ts:169` 生成 `http://<ip>:<port>/view?token=<token>`，token 是 `randomBytes(16)` 且**无过期**。公网暴露后泄漏面显著扩大（Referer / 浏览器历史 / 二维码被拍照）。

**③ 国内自建中转会被基础设施层拦截。**
已验证：未备案域名打国内 VPS 的 80/443，会被云服务商劫持或 TCP 重置；《非经营性互联网信息服务备案管理办法》要求备案否则关站罚款。且 frp issue #4635 实证：*"frp 默认的 404 页面包含项目的 github 地址，会被国内运营商识别跳反炸页面"*、*"https 会 SNI 阻断"*。

### 2.2 SaaS 隧道对比（步骤数视角）

| 服务 | 从零到手机能打开 | 账号 | 装 binary | 关键限制（原文） | 能承载本需求？ |
|---|---|---|---|---|---|
| Pinggy | **1 步** `ssh -p 443 -R0:localhost:8000 free.pinggy.io` | 否 | 否 | "60 minutes tunnel timeout / Random subdomains" | ✗ 60 分钟断，随机域名 |
| Cloudflare Quick | 2 步 | 否 | 是 | **不支持 SSE**、无 uptime 保证、200 并发 | ✗ 硬性不符 |
| localtunnel | 2 步 | 否 | 是 | 共享域名 | ✗ 有劫持史（#627/#676） |
| Tailscale Funnel | 3 步 | 是 | 是 | 仅 443/8443/10000、TLS only、带宽不可配 | ~ 唯一「中转不可读明文」 |
| ngrok 免费 | 4 步 | 是 | 是 | 3 endpoint、**20k 请求/月**、**interstitial 警告页** | ✗ 扫码变两跳 |
| Cloudflare Named | 6 步 | 是 + **自有域名** | 是 | 免费无带宽硬限 | △ 可行但步骤多 |

### 2.3 端到端加密：只有 Tailscale Funnel 做到

官方原文：
> "This ensures that **Tailscale cannot access or read any content**. It maintains end-to-end encryption and privacy. The Tailscale server running on your device receives the encrypted request … then **terminates the TLS connection**."

ngrok / CF / serveo / Pinggy / localtunnel 均为**中转侧 TLS 终结、边缘可见明文**。对「完整桌面控制权 + AI 会话内容」而言，这意味着中转商理论上可读全部对话与审批流。

### 2.4 frp 的工程实现（值得借鉴的两点）

读源码取证（`fatedier/frp` dev 分支）：

- **协议**（`pkg/msg/msg.go`）：单字节类型前缀 + JSON —— `TypeLogin='o'`、`TypeNewWorkConn='w'`、`TypePing='h'`、`TypePong='4'`；`Login` 带 `PrivilegeKey` + `PoolCount` + `RunID`（断线重连带回身份）。
- **心跳**（`server/control.go`）：**客户端发 Ping，服务端只做超时裁决**（`if time.Since(lastPing) > HeartbeatTimeout { Close() }`），服务端 close 触发客户端重连。
- **「傻瓜式」的关键**：workConn **连接池预建**——取走一个后立即补一个（`ReqWorkConn`），访客请求不承担拨号延迟。

> 这条对 pi-desktop 很重要：若手机点开才建隧道，首屏要等 1~2s 握手。预建连接池能把这段延迟藏掉。

### 2.5 技术选型

| 维度 | 结论 | 依据 |
|---|---|---|
| 传输层 | **WebSocket over TLS** | 浏览器只能经 HTTPS+WS 到达；yamux/smux 主流实现均为 Go，Node 侧无同等维护度；QUIC 在 Node 22/26 无内置（实测 `require("node:quic")` → ERR_UNKNOWN_BUILTIN_MODULE），且 UDP 常被企业网/云安全组封 |
| 云端语言 | **Go**（与 frp 同构）；若坚持 Node 同构，长连接面用 **uWebSockets.js** 而非 Fastify/ws | uWS README 原文："written in 10,000 lines of C++ … is 13x faster than Fastify, 20x faster than Socket.IO"；benchmarks 页："Holding many WebSockets should not require lots of RAM" |
| 2C4G 容量 | **未找到可靠公开数据**，需自测 | 调研方明确拒绝引用未验证数字（原话：搜索引擎被反爬拦截，知名文章 JS 渲染抓不到正文） |
| TLS | **Caddy 前置**：自动 HTTPS + 通配符 DNS-01 | — |

### 2.6 安全与合规

**token 泄漏四个具体面**：Referer 头、浏览器历史/截图、中转商访问日志、**二维码被拍照**（= URL+token 的图像化，外泄即永久有效）。

**被扫描是必然**：frp #4844 实证 *"frp服务器开放的端口遭受持续暴力攻击"*，且 *"无法屏蔽IP，只能在frps服务端想办法"*。

**被滥用过的域名会被企业网封杀**：ngrok 被 MITRE ATT&CK 收录为攻击者工具 **S0508**；Trend Micro 报告 *"Malware and phishing attacks using cloud tunneling services, particularly ngrok, have seen a dramatic increase"*。

**国内合规档位**：花生壳/natapp/cpolar 等已备案商用隧道商承载用户流量，是「傻瓜式 + 合规」的唯一现成产品形态（花生壳官网：*"送国内备案服务"*）。

**自建开放给他人的风险**：《刑法》287 条之二帮信罪——*"明知他人利用信息网络实施犯罪，为其犯罪提供互联网接入、服务器托管、网络存储、通讯传输等技术支持"*。自用风险低，公开传播有实质刑责敞口。

---

### 2.7 ZCode 的远控实现（2026-10-29 实测调研，源码级）

调研对象 `zai-org/ZCode`（TypeScript，约 100MB 仓库）。**它有完整的公网远控能力，且形态与你的需求高度吻合。**

#### 架构总览

```
桌面端 (device)                    云端 relay                    手机 (terminal)
     │                                 │                              │
     │  POST /api/v1/remote/device      │                              │
     │  Authorization: Bearer <JWT>    │                              │
     ├────────────────────────────────>│  注册得 device_sid            │
     │  POST /api/v1/remote/token       │                              │
     │  {role:"device"}                │                              │
     ├────────────────────────────────>│  一次性 token(60s 有效)       │
     │  WS /api/v1/remote/ws2?token&mid │                              │
     ├────────────────────────────────>│  消费 token → auth_init(SID)  │
     │<────────────────────────────────┤  auth_ack(pair=waiting)       │
     │                                 │<─────────────────────────────┤
     │                                 │  同账号 JWT + token(terminal) │
     │                                 │<─────────────────────────────┤
     │                                 │  auth_ack(pair=matched)       │
     │<────────── pair_status_ack ─────┤                              │
     │<──────────── data(payload) ─────┼────────── data(payload) ────>│
```

源码位置：
- `packages/desktop/src/main/webRemoteControlManager.ts`（manager，设备身份与窗口 runtime 的唯一 owner）
- `packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts`（WS device transport）
- `packages/desktop/src/main/web-remote-relay/webRemoteControlV2Http.ts`（register/token/delete）
- `packages/desktop/src/main/web-remote-relay/webRemoteControlDeviceStorage.ts`（身份持久化）
- `packages/client/src/webRemoteControl*`（手机侧 relay 协议）
- 契约文档 `docs/web-remote-control/relay-v2-pairing.md`

#### 五个可直接借鉴的设计

**1. 三层身份，二维码里没有任何凭证**

```
JWT（账号登录态，只在桌面→relay 的 HTTP 上用，Bearer header）
  └─ device_sid（设备身份，注册得到，存 AppSettings）
       └─ token（一次性，60 秒有效，只用于 WS upgrade 前原子消费）
```

二维码 URL 只含 `sid`/`mid`/`name`/`app_version` 路由提示。契约文档原文：

> **JWT/token 不进入二维码或业务消息。**

这直接解决了你担心的「二维码被拍照 = 永久钥匙」问题。

**2. 一次性 token + 原子消费**

> Token 是 16 随机字节的 22 字符 Base64URL 无填充编码，绑定用户与角色，不绑定 SID；签发带 `Cache-Control: no-store`，**有效期 60 秒。在 WS Upgrade 前原子消费，失败不恢复，重连必须重新申请。**

重连要重新拿 token，所以泄露的 token 窗口只有 60 秒。

**3. 心跳 + ACK deadline 主动踢连接**

```
V2 心跳基准 5,000ms、jitter ±1,000ms、ACK deadline 15,000ms
```

代码里 `WebRemoteControlV2Heartbeat` 超时会 `scheduleReconnect()`。且**同角色新连接会踢掉旧连接**（发 `KICKED` 后关闭），防止一份账号多处复用。

**4. relay 不持有任何业务状态**

> Relay 不保有 task、workspace、stream 或已提交输入。

云端只做「认身份 + 按角色转发」，不碰业务数据。这大幅降低了云端被攻破的影响面，也让云端实现极简。

**5. 手机端与桌面端是同一套 relay 协议的两个角色**

不是「HTTP 反向代理」，而是**双工 WebSocket 消息路由**。桌面既是被控端也是服务端（自己起 WS 连出去），手机是另一个客户端。这意味着：

- 不需要把桌面端口暴露给任何人
- 桌面可以躲在 NAT 后面（主动外连）
- 手机与桌面之间的 payload 是透明的 JSON，relay 不解析

#### 但它有两个不适用的地方

**① 依赖账号体系（JWT）**

ZCode 的 relay 要求用户登录态，`Authorization: Bearer <JWT>`。你的需求是「配一个地址 + 一个 key」，**不想要账号系统**。这点必须改造：把 JWT 换成一把预共享 key（PSK）。

**② relay 是 Go 写的中心化服务**

契约依据里写明 `zcode-server` 的 `internal/domain/relay_v2/proto.go` —— 云端是 Go 服务。这意味着要么自建、要么用他们的服务。

#### 对 pi-desktop 的适配判断

**可以照搬的**：三层身份模型、一次性 token、二维码不含凭证、心跳/ACK deadline、同角色踢旧连接、relay 不持业务状态。这套设计几乎就是为你「地址 + key 且安全」的需求量身定做的。

**必须改造的**：
- JWT → **预共享 key**（你要的「一个 key」）。桌面与手机都用同一个 key 向 relay 表明身份，relay 校验 key 才允许注册/建连。
- 去掉账号/用户隔离维度（单人使用，按 key 隔离足够）

### 2.8 DeepSeek Harness 的远控实现（2026-10-29 实测调研，源码级）

调研对象 `deepseek-ai/deepseek-harness`（TypeScript，默认分支 `master`，约 32 万 star 级仓库）。它的对应功能叫 **LiveShare**（`packages/experimental/liveshare/`）。

#### 架构总览

```
owner host（桌面）              Liveshare server（Relay）         viewer（手机/他人）
      │                                │                              │
      │  发布一个 Session               │                              │
      │  {shareId, sessionId,          │                              │
      │   accessMode, sessionMode,     │                              │
      │   allowedSubjectIds, expiresAt}│                              │
      ├───────────────────────────────>│  存储 share 行                │
      │                                │<─────────────────────────────┤
      │                                │   viewer 拿链接进来           │
      │                                │   Relay 先做准入判定           │
      │<───────── viewer 请求 ──────────┤                              │
      │  host 自己读请求、以 viewer     │                              │
      │  自己的 Peer 身份派发           │                              │
      │  并被约束在 share 授权的         │                              │
      │  workspace 沙箱内               │                              │
```

源码位置：
- `packages/experimental/liveshare/src/host/share-remote.ts`（owner 侧 Remote 服务：create/list/stop/updatePermissions/setCapabilities/relay）
- `packages/experimental/liveshare/src/host/relay-authority.ts`（Relay 授权状态的本地镜像与重新校验）
- `packages/experimental/liveshare/src/host/relay-url.ts`（Relay 地址规范化）
- `packages/experimental/liveshare/src/client/share-relay-address.ts`（配置 UI 的状态机）
- `packages/experimental/liveshare-protocol/src/tunnel-protocol.ts`（wire 帧定义）
- 官方文档 `docs/subsystems/liveshare.md`、`packages/experimental/liveshare-protocol/README.md`

#### 与 ZCode 的关键差异：**viewer 从不直接碰桌面**

这是它与 ZCode 最本质的区别。官方文档原文：

> A viewer never receives the owner's tools: **the owner host reads each viewer request itself, dispatches it as that viewer's own Peer**, whose `share-viewer` principal the Gateway decides through the remote access policy this package registers, and **constrains everything a shared Session runs on the viewer's behalf to the workspace the share granted**.

也就是说 Relay 只做「准入 + 转发」，**所有工具调用都在 owner 机器上执行，且被沙箱限制**。viewer 不是在遥控桌面，而是在「借用桌面的一个受限会话」。

#### 五个值得借鉴的设计

**1. 能力声明而非版本协商**

```ts
export const LIVESHARE_CAPABILITIES = [
  'session-mode', 'fork', 'acl-subjects', 'expiry',
  'owner-credential', 'scoped-rpc-response',
  'unsupported-frame-refusal', 'share-access-state',
  'actor-credential', 'direct-connection',
] as const
```

官方 README 原文：

> Relay compatibility uses declared versions, capabilities, and explicit refusals, **not per-release frame translation or common-subset negotiation**. Independently deployed peers have no agreed historical support window.

这解决了「relay 与客户端版本不一致」的兼容噩梦——不猜对方支持什么，明确声明 + 明确拒绝。

**2. 授权状态由 Relay 声明，本地只做镜像**

> The committed frame is the authority: **a reader follows it, not the request that produced it.**

且每次操作都重新读：

> Each operation re-reads the Relay grants of the shares that keep the Session drivable, and **each reading is synchronous with the tool call it authorizes**, so input queued past the grant that admitted it cannot act on that stale admission.

**3. Fail-closed 的权威快照**

> An unavailable snapshot **fails closed** instead of borrowing persisted ACLs.

拿不到授权状态就拒绝，而不是用本地缓存的旧 ACL 放行。

**4. viewer 状态有完整词汇表，拒绝也讲清原因**

> A viewer read that ends in a refusal names its own condition rather than one failure for every cause: the Liveshare server answers a missing link, a share the owner stopped, an expired share, an owner whose machine holds no route, an expired sign-in, a reader who has not asked, a request still waiting, a request the owner refused…

`VIEWER_STATE_ANSWERS` 是受测的封闭词表。这对应你遇到的「空白确认框」类问题——**每个拒绝都有名字**，不会出现无信息的空白态。

**5. 地址规范化拒绝凭据入 URL**

```ts
if (url.username !== '' || url.password !== '') {
  throw new Error('liveshare relayUrl must not include credentials')
}
```

配置 Relay 地址时**显式拒绝** `https://user:pass@host` 形式，与 RFC 6819 对策一致。

#### 它的复杂度更高

LiveShare 引入了：身份三元组（providerId/tenantId/subjectId）、ACL、fork（viewer 可派生自己的子会话）、读写分层沙箱、share-access-state 版本化快照。这些是**为「把会话分享给同事」设计的多租户能力**。

你的场景是**单人 + 一把 key**，这些大多不需要。

### 2.9 两个开源实现的对照与取舍

| 维度 | ZCode Relay V2 | DeepSeek Harness LiveShare | 采哪个 |
|---|---|---|---|
| 拓扑 | 双工 WS，device/terminal 两角色 | Relay 只准入+转发，**owner host 自己执行 viewer 请求** | **ZCode**（简单；你不需要多人协作） |
| 身份 | JWT → device_sid → 一次性 token | 身份三元组 + ACL + credential | **ZCode 的三层，但 JWT 换成预共享 key** |
| 二维码 | 只含 sid/mid/name，**无任何凭证** | 链接由 owner 发布，Relay 判定准入 | **ZCode** |
| token | 16 随机字节、60s、升级前原子消费 | actor credential，owner 可验证 | **ZCode** |
| 心跳 | 5s±1s / ACK 15s / 同角色踢旧连接 | 同 | **ZCode** |
| 兼容策略 | — | **能力声明 + 明确拒绝**，不做版本协商 | **Harness**（这条显著更好） |
| 授权状态 | Relay 是 owner，pair_status | **committed frame is the authority** + 每次操作同步重读 | **Harness** |
| 快照缺失 | — | **fail closed**，不借旧 ACL | **Harness** |
| 拒绝语义 | 错误码枚举 | **封闭状态词表**，每种拒绝一个名字 | **Harness**（直接治你的空白框问题） |
| 地址校验 | — | **显式拒绝 URL 内嵌凭据** | **Harness** |
| 沙箱/ACL/fork | 无 | 有（为多租客设计） | **不要**（单人场景过重） |

**结论：拓扑与身份学 ZCode，韧性与错误语义学 Harness。**

---

### 方案 A：不做隧道，只做「配对 + 短时效 session」

不动网络层，先把当前 token 模型修对：二维码载**一次性 pairing code**，换取短时效 session token，走 `Authorization` 头，服务端加限速与失败锁定。

- 改动面：`remote-server.ts` 鉴权层 + `/view` 页 + 手机端存储
- 风险：低
- 价值：**这是所有其他方案的前置条件**，且独立可交付

### 方案 B：自选 SaaS 隧道（产品内建「中转选择器」）

不自己做云端，把隧道能力做成可插拔：用户按自己的情况选一档。

- 国内合规档：花生壳 / natapp / cpolar（已备案，傻瓜式）
- 极客安全档：Tailscale Funnel（唯一中转不可读明文）
- 自建档：境外 VPS + frp

- 改动面：`tunnel-client.ts` 适配层 + 设置页 UI
- 风险：中（依赖第三方可用性）
- 价值：不需要维护云端服务，**最快能满足「出门能用」**

### 方案 C：自建云端中转（新仓库）

用户最初的想法。调研后的问题：

1. 国内部署需备案，未备案会被劫持/重置
2. 境外部署 → 大陆手机链路不稳定（Tailscale 都有大量国内 issue：#12532/#10815/#10136/#4082）
3. 中转侧 TLS 终结 = 云端可见全部会话内容（除非自做端到端加密，如 Tailscale 方案）
4. 开放给他人有帮信罪风险
5. 2C4G 容量无公开数据，需先自测

- 改动面：新仓库 + 客户端 + 运维
- 风险：高
- 价值：完全可控，但成本最高

### 2.10 最终推荐：ZCode 拓扑 + Harness 韧性（方案 D）

> 2026-10-29 更新：调研 ZCode 与 DeepSeek Harness 后，原「A → B」建议被取代。两家用**双工 WebSocket + 一次性 token**解决了「公网可达 + 不暴露端口 + 二维码不含凭证」，且 relay 极简、不持业务状态。这条路同时满足你的两个硬要求：**只需配一个地址 + 一个 key**，且 key 不进入 URL。

| 方案 | 能否满足「地址+key」 | SSE 可用 | 需账号 | 需备案 | 结论 |
|---|---|---|---|---|---|
| A 仅修鉴权 | ✅ | ✅（仅局域网） | 否 | 否 | 必要但不够，**作为 D 的第一步** |
| B SaaS 隧道 | ✅ | ❌（Quick Tunnel 明确不支持）/ △ | 部分要 | 部分要 | 放弃（见 2.1/2.6） |
| C 自建 HTTP 反代 | ✅ | ✅ | 否 | 境内要 | 次优（比 D 多暴露一层） |
| Tailscale Funnel | △ 要装 tailscaled | ❌（实测 HTTP/2 下 SSE 无数据） | 要 | 否 | **实测否决** |
| **D ZCode 拓扑 + Harness 韧性** | ✅ | ✅ | **否（预共享 key）** | 境外部署则否 | **推荐** |

**为什么 D 优于 C（都是自建）**：

- C 是「云端反代 → 桌面端口」，桌面要么开公网端口，要么桌面也常驻 tailscaled；D 是「桌面主动外连 WS」，桌面**不需要任何入站端口**，NAT 后天然可用。
- C 的云端能看到全部明文（TLS 终结在云端）；D 的云端只按 sid 转发，**可以在应用层再做端到端加密**（payload 由桌面与手机协商密钥，relay 读不到内容）。
- C 的 key 校验在云端 HTTP 层；D 的 key 用于设备注册 + token 签发，一次性 token 60 秒窗口。

**为什么不用更简单的替代**：

- 直接把 URL 换成隧道域名 → Quick Tunnel 不支持 SSE、localtunnel/serveo 有劫持停机史、ngrok 免费档有 interstitial 且 20k 请求/月
- Tailscale Funnel → 已在你的 ECS 上实测：**公网 SSE 零数据流出**（HTTP/2 缓冲），且 ts.net 解析到德国 DERP，境内链路无 SLA

---

## 4. 详细设计（推荐方案 D：ZCode 式自托管 relay）

### 4.0 总体数据流

```
┌── 桌面机（NAT 后，无入站端口）─────────┐
│                                        │
│  remote-server.ts（现有，不动）          │
│    ↑ 本地 HTTP + SSE                   │
│  tunnel-client.ts（新增）               │
│    · 持有 relay 地址 + 预共享 key        │
│    · POST /device 注册得 device_sid     │
│    · POST /token 拿 60s 一次性 token    │
│    · WS 连出去，auth_init(sid, meta)    │
│    · 把 relay 来的 JSON 帧转成本地 HTTP  │
└────────────────────┬───────────────────┘
                     │ 主动外连 WSS
        ┌────────────▼────────────┐
        │  relay（ECS，极简）       │
        │  · 校验预共享 key         │
        │  · sid ↔ 连接 映射        │
        │  · 按角色双向转发          │
        │  · 不解析 payload          │
        │  · 心跳 5s / ACK 15s      │
        │  · 同角色新连接踢旧连接     │
        └────────────┬────────────┘
                     │ WSS
        ┌────────────▼────────────┐
        │  手机浏览器               │
        │  · 扫码得 sid/mid 路由提示 │
        │  · 同 key 注册 terminal    │
        │  · WS 连进来 → 配对成功    │
        │  · 渲染远程控制页          │
        └──────────────────────────┘
```

**关键点：桌面端口始终不暴露**，relay 只认 key 与 sid，payload 透明转发。

### 4.1 阶段 1：本地鉴权加固（可独立交付，先做这个）

在动任何网络之前，先把现有的「URL 里长驻 token」修掉。这一步**独立有价值**（局域网也更安全），且是阶段 2 的前提。

数据流：

```
桌面                              手机
 │── 二维码只含 6 位 pairing code ──>│
 │<─ POST /api/pair {code} ─────────│
 │─ {session, ttl} ────────────────>│  存 sessionStorage，不进 URL
 │<─ 后续 Authorization: Bearer ────│
```

| 文件 | 改动 |
|---|---|
| `src/main/pi/remote-server.ts` | 新增 pairing code（TTL 120s + 一次性）；`authorize()` 优先读 `Authorization` 头；新增每 IP 失败计数与锁定 |
| `src/main/pi/remote-server.ts` 内联页 | `/view` 收 code → `POST /api/pair` → 存 sessionStorage；二维码只渲染 code |
| `src/shared/pi.ts` | `RemoteStatus` 增加 `pairing?: { code, expiresAt }` |

**兼容**：保留 URL token 作为过渡（标记 deprecated），避免升级后旧二维码立刻失效。

**测试**：code 过期拒绝、同一 code 只能用一次、无 URL token 但带有效 session 通过、连续失败 N 次锁定。

### 4.2 阶段 2：relay 服务端（新仓库）

**接口契约**（对齐 ZCode V2，但 JWT 换成预共享 key）：

| 方法与路径 | 请求 | 成功 data |
|---|---|---|
| `POST /api/v1/remote/device` | `{device_mid}` + `X-Relay-Key` | `{device_sid}` |
| `POST /api/v1/remote/token` | `{role:"device"\|"terminal"}` + `X-Relay-Key` | `{token, expires_in:60}` |
| `WS /api/v1/remote/ws2?token=&mid=` | — | — |

WS 消息（JSON 文本，单条 ≤1 MiB）：

| 方向 | 消息 | 字段 |
|---|---|---|
| → relay | `auth_init` | `device_sid`、可选 `meta`、`client_ts` |
| → relay | `pair_status_query` | 可选 `client_ts` |
| → relay | `data` | `payload`（任意 JSON）、可选 `client_ts` |
| relay → | `auth_ack` | `device_sid`、`terminal_sid`、`pair_status` |
| relay → | `pair_status_ack` | `terminal_sid`、`pair_status` |
| relay → | `data` | `payload`、可选 `server_ts` |
| relay → | `error` | `code` |

**必须照搬的不变式**（ZCode 契约 + Harness 韧性设计）：

**来自 ZCode：**

1. token 一次性、60 秒有效、WS upgrade 前原子消费，失败不恢复
2. 心跳 5000ms ±1000ms jitter，ACK deadline 15000ms
3. 同角色新连接替换旧 owner，先发 `KICKED` 再关闭；旧连接异步 close 不得移除新 owner
4. relay 不保有 task/workspace/stream，只按 sid 与角色转发

**来自 DeepSeek Harness（这几条直接治你遇到的问题）：**

5. **能力声明而非版本协商**：连接时双方声明 capabilities 列表，不猜对方支持什么；不认识的帧返回**明确的 refusal**，而不是静默丢弃或崩溃。
   ```ts
   // relay 与客户端各自声明，拒绝时给出具名错误
   const LIVESHARE_CAPABILITIES = ['session-mode','fork','acl-subjects','expiry',
     'owner-credential','scoped-rpc-response','unsupported-frame-refusal',
     'share-access-state','actor-credential','direct-connection']
   ```
6. **授权状态以 Relay 声明的为准，每次操作同步重读**：排队期间授权过期不得放行（"input queued past the grant that admitted it cannot act on that stale admission"）。
7. **权威快照缺失时 fail closed**：拿不到授权状态就拒绝，不借用本地旧 ACL。
8. **封闭的拒绝状态词表**：每种拒绝条件有唯一名字与答案，不允许出现「无信息的空白态」。这一条正是你手机端**空白确认框**的对症解法——任何渲染不出来的交互都必须有具名原因，而不是兜底成「需要你的确认」+ 空输入框。
9. **地址规范化显式拒绝内嵌凭据**：`https://user:pass@host` 直接抛错，与 RFC 6819 对策一致。

**部署**：放你的 ECS，`8443` 端口（避开 80/443 的备案审查）。TLS 用 Caddy 前置自动签证书——已在 ECS 上验证过 Let's Encrypt 可达（证书实际申请成功过）。

### 4.3 阶段 3：桌面 tunnel-client

| 文件 | 改动 |
|---|---|
| `src/main/pi/tunnel-client.ts`（新建） | 持有 relay 地址 + key；注册/token/WS；把收到的 JSON 帧转成对本地 `remote-server` 的 HTTP 调用，反之把 SSE 事件序列化成 `data` 帧 |
| `src/main/pi/remote-server.ts` | **不改**。tunnel-client 只作为它的一个「虚拟客户端」 |
| `src/main/index.ts` | 生命周期挂载、IPC `tunnelStart/tunnelStop/tunnelStatus`、退出清理 |
| `src/shared/pi.ts` + `src/preload/index.ts` | 扩类型与 IPC |
| `src/renderer/pi/RemotePane.tsx` | 配置区：relay 地址 + key；展示公网二维码（只含 sid/mid/name） |

**配置就是你要的两个字段**：

```
relay 地址:  https://你的ECS:8443
relay key:   <预共享密钥>
```

### 4.4 第一步最小可验证切片

**只做阶段 1（本地 pairing code + 短时效 session）**，不碰 relay。

验收：手机扫码 → 不用 URL 里的 token → 关掉浏览器重开仍能用 → 2 分钟后 code 再用失效。

这一步能在你的 Mac 上完整验证，**不依赖 ECS、不依赖新仓库**，且即使阶段 2/3 推迟也已经提升了局域网场景的安全性。

---

## 5. 盲区与待拍板

### 5.1 盲区（证据不足，不能当结论）

- **2C4G 能撑多少并发 WS 连接**：无可靠公开数据。relay 上线前需自测（ZCode 的假 relay 测试只覆盖功能，不覆盖容量）。
- **大陆手机 → ECS(境内) 的链路质量**：ECS 在境内（阿里云），这条比境外隧道乐观，但**未实测**移动网络下的握手时间与稳定性。
- **端到端加密是否必要**：当前设计里 relay 能读到 payload 明文（与你 CCR 会话内容、审批流同级）。ZCode 也没做端到端加密（它靠账号信任自己的服务）。若你要求 relay 也读不到，需再加一层桌面↔手机协商的应用层加密——**这会显著增加复杂度**，我未展开设计。
- **ZCode relay 的账号维度如何完整裁剪**：只读了契约文档与桌面侧源码，未读 `zcode-server` 的 Go 实现，所以「去掉账号后是否引入新漏洞」这一条是推断，不是验证过的。

### 5.2 需要你拍板

1. **是否按方案 D 推进？** 我推荐：先做阶段 1（本地 pairing，1 个 PR、无新依赖），验证后再做阶段 2/3。
2. **relay 部署在哪？** 你已有 ECS（境内、2C4G）。用 8443 避开备案审查；若要 443 则需备案。这条决定部署形态。
3. **relay 语言选 Node 还是 Go？** 我倾向 **Node**（与 pi-desktop 同栈、你能自己改；负载远未到需要 Go 的程度）。若你更看重长连接密度，选 Go 可对齐 ZCode/frp。
4. **是否要求端到端加密**（relay 也读不到内容）？要的话复杂度上一个台阶，需要单独设计密钥交换。
5. **阶段 1 要不要现在就开始做？** 它独立有价值、可在 Mac 上完整验证、不依赖 ECS 与新仓库。
> 附带一条已被证伪、不要外传的说法：localtunnel npm 包「2024-09 投毒」不成立（OSV 查询返回空，最后版本 2.0.2 停在 2021-09）。

