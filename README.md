> 目录说明：本目录为 Mohua 服务端；iOS 客户端已独立至桌面的 `Mohua-iOS` 目录。

# Mohua

<img src="public/mohua.jpg" alt="Mohua" width="128" />

自托管邮件代理服务与原生 iOS 客户端。Node.js 24、PostgreSQL 18、SwiftUI（iOS 17+）。当前为开发版。

## 控制台语言与外观

访问服务器首页即可登录管理控制台；首次部署可展开“首次设置”创建管理员。页面右上角支持中文 / English 切换，以及浅色、深色和跟随系统三种外观。偏好仅保存在当前浏览器，登录页与控制台共用，手机端同样可用。

## Docker 启动

需要 Docker Compose v2。在项目目录运行：

```sh
node scripts/configure.mjs
# 如果没有本机 Node，可用：docker run --rm -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/configure.mjs
docker compose up -d --build --wait
```

打开 http://127.0.0.1:3210。用本机 `.env` 中的 `SETUP_TOKEN` 创建首位管理员（密码至少 12 字符）。配置脚本生成独立随机数据库密码和设置令牌，已有 `.env` 不会被覆盖。Compose 自动加载该文件。

此编排包括服务端、网页管理后台和 PostgreSQL；iOS App 仍用 Xcode 构建并连接服务端，不运行在 Linux 容器内。没有包含、修改或启动笑翠鸟网关。

`docker compose ps` 查看健康状态，`docker compose logs --tail=100 server` 查看日志。`docker compose down` 停止服务但保留数据，重新运行 `up` 自动恢复。不要用 `down -v`，除非确实需要删除数据库和主密钥。

默认仅开放本机 3210 端口，PostgreSQL 不映射宿主机端口。公网使用 HTTPS 反向代理。局域网调试可在 `.env` 设置 `MOHUA_BIND_ADDRESS=0.0.0.0` 后重建服务，生产仍需 HTTPS。数据库配置通过 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD` 注入。

## 开发与测试

本地 Node 开发需要 `DATABASE_URL`（PostgreSQL 连接串）或标准 `PG*` 环境变量，再运行 `npm ci --ignore-scripts` 和 `npm start`。SQLite 已移除。Windows 的 `start.ps1` 同样需要数据库环境变量。

使用独立临时 PostgreSQL 容器完成测试：

```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down
```

本机调试测试可先运行 `docker compose -f compose.test.yaml up -d --wait database`，设置 `TEST_DATABASE_URL=postgres://mohua_test:local-disposable-test-only@127.0.0.1:54329/mohua_test` 后运行 `npm test`。此密码仅属于临时测试容器。每个数据库测试使用独立 schema，测试结束自动删除，不访问正式应用数据。

## 客户端连接

1. 管理员登录网页，在“用户管理”生成注册邀请。
2. Xcode 打开 `../Mohua-iOS/Mohua.xcodeproj`，选择 Mohua 和 iPhone 模拟器运行。
3. App 填入 `http://localhost:3210`（Debug 模拟器），选择“使用邀请注册”，创建个人用户账号。
4. 用该用户账号登录 App，添加自己的邮箱；在“管理”中测试连接、更新密码、设置监听或删除邮箱配置。
5. 同一用户可登录多台设备。新增邮箱自动对其设备可见，设备名称自动识别，可单独撤销设备。

管理员与用户是独立身份，管理员不能登录客户端，也不能通过管理 API 查看、管理或读取用户邮箱。管理员如需使用邮箱，需另行邀请注册用户账号。邀请码只用于注册，不用于设备配对。

改名前的本地数据已按要求删除，此版本以全新 PostgreSQL 数据库启动；不提供旧 SQLite 数据自动迁移。正式容器不预置测试账号或邮箱。

## 身份与权限

- `administrators` / `admin_sessions`：只负责服务设置、健康自检、用户邀请与停用。管理会话有效期 24 小时，网页仅在内存保存令牌。
- `users` / `sessions` / `client_devices`：邀请注册的用户、其独立设备登录。设备会话有效期 30 天。
- `accounts.user_id`：每个邮箱归属一个用户，同一用户的设备共享邮箱配置；不能跨用户访问。
- 设备同步进度独立保存。退出登录会撤销当前设备；撤销某一设备不影响其他设备。停用用户会撤销该用户所有会话。
- 已删除个人邮件和设备 Web 测试页，以及配对码 API。邮箱管理在原生客户端完成。

