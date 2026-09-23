# Mohua 项目交接

> 当前部署（2026-09-23）：Mohua 邮件服务已改用 PostgreSQL 18 + Docker Compose。当前操作以 README.md 为准；下方为历史开发记录，不代表当前运行实例。本次没有修改笑翠鸟网关。

更新时间：2026-09-22。以本文件当前架构为准，旧配对码方案已移除。

## 当前推送架构（2026-09-22 本轮，覆盖后文历史直连方案）

- 用户最终确认：Server 开源；官方 Gateway 私有且独立运行；管理员选停用／官方／自定义网关；客户端用户可以关闭通知，不强制开启。
- 开源 Server 的 `src/gateway.js` 管理配置与 HTTPS 出站，`src/push.js` 只维护设备合并队列和网关调用。Apple 签名发送代码已迁到 `.private-gateway/`。Server 不再接收 APNs token，改为加密保存设备投递凭证。
- 管理后台新增推送设置与连接测试。官方网关 URL 来自 `OFFICIAL_PUSH_GATEWAY_URL`，未给定真实域名时保持空值并明确显示未配置。自定义网关需配套客户端。
- 私有 Gateway 提供管理页面，令牌登录，填写 Team ID / Key ID / Bundle ID、上传 `.p8`，AES-GCM 加密存储且不回显私钥；部署说明在私有目录 README。接口协议公开在 `GATEWAY_PROTOCOL.md`。
- 客户端构建配置 `MOHUA_GATEWAY_URL` 限定可信 HTTPS 网关；通过 APNs 挑战证明 token 接收能力后取得限定设备、Server 和 sync 用途的投递凭证及独立注销凭证。Keychain 保存两者，Server 只得到投递凭证。没有实现 App Attest。
- 客户端开关按 Server+设备保存，关闭立即拒绝后台提示，联网时同步 Server 并注销 Gateway；失败的注销凭证留在 Keychain 等下次前台重试。退出也注销。切换 Server 网关清除旧凭证和队列。
- 私有目录被 `.gitignore`、`.dockerignore` 排除；`npm run export:server` 按白名单导出 `dist/mohua-server/`，不包含客户端、私有网关、运行数据、密钥。当前整个工作区不是 Git 仓库，不要直接将整个目录公开。
- 当前仍只有静默摘要更新，无可见横幅或声音。真实 HTTPS 域名尚未提供、APNs 私钥未配置、真机送达未验收；不要把模拟器或模拟 APNs 测试说成生产推送完成。
- 正式数据、主密钥及真实邮箱未改动。旧 APNs token 仅在下次启动新版 Server 时迁移清除，用户／邮箱／设备身份保留。

## 多应用网关增量（本轮最新）

用户确认未来复用：本轮完成多应用管理与统一通道接口，APNs 已接入；Android FCM/厂商通道只预留，尚未实现，不能声称支持 Android 推送。

- 私有 `applications.js` 管理应用、加密配置和版本；`channels.js` 隔离 APNs payload 映射，列出各通道的 `implemented` / `kinds`。应用管理 API 改为 `/admin/apps`，移除单实例 `/admin/config`。
- 每个应用独立名称、启停、Bundle ID、APNs key 和允许环境。界面可创建、切换、修改应用；名称编辑不清理凭证，推送配置或启停变更只使该应用登记失效。相同 Team/topic/environment 不可重复归属两个应用。
- 协议增加 appId/platform/channel，凭证、token 所有权与路由按应用隔离；旧请求省略 appId 仅默认为 `mohua`。Server 固定发送此 ID；iOS 的 Info plist 同样配置 `MohuaGatewayAppID=mohua`，并拒绝其他 App 的提示和挑战。
- 旧私有网关加密配置迁为默认应用；没有 app scope 的旧网关登记一次性清除后重新登记。没有启动/迁移正式实例，没有修改其数据库或主密钥。
- 9 项 Node 定向测试通过（原受影响 6 项 + 新 3 项），包括跨应用隔离、同 token 两应用共存、不同 Bundle 路由、停用互不影响、重启、旧配置迁移及延迟挑战竞态。iOS 定向应用/设备隔离测试通过并完成 Debug 编译，结果 `/tmp/mohua-multiapp-core.xcresult`。未重复整套 UI 邮件回归。
- 浏览器使用临时无密钥实例验证登录、新建应用、停用、切换到另一仍启用的应用、展开 APNs 字段；没有上传真实私钥或联系 Apple。正式域名、签名真机验收仍待配置。

