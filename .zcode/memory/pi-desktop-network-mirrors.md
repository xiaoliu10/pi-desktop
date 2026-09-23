---
name: pi-desktop-network-mirrors
description: 本机访问 GitHub 直连不稳/被墙，需要用镜像源；pnpm 11 默认拦截依赖构建脚本
metadata:
  node_type: memory
  type: project
  originSessionId: sess_33c48024-f281-4ff8-89a4-32c33a1b4e55
---

用户机器（macOS，中国网络环境）访问 GitHub 直连经常超时/TLS 失败（raw.githubusercontent.com 下载、WebFetch github.com、Electron 官方下载均失败）。可用替代（按可靠性排序）：`cdn.jsdelivr.net/gh/<org>/<repo>@main/...`、`fastly.jsdelivr.net`、`gcore/testingcf.jsdelivr.net`、`gh-proxy.com/https://raw.githubusercontent.com/...`（jsdelivr 对个别文件 404 时它成功过，如截图 home-light.webp）；Electron 二进制用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，或直接 curl npmmirror 的 zip 手动解压（npm registry 直连正常）。

另外 pnpm 11 默认不运行依赖的 postinstall 脚本，Electron 装完报 "failed to install correctly"——需在 `pnpm-workspace.yaml` 的 `allowBuilds: { electron: true, esbuild: true }` 放行（本仓库已配置）。

**npm registry 搜索的坑（2026-09-21 实测）：** 本机直连 `registry.npmjs.org/-/v1/search` 是通的（HTTP 200，~2s），pi 插件市场搜索必须用它——npmmirror 的 `/-/v1/search` 不支持 `keywords:` 过滤语法，同样查询返回 total:0，不能当替代源。npm 官方搜索有速率限制：短时间重复调用会 HTTP 429（排查"市场为空"时注意区分"没触发请求"和"429 被限流"）。

**Why:** 反复踩坑：截图下载、Electron 安装都因此失败过一次才找到可用路径。

**How to apply:** 在此项目需要下载 GitHub 资源或 Electron 二进制时，直接走上述镜像，不要先试直连；clone GitHub 仓库用 `HTTPS_PROXY=http://127.0.0.1:7897 git clone …`（本地 7897 代理，用户 2026-09-22 提供，实测可用）；**WebFetch 工具不走本地代理**，抓 github.com 页面照样超时，别用它替代 git clone；解压 Electron zip 后若缺 `path.txt`，手写 `Electron.app/Contents/MacOS/Electron` 进去即可。
