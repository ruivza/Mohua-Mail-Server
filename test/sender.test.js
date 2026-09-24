import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers.mjs";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import { MailSender, validateSend, uploadParts } from "../src/sender.js";
const input = {
  to: ["to@example.com"],
  cc: [],
  bcc: ["hidden@example.com"],
  subject: "Hello",
  text: "Message body",
  sentCopy: "provider",
  attachments: [
    { filename: "one.txt", size: 3 },
    { filename: "two.txt", size: 4 },
  ],
};
async function fixture() {
  const db = await createTestDatabase();
  let sent = 0,
    raw,
    options,
    copy;
  const client = {
    list: async () => [{ path: "Sent", specialUse: "\\Sent" }],
    append: async (path, bytes) => {
      copy = bytes;
      return { uid: 1 };
    },
    close() {},
    connect: async () => {},
    fetchOne: async () => ({
      size: 20,
      envelope: {
        messageId: "<original@example.com>",
        inReplyTo: "<root@example.com>",
      },
    }),
    download: async () => ({
      content: Readable.from(["Subject: original\r\n\r\nforwarded original"]),
    }),
  };
  const mail = {
    resolveHost: async () => "1.1.1.1",
    decrypt: () => "secret",
    password: () => "secret",
    imap: async (a, j) => {
      j.client = client;
      return client;
    },
    smtpFactory: (o) => {
      options = o;
      return {
        verify: async () => {},
        close() {},
        sendMail: async (message) => {
          sent++;
          const chunks = [];
          for await (const chunk of message.raw) chunks.push(chunk);
          raw = Buffer.concat(chunks);
          return {
            accepted: ["to@example.com", "hidden@example.com"],
            rejected: [],
          };
        },
      };
    },
  };
  const reader = { execute: async (a, o, fn) => fn(client) };
  const sender = new MailSender({ db, mail, reader });
  await sender.initialize();
  return {
    db,
    sender,
    client,
    mail,
    account: {
      id: "a",
      email: "me@example.com",
      mode: "proxy",
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      credential: "encrypted",
    },
    get sent() {
      return sent;
    },
    get raw() {
      return raw;
    },
    get copy() {
      return copy;
    },
    get options() {
      return options;
    },
    async close() {
      await sender.close();
      await db.close();
    },
  };
}
test("stream two attachments, omit Bcc header, pin TLS and deduplicate submissions", async () => {
  const f = await fixture();
  try {
    const p = await f.sender.prepare(f.account, "u", "same", input);
    assert.equal(
      (await f.sender.prepare(f.account, "u", "same", input)).id,
      p.id,
    );
    await assert.rejects(
      async () =>
        await f.sender.prepare(f.account, "u", "same", {
          ...input,
          subject: "different",
        }),
      { status: 409 },
    );
    await assert.rejects(async () => await f.sender.status(p.id, "other"), {
      status: 404,
    });
    const r = await f.sender.submit(
      p.id,
      "u",
      Readable.from(["ab", "cdefg"]),
      () => {},
    );
    assert.equal(r.state, "sent");
    const parsed = await simpleParser(f.raw);
    assert.equal(parsed.text.trim(), "Message body");
    assert.deepEqual(
      parsed.attachments.map((a) => a.content.toString()),
      ["abc", "defg"],
    );
    assert.equal(parsed.bcc, undefined);
    assert.equal(f.options.host, "1.1.1.1");
    assert.equal(f.options.tls.servername, "smtp.example.com");
    await f.sender.submit(p.id, "u", Readable.from([]), () => {});
    assert.equal(f.sent, 1);
  } finally {
    await f.close();
  }
});
test("reply threading, forward original and exact sent copy", async () => {
  const f = await fixture();
  try {
    for (const kind of ["reply", "forward"]) {
      const p = await f.sender.prepare(f.account, "u", kind, {
        ...input,
        attachments: [],
        sentCopy: "append",
        source: { kind, uid: 1, folder: "INBOX", uidValidity: "7" },
      });
      const r = await f.sender.submit(p.id, "u", Readable.from([]), () => {});
      assert.equal(r.sentCopy, "saved");
      assert.deepEqual(f.copy, f.raw);
      const parsed = await simpleParser(f.raw);
      if (kind === "reply") {
        assert.equal(parsed.inReplyTo, "<original@example.com>");
        assert.deepEqual(parsed.references, [
          "<root@example.com>",
          "<original@example.com>",
        ]);
      } else
        assert.match(
          parsed.attachments[0].content.toString(),
          /forwarded original/,
        );
    }
  } finally {
    await f.close();
  }
});
test("ambiguous SMTP failure is never automatically resent; copy failure remains sent", async () => {
  const f = await fixture();
  try {
    f.client.append = async () => {
      throw Error("lost response");
    };
    let p = await f.sender.prepare(f.account, "u", "copy", {
      ...input,
      attachments: [],
      sentCopy: "append",
    });
    let r = await f.sender.submit(p.id, "u", Readable.from([]), () => {});
    assert.equal(r.state, "sent");
    assert.equal(r.sentCopy, "failed_or_unknown");
    f.mail.smtpFactory = () => ({
      verify: async () => {},
      close() {},
      sendMail: async () => {
        throw Error("lost connection");
      },
    });
    p = await f.sender.prepare(f.account, "u", "unknown", {
      ...input,
      attachments: [],
    });
    r = await f.sender.submit(p.id, "u", Readable.from([]), () => {});
    assert.equal(r.state, "unknown");
    assert.equal(
      (await f.sender.submit(p.id, "u", Readable.from([]), () => {})).state,
      "unknown",
    );
  } finally {
    await f.close();
  }
});
test("validation and exact upload framing reject malformed or oversized requests", async () => {
  assert.throws(
    () =>
      validateSend({
        ...input,
        to: ["a@example.com\r\nBcc: evil@example.com"],
      }),
    { status: 400 },
  );
  assert.throws(
    () =>
      validateSend({
        ...input,
        attachments: [{ filename: "large", size: 26 * 1024 * 1024 }],
      }),
    { status: 413 },
  );
  const p = uploadParts(Readable.from(["xx"]), [{ filename: "a", size: 3 }]);
  await assert.rejects(
    async () => {
      for await (const c of p.parts[0].content) {
      }
    },
    { status: 400 },
  );
  const q = uploadParts(Readable.from(["xx"]), []);
  await assert.rejects(q.finish(), { status: 400 });
});
test("restart marks in-flight sends uncertain and expires prepared content", async () => {
  const f = await fixture();
  try {
    const p = await f.sender.prepare(f.account, "u", "restart", input);
    await f.db
      .prepare("UPDATE outbox SET state='sending' WHERE id=?")
      .run(p.id);
    await f.sender.close();
    const next = new MailSender({ mail: f.mail, reader: {}, db: f.db });
    await next.initialize();
    assert.equal((await next.status(p.id, "u")).state, "unknown");
    await next.close();
  } finally {
    await f.db.close();
  }
});

