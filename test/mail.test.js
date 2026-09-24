import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { publicAddress, MailService } from "../src/mail.js";

test("reject private, reserved, mapped and mixed DNS results; pin public address", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.2",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "192.0.2.1",
    "224.0.0.1",
  ])
    await assert.rejects(
      publicAddress("mail.example.com", async () => [{ address }]),
    );
  await assert.rejects(
    publicAddress("mail.example.com", async () => [
      { address: "1.1.1.1" },
      { address: "10.0.0.1" },
    ]),
  );
  assert.equal(
    await publicAddress("mail.example.com", async () => [
      { address: "1.1.1.1" },
    ]),
    "1.1.1.1",
  );
});

function fixture(overrides = {}) {
  const account = {
    id: "a",
    email: "mail@example.com",
    credential: "encrypted",
    imap_host: "imap.example.com",
    imap_port: 993,
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    monitor_enabled: 1,
  };
  let client,
    imapOptions,
    smtpOptions,
    verified = false;
  const db = { prepare: () => ({ get: () => account, all: () => [account] }) };
  class Client extends EventEmitter {
    async connect() {}
    async mailboxOpen(path, options) {
      assert.equal(path, "INBOX");
      assert.equal(options.readOnly, true);
      return { exists: 2, uidValidity: 99n };
    }
    async logout() {
      this.close();
    }
    close() {
      this.emit("close");
    }
  }
  const service = new MailService({
    db,
    leases: { assert() {}, password: () => "secret" },
    resolveHost: async () => "1.1.1.1",
    imapFactory: (options) => {
      imapOptions = options;
      return (client = new Client());
    },
    smtpFactory: (options) => {
      smtpOptions = options;
      return {
        verify: async () => {
          verified = true;
        },
        close() {},
      };
    },
    ...overrides,
  });
  return {
    service,
    account,
    get client() {
      return client;
    },
    get imapOptions() {
      return imapOptions;
    },
    get smtpOptions() {
      return smtpOptions;
    },
    get verified() {
      return verified;
    },
  };
}
test("verification pins DNS, checks TLS hostname, authenticates SMTP without sending", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.service.verify(f.account)).connectionStatus,
      "verified",
    );
    assert.equal(f.imapOptions.host, "1.1.1.1");
    assert.equal(f.imapOptions.servername, "imap.example.com");
    assert.equal(f.imapOptions.logger, false);
    assert.equal(f.smtpOptions.tls.servername, "smtp.example.com");
    assert.equal(f.smtpOptions.requireTLS, true);
    assert.equal(f.smtpOptions.secure, false);
    assert.ok(f.verified);
  } finally {
    await f.service.close();
  }
});
test("read-only monitor updates metadata and stops receiving changes after revocation", async () => {
  const f = await fixture();
  await f.service.start(f.account);
  assert.equal(f.service.state("a").connectionStatus, "listening");
  f.client.emit("exists", { count: 3 });
  await Promise.all([...f.service.background]);
  assert.equal(f.service.state("a").messageCount, 3);
  f.service.stop("a");
  f.client.emit("exists", { count: 4 });
  assert.equal(f.service.state("a").messageCount, 3);
  assert.equal(f.service.state("a").connectionStatus, "stopped");
  assert.equal(f.service.jobs.size, 0);
  await f.service.close();
});
test("verification timeout releases job and does not disclose upstream secrets", async () => {
  const f = await fixture({
    timeoutMs: 15,
    resolveHost: () => new Promise(() => {}),
  });
  await assert.rejects(
    f.service.verify(f.account),
    /Mailbox verification failed/,
  );
  assert.equal(f.service.jobs.size, 0);
  await f.service.close();
});
test("connection failures retry and stop cancels pending retries", async () => {
  const f = await fixture({
    resolveHost: async () => {
      throw Error("password secret");
    },
    retryMs: 10000,
  });
  await f.service.start(f.account);
  assert.equal(f.service.state("a").connectionStatus, "reconnecting");
  assert.ok(!JSON.stringify(f.service.state("a")).includes("secret"));
  f.service.stop("a");
  assert.equal(f.service.jobs.size, 0);
  await f.service.close();
});

test("watcher emits only mailbox-level change hints and stops them after stop", async () => {
  const changes = [];
  const f = await fixture({ onChange: (id) => changes.push(id) });
  await f.service.start(f.account);
  for (const event of ["exists", "flags", "expunge"])
    f.client.emit(event, { count: 3, subject: "not forwarded" });
  await Promise.all([...f.service.background]);
  assert.deepEqual(changes, ["a", "a", "a", "a"]);
  f.service.stop("a");
  f.client.emit("exists", { count: 4 });
  assert.equal(changes.length, 4);
  await f.service.close();
});

