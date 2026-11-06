# 会议录音模式 调研与设计

> 真实意图 / 日期 / 状态（草案）
>
> - **真实意图**：让用户能录制数小时会议，过程中分段转写、失败可补，最后把全部 transcript 合并成结构化会议纪要；不是简单调大输入框麦克风的单段上限。
> - **日期**：2026-11-05
> - **状态**：草案，Phase 1 内部摸底已完成，Phase 2 外部调研进行中。
> - **目标项目**：`xiaoliu10/pi-desktop`

## 1. 现状与接入点

### 1.1 数据流（改动前）

```text
用户点击输入框麦克风
  → renderer: VoiceInputButton
      getUserMedia + MediaRecorder 连续采集
      内存 chunks 聚合；5 分钟定时器强制 stop
      整段 decode → 16k mono WAV（失败则保留 webm/mp4）
  → IPC localPi.voiceTranscribe(bytes, mime)
  → main: VoiceService.transcribe()
      读取 voice.json 的 active ASR model
      safeStorage 解密 key
      单次 POST /audio/transcriptions 或 /chat/completions
  → renderer: transcript 追加到输入框
  → 用户检查后手动发送
```

### 1.2 关键现状事实

| 事实 | 位置 / 来源 |
|---|---|
| 单次录音上限固定 **5 分钟**：`VOICE_MAX_RECORD_MS = 5 * 60_000` | `src/shared/voice.ts:62` |
| 上传音频硬上限 **24 MiB**，注释说明对齐 OpenAI 转写接口限制 | `src/shared/voice.ts:64` |
| 录音在 renderer 用 `getUserMedia + MediaRecorder`，数据保存在内存 `chunks`，`rec.start(250)` 定期产出 chunk，到 5 分钟后 `stopRef.current()` 强制停止 | `src/renderer/pi/VoiceInputButton.tsx:93-136` |
| 停止后才把整段 blob 解码为 16k mono WAV；`AudioContext` 不可用或解码失败时按原始格式上传 | `src/renderer/pi/VoiceInputButton.tsx:10-22,103-111` |
| 主进程转写只接受一次完整字节数组，超过 24 MiB 直接拒绝；ASR 配置来自 `voice.json`，key 在 main 解密 | `src/main/pi/voice-service.ts:173-184` |
| 两种 ASR 调用方式：OpenAI 兼容 `/audio/transcriptions` 和 Chat 多模态 `/chat/completions`；Chat 方式把音频编码成 base64 data URL | `src/main/pi/voice-service.ts:192-233` |
| 单次转写请求共用 **120 秒**超时预算 | `src/main/pi/voice-service.ts:23` |
| 现有结果只追加到输入框，不自动发送；UI 明确提示“不共享主会话上下文” | `docs/voice-input.md:3`、`src/renderer/pi/SidecarPanel.tsx:38-39` |
| 语音输入按钮由 `PiReplicaApp` 作为 `voiceSlot` 注入 ChatView；转写文本由 `appendTranscript` 追加到草稿 | `src/renderer/pi/PiReplicaApp.tsx:645-658`、`src/renderer/replica/chat/ChatView.tsx:1748-1756` |
| pi 普通输入单条文本最大 **200000 字符** | `src/main/pi/backend.ts:940-942` |
| 工作台已有稳定 tab/slot 架构：review / files / browser / aux；browser 和 aux 使用 keep-alive 插槽，切换 tab 只改 `display` | `src/renderer/replica/workbench/WorkbenchPanel.tsx:41-45,66-73,164-172` |
| 项目已有大量主进程 JSON 状态文件先例：`voice.json`、`sidecar-map.json`、automations 等；敏感值走 safeStorage，普通配置常做原子写入 | `src/main/pi/voice-service.ts:87`、`src/main/pi/sidecar-service.ts:137`、`src/main/pi/automation-service.ts:58` |

### 1.3 音频规模推断（推断）

- 16 kHz / mono / 16-bit PCM WAV 理论码率约 **32 KiB/s**：
  - 5 分钟 ≈ 9.6 MiB；
  - 1 小时 ≈ 115 MiB；
  - 2 小时 ≈ 230 MiB。
- 原始 webm/opus 更小，但浏览器/平台/码率差异大；不能把它当作可控上限。
- 因此“录几小时后一次性上传”不可行，必须**边录边切段、边转写、边落盘**。此判断来自当前常量与本地转码公式，非实测。

### 1.4 可复用的项目内同类实现

