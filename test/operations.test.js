import test from 'node:test';
import assert from 'node:assert/strict';
import { Operations, businessHealth } from '../src/operations.js';
import { createTestDatabase } from './helpers.mjs';

test('request diagnostics exclude probes/admin traffic, expire, and retain no private paths', () => {
  let now = 6000000;
  const monitor = new Operations({ now: () => now });
  for (const path of ['/healthz','/api/admin/health','/']) monitor.record({ path, method:'GET',status:500,duration:5 });
  assert.equal(monitor.snapshot().requests, 0);
  monitor.record({ path:'/api/accounts/private-email/messages/secret-id?password=secret',method:'GET',status:502,duration:120 });
  monitor.record({ path:'/api/outbox/private-id',method:'POST',status:200,duration:80,aborted:true });
  assert.equal(monitor.snapshot().requests,2);
  assert.equal(monitor.snapshot().errors,1);
  assert.equal(monitor.snapshot().aborted,1);
  assert.equal(monitor.snapshot().averageMs,100);
  assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /private|secret|password/);
  for(let i=0;i<100;i++) monitor.record({path:'/api/login',method:'POST',status:500,duration:1});
  assert.equal(monitor.snapshot().recent.length,50);
  now += 3600000;
  assert.equal(monitor.snapshot().requests,0);
  assert.equal(monitor.snapshot().recent.length,0);
});

test('business summary excludes inactive watchers and expired jobs; backoff is not overdue', async () => {
  const db = await createTestDatabase(), now=Date.now();
  try {
    await db.exec(`INSERT INTO users VALUES('u','secret@example.com','hash','user',1),('off','off@example.com','hash','user',0);
      INSERT INTO accounts VALUES('a','u','private@example.com','proxy','imap.example.com',993,'smtp.example.com',465,'secret',1),
        ('b','u','disabled@example.com','proxy','imap.example.com',993,'smtp.example.com',465,'secret',0),
        ('c','off','inactive@example.com','proxy','imap.example.com',993,'smtp.example.com',465,'secret',1);`);
    for (const [id,next,expires,attempts] of [['future',now+60000,now+86400000,1],['due',now-120000,now+86400000,0],['expired',now-900000,now-1,2]]) {
      await db.prepare("INSERT INTO client_devices(id,user_id,name,platform,created,push_credential,push_error) VALUES(?,'u','private phone','ios',?,'secret','retry_exhausted')").run(id,now);
      await db.prepare("INSERT INTO sessions VALUES(?,'u',?,'private session',?)").run(id,id,now+86400000);
      await db.prepare('INSERT INTO device_sessions VALUES(?,?)').run(id,id);
      await db.prepare('INSERT INTO push_jobs(device_id,next_at,expires,attempts) VALUES(?,?,?,?)').run(id,next,expires,attempts);
    }
    for(const [id,state,result,at] of [['unknown','unknown',null,now],['partial','partial','{"sentCopy":"failed"}',now],['pending','sent','{"sentCopy":"pending"}',now],['old','failed',null,now-86400001]])
      await db.prepare("INSERT INTO outbox VALUES(?,'u','a',?,'digest',?,?,?)").run(id,id,state,result,at);
    const mail = { state:()=>({connectionStatus:'reconnecting',disconnectedSince:now-360000}) };
    const push = {settings:{current:async()=>({gatewayUrl:'https://gateway.example.com'})}};
    const value = await businessHealth(db,mail,push,now);
    assert.deepEqual(value.listeners,{expected:1,connected:0,connecting:0,reconnecting:1,missing:0,prolonged:1});
    assert.equal(value.outgoing.failed,0);
    assert.equal(value.outgoing.unknown,1);
    assert.equal(value.outgoing.partial,1);
    assert.equal(value.outgoing.copy_issues,1);
    assert.equal(value.notification.pending,2);
    assert.equal(value.notification.retrying,1);
    assert.equal(value.notification.overdue,1);
    assert.equal(value.notification.overdueSeconds,120);
    assert.doesNotMatch(JSON.stringify(value), /private|secret|example.com/);
    push.settings.current=async()=>({gatewayUrl:''});
    assert.equal((await businessHealth(db,mail,push,now)).notification.pending,0);
  } finally { await db.close(); }
});
