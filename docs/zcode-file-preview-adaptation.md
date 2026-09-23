# ZCode 文件预览适配

参考仓库： https://github.com/zai-org/ZCode
参考版本：872ad960de7ec172591f7e1952f7849229f94521（Apache-2.0）。

已阅读：
- packages/ui/src/ToolCallBlocks/renderers/read.tsx：文件目标通过 onOpenCodeViewer({type:"file",title,path}) 进入侧栏，不依赖工具执行成功。
- packages/ui/src/ToolCallBlocks/renderers/edit.tsx：有补丁则打开 patch，否则打开 file；历史修改与当前文件语义分开。
- packages/ui/src/components/ui/code-viewer.tsx：代码高亮、行号与定位能力。

PI Desktop 采用上述交互设计，重新适配现有 Electron IPC 与 pi 工具消息，并未直接复制依赖 ZCode app-server、Shiki、国际化与评论系统的完整组件。

文件名点击不触发工具详情折叠；读取目标支持运行中点击。当前文件有 Git 净变化时优先展示差异，可切换文件正文；读取 offset 用于正文行号定位。编辑记录继续展示历史替换片段。文件正文支持行号与常用代码语法高亮，大文件降级为纯文本。未实现 ZCode 的代码评论系统。
