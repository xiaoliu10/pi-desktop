# 本地 pi 协议基线

验证日期：2026-09-20。实现位置：`src/main/pi/`、`src/shared/pi.ts`。

## 安装与版本

本机 npm 安装为 `@earendil-works/pi-coding-agent` 0.85.1，可执行路径 `/opt/homebrew/bin/pi`。发现器也识别旧包名 `@mariozechner/pi-coding-agent`，但执行只启用 0.85.1。未知版本、独立二进制无法读取 package.json、Windows 安装均保留历史浏览并禁用执行。macOS 已实机验证；Linux 使用同一 POSIX 路径，但尚未实机验证。

发现顺序：用户明确设置 → PATH → 常见安装位置。发现过程只读安装元数据，不调用 `pi`、不加载用户扩展。配置根使用用户设置或 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`；会话根使用 `PI_CODING_AGENT_SESSION_DIR` 或 `<agentDir>/sessions`，再合并额外路径。

## 进程与调用

每个连接独立启动进程，最多 6 个；使用参数数组，不经过 shell：

```text
pi --mode rpc --session <desktop-copy.jsonl> --session-dir <agentDir>/sessions/desktop
   --approve|--no-approve -e <bundled-desktop-policy/index.mjs>
```

默认不批准项目资源，用户在连接对话框显式选择；全局资源仍是用户信任的本地代码。认证与模型由 pi 原生配置处理，Desktop 不读取认证内容到 renderer。所有 RPC 事件按文件 key 和进程 generation 路由；命令请求使用独立 UUID。

| RPC / 事件 | Desktop 语义 |
| --- | --- |
| get_state / get_available_models / get_commands | 启动状态、模型列表、实际可调用命令；模型仅保留 id/name/provider |
| prompt + streamingBehavior | 接受输入；运行中支持 steer / followUp |
| message_update / message_end | 流式助手消息；随后与落盘记录去重 |
| tool_execution_* | 展示工具名称与进度；保存的结构化输出由历史视图展示 |
| queue_update | 更新待执行输入数量 |
| agent_end | 单次循环结束，不能判定整项任务完成 |
| agent_settled | 无自动重试、压缩重试、排队接续后，才显示空闲 |
| clear_queue → abort | 停止前先取消 UI 等待，再清队列与 abort，恢复未执行输入 |
| set_model | 仅空闲时选择 pi 返回的可用模型 |
| extension_ui_request / response | 标准交互桥接，校验会话、进程代际、请求 ID |

连接检查 Desktop 权限扩展的启动状态回报；缺失或未加载即关闭进程。RPC 以 LF 分帧，支持 UTF-8 跨块与 Unicode 段分隔符，16 MiB 缓冲上限；超时不自动重放。stderr 原文不转发，以免扩展日志泄露认证内容。断开会终止 POSIX 进程组，延迟强制终止仍存活的进程。

刷新扩展采用空闲时重启相同 Desktop 会话，不假定存在 reload_extensions RPC；待回答交互和排队输入存在时禁止刷新。

## 会话所有权

CLI 会话通过原生 JSONL 直接只读解析，按 header.cwd 分组。只消费完整行；保留 entries，按 id/parentId 构建选定历史分支。历史浏览不调用会话迁移 API，不启动代理。

“在 Desktop 接续副本”复制完整条目，替换头部 ID，并以 parentSession 指向原文件。原始会话不写入；默认从文件最新分支继续，历史分支下拉仅影响浏览。桌面副本位于原生 pi 会话根下，CLI 可通过 `pi --session <副本路径>` 接续。使用 CLI 写入副本前先断开 Desktop；不宣称私有锁能阻止外部进程。

## 核实依据

本机 0.85.1 包内的 `docs/rpc.md`、`docs/session-format.md`、`docs/extensions.md`、`docs/packages.md`、`docs/security.md`，以及该版本真实进程的隔离联调。源码测试中的 fake-pi 只用于传输边界测试，不作为真实兼容性证据。
