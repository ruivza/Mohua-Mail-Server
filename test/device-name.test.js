import { test } from "node:test";
import assert from "node:assert/strict";
import { browserDeviceName, iosDeviceName } from "../src/device-name.js";

test("browser labels identify browser and OS without retaining raw user-agent", () => {
  for (const [ua, expected] of [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1", "Safari · macOS"],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0", "Edge · Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) CriOS/140.0 Safari/604.1", "Chrome · iOS"],
    ["Mozilla/5.0 (iPad; CPU OS 18_0) FxiOS/140.0 Safari/604.1", "Firefox · iPadOS"],
    ["Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Safari/537.36", "Chrome · Android"],
    ["Firefox/140.0 (Linux)", "Firefox · Linux"],
    [undefined, "浏览器"], ["<script>\nprivate name</script>", "浏览器"],
  ]) assert.equal(browserDeviceName(ua), expected);
});

test("native labels validate model and version and support older clients", () => {
  assert.equal(iosDeviceName({model: "iPhone", systemVersion: "27.0"}), "iPhone · iOS 27.0");
  assert.equal(iosDeviceName({model: "iPad", systemVersion: "26.1.2"}), "iPad · iPadOS 26.1.2");
  assert.equal(iosDeviceName(), "iOS 设备");
  assert.equal(iosDeviceName({model: "Private name", systemVersion: "<script>"}), "iOS 设备");
});
