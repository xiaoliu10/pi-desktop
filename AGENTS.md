# AGENTS.md

面向在本仓库工作的 AI 代理与人类贡献者的约定。

## PR 流程约定

- **提交 PR 后必须跟进 Copilot code review 的结果**：用 `gh pr view <编号> --comments` 或
  `gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/reviews` 查看审查意见，逐条处理
  （该改代码就改，不同意则在评论里说明理由后请求重新审查）。
- **审查结论为无待处理问题之前，不要合并 PR、也不要开始下一步工作。**
  「无待处理问题」指：Copilot 给出 approve / no changes，或所有 comment 已逐条回应并解决。
