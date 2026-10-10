# AGENTS.md

面向在本仓库工作的 AI 代理与人类贡献者的约定。

## 代码改动约定

- **写代码必须拉子代理做 code review**：实现类改动（非纯文案/配置/文档）提交 PR 前，
  先派 `code-reviewer` 子代理审查本轮 diff（任务里给全分支/diff 范围与验收标准），
  按其意见修改后再提 PR。
- 子代理 review 与 Copilot review 是串联的两道：子代理前置（本地快反馈），
  Copilot 后置（PR 上），两者都干净才合并。

## 版本发布约定

- **PR/任务完成后默认不做 dist 同步**。用户经常连续排队多个对话/任务，每个 PR 都
  `--force` 覆盖一次运行中的 app，会一天产出多个版本、反复打断用户（需 ⌘Q 重启），
  并制造「运行中实例磁盘被换」的错配风险窗口（见 #38/#51 后续教训）。
- **等对话队列的所有问题处理完之后，统一发一个版本**：确认队列清空或用户明确说
  「发布 / 打包 / 同步版本」时，执行一次
  `pnpm build && npx electron-builder --dir && node scripts/sync-release.mjs --force`，
  同步前先 `ps` 确认实例代际。
- 例外：用户明确要求立即同步验证某个修复时照做。

## 发版检查清单（统一发版时逐项执行，缺一不可）

1. **版本号**：`package.json` bump（修改用 patch、功能用 minor）+ `git tag vX.Y.Z` 推送。
2. **CHANGELOG.md**：新增版本条目（`## [X.Y.Z] - 日期`），用**用户视角**描述（解决什么问题，
   不是 commit 标题堆砌）；未发版的改动先落在 `[Unreleased]`。
3. **README 表格**：`README.zh-CN.md`「📅 最近版本变化」与 `README.md`「📅 Recent releases」
   同步插入新版本行（HTML 表格格式），保持最近 10 个版本以内，并核对「完整记录见 CHANGELOG.md」链接。
4. **文档提交先行**：以上 1–3 作为独立 docs/chore 提交进 main 后再打包（保证 asar 外文档与包一致）。
5. **打包同步**：`ps` 确认运行实例代际 → `pnpm build && npx electron-builder --dir &&
   node scripts/sync-release.mjs --force`（electron-builder 输出在 `dist/mac-arm64`，
   `release/` 由 sync-release 写入——验证要看对目录）。
6. **asar 验证**：`LC_ALL=C grep -ac "<本版关键字符串>" release/mac-arm64/"PI Desktop.app"/Contents/Resources/app.asar`
   （grep 运行时字符串；压缩后变量名会被混淆，选 CSS 类名或中文 UI 文案）。
7. **提醒重启**：同步完成后告知用户 ⌘Q 重启生效。

## PR 流程约定

- **提交 PR 后必须跟进 Copilot code review 的结果**，三类意见都要查：
  1. 审查综述：`gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/reviews`
  2. 逐行审查评论（Copilot 的具体修改建议在这里）：`gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/comments --paginate`
  3. 会话评论：`gh pr view <编号> --comments`
- 逐条处理：该改代码就改并 push，不同意则在对应评论里说明理由后请求重新审查。
- **审查结论为无待处理问题之前，不要合并 PR、也不要开始下一步工作。**
  「无待处理问题」指：Copilot 给出 approve / no changes，或所有意见已逐条回应并解决。
