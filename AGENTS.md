# AGENTS.md

面向在本仓库工作的 AI 代理与人类贡献者的约定。

## 代码改动约定

- **写代码必须拉子代理做 code review**：实现类改动（非纯文案/配置/文档）提交 PR 前，
  先派 `code-reviewer` 子代理审查本轮 diff（任务里给全分支/diff 范围与验收标准），
  按其意见修改后再提 PR。
- 子代理 review 与 Copilot review 是串联的两道：子代理前置（本地快反馈），
  Copilot 后置（PR 上），两者都干净才合并。

## PR 流程约定

- **提交 PR 后必须跟进 Copilot code review 的结果**，三类意见都要查：
  1. 审查综述：`gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/reviews`
  2. 逐行审查评论（Copilot 的具体修改建议在这里）：`gh api repos/xiaoliu10/pi-desktop/pulls/<编号>/comments --paginate`
  3. 会话评论：`gh pr view <编号> --comments`
- 逐条处理：该改代码就改并 push，不同意则在对应评论里说明理由后请求重新审查。
- **审查结论为无待处理问题之前，不要合并 PR、也不要开始下一步工作。**
  「无待处理问题」指：Copilot 给出 approve / no changes，或所有意见已逐条回应并解决。
