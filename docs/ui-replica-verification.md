# UI 复刻验收记录（第一阶段 U01–U07）

修订 2026-09-20（二次）：复刻 UI 已按用户批准接入 **Electron 生产入口**（P08 增补），见文末 §7。

验收日期：2026-09-20。负责人：ZCode（主会话）。状态：**待验收**（等待用户查看）。

## 1. 启动方式

```bash
pnpm install          # 首次
pnpm preview:ui       # 启动预览（Vite，端口 5174）
# 浏览器打开 http://127.0.0.1:5174/?preview=1
```

- 预览是纯 Web 页面：**不需要** Electron、模型 Key、`~/.pi` 或任何用户文件。
- 正常应用入口（无 `?preview=1`）不受影响；缺少 Electron bridge 时正常入口不会退回假数据。
- 界面右上角固定显示"界面预览 · 演示数据"标记；重置按钮可一键清空演示状态（内存 + `pireplica-preview:` localStorage 前缀）。

## 2. 复现步骤（与规格 §9 对照）

1. 打开预览 → 首页欢迎态（吉祥物 + 问候 + 底部输入器）。
2. 侧栏点击会话"重新设计设置页面插件板块手机端布局" → 长对话：用户气泡、Markdown、行内代码、工具行（read_file/grep/edit_file/run_command + 完成状态）、错误样式、左侧消息导航条（点击跳转）。
3. 点击会话"重构会话索引模块（来自 pi CLI）" → 显示"只读观察"横幅与"在 Desktop 继续"入口（点击只弹出演示通知，不启动任何代理）。
4. 顶栏"工作面板" → Review 标签显示可展开行级 diff；Files 支持选择文件查看摘录；Browser 为明确的空状态说明。
5. 输入器：`/` 弹出命令菜单、`@` 弹出文件菜单（键盘 ↑↓/Enter/Tab 选择、Escape 关闭）；"模型"弹出模型/推理强度菜单；Agent/权限菜单可切换并显示演示标记。
6. 输入文字回车发送 → 出现明确标注"模拟运行"的演示回复（不涉及真实模型）；运行中发送按钮变为停止。
7. 侧栏"扩展" → 已安装页（需要关注/可更新/活跃/已关闭分组、更新横幅、详情展开、开关/更新/演示安装）；"市场"标签（来源选择、标签 chips、权限 chips、更新/已安装/未发布卡片态）。
8. 侧栏"设置" → 全页面设置：General（主题/语言/字体/字号/代理，主题与语言即时生效并持久化到演示存储）、Models（默认模型、提供商行、添加/编辑/删除/开关演示表单，带校验错误）、其余分组空状态、Info。
9. 顶栏"搜索"或 Cmd/Ctrl+K → 全局搜索浮层（新任务 + 今天分组 + 消息/页面/设置/命令范围，Escape 关闭）；侧栏铃铛 → 通知列表（含待处理请求样式、全部已读）。
10. 窗口尺寸：1600×1067、1440×900、1024×768 均可操作；窄视口下工作面板为覆盖式，不挤压输入器。

## 3. 截图（docs/verification/）

| 文件 | 场景 | 对照参考 |
| --- | --- | --- |
| 01-home-light-1600.png | 浅色首页（1600×1067） | home-light.webp |
| 02-chat-light-1600.png | 长对话 + 消息导航条 | minimap.webp |
| 03-chat-review-panel-1600.png | Review 工作面板 + 展开 diff | （无上游图，按规格文字） |
| 04-model-menu-1600.png | 输入器模型菜单 | model-menu.webp |
| 05-search-overlay-1600.png | 全局搜索浮层 | search.webp |
| 06-plugins-installed-1600.png | 已安装插件页 | plugins-live.webp |
| 07-plugins-market-1600.png | 插件市场 | plugins-market.webp |
| 08-settings-general-1600.png | 设置 General | settings-live.webp（=panel-review.webp） |
| 09-settings-models-1600.png | 模型配置 | settings-models.webp |
| 10-home-dark-1600.png | 深色对话/首页 | home-dark.webp |
| 11-chat-dark-1024-panel.png | 1024×768 深色 + 覆盖式工作面板 | 窄视口验收 |

另见各参考图本地副本转换（/tmp/pidesktop-ref，临时目录）。

## 4. 检查结果

- `pnpm typecheck`（main + renderer）：通过。
- `pnpm test`：**69 通过 / 0 失败**（含本阶段新增 32 个预览逻辑测试：shell/chat/plugins/settings/workbench；其余为旧原型与并行任务的测试，未改动）。
- `pnpm build`：通过（PreviewApp 独立分包，不进入正常入口首屏）。
- `PI_SMOKE=2 electron .` 正常入口启动验证：通过（预览未影响真实应用）。
- 边界核查：`src/renderer/preview/**` 与 `src/renderer/replica/**` 不含 `window.pi`、`ipcRenderer`、`fetch` 调用；演示持久化仅使用 `pireplica-preview:` 前缀；未读取 `~/.pi`、未调用真实模型、未执行插件。

