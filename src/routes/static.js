import { readFileSync } from "node:fs";

const CONSOLE_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const ASSETS = {
  "/app.js": "text/javascript",
  "/preferences.js": "text/javascript",
  "/style.css": "text/css",
  "/mohua.jpg": "image/jpeg",
  "/favicon.png": "image/png",
};
// Retired test pages stay explicitly unavailable.
const REMOVED = new Set(["/mail-test", "/device-test", "/mail-test.js", "/device-test.js"]);

// The administration console. Files are read once at startup; an upgrade restarts the process.
export function consoleFiles(root = new URL("../../public/", import.meta.url)) {
  const index = readFileSync(new URL("index.html", root));
  const assets = new Map(
    Object.entries(ASSETS).map(([path, type]) => [
      path,
      { type, data: readFileSync(new URL("." + path, root)) },
    ]),
  );
  // Returns true when the request was answered.
  return (req, res, path, send) => {
    if (REMOVED.has(path)) return send(404, { error: "Not found" });
    if (req.method !== "GET") return false;
    if (path === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": CONSOLE_POLICY,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(index);
      return true;
    }
    const asset = assets.get(path);
    if (!asset) return false;
    res.writeHead(200, {
      "Content-Type": asset.type,
      // Revalidate so an upgraded console never runs a stale script against a new API.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(asset.data);
    return true;
  };
}
