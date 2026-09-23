// Explicit, local-only iOS UI fixture. Never opens a real mail connection.
import { passwordHash, hashToken } from "../src/auth.js";
import {
  cleanupTestDatabases,
  createTestApp as createApp,
} from "./helpers.mjs";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { simpleParser } from "mailparser";

let sentMessages = [],
  dropSendResponse = false,
  uncertainSend = false;

let bodyDownloads = {},
  bodyCompleted = {},
  connections = 0,
  slowBody = false;
let htmlMail = false,
  inlineDownloads = 0;
const inlinePNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAYUlEQVR4nO3PsQ0AIAzAsN7N8+UIBgspQ3Zn5ux+HQc0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrw2AUp8zlLqF+7lwAAAABJRU5ErkJggg==",
  "base64",
);
const htmlBody = `<!doctype html><html><body>
  <h2 style="color:#007aff">欢迎阅读 HTML 邮件</h2>
  <p>这是<b>加粗文字</b>与正常排版。</p>
  <table style="border-collapse:collapse;width:100%" cellpadding="10" border="1"><tr><th>项目</th><th>状态</th></tr><tr><td>正文排版</td><td>已完成</td></tr></table>
  <p><img src="cid:logo@fixture" alt="邮件内嵌图片" width="48" height="48"></p>
  <p><a href="https://example.com/mail-details">查看邮件详情</a></p>
  <img src="https://example.invalid/tracker.png" alt="远程图片">
  <script>document.body.innerHTML='SCRIPT_EXECUTED'</script>
  <iframe src="http://localhost:43210/__test/unexpected"></iframe>
  <form action="https://example.invalid/submit"><input placeholder="不应出现的表单"></form>
  </body></html>`;
const dir = mkdtempSync(join(tmpdir(), "mohua-ios-fixture-"));
let offline = false,
  uidNext = 500;
let validity = 7n,
  folders,
  flags,
  cancelledDownloads = 0;
