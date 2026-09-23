# Push gateway protocol v1

> 本文描述 Mohua 改名后的协议要求。本次仅修改邮件项目，未修改或部署 Kookaburra Relay 网关；现有网关需要另行适配后才能使用新版推送。

All production endpoints require HTTPS at one origin. No redirects. JSON bodies and responses. No mailbox content is accepted for delivery. IDs are 1–100 ASCII letters, digits, `_` or `-`; credentials are random 32-byte base64url values.

## Client enrollment

1. Authenticated `GET /api/client/push/config` on Server returns `protocol`, `appId`, `mode`, `gatewayUrl`, `serverId`, `revision`, `enabled`, `pushStatus`. Client verifies gateway against its bundled trusted origin.
2. Client calls gateway `POST /v1/registrations` with `appId`, `platform` (`ios`), `channel` (`apns`), `deviceId`, `serverId`, `deviceToken` (hex), `environment` (`sandbox` or `production`), `nonce` (random, at least 32 characters). Response 202 contains `registrationId`, `expiresAt`, **no challenge or credentials**.
3. APNs sends `{aps:{"content-available":1},mohuaRegistration:{id,challenge,nonce,deviceId,serverId,appId}}`. Client must match its pending registration and active session.
4. Client posts `appId`, `challenge` and `nonce` to `/v1/registrations/:id/confirm`. Proof expires after five minutes before confirmation. Response contains `registrationId`, `credential`, `revokeToken`, `expiresAt`; delivery credentials expire after 30 days. Confirmation retries return the same credentials. A proven replacement invalidates other grants for the same application, channel, APNs token and environment.
5. Client stores secrets in protected Keychain and posts `{enabled:true,credential,revision}` to Server `/api/client/push`. Server validates with the gateway before saving encrypted credentials. Config or device changes during validation reject stale writes.

## Server delivery

- `GET /v1/status?appId=mohua`: `{protocol:1,appId,ready:boolean,kinds:["sync"]}`; readiness is not proof of device delivery.
- `POST /v1/validate`, bearer delivery credential; body `{appId,deviceId,serverId,kind:"sync"}`. Response 200 `{valid:true}`.
- `POST /v1/notify`, same scope and credential; response 200 `{accepted:true}` means APNs accepted it, not that the device processed it.
- Gateway sends only `{aps:{"content-available":1},mohua:{version:1,deviceId,appId}}`.
- 410 invalidates a registration; 403 means wrong scope; 429/5xx/network failure are retryable. Unknown fields are never forwarded to APNs.

## Disable and revoke

Client sends `{enabled:false}` to Server `/api/client/push`, clearing credentials and queued work. `{enabled:true}` sets preference only; credentials still need registration. `DELETE /v1/registrations/:id` with bearer **revocation credential** revokes the gateway grant, returning `{revoked:true}` idempotently. Server never receives that revocation credential. Client queues failed revocations securely and retries on foreground entry. Logout also retires the grant.

Server admins use GET/PATCH `/api/admin/push` and POST `/api/admin/push/test`. PATCH accepts `mode` (`disabled`, `official`, `custom`) and custom mode's `customUrl`. An effective configuration change increments `revision` and invalidates existing device credentials. Gateway admin endpoints are private operator interfaces outside this public protocol.

## Multiple applications and channel capabilities

Each application has an immutable gateway application ID, independent enablement, Apple topic/key/environment configuration and registration revision. The client bundles its expected ID (`MohuaGatewayAppID` for iOS); the business Server sends the same ID for validation and delivery. Mohua uses `mohua`. Missing `appId`, `platform` and `channel` retain only the legacy Mohua/iOS/APNs defaults; they are never inferred from a caller-supplied device token.

Credentials are bound to app, device, Server instance and `sync` purpose. A caller cannot substitute a different application or request a visible alert. Token ownership, rate limits by token, and replacement are scoped to app/channel/environment. Changing an app's push configuration or enablement invalidates only that app's registrations; a name-only edit preserves them. The same Apple topic/environment cannot be assigned to two gateway apps within a team.

Currently only `ios` + `apns` + `sync` is implemented. Android FCM and vendor channel IDs (`huawei`, `xiaomi`, `oppo`, `vivo`, `honor`) are reserved, explicitly marked unimplemented, and enrollment returns 501. They are not a working Android implementation. Future adapters must implement their own device proof and map supported message kinds without assuming APNs silent-wake semantics. Visible notifications must be a separate capability and credential purpose.

The private administration API uses GET/POST `/admin/apps` and PUT `/admin/apps/:id`. Listing returns applications plus channel capabilities, without private keys. Update accepts `name`, `enabled`, and optional `apns` (`teamId`, `keyId`, `topic`, `environment`, optional `privateKey` to replace the stored key). The old singleton `/admin/config` is removed. Migration preserves its encrypted Apple configuration as `mohua` and invalidates old, unscoped gateway registrations once; clients re-enroll.


## 可选扩展：持久任务与 Android FCM（2026-09）

现有 APNs `/v1/notify` 与挑战协议保持兼容。原接口的 200 仍表示通道已接受；网关不自动重试其失败任务，由调用方负责。

支持此扩展的网关提供 `POST /v1/jobs`：使用原有设备 Bearer 凭证，正文在 `{appId,deviceId,serverId,kind:"sync"}` 上增加 `requestId`（16–100 个 `[A-Za-z0-9_-]` 字符）。202 返回任务记录及 ID，仅表示已入队；调用方用同一个 requestId 恢复丢失的入队响应，不能另发一份通知。`GET /v1/jobs/:id` 使用同一设备凭证查询，仅允许读取该登记自己的任务。

状态包括 queued、sending、retrying、accepted、failed、unknown、cancelled；accepted 是厂商接受而非设备送达。429 / 5xx 的异步重试由网关负责；unknown 表示结果无法确定，不自动重发。幂等保证限于任务记录保留期（当前 30 天）。现有 Mohua Server 继续使用同步接口，不因扩展发生行为变化。

FCM 登记指定 `platform:"android"`、`channel:"fcm"`、`environment:"production"`。token 必须保留大小写。FCM `data.mohuaRegistration` 为挑战对象的 JSON 字符串，解析后调用原确认 API；`data.mohua` 为同步提示对象的 JSON 字符串。查询 FCM 配置就绪使用 `/v1/status?appId=...&channel=fcm`；不指定 channel 时仍查询 APNs。未实现厂商返回 501，不回退到其他通道。
