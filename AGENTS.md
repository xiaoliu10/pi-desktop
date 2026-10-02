# AGENTS.md

面向在本仓库工作的 AI 代理与人类贡献者的约定。

## PR 流程约定

- **提交 PR 后必须跟进 Copilot code review 的结果**，三类意见都要查：
  1. 审查综述：`gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/reviews`
  2. 逐行审查评论（Copilot 的具体修改建议在这里）：`gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/comments --paginate`
  3. 会话评论：`gh pr view <编号> --comments`
- 逐条处理：该改代码就改并 push，不同意则在对应评论里说明理由后请求重新审查。
- **审查结论为无待处理问题之前，不要合并 PR、也不要开始下一步工作。**
  「无待处理问题」指：Copilot 给出 approve / no changes，或所有意见已逐条回应并解决。
