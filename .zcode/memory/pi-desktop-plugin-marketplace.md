---
name: pi-desktop-plugin-marketplace
description: pi 插件市场已接入——扩展页列出已装 npm 包（含未注册一键注册）+ 插件市场 tab 搜索 npm registry 的 pi-package 包并 pi install 安装
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

2026-09-21 用户报"pi cli 装了很多插件在这里展示不出来"+ 要求加市场功能直接安装 pi 插件。已全量实现。

**为什么之前看不到已装插件：** pi 只加载 `~/.pi/agent/settings.json` 的 `packages` 数组里登记的来源（用户那里只登记了 1 个 `npm:pi-memory`，但 npm 目录实装 7 个包）。原 `resource-catalog.ts` 也只读这个数组，所以一个都看不到。修复：resource-catalog 现在额外扫 `~/.pi/agent/npm/package.json` 的 **dependencies（顶层安装包）**，未注册的标"已下载未注册"+ 一键注册入口。

**关键陷阱——只扫顶层依赖：** 直接 `readdirSync(node_modules)` 会把传递依赖全列出来（用户机器实测 270 个，含 @aws-sdk/*、@anthropic-ai/sdk 等）。正确口径是读 `npm/package.json` 的 dependencies 键集，只列那些。`listInstalledPackages` 和 `resource-catalog` 都按此口径。

**pi 插件市场 = npm 生态：** pi 没有独立 registry，插件就是 npm 上带 `keywords:pi-package` 的包（registry 上有上万个）。市场搜索走 npm 官方 `https://registry.npmjs.org/-/v1/search?text=<query>+keywords:pi-package&size=36`（空查询=浏览生态关键字，有查询=全文本搜索）。安装走**官方 `pi install npm:<name>` CLI**——pi 自己处理下载、脚本 allowlist、写 settings.packages；Desktop 只编排，不直接 npm install。移除走 `pi remove`。注册已下载未登记的包 = 直接写 settings.packages（`pi-packages.ts` 的 registerPackage，原子写）。

**文件：** `src/main/pi/pi-packages.ts`（listInstalledPackages/searchMarket/installPackage/registerPackage/isValidSource——来源校验严防 shell 注入，只接受 `npm:`/`git:`/`https://`/`ssh:` 前缀）。host.ts 的 packageList/packageSearch/packageInstall/packageRegister（install 时守卫 executable 非空；完成后 emit resources-changed 触发重扫）。shared/pi.ts 加 PiInstalledPackage/PiMarketPackage 类型 + LocalPiApi 四方法。preload + main/index.ts handle 四个。

**UI（PiReplicaApp PluginsPage）：** 不再 hideMarketplace，两 tab：已安装（包行 + 资源行；未注册包行 badge「未注册」+「注册」primaryAction 按钮，PluginRowData 新增 primaryAction 字段；PluginRowItem 渲染时替换 scope 按钮位）、插件市场（npm registry 卡片，installedVersion/updateAvailable 标记，安装按钮调 installPackage）。搜索 350ms 防抖（adapter 模块级 marketSearchTimer），tab 首次打开且市场为空时自动加载。安装/注册后自动 loadPackages + scanResources 刷新。

**Why:** 用户要 Desktop 足不出户装 pi 插件；pi 自己的 install 是权威流程（脚本 allowlist、settings 同步），Desktop 复用它而非自造 npm 调用最安全。

**How to apply:** 列举已装包永远以 npm 根 package.json 的 dependencies 为准（不扫 node_modules 全目录）；"安装第三方能力"需求优先复用目标工具的官方安装命令做编排，不绕过；远程搜索类输入必须防抖。npm 搜索 API 不返回下载量（卡片 installs 恒 0，可后续换 npms.io 补）。相关：[[pi-desktop-task-board-workflow]]

**扩展页首次为空的相邻修复（2026-09-21）：** adapter init 之前从不加载 resources 列表，只在手动点刷新或 resources-changed 时才有；而 resources-changed 处理器原本也只弹通知不重扫。现改为 init 完成后自动 `scanResources()`+`loadPackages()`，resources-changed 事件也自动重扫（替代只弹通知）。教训：页面"第一次进来是空"先查 init 是否加载了该页所需数据，以及事件处理器是否真的刷新状态而非只通知。

**市场封面缩略图（2026-09-21）：** 市场卡片显示包封面（README 首张非徽章图；实测 36 个 pi-package 里约一半有真封面）。要点：①npm 搜索接口不带 README——按包解析：registry `/latest`（拿 repository/version）+ jsdelivr/unpkg 的 `README.md`（npm 发布包自带 README，实测 scoped 包也 200）；②**候选 URL 链按序降级**（jsdelivr → unpkg → raw.githubusercontent → gh-proxy.com），因为封面多托管在 GitHub raw、国内直连不稳，`<img>` onError 试下一个，全败回退首字母头像；③徽章过滤（shields.io/badgen/CI/star-history）；④包名过 npm 命名校验 + 拒绝 `..` 才拼 URL；⑤进程内缓存 24h（负结果也缓存）；⑥CSP `img-src` 需加 `https:`。链路：`pi-packages.ts` packageCovers → host → IPC `packageCovers`（≤64 个、每个 ≤214 字符）→ preload → adapter searchMarketplace 成功后异步补齐（不阻塞结果）→ MarketplaceCardData.covers → PluginsPage CoverImage。
