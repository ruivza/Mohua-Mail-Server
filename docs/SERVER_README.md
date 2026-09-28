# Mohua Server

> 新增可选「同步模式」：与下文代理模式不同，它由邮件 worker 使用独立持久密钥加密保存后端授权、邮件原件、正文及附件；正文和索引在数据库，原件与附件在 `mohua-mail-files` 独立卷，控制服务仅保存密文。取消绑定立即清除密码包及持续授权，30 天内仅可恢复归档。App 登录过期/设备撤销不会终止已开启的独立同步授权。停止同步需使用邮箱设置中的对应操作，不删除已保存副本。详情与密钥备份要求见 [同步模式](../SYNC_MODE_ZH.md)。


<img src="public/mohua.jpg" alt="Mohua" width="128" />

自托管邮件代理，使用 Node.js 24 和 PostgreSQL 18。此发布包包含服务端、管理网页、Docker 编排和测试，不包含 iOS 源码、推送网关、运行数据或密钥。

## 控制台语言与外观

访问服务器首页即可登录管理控制台；首次部署可展开“首次设置”创建管理员。页面右上角支持中文 / English 切换，以及浅色、深色和跟随系统三种外观。偏好仅保存在当前浏览器，登录页与控制台共用，手机端同样可用。

## 启动

```sh
node scripts/configure.mjs
docker compose up -d --build --wait
```

没有本机 Node 时，第一步可用 `docker run --rm -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/configure.mjs`。

打开 http://127.0.0.1:3210，用 `.env` 中的 `SETUP_TOKEN` 创建管理员，随后生成邀请让客户端用户注册。配置脚本生成独立随机的数据库密码和设置令牌；不会覆盖已有 `.env`。管理员与客户端用户是不同身份。

数据库在内部 Docker 网络，不对外开放端口。默认网页仅绑定本机；局域网调试可设置 `.env` 的 `MOHUA_BIND_ADDRESS`，公网应使用 HTTPS 反向代理。

## 运维

- 查看：`docker compose ps`、`docker compose logs --tail=100 server`。
- 更新：`docker compose up -d --build --wait`。
- 停止：`docker compose down`；不带 `-v` 时保留数据。
- 持久化：`mohua-postgres` 数据库卷、`mohua-mail-files` 文件卷及 `mohua-keys` / `mohua-mail-keys` 密钥卷，实际名称带 `mohua_` 前缀。
- 备份：停止 server 的写入后，用 `pg_dump` 导出数据库，同时备份 `/app/keys/master.key`。恢复必须配套；密钥不匹配时服务拒绝启动。
- 同一数据库 schema 仅支持一个服务端进程。后台监听与队列通过运行锁避免多个实例重复处理。

## 测试

```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down
```

测试使用独立临时 PostgreSQL 和隔离 schema，不操作正式数据。也可配置 `TEST_DATABASE_URL` 后运行 `npm test`。本地 `npm start` 需要 `DATABASE_URL` 或标准 `PG*` 环境变量；不再支持 SQLite。

推送通过 `OFFICIAL_PUSH_GATEWAY_URL` 配置，留空时可正常收发邮件但无法推送。此包没有修改笑翠鸟网关；新版 Mohua 推送协议需要网关另行适配。不要在 Server 放置 Apple 私钥。详见 [推送配置](APNS_SETUP_ZH.md) 和 [网关协议](GATEWAY_PROTOCOL.md)。

### 自动设备名称

管理后台登录时由 Server 根据 User-Agent 识别浏览器与操作系统，例如 `Safari · macOS`，不再要求填写会话名称。iOS 登录自动提交 `deviceInfo.model` 和 `deviceInfo.systemVersion`，Server 校验后生成设备名称，例如 `iPhone · iOS 27.0`。这些信息仅用于展示，不参与认证。旧客户端未提供信息时使用 `iOS 设备`；已有记录下次登录更新。设备重命名接口已移除，仍可通过 `DELETE /api/client-devices/:id` 撤销自己的设备。

## GitHub 自动打包与镜像部署

`.github/workflows/docker.yml` 在推送 main/master、v* 标签、PR 或手动运行时执行测试。测试通过后构建 linux/amd64 和 linux/arm64 镜像；PR 只验证构建，不发布。默认分支发布 `latest`，`v1.2.3` 标签发布 `1.2.3`，另有 `sha-` 标签。镜像名自动取 GitHub 仓库的小写路径：`ghcr.io/<owner>/<repository>`。使用 GitHub 自带的 `GITHUB_TOKEN` 发布，仓库/组织需允许 Actions 写入 Packages。

