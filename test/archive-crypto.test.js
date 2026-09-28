import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { ArchiveCrypto } from '../src/archive-crypto.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'mohua-compression-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return new ArchiveCrypto(join(dir,'key'));
}
function legacy(crypto,plain,context,header=Buffer.alloc(0)) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',crypto.key(),iv);
  cipher.setAAD(Buffer.concat([Buffer.from(context),header]));
  return Buffer.concat([header,iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]).toString('base64');
}
test('mail content compresses losslessly and survives key reload',t=>{
  const crypto=fixture(t),plain=Buffer.from('<p>中文正文与完整邮件 MIME 内容</p>\r\n'.repeat(1200));
  for(const context of ['metadata:account','chunk:a:m:raw:0','chunk:a:m:body:0','draft:a:d:r:0','draft-file:a:d:r:f:0']) {
    const sealed=crypto.seal(plain,context);
    assert.ok(Buffer.from(sealed,'base64').length < plain.length/2);
    assert.deepEqual(new ArchiveCrypto(crypto.path).open(sealed,context),plain);
    assert.throws(()=>crypto.open(sealed,context+'other'));
  }
});
test('random data, short data and credentials keep legacy representation',t=>{
  const crypto=fixture(t);
  for(const [plain,context] of [[randomBytes(65536),'chunk:a:m:raw:0'],[Buffer.from('short'),'metadata:a'],[Buffer.alloc(4096,65),'credential:a'],[Buffer.alloc(0),'chunk:a:m:body:0']]) {
    const sealed=crypto.seal(plain,context);
    assert.equal(Buffer.from(sealed,'base64').length,plain.length+28);
    assert.deepEqual(crypto.open(sealed,context),plain);
  }
});
test('pre-compression mail ciphertext remains readable byte for byte',t=>{
  const crypto=fixture(t),plain=randomBytes(65536),context='chunk:a:m:raw:0';
  assert.deepEqual(crypto.open(legacy(crypto,plain,context),context),plain);
});
test('compressed envelope header and ciphertext tampering are rejected',t=>{
  const crypto=fixture(t),context='chunk:a:m:raw:0',bytes=Buffer.from(crypto.seal(Buffer.alloc(65536,65),context),'base64');
  for(const index of [0,16,17,18,21,22,35,bytes.length-1]) {
    const changed=Buffer.from(bytes);changed[index]^=1;
    assert.throws(()=>crypto.open(changed.toString('base64'),context));
  }
  assert.throws(()=>crypto.open(bytes.subarray(0,20).toString('base64'),context));
});
test('authenticated malformed frames cannot exceed the declared expansion bound',t=>{
  const crypto=fixture(t),context='chunk:a:m:raw:0';
  function frame(length,version=1,codec=1) {
    const header=Buffer.alloc(22);Buffer.from('MohuaZstdStore!01').copy(header);
    header[16]=version;header[17]=codec;header.writeUInt32BE(length,18);
    return legacy(crypto,zstdCompressSync(Buffer.alloc(65536,65)),context,header);
  }
  for(const value of [frame(1024),frame(65537),frame(0),frame(1024*1024+1),frame(65536,2),frame(65536,1,2)]) {
    assert.throws(()=>crypto.open(value,context));
  }
});
