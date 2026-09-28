# 邮件工作服务隔离

> 新增可选「同步模式」：与下文代理模式不同，它由邮件 worker 使用独立持久密钥加密保存后端授权、邮件原件、正文及附件；正文和索引在数据库，原件与附件在 `mohua-mail-files` 独立卷，控制服务仅保存密文。取消绑定立即清除密码包及持续授权，30 天内仅可恢复归档。App 登录过期/设备撤销不会终止已开启的独立同步授权。停止同步需使用邮箱设置中的对应操作，不删除已保存副本。详情与密钥备份要求见 [同步模式](../SYNC_MODE_ZH.md)。


生产部署使用四个容器：PostgreSQL、主 API、mail-worker、固定路由入口 edge。

客户端仍连接原来的 HTTPS 地址。外部 TLS 代理将流量交给 edge；edge 将 credential、folders、messages、sync、outbox 和 verify 路径直接转给 mail-worker。主 API 在读取这些路径的请求体之前返回 421，禁止回退。正文、附件、写信内容和临时授权密钥不进入主 API 的正常处理路径。edge 是受信任的数据通道，仍能看到明文；入口与外部代理必须关闭正文日志及请求/响应磁盘缓冲。本配置禁用 Nginx 请求/响应缓冲，限制请求体为 26 MiB。

## 权限与网络

主 API 以 uid 1000 运行，邮件服务以 uid/gid 65532 运行，入口为 101。各自独立 PID/挂载空间，丢弃 capabilities，禁止提权，只读根文件系统，core limit 为 0。mail-worker 没有主密钥卷、数据库环境变量或数据库网络；另有 worker 专用的 `mohua-mail-keys` 归档密钥卷及 /tmp tmpfs。主 API 挂载 `mohua-mail-files`，只能读写文件密文。主 API 不挂载 edge 配置，容器均不挂载 Docker socket。

MAIL_BROKER_TOKEN 为独立服务令牌，不是主密钥或数据库密码。`node scripts/configure.mjs` 在已有配置中只补充缺失令牌，不打印秘密。邮件服务通过内部网络调用 /internal/mail；edge 拒绝公开 /internal/。代理只接受命名白名单操作，不接受任意 SQL，不返回登录密码/管理员凭据/服务端主密钥。发信正文和附件只驻留 worker；主 API 保存摘要哈希与发送状态，不保存正文。

此工作服务处理所有邮箱，不是每邮箱一个容器。其被入侵仍可能影响当前授权邮箱。主机 root、Docker 管理员及被控制的入口仍不在保护范围内。主 API 仍是账号和授权判定的信任根，不能将此描述为抵御主动恶意 API 的端到端保密方案。

## 生命周期

服务端授权到期每秒检查，关闭对应监听、借用/空闲 IMAP 和 SMTP。只要最后一个内存授权被撤销/到期，生产工作进程会退出并由 Docker 重启；仍有其他邮箱授权时不重启整个服务，避免中断所有邮箱。JS 字符串和内核缓冲不保证物理安全擦除。

Worker 每秒与主 API 对账邮箱版本、设备撤销、监听配置和显式撤销计数。失联或注册失效即清除能力并退出。主 API 重启后重新建立 worker 注册；worker 重启后所有邮箱需客户端自动重授。正常无时间限制授权也不跨重启保存。

发送状态通过受限代理持久化。工作服务启动将 sending 标记 unknown、prepared 标记 expired；不会自动重放可能已接受的 SMTP 投递。注册互斥防止多个 worker 同时运行。突然崩溃后旧注册最长需等待 15 秒失效。

## 升级

运行 `node scripts/configure.mjs`，构建 server 镜像，再更新全部服务：`docker compose up -d --build --wait`。不要只更新 server 并绕过入口。宿主机 3210 由 edge 监听，主 API 和 worker 不直接映射端口。iOS URL 和协议无需修改。预构建部署使用 compose.image.yaml 并保留 ops/mail-edge.conf。

测试允许显式 createApp 不传 brokerToken 的进程内模拟路径，以复用合成邮箱测试。命令行生产入口强制要求 MAIL_BROKER_TOKEN，不提供生产单进程回退。

## 验证

集成测试检查：主 API 请求中不存在合成邮箱密码、临时密钥、正文、发信文本和附件；错误令牌及任意 SQL 被拒绝；并行 worker 被拒绝；撤销关闭连接；重启丢失授权并保留 unknown 发信状态；控制面失效清理授权。Docker 验收还须检查实际用户、挂载、网络及路由。
