# Mohua Server

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
- 持久化：`mohua-postgres` 数据库卷与 `mohua-keys` 密钥卷，实际名称带 `mohua_` 前缀。
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