## 必须保持的产品约定

- server admin 只管理服务器，不是邮箱用户。管理员存于 administrators，管理会话存于 admin_sessions；不能用管理员账号登录 App、拥有邮箱或调用个人邮箱接口。
- 管理员发出邀请，使用人通过客户端邀请注册，再以用户账号登录客户端。一个用户拥有多邮箱、多设备，用户之间严格隔离。
- 设备通过账号密码登录获得独立会话，不再使用配对码或手动关联邮箱。用户的邮箱对其全部设备可见，设备同步确认进度仍独立。
- 邮箱和设备管理交给客户端。网页只做服务状态、自检、邀请、用户启停和服务器推送网关配置；旧 mail-test/device-test 页面已删除。
- 管理员不监控个人邮件活动。服务状态只展示用户、邮箱数量和服务自身健康。
- 正文与附件通过服务器流式转发，不在服务器保存内容。邮箱密码静态加密不等于端到端加密。
- 代码按职责拆分，保持命名清楚、缩进统一。身份模块为 src/auth.js，设备模块为 src/devices.js；不要恢复配对或管理员兼任用户的旧逻辑。

## 本地数据状态

用户授权的清空本地实例和轮换主密钥已完成。随后用户已重新配置实例；2026-09-22 本轮只读核对有 1 个管理员、1 个用户、1 个 proxy 邮箱和 2 个设备。保留现有实例，不再按空库处理，不要再次重置或替换密钥。自动测试使用临时目录，iOS fixture 端口 43210，正式服务默认 3210。

## 现有功能

服务端：邀请注册、管理员/用户分离、用户设备登录、租户隔离、加密凭据、IMAP/SMTP 连接验证、INBOX 监听及重连、UID 分页、MIME 正文/附件流、已读/旗标/移动/归档/垃圾箱、幂等 SMTP 发送、回复/转发、已发送副本、同步版本、可配置网关静默推送、持久重试与令牌生命周期管理。

网页：管理员初始化和登录、健康与资源趋势、独立 Ethereal 自检、邀请用户、停用/启用用户、管理会话撤销。

iOS：SwiftUI、最低 iOS 17；受限持久化离线列表、UID 增量同步与多设备状态核对；邀请注册与登录、Keychain、邮箱添加/删除/密码更新/验证/监听、设备列表/重命名/撤销、退出登录；文件夹/UID 分页/正文阅读/附件下载导出/邮件整理。

纯文本正文先接收约 4 KiB 就显示首段，随后以 32 KiB 缓冲写入受保护临时文件；下载完成后按约 64 KiB 的 UTF-8 完整分段显示。纯文本无旧的 2 MiB 截断；HTML 完整下载后安全排版，超过 2 MiB 时回退为完整分段源码。附件取消会中止下载。详情离开、后台、退出和启动会清理工作文件；完整正文另外存入有容量和期限限制的受保护缓存，退出或确认会话失效时清除。文件选择器导出的副本由用户管理。

## 工程与运行

