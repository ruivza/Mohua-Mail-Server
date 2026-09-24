import https from "node:https";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { publicAddress } from "./mail.js";

const fail = (message) => {
  throw Object.assign(Error(message), { status: 400 });
};
export function gatewayURL(value) {
  if (typeof value !== "string" || value.length > 2048)
    fail("Invalid gateway URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Invalid gateway URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    fail("Gateway must be an HTTPS origin");
  return url.origin;
}

export class GatewaySettings {
  constructor(db, officialURL) {
    this.db = db;
    this.officialURL = officialURL ? gatewayURL(officialURL) : null;
  }
  async initialize() {
    const db = this.db;
    await db
      .prepare(
        "INSERT INTO push_settings VALUES(1,'official',NULL,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(randomUUID(), randomUUID(), this.officialURL);
    const previous = await db
      .prepare("SELECT official_url FROM push_settings WHERE id=1")
      .get();
    if (previous.official_url !== this.officialURL) {
      await db
        .prepare(
          "UPDATE push_settings SET official_url=?,revision=? WHERE id=1",
        )
        .run(this.officialURL, randomUUID());
      await this.invalidate();
    }
  }
  async current() {
    const row = await this.db
      .prepare("SELECT * FROM push_settings WHERE id=1")
      .get();
    return {
      mode: row.mode,
      customUrl: row.custom_url || "",
      officialUrl: this.officialURL,
      gatewayUrl:
        row.mode === "official"
          ? this.officialURL
          : row.mode === "custom"
            ? row.custom_url
            : null,
      revision: row.revision,
      serverId: row.server_id,
      protocol: 1,
      appId: "mohua",
    };
  }
  async configure(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail("Invalid push settings");
    if (!["disabled", "official", "custom"].includes(input.mode))
      fail("Invalid push mode");
    const url = input.mode === "custom" ? gatewayURL(input.customUrl) : null;
    const previous = await this.current();
    if (previous.mode === input.mode && previous.customUrl === (url || ""))
      return previous;
    await this.db.transaction(async () => {
      await this.db
        .prepare(
          "UPDATE push_settings SET mode=?,custom_url=?,revision=? WHERE id=1",
        )
        .run(input.mode, url, randomUUID());
      await this.invalidate();
    });
    return await this.current();
  }
  async invalidate() {
    // Credentials are bound to one gateway configuration and cannot move to another host.
    await this.db
      .prepare(
        `UPDATE client_devices SET push_alerts=0,notification_key=NULL,push_credential_hash=NULL,push_credential=NULL,push_token=NULL,push_token_hash=NULL,
      push_environment=NULL,push_error=NULL,push_registered=push_registered+1`,
      )
      .run();
    await this.db.exec("DELETE FROM push_jobs");
  }
}

export class GatewayTransport {
  constructor(resolveHost = publicAddress) {
    this.resolveHost = resolveHost;
    this.requests = new Set();
  }
  async request(origin, path, { credential, serverCredential, body } = {}) {
    const url = new URL(path, gatewayURL(origin));
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const address = await Promise.race([
        this.resolveHost(url.hostname),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(Error("Gateway timed out")),
            { once: true },
          ),
        ),
      ]);
      if (controller.signal.aborted) throw Error("Gateway request cancelled");
      return await new Promise((resolve, reject) => {
        const request = https.request(
          url,
          {
            method: body ? "POST" : "GET",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...(credential ? { Authorization: "Bearer " + credential } : {}),
              ...(serverCredential ? { "X-Relay-Server-Credential": serverCredential } : {}),
            },
            lookup: (_, options, done) =>
              options.all
                ? done(null, [{ address, family: isIP(address) }])
                : done(null, address, isIP(address)),
          },
          (response) => {
            let bytes = 0;
            const chunks = [];
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 65536) {
                response.destroy(Error("Gateway response too large"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              let payload = {};
              try {
                payload = JSON.parse(Buffer.concat(chunks).toString());
              } catch {
                reject(Error("Invalid gateway response"));
                return;
              }
              // No redirects: never send a delivery credential to another origin.
              resolve({ status: response.statusCode, body: payload, retryAfter: response.headers["retry-after"] });
            });
          },
        );
        request.on("error", reject);
        request.end(body ? JSON.stringify(body) : undefined);
      });
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }
  close() {
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }
}

export class GatewayProvider {
  constructor(settings, transport = new GatewayTransport(), identity = {}) {
    Object.assign(this, { settings, transport });
    this.serverCredential = identity.credential ?? process.env.GATEWAY_SERVER_CREDENTIAL ?? "";
    const origin = identity.origin ?? (process.env.GATEWAY_SERVER_CREDENTIAL_URL || settings.officialURL);
    this.credentialOrigin = origin ? gatewayURL(origin) : null;
  }
  identityFor(config) {
    return config.gatewayUrl === this.credentialOrigin ? this.serverCredential : "";
  }
  async registrationTicket(device) {
    const config = await this.settings.current(), credential = this.identityFor(config);
    if (!config.gatewayUrl || !credential) return { ticket: null, revision: config.revision };
    let result;
    try {
      result = await this.transport.request(config.gatewayUrl, "/v1/server-tickets", {
        credential, body: { appId: config.appId, serverId: config.serverId, deviceId: device.id },
      });
    } catch { throw Object.assign(Error("Gateway ticket temporarily unavailable"), { status: 503, retryAfter: 60 }); }
    if (result.status !== 200) throw Object.assign(Error("Gateway server ticket rejected"), {
      status: result.status === 429 ? 429 : result.status >= 500 ? 503 : 403,
      retryAfter: /^\d+$/.test(String(result.retryAfter)) ? Math.max(1, Math.min(86400, Number(result.retryAfter))) : 60,
    });
    if (config.revision !== (await this.settings.current()).revision)
      throw Object.assign(Error("Push gateway changed"), { status: 409 });
    if (typeof result.body?.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.body.ticket))
      throw Object.assign(Error("Invalid gateway ticket response"), { status: 503, retryAfter: 60 });
    return { ticket: result.body.ticket, expiresAt: result.body.expiresAt, revision: config.revision };
  }
  async call(path, device, credential, kind = "sync", encryptedNotification) {
    const config = await this.settings.current();
    if (!config.gatewayUrl) return { status: 0 };
    try {
      const result = await this.transport.request(config.gatewayUrl, path, {
        credential,
        serverCredential: this.identityFor(config),
        body: {
          appId: config.appId,
          deviceId: device.id,
          serverId: config.serverId,
          kind: kind === "new_mail" ? "encrypted_alert" : kind,
          ...(encryptedNotification ? { encryptedNotification } : {}),
        },
      });
      return { status: result.status, reason: result.body?.reason, retryAfter: result.retryAfter };
    } catch {
      return { status: 0 };
    }
  }
  send(device, credential, kind = "sync", encryptedNotification) {
    return this.call("/v1/notify", device, credential, kind, encryptedNotification);
  }
  validate(device, credential, kind = "sync") {
    return this.call("/v1/validate", device, credential, kind);
  }
  async health() {
    try {
      return await this.transport.request(
        (await this.settings.current()).gatewayUrl,
        "/v1/status?appId=" +
          encodeURIComponent((await this.settings.current()).appId),
      );
    } catch {
      return { status: 0 };
    }
  }
  close() {
    this.transport.close();
  }
}
