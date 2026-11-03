import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "docs/SERVER_README.md",
  "docs/CLIENT_CREDENTIAL_LEASES.md",
  "docs/MAIL_PROCESS_ISOLATION.md",
  ...readdirSync(resolve(root, "test"))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => "test/" + name),
];
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of files) cpSync(resolve(root, file), resolve(target, file), { recursive: true });
// The bundle README sits at the root while the other docs keep their docs/ paths.
writeFileSync(
  resolve(target, "README.md"),
  readFileSync(resolve(root, "docs/SERVER_README.md"), "utf8")
    .replaceAll("../SYNC_MODE_ZH.md", "SYNC_MODE_ZH.md")
    .replaceAll("(CLIENT_CREDENTIAL_LEASES.md)", "(docs/CLIENT_CREDENTIAL_LEASES.md)")
    .replaceAll("(MAIL_PROCESS_ISOLATION.md)", "(docs/MAIL_PROCESS_ISOLATION.md)"),
);
console.log("Open-source server files exported to dist/mohua-server/");
