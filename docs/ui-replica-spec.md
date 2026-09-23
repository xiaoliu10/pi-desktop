# PI Desktop UI 复刻规格

修订：2026-09-20。用户要求先参考 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) 的界面完成复刻，再在此基础上修改和接入本地 pi。**本文件是交给实现 Agent 的 UI 规格，尚未表示 UI 已完成。**

## 1. 交付顺序

```text
核对参考截图
  → 复刻布局、视觉和交互（使用明确标记的演示数据）
  → 本地可运行预览，逐页对照验收
  → 在复刻版本上调整个性化需求
  → 接入本机 pi RPC、会话与扩展
```

首阶段不调用真实模型，不自动安装扩展，不修改用户 ~/.pi。交互通过独立的演示数据适配层实现，不能把示例插件显示为本机已加载。

核心原则：优先还原参考项目，避免自行改造成营销首页、仪表盘或彩色卡片系统。此前已有的深蓝色原型不是本次视觉基准。

## 2. 参考来源与已观察事实

主参考：[官方截图目录](https://github.com/vastsa/PI-Desktop/blob/main/docs/guide/screenshots.md)。本轮已实际查看浅色首页、插件页和设置页截图，观察到的截图底部版本为 v0.14.6；仓库最新版本可能不同，不将截图版本等同于当前发行版本。

| 场景 | 官方截图 |
| --- | --- |
| 浅色首页 | [home-light.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/home-light.webp) |
| 深色首页 | [home-dark.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/home-dark.webp) |
| 对话与右侧导航条 | [minimap.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/minimap.webp) |
| 输入器模型菜单 | [model-menu.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/model-menu.webp) |
| 变更面板 | [panel-review.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/panel-review.webp) |
| 文件面板 | [panel-files.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/panel-files.webp) |
| 插件列表 | [plugins-live.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/plugins-live.webp) |
| 插件市场 | [plugins-market.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/plugins-market.webp) |
| 设置总览 | [settings-live.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/settings-live.webp) |
| 模型设置 | [settings-models.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/settings-models.webp) |
| 全局搜索 | [search.webp](https://raw.githubusercontent.com/vastsa/PI-Desktop/main/docs/public/screenshots/app/en/search.webp) |

以上链接只是参考索引；实现者必须实际查看自己负责页面的截图，再写对应界面。未查看的细节不能凭空宣称精准复刻。上游动态链接可能变化，U01 应记录参考提交或获取日期并建立一致的视觉基线。

## 3. 视觉基线

### 3.1 总体风格

浅色作为首个对照主题，再补深色。使用白色工作区、浅中性灰侧栏、深色文字、弱分隔、线性图标和圆角选中态。主操作为黑色按钮，状态才使用克制的绿、红等语义色。

遵循参考项目的系统无衬线字体与紧凑桌面排版；不为“设计感”换成装饰性展示字体，不增加渐变背景、大面积强调色、夸张动画或额外欢迎卡片。

### 3.2 尺寸和间距

已查看的基准图为 1600 × 1067。截图中侧栏约 366 px，顶部工具行约 60 px；首页输入器位于主区域底部，两侧留白约 100 px，底部留白约 20 px。以上为截图估算，实际实现时测量并统一为设计变量，不当作上游 CSS 的精确值。

建议同时验收 1600 × 1067、1440 × 900、1024 × 768：

- 桌面宽度下保持侧栏、主区、面板的视觉比例。
- 窄窗口优先折叠侧栏或工作面板，不挤压输入器至无法操作。
- 长标题单行省略，菜单不越界，输入区随文字增加到合理上限。
- macOS 标题栏保留原生窗口按钮和拖动区，不能用假交通灯冒充窗口控制。

### 3.3 通用状态

所有按钮需要 hover、focus-visible、disabled 状态；所有图标按钮带可访问名称；菜单支持 Escape 关闭和键盘导航。动画只用于状态切换，不改变参考布局。

颜色、圆角、间距和字体尺寸由 U01 集中定义；各页面使用自己的局部样式文件，避免多个 Agent 同时改全局 CSS。

## 4. 首页与导航

### 侧栏

参考首页侧栏从上至下包括折叠按钮、Sessions 分组、Projects 分组、底部设置/扩展/通知图标和版本信息。项目下可以展开会话或显示无会话说明。选中会话采用浅灰色圆角长条。

本项目新增的核心场景是 CLI session 直接可见：预览数据必须包含“来自 pi CLI”的既有会话，并能模拟外部新建会话和历史追加；查看模式显示“只读观察”和同步时间，单独提供“在 Desktop 继续”的入口，不把点击历史变成运行操作。无需用户先导入会话或手动添加其项目。

实现要求：会话切换、新建、项目展开折叠、侧栏收起、设置/插件页面导航可操作；当前选中项跨页面保持合理状态。会话重命名和归档可以在演示适配层中生效，不能调用真实删除接口。

### 主区与欢迎状态

顶部左侧是当前会话标题，右侧为新会话、搜索、工作面板等线性图标。主体保留大面积留白，居中展示简洁角色图形与一句欢迎语；输入器固定在主区域底部。

参考角色图形是单色描边形象。实现者如复用上游资产，须记录来源和遵守上游许可；若独立绘制替代形象，明确标为近似项，不宣称图形像素级一致。

英文对照模式用于与官方截图比较；中文模式复用同一布局，避免中文长文本导致拥挤。

## 5. 输入器、对话和工作面板

### 输入器

复刻大圆角容器、上部多行输入、下部工具行：附件入口、Agent 模式、权限模式、模型选择、其他辅助操作、圆形发送按钮。模型选择放在输入器而不是继续沿用原型顶部选择器。

UI 阶段模式和权限选项只更新演示状态，明显标记“界面预览”；不能暗示已接入 pi 权限控制。输入 Enter 发送、Shift+Enter 换行、中文输入法组合期间不发送。未接入的附件上传明确禁用或说明，不能假装上传成功。

模型菜单、`/` 命令菜单、`@` 文件引用菜单均有明确的演示数据和可见选择效果。每个菜单单独验收键盘与失焦关闭。

### 对话

采用参考项目的轻量文档流，支持用户消息、Markdown 回复、可展开工具调用、错误与状态信息。演示步骤要标为模拟运行，不用虚构的成功信息冒充真实测试结果。

右侧对话导航条按照消息位置展示标记；点击跳转相应消息，长会话可滚动。不只绘制没有功能的装饰条。

### 工作面板

由用户显式打开，展示 Review / Files / Browser 等标签。开关不改变当前会话内容。Review 显示可展开文件和行级差异，Files 选择文件显示内容；Browser 首阶段使用本地预览内容或空状态，不绕过 Electron 导航和网络边界。

在 1024 px 宽度下，工作面板和主对话仍能操作；必要时采用覆盖式面板。面板为空时复刻清晰的空状态。

## 6. 插件与资源页面

参考已安装页包括：页面标题、市场入口、更新提示、Installed / Marketplace 分段切换、搜索、按状态分组的插件行。

插件行包括图标、名称、包 ID、版本、错误摘要（若存在）、可展开详情、作用范围和更多菜单。状态分组包含需关注、可更新、活跃、已关闭。

UI 预览可以按截图设置演示行，但需要显示“示例数据”，并提供加载失败、空列表、搜索无结果等状态。安装/启用/更新仅影响演示数据，不执行系统命令。

后续接入本地 pi 时保留上述视觉结构，数据改为 pi 的 package / extension / skill / prompt 等资源，并遵守 [pi 架构文档](./coding-agent-workflow.md) 的兼容矩阵。

“市场”“已安装”“发现”“当前会话实际加载”是不同含义；原项目的 .piplug 市场不得直接当作本地 pi packages 市场接上。

## 7. 设置页面

参考设置是全页面布局：左侧返回应用、设置搜索、分组导航；右侧为标题、分节与浅灰色设置行，不是居中的弹窗。

首批复刻页：

- General：主题、语言、字体、字号、网络代理的布局和控件。
- Models：提供商列表、模型列表、编辑/新增表单。
- Extensions / Skills / MCP / Subagents：导航与对应列表或明确空状态。
- Info：版本与运行环境说明。

主题和语言切换在预览中真实生效；字体和字号可作用于预览容器。代理、认证和提供商表单只操作演示配置，不能写入真实 pi。未实现项保持禁用并解释，不用空的可点击控件制造功能已完成的假象。

## 8. 预览数据与边界

提供显式的独立预览入口，例如 `?preview=1`，由 U01 确定。生产入口不能在缺少 Electron bridge 时自动默默使用假数据。

建议新增独立 `src/renderer/preview/`，包含演示数据、状态适配层和预览入口：

- 至少覆盖首页、长对话、工具展开、Review、插件列表、模型设置、全局搜索。
- 数据中每个 ID 和来源稳定，方便截图和交互测试。
- 使用内存或单独前缀的 localStorage；提供重置演示按钮。
- 预览不得访问真实文件系统、认证、模型服务或插件安装命令。
- 后续 pi 接入时替换适配层，保留已验收的 UI 组件。

本阶段不要为了展示 UI 继续完善旧自研 AgentRuntime。

## 9. 验收与后续修改

每个任务至少提供对应截图、可重复操作步骤和类型检查结果。U07 集成验收：

1. 打开独立预览，不配置 Key 即可进入界面。
2. 按官方截图逐页比较布局、间距、控件位置、颜色、字体层级。
3. 通过侧栏进入首页、对话、插件、设置，再返回，状态保持正确。
4. 搜索、菜单、展开、主题切换和工作面板均可操作。
5. 三种窗口尺寸无重大溢出、遮挡和不可点击控件。
6. 预览没有请求真实模型和用户目录；没有将演示数据冒充本机状态。
7. 未复刻的 TUI 渲染、品牌图形差异和不支持功能列入差异清单。

UI 对照验收后冻结第一版，再增加用户个性化修改和 pi 运行时能力。核心架构以本地 pi 为准，参考项目主要用于复刻桌面交互和视觉结构。