test("watcher retries after database outage instead of remaining stranded", async () => {
  const f = fixture({retryMs:5});
  try {
    await f.service.start(f.account);
    const active = f.service.active.bind(f.service);
    let attempts=0;
    f.service.active=async id=>{ if(++attempts<=2) throw Error('database unavailable'); return active(id); };
    f.client.close();
    const deadline=Date.now()+1000;
    while(f.service.state('a').connectionStatus!=='listening' && Date.now()<deadline) await new Promise(r=>setTimeout(r,5));
    assert.ok(attempts>=3);
    assert.equal(f.service.state('a').connectionStatus,'listening');
    assert.equal(f.service.state('a').disconnectedSince,null);
  } finally {await f.service.close();}
});

test('stopping a watcher during its initial change callback cannot report listening afterward', async () => {
  let release, entered;
  const waiting = new Promise(resolve => {entered=resolve;});
  const f = fixture({onChange:()=>new Promise(resolve=>{release=resolve;entered();})});
  const starting=f.service.start(f.account);
  try {
    await waiting;
    f.service.stop('a');
    release();
    await starting;
    assert.equal(f.service.state('a').connectionStatus,'stopped');
    assert.equal(f.service.jobs.size,0);
  } finally {release?.();await starting;await f.service.close();}
});


test("only an inbox count increase emits a new mail alert", async () => {
  const kinds = [];
  const f = fixture({ onChange: (id, kind = 'sync') => kinds.push(kind) });
  try {
    await f.service.start(f.account);
    for (const [event, detail] of [
      ['exists', { path: 'INBOX', prevCount: 2, count: 3 }],
      ['flags', { path: 'INBOX' }], ['expunge', { path: 'INBOX' }],
      ['exists', { path: 'INBOX', prevCount: 3, count: 3 }],
      ['exists', { path: 'Sent', prevCount: 2, count: 3 }],
    ]) {
      f.client.emit(event, detail);
      await Promise.all([...f.service.background]);
    }
    assert.deepEqual(kinds, ['sync','new_mail','sync','sync','sync','sync']);
  } finally { await f.service.close(); }
});


test('notification preview fetches envelope only and excludes body', async () => {
  const changes=[]; const f=fixture({needsPreview:async()=>true,onChange:(...args)=>changes.push(args)});
  try {
    await f.service.start(f.account);
    f.client.fetchOne=async(range,query)=>{
      assert.equal(range,'*');assert.deepEqual(query,{envelope:true});
      return {envelope:{from:[{name:'Sender',address:'sender@example.test'}],subject:'Subject'},source:'BODY NOT REQUESTED'};
    };
    f.client.emit('exists',{path:'INBOX',prevCount:2,count:3});
    await Promise.all([...f.service.background]);
    assert.deepEqual(changes.at(-1),['a','new_mail',{sender:'Sender',subject:'Subject'}]);
  } finally {await f.service.close();}
});


test('no preview recipient means no envelope read or plaintext metadata', async () => {
  const changes=[]; const f=fixture({onChange:(...args)=>changes.push(args)});
  let reads=0;
  try {
    await f.service.start(f.account);
    f.client.fetchOne=async()=>{reads++;return {envelope:{subject:'private'}};};
    f.client.emit('exists',{path:'INBOX',prevCount:2,count:3});
    await Promise.all([...f.service.background]);
    assert.equal(reads,0);
    assert.deepEqual(changes.at(-1),['a','new_mail',undefined]);
  } finally {await f.service.close();}
});

test('envelope timeout delivers generic alert before reconnecting', async () => {
  const changes=[]; const f=fixture({timeoutMs:10,needsPreview:async()=>true,onChange:(...args)=>changes.push(args)});
  try {
    await f.service.start(f.account); changes.length=0;
    f.client.fetchOne=()=>new Promise(()=>{});
    f.client.emit('exists',{path:'INBOX',prevCount:2,count:3});
    await Promise.all([...f.service.background]);
    assert.deepEqual(changes,[['a','new_mail',undefined]]);
    assert.equal(f.service.state('a').connectionStatus,'reconnecting');
  } finally {await f.service.close();}
});

test('stopping during envelope read suppresses timeout fallback', async () => {
  const changes=[]; let started;
  const ready=new Promise(resolve=>started=resolve);
  const f=fixture({timeoutMs:10,needsPreview:async()=>true,onChange:(...args)=>changes.push(args)});
  try {
    await f.service.start(f.account); changes.length=0;
    f.client.fetchOne=()=>{started();return new Promise(()=>{});};
    f.client.emit('exists',{path:'INBOX',prevCount:2,count:3});
    await ready; f.service.stop('a');
    await Promise.all([...f.service.background]);
    assert.deepEqual(changes,[]);
  } finally {await f.service.close();}
});


test('preview lookup failure skips content and preserves generic notification', async () => {
  const changes=[];const f=fixture({needsPreview:async()=>{throw Error('unavailable');},onChange:(...args)=>changes.push(args)});
  let reads=0;
  try {
    await f.service.start(f.account);
    f.client.fetchOne=async()=>{reads++;};
    f.client.emit('exists',{path:'INBOX',prevCount:2,count:3});
    await Promise.all([...f.service.background]);
    assert.equal(reads,0);
    assert.deepEqual(changes.at(-1),['a','new_mail',undefined]);
  } finally {await f.service.close();}
});
