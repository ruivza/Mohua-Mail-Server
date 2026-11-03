import {
  createECDH,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  createCipheriv,
} from "node:crypto";
import { clean as sanitize } from "./validate.js";
import { DAY } from "./limits.js";
import { fail } from "./errors.js";
export const notificationAlgorithm = "p256-hkdf-sha256-aes256gcm-v1";
const invalidKey = () => fail(400, "Invalid notification public key");
export function notificationKey(input) {
  if (
    !input ||
    input.algorithm !== notificationAlgorithm ||
    typeof input.publicKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.keyId)
  )
    invalidKey();
  const bytes = Buffer.from(input.publicKey, "base64");
  if (
    bytes.length !== 65 ||
    bytes[0] !== 4 ||
    bytes.toString("base64") !== input.publicKey ||
    createHash("sha256").update(bytes).digest("hex") !== input.keyId
  )
    invalidKey();
  try {
    const check = createECDH("prime256v1");
    check.generateKeys();
    check.computeSecret(bytes);
  } catch {
    invalidKey();
  }
  return { algorithm: notificationAlgorithm, keyId: input.keyId, publicKey: input.publicKey };
}
export function notificationAAD(scope, envelope) {
  return Buffer.from(
    [
      "mohua-notification-v1",
      scope.appId,
      scope.deviceId,
      scope.serverId,
      envelope.keyId,
      envelope.id,
      String(envelope.expires),
    ].join("\n"),
  );
}
// Non-string details become empty rather than their String() form.
const clean = (value, limit) => (typeof value === "string" ? sanitize(value, limit) : "");
export function encryptNotification(input, details, scope, now = Date.now()) {
  const recipient = notificationKey(input);
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const envelope = {
    version: 1,
    keyId: recipient.keyId,
    id: randomUUID(),
    expires: now + DAY,
    ephemeralKey: ephemeral.getPublicKey().toString("base64"),
  };
  const aad = notificationAAD(scope, envelope);
  const secret = ephemeral.computeSecret(Buffer.from(recipient.publicKey, "base64"));
  const key = Buffer.from(
    hkdfSync("sha256", secret, Buffer.from("mohua-notification-v1"), aad, 32),
  );
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const content = { sender: clean(details.sender, 120), subject: clean(details.subject, 400) };
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(content), "utf8"),
    cipher.final(),
  ]);
  envelope.ciphertext = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
  secret.fill(0);
  key.fill(0);
  return envelope;
}
