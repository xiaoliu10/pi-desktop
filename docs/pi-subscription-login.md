# pi 编程套餐与 Desktop 登录

模型设置展示内置 pi 0.86 ModelRuntime 提供的 OAuth 提供商及模型目录，结合共享 agentDir/auth.json 的非敏感凭证类型显示登录状态。模型来自 pi 的 getModels，不代表已向远端验证当前账号每一个模型的权益。无目录的动态提供商显示明确空态。

登录入口调用私有 Node 子进程中的 ModelRuntime.login(provider, 'oauth', interaction)。Desktop 支持 auth_url、device_code、info/progress、text/secret/select/manual_code 提问及逐问题取消信号。浏览器链接由用户点击打开，主进程仅接受当前登录实例返回的 HTTPS URL。一次只允许一个登录实例。

凭证由 pi 的原生 AuthStorage 写入共享 auth.json（使用 pi 自己的文件锁）；Desktop 不复制凭证、不向 renderer 返回 token，也不转发 SDK stderr。授权回填仅经过 IPC/stdin，不进入状态或日志。登录后尝试更新该提供商动态模型缓存（models-store.json），刷新失败不撤销已完成的登录。现有会话不会中断，新会话读取更新后的模型和认证。

关闭登录弹窗、退出应用或修改运行时配置会取消当前流程，必要时终止子进程。服务商自身设备码/授权链接有效期保持其原生规则。SDK 登录凭证持久化与模型快照同步发生错误时，目前显示通用失败提示；可先刷新目录检查是否已登录，再重试。

认证桥固定使用 Desktop 内置 0.86 SDK，普通会话仍遵循所选内核；读取的是同一个配置目录。不依赖全局 CLI，也不修改 CLI 安装。

验证覆盖：隔离目录中实际内置 SDK 套餐模型读取与凭证过滤；模拟登录提示、回填、提示失效、URL 协议检查、取消、迟到结果忽略；模型配置回归。未使用用户真实账号执行 OAuth 授权。
