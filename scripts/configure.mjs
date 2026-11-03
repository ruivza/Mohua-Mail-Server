import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const path = fileURLToPath(new URL("../.env", import.meta.url));
const secret = () => randomBytes(32).toString("hex");
// Keep in step with .env.example. Secrets are generated here and never printed; the other
// variables get their documented defaults (an empty value means unset, see compose.yaml).
const secrets = ["POSTGRES_PASSWORD", "SETUP_TOKEN", "MAIL_BROKER_TOKEN"];
const defaults = [
  ["MOHUA_BIND_ADDRESS", "127.0.0.1"],
  ["MOHUA_PORT", "3210"],
  ["OFFICIAL_PUSH_GATEWAY_URL", ""],
  ["PUSH_GATEWAY_APP_ID", "mohua"],
  ["TRUSTED_PROXY_HOPS", "1"],
  ["GATEWAY_SERVER_CREDENTIAL", ""],
  ["GATEWAY_SERVER_CREDENTIAL_URL", ""],
];
if (existsSync(path)) {
  const text = readFileSync(path, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // A variable assigned on an uncommented line is kept as is, even when empty.
  const assigned = (key) => new RegExp(`^[ \t]*(?:export[ \t]+)?${key}[ \t]*=`, "m").test(text);
  const added = [];
  // An empty broker token is replaced as before; existing database and setup secrets are
  // never generated again because the database volume already depends on them.
  if (!/^MAIL_BROKER_TOKEN=.+$/m.test(text)) added.push(["MAIL_BROKER_TOKEN", secret()]);
  for (const entry of defaults) if (!assigned(entry[0])) added.push(entry);
  if (added.length) {
    const lines = added.map(([key, value]) => `${key}=${value}${eol}`).join("");
    appendFileSync(path, (text && !text.endsWith("\n") ? eol : "") + lines);
    console.log(
      `Added missing settings to .env: ${added.map(([key]) => key).join(", ")}. Existing configuration preserved.`,
    );
  } else console.log(".env already exists; kept existing configuration.");
} else {
  const lines = [...secrets.map((key) => [key, secret()]), ...defaults].map(
    ([key, value]) => `${key}=${value}\n`,
  );
  writeFileSync(
    path,
    "# Generated locally. Do not commit or share this file. See .env.example for each variable.\n" +
      lines.join(""),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created .env with independent random database password, first-admin setup token and mail broker token.",
  );
}