数据库中密码使用 scrypt 哈希；会话令牌只存哈希；邮箱凭据使用 AES-256-GCM 加密。Docker 中主密钥位于 `mohua-keys` 卷的 `/app/keys/master.key`；本地 Node 默认位于 `data/master.key`。数据库与主密钥必须一起备份，密钥不匹配时服务拒绝启动。该主密钥用于服务端自身秘密；邮箱长期密钥由客户端持有，临时授权仅交给隔离邮件服务，仍不等于抵御整个服务被攻陷的端到端加密。

## 当前能力

- 管理后台：邮箱监听、发信异常、通知队列、业务接口诊断和资源趋势；Ethereal 仅保留手动诊断。支持邀请注册、停用／启用用户。
- 客户端：注册、登录、Keychain、邮箱配置与设备管理；邮箱总览、所有收件箱、文件夹、UID 分页、已加载邮件搜索／筛选、正文预览、阅读及底部整理工具栏。
- 服务端：代理收信及发信 API、流式正文和附件、幂等发送状态、回复／转发、监听、同步版本提示。
- 邮箱删除只删除 Mohua 配置，不删除服务商邮件。邮件“删除”操作移入垃圾箱，不执行永久删除。

只支持公网邮箱服务器、IMAP 993 隐式 TLS、SMTP 465 隐式 TLS 或 587 强制 STARTTLS。添加后不会自动连接，可手动测试连接和启用监听。用户名为邮箱地址，IMAP/SMTP 使用同一个邮箱密码或应用专用密码。

当前 iOS 仅支持 proxy 模式；支持纯文本写信、回复、转发、附件和本机草稿。已接入可选网关的静默推送与限时后台摘要同步，真实推送仍待配置签名和密钥后验收。尚无手机直连、OAuth、全邮箱离线下载、Face ID 或账号恢复。HTML 邮件支持安全排版与 CID 内嵌图片，远程图片默认阻止，可逐封允许 HTTPS 图片。真机验收仍需另行进行。

## 阅读速度与手机缓存

- IMAP 连接独占借用后复用，空闲 60 秒回收；全局最多保留 8 个空闲连接，每用户最多 2 个。密码更新、邮箱删除和用户停用会关闭对应连接。
- 纯文本正文接收约 4 KiB 后可以先显示首段，继续下载剩余内容；完整下载后支持长正文分段阅读。HTML 正文完成下载后清理并排版；超过 2 MiB 或结构过于复杂时明确回退为完整分段源码。失败或取消不会把残缺正文保存为缓存。
- 手机缓存完整正文，使用系统完整文件保护并排除备份；默认最多 50 MiB、200 封、7 天，单封不超过 5 MiB。服务器仍不保存正文。
- 缓存按服务器、设备、邮箱、文件夹、UIDVALIDITY 和 UID 隔离。命中时先显示本机副本，再校验最新状态；退出登录或确认设备失效后清除缓存。
- 邮箱与文件夹目录、邮件列表可跨启动恢复；每文件夹最多保存最新 1000 条已加载摘要，列表索引合计最多 50 MiB。正文另有独立缓存上限，未缓存正文仍需联网。
- 刷新和恢复前台时按 UID 增量拉取新摘要，并核对已保存邮件的已读、旗标和移除状态。同步失败保留旧列表，UIDVALIDITY 改变则清除该文件夹旧列表和正文并重建。
- 列表在前台最多预取 3 封不超过 128 KiB 的小邮件正文，不预取附件；打开阅读页或离开列表时取消预取。
- 搜索和未读／旗标筛选仅覆盖已加载邮件；已加载列表持久化，但不能保证所有邮件离线可读。远程撤销只能在客户端再次联系服务器时被发现。

## 主要 API

