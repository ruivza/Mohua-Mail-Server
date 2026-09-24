# 新邮件加密通知

三端需要一起更新：Mohua iOS、Mohua Server（含 mail-worker）和 KookaburraRelay。此功能不下载或推送正文；既有正文／附件不在 Server 落盘的行为不变。

## 数据流

1. IMAP 监听确认 INBOX 的邮件数量增加。先查询是否存在启用提醒、持有通知公钥且会话有效的设备；没有此类设备或查询失败时，不读取邮件头。需要预览时仅请求最新一封邮件的 `ENVELOPE`，取第一个发件人的显示名称（没有名称时使用地址）和主题；已读、删除、初次连接等事件只触发静默同步。
2. mail-worker 将这两个字段交给业务 Server。它们只在服务端内存中用于加密，不写入日志或通知数据库的明文字段。
3. Server 使用这台手机的通知公钥加密，持久重试队列仅保存密文。每台设备独立加密；短时间内多封来信合并为最新一封的提醒。
4. 网关仅接受固定结构的加密信封，使用该应用配置的兜底标题和 `mutable-content:1`。Apple APNs 收到通用文案及密文，不收到可读的发件人、主题或正文。
5. iOS Notification Service Extension 使用本机私钥解密，显示发件人和主题。无法解密时保留“你有新邮件”；点击打开收件箱，正文仍按用户阅读操作获取。

这只是 Server 到手机的通知内容加密，不代表邮件本身端到端加密：邮件服务商及 Mohua 邮件服务在处理邮件时仍可读取邮件信封。网关和 Apple 仍能看到设备路由、应用标识、投递时间及密文长度等元数据。

## 密钥和锁屏

- iOS 生成独立 P-256 密钥对，只向已登录的业务 Server 上传公钥；私钥不发送给 Server、网关或 Apple。
- 通知私钥保存在 app 和通知扩展专用的 Keychain 共享组，使用 `AfterFirstUnlockThisDeviceOnly`。正常锁屏可解密；重启后第一次解锁前回退通用提醒。
- 共享组只保存通知私钥及作用域。登录会话、邮箱密码密钥仍在 app 私有组，保持 `WhenUnlockedThisDeviceOnly`；邮件数据库保留完整文件保护。
- 关闭设备通知、退出登录或发现系统拒绝通知权限时删除本机通知密钥。停用／撤销远端登记后清理队列；离线时撤销需要等待联网，已经交给 APNs 的通知无法保证撤回。
- 系统的“显示预览”、专注模式、通知摘要和声音设置继续生效。可见推送也不是送达保证。

## 加密协议

算法名：`p256-hkdf-sha256-aes256gcm-v1`。

设备上传 `{algorithm,keyId,publicKey}`：公钥为 65 字节未压缩 X9.63 P-256 公钥的标准 Base64；`keyId` 是公钥原始字节的 SHA-256 小写 hex。

每条通知生成临时 P-256 密钥对，执行 ECDH，再用 HKDF-SHA256 派生 32 字节 AES 密钥。HKDF salt 为 UTF-8 `mohua-notification-v1`，info 与 AES-GCM AAD 相同，按下列字段以换行连接，无结尾换行：

```
mohua-notification-v1
appId
deviceId
serverId
keyId
notificationId
expires
```

`expires` 为十进制 Unix 毫秒，最长 24 小时。密文内容只有 `{sender,subject}`，最多分别 120 和 400 个 Unicode 标量；过滤控制字符及双向文本控制符。

信封为 `{version:1,keyId,id,expires,ephemeralKey,ciphertext}`。`ephemeralKey` 为临时公钥 Base64；`ciphertext` 为 `nonce(12) || ciphertext || tag(16)` 的 Base64。网关限制密文原始字节为 28–2400，拒绝非白名单信封字段。手机校验版本、作用域、密钥标识、期限和 GCM 认证。

网关及 Server 队列只持久化信封，不持久化解密私钥或明文邮件头。成功消费后删除或清空信封；失败等待重试的密文有效期为 24 小时。运行中的服务每轮清理过期队列，即使未配置网关也会清理；停机时暂停，恢复运行后继续。SQL 删除或清空不保证数据库旧页、WAL 或备份同步物理擦除。明文引用在处理完成后由运行时回收，没有固定清除时间或可靠的字符串擦除保证。禁止把明文邮件内容加入日志、API 错误或指标标签。

## 兼容与部署

1. 先更新网关，再更新 Server 和 mail-worker。新增数据库列由原有启动初始化中的幂等 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 添加，不需要重置数据。
2. 网关须配置 `mohua` 应用及匹配的 Apple Bundle ID、环境和 APNs 密钥，在应用管理启用 `sync` 和 `encrypted_alert`，兜底文案设置为“你有新邮件”。`/v1/status?appId=mohua` 返回 `encrypted_alert` 能力和算法名后，Server 才向客户端宣布加密通知支持。
3. 编译 iOS app 和 `MohuaNotificationService` 扩展，两者使用同一 Apple Team，Bundle IDs 为 `com.mohua.app` / `com.mohua.app.notifications`。两者 provisioning profile 均需允许 `$(AppIdentifierPrefix)com.mohua.app.notification-preview` Keychain 共享组；app 还需 Push Notifications。
4. app 的 `MOHUA_GATEWAY_URL` 必须匹配可信 HTTPS 网关。进入通知设置点击“开启新邮件提醒”，允许系统通知；新客户端申请 `purpose:"encrypted_alert"` 凭证并上传通知公钥。
5. 老网关、老 Server 或未授权通知的设备继续静默同步。旧 `sync` 凭证不能发送 `encrypted_alert`；需要重新完成设备证明取得 encrypted_alert 用途凭证。

通知合并窗口默认 5 秒；新邮件提醒最短发送间隔 60 秒，普通静默更新仍为 20 分钟。失败遵守退避和 Retry-After。静默提示只改善同步速度；进入前台仍必须对账，不能把推送视作邮件的唯一来源。

## 验收

自动测试覆盖 Node 加密→Swift 解密、作用域/密钥/密文篡改及过期拒绝、只读 ENVELOPE、密文队列、旧凭证权限隔离、APNs alert 类型、合并与重试、停用、撤销和不变公钥重复登记。

仍须在签名真机与已部署 HTTPS 网关上验收：前台/锁屏/冷启动、重启后首次解锁前的通用提醒、关闭权限和退出登录、多设备、网络离线恢复、空主题，以及收到提醒后打开收件箱。模拟器和假 APNs transport 测试不代表真实 Apple 送达。

网关是通用推送服务：按应用启用 `sync`、`alert`、`encrypted_alert`；新应用及旧应用默认仅 `sync`。Mohua 只申请 `sync` 与 `encrypted_alert`，不发送普通明文邮件通知。更改通知能力保留已有登记：新增能力需客户端申请对应授权，关闭能力仅禁止该类型并取消其未完成任务；其他能力不受影响。修改兜底文案无需重新登记。加密通知默认请求系统通知音，声音由用户在手机系统设置中控制。其他应用可以使用 `alert` 发送普通标题和内容，或自行约定密文内容；邮件字段与加密 AAD 属于 Mohua 业务协议。
