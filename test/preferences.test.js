import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/preferences.js", import.meta.url), "utf8");
function preferences({ saved = {}, locale = "zh-CN", dark = false, blocked = false } = {}) {
  const storage = new Map(Object.entries(saved));
  const media = {
    matches: dark,
    addEventListener(_, fn) {
      this.changed = fn;
    },
  };
  const root = { dataset: {} };
  const context = vm.createContext({
    navigator: { language: locale },
    document: { documentElement: root, querySelector: () => null },
    window: { matchMedia: () => media },
    localStorage: {
      getItem(key) {
        if (blocked) throw Error("Storage blocked");
        return storage.get(key);
      },
      setItem(key, value) {
        if (blocked) throw Error("Storage blocked");
        storage.set(key, value);
      },
    },
  });
  vm.runInContext(source, context);
  return { run: (code) => vm.runInContext(code, context), root, media, storage };
}

test("browser locale and OS appearance provide safe defaults without storage", () => {
  const p = preferences({ locale: "en-AU", dark: true, blocked: true });
  assert.equal(p.root.lang, "en");
  assert.equal(p.root.dataset.theme, "dark");
  assert.doesNotThrow(() => p.run('savePreference("theme", "light")'));
  p.media.matches = false;
  p.media.changed();
  assert.equal(p.root.dataset.theme, "light");
});

test("saved language and explicit appearance survive reload and override system changes", () => {
  const p = preferences({ saved: { "mohua-language": "en", "mohua-theme": "light" }, dark: true });
  assert.equal(p.root.lang, "en");
  assert.equal(p.root.dataset.theme, "light");
  p.media.changed();
  assert.equal(p.root.dataset.theme, "light");
  p.run('theme = "dark"; savePreference("theme", theme); applyTheme()');
  const reloaded = preferences({ saved: Object.fromEntries(p.storage) });
  assert.equal(reloaded.root.dataset.theme, "dark");
  assert.equal(reloaded.root.lang, "en");
});

test("invalid saved preferences fall back to supported locale and system appearance", () => {
  const p = preferences({ saved: { "mohua-language": "invalid", "mohua-theme": "invalid" } });
  assert.equal(p.root.lang, "zh-CN");
  assert.equal(p.root.dataset.theme, "light");
  assert.equal(p.run('t("Invalid credentials")'), "邮箱或密码错误");
});

test("every marked UI string and dynamic Chinese literal has an English translation", () => {
  const p = preferences({ locale: "en" });
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const keys = [...html.matchAll(/data-i18n(?:-label)?="([^"]+)"/g)].map((m) => m[1]);
  for (const match of app.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const text = JSON.parse(match[0]);
    if (/[\u4e00-\u9fff]/.test(text)) keys.push(text);
  }
  for (const key of keys) {
    const translated = p.run(`t(${JSON.stringify(key)})`);
    assert.notEqual(translated, key, `Missing English translation: ${key}`);
    assert.doesNotMatch(translated, /[\u4e00-\u9fff]/);
  }
  assert.equal(
    p.run('t("测试服务连接失败（ETLS），请检查网络、DNS 或 TLS")'),
    "Test service connection failed (ETLS). Check the network, DNS or TLS.",
  );
  assert.equal(p.run('t("Unexpected diagnostic")'), "Unexpected diagnostic");
});

test("server version and light theme colour each come from one place", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(
    [...html.matchAll(/\bv?\d+\.\d+\.\d+\b/g)].map((m) => m[0]),
    [`v${version}`],
  );
  assert.match(html, /id="server-version"\s*>\s*v\d+\.\d+\.\d+\s*</);
  for (const script of [app, source]) assert.doesNotMatch(script, /\d+\.\d+\.\d+/);
  const light = source.match(/dark\s*\?\s*"(#[0-9a-f]{6})"\s*:\s*"(#[0-9a-f]{6})"/i)[2];
  assert.equal(html.match(/name="theme-color"\s+content="([^"]+)"/)[1], light);
});
