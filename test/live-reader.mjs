import { cleanupTestDatabases, createTestApp as createApp } from "./helpers.mjs";
import nodemailer from "nodemailer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "mohua-read-live-"));
const app = await createApp({ dataDir: dir, setupToken: "live-test" });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + app.server.address().port;
let bearer = "";
async function api(path, method = "GET", body) {
  const r = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Error(path + " HTTP " + r.status + " " + (await r.text()));
  return r;
}
try {
  const test = await nodemailer.createTestAccount();
  const smtp = nodemailer.createTransport({
    ...test.smtp,
    auth: { user: test.user, pass: test.pass },
    requireTLS: true,
  });
  await smtp.sendMail({
    from: test.user,
    to: test.user,
    subject: "Mohua reader integration",
    text: "read integration marker",
    attachments: [{ filename: "test.txt", content: "mohua attachment marker" }],
  });
  smtp.close();
  await api("/setup", "POST", {
    email: "test@example.com",
    password: "Temporary-test-password",
    setupToken: "live-test",
  });
  bearer = (
    await (
      await api("/login", "POST", {
        email: "test@example.com",
        password: "Temporary-test-password",
      })
    ).json()
  ).token;
  const invite = (await (await api("/admin/invites", "POST", {})).json()).invite;
  await api("/register", "POST", {
    email: "reader@example.com",
    password: "Temporary-test-password",
    invite,
  });
  bearer = (
    await (
      await api("/client/login", "POST", {
        email: "reader@example.com",
        password: "Temporary-test-password",
        deviceName: "Live test",
      })
    ).json()
  ).token;
  const account = await (
    await api("/accounts", "POST", {
      email: test.user,
      mode: "proxy",
      imapHost: "imap.ethereal.email",
      smtpHost: "smtp.ethereal.email",
      smtpPort: 587,
      credential: test.pass,
    })
  ).json();
  const prefix = "/accounts/" + account.id;
  const folders = await (await api(prefix + "/folders")).json();
  assert.ok(folders.some((f) => f.path === "INBOX"));
  const list = await (await api(prefix + "/messages")).json();
  assert.ok(list.items.length);
  const path = prefix + "/messages/" + list.items[0].uid,
    q = "?uidValidity=" + list.uidValidity;
  const message = await (await api(path + q)).json();
  assert.ok(message.body);
  assert.match(await (await api(path + "/body" + q)).text(), /read integration marker/);
  await api(path + "/actions" + q, "POST", { action: "read" });
  const updated = await (await api(prefix + "/messages")).json();
  assert.ok(updated.items.find((m) => m.uid === list.items[0].uid).flags.includes("\\Seen"));
  const bytes = await (await api(path + "/attachments/0" + q)).text();
  assert.match(bytes, /mohua attachment marker/);
  const preparedResponse = await fetch(base + "/api" + prefix + "/outbox", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/json",
      "Idempotency-Key": "live-sender",
    },
    body: JSON.stringify({
      to: [test.user],
      subject: "Mohua outgoing API",
      text: "outgoing stream marker",
      sentCopy: "provider",
      attachments: [{ filename: "outgoing.txt", size: 8 }],
    }),
  });
  assert.equal(preparedResponse.status, 201);
  const prepared = await preparedResponse.json();
  const sendResponse = await fetch(base + "/api/outbox/" + prepared.id, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/octet-stream",
    },
    body: "outgoing",
  });
  const result = await sendResponse.json();
  assert.equal(result.state, "sent", JSON.stringify(result));
  const sentList = await (await api(prefix + "/messages")).json();
  const outgoing = sentList.items.find((m) => m.subject === "Mohua outgoing API");
  assert.ok(outgoing);
  const sentPath = prefix + "/messages/" + outgoing.uid + "/",
    sentQuery = "?uidValidity=" + sentList.uidValidity;
  assert.match(await (await api(sentPath + "body" + sentQuery)).text(), /outgoing stream marker/);
  assert.equal(await (await api(sentPath + "attachments/0" + sentQuery)).text(), "outgoing");
  console.log(
    "LIVE PASS: authenticated read, body/attachment streams, flags, SMTP send and received attachment verified in isolated Ethereal sandbox",
  );
} finally {
  await app.close();
  await cleanupTestDatabases();
  rmSync(dir, { recursive: true, force: true });
}