function resetMail() {
  offline = false;
  uidNext = 500;
  sentMessages = [];
  dropSendResponse = false;
  uncertainSend = false;
  bodyDownloads = {};
  bodyCompleted = {};
  slowBody = false;
  htmlMail = false;
  inlineDownloads = 0;
  folders = new Map([
    ["INBOX", [499, 450, 5]],
    ["Archive", []],
    ["Trash", []],
  ]);
  flags = new Map([
    [499, new Set()],
    [450, new Set(["\\Seen"])],
    [5, new Set()],
  ]);
  cancelledDownloads = 0;
}
resetMail();
const envelope = (uid) => ({
  subject: uid === 5 ? "稀疏分页末尾" : "测试邮件 " + uid,
  from: [{ name: "Mohua 测试", address: "fixture@example.com" }],
  replyTo: [{ address: "reply@example.com" }],
  cc: [{ address: "team@example.com" }],
  messageId: `<fixture-${uid}@example.com>`,
  to: [{ address: "proxy@example.com" }],
  date: new Date("2026-09-21T12:00:00Z"),
});
const app = await createApp({
  dataDir: dir,
  mailOptions: {
    resolveHost: async () => "1.1.1.1",
    imapFactory: () => {
      let selected = "INBOX";
      return {
        on() {},
        connect: async () => {
          connections++;
        },
        close() {},
        append: async () => ({ uid: 999 }),
        capabilities: new Set(["MOVE"]),
        list: async () => [
          {
            path: "Sent",
            name: "已发送",
            specialUse: "\\Sent",
            flags: new Set(),
          },
          {
            path: "INBOX",
            name: "收件箱",
            specialUse: "\\Inbox",
            flags: new Set(),
          },
          {
            path: "Archive",
            name: "归档",
            specialUse: "\\Archive",
            flags: new Set(),
          },
          {
            path: "Trash",
            name: "垃圾箱",
            specialUse: "\\Trash",
            flags: new Set(),
          },
        ],
        mailboxOpen: async (folder) => {
          selected = folder;
          return { uidValidity: validity, uidNext };
        },
        fetchAll: async () =>
          (folders.get(selected) || []).map((uid) => ({
            uid,
            size: uid === 499 ? 3 * 1024 * 1024 : 200,
            flags: flags.get(uid),
            envelope: envelope(uid),
          })),
        fetchOne: async (uid) =>
          !(folders.get(selected) || []).includes(Number(uid))
            ? false
            : {
                uid: Number(uid),
                flags: flags.get(Number(uid)),
                envelope: envelope(Number(uid)),
                bodyStructure:
                  htmlMail && Number(uid) === 450
                    ? {
                        type: "multipart/related",
                        childNodes: [
                          { part: "1", type: "text/html" },
                          {
                            part: "4",
                            type: "image/png",
                            id: "<logo@fixture>",
                            disposition: "inline",
                            dispositionParameters: { filename: "logo.png" },
                            size: inlinePNG.length,
                          },
                        ],
                      }
                    : {
                        type: "multipart/mixed",
                        childNodes: [
                          { part: "1", type: "text/plain" },
                          {
                            part: "2",
                            type: "application/octet-stream",
                            disposition: "attachment",
                            dispositionParameters: { filename: "large.bin" },
                            size: 2621440,
                          },
                          {
                            part: "3",
                            type: "text/plain",
                            disposition: "attachment",
                            dispositionParameters: { filename: "note.txt" },
                            size: 12,
                          },
                        ],
                      },
              },
        download: async (uid, part) => ({
          content: Readable.from(
            (async function* () {
              if (part === "1") {
                bodyDownloads[uid] = (bodyDownloads[uid] || 0) + 1;
                if (htmlMail && Number(uid) === 450) {
                  yield Buffer.from(htmlBody);
                  bodyCompleted[uid] = true;
                  return;
                }
                if (Number(uid) !== 499) {
                  yield Buffer.from("你好，这是一封提前同步到本机的邮件。");
                  bodyCompleted[uid] = true;
                  return;
                }
                yield Buffer.from("正文开头验证\n");
                yield Buffer.alloc(4096, 97);
                if (slowBody) await delay(8000);
                for (let i = 0; i < 48; i++) yield Buffer.alloc(65536, 97);
                yield Buffer.from("\n正文末尾验证");
                bodyCompleted[uid] = true;
              } else if (part === undefined) {
                yield Buffer.from(
                  `From: fixture@example.com\r\nSubject: Original fixture\r\nMessage-ID: <fixture-${uid}@example.com>\r\n\r\nOriginal message content`,
                );
              } else if (part === "4") {
                inlineDownloads++;
                yield inlinePNG;
              } else if (part === "2") {
                let complete = false;
                try {
                  for (let i = 0; i < 80; i++) {
                    await delay(200);
                    yield Buffer.alloc(32768, 42);
                  }
                  complete = true;
                } finally {
                  if (!complete) cancelledDownloads++;
                }
              } else {
                yield Buffer.from("hello file!\n");
              }
            })(),
          ),
        }),
        messageFlagsAdd: async (uid, values) => {
          for (const flag of values) flags.get(Number(uid)).add(flag);
          return true;
        },
        messageFlagsRemove: async (uid, values) => {
          for (const flag of values) flags.get(Number(uid)).delete(flag);
          return true;
        },
        messageMove: async (uid, destination) => {
          folders.set(
            selected,
            folders.get(selected).filter((value) => value !== Number(uid)),
          );
          folders.get(destination).push(Number(uid));
          return true;
        },
      };
    },
    smtpFactory: () => ({
      verify: async () => {},
      close() {},
      sendMail: async (message) => {
        const chunks = [];
        for await (const chunk of message.raw) chunks.push(chunk);
        const parsed = await simpleParser(Buffer.concat(chunks));
        sentMessages.push({
          to: message.envelope.to,
          subject: parsed.subject,
          text: parsed.text,
          inReplyTo: parsed.inReplyTo,
          bccHeader: !!parsed.bcc,
          attachments: parsed.attachments.map((a) => ({
            name: a.filename,
            size: a.size,
            text: a.content.toString(),
          })),
        });
        if (uncertainSend) throw Error("Simulated lost SMTP acknowledgment");
        return { accepted: message.envelope.to, rejected: [] };
      },
    }),
  },
});
const key = readFileSync(join(dir, "master.key"));
const iv = randomBytes(12),
  cipher = createCipheriv("aes-256-gcm", key, iv);
const credential = Buffer.concat([
  iv,
  cipher.update("fixture-only"),
  cipher.final(),
  cipher.getAuthTag(),
]).toString("base64");
await app.db
  .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
  .run(
    "fixture-owner",
    "owner@example.com",
    passwordHash("fixture-password-123"),
    "user",
    1,
  );
