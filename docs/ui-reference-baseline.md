# UI 复刻参考基线（U01）

修订：2026-09-20。负责人：ZCode（主会话）。

## 1. 参考来源与获取方式

- 上游仓库：vastsa/PI-Desktop（GitHub），官方截图目录 `docs/public/screenshots/app/en/`。
- 本机网络无法直连 `raw.githubusercontent.com` 稳定下载，实际通过以下镜像获取（2026-09-20）：
  - `cdn.jsdelivr.net/gh/vastsa/PI-Desktop@main/...`
  - `fastly.jsdelivr.net/gh/...`
  - `gh-proxy.com/https://raw.githubusercontent.com/...`（仅 home-light）
- 参考提交：镜像对应 `main` 分支 2026-09-20 缓存版本；截图内版本标注 **v0.14.6**。上游 main 分支代码可能已更新，本基线以截图为准，不假设与最新发行版一致。
- 本地缓存：截图副本存于 `/tmp/pidesktop-ref/*.webp`（临时目录，不入库）；如需复核可按上述镜像重新下载。

## 2. 已观察页面（11 张，1600 × 1067）

| 截图 | 实际内容 | 备注 |
| --- | --- | --- |
| home-light.webp | 浅色首页（欢迎态 + 输入器） | 主要视觉基准 |
| home-dark.webp | 深色首页 | 深色变量来源 |
| minimap.webp | 对话视图 + 左侧消息导航条 | 消息气泡/导航条形态 |
| model-menu.webp | 输入器模型菜单（上弹） | Model / Reasoning level 两行 |
| panel-review.webp | **实为设置页 General**（上游截图命名错位） | 设置页布局参考 |
| settings-live.webp | 与 panel-review.webp **字节一致**（已用 cmp 验证） | 同上 |
| panel-files.webp | Files 工作面板（空状态 + 顶栏形态） | 面板宽度、空状态参考 |
| plugins-live.webp | 已安装插件页（含需关注/可更新/活跃/关闭分组） | 侧栏区域为空白，视为截图异常，以 plugins-market 的侧栏形态为准 |
| plugins-market.webp | 插件市场（标签、来源选择、权限 chips、卡片） | |
| settings-models.webp | 模型配置页（默认模型/提供商/厂商账号/目录） | |
| search.webp | 全局搜索浮层（New task + Today 分组） | |

**缺失参考：** Review 面板的 diff 展示没有对应截图（panel-review.webp 实为设置页）。Review 面板按 ui-replica-spec §5 文字要求实现（可展开文件 + 行级差异），视觉沿用全局卡片语言，列入差异清单，不宣称像素级对照。

## 3. 从截图测得的布局事实（1600 × 1067 基准）

- 侧栏约 366px，浅灰底；主区白色；顶部工具行约 60px。
- 首页输入器两侧留白约 110px、底部约 20px，圆角约 16px，含上部输入区与下部工具行。
- 首页欢迎区：居中单色描边吉祥物（云形轮廓 + 双眼 + 双足，约 90px 高）+ 约 30px 常规体欢迎语。
- 对话：用户消息右对齐浅灰圆角气泡；助手回复为通栏文本流；行内代码为灰色圆角短棒（等宽）；回合间距大（约 70px）。
- 消息导航条：紧贴主区左缘的细竖条，由灰色短横线标记组成，当前消息加长加深，点击可跳转。
- 插件页：标题行 + 黑色主按钮；浅绿更新横幅；Installed/Marketplace 分段切换；NEEDS ATTENTION / UPDATES AVAILABLE / ACTIVE / TURNED OFF 状态分组；行卡片浅灰圆角，含等宽包 ID、权限 chips（橙色调为敏感权限）、范围 pill、更多菜单；市场为三列卡片网格 + 标签 chips + 来源选择行。
- 设置页：全页面布局（非弹窗），左栏 Back to app + 搜索 + 分组导航（Preferences/Agent/Workspace/System），右侧大标题 + 浅灰设置行卡片；控件为白色 pill 下拉、分段控件、黑色开关。
- 搜索浮层：居中白色圆角卡片，首行 New task，按 Today 等时间分组，行尾灰色来源标注。

精确色值与间距已在 `src/renderer/replica/tokens.css` 中固化为设计变量；数值为截图估算与取色，不是上游 CSS 的原始值。

## 4. 设计令牌与组件约定（U01 冻结）

- 所有复刻组件根类名为 `.pireplica`，样式作用域限定其内部；深色通过 `.pireplica--dark` 覆盖变量。不修改旧原型全局样式。
- 图标统一使用 `replica/Icons.tsx` 的线性 SVG（24 viewBox，stroke 1.7，currentColor），不混用 emoji。
- 页面 props / 事件契约见 `replica/contracts.ts`；演示数据与重置机制见 `preview/fixtures.ts`；状态适配层见 `preview/adapter.ts`（U07）。
- 吉祥物为独立重绘的近似 SVG（`Icons.tsx` 中 `MascotMark`），非上游资产，存在可见差异，已在差异清单标注。
- 预览入口：`?preview=1`（`src/renderer/main.tsx` 分支渲染 `preview/PreviewApp`），界面右上角固定显示"界面预览 · 演示数据"标记；预览不访问 `window.pi`、真实文件系统、认证、模型或插件命令。
- i18n 标签字典：`replica/i18n.ts`（U01 交付的新增共享资产，仅服务复刻组件）。

## 5. 已知差异与限制（持续维护）

- 吉祥物图形为近似重绘，非像素级一致。
- Review 面板无上游截图对照（见 §2 缺失参考）。
- 上游截图中未见的深层交互（会话右键菜单细节、更多菜单展开项、设置搜索结果形态）按常见桌面模式实现，属推断项。
- 截图中 sidebar 会话行首的圆形图标（运行中会话指示）以静态演示状态呈现。