test("revocation blocks submission, partial acceptance stays partial and failed uploads are uncertain", async () => {
  const f = await fixture();
  try {
    let p = await f.sender.prepare(f.account, "u", "revoke", input);
    await assert.rejects(
      f.sender.submit(p.id, "u", Readable.from([]), () => {
        throw Object.assign(Error("revoked"), { status: 401 });
      }),
      { status: 401 },
    );
    assert.equal(f.sent, 0);
    p = await f.sender.prepare(f.account, "u", "short", input);
    const r = await f.sender.submit(p.id, "u", Readable.from(["x"]), () => {});
    assert.equal(r.state, "unknown");
    f.mail.smtpFactory = () => ({
      verify: async () => {},
      close() {},
      sendMail: async (m) => {
        for await (const chunk of m.raw) {
        }
        return {
          accepted: ["to@example.com"],
          rejected: ["hidden@example.com"],
        };
      },
    });
    p = await f.sender.prepare(f.account, "u", "partial", {
      ...input,
      attachments: [],
    });
    assert.equal(
      (await f.sender.submit(p.id, "u", Readable.from([]), () => {})).state,
      "partial",
    );
  } finally {
    await f.close();
  }
});

test("concurrent prepare is idempotent and simultaneous uploads cannot send twice", async () => {
  const f = await fixture();
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    ready = new Promise((r) => (entered = r));
  try {
    const prepared = await Promise.all(
      Array.from({ length: 6 }, () =>
        f.sender.prepare(f.account, "u", "concurrent", {
          ...input,
          attachments: [],
        }),
      ),
    );
    assert.equal(new Set(prepared.map((p) => p.id)).size, 1);
    const sending = f.sender.submit(
      prepared[0].id,
      "u",
      Readable.from([]),
      async () => {
        entered();
        await gate;
      },
    );
    await ready;
    await assert.rejects(
      f.sender.submit(prepared[0].id, "u", Readable.from([]), () => {}),
      { status: 429 },
    );
    release();
    assert.equal((await sending).state, "sent");
    assert.equal(f.sent, 1);
  } finally {
    release?.();
    await f.close();
  }
});
