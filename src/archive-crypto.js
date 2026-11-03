import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

// Distinguishes the versioned envelope from legacy random-IV ciphertext.
const magic = Buffer.from("MohuaZstdStore!01");
const headerSize = magic.length + 6;
const maxPlaintext = 1024 * 1024;
const contentContext = /^(metadata|chunk|draft|draft-file):/;

// The isolated worker owns this key; the control service stores ciphertext only.
export class ArchiveCrypto {
  constructor(path) {
    this.path = path;
  }
  key(create = true) {
    if (!this.material) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (!existsSync(this.path) && !create)
        throw Error("Restore the sync encryption key to read saved mail");
      if (!existsSync(this.path))
        writeFileSync(this.path, randomBytes(32), { flag: "wx", mode: 0o600 });
      this.material = readFileSync(this.path);
      if (this.material.length !== 32) throw Error("Invalid sync encryption key");
    }
    return this.material;
  }
  seal(value, context) {
    let header = Buffer.alloc(0);
    if (contentContext.test(context) && value.length >= 256 && value.length <= maxPlaintext) {
      const compressed = zstdCompressSync(value, {
        params: { [constants.ZSTD_c_compressionLevel]: 3 },
      });
      // Include the envelope overhead when deciding whether compression pays off.
      if (compressed.length + headerSize < value.length) {
        header = Buffer.alloc(headerSize);
        magic.copy(header);
        header[magic.length] = 1;
        header[magic.length + 1] = 1;
        header.writeUInt32BE(value.length, magic.length + 2);
        value = compressed;
      }
    }
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key(), iv);
    c.setAAD(Buffer.concat([Buffer.from(context), header]));
    return Buffer.concat([header, iv, c.update(value), c.final(), c.getAuthTag()]).toString(
      "base64",
    );
  }
  open(value, context) {
    const bytes = Buffer.from(value, "base64");
    const versioned = bytes.subarray(0, magic.length).equals(magic);
    const header = versioned ? bytes.subarray(0, headerSize) : Buffer.alloc(0);
    if (bytes.length < header.length + 28) throw Error("Invalid saved mail envelope");
    const b = bytes.subarray(header.length),
      c = createDecipheriv("aes-256-gcm", this.key(false), b.subarray(0, 12));
    c.setAAD(Buffer.concat([Buffer.from(context), header]));
    c.setAuthTag(b.subarray(-16));
    const plain = Buffer.concat([c.update(b.subarray(12, -16)), c.final()]);
    if (!versioned) return plain;
    // Authenticate before interpreting the format or decompressing untrusted bytes.
    if (header[magic.length] !== 1 || header[magic.length + 1] !== 1)
      throw Error("Unsupported saved mail compression");
    const length = header.readUInt32BE(magic.length + 2);
    if (!length || length > maxPlaintext) throw Error("Invalid saved mail size");
    const result = zstdDecompressSync(plain, { maxOutputLength: length });
    if (result.length !== length) throw Error("Saved mail size mismatch");
    return result;
  }
}
