# ZCode 模型配置交互适配

参考源：zai-org/ZCode，`872ad960de7ec172591f7e1952f7849229f94521`。
直接阅读 `packages/ui/src/settings/model-provider-section/` 中的：

- ProviderModelMetadataDialog.tsx：独立新增/编辑弹窗、基础字段、固定页脚、保存锁定、IME Enter 保护。
- ModelEditorAdvanced.tsx：高级默认折叠，错误时展开并聚焦字段。
- ProviderModelMetadata.ts / ProviderModelDraftState.ts / useProviderModelDraft.ts：独立草稿、校验后提交、恢复配置、取消丢弃草稿。
- ProviderModelMetadataFields.tsx / ProviderModelModalityOptions.tsx：能力选项及多模态选择。

这是按源代码行为重新实现的 React/pi 适配，不依赖 ZCode 的 @zcode/provider、推荐解析服务或组件库。

## 已迁移交互

模型列表独立新增/编辑；提供商表单内使用紧凑模型列表，再打开同一个模型弹窗。提供商表单中的模型修改暂存到提供商草稿，外层保存才落盘。模型列表直接编辑保存时提交真实配置。新增聚焦模型 ID，编辑聚焦上下文；编辑时 ID 只读，避免影响默认模型和已有会话引用。

模型弹窗正文独立滚动，固定标题和操作栏。高级配置默认折叠，保留折叠内的输入状态。保存锁定重复操作，错误定位并保留草稿，取消/Esc/遮罩关闭恢复焦点，输入法确认不误提交。

## pi 字段映射

| 界面 | pi models.json |
| --- | --- |
| 上下文窗口 | contextWindow |
| 最大输出 | maxTokens |
| 文本/图片 | input |
| 推理能力 | reasoning |
| 等级映射 | thinkingLevelMap |

等级映射保留 pi 原生三态：缺省使用 provider 默认（xhigh/max 缺省不支持）、字符串映射为服务商值、null 禁用。主进程验证字段再原子写入。既有 API Key、模型 cost/compat/headers 等未编辑配置保留。

恢复 pi 默认仅清除本编辑器管理的覆盖；Token 留空使用 pi 0.86 默认 128000/16384，文本输入、不支持推理、缺省映射。不会清除价格、协议和其他高级字段。

ZCode 的智能推荐/个人覆盖解析依赖其内核；这里未虚构同名开关。ZCode 的视频、音频、原生网页搜索等声明无法直接映射为 pi 能力，因此不提供无效开关。

验证：草稿校验和回退测试、配置保存回读和原子拒绝测试、UI 预览验证独立弹窗/高级错误定位/保存关闭。未改动用户真实模型配置。
