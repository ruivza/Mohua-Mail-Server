import { randomBytes } from "node:crypto";

// Shared input validators. Each returns a boolean; callers decide the status and message.
export const UUID = /^[a-f0-9-]{36}$/i;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAIL_HOST = /^[a-zA-Z0-9.-]+$/;
export const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const isUuid = (value) => typeof value === "string" && UUID.test(value);
export const text = (value, max = 512) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
export const integer = (value, max = 4294967295) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
export const encrypted = (value, max = 100000) => text(value, max) && BASE64.test(value);

// Display text that may reach notifications or logs: drop control and bidi override characters,
// then bound the length in code points rather than UTF-16 units.
export const clean = (value, limit) =>
  Array.from(
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .trim(),
  )
    .slice(0, limit)
    .join("");

// Archive folders carry their own UIDVALIDITY, independent of the provider's.
export const newValidity = () => (BigInt("0x" + randomBytes(8).toString("hex")) + 1n).toString();
