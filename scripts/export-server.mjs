import { cpSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "dist/mohua-server");
// An allowlist makes private code and local secrets impossible to include accidentally.
const files = [
  "src",
  "SYNC_MODE_ZH.md",
  "public",
  "ops/mail-edge.conf",
  "package.json",
  "package-lock.json",
  "Dockerfile",
  "compose.yaml",
  "compose.image.yaml",
  ".github/workflows/docker.yml",
  "compose.test.yaml",
  "scripts/configure.mjs",
  "scripts/remove-legacy-mailboxes.mjs",
  "test/helpers.mjs",
  "start.ps1",
  ".env.example",
  ".dockerignore",
  ".gitignore",
  ".prettierrc",
  ".prettierignore",
  "APNS_SETUP_ZH.md",
  "GATEWAY_PROTOCOL.md",
  "ENCRYPTED_NOTIFICATIONS.md",
  "scripts/export-server.mjs",
  "README.md",
  "docs/SERVER_README.md",
  "docs/CLIENT_CREDENTIAL_LEASES.md",
  "docs/MAIL_PROCESS_ISOLATION.md",
  ...readdirSync(resolve(root, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => "test/" + name),
];
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// The bundle keeps the repository layout, so README.md and its relative links copy unchanged.
for (const file of files) cpSync(resolve(root, file), resolve(target, file), { recursive: true });
console.log("Open-source server files exported to dist/mohua-server/");