## 5. 已知差异与限制（如实声明）

1. **吉祥物为近似重绘**（replica/Icons.tsx 的 MascotMark），非上游品牌资产，轮廓细节有可见差异。
2. **Review 面板无上游截图对照**（上游 panel-review.webp 实为设置页），面板布局按规格文字与全局设计语言推导。
3. 上游截图中不可见的深层交互（更多菜单展开项、会话右键、设置搜索结果形态）按常见桌面模式实现，属推断。
4. 会话行内的运行指示为静态演示状态；时间显示与同步时间为演示数据。
5. 附件上传按钮为禁用态并带说明（规格要求不得假装成功）；Browser 面板为空状态说明，不加载外部页面。
6. 侧栏未复刻上游没有的元素；参考截图中 plugins-live 侧栏区域空白视为上游截图异常，按 plugins-market 的形态保留侧栏。
7. 字体使用系统栈，与上游具体字体可能有亚像素级差异；未宣称像素级一致。

## 6. 交付文件清单

- U01：`src/renderer/replica/tokens.css`、`Icons.tsx`、`i18n.ts`（新增共享标签资产）、`contracts.ts`；`src/renderer/preview/fixtures.ts`；`docs/ui-reference-baseline.md`；`src/renderer/main.tsx`（入口开关）；`vitest.config.ts`（纳入预览测试）；`package.json`（preview:ui 脚本）。
- U02：`src/renderer/replica/shell/`（Sidebar、TopBar、helpers、css）；`src/renderer/preview/shell.test.ts`。
- U03：`src/renderer/replica/chat/`（ChatView、Composer、MessageNav、ToolCard、DiffBlock、Markdown、helpers、css）；`src/renderer/preview/chat.test.ts`。
- U04：`src/renderer/replica/plugins/`；`src/renderer/preview/plugins.test.ts`。
- U05：`src/renderer/replica/settings/`；`src/renderer/preview/settings.test.ts`。
- U06：`src/renderer/replica/workbench/`、`src/renderer/replica/overlays/`；`src/renderer/preview/workbench.test.ts`。
- U07：`src/renderer/preview/adapter.ts`、`PreviewApp.tsx`、`preview.css`；`scripts/preview-ui.mjs`；本文件；README 预览入口说明。

未触碰：旧原型（`src/renderer/components|store.ts|App.tsx` 的既有逻辑）、`src/main/**`、`src/shared/**`、其他并行 Agent 的 `tests/pi-*` 文件。

## 7. P08 增补：复刻 UI 接入 Electron 生产入口（2026-09-20）

经用户批准，生产入口界面由并行会话的 `PiDesktop.tsx`（深色工作台）切换为**本阶段验收的复刻 UI**，底层对接其已就绪的 `window.localPi` 后端（P01–P07/P09 零改动，仅消费）。

**实现：**

- `src/renderer/pi/adapter.ts`：真数据适配层。会话索引 → 侧栏项目分组（CLI 会话带只读徽章）；`history.branch` + 流式 `message_update`/`tool_execution_*` 事件 → 对话消息与工具卡；`run.models` → 模型菜单；`resources` → 插件页（诚实状态映射：已发现 ≠ 已加载）；`review` unified diff → 变更面板；Extension UI select/confirm/input/editor → 复刻风格弹窗；接续副本/新建会话 → 复刻风格连接框（信任项目 .pi、工具权限选项）。
- `src/renderer/pi/PiReplicaApp.tsx`：生产视图。`App.tsx` 改为挂载它；`PiDesktop.tsx` 保留不挂载。演示预览 `?preview=1` 不受影响。
- 诚实边界：文件内容预览（桥接未提供）、代理配置、市场安装、资源启停均禁用或提示到 pi CLI 完成；CLI 会话只读观察 + "在 Desktop 继续"接续副本入口。

**验证：**

- `pnpm typecheck` / `pnpm build` 通过；`pnpm test` 80 通过（新增 `tests/pi-replica-adapter.test.ts` 10 例：历史→消息映射、流式映射、unified diff 解析、资源状态映射、模型分组、侧栏分组）。
- `PI_SMOKE=2` 生产入口启动：`data-pi-ready=true`，真实数据渲染（model-benchmark 项目、CLI 会话列表、只读观察横幅、`pi 0.85.1`）。截图 `docs/verification/12-electron-replica-home.png`。
- 截图 13（对话/接续流程）待与 pi 后端负责人联调后补充。

**已知限制（生产接入后新增）：**

1. 消息导航条、@ 文件菜单在生产入口禁用/空（前者待接消息锚点，后者因桥接无文件读取）。
2. CLI 只读会话的对话区在历史加载完成前短暂空白。
3. 深色主题为渲染层偏好切换，与 pi 无关。