- src/auth.js：管理员与用户认证、邀请注册。
- src/devices.js：用户设备登录、撤销、按用户判断邮箱权限、设备同步进度。
- src/server.js：HTTP 路由、服务初始化、即时权限复核。
- src/mail.js：公网上游地址校验、固定 DNS、TLS、连接与监听。
- src/imap-pool.js：按用户、邮箱和凭据隔离的独占连接复用，空闲回收及失效处理。
- src/reader.js / sender.js：邮件流读取/操作与幂等发送。
- src/health.js：进程采样和独立沙箱自检。
- public/：仅管理员页面及静态资源。
- ../Mohua-iOS/Mohua/：API、Keychain、Store、LoginView、ClientSettingsView、MailboxSettingsView、邮件阅读相关视图。
- test/*.test.js：Node 测试；test/ios-fixture.mjs：隔离模拟器服务。

macOS：npm ci --ignore-scripts；npm test；npm start。详细首次配置和 API 见 README.md，模拟器步骤见 ../Mohua-iOS/README.md。

## 关键实现边界

- admin 24 小时会话；用户设备 30 天会话；最多 20 台未撤销设备。无自动续期。
- deviceId 是逻辑设备标识，不是硬件证明。携带已有 deviceId 重新登录必须先通过用户密码验证；只轮换该设备令牌，不影响其他设备。
- users.role 目前保留兼容字段，但正式用户只能通过邀请创建 role=user；管理员使用独立表。
- device_mailboxes 表只存同步确认，不再是邮箱授权表。权限始终按 accounts.user_id 判断。
- user 停用会清除所有用户会话并停止监听，启用后恢复已配置监听，但必须重新登录。
- 邮箱模式当前为账号级 proxy/direct；iOS 只创建 proxy，已有 direct 显示尚未支持。不要声称 direct 已在手机实现。
- 主密钥和数据库配套保管，不提交到仓库。当前项目没有初始化 Git 仓库。
- 生产配置和真机验收尚未完成；当前不支持内网邮箱、OAuth、账号找回、管理员 MFA。

## 下一阶段

HTML 阅读、客户端写信、本机草稿与发送状态恢复已完成。真实邮箱已做一次只读抽查及 SMTP 认证验证。增量同步与持久化离线列表现已实现；APNs 静默推送与限时后台摘要同步代码已实现，下一步应确定官方 HTTPS 网关域名、部署私有 Gateway 并配置 Apple 签名／密钥，做真机送达和锁屏验收，再考虑手机直连。不要跳过相关权限边界，也不要将模拟器测试描述为真实多服务商验收；用户要求避免重复整套测试。

## 本轮验证记录

2026-09-22：Node 自动测试 30 项通过；iPhone 18 Pro / iOS 27 模拟器共 6 项测试通过（5 项回归及单独的邀请注册/设备重命名流程）。Debug、Release 模拟器编译通过。

覆盖管理员/用户隔离、邀请单次使用、多用户多设备、设备 ID 不可单独冒用、邮箱跨设备可见、独立同步确认、撤销与停用、登录持久化、原生邮箱添加/删除/退出、邀请注册/重命名、UID 分页和变更、超过 3 MiB 正文、UTF-8 分段、附件取消、已读/旗标/归档。未进行本轮真实邮箱或真机验收。

结果文件：`/tmp/mohua-accounts-tests-2.xcresult`、`/tmp/mohua-registration-tests-4.xcresult`，最终 Release 日志 `/tmp/mohua-accounts-release-final.log`。早期注册 UI 测试被模拟器系统强密码提示打断，已改为关闭该提示后输入测试密码并通过；App 保留系统密码填充支持。

本地实例最终核对：管理员、用户、邮箱、设备、两类会话、邀请、发送记录、自检及采样历史均为 0；已更换的主密钥保持不变。正式服务未启动，测试服务已停止。


## 阅读体验与页面结构（本轮新增）

参考 Apple 官方 iPhone Mail 的邮箱组织和阅读层级，保持 Mohua 品牌：邮箱总览包含“所有收件箱”、各邮箱收件箱和账户文件夹；列表展示发件人、日期、主题、已缓存正文预览及未读／旗标；阅读页为邮件头、正文、附件，底部提供垃圾箱、移动、归档及更多操作。没有添加尚不可用的写信或 AI 分类按钮。

新增 BodyCache.swift、MailListModel.swift、MailListView.swift。完整正文缓存使用 NSFileProtectionComplete，排除备份；50 MiB / 200 封 / 7 天上限，单封最多 5 MiB。缓存以服务器+设备+完整 IMAP 标识隔离，未完成下载不缓存，清除时使未完成写入票据失效。缓存命中先显示再取元数据核对，权限失败会清除对应内容，401 清除当前用户缓存。网络不可用时仅保留已有的内存列表和缓存正文，没有完整离线索引。

前台列表最多预取 3 封 ≤128 KiB 的正文，附件仍按需；离开列表取消预取。正文先显示约 4 KiB 首段，后台继续接收，取消或失败清除未完成预览。完成后的权限复核改为 /api/accounts/:id/access，只查权限，不再额外建 IMAP 连接。

IMAP 连接池不并发共享已选文件夹的连接；每次操作显式选择文件夹并核对 UIDVALIDITY。错误、取消、超时不复用连接，也不自动重试邮件修改。空闲 60 秒关闭，全局最多 8 个空闲连接，每用户最多 2 个；更新密码、删除邮箱和停用用户时主动失效。

设计参考：[Apple 邮箱组织](https://support.apple.com/en-ie/guide/iphone/iph376ef8aa3/ios)和[Apple 邮件阅读](https://support.apple.com/en-ph/guide/iphone/iph461684497/ios)。这是交互结构参考，不声称复刻 Apple 内部的预取或缓存算法。

### 页面与性能优化验收

2026-09-22：最新 Node 测试 34/34 通过；iOS 分批回归共 9 个不同测试通过（4 个核心测试、5 个 UI 测试），Debug / Release 模拟器构建通过。最终统一收件箱测试使用两个 proxy 邮箱，确认合并列表、首段在完整下载前显示，以及再次打开缓存邮件不重复下载正文。其他覆盖包括缓存隔离与清除、UTF-8 分段、连接复用与失效、邀请注册、邮箱管理、设备撤销及阅读操作。

结果文件：`/tmp/mohua-redesign-tests.xcresult`（其中两项旧 UI 等待条件失败，后续已修正）、`/tmp/mohua-redesign-tests-2.xcresult`（6/6 通过）、`/tmp/mohua-unified-inbox-tests.xcresult`（扩展双邮箱用例 1/1 通过）。Release 日志：`/tmp/mohua-redesign-release.log`。截图保存在 `docs/screenshots/`，均为隔离测试数据。未进行真实邮箱测速或真机验收；HTML 排版和客户端写信尚未实现。

## HTML 阅读（最新）

服务端正文选择改为优先 HTML，附件元数据增加可选 contentId。原有旧纯文本缓存如果与新元数据正文类型不一致，会失效并重新下载。HTMLDocument.swift 使用系统 libxml2 生成标签、属性和内联样式白名单；HTMLMessageView.swift 使用非持久 WKWebView、禁用 JavaScript、CSP 和内容拦截规则，脚本、表单、框架、外部样式、自动跳转不保留。所有 HTTP(S) 链接拦截后显示地址，确认才交给浏览器。

CID 图片只按当前邮件附件 ID 串行读取，权限复核后显示，支持常见光栅图；限 5 MiB/张、12 张/页、重编码后合计 15 MiB，原始像素最多 4000 万，缩略至 2048，动画取首帧。内嵌图片不持久缓存。远程图片默认禁止，手动允许当前邮件的 HTTPS 图片，返回或后台恢复后复位。它是手机直接请求，非 Apple 隐私代理。HTML 排版限 2 MiB/30000 节点/100 层，失败或超限回退完整分段源码；原始 HTML 仍受现有正文缓存保护。

### HTML 阅读验收（2026-09-22）

服务端 35/35 测试通过；iOS 完整回归 12/12（6 个核心、6 个 UI）通过，结果 `/tmp/mohua-html-tests-2.xcresult`。最后补强图片开关往返、HTML 正文缓存复用和图片错误检查，并验证最终修改，7/7 核心及 HTML UI 测试通过，结果 `/tmp/mohua-html-final.xcresult`。Debug / Release 编译通过，最终 Release 日志 `/tmp/mohua-html-release-final.log`。

首轮链接确认菜单的取消按钮测试失败，改为明确的原生警告框后通过；首轮结果收集进程卡住已停止，不作为通过结果。合成 PNG 样本 CRC 已修正，最终截图确认内嵌蓝色图片显示。截图：`docs/screenshots/html-message.png`。正式数据库及主密钥未修改；本次仅使用隔离服务与合成邮件，没有真实邮箱或真机验收。

## 客户端写信与有限验收（最新）

新增 Draft.swift、DraftStore.swift、ComposeModel.swift、ComposeView.swift。首页／列表写信入口，阅读页回复、回复全部、转发；发件邮箱、To/Cc/Bcc、纯文本正文、文件附件、本机草稿及发送记录。回复去重并排除自己的邮箱，保留线程；转发以 original.eml 保留原邮件和附件。引用正文上限 16000 字，截短有标注。

草稿和附件存 Application Support，服务器+设备分区、完整文件保护、排除备份，最多 100 条记录及 250 MiB 附件。退出／确认会话失效清除；删除记录有进程内删除标记，迟到请求不能重新保存已删除草稿。附件分块复制及拼接，不一次性读入大文件。草稿不跨设备或同步到 IMAP。

发送前先持久化唯一请求键并冻结内容，POST 准备后保存服务端 ID，再 PUT 上传。准备响应丢失用相同键恢复；上传响应丢失只查原记录。unknown/partial/sending 不重发，failed/expired 可返回编辑；prepared 的用户主动继续发送也先查询并用同一记录。已发送副本由用户选择 provider/append，副本失败不等于邮件未发送。服务端发信协议未修改。

按用户要求限制验收范围：已配置真实邮箱只查一次文件夹和最近 5 条列表，抽取一封 4818 字节 HTML 正文，读取前后标记一致；列表约 5.3 秒（含建连），正文及复核约 2.4 秒，仅为本次网络样本。SMTP 认证通过，真实发送数量为 0。未修改真实邮件、配置、数据库记录或主密钥。

验证：现有 sender 相关 6 项通过（`/tmp/mohua-compose-sender-tests.log`）；新增 3 个核心、2 个 UI 测试均通过，覆盖地址/回复去重、草稿分区与重启、退出和删除后的迟到写入拒绝、附件分块拼接、响应丢失后同记录恢复且仅发送一次、Bcc 不进入邮件头、回复线程、完整原邮件转发以及 unknown 状态不重试。没有重跑全部旧阅读测试。

核心首次通过记录在 `/tmp/mohua-compose-tests.log`；该轮 UI 因 iOS 27 对确认按钮暴露重复无障碍节点而失败，修正为 firstMatch 后两个 UI 用例通过（`/tmp/mohua-compose-ui-2.xcresult`）。最后只补验删除保护和发送状态位置（`/tmp/mohua-compose-final.xcresult`，2/2）。Debug / Release 编译通过；写信弹窗固定大尺寸的最后增量编译见 `/tmp/mohua-compose-release-final.log`。截图在 `docs/screenshots/compose.png` 与 `send-receipt.png`，为隔离模拟数据；写信截图采集于固定大尺寸之前。原生文件选择器未做完整 UI 自动操作，附件复制、容量限制、上传拼接与服务端解码分别有定向测试。未向真实收件人发送验收邮件。

## 2026-09-22 列表索引与增量同步

- `src/reader.js` 新增 syncOptions / sync；`src/server.js` 的 POST `/api/accounts/:id/sync` 沿用用户邮箱所有权和响应前再次授权，readonly IMAP，不新增服务端邮件内容存储。
- 请求 `{folder,uidValidity,after,known}`，known 最多 500 个 UID，单批最多跨 1000 个新 UID；返回新摘要及已查询 UID 的 flags／存在性。空洞推进 highWater，UIDVALIDITY 或 UIDNEXT 回退返回 409。GET messages 新增 highWater。
- `MailIndex.swift` 受保护、排除备份的服务器／设备作用域目录及文件夹快照；每文件夹最多 1000 个已加载摘要，快照合计 50 MiB。列表与游标原子提交，保存代次检查阻止删除或退出后的迟到写入。
- `MailListModel` 先恢复本机列表，按批核对旧 UID 和新摘要；失败不推进游标；UID 纪元变化清除旧列表／正文再重建。保留历史分页，最多推进 5000 个新 UID 范围后提供继续按钮。未缓存正文和附件仍需联网。
- 本机已确认的整理操作写回索引；多设备变化在刷新／恢复前台时核对，尚非实时推送。账号 revision 是提示，不能替代其他客户端变化检查，更不能以部分文件夹同步 ack 整个账号。
- 正式实例数据库和密钥未改，所有新 UI 验收使用 43210 隔离 fixture。

定向验收：服务端 reader 13 项、同步路由权限 1 项通过；新增 iOS 核心 2 项及离线重启／远端更新／UID 重建／撤销清理 UI 1 项通过。核心结果见 `/tmp/mohua-index-tests.log`，最终 UI 为 `/tmp/mohua-index-ui-final.xcresult`。初次 UI 仅因正文控件断言类型错误失败，修正后只重跑该场景，没有重复整套旧回归。

最终 Debug／Release 模拟器编译通过（Release 日志 `/tmp/mohua-index-release.log`）。页面留档：`docs/screenshots/offline-inbox.png` 和 `docs/screenshots/incremental-sync.png`（从 iOS 目录查看需加 `../`）。仅有既存 AppIntents 无依赖提示，无编译错误。

## 2026-09-22 静默 APNs 与后台同步

- 新增 `src/push.js`：P-256 ES256 provider JWT（缓存 50 分钟）、两种环境的 HTTP/2 连接、固定 background/priority 5、合并 ID。推送只含协议版本和逻辑设备 ID。
- `push_jobs` 持久队列按设备合并；成功间隔 20 分钟；网络／429／5xx／认证错误退避最多 8 次，24 小时任务期限；永久失败和耗尽后冷却。新变化不会被较早一次发送的结果误删。
- DeviceService 自动迁移登记时间、指纹、发送时间、错误和冷却字段；APNs token 仍加密。同 token 同环境只归属最近认证登记的设备，旧 token 的迟到 410 不清除新登记。发送前后复核有效会话、用户、设备和 proxy 邮箱。撤销同步清队列。
- iOS `PushNotifications.swift` 注册／处理静默提示、唯一 MailStore、25 秒后台期限、前台取消；`PushProtocol.swift` 提示作用域和只完成一次的任务管理。受保护数据不可用时跳过，不放宽 Keychain 或文件保护。
- 每轮最多三个收件箱，轮换位置保存在 MailIndex，跨冷启动继续；仅摘要及 flags，不后台预取正文、不做账号级 ack。管理页新增推送登记状态和复用工作逻辑的手动入口。没有新邮件横幅／声音，也没有真机送达保证。
- Debug 真机 development/sandbox；Release production/production；模拟器不登记真实 APNs。`.p8` 已加入忽略，`.env.example` 提供可选变量；`npm start` 不自动读取 `.env`，需 `node --env-file=.env src/server.js` 或由部署环境注入变量。详细配置见 `APNS_SETUP_ZH.md`。
- 验证：4 个服务端推送测试与 1 个受影响设备集成测试通过，4 个新 iOS 核心与 1 个 UI 测试通过。UI 验证相同工作逻辑，不是 Apple 推送唤醒；结果 `/tmp/mohua-push-tests.xcresult`、`/tmp/mohua-push-final.xcresult`。没有重复整套旧回归，正式实例和真实邮箱未操作。
- 尚需用户的 Apple Team ID、Key ID、匹配的 Bundle ID、服务器私钥文件路径及真机签名；不要索要私钥内容或把凭据提交项目。没有实际 APNs 送达验收，不能标为生产推送完成。

最终 Debug／Release 模拟器编译通过；Release 日志 `/tmp/mohua-push-release.log`。后台更新页截图保存在项目 `docs/screenshots/background-updates.png`。仅有既存的 AppIntents 无依赖提示，无编译错误。

## 本轮网关验收记录

- 8 项受影响 Node 测试通过：APNs 签名模拟、挑战登记／限定凭证／注销、管理配置加密不回显、管理员和设备路由、持久队列与三项生命周期边界。未联系真实 APNs 或邮箱。
- iOS 网关信任边界核心测试通过；设备通知 UI 测试通过，覆盖关闭后 Server 状态、App 重启保持关闭、重新开启。最终结果 `/tmp/mohua-gateway-toggle.xcresult`；截图 `docs/screenshots/device-notifications.png`。初次 UI 失败是旧 fixture 会话及 iOS 27 整行 Switch 点击位置，已修正测试助手；未重复整套邮件回归。
- Debug 模拟器与 Release 真机目标（未签名）均编译成功。Release 日志 `/tmp/mohua-gateway-release.log`；有既存 AppIntents 和 iPad 方向配置提示，未影响编译。
- Server 导出 37 个公开文件，检查无私有 Gateway、客户端或运行密钥；前端静态 DOM 引用和 JS 语法检查通过。网关管理 UI 尚未做实际浏览器人工验收。

### 网关登录提示修复

用户反馈 3220 登录失败。只读检查确认实际网关 PID 48053 正在监听，使用本机 admin.token 调用 `/admin/apps` 返回 200，未重启或更改运行凭据。发现浏览器 401 调用 lock 后 epoch 改变，外层错误提示被过期请求保护吞掉；现由 401 分支显示明确中文提示，输入同时 trim 首尾空白。页面说明网关令牌与邮件 Server 密码不同，避免复制终端末尾 `%`。已用错误测试令牌在浏览器验证提示显示，未修改正式应用配置。

## 2026-09-22 私有推送网关管理平台升级

用户同意借鉴 Gorush 的模块分工、队列、监控和日志设计，保留现有网关，不引入 Gorush 服务。当前 `.private-gateway` 已完成以下本地版本：

- 后台分为总览、应用、APNs、Android、推送记录、设备、运行监控、日志审计；响应式导航，创建 / 编辑 / 删除确认，应用 / 任务 / 日志详情，过滤与分页。管理 token 仍只保存在页面内存。
- applications 保留旧 APNs 接口，新增独立 channel-store（加密 APNs / FCM），应用删除不会重启复活；改名保留登记，配置 / 启停变化撤销该应用登记及待处理任务，其他应用不受影响。
- FCM HTTP v1 + 服务账号 OAuth RS256、令牌缓存、固定 Google 端点、normal priority data 消息。挑战和同步对象使用 JSON 字符串字段。未接入华为、小米、OPPO、vivo、荣耀，不提供 Android 客户端，不声称真机已送达。
- delivery.js：SQLite 任务记录、4 worker、最多 10000 未完成任务、24h 期限、异步 requestId 去重、429 / 5xx 最多 6 次退避；网络 / 重启中的在途结果标记 unknown，不自动重放。发送期间注销 / 改配置不会被迟到结果覆盖。
- `/v1/notify` 仍是同步接口，200 才表示厂商接受，失败由既有邮件 Server 重试；网关对这类任务不重试。新增 `/v1/jobs` 及查询 API 为可选异步协议，现有 iOS / 邮件 Server 无需升级。没有设备送达回执。
- observability.js：持久日志 / 审计、每分钟采样和运行历史，默认 30 天、日志约 10 万条；受监控 token 保护的 Prometheus `/metrics`，公共 `/healthz`。独立 uptime-probe.mjs 可在其他主机缓存断线样本并补报，没有样本显示未知。未替用户部署外部探针或告警服务。
- 拆出 admin-api.js / device-api.js；私有目录仍被公开 Server 导出白名单排除。README 和公开 GATEWAY_PROTOCOL 已补充兼容说明与运维方式。没有修改 src/ 邮件或 iOS 代码。

验证：19 项受影响测试全部通过（私有网关 15 + 原邮件 push 4），使用临时数据库、模拟 APNs / FCM；另在真实配置的隔离副本上核对应用行、加密凭据、revision 和有效登记迁移前后不变。浏览器验证登录、应用创建 / 重命名、APNs 配置不回显、Android 页面、测试推送入队和接受记录、任务详情、状态筛选空状态、监控页和日志；桌面 / 窄屏布局检查，无浏览器 error / warn。未进行真实厂商投递。

已备份现有网关数据库和密钥至 `.private-gateway/data/backups/before-console-20260922-172848/`（敏感目录，不能公开）。旧 PID 56161 正常退出，新服务 PID 59868 继续在 `127.0.0.1:3220` 运行，原 admin.token、应用名称、启停状态与 revision 已只读核对不变。新后台及管理 API / health / metrics 已验证。模拟验收服务 43221 已关闭。外部 uptime 探针没有部署，页面将明确显示尚未接入。

### 2026-09-22 Kookaburra Relay PostgreSQL 与管理员安全

- 私有网关主库已从 SQLite 切换到本机 Docker PostgreSQL 18.6（127.0.0.1:55432，relay schema），配置在 `.private-gateway/.env`，勿输出其中凭据。启动 `node .private-gateway/server.js` 会读取该文件。
- 迁移前备份：`.private-gateway/data/backups/before-postgresql-2026-09-22T09-03-03-998Z/`。10 张原表全字段校验通过，保留 2 个应用与历史记录。旧 SQLite 不再更新。
- 数据库访问改为异步连接池、事务，配置变更与任务入队有并发锁；当前仍强制每 schema 单个网关实例，尚不支持分布式 worker。
- 新增 `/#security`：修改令牌、验证器 TOTP 绑定、单次恢复码和关闭两步验证。修改安全配置会撤销全部会话；管理员需要自己绑定验证器。实际运营账号尚未启用两步验证。
- 管理接口改用 `/auth/login` 返回的 8 小时会话凭证；原 admin.token 仅作初始导入，之后修改文件不会重置令牌。设备接口与业务邮件 Server 的协议保持兼容。
- 地球图标改为自定义菜单，含选中勾选、键盘导航和中英文文案。浏览器已检查登录、安全设置与语言切换。
- 数据迁移工具、PostgreSQL compose、环境示例与运维说明在私有目录。外部 uptime 探针仍使用自己的 SQLite 离线缓冲，与网关主库无关。

### 2026-09-22 全 Docker 重置测试部署

按用户明确要求，已停止宿主机网关、删除旧 Compose PostgreSQL 容器和数据卷，并删除 `.private-gateway/data`（含旧密钥与备份）及旧 `.env`。现在网关与 PostgreSQL 均由 `.private-gateway/compose.yaml` 运行，新的数据与密钥在命名卷中；本地旧备份路径已失效。

入口仍为 http://127.0.0.1:3220 。初始令牌读取：在 `.private-gateway` 下运行 `docker compose exec gateway cat /app/data/admin.token`。新环境只有默认未配置应用，无原通道、设备、投递记录或两步验证绑定。安装脚本自动生成数据库密码；数据库不映射宿主机端口。

独立无敏感数据的源码发行包：`releases/kookaburra-relay-source.zip`，对应目录 `releases/kookaburra-relay`。包含 Dockerfile、Compose、一键安装脚本及 GitHub Actions（测试后发布 GHCR，amd64/arm64）。尚未推送 GitHub，发布开源前仍需选定许可证。容器内 19 项测试通过，网关重建验证 master.key 保持不变。

## 2026-09-22：网关独立目录及可配置清理

Kookaburra Relay 已完整移至 `/Users/ray/Desktop/KookaburraRelay`，不再位于本项目 `.private-gateway`。旧 releases 中的网关副本已移除，新的无凭据源码包为 `/Users/ray/Desktop/KookaburraRelay-source.zip`。后续网关修改、Compose 操作和 GitHub 发布都在独立目录进行。

Compose 项目名与命名卷维持 kookaburra-relay，数据库和 master.key 沿用。新增「存储与清理」页面：开关、执行间隔、分类保留天数、手动选择类型/截止日期、数量预览确认、历史结果。清理分批执行，保护未完成任务和有效登记。Docker 日志设置 local 10 MB × 5 轮转。默认每日清理，请求日志 14 天、错误 30 天、审计 90 天、其余 30 天。尚未增加自动备份调度。

### 2026-09-23 Mohua PostgreSQL 与 Docker 部署

- 邮件服务完全改用 PostgreSQL 异步查询、连接池及独立事务；新增 bigint 时间戳、运行锁、数据库/密钥匹配校验。
- Docker Compose 项目为 `mohua`，网页地址 http://127.0.0.1:3210；数据库无宿主机映射端口，数据与密钥分别持久化。首次管理员使用本机 `.env` 的 `SETUP_TOKEN`，未预置账号。
- Docker 内 46 项测试通过；额外验证容器重建后数据库记录与 master.key 保持一致，验证 iOS 隔离 fixture 的启动、reset、第二邮箱幂等创建。测试未发送真实邮件。
- 部署包：`releases/mohua-server-docker.tar.gz`；全项目源码：`releases/Mohua-source.tar.gz`。均不含 `.env`、数据库和密钥。
- 本次未修改或重启笑翠鸟网关。iOS App 仍以 Xcode 构建，连接 Docker 中的邮件服务。
