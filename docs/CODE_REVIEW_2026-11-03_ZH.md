# Mohua 服务端代码审查（2026-11-03）

范围：`src/`、`public/`、`ops/`、`compose*.yaml`、`Dockerfile`、`scripts/`，以静态阅读为主。本机无 Node，测试只能在 Docker 内跑，本次没有执行测试套件，也没有在运行环境中复现下列问题。

总体评价：安全设计是这个项目最强的部分（进程隔离、密钥不出 worker、AES-GCM 全部带 AAD、SSRF 固定 IP、容器硬化、令牌只存哈希、常量时间比较、全参数化 SQL）。真正需要优先处理的是两件事：一个会让大归档永远删不掉的缺失索引，以及一组每秒全量轮询。代码层面最大的问题是风格分裂和 server.js / mail-worker.js 之间的大段复制。

严重度：高 = 会造成数据无法清理或功能停摆；中 = 行为错误或明显可感知的性能/一致性问题；低 = 应修但影响有限。

---

## 一、安全

### S1（中）会话失效不会撤销内存中的邮箱授权

- 用户路径 `DELETE /api/devices/:id`（[server.js:568](../src/server.js#L568)）只删除 `sessions` 行，不把 `client_devices.revoked` 置位，也不调用 `leases.revokeDevice`。
- 会话到期由 `auth.sweep` 删除 `sessions` 行，同样不触及设备。
- 控制面 leaseTick（[server.js:206](../src/server.js#L206)）和 worker inventory（[mail-worker.js:146](../src/mail-worker.js#L146)，devices 列表来自 [mail-broker.js:58](../src/mail-broker.js#L58)）判断授权是否继续存活时只看 `revoked IS NULL`，不看该设备是否还有有效会话。
- 结果：某设备安装的邮箱授权（解密密钥 + 密码密文）在会话被撤销或过期后仍驻留内存并继续 IMAP 监听，直到授权自身的 `expiresAt`；`expiresAt` 可为 null，即永不过期。

建议：把授权存活条件改为"设备未撤销且至少有一个未过期会话"，inventory 的 `devices` 查询加 `EXISTS(sessions 未过期)`；或让 `/api/devices/:id` 对用户设备走 `devices.revoke`。

### S2（低）验证回执的 HMAC 密钥直接复用 MAIL_BROKER_TOKEN

[server.js:155](../src/server.js#L155)、[mail-verification.js:346](../src/mail-verification.js#L346)。一个秘密承担两个用途（Bearer 认证 + 签名）。建议用 HKDF 从 token 派生一个独立的 `verification` 密钥。

### S3（低）控制面模式下 lease 安装与事务不一致

[server.js:679-680](../src/server.js#L679)：`leases.install` 在事务内修改内存，之后 `configureSync` 若失败，事务回滚但 lease 已安装。worker 版本（[mail-worker.js:219](../src/mail-worker.js#L219)）有 try/catch 回滚，控制面没有。

### S4（低）登录限流表清理条件过松

[server.js:246](../src/server.js#L246)：只在 `attempts.size > 10000` 时清理过期项，且只删除已过期的。一分钟内来自大量不同 /64 的请求可让 Map 持续增长。建议每次进入时顺手淘汰、或改用固定容量 LRU。

### 做得好的地方（无需改动）

- `publicAddress` 先解析再固定 IP，拒绝非 unicast，TLS 仍校验原主机名：IMAP/SMTP/推送网关三处 SSRF 都被堵住。
- 所有 AES-GCM 调用都绑定了上下文 AAD（凭证、归档块、草稿、通知）。
- 管理台 CSP `script-src 'self'`，前端全部 `textContent`，无 innerHTML。
- broker 令牌用 `timingSafeEqual`，会话令牌只存 SHA-256。
- `archive-store` 动态 `IN (...)` 全部用占位符；`parameters()` 跳过引号内的 `?`。
- 容器：read_only、cap_drop ALL、no-new-privileges、内部网络分段、worker 无数据库与主密钥。

---

## 二、逻辑错误

### L1（中）恢复邮箱时无条件开启同步模式

[remote-storage.js:38](../src/remote-storage.js#L38)：`restore` 把 `sync_enabled=1, sync_status='paused'` 写死。一个从未开启过同步模式的邮箱，删除后在 30 天内恢复，会变成"已暂停的同步模式"：`ArchiveReader.folders/list` 走空归档而不是 IMAP，用户看到空邮箱。测试 [archive.test.js:152](../test/archive.test.js#L152) 只覆盖了原本就开启同步的情况。

建议：`sync_status = CASE WHEN sync_enabled=1 THEN 'paused' ELSE 'off' END`，不改 `sync_enabled`。

### L2（中）隔离模式下关闭监听会撤销授权

[server.js:168](../src/server.js#L168) 的 `mail.stop` 桩映射为 `broker.invalidate(id)`；worker 看到 invalidation 计数变化后执行 `leases.revoke`（[mail-worker.js:146](../src/mail-worker.js#L146)）。于是 `POST /monitor {enabled:false}` 在隔离模式下会把用户的邮箱授权一并撤销，控制面模式只是停监听。两种模式行为不一致，客户端需要重新授权才能继续读信。

建议：broker 增加独立的 `stopMonitor` 信号，而不是复用 invalidation 计数。

### L3（中）同步遇到"毒消息"没有退避，整个文件夹停摆

[archive-sync.js:447-448](../src/archive-sync.js#L447)：单条 `capture` 失败（非 401/403/409/423）让 `savePage` 返回 false，游标不推进，状态置 `error`。典型触发：服务器报告的 `RFC822.SIZE` 与实际下载字节数不符（部分 IMAP 服务器会做 CRLF 规范化），[archive-sync.js:521](../src/archive-sync.js#L521) 抛 502。此后每轮都重新下载同一封信、再次失败，该文件夹的历史回填永远不会完成。

建议：按 `(validity, uid)` 记录失败次数，超过阈值后跳过并标记，继续后续消息。

### L4（低）worker 对非账号路径的 POST/DELETE 抛 TypeError

[mail-worker.js:195](../src/mail-worker.js#L195)：`match?.[2].startsWith("drafts/")` 在 `match` 为 null 时对 `undefined` 调用 `startsWith`。`POST /api/outbox`、`DELETE /api/outbox/<id>` 会返回 502 "Mail operation failed" 而不是 404/405。改为 `match?.[2]?.startsWith(...)`。

### L5（低）失败的消息操作也会推进 revision 并入队推送

[server.js:738-739](../src/server.js#L738)：`finally` 中无条件 `devices.changed`。失败请求也让所有设备触发一次同步。

### L6（低）被阻塞的 writeback 永久卡住同一消息的后续回写

[independent-store.js:541](../src/independent-store.js#L541)：`NOT EXISTS (earlier sequence)` 把 `blocked` 行也算在内，之后该消息的任何标记变化都不会回写；状态接口只报数量，没有清理或重试入口。

### L7（低）版本与限额文案不一致

- `package.json` 0.1.0；`index.html` v0.8.0；`app.js` 两处 "Server v0.8.0"。
- `ops/mail-edge.conf` `client_max_body_size 37m`；`docs/MAIL_PROCESS_ISOLATION.md` 写 26 MiB。

### L8（低）edge 正则与 `mailRoute` 没有一致性测试

[ops/mail-edge.conf:30](../ops/mail-edge.conf#L30) 与 [mail-protocol.js:314](../src/mail-protocol.js#L314) 手工保持同步，`test/mail-isolation.test.js` 只测了 `mailRoute` 自身。任何一侧漂移都会表现为 421 或 404。建议测试里解析 nginx 配置中的正则并与一组路径逐一比对。

---

## 三、性能

### P1（高）缺少外键索引，大归档的删除会撞 statement_timeout

`schema.sql` 中 `mailbox_source_links.message_id`（ON DELETE SET NULL）和 `mailbox_writebacks.message_id`（ON DELETE CASCADE）都没有索引。每删除一行 `archive_messages`，PostgreSQL 都要全表扫描这两张表以维护外键。`mailbox_source_links` 行数约等于消息数，所以 [remote-storage.js:58](../src/remote-storage.js#L58) 的 `DELETE ... LIMIT 100` 实际是 100 次全表扫描；归档达到数万封时会超过 `statement_timeout: 15000`，清理每分钟重试、每分钟超时，邮箱永远删不掉。`independentMutation` 的 `purge` 同样受影响。

修复：

```sql
CREATE INDEX IF NOT EXISTS source_links_message ON mailbox_source_links(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS writebacks_message ON mailbox_writebacks(message_id);
```

顺带可加 `device_mailboxes(account_id)`、`outbox(account_id)`，影响较小。

### P2（中）多处每秒 O(N) 轮询

- 控制面 leaseTick（[server.js:201-216](../src/server.js#L201)）：每秒全量 `SELECT accounts`，每个有授权的邮箱再 1 次 `devices.allowed`，再 1 次 `SELECT` 草稿账号。
- worker inventory（[mail-worker.js:139](../src/mail-worker.js#L139)）：每秒把全部账号（含 credential/sync_credential）和设备序列化成 JSON 走一遍 HTTP。
- `remoteDrafts.scheduleMigration`（[remote-drafts.js:166](../src/remote-drafts.js#L166)）：每秒对每个账号开一个事务、取 `FOR SHARE` 行锁（[archive-store.js:19](../src/archive-store.js#L19)）、查一次 `draftLegacy`。即使系统里早就没有旧格式草稿，这个开销也永远存在。

建议：迁移改为启动时跑一次、完成后写 `schema_migrations` 标记；inventory 加变更号，账号未变时只发心跳；leaseTick 的 `devices.allowed` 改为一次 JOIN 查询。

### P3（中）全局硬上限按单用户部署设定

- 同时发送 2 封（[sender.js:201](../src/sender.js#L201)），prepared 32 封。
- IMAP 读取全局 16、每用户 2（[reader.js:520](../src/reader.js#L520)）。

多用户场景下互相挤占，第三个用户直接 429。建议按用户限额，全局上限放宽或改为可配置。

### P4（中）邮箱删除清理速率 100 条/分钟

[remote-storage.js:58](../src/remote-storage.js#L58) 每次 sweep 每个账号只删 100 条，sweep 由 60 秒定时器驱动。5 万封邮件需要 8 小时以上。P1 修完后可以在单次 sweep 内循环直到用完时间预算。

### P5（低）fsync 频率过高

[mail-files.js:278-280](../src/mail-files.js#L278)：每 8 块（≤512 KiB）1 次文件 fsync + 2 次目录 fsync。25 MiB 附件约 150 次 fsync。目录 fsync 只在文件首次创建时需要。`migrateArchive`（[mail-files.js:333](../src/mail-files.js#L333)）逐块 `putChunk` + `getChunk` 校验，每块 3 次 fsync + 2 次 SQL + 1 次文件打开。

### P6（低）发送路径的内存拷贝

[sender.js:95](../src/sender.js#L95) `Buffer.from(r.value)` 复制每个上传块；`append` 模式把整封 MIME（≤40 MiB）缓存在 `saved` 数组（[sender.js:344](../src/sender.js#L344)）。

### P7（低）重复查询

- `GatewaySettings.current()` 每次查库，`push.status` 调 2 次、`scheduleLocked` 调 2 次、`validate` 调 2 次。
- 每个已认证请求：`auth.authenticate` 2 次查询（先管理员后用户）+ `deviceForSession` 1 次 + `scopedAccount` 1 次 + 路由内再 `SELECT * FROM accounts` 1 次。可合并为一次 JOIN 并在请求内复用账号行。
- 管理台每 5 秒拉 `/admin/health`，约 12 条查询；采样本身每 60 秒一次，轮询可放宽到 15 秒。

### P8（低）其他

- 静态文件每次请求 `readFileSync`（[server.js:297](../src/server.js#L297)、[server.js:316](../src/server.js#L316)），启动时读入内存即可。
- `reader.list` 为返回 ≤50 条取 200 条 envelope（[reader.js:616](../src/reader.js#L616)）。
- `remote-storage.status(usage=1)` 对整个归档做 `octet_length` 求和，大归档上是全表读；改用 `pg_column_size` 或维护计数器。

---

## 四、复用与清晰度

### R1（高）代码风格分裂

约一半文件是 Prettier 风格（auth、devices、push、gateway、reader、sender、mail、database），另一半是压成单行的密集写法（mail-worker、mail-broker、archive-store、archive-sync、archive-reader、remote-storage、remote-drafts、mail-files、independent-*、credential-leases）。[mail-worker.js:292](../src/mail-worker.js#L292) 一行 400 多个字符包含整个关闭流程。这直接拉高了审查和修改成本。建议：统一 `prettier` + `eslint`，CI 里 `--check`。

### R2（高）server.js 与 mail-worker.js 大段复制

`server.js` 是 1068 行的单个请求闭包，用顺序正则做路由。`mail-worker.js` 复制了其中 credential、sync-mode、drafts、outbox、读取和附件流式这些路由；附件流式与 `Content-Disposition` 构造（[server.js:783-813](../src/server.js#L783) 对 [mail-worker.js:271-279](../src/mail-worker.js#L271)）几乎逐字相同。任何修复都要改两处，L4 这种差异就是复制后分叉的结果。

建议：抽 `routes/` 目录按域拆分（auth、client、accounts、mail、admin），`streamAttachment(res, file, recheck, signal)` 共用，mail 路由处理器接受一个 `{authorize, store, ...}` 上下文，控制面与 worker 各自注入。

### R3（中）重复的小工具函数

- `fail(status, message)` 定义了 14 次。
- 控制字符清洗 `clean()` 3 份：[mail.js:1157](../src/mail.js#L1157)、[archive-store.js:153](../src/archive-store.js#L153)、[notification-crypto.js:505](../src/notification-crypto.js#L505)。
- UID validity 生成 `(BigInt("0x"+randomBytes(8)...)+1n).toString()` 3 份。
- UUID 正则 5 处以上。
- "会话 + 凭证未变"的 `Access revoked` SQL 在 server.js 出现 3 次（[519](../src/server.js#L519)、[724](../src/server.js#L724)、[820](../src/server.js#L820)）；会话存活 SQL 在 [server.js:653](../src/server.js#L653)、[server.js:672](../src/server.js#L672)、[mail-broker.js:78](../src/mail-broker.js#L78)。
- `jsonBody` / `reply` 已在 `mail-protocol.js` 中，server.js 又手写了一遍（[338-360](../src/server.js#L338)、[269-276](../src/server.js#L269)）。

建议：`src/errors.js`（fail）、`src/validate.js`（uuid、clean、text、integer）、`src/queries.js`（共享 SQL）。

### R4（中）鸭子类型桩对象

[server.js:157](../src/server.js#L157)、[server.js:168-170](../src/server.js#L168) 在隔离模式下用内联对象字面量冒充 `CredentialLeases`、`MailService`、`MailReader`、`MailSender`；[mail-verification.js:364](../src/mail-verification.js#L364) 用假 db `{prepare:()=>({get:async()=>account})}` 骗过 `MailService.active`。L2 的 bug 正是 `stop → invalidate` 这种"看起来差不多"的映射带来的。建议用显式的 `BrokerMailFacade` 类，方法语义与接口文档一一对应。

### R5（低）散落的魔法数

86400000、300000、4294967295、65536、批大小 8、心跳 10000/15000 ms、限额 20/32/16/2 分布在十几个文件里。建议 `src/limits.js` 集中命名。

### R6（低）零碎

- `recoveryDays: 30` 字面量与 `RECOVERY_MS` 常量分离（remote-storage.js:12）。
- `publicAccount` 列表包含 `credential` 只为算 `credentialMode`，之后再 `credential: undefined` 删掉。
- `app.js:469` `api("/admin/invites", "POST", {}, bearer)` 多传了一个被忽略的参数。
- `.env.example` 和 `configure.mjs` 生成的字段集合不一致（example 多 `PUSH_GATEWAY_APP_ID`、`TRUSTED_PROXY_HOPS`、`GATEWAY_SERVER_CREDENTIAL*`）。

---

## 五、建议的处理顺序

1. P1 加索引（两行 SQL，立刻生效）。
2. L1 restore 条件、L4 空值保护、S3 控制面 lease 回滚：各一两行。
3. S1 授权存活绑定会话。
4. L2 broker 增加独立 stopMonitor 信号。
5. L3 同步毒消息退避。
6. P2 去掉每秒迁移扫描、inventory 加变更号。
7. R1 统一格式化，然后再做 R2/R3 的抽取，否则 diff 不可读。

## 六、未验证事项

- 测试套件未运行（需 Docker）。
- 没有在真实 PostgreSQL 上验证 P1 的执行计划，结论来自外键维护的标准行为。
- L3 依赖 IMAP 服务器报告的 size 不准这一前提，未在具体提供商上复现。
