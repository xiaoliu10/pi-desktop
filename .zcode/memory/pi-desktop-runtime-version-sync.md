---
name: pi-desktop-runtime-version-sync
description: desktop 与本地 pi CLI 的版本同步机制：'auto' 默认优先本地、兼容区间替代硬白名单、pi update self 一键同步
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

pi desktop 有两份 pi：内置（resources/pi-runtime 冻结副本）+ 本机 CLI（PATH/homebrew 发现）。版本同步采用「本地优先 + 兼容区间 + 一键升级」模型（用户 2026-09-22 选定，替代旧的硬白名单 ['0.85.1','0.86.0'] + 默认 bundled）。

**核心（src/main/pi/environment.ts）**：
- `PiRuntimeMode = 'auto' | 'bundled' | 'system' | 'custom'`，默认 `'auto'`（`prefs.runtime ?? (executable ? 'custom' : 'auto')`）。
- `'auto'`：本机 pi 在兼容区间内 → 用本机（runtime:'system', fallback:false）；否则回退内置（fallback:true + 诊断说明）。每次启动重读本机版本 → 用户 `pi update self` 升级后 desktop 自动跟随。
- 兼容区间 = `piVersionSupported(v)`：`compareVersion(v,'0.85.1')>=0 && <'0.90.0' && !win32`。发新版时 bump `PI_MAX_TESTED`。0.87/0.88 直接可用，不必等 desktop 发版。
- 内置副本去掉精确版本冻结（旧 `manifest.version==='0.86.0'` 校验已删），只校验 runtime.json 的 platform/arch stamp —— 新 desktop 发版自带新内置 pi 自动生效。
- `PiEnvironment` 多了 `systemVersion/systemExecutable/systemSupported/bundledVersion` 供渲染层对比。

**一键同步**：`host.upgradeLocalPi()` 用 `systemExecutable` 跑 `pi update self`（pi 自带升级命令），`refreshEnvironment()` 重新 discover。IPC `upgradeLocalPi`/`refreshEnvironment`；store action `s.upgradeLocalPi()`。设置页 ConnectionPane 在 systemVersion≠bundledVersion 时出横幅；仅当 `!systemSupported` 才显示升级按钮（本机已较新时纯信息提示，不误导）。

**实证**：本机 `/opt/homebrew/bin/pi` 0.87 → discoverPi({}) 解析为 runtime=system version=0.87.0 systemSupported=true fallback=false。

相关：[[pi-desktop-pi-behavior-verification]]（pi 行为先读 dist 核查）、[[pi-desktop-network-mirrors]]。