在 GitHub Actions 的运行结果中可以下载 `mohua-server-package`，其中含源码、Compose、配置脚本和文档，不包含 `.env`、数据库或密钥。镜像位于 GHCR Packages，不是下载包中的离线镜像。工作流需要 GitHub 仓库；只推送到其他 Git 服务不会触发 GitHub Actions。

### 使用预构建镜像

下载部署包后，在解压目录初始化配置：

```sh
node scripts/configure.mjs
```

没有本机 Node 时可使用上文的 Docker 配置命令。在生成的 `.env` 中加入实际镜像地址（将 owner/repository 换成自己的 GitHub 仓库小写路径）：

```dotenv
MOHUA_IMAGE=ghcr.io/owner/repository:latest
```

然后启动应用和数据库：

```sh
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d --wait
```

私有镜像需要先运行 `docker login ghcr.io`，使用具备读取该包权限的凭证；公共镜像可以匿名拉取。后续更新重复上面两条命令。固定版本可将 `latest` 改成已发布版本号；仅更新应用可执行 `pull server` 后执行 `up -d --no-deps --wait server`。

镜像部署与源码部署使用相同项目名 `mohua`、数据库卷和密钥卷。原地切换时保留原 `.env`，两种部署方式择一使用，不要同时启动，不要执行 `down -v`。`compose.image.yaml` 不包含 build 配置，部署机无需编译应用。数据库仍使用 PostgreSQL 官方镜像，运行数据不进入应用镜像。

## 健康检查

`GET /healthz` 无需登录，执行一次 PostgreSQL `SELECT 1`。正常返回 HTTP 200 和 `{"status":"ok"}`；数据库查询失败返回 HTTP 503 和 `{"status":"unavailable"}`，不暴露错误详情，响应禁止缓存。Docker 使用此接口。旧 `/health` 已移除，返回 HTTP 404。

可从另一台机器定期请求 `https://你的域名/healthz`，用 HTTP 状态码和请求超时判断基础服务可用性。该接口不测试用户邮箱、SMTP、IMAP 或推送送达，也不会发邮件；外部监控建议设置 5 秒超时。

## 内部运行监控的职责

外部 Uptime 负责公网 `/healthz`、超时、可用率与告警；主机或 Docker 负责整机资源、磁盘与重启。Mohua 不再生成 API/数据库/后台心跳可用率色条，不再做定时数据库探测写入；只保留进程 CPU/RSS 的资源趋势。CPU 为单核等效百分比，可以超过 100%。旧采样列保留在库中但不再填充或返回，旧资源样本继续按七天清理。

运行状态页聚焦：
- 邮箱监听：仅活跃用户且启用监听的账号；分为已连接、连接中、重连中、未运行，连续断线超过五分钟单独统计。不会返回邮箱地址或个人邮件活动。
- 发信结果：最近24小时创建的任务，统计失败、结果未知、部分发送、发送中和副本保存失败/结果未知；分类可重叠。结果未知不会自动重发。
- 通知队列：有效会话设备的待处理、重试、已到期未处理及最长超期时间；正常限流/退避未到期不算超期。异常设备是当前配置错误、拒绝或重试耗尽的设备数，不是历史失败次数。只监控 Mohua 到网关这一段，不代表手机送达。
- 业务接口：当前进程最近60个分钟桶的请求量、5xx、中断响应及平均耗时（含传输时间）；排除管理接口、静态资源和健康检查。最多保留50条脱敏异常，只含操作分类、方法、时间和状态，重启清空。不存完整路径、邮箱、令牌或邮件内容。

Ethereal 移到折叠的“手动诊断”，保留人工排障能力。定时调度和 `/api/admin/health/settings` 已移除，旧 enabled/interval 配置不再生效，不会自动联系沙箱服务。`/api/admin/health` 仅供管理员查看汇总，`/api/admin/health/run` 仍可手动启动诊断。


### 客户端持有邮箱密钥

新版 iOS 支持按邮箱加密与可配置期限的内存授权、自动续期及恢复密钥。旧格式配置必须删除后重新添加，不保留兼容路径；Server 重启后等待客户端重新授权。详见 [协议及安全边界](CLIENT_CREDENTIAL_LEASES.md)。运行中的 Server 仍可读取已授权密码，不提供抵御主机完全入侵的保证。


### 邮件工作服务隔离

生产必须运行固定路由入口、主 API 和独立 mail-worker。入口直接转发邮箱授权及邮件内容请求；工作服务不持有数据库密码或服务端主密钥。运行配置脚本补充内部令牌，然后更新全部 Compose 服务；客户端地址不变。详见 [架构、边界和升级说明](MAIL_PROCESS_ISOLATION.md)。
