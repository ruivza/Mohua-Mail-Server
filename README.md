# Mohua Mail Server

[![Test and publish](https://github.com/ruivza/Mohua-Mail-Server/actions/workflows/docker.yml/badge.svg)](https://github.com/ruivza/Mohua-Mail-Server/actions/workflows/docker.yml)

Self-hosted mail proxy for the Mohua iOS client. It connects to your existing IMAP/SMTP mailboxes, streams mail to the app, sends on its behalf, and optionally keeps an encrypted archive on the server. Node.js 24, PostgreSQL 18, Docker Compose.

The iOS client lives in a separate repository. This repository contains only the server and its web console.

## Features

- Multiple mailboxes per user, multiple devices per user, invitation-based registration.
- **Proxy mode** (default): mail is read live from the provider; bodies and attachments are never written to disk on the server.
- **Sync mode** (optional): the mail worker archives originals, bodies and attachments under its own key, so mail survives deletion at the provider and background sync continues while the app is signed out. See [SYNC_MODE_ZH.md](SYNC_MODE_ZH.md).
- Client-held mailbox keys: the client encrypts mailbox passwords; the server only holds a time-limited in-memory authorization while a device session is alive. See [docs/CLIENT_CREDENTIAL_LEASES.md](docs/CLIENT_CREDENTIAL_LEASES.md).
- Process isolation: mailbox credentials, IMAP/SMTP traffic and message bodies only enter a separate `mail-worker` container that has no database access and no master key. See [docs/MAIL_PROCESS_ISOLATION.md](docs/MAIL_PROCESS_ISOLATION.md).
- Sending with idempotency keys, reply/forward, sent-copy policy, streamed attachments up to 25 MiB.
- Incremental folder sync, IMAP IDLE monitoring, and push hints through an optional gateway (Kookaburra Relay), including end-to-end encrypted new-mail alerts. See [GATEWAY_PROTOCOL.md](GATEWAY_PROTOCOL.md) and [ENCRYPTED_NOTIFICATIONS.md](ENCRYPTED_NOTIFICATIONS.md).
- Web console for administrators: users, invitations, push gateway, service health. Chinese and English, light and dark.

## Architecture

```
client ──HTTPS──▶ your TLS proxy ──▶ edge (nginx)
                                      ├─ /api/accounts/:id/{credential,folders,messages,sync,drafts,outbox,verify}
                                      │        └──▶ mail-worker ──▶ IMAP / SMTP
                                      └─ everything else ──▶ server ──▶ PostgreSQL
                                                   ▲
                                      mail-worker ─┘ /internal/mail (broker, token-authenticated)
```

| Service       | Role                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `edge`        | Fixed routing. Sends mailbox authorization and mail content paths straight to the worker. |
| `server`      | Accounts, devices, sessions, push queue, console, broker for the worker. Owns the master key. |
| `mail-worker` | IMAP/SMTP connections, decryption of mailbox credentials, archive encryption. No DB access.  |
| `database`    | PostgreSQL. Not exposed to the host.                                                      |

Only one server instance may own a database schema at a time; horizontal scaling is not supported.

## Requirements

- Docker Engine with Compose v2.
- A TLS reverse proxy in front of port 3210 for anything beyond local testing.
- Mail providers reachable on public addresses with IMAP 993 (implicit TLS) and SMTP 465 (implicit TLS) or 587 (STARTTLS). Username is the mailbox address; use an app password where the provider requires one.

## Quick start

```sh
node scripts/configure.mjs
docker compose up -d --build --wait
```

Without local Node, run the configuration step in a container:

```sh
docker run --rm -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/configure.mjs
```

`configure.mjs` writes `.env` with random secrets and the defaults from `.env.example`. It never overwrites existing values or prints secrets.

Open `http://127.0.0.1:3210`, expand **First-time setup**, and create the first administrator with the `SETUP_TOKEN` from `.env` (password of at least 12 characters). Then create an invitation under **Users** and register from the iOS app.

Useful commands:

```sh
docker compose ps                        # health of all four services
docker compose logs --tail=100 server
docker compose down                      # stop, keep data
```

Never run `docker compose down -v` unless you intend to delete the database and the master key.

### Prebuilt image

CI publishes `ghcr.io/<owner>/<repository>` for linux/amd64 and linux/arm64 on every push to the default branch (`latest`) and on `v*` tags. To deploy without building:

```sh
node scripts/configure.mjs
echo 'MOHUA_IMAGE=ghcr.io/ruivza/mohua-mail-server:latest' >> .env
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d --wait
```

`compose.image.yaml` uses the same project name and volumes as `compose.yaml`; use one or the other, not both.

## Configuration

All variables live in `.env` and are read by Compose.

| Variable                                               | Default     | Purpose                                                                                           |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                                    | generated   | Database password shared by `database` and `server`.                                              |
| `SETUP_TOKEN`                                          | generated   | One-time token for creating the first administrator.                                              |
| `MAIL_BROKER_TOKEN`                                    | generated   | Internal token between `mail-worker` and `server`. Also seeds the mailbox-verification key.       |
| `MOHUA_BIND_ADDRESS`, `MOHUA_PORT`                     | `127.0.0.1`, `3210` | Host address and port published by `edge`.                                              |
| `TRUSTED_PROXY_HOPS`                                   | `1`         | Proxies that append `X-Forwarded-For`. The bundled edge counts as 1. Never set it higher than reality. |
| `OFFICIAL_PUSH_GATEWAY_URL`                            | empty       | HTTPS origin of the push gateway offered as "official" in the console.                            |
| `PUSH_GATEWAY_APP_ID`                                  | `mohua`     | Application ID registered at the gateway; must match the iOS build.                               |
| `GATEWAY_SERVER_CREDENTIAL`, `GATEWAY_SERVER_CREDENTIAL_URL` | empty | Server identity for gateways that require approval. See [APNS_SETUP_ZH.md](APNS_SETUP_ZH.md). |
| `MOHUA_IMAGE`                                          | unset       | Image reference for `compose.image.yaml`.                                                         |

For local Node development the server also accepts `DATABASE_URL` (or `PG*`), `HOST`, `PORT`, `DATA_DIR` and `MASTER_KEY_FILE`.

Keys and data: the master key is `/app/keys/master.key` in the `mohua-keys` volume (`data/master.key` for local Node); the worker's archive key is in `mohua-mail-keys`; archived originals and attachments are in `mohua-mail-files`. The server refuses to start if the database and the master key do not match.

## Development

```sh
npm ci --ignore-scripts
DATABASE_URL=postgres://user:password@127.0.0.1:5432/mohua npm start
```

Production always runs the isolated worker; `npm start` without `MAIL_BROKER_TOKEN` is refused. Tests exercise the in-process mode through `createApp()`.

### Tests

```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down
```

Or keep the throwaway database running and iterate locally:

```sh
docker compose -f compose.test.yaml up -d --wait database
TEST_DATABASE_URL=postgres://mohua_test:local-disposable-test-only@127.0.0.1:54329/mohua_test npm test
```

Each database test uses its own schema and drops it afterwards.

### Formatting

Prettier 3.3.3 via `npx`, pinned, not a dependency. CI runs the check before the tests.

```sh
npm run format:check
npm run format
```

### Release bundle

`npm run export:server` copies an allowlist of files to `dist/mohua-server/`. The whole working directory is not meant to be published as-is.

## API

JSON requests use `Content-Type: application/json`; authenticated requests send `Authorization: Bearer <token>`. Administrators and users are separate identities: administrators cannot sign in to the client or read any mailbox.

| Method       | Path                                                      | Purpose                                                      |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------ |
| POST         | `/api/setup`                                              | Create the first administrator: `email`, `password`, `setupToken` |
| POST         | `/api/login`                                              | Administrator sign-in (24 h session)                         |
| POST         | `/api/admin/invites`                                      | Create a single-use invitation valid for 24 h                |
| GET/PATCH    | `/api/admin/users[/:id]`                                  | List users / set `active`                                    |
| GET/PATCH    | `/api/admin/push`, POST `/api/admin/push/test`            | Push gateway selection and connectivity test                 |
| GET          | `/api/admin/health`, POST `/api/admin/health/run`         | Service summary / manual mail-path self-test                 |
| POST         | `/api/register`                                           | Register with an invitation                                  |
| POST         | `/api/client/login`                                       | Device sign-in (30-day session); accepts `deviceId`, `deviceInfo` |
| GET          | `/api/me`                                                 | Current identity                                             |
| POST         | `/api/logout`                                             | End the session; a device session also revokes the device   |
| GET/DELETE   | `/api/devices[/:id]`                                      | List / revoke sessions                                       |
| GET/DELETE   | `/api/client-devices[/:id]`                               | List / revoke devices                                        |
| GET          | `/api/client/sync`, POST `/api/client/ack`                | Mailbox revision hints and acknowledgements                  |
| GET/POST     | `/api/client/push/config`, `/api/client/push`, `/api/client/push/ticket` | Push registration                            |
| GET/POST     | `/api/accounts`                                           | List / add mailboxes (requires a verification receipt)       |
| PATCH/DELETE | `/api/accounts/:id`                                       | Rotate the encrypted credential / start deletion             |
| GET/POST     | `/api/accounts/:id/remote-storage`                        | Archive status / `delete`, `restore`, `purge`                |
| GET/POST/DELETE | `/api/accounts/:id/credential`                         | Challenge, install or revoke the in-memory authorization     |
| GET/POST/DELETE | `/api/accounts/:id/sync-mode`                          | Sync-mode status, enable, pause                              |
| POST         | `/api/accounts/:id/verify`                                | Verify IMAP/SMTP; `preflight: true` returns a receipt        |
| POST         | `/api/accounts/:id/monitor`                               | Enable or disable IMAP IDLE monitoring                       |
| GET          | `/api/accounts/:id/folders`                               | Folder list                                                  |
| GET          | `/api/accounts/:id/messages`                              | UID-paged list (`folder`, `uidValidity`, `before`, `limit`)  |
| POST         | `/api/accounts/:id/sync`                                  | Incremental sync: `{folder, uidValidity, after, known}`      |
| GET          | `/api/accounts/:id/messages/:uid[/body\|/attachments/:n]` | Metadata / body stream / attachment stream                   |
| POST         | `/api/accounts/:id/messages/:uid/actions`                 | `read`, `unread`, `flag`, `unflag`, `move`, `archive`, `trash` |
| GET/POST/DELETE | `/api/accounts/:id/drafts[/:id]`                       | Remote drafts (sync mode)                                    |
| POST         | `/api/accounts/:id/outbox`                                | Prepare a send; requires `Idempotency-Key`                   |
| GET/PUT      | `/api/outbox[/:id]`                                       | Send status / upload attachments and send                    |
| GET          | `/healthz`                                                | Readiness probe, no authentication                           |

A stale `uidValidity` returns 409; drop paging state and reload. Send results that are `unknown` must not be retried automatically.

## Security model

- Passwords are scrypt-hashed; session tokens are stored as SHA-256 hashes; server-side secrets are AES-256-GCM encrypted with the master key.
- Mailbox passwords are encrypted by the client. The server receives a short-lived decryption key per mailbox, keeps it in memory only, and discards it when the device signs out, its session expires, the credential is rotated or the server restarts. Sync-mode authorizations are persisted under the worker's own key and are independent of sessions.
- Outbound IMAP, SMTP and gateway connections resolve the host first, reject non-public addresses, pin the resolved IP and still verify TLS against the hostname.
- Containers run read-only with all capabilities dropped; the worker runs as a separate UID with no database network.
- Rate limits for sign-in, registration and verification use the real client address derived from `TRUSTED_PROXY_HOPS`.
- A running server can read any mailbox it currently holds an authorization for. This is not end-to-end encryption against a compromised host.

## Backup and restore

The database and the master key only work together. In sync mode the `mohua-mail-keys` and `mohua-mail-files` volumes must be backed up consistently as well (see [SYNC_MODE_ZH.md](SYNC_MODE_ZH.md#备份)).

```sh
mkdir -p backups && chmod 700 backups
docker compose stop server
docker compose exec -T database pg_dump -U mohua -d mohua -Fc > backups/database.dump
docker compose cp server:/app/keys/master.key backups/master.key
chmod 600 backups/database.dump backups/master.key
docker compose start server
```

Restore with `pg_restore`, copy `master.key` back into the `mohua-keys` volume, then start the server. Keep `.env` private as well.

## Documentation

- [docs/SERVER_README.md](docs/SERVER_README.md): deployment guide (Chinese)
- [docs/MAIL_PROCESS_ISOLATION.md](docs/MAIL_PROCESS_ISOLATION.md): worker isolation, lifecycle, upgrade
- [docs/CLIENT_CREDENTIAL_LEASES.md](docs/CLIENT_CREDENTIAL_LEASES.md): client-held keys and authorization protocol
- [SYNC_MODE_ZH.md](SYNC_MODE_ZH.md): sync mode, retention, backup
- [GATEWAY_PROTOCOL.md](GATEWAY_PROTOCOL.md), [ENCRYPTED_NOTIFICATIONS.md](ENCRYPTED_NOTIFICATIONS.md), [APNS_SETUP_ZH.md](APNS_SETUP_ZH.md): push gateway

## License

No license file is included yet. All rights reserved until one is added.
