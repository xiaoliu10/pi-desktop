# pi 1.4.0 适配验证（2026-10-27）

目标：确认内置 pi 1.4.0 能承接 Desktop 既有 RPC 与扩展参数，并允许 macOS/Linux 的本机 1.4.x 进入自动选择。Windows 本机 npm shim 支持不在本次范围。Desktop 自身版本未变。

## 核对结果

对比隔离 worktree 安装的 1.3.0 与本机 1.4.0 包：`dist/modes/rpc/rpc-mode.js`、`rpc-types.d.ts`、`core/model-registry.js`、`core/extensions/runner.js`、`core/extensions/types.d.ts` 逐字节相同。`sdk.js` 改用 pi-ai client identity；`before_provider_headers` 对 attribution 头的可见性变化应按上游 CHANGELOG 理解，不是完整语义不变。Desktop 自带扩展没有使用该 hook，第三方扩展需自行核对。`model-runtime.js` 增加 OpenCode 会话头合并；bundle 入口引用的 chunk 哈希更新。上述是已检查文件的差异，不是全包变更清单。

上游 1.4.0 还修复摘要输出上限、codemode worker 排队、恢复会话新增扩展工具激活（#11062/#11075）等。未额外复现 desktop_handoff 的旧会话现场问题，因此不能把上游发布说明当作现场验证。

## 红绿与验证

证据目录：`/tmp/pi14-proof/`（本机临时日志，不能作为长期附件）。

- `pnpm exec vitest run tests/pi-environment.test.ts`：新断言保持不变，把上界暂时恢复为 1.4.0 时 exit 1，`1.4.0` 被拒绝（boundary-red.log）；恢复 1.5.0 后 exit 0，10 passed（boundary-green.log）。测试同时覆盖 1.5.0 被拒绝、auto 选择本机 1.4.0 而非回退。
- RPC 两项脚本均在执行前校验被测 CLI 版本，清除 `PI_PACKAGE_DIR` 和 `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`，实际报告 `bundled runtime: pi 1.4.0`。
- `tests/rpc-runtime-smoke.mjs`：exit 0，`RPC SMOKE OK (bundled runtime, offline)`。
- `tests/rpc-full-args-smoke.mjs`：exit 0，`FULL-ARGS RPC SMOKE OK (bundled pi 1.4.0)`。验证现有 Desktop 启动参数、本地 mock provider 回合、落盘、只读工具白名单、扩展 audit、思考等级和 entries 游标。该既有 harness 不是所有 Desktop 内置扩展的端到端测试。
- 本次留存日志时，`pnpm smoke:rpc` 的 `npx tsx` 分发步骤卡住；直接使用本机 npm 缓存中的 tsx 执行同一脚本，两项均通过（smoke-rpc-direct.log / smoke-rpc-full-direct.log）。未改脚本或断言。命令：`node /Users/jason/.npm/_npx/fd45a72a545557e9/node_modules/tsx/dist/cli.mjs tests/rpc-runtime-smoke.mjs`，第二项替换为 `tests/rpc-full-args-smoke.mjs`。正常环境可使用 `pnpm smoke:rpc` 与 `pnpm smoke:rpc-full`。
- `pnpm typecheck`：exit 0。
- `pnpm test`：exit 0，211 passed files / 5 skipped；1866 passed tests / 6 skipped。包括模型即时刷新、思考档、会话索引、子代理恢复与转录、辅助对话等已有回归；这些测试不等于逐项真实 UI 验收。

未执行打包、Windows 实机验证、真实 provider 调用或运行中应用替换；PR 保持 OPEN 等用户验证、统一发版。
