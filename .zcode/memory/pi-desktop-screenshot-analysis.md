---
name: pi-desktop-screenshot-analysis
description: 当前会话模型不支持图像输入，用户发的截图要用 wengine-visual MCP 工具间接读取
metadata:
  node_type: memory
  type: feedback
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi-desktop 会话中用户习惯发截图当需求（"参考 zcode 这个"），但所选模型不带图像输入——Read 图片会返回 "[Media omitted...]"，直接看不了。

**Why:** 不解决就只能瞎猜 UI，用户会反复补充截图。

**How to apply:** 用 `mcp__wengine-visual__extract_text`（OCR，快而稳）和 `mcp__wengine-visual__analyze_image`（布局描述，常 30s 超时，重试或先用 `sips -Z 900` 缩小再喂）；`zai-mcp-server` 已欠费（HTTP 429 "Insufficient balance"）。2026-09-22 实测两个工具同时不可用（wengine 连续超时、zai 429）——此时按用户的文字描述实现即可，不要卡在截图上；用户通常会附文字说明交互行为。分析时先要 OCR 拿文字清单，再用 analyze 问布局细节；大图（>300KB 或 >1500px）先 sips 缩放可显著降超时率。相关：[[pi-desktop-task-board-workflow]]