JSON 请求使用 `Content-Type: application/json`。登录后带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/setup` | 首次创建管理员：email,password,setupToken |
| POST | `/api/login` | 仅管理员登录 |
| POST | `/api/admin/invites` | 管理员创建 24 小时有效的单次注册邀请 |
| POST | `/api/register` | 用户注册：email,password,invite |
| POST | `/api/client/login` | 用户设备登录：email,password；客户端自动上报 deviceInfo（model、systemVersion），可带已有 deviceId |
| GET | `/api/me` | 当前身份 |
| POST | `/api/logout` | 退出当前会话；用户设备同时撤销 |
| GET/PATCH | `/api/admin/users[/:id]` | 列出用户／设置 active |
| GET | `/api/admin/health` | 服务汇总，不含个人邮件活动 |
| GET/POST | `/api/accounts` | 用户列出／添加邮箱 |
| PATCH/DELETE | `/api/accounts/:id` | 更新邮箱密码／删除配置 |
| GET | `/api/accounts/:id/access` | 只校验当前设备和邮箱访问权，不建立 IMAP 连接 |
| POST | `/api/accounts/:id/verify` | 验证 IMAP/SMTP 连接 |
| POST | `/api/accounts/:id/monitor` | 设置监听：enabled |
| GET | `/api/client-devices` | 用户设备列表 |
| DELETE | `/api/client-devices/:id` | 撤销设备 |
| GET | `/api/client/sync` | 邮箱版本提示 |
| POST | `/api/client/ack` | 确认设备同步进度：accountId,revision |
| GET | `/api/client/push/config` | 当前网关、配置版本与设备通知状态 |
| GET/PATCH | `/api/admin/push` | 管理员读取／修改网关选择 |
| POST | `/api/admin/push/test` | 检查已保存网关的协议与就绪状态 |
| POST | `/api/client/push` | 登记网关凭证／设置设备通知开关 |
| GET | `/api/accounts/:id/folders` | 文件夹 |
| GET | `/api/accounts/:id/messages` | UID 分页列表，返回 highWater |
| POST | `/api/accounts/:id/sync` | 文件夹增量与已知 UID 状态核对 |
| GET | `/api/accounts/:id/messages/:uid[/body或/attachments/:index]` | 元数据／正文流／附件流 |
| POST | `/api/accounts/:id/messages/:uid/actions` | 整理邮件 |
| POST | `/api/accounts/:id/outbox` | 准备发送，要求 Idempotency-Key |
| PUT/GET | `/api/outbox/:id` | 上传并发送／查询结果 |

增量请求为 `{folder,uidValidity,after,known}`：after 是上次成功保存的 highWater，known 是最多 500 个已加载 UID。返回 `{uidValidity,highWater,hasMore,items,existing}`；items 仅包含 after 之后的新摘要，existing 仅包含所查询 UID 中仍存在的邮件及 flags。每次最多跨 1000 个 UID，UID 空洞仍推进 highWater；hasMore 为 true 时继续请求。只可把 known 中缺少的 UID 视为移除，不可推断其他 UID。客户端将行数据与 highWater 原子保存，失败不推进。现有账号级 revision 仅作提示，不能以单文件夹或部分列表同步冒充整个账号已完成 ack。

邮件操作需要 folder、uidValidity；列表分页支持 before、limit。旧 UIDVALIDITY 返回 409，应清除分页状态重载。发送结果不确定时不可自动重发。正文和附件不在服务器落盘。

远程连接使用 HTTPS 反向代理，默认服务只监听 `127.0.0.1:3210`。环境配置：`DATABASE_URL`（或 `PG*`）、`HOST`、`PORT`、`DATA_DIR`、`MASTER_KEY_FILE`、`SETUP_TOKEN`。

开发边界和下一步见 [项目交接说明](PROJECT_HANDOFF_ZH.md)，模拟器测试及临时文件说明见 [iOS 说明](../Mohua-iOS/README.md)。

## HTML 邮件阅读

服务端优先选择 HTML 正文，并在附件元数据中提供可选 `contentId`。客户端通过系统 libxml2 解析并重新生成白名单标签与内联样式，再交给禁用网页 JavaScript 的 WKWebView；不保留脚本、表单、嵌入页面、外部样式和自动跳转。WebKit 使用非持久数据存储，另有 CSP 与内容拦截规则限制资源加载。

CID 图片只读取当前邮件对应的附件，串行下载，下载后再次核对邮箱访问权限。仅自动显示 PNG、JPEG、GIF、WebP；单张最多 5 MiB、每次阅读最多 12 张、解码后合计最多 15 MiB，尺寸限制为 4000 万像素并缩小到最长边 2048；动画显示首帧。图片仅留在当前阅读内存及受保护临时文件中，退出清理，不写入正文缓存。原图仍可从附件导出。

远程图片默认阻止；用户允许后由手机直接请求 HTTPS 图片，可能向发件人透露 IP 与阅读时间。授权仅限当前阅读，重新打开或从后台恢复后重新阻止，不携带 Mohua 设备令牌。链接先展示实际地址，经用户点击交给外部浏览器；邮件内不打开网站。

当前保留常见表格、文字及内联样式，不完整复刻所有网页 CSS，不自动加载 HTTP 图片、data URI 或 SVG。超过排版限制的 HTML 可以继续按源码分段查看，不截断原始正文。

## 客户端写信与草稿

首页和邮件列表底部可新建邮件；阅读页“更多操作”中可回复、回复全部或转发。支持选择 proxy 发件邮箱、收件人／抄送／密送、纯文本正文和文件附件。回复保留原线程、去重收件人并排除自己的邮箱；转发通过 original.eml 附件保留原邮件及其附件。引用正文最多 16000 字，长正文仅引用开头并标注。

“草稿与发送记录”保存在本机，支持重启恢复，使用完整文件保护并排除备份，按服务器和设备隔离；退出登录或确认会话失效后清除。最多 100 条记录、草稿附件合计 250 MiB，不同步到其他设备或 IMAP 草稿箱。附件从系统文件选择器复制到草稿目录，不依赖原文件持续存在；单封最多 20 个文件、合计 25 MiB，正文上限 256 KiB，编码后请求还需满足服务器限制。

已发送副本可选择由邮箱服务商保存，或由 Mohua 追加到唯一的已发送文件夹。服务商若自动保存，请不要再由 Mohua 保存。转发原邮件上限 25 MiB，最终 MIME 编码总量受服务端 40 MiB 上限约束。

发送前先持久化唯一发送键并冻结内容，再准备请求和上传附件。网络中断或重启后，通过原记录查询结果，查询不会上传或重发。发送中、结果不确定或部分发送时不提供重发按钮；只有明确发送前失败或准备过期才允许返回编辑。prepared 状态可由用户主动继续发送，仍先查询并使用相同记录。删除本机记录不会撤回邮件。

## 静默推送与后台同步

Server 管理后台可选停用、官方网关或自定义网关。官方网关地址由 `OFFICIAL_PUSH_GATEWAY_URL` 提供；未设置时页面明确提示未配置。Server 不接收 APNs 私钥或设备 token，只加密保存限定设备、Server 实例和同步用途的网关凭证。切换网关会清除旧凭证和队列。

客户端“管理 → 后台更新 → 允许本设备通知”可关闭本设备推送；偏好跨启动保存，手动同步仍可用。客户端只向构建时指定的可信网关登记，APNs 送达校验通过后才能取得凭证。自定义网关需配套客户端。

客户端收到提示后最多用 25 秒同步三个收件箱的摘要／状态，不后台下载正文。未开启新版加密通知时仅静默更新；启用后显示发件人和主题，仍不能保证即时送达。配置步骤见 [推送部署说明](APNS_SETUP_ZH.md)，接口见 [网关协议](GATEWAY_PROTOCOL.md)。

仅导出开源 Server：`npm run export:server`，产物在 `dist/mohua-server/`。导出采用明确文件清单，不包含私有网关、客户端、运行数据或密钥；整个工作目录不应直接作为公开仓库发布。

### Mohua 品牌与全新安装

App、Xcode 工程、服务端和项目目录统一为 Mohua。小鸟图标来自 `public/mohua.jpg`，控制台与 Kookaburra Relay 使用一致的浅色布局。

本次为全量改名和数据重置，不迁移旧账号、邮件缓存、设备会话和推送登记。启动后重新创建管理员、邀请用户、配置邮箱并登记推送。

- 项目目录：`Mohua`；服务端包：`mohua-server`。
- iOS Bundle ID：`com.mohua.app`；测试包：`com.mohua.app.uitests`。
- 数据库：PostgreSQL；Docker 数据卷：`mohua-postgres`、`mohua-keys`（Compose 自动添加 `mohua_` 前缀）。
- 推送应用 ID：`mohua`；同步载荷：`mohua`；登记挑战：`mohuaRegistration`。
- iOS 构建配置：`MOHUA_GATEWAY_URL`、`MOHUA_PUSH_ENVIRONMENT`。
- 本次没有修改 Kookaburra Relay 网关。新版推送要求网关支持应用 ID `mohua`、载荷 `mohua` 和挑战 `mohuaRegistration`，并配置 APNs topic `com.mohua.app`；当前旧网关未适配前无法完成新版登记和推送。Apple Developer 的 App ID 和签名描述文件也必须匹配，真机需重新登记。

运行 `npm run export:server` 生成 `dist/mohua-server`。仅此目录用于服务端分发。

## 数据持久化与备份

数据库卷与密钥卷在镜像更新、容器重建后保留。单个数据库 schema 只允许一个 Mohua 服务端持有运行锁，以保护邮件监听、发信恢复和推送队列；本版本不支持多副本横向扩容。

在项目目录执行以下命令，取得数据库及密钥的配套备份（备份文件包含私密数据，不要放入源码包）：

```sh
mkdir -p backups
chmod 700 backups
# 停止业务写入，数据库容器保持运行
docker compose stop server
docker compose exec -T database pg_dump -U mohua -d mohua -Fc > backups/database.dump
docker compose cp server:/app/keys/master.key backups/master.key
chmod 600 backups/database.dump backups/master.key
docker compose start server
```

恢复时停止 server，通过 `pg_restore` 恢复到目标 PostgreSQL 数据库，并将配套 `master.key` 复制到服务端密钥卷后再启动。仅恢复其中一项无法解密已有邮箱凭证。`.env` 中的数据库密码和设置令牌也需私下保存。

设备名称自动生成：管理后台根据请求的浏览器与操作系统命名；iOS 自动上报设备类型与系统版本。登录界面不再填写名称，不提供手动重命名。旧设备记录在下次登录时更新；旧客户端没有设备信息时显示“iOS 设备”。浏览器信息不足时使用通用名称，不读取电脑主机名。

## GitHub 镜像发布

已提供 GitHub Actions 自动测试、双架构 GHCR 镜像构建与部署包下载。源码部署使用 `compose.yaml`；拉取预构建镜像使用 `compose.image.yaml`。首次配置、镜像地址和更新命令见 [服务端部署说明](docs/SERVER_README.md#github-自动打包与镜像部署)。


### 推送网关资源限制兼容

网关返回 429 / 503 时，Server 保留 `Retry-After`（秒数或 HTTP 日期，最大 24 小时），取它与指数退避中的较长等待时间，并增加最多 5 秒抖动；等待时间持久化，重启不提前重试。设备凭证验证遇到 429、网关 5xx 或网络故障时向 iOS 返回临时错误及冷却时间，不把它们归类为无效凭证。仍沿用同步 `/v1/notify`，由 Server 持久队列负责投递重试，不同时提交异步任务。


### 客户端持有邮箱密钥

新版 iOS 支持按邮箱加密与可配置期限的内存授权、自动续期及恢复密钥。旧格式配置必须删除后重新添加，不保留兼容路径；Server 重启后等待客户端重新授权。详见 [协议及安全边界](docs/CLIENT_CREDENTIAL_LEASES.md)。运行中的 Server 仍可读取已授权密码，不提供抵御主机完全入侵的保证。


### 邮件工作服务隔离

生产必须运行固定路由入口、主 API 和独立 mail-worker。入口直接转发邮箱授权及邮件内容请求；工作服务不持有数据库密码或服务端主密钥。运行配置脚本补充内部令牌，然后更新全部 Compose 服务；客户端地址不变。详见 [架构、边界和升级说明](docs/MAIL_PROCESS_ISOLATION.md)。


## 加密新邮件提醒

支持可选的 `new_mail` 提醒：仅发件人和主题在业务 Server 中加密，网关与 Apple 只接收密文，iOS 通知扩展本地解密；正文不进入推送。旧客户端继续使用静默同步。部署顺序、专用密钥保护、通知用途授权和真机验收见 [加密通知说明](ENCRYPTED_NOTIFICATIONS.md)。


## 推送网关服务器审批

新版网关可以要求服务器先获批。把 `/api/client/push/config` 或管理推送配置中的 `serverId` 登记到网关「服务器接入」，选择允许的 `mohua` 应用并批准。将只显示一次的凭证放入业务 Server 的 `GATEWAY_SERVER_CREDENTIAL`，同时设置 `GATEWAY_SERVER_CREDENTIAL_URL` 为对应 HTTPS 网关根地址。留空 URL 时绑定 `OFFICIAL_PUSH_GATEWAY_URL`。这两个变量已接入 Compose；它们不能放进 iOS 或公开源码。

已登录客户端通过 `POST /api/client/push/ticket {}` 获取绑定自身设备的五分钟一次性票据。Server 的长期凭证不返回客户端；验证/投递请求额外携带服务器身份头，切换到其他网关不会转发原凭证。未配置凭证时票据为 null，兼容未强制审批的网关。先更新两端并完成登记验证，再在网关开启强制审批。轮换或封禁会撤销旧登记，需要客户端重新登记。
