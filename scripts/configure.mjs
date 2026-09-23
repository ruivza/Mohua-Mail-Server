import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const path = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(path)) {
  console.log(".env already exists; kept existing configuration.");
} else {
  writeFileSync(
    path,
    `# Generated locally. Do not commit or share this file.\nPOSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\nSETUP_TOKEN=${randomBytes(32).toString("hex")}\nMOHUA_BIND_ADDRESS=127.0.0.1\nMOHUA_PORT=3210\nOFFICIAL_PUSH_GATEWAY_URL=\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created .env with independent random database password and first-admin setup token.",
  );
}
