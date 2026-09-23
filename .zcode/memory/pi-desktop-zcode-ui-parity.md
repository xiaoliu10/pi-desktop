---
name: pi-desktop-zcode-ui-parity
description: 用户的常驻设计指令——所有 desktop UI 优先对齐 ZCode 的界面，存疑时按 ZCode 的做法做
metadata:
  node_type: memory
  type: feedback
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

用户在 pi-desktop 会话里反复要求"完全按照 zcode 的UI来做"——这是常驻设计指令，不是单次请求。已落地的 ZCode 对齐项（2026-09）：输入框（白卡片+chips+思考胶囊+深色圆角发送）、快捷键设置页（kbd 表+录制）、侧边栏项目行（**去折叠箭头、双击展开/收起、会话前缀图标与项目文件夹图标对齐（嵌套行 padding-left 10px）、固定宽度图标槽防 spinner 出现时标题错位**、"显示全部"纯文字）、追问队列（卡片行+立即/编辑/删除）、上下文占用圆环（工具栏内模型胶囊左侧、纯圆环无文字）、执行过程摘要（思考流式时加粗「正在思考」；**底部 working 行只转圈不计时，计时只留在执行摘要一行**）、移动端远程控制面板布局、IM 机器人 /帮助 命令清单、ask_user_question 富问题卡片（header 胶囊+选项卡 label+描述+多选，对齐 ZCode 的 AskUserQuestion）、loading 菊花（8 瓣放射+彗尾渐隐，iOS/ZCode 风格，替换弧线圆环）、新建任务页胶囊快捷入口（周报总结等固定 agent，输入卡下方一排）。

**悬浮/高亮线条一律用灰，不用纯黑/纯白**：消息导航刻度悬浮用 `--pi-text-secondary`，侧栏拖动手柄提示线用 `--pi-text-tertiary`——用户明确说 accent（浅色主题下是纯黑 #1d1d1f）"太突兀，ZCode 是灰色的"。

**开关类按钮不用色块标识激活态，切换图标样式即可**：顶栏工作面板开关已去掉常驻黑底（用户圈出说"黑色可以去掉，只变化图标样式"），改为开=panel-right（箭头朝右）/关=panel（箭头朝左）图标切换 + 激活时图标加深；发送后停止按钮 = 浅灰底 + 中心实心深色小圆角方块（stop 图标 rect 需 fill="currentColor"，Icon 默认描边），发送态保持深底白箭头。**队列「立即」按钮**也用深底白字（`--pi-text` 底 + `--pi-bg` 字），不再是浅灰描边——用户报"色调太浅，参考 zcode"。**例外——多选/勾选项要真复选框**（2026-09-23 用户纠正）：模型编辑弹窗的输入类型/模型能力原来按「勾选项无边框纯 ✓ 文本」做，用户批"多选框没有展示出来"→ 已改 15px 方框（选中=深底白勾 `--pi-text` 底 + `--pi-text-on-accent` 勾，未选=1px `--pi-border-strong` 空框），`aria-checked` 驱动，固定项（文本）灰显勾选。settings.css `.pi-model-checkbox`。别把"勾选项做成纯文本"推广到表单复选框——那只适用于执行摘要里的对勾标记。

**思考块展开样式（ZCode 源码规格，2026-09-23 实测）**：ZCode reasoning 展开内容 = 无背景填充、无圆角盒子，仅 `ml-2 border-border border-l pl-3.5`（左边 1px 标准边线 + 14px 左内距）、`max-h-60`（**240px**）overflow-auto 滚动、文字 `text-foreground-subtlest`（最浅档），纯文本 pre-wrap。desktop 已照搬（chat.css `.pi-execution__note-body`：transparent bg + 1px var(--pi-border) 左线 + max-height 240px + `--pi-text-tertiary` 文字）——此前 420px+`#f2f2f3` 填充+3px 深左线的盒子被用户批"展开太大、对比度太深"。查 ZCode 样式规格的路径：`/tmp/zcode-asar/out/renderer/assets/styles-*.js` 里 grep `max-h-`/`reasoning`（tailwind 工具类内联在 JSX 里，不在 .css）；**完整 ZCode 源码在 `/tmp/zcode-src`**（packages/ui/src/ToolCallBlocks/ 是工具块的全部渲染器，比 asar 反查直观）。

**终端输出块规格（ZCode ExecuteOutput.tsx，2026-09-23 照抄）**：单层卡片（rounded-xl + border-border + bg-panel + px-4 py-3，ZCode 的外层 ToolCallBody）；命令行 `$` 提示符 `text-foreground-subtle` 弱化、命令本体 `max-h-15`（**60px**）pre-wrap；**输出区 `max-h-[5lh]` = 仅 5 行（leading-5 = 100px）** overflow-auto，`text-foreground-subtle` 浅灰、font-mono、whitespace-pre-wrap break-words。desktop 已对齐：`.pi-terminal` 扁平化（去掉自己的边框/圆角/内距——外层 `.pi-tool__detail` 是唯一卡片，此前双层嵌套框被批"土"）、命令 60px（滚动条隐藏）、输出 100px、`$` 用 `--pi-text-tertiary`。教训：**凡"框套框"先想外层是不是唯一卡片**；ZCode 的高度上限都很抠（5 行/240px），"有滚动条就不用张开很大"是常驻偏好。

**Why:** 用户把 ZCode 当作 UI 真相来源；偏离 ZCode 的细节（多余的折叠符号、计时重复、对齐错位）他都会逐个指出。按 ZCode 做能减少返工。

**How to apply:** 做任何 desktop UI 时先回忆/截图对照 ZCode 对应区域的布局与交互；遇到"要不要加个折叠符号/要不要显示计时/对齐到哪"这类选择，默认照 ZCode——能不加的装饰就不加（ZCode 偏极简、无多余箭头/计时）。用户发 ZCode 截图说"抄过来/复刻"时，先用截图读取工具确认目标样式再实现（图标、行内统计如 write +N、交互模式如编辑召回输入框）。截图先 [[pi-desktop-screenshot-analysis]] 间接读取确认目标样式再动手。相关：[[pi-desktop-task-board-workflow]]
