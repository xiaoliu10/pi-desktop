# 内置 pi 运行时与本机 CLI

## 使用方式

Desktop 默认使用「自动」（auto）模式：优先使用兼容的本机 CLI，否则尝试内置运行时。当前内置依赖固定为 pi 0.86.0 + Node.js 22.22.0。程序运行时不下载安装内核，不修改系统 PATH，不安装全局 npm 包。用户仍需要配置模型与认证；Git、项目语言环境以及插件要求的额外服务不属于内核。

设置 → pi 内核与共享数据：
- 自动（默认）：优先使用兼容的本机 pi，找不到或不兼容时尝试内置。
- 内置 pi：固定版本，随 Desktop 发布。
- 本机 pi：查找 PATH 与常见安装路径，当前仅接受版本范围 `[0.85.1, 0.90.0)` 的 POSIX CLI；0.90.0 及以上不接受，Windows 外部 CLI RPC 尚未启用。兼容范围不代表其中每个版本均已实测。
- 自定义：指定 pi 可执行文件。已有明确路径的旧配置继续使用自定义模式。
- 外部路径失效或版本不支持时，在内置运行时可用的前提下回退，界面显示原因；内置也缺失时不会自动下载修复。启动后的扩展错误、模型失败不自动重放任务。

切换前必须断开所有 Desktop 会话，避免运行中切换内核或数据目录。私有 Node 使用绝对路径启动 pi 的 JS 入口，与全局 Node/CLI 独立。准备阶段检查固定依赖版本，打包前检查平台、架构与入口文件；运行时发现检查平台、架构及文件可用性，读取内置 pi 版本，但不再硬编码限制该版本。

## 数据共享与边界

沿用 PI_CODING_AGENT_DIR / ~/.pi/agent，可在设置指定：模型、认证、插件配置和 session 都从用户目录读取，安装包不包含这些数据。发现 pi 配置目录不存在不阻止内核启动。

**共享配置不等于共享运行时。** 模型目录（catalog）、账号登录（login）和套餐额度查询（quota）始终使用 Desktop 内置运行时，与对话选择 auto/system/custom 无关。即使本机 CLI 和共享配置可用，安装包缺少内置运行时仍会导致这三项操作失败。开发环境运行 `pnpm runtime:prepare`；安装版需重新安装包含内置运行时且匹配架构的安装包。

外部 CLI 会话保持只读；Desktop 继续执行时使用派生副本，原会话不被覆盖。同一 Desktop 已连接会话重复打开复用运行实例，不重复启动 writer。Electron 单实例锁防止同一 Desktop 数据目录重复启动。

**这不是跨任意 CLI 的文件锁。** 原生 CLI 不执行 Desktop 的互斥协议；用户如果手动用 CLI 指定正在运行的 Desktop 私有 session 文件，仍可能产生并发写入。不要这样操作，改为派生会话。插件自己的数据库/记忆文件是否支持并发取决于插件实现，未提供通用并发保证。内核选择也不等于所有第三方插件都已通过兼容测试。

## 构建

```
pnpm runtime:prepare
pnpm build
pnpm dist
```

资源来自固定依赖和 package-lock.json 的 npm ci；准备脚本执行私有 Node/pi 版本检查，写入 platform/arch 标记。`pnpm dist` 不显式指定配置文件，实际采用根 `package.json` 的 `build` 配置（不是 `electron-builder.yml`）。其中 `extraResources` 将 `resources/pi-runtime` 复制到应用资源目录下的 `pi-runtime`（macOS 为 `.app/Contents/Resources/pi-runtime`），排除 `node_modules/.cache`；`beforePack: scripts/check-runtime.cjs` 拒绝缺失、不完整或平台/架构错误的运行时。各操作系统/架构需要在对应构建环境准备，不把 macOS arm64 的 Node 装入 Windows/x64 安装包。

开发直接 pnpm build 不下载内核；首次运行先 runtime:prepare。资源依赖保留各自许可证文件；此私有运行时不修改根项目依赖中的 Electron ABI。

验证：本机 macOS arm64 的私有 Node + pi、无 PATH CLI 发现的 RPC 集成测试（本地 SSE 模型，不消耗外部模型额度）；环境发现、回退、会话复用和设置回归。Windows/Linux 仍需目标平台实机验证，不宣称跨平台已验证。

2026-09-25 修复实际 `package.json.build` 漏装运行时后，已执行 `pnpm dist` 并同步本地 macOS arm64 `.app`。使用隔离的临时空 agentDir 验证：从包内发现运行时、包内 CLI 返回版本 0.86.0、PiAccounts.catalog 使用包内 Node/SDK 返回 7 个提供商；Info.plist 包含麦克风用途说明。全量 443 项测试通过、3 项跳过。本次未进行真实 OAuth 登录或套餐网络查询，也未重新执行完整 GUI/RPC smoke；应用仍未做发布签名或公证。