1. **输入框语音录制**：`VoiceInputButton` 已经处理麦克风权限、ASR 就绪检查、MediaRecorder 兼容 mime、停止/失败清理、session key 防 late callback。会议模式应复用这些状态机经验，但不能继续把整段 Blob 放在单个 `chunks` 数组里。
2. **ASR 配置与调用**：`VoiceService` 已经解决 API key 加密、模型选择、两种调用方式、404 回退、错误脱敏。会议模式不应另建一套 ASR 配置，应新增按段调用能力或从 `VoiceService` 提取可复用方法。
3. **主进程配置存储**：`VoiceService` / `SidecarService` / automation service 已有 JSON 持久化与密钥隔离经验，meeting 的 session index 可放在 `userData/meetings/`。
4. **工作台面板**：`WorkbenchPanel` 已有长生命周期 tab/slot 模式，会议面板适合作为新的 keep-alive slot，避免切 tab 后录音中断。
5. **pi 会话发送**：`backend.prompt()` 有单次 200k 字符限制和完整运行态校验。纪要生成不能简单把数小时 transcript 塞进一条 prompt，需要分段/分步生成，或让模型通过 `read` 工具读取已落盘的 transcript 文件。

### 1.5 初步接入点

| 层 | 接入点 |
|---|---|
| shared contract | 新增 `src/shared/meeting.ts`：meeting 元数据、segment 状态、transcript entry、minutes 状态、IPC 返回类型。 |
| main service | 新增 `src/main/pi/meeting-service.ts`：meeting 目录、segment 索引、transcript 状态、重试、导出；不直接放业务逻辑进 `index.ts`。 |
| main ASR | 扩展 `VoiceService`：暴露“按已落盘文件/字节转写”的能力，保留现有 `voiceTranscribe` 给输入框使用；会议段可绕过 24 MiB 的单段限制，但每段仍要受服务端限制。 |
| IPC | `src/main/index.ts` 注册 `meetingStart/appendSegment/stop/retry/list/open/export` 等 handler；渲染进程只在完成一段后传字节，不做小时级单次 IPC。 |
| renderer | 新增 `MeetingPanel`；挂进 workbench，录音状态跨 tab 保留。 |
| transcription worker | 长会话转写应有队列和重试；若主进程请求阻塞明显，再考虑 utility process，不作为 MVP。 |
| minutes generation | 先用当前/指定 pi 会话 + 分段 prompt（map-reduce），或让会话读取落盘 transcript 文件；不能默认一条 prompt 塞全会。 |

### 1.6 约束与坑

- **隐私边界**：会议音频会上传到用户配置的 ASR 服务；UI 必须提示，且音频/转写只存本地。
- **密钥边界**：API key 已经只在 main 解密；meeting service 不能把 key 返回 renderer。
- **大小边界**：单段仍需受 ASR 服务限制。不能把 24 MiB 简单改成“无限”。
- **连续录音状态**：工作台切 tab、隐藏窗口、收起 panel 都不能销毁 recorder；应沿用 workbench keep-alive 思路。
- **系统睡眠/麦克风设备变化**：2 小时会议可能遇到系统休眠、蓝牙耳机切换、macOS 权限撤销。必须有断段保存和可续录语义。
- **转写队列**：5 分钟一段、2 小时会议会产生 24 段；不能顺序卡死 UI，也不能并发打爆限流。
- **纪要上下文**：数小时 transcript 可能远超 200k 字符；不能依赖单条 prompt。
- **说话人分离**：当前 ASR 契约只返回纯文本，没有 speaker/turn 数据；MVP 不应承诺精确发言人。
- **发布纪律**：这是新能力，实现需独立 worktree/PR，按仓库要求补回归测试、requirements、CHANGELOG；不得直接发版。

## 2. 外部调研

材料来源：三份只读调研报告，原文保存在 `/tmp/meeting-research-open-source.md`、`/tmp/meeting-research-products.md`、`/tmp/meeting-research-tech.md`。子代理遇到 GitHub 直连/部分官网反爬时已降级到 `gh api` 与可访问官方页，并在报告里说明降级范围。

### 2.1 开源会议录音/转写实现