for (const [id, mode] of [
  ["fixture-proxy", "proxy"],
  ["fixture-direct", "direct"],
]) {
  await app.db
    .prepare(
      "INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      "fixture-owner",
      mode + "@example.com",
      mode,
      "imap.example.com",
      993,
      "smtp.example.com",
      465,
      credential,
    );
}
const handler = app.server.listeners("request")[0];
app.server.removeListener("request", handler);
app.server.on("request", async (req, res) => {
  // Local-only transfer regressions: never routes to a real mailbox.
  if (req.method === "GET" && req.url.startsWith("/__test/download/")) {
    const kind = req.url.split("/").at(-1);
    if (kind === "redirect") { res.writeHead(302, { Location: "/__test/download/ok" }); res.end(); return; }
    if (kind === "denied") { res.writeHead(403); res.end("denied"); return; }
    if (kind === "broken") {
      res.writeHead(200, { "Content-Length": "1000" });
      res.write("partial"); setTimeout(() => res.destroy(), 50); return;
    }
    if (kind === "slow") {
      res.writeHead(200); res.write("partial");
      const timer = setTimeout(() => res.end("done"), 10000);
      res.on("close", () => clearTimeout(timer)); return;
    }
    const data = kind === "large" ? Buffer.alloc(65536) : Buffer.from("complete file");
    res.writeHead(200, { "Content-Length": String(data.length) }); res.end(data); return;
  }
  if (
    dropSendResponse &&
    req.method === "PUT" &&
    req.url.startsWith("/api/outbox/")
  ) {
    dropSendResponse = false;
    res.end = () => {
      res.destroy();
      return res;
    };
  }
  if (!req.url.startsWith("/__test/")) {
    if (offline) {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    return handler(req, res);
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  let result = { ok: true };
  try {
    const latest = async () =>
      (
        await app.db
          .prepare(
            "SELECT id FROM client_devices WHERE revoked IS NULL ORDER BY created DESC LIMIT 1",
          )
          .get()
      )?.id;
    switch (req.url) {
      case "/__test/reset":
        await app.db.prepare("DELETE FROM outbox").run();
        for (const d of await app.devices.list("fixture-owner"))
          await app.devices.revoke("fixture-owner", d.id);
        await app.db
          .prepare("DELETE FROM accounts WHERE id NOT IN (?,?)")
          .run("fixture-proxy", "fixture-direct");
        validity = 7n;
        resetMail();
        await app.db.prepare("DELETE FROM invites").run();
        await app.db
          .prepare("INSERT INTO invites VALUES(?,?)")
          .run(hashToken("fixture-invitation"), Date.now() + 600000);
        break;
      case "/__test/many-messages":
        folders.set("INBOX", Array.from({ length: 55 }, (_, index) => 154 - index));
        flags = new Map(folders.get("INBOX").map(uid => [uid, new Set()]));
        uidNext = 155;
        break;
      case "/__test/second-mailbox":
        await app.db
          .prepare(
            `INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential)
          SELECT 'fixture-second',user_id,'work@example.com',mode,imap_host,imap_port,smtp_host,smtp_port,credential
          FROM accounts WHERE id='fixture-proxy' ON CONFLICT(id) DO NOTHING`,
          )
          .run();
        break;
      case "/__test/offline":
        offline = true;
        break;
      case "/__test/online":
        offline = false;
        break;
      case "/__test/remote-change":
        folders.set("INBOX", [503, 499, 5]);
        folders.set("Archive", [450]);
        flags.set(503, new Set());
        flags.set(499, new Set(["\\Seen", "\\Flagged"]));
        uidNext = 504;
        break;
      case "/__test/new-epoch":
        validity += 1n;
        folders.set("INBOX", [12]);
        flags.set(12, new Set());
        uidNext = 13;
        break;
      case "/__test/slow-body":
        slowBody = true;
        break;
      case "/__test/html-mail":
        htmlMail = true;
        break;
      case "/__test/drop-send-response":
        dropSendResponse = true;
        break;
      case "/__test/uncertain-send":
        uncertainSend = true;
        break;
      case "/__test/uidvalidity":
        validity += 1n;
        break;
      case "/__test/revoke":
        await app.devices.revoke("fixture-owner", await latest());
        break;
      case "/__test/stats":
        result = {
          notificationsEnabled: Boolean(
            (
              await app.db
                .prepare("SELECT push_enabled FROM client_devices WHERE id=?")
                .get(await latest())
            )?.push_enabled,
          ),
          cancelledDownloads,
          sentMessages,
          inlineDownloads,
          bodyDownloads,
          bodyCompleted,
          connections,
          flags: [...(flags.get(499) ?? [])],
          inbox: folders.get("INBOX"),
          archive: folders.get("Archive"),
          trash: folders.get("Trash"),
        };
        break;
      default:
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch {
    res.writeHead(500);
    res.end("{}");
  }
});
app.server.listen(43210, "127.0.0.1", () =>
  console.log("Isolated iOS fixture ready on http://localhost:43210"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    await cleanupTestDatabases();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
