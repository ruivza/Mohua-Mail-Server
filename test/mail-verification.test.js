import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  candidateMailbox,
  verifyCandidate,
  verificationReceipt,
  requireVerification,
  verificationKey,
} from "../src/mail-verification.js";
import { credentialAAD } from "../src/credential-leases.js";
function fixture() {
  const id = randomUUID(),
    revision = randomUUID(),
    key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(credentialAAD(id, revision)));
  const ciphertext = Buffer.concat([
    iv,
    cipher.update("synthetic password"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = {
    email: "mail@example.test",
    mode: "proxy",
    imapHost: "imap.example.test",
    smtpHost: "smtp.example.test",
    envelope: { revision, ciphertext },
  };
  return {
    a: candidateMailbox(id, body),
    body,
    authorization: { revision, ciphertext, key: key.toString("base64") },
  };
}
test("verification receipts bind settings, envelope, session and expiry", () => {
  const { a } = fixture(),
    key = randomBytes(32),
    ticket = verificationReceipt(key, "session", a, 1000);
  assert.doesNotThrow(() => requireVerification(key, "session", a, ticket, 2000));
  for (const [session, account, receipt, now] of [
    ["other", a, ticket, 2000],
    ["session", { ...a, smtp_host: "other.test" }, ticket, 2000],
    ["session", { ...a, credential: "different" }, ticket, 2000],
    ["session", a, ticket, 301000],
    ["session", a, undefined, 2000],
  ]) {
    assert.throws(
      () => requireVerification(key, session, account, receipt, now),
      (e) => e.status === 422,
    );
  }
});
test("provider authentication and timeout failures remain actionable and never reveal secrets", async () => {
  const { a, authorization } = fixture();
  for (const [failure, message] of [
    [{ authenticationFailed: true }, "Mailbox authentication failed"],
    [{ code: "EAUTH" }, "Mailbox authentication failed"],
    [{ code: "ETIMEDOUT" }, "Mailbox connection timed out"],
    [{}, "Mailbox connection failed"],
  ]) {
    class Client extends EventEmitter {
      async connect() {
        throw Object.assign(Error("synthetic password"), failure);
      }
      close() {}
    }
    await assert.rejects(
      verifyCandidate(a, authorization, {
        resolveHost: async () => "1.1.1.1",
        imapFactory: () => new Client(),
      }),
      (e) => e.status === 422 && e.message === message,
    );
  }
});
test("verification checks IMAP and SMTP and closes both transports", async () => {
  const { a, authorization } = fixture();
  let imap = false,
    smtp = false,
    closed = 0;
  class Client extends EventEmitter {
    async connect() {
      imap = true;
    }
    async mailboxOpen() {}
    async logout() {}
    close() {
      closed++;
    }
  }
  await verifyCandidate(a, authorization, {
    resolveHost: async () => "1.1.1.1",
    imapFactory: () => new Client(),
    smtpFactory: () => ({
      verify: async () => {
        smtp = true;
      },
      close() {
        closed++;
      },
    }),
  });
  assert.equal(imap, true);
  assert.equal(smtp, true);
  assert.equal(closed, 2);
});
test("malformed verification signatures fail validation without throwing a server error", () => {
  const { a } = fixture(),
    key = randomBytes(32),
    ticket = verificationReceipt(key, "session", a, 1000);
  const payload = ticket.split(".")[0];
  for (const signature of ["é".repeat(43), "a".repeat(43), "", "a".repeat(44)]) {
    assert.throws(
      () => requireVerification(key, "session", a, payload + "." + signature, 2000),
      (e) => e.status === 422,
    );
  }
});
test("SMTP rejection after IMAP success cannot produce a verification receipt", async () => {
  const { a, authorization } = fixture();
  let imap = false;
  class Client extends EventEmitter {
    async connect() {
      imap = true;
    }
    async mailboxOpen() {}
    async logout() {}
    close() {}
  }
  await assert.rejects(
    verifyCandidate(a, authorization, {
      resolveHost: async () => "1.1.1.1",
      imapFactory: () => new Client(),
      smtpFactory: () => ({
        verify: async () => {
          throw Object.assign(Error("provider private response"), { code: "EAUTH" });
        },
        close() {},
      }),
    }),
    (e) => e.status === 422 && e.message === "Mailbox authentication failed",
  );
  assert.equal(imap, true);
});
test("receipts are signed with a key derived from the broker token, not with the token itself", () => {
  const token = randomBytes(32).toString("hex"),
    key = verificationKey(token),
    { a } = fixture();
  assert.equal(key.length, 32);
  assert.deepEqual(verificationKey(token), key);
  assert.notDeepEqual(verificationKey(randomBytes(32).toString("hex")), key);
  assert.doesNotThrow(() =>
    requireVerification(
      key,
      "session",
      a,
      verificationReceipt(verificationKey(token), "session", a, 1000),
      2000,
    ),
  );
  assert.throws(
    () =>
      requireVerification(key, "session", a, verificationReceipt(token, "session", a, 1000), 2000),
    (e) => e.status === 422,
  );
});