| 项目 | 可借鉴点 | 与 pi-desktop 的映射 |
|---|---|---|
| [Vexa](https://github.com/Vexa-ai/vexa) | VAD 切短窗后走 OpenAI 兼容 STT；FLAC 默认、WAV 降级；typed fault + transient 按时间预算重试；共享并发闸；动态超时；final pass 清账 | 主要影响 `VoiceService` 调用参数与新增 `MeetingService` 转写队列：按错误类型重试、并发闸、段级幂等提交、缺失账本 |
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | 录音 chunk 队列、时间戳取采集位置、纪要 map-reduce（块摘要→combine→模板）、部分块失败仍可产出并报告 N/M | 主要影响 transcript 存储与 minutes runner；pi-desktop 用 JSON/manifest 实现同语义 |
| [Buzz](https://github.com/chidiwilliams/buzz) | 实时转录在批内回扫 RMS 最低点切分；队列有背压；segment 增量持久化；diarization 长音频 OOM 反例 | 影响采集侧：段边界尽量落静音；UI 显示转写积压；v1 不做说话人分离 |
| [speaches](https://github.com/speaches-ai/speaches) | OpenAI 兼容 STT 服务端不做长文件分块，分片责任在客户端 | 证实 pi-desktop 不能依赖“服务端帮我切” |

外部反例尤其重要：

- Vexa issue [#2015](https://github.com/Vexa-ai/vexa/issues/2015)：固定 3 次 / 1.5s 重试导致服务重启窗口内音频段永久丢失；修复方向是 transient 错误用 **120s 时间预算 + 指数退避**，非 transient 才有限重试。
- Meetily [#840](https://github.com/Zackriya-Solutions/meetily)：压缩分段拼接会累积编码 priming/padding，30 分钟漂 2.2s、60 分钟漂 4.5s；若保留可回放母带，应录无损 checkpoint、停止后一次性编码。
- Buzz [#1692](https://github.com/chidiwilliams/buzz/issues/1692)：110 分钟 diarization 内存峰值 11.4GB，patch 后仍在 alignment 阶段被杀。纯本地长音频说话人分离不适合 v1。
- Meetily [#356](https://github.com/Zackriya-Solutions/meetily)：本地 Parakeet 超过约 5 分钟稳定失败，说明分段不只是云服务 25MB 问题。

### 2.2 商业产品 / agent 产品的会议纪要模式

| 产品 | 与本设计相关的做法 |
|---|---|
| Google Meet “Take notes for me” | 官方推荐 15 分钟到最长 8 小时；纪要分 Quick notes 与 Full notes；明确 consent 与录制指示；迟到者可看 “Summary so far”。来源：[Meet help](https://support.google.com/meet/answer/14754931?hl=en) |
| Notion AI Meeting Notes | 桌面端捕获 mic + system audio；会中 skills / 停止后 summary；纪要 citation 可跳回 transcript；明确说话人标签在群聊/共享麦克风下不可靠；音频保留策略量化。来源：[Notion help](https://www.notion.com/help/ai-meeting-notes) |
| Otter | 单会时长按档位 90 分钟 / 4 小时，说明“数小时”仍应有显式上限。来源：[Otter pricing](https://otter.ai/pricing) |
| Fireflies no-bot | 用系统音频捕获、默认不保存音频文件；但文档承认 capture 中断可能不可恢复。pi-desktop 的分段落盘正是避免这个失败面。来源：[Fireflies help](https://guide.fireflies.ai/articles/6666374717) |
| Grain Desktop Capture | 本地系统音频捕获，支持“停止并丢弃=不存任何数据”；只存 transcript/notes 的隐私取舍很清晰。来源：[Grain help](https://support.grain.com/en/articles/12022918-desktop-capture) |
| tl;dv | 文件上传上限 3 小时；大文件上传窗口不能关、失败可能悬挂，进一步支持分段上传。来源：[tl;dv uploads](https://intercom.help/tldv/en/articles/7266251-uploads) |
| MeetingBaas | 转写状态与录制状态分离；录制上限逐步到 12h；大量 release 修重连、静音退出、provider 失败原因透传。来源：[MeetingBaas releases](https://docs.meetingbaas.com/api-v2/releases) |

产品层的共性结论：

1. **录制状态、转写状态、纪要状态必须分开**。MeetingBaas 的 `status` 与 `transcription_status` 分离是最小正确形态。
2. **“停止成功”不等于“有产出”**。Vexa issue [#807](https://github.com/Vexa-ai/vexa/issues/807) 统计到大量 completed 会议没有 transcript；pi-desktop 的段终态必须有 `done` / `empty` / `failed` 交付标记。
3. **隐私要可操作**：默认关闭、录制指示常驻、可复制同意话术、停止时可丢弃、音频保留期与一键删除。
4. **本地工具不承诺精确说话人**。Notion 明说群聊/共享麦克风不可靠；Vexa 生产也主要依赖平台通道元数据而不是通用 diarizer。

### 2.3 ASR / Electron 技术约束

- W3C MediaRecorder 规范指出：`timeslice` 产生的 individual Blob **不一定可独立播放**，完整录音所有 Blob 组合后才保证可播放。因此 pi-desktop 不能把 `ondataavailable` 的每个碎片直接当 ASR 文件；ASR 段必须是独立完成的 recorder 生命周期，或由 PCM/worker 重新封装。来源：[W3C MediaStream Recording](https://w3c.github.io/mediacapture-record/)。
- MDN 明确 `timeslice` 不是精确时钟：任务阻塞、锁屏、浏览器特性都可能延迟或产生巨块；不能拿 chunk 数量或 timeslice 间隔还原时间。来源：[MDN dataavailable](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event)。
- Electron 提供 `powerSaveBlocker('prevent-app-suspension')`，可保持系统活跃但允许熄屏；`powerMonitor` 有 suspend/resume 和 lock/unlock。它**不能保证用户手动睡眠/合盖不中断**。来源：[Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)、[powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)。
- OpenAI cookbook 的 25MB 是该接口的文件限制，不是所有 OpenAI-compatible 服务的统一契约，也不是固定时长；pi-desktop 应按实际编码后的字节数校验，并按 provider 能力声明支持字段。来源：[OpenAI cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/Speech_transcription_methods.ipynb)。
- Whisper 类模型存在静音幻觉与重复；跨段上下文可能把失败循环传染给后续文本。原始 transcript 和模型纪要必须分开保存，允许人工校正。来源：[Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md)。
- 长文档摘要的标准模式是分块结构化抽取后 reduce；不能照抄会“drop chunk”的示例。来源：[OpenAI long document summarization cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/Summarizing_long_documents.ipynb)。

### 2.4 外部做法 → pi-desktop 接入点

| 外部做法 | 是否采纳 | pi-desktop 落点 |
|---|---|---|
| 采集侧分段，而不是上传端硬切 | 采纳 | `MeetingRecorderController` 创建独立 recorder 生命周期；现有 `chunks` 只允许在一个 segment 内聚合 |
| 5 分钟 WAV 保守分段 | MVP 采纳 | 复用 `VOICE_MAX_RECORD_MS=5min` 作为默认段长；单段 WAV 约 9.6MiB，低于 24MiB |
| 静音/RMS 边界切分 | 二期采纳 | MVP 先用“到 5 分钟后等待短静音窗口（最多 20s）再切”；复杂 VAD/PCM worker 二期做 |
| FLAC 压缩上传 | 暂不采纳 | Electron/renderer 无内置可靠 FLAC 编码；MVP 用 5 分钟 16k WAV，二期再评估 worker 编码 |
| typed fault + 时间预算重试 | 采纳 | `MeetingService` 的 ASR queue：network/429/5xx 可重试，401/400/413 终态；幂等 segmentId |
| 共享并发闸 | 采纳但缩小 | 单 meeting 默认 2 个 in-flight ASR 请求，避免打爆用户配额 |
| 动态超时 | 采纳 | 修改 meeting 侧 ASR 超时，不沿用固定 120s；按音频秒数与字节量计算 |
| 段级 manifest / transcript JSONL | 采纳 | `userData/meetings/<id>/meeting.json` + `transcripts/*.json` |
| 时间戳用采集时钟 | 采纳 | renderer 传 capture epoch、段起止、wall clock；main 不用 ASR 时间伪造母带时间轴 |
| `powerSaveBlocker` + powerMonitor | 采纳 | recording 期间 main 持有 blocker；suspend/resume 写入 gap/event |
| 系统音频 + 麦克风双路 | 二期决策 | 产品价值高，但 macOS 需要屏幕录制权限且实现复杂；MVP 先复用现有麦克风链路 |
| 实时 pending/confirmed 两态 | 暂不采纳 | 目标是段级准实时/会后纪要；先不引入 live draft 重排复杂度 |
| speaker diarization | v1 不做 | 数据模型保留可选 speaker 字段，但 UI 明示“未区分说话人” |
| map-reduce 会议纪要 | 采纳 | `MeetingMinutesRunner` 分块抽取结构，再 reduce 成 Markdown |
| 纪要引用 transcript segment | 采纳 | minutes JSON/Markdown 带 `segmentIds`，UI 可跳转 |

## 3. 方案对比与推荐

### 方案 A：只调大输入框录音上限

- 改动面：最小，只改 `VOICE_MAX_RECORD_MS` 和提示文案。
- 风险：数小时整段 Blob 会造成 renderer 内存峰值；16k WAV 1 小时约 115MiB，直接撞 24MiB；ASR 单请求 120s 超时；失败就是整场丢失。
- 结论：不可行。

### 方案 B：renderer 分段录制 + main 持久化 + 分段转写 + map-reduce 纪要（推荐）

- 改动面：新增 meeting 数据模型、MeetingService、MeetingRecorderController、MeetingPanel、minutes runner；复用现有 VoiceService、workbench keep-alive、safeStorage ASR 配置。
- 风险：UI/状态机较大；需要真机验证睡眠、设备切换和长时间转写。
- 侵入度：不改现有主聊天发送链路；输入框 5 分钟语音输入保持不变。
- 结论：推荐 MVP。

### 方案 C：实时 WebSocket ASR + live transcript

- 改动面：最大，需要 provider adapter、interim/final 幂等、断线偏移、confirmed/pending 渲染、离线兜底。
- 风险：不同 ASR 服务协议差异大；离线会议不可用；第一版难以稳定。
- 结论：暂不推荐，等 MVP 的段级 transcript 和状态机稳定后再评估。

### 方案 D：主进程/系统音频捕获

- 改动面：需要 macOS 屏幕录制权限、Windows loopback、双路混音/分轨、权限失败降级。
- 价值：远程会议只开麦克风时，现有 getUserMedia 很可能只能录到自己；这是产品完整性的关键。
- 结论：不做 MVP 默认能力；作为快速跟进阶段，需要用户拍板平台优先级。

**推荐：方案 B。** 它保留现有 renderer 采集和 main ASR 密钥边界，把“一次录音=一次上传”改成“持久化会议资产 + 可重试段 + 可追踪纪要任务”，是能支持数小时会议的最小正确架构。更简单的方案 A无法处理失败恢复；更激进的方案 C会把第一版复杂度花在实时协议上，而不是用户关心的“会议结束后有一份可用纪要”。

## 4. 详细设计（推荐方案）

### 4.1 总体数据流（改动后）

```text
用户打开工作台「会议」tab，显式开始
  → renderer: MeetingRecorderController
      getUserMedia 一个 capture stream
      每个 segment 创建独立 MediaRecorder 生命周期
      目标 5 分钟；到点后等最多 20s 静音窗口再 stop
      stop 后整段转 16k mono WAV
  → IPC meetingAppendSegment(meetingId, clientSegmentId, bytes, meta)
  → main: MeetingService
      先原子写音频段 + manifest ACK
      ASR queue（并发 2）读取本地段转写
      transcript segment 状态机：queued/transcribing/done/empty/failed
  → renderer: meeting event 更新进度、积压分钟数、失败重试
用户停止会议
  → renderer 停止当前 segment
  → main final pass：补齐 queued/failed 段（有界）
  → manifest 标记 processing/ready；生成 coverage 账本
用户点击生成纪要
  → MeetingMinutesRunner
      按 transcript 分块 map 抽取结构化内容
      reduce 合并成 Markdown 纪要，带 segmentIds 锚点
  → 保存 minutes.md / minutes.json；面板可预览/重跑/导出
```

### 4.2 本地存储布局

```text
<userData>/meetings/
  index.json                       # 轻量列表，避免启动扫全目录
  <meetingId>/
    meeting.json                   # manifest + segment 状态机（原子写）
    audio/
      seg-000001.webm              # 原始段，可选保留
      seg-000001.wav               # 16k mono ASR 输入
    transcripts/
      seg-000001.json              # 原始/归一化转写结果
      transcript.jsonl             # 稳定顺序追加
    minutes/
      map-000001.json              # 每块结构化抽取
      minutes.json                 # 结构化纪要
      minutes.md                   # 用户可见纪要
```

`meeting.json` 只存元数据与状态，不内嵌大段 transcript；写入采用 temp + rename，崩溃后可按 manifest 恢复。

### 4.3 数据契约

新增 `src/shared/meeting.ts`：

```ts
export type MeetingStatus =
  | 'recording' | 'paused' | 'processing' | 'ready' | 'failed' | 'discarded';

export type SegmentStatus =
  | 'capturing' | 'captured' | 'queued' | 'transcribing'
  | 'done' | 'empty' | 'failed' | 'missing';

export type SegmentFailureKind =
  | 'none' | 'network' | 'rate_limited' | 'provider'
  | 'auth' | 'bad_request' | 'too_large' | 'timeout' | 'capture_gap';

export interface MeetingSegment {
  id: string;                    // 客户端生成，重试幂等
  index: number;
  captureEpoch: number;          // stream/device 重启后递增
  startOffsetMs: number;         // 有效音频时间轴
  endOffsetMs: number;
  wallStartedAt: string;         // ISO 时间
  wallEndedAt: string;
  audioPath?: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
  status: SegmentStatus;
  failureKind?: SegmentFailureKind;
  attempt?: number;
  text?: string;
  transcriptPath?: string;
  error?: string;                // 脱敏后的用户可读错误
}

export interface Meeting {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: MeetingStatus;
  captureEpochs: Array<{
    epoch: number;
    startedAt: string;
    endedAt?: string;
    reason: 'start' | 'pause' | 'resume' | 'device_change' | 'error' | 'app_resume';
  }>;
  segments: MeetingSegment[];
  coverage: {
    capturedMs: number;
    transcribedMs: number;
    emptyMs: number;
    missingMs: number;
  };
  minutes?: {
    status: 'idle' | 'running' | 'done' | 'failed';
    model?: string;
    mappedChunks?: number;
    completedChunks?: number;
    path?: string;
    error?: string;
    generatedAt?: string;
  };
  retention?: {
    keepAudioUntil?: string;
    discardedAt?: string;
  };
}
```

关键规则：

- `status` 只表达生命周期；`SegmentStatus.done` 必须有非空 `text`，`empty` 表示有效音频但 ASR 认为无语音。
- `captureEpoch` 在设备切换、权限失败重试、睡眠恢复后递增；跨 epoch 不伪造连续音频。
- `startOffsetMs/endOffsetMs` 来自采集时钟，`wallStartedAt/wallEndedAt` 来自 wall clock；两者分开，睡眠 gap 显式可见。
- ASR 重试用同一个 `id` 幂等提交；成功只替换该段结果，不重复 append。

### 4.4 renderer 录音控制器

新增 `src/renderer/pi/MeetingRecorderController.ts`：

- **stream 管理**：开始会议时获取一个 `MediaStream`；除非设备切换/错误，不在段间重建 stream。
- **segment 生命周期**：每个 segment 新建一个 `MediaRecorder`，到目标时长后 `stop()`，等待 `onstop` 后把该 recorder 的全部 chunk 合成完整 Blob。这与现有输入框“整段录制”的容器语义一致，但把“一次 recorder=整场”拆成“一次 recorder=一个可播放段”。
- **默认段长**：沿用 5 分钟。到点后监听 `AnalyserNode` RMS，最多等 20 秒找短静音再 stop；找不到静音也必须硬切，保证段长上限可预期。
- **内存上限**：只保留当前 segment 的 chunks；主进程 ACK 后丢弃。不把整场会议攒在 renderer。
- **WAV 转码**：复用现有 `toWav16k()` / `encodeWav16kMono()`。5 分钟 16k mono WAV 约 9.6MiB，低于 24MiB。
- **失败语义**：
  - MediaRecorder error / track ended / 设备拔出：结束当前 segment，标 `capture_gap`，暂停会议，等待用户恢复。
  - `getUserMedia` 权限失败：不创建半开会议。
  - 系统睡眠恢复：新 `captureEpoch`，先验证音频真的推进，不把 sleep 时间算进有效音频。
- **暂停/停止**：暂停=结束当前 segment 并不再开新 segment；恢复=同一 meeting 追加新 segment；停止=结束当前 segment 并进入 final pass。
- **上限**：默认单会议 8 小时、单段最长 5 分 20 秒（5 分钟目标 + 20 秒静音等待）。到达上限先优雅停止，不直接丢音频。

### 4.5 main：MeetingService 与 ASR 队列

新增 `src/main/pi/meeting-service.ts`，`src/main/index.ts` 只注册 handler：

```ts
meetingCreate(input): MeetingSummary
meetingList(): MeetingSummary[]
meetingGet(id): Meeting
meetingAppendSegment(id, clientSegmentId, bytes, meta): MeetingSegmentAck
meetingPause(id): Meeting
meetingResume(id): Meeting
meetingStop(id): Meeting
meetingRetrySegment(id, segmentId): Meeting
meetingDelete(id): void
meetingExport(id, targetDir?): { transcriptPath: string; minutesPath?: string }
meetingGenerateMinutes(id, input): Meeting
```

职责：

1. **段持久化**：先写 temp + rename，再更新 manifest。`meetingAppendSegment` 按 `clientSegmentId` 幂等；ACK 后 renderer 才丢内存。
2. **转写队列**：单 meeting 并发 2；复用 `VoiceService` 的 active ASR model 和 key 解密。ASR 成功写 `transcripts/<segmentId>.json`，再 append/update `transcript.jsonl`。
3. **错误分类**：
   - transient：network、timeout、429、500/502/503/504；
   - terminal：401/403、400、413、模型不支持音频；
   - transient 默认 120s 时间预算 + 指数退避；terminal 不自动重试，保留原始脱敏错误。
4. **动态超时**：meeting 侧不用现有固定 120s。建议 `min(240s, max(60s, 30s + audioSeconds * 2s + bytes / 16KiB/s))`，后续按实测 provider 调整。
5. **final pass**：停止后对 queued/transcribing/failed-but-transient 段做最多 2 分钟收尾；仍失败标 `missing`，coverage 显示缺失分钟。
6. **coverage 对账**：每次段终态更新 captured / transcribed / empty / missing 四个毫秒数；纪要生成前必须显示“缺失 N 分钟”。
7. **电源事件**：录音期间持有 `powerSaveBlocker('prevent-app-suspension')`；`powerMonitor` 的 suspend/resume、lock/unlock 写入 capture epoch/events，release 与 blocker 成对。
8. **隐私操作**：支持丢弃整个 meeting、删除音频保留 transcript、导出 Markdown；不回传 ASR key。

### 4.6 会议纪要 runner

新增 `src/main/pi/meeting-minutes.ts`，必要时抽 utility worker。

- **模型来源**：默认用当前聊天模型；UI 生成前允许更换一次。模型解析与鉴权沿用 pi `ModelRuntime`。项目内已有 worker 使用 `ModelRuntime.create()` 并调用模型能力的先例：`src/main/pi/account-worker.ts:15,52`。
- **输入**：只使用 `transcript.jsonl` 中 `done` 段；不把失败段伪装成“无内容”。
- **分块**：
  - 按段边界切，不切句子；
  - 初始目标 20,000–30,000 字符/块，具体值按模型上下文留 1/3 余量；
  - 相邻块带 1,000 字符 overlap；
  - 任何块超过目标必须继续拆，绝不 drop。
- **map**：每块输出结构化 JSON：
  ```json
  {
    "topics": [],
    "decisions": [{ "statement": "", "segmentIds": [] }],
    "actionItems": [{ "task": "", "owner": null, "due": null, "segmentIds": [] }],
    "openQuestions": [],
    "risks": [],
    "importantQuotes": [{ "quote": "", "segmentIds": [] }]
  }
  ```
  `owner/due` 无法从原文确认时必须是 `null`，不得编造。
- **reduce**：合并 map 结果，去重，保留矛盾与未决项；输出：
  ```markdown
  # 会议纪要：<title>
  ## 速览
  ## 决议
  ## Action Items
  ## 待澄清
  ## 风险与依赖
  ## 详细讨论
  ```
  每条结论带 `segmentIds`，渲染为可跳转锚点。
- **部分成功语义**：若 M 块中 N 块成功，仍可生成草稿，但 UI 明示“纪要基于 N/M 块，缺失 X 分钟”。
- **幂等**：同一 meeting 可重跑；新 minutes 覆盖旧文件，但保留上一次文件为 `minutes.previous.md` 可选回滚。

### 4.7 UI

#### 入口与触发

推荐入口是**工作台「会议」tab + 首页卡片**，而不是输入框麦克风：

1. **工作台首页卡片**
   - workbench 打开后的功能选择页新增「会议」卡片，与变更 / 文件 / 浏览器 / 辅助对话并列。
   - 点击卡片进入 `meeting` tab。
2. **workbench tab**
   - tab 名建议「会议」或「会议纪要」；打开后就是 `MeetingPanel`。
   - 如果当前有录音，切到 review / files / browser / aux 不停止录音；再点回「会议」继续看进度。
3. **Command Palette / 全局搜索**
   - 增加「开始会议录音」「打开会议面板」两个可搜索动作；不做 slash command，因为这是应用级 UI 状态，不应伪装成 pi prompt 命令。
4. **录音中常驻入口**
   - 顶栏 workbench 按钮或会议入口显示红点/计时徽标；点击直达会议 tab。
   - 关闭 workbench 面板不停止会议；停止必须在会议面板显式操作。

不推荐把入口放在输入框麦克风上：现有麦克风是“短语音转写进输入框”，用户预期是几句话；会议模式是持久录制、会落盘并上传 ASR，误触成本高。普通输入框语音按钮保持不变。

#### 面板形态

新增 `src/renderer/pi/MeetingPanel.tsx`，挂进 workbench：

- `WorkbenchTab` 扩展 `'meeting'`；`WorkbenchPanel` 的 tabs、home 卡片、contracts、preview adapter、i18n 同步扩展。
- 会议 slot 使用与 browser/aux 相同的 keep-alive 模式：切 tab / 收起 workbench 不销毁 recorder 状态。
- 面板状态：
  - 空态：新建会议、隐私提示、ASR 检查；
  - 录音中：计时、当前段、已完成/排队/失败段、转写积压分钟、暂停/停止；
  - 处理中：coverage 对账、失败段重试；
  - 就绪：transcript 预览、生成纪要、导出、删除音频、删除会议。
- 生成纪要时可选择模型；生成中可取消；失败保留可重跑。
- 顶栏/会话列表在录音中显示常驻录制指示，避免用户误以为后台没有在录。

### 4.8 契约与兼容策略

- `src/shared/pi.ts` 增加 meeting IPC 类型；preload 只暴露显式方法，不把文件系统路径随便交给 renderer 执行。
- 现有 `VoiceInputButton`、`voiceTranscribe`、`VOICE_MAX_RECORD_MS` 保持不变，避免影响普通语音输入。
- `VoiceService` 只做向后兼容扩展：内部提取可复用转写方法，或新增可选 `timeoutMs/attempt` 参数；默认行为不变。
- meeting 功能默认不在菜单突出入口；ASR 未配置时引导到既有设置页。
- 旧 meeting 数据不存在，不需要迁移；manifest schema 从 `version: 1` 开始。

### 4.9 分阶段实施

#### Slice 1：会议资产与分段转写（最小可验证切片）

- shared contract + `MeetingService` 存储层；
- `meetingAppendSegment` 先落盘，再调用现有 VoiceService 转写；
- 段状态机、幂等 ACK、coverage；
- 无 UI 或只有最小内部面板；
- 测试：单测覆盖 manifest 原子写、重复 ACK、ASR 成功/空/失败、重试与 coverage。

#### Slice 2：工作台会议面板与长录音状态机

- `MeetingRecorderController` + `MeetingPanel` + workbench tab；
- 分段 recorder、静音等待、暂停/恢复/停止；
- 主进程 powerSaveBlocker / powerMonitor 事件；
- 浏览器测试覆盖切 tab 保活、段状态、失败重试、暂停恢复。

#### Slice 3：纪要生成

- `MeetingMinutesRunner` + map/reduce prompt + minutes 文件；
- 面板预览、模型选择、重跑、citation 锚点；
- 测试覆盖分块、部分成功、citation 与不编造 owner/due。

#### Slice 4：长会稳健性

- 设备切换 / capture epoch；
- 系统睡眠恢复与 gap 展示；
- 音频保留策略、后台清理；
- macOS/Windows 真机长会验证。

#### 快速跟进候选

- mic + system audio 双路捕获；
- FLAC/opus 压缩；
- 真正 VAD 分段；
- 本地 ASR provider；
- speaker diarization（需要明确精度边界）。

### 4.10 测试策略

按仓库纪律，实现 PR 必须先红后绿：

| 层 | 测试 |
|---|---|
| main 单测 | meeting manifest 原子写、重复 segment ACK 幂等、ASR queue 并发/退避、错误分类、coverage、transcript 顺序 |
| ASR 单测 | 5 分钟段字节数校验、动态超时、401/413 不重试、429/网络重试、成功只提交一次 |
| renderer 浏览器测试 | MeetingPanel 开始/停止、segment 状态、切 tab keep-alive、失败重试、暂停恢复、未配置 ASR 引导；沿用 `tests/voice-input.browser.cjs` 的 fake IPC 模式 |
| minutes 单测 | 分块不丢段、overlap、部分成功、结构化 JSON 校验、reduce citation、owner/due 为 null |
| docs 测试 | `docs/voice-input.md` 与新 meeting docs 的上限/隐私文案同步 |
| 真机手工验收 | 30 分钟连续会议、熄屏、锁屏解锁、耳机切换、暂停恢复、ASR 服务临时 500、停止后重试、2 小时音频保留/删除 |

### 4.11 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 系统睡眠导致假录音 | powerMonitor + capture epoch + 音频推进健康检查；文档明示不能保证合盖连续录 | 段缺失显式展示，不伪造 transcript |
| ASR 服务限流/失败 | 并发 2、typed retry、时间预算、手动重试 | 失败段保留音频，可稍后补转写 |
| 长会议 transcript 过大 | 段级 JSONL + minutes map-reduce；不整段塞 prompt | transcript 与 minutes 独立文件，可只导出 transcript |
| UI 状态复杂 | 状态机集中在 MeetingService / RecorderController；workbench keep-alive | 面板入口可隐藏；已有输入框语音不受影响 |
| 隐私/合规风险 | 默认手动开启、常驻指示、同意话术、保留期、一键删除 | 丢弃=删除整个 meeting 目录 |
| speaker 信息误导 | v1 不做 diarization；minutes 不凭匿名标签推断负责人 | 结构化字段保留但 UI 不渲染不确定身份 |

## 5. 盲区与待拍板

1. **是否 MVP 只录麦克风？**
   现有实现只有 `getUserMedia` 单路麦克风。远程会议、耳机场景很可能需要系统音频才能真正录到其他参会人。双路捕获产品价值高，但 macOS 需要屏幕录制权限，工程量大。建议 MVP 先做麦克风，验证会议存储/转写/纪要链路；系统音频作为紧随其后的独立 slice。
2. **纪要默认模型**
   推荐默认当前聊天模型，允许生成前更换。若希望固定便宜模型/本地模型，需要用户拍板。
3. **音频保留策略**
   推荐默认保留 7 天，转写成功后可在设置中改成“生成纪要后删除音频”；默认值需要拍板。
4. **真实 provider 限制**
   OpenAI-compatible 服务没有统一时长/超时契约。MVP 用 5 分钟 WAV + 24MiB 校验是保守安全线；上线前要用实际配置的 ASR 服务做短段和失败注入验证。
5. **8 小时上限**
   设计上支持 8 小时，但这不等于未经真机验证的产品承诺。首版文档应写“设计上限 8 小时；长时间会议请保持电脑唤醒”。
