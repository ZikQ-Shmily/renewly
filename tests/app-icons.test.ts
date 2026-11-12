import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appIconInitial, appIconPresets, merchantIconPresets, matchedAppIcon, appFaviconUrl, isUploadedAppIcon, resolveAppIcon } from "../client/src/app-icons.js";

test("merchant initials preserve complete Unicode graphemes and use a cloud for empty names", () => {
  assert.equal(appIconInitial("腾讯云"), "腾");
  assert.equal(appIconInitial("  DMIT  "), "D");
  assert.equal(appIconInitial(""), "云");
  assert.equal(appIconInitial(" \t\n"), "云");
  assert.equal(appIconInitial("e\u0301dge"), "é");
  assert.equal(appIconInitial("👩🏽‍💻 Cloud"), "👩🏽‍💻");
  assert.equal(appIconInitial("🇨🇳云服务"), "🇨🇳");
});

test("app icons match real brand domains and recognizable names without domain substring spoofing", () => {
  assert.equal(matchedAppIcon("我的效率工具", "https://www.notion.so/settings")?.key, "notion");
  assert.equal(matchedAppIcon("Notion Plus", "")?.key, "notion");
  assert.equal(matchedAppIcon("iCloud+ 200 GB", "")?.key, "icloud");
  assert.equal(matchedAppIcon("个人 ChatGPT", "")?.key, "chatgpt");
  assert.equal(matchedAppIcon("家庭计划", "https://accounts.spotify.com/")?.key, "spotify");
  assert.equal(matchedAppIcon("My plan", "https://notion.so.evil.example/"), undefined);
  assert.equal(matchedAppIcon("My plan", "https://evil-notion.so/"), undefined);
  assert.equal(matchedAppIcon("notional costs", ""), undefined);
});

test("merchant favicon fallback stays on a public HTTPS origin and discards paths and query strings", () => {
  assert.equal(appFaviconUrl("https://subscriptions.example.com/manage?account=private"), "https://subscriptions.example.com/favicon.ico");
  for (const url of [
    "javascript:alert(1)", "data:image/png;base64,AA==", "http://example.com/", "https://example.com:8443/",
    "https://user:pass@example.com/", "https://127.0.0.1/", "https://10.0.0.1/", "https://[::1]/",
    "https://localhost/", "https://app.localhost/", "https://app.local/", "https://app.internal/", "https://intranet/",
  ]) assert.equal(appFaviconUrl(url), null, url);
});

test("uploaded icons only allow bounded raster data URLs", () => {
  const png = "data:image/png;base64," + Buffer.alloc(64 * 1024).toString("base64");
  assert.equal(isUploadedAppIcon(png), true);
  assert.equal(isUploadedAppIcon("data:image/webp;base64," + Buffer.alloc(64 * 1024 + 1).toString("base64")), false);
  assert.equal(isUploadedAppIcon("data:image/jpeg;base64,AA=="), true);
  for (const value of ["auto", "generic", "https://example.com/icon.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,AA==", "data:image/png;base64,AAAA%20", "data:image/png;base64,A="])
    assert.equal(isUploadedAppIcon(value), false, value);
});

test("every preset has a small inert bundled SVG, with library license and source provenance", () => {
  for (const preset of appIconPresets) {
    const svg = readFileSync(new URL(`../client/public/app-icons/${preset.key}.svg`, import.meta.url), "utf8");
    assert.ok(svg.startsWith("<svg"), preset.key);
    assert.ok(svg.length < 10_000, preset.key);
    assert.doesNotMatch(svg, /<script|<foreignObject|\bon[a-z]+\s*=|\bhref\s*=/i);
  }
  assert.match(readFileSync(new URL("../client/public/app-icons/LICENSE.txt", import.meta.url), "utf8"), /CC0/);
  assert.match(readFileSync(new URL("../client/public/app-icons/README.md", import.meta.url), "utf8"), /simple-icons\/simple-icons/);
});

test("manual generic icons suppress merchant requests and selected presets override automatic matching", () => {
  assert.deepEqual(resolveAppIcon("Notion", "https://example.com", "generic"), { preset: undefined, src: null });
  const manual = resolveAppIcon("Notion", "https://notion.so", "spotify");
  assert.equal(manual.preset?.key, "spotify");
  assert.equal(manual.src, null);
  const automatic = resolveAppIcon("Example plan", "https://billing.example.com/private?account=x");
  assert.equal(automatic.src, "https://billing.example.com/favicon.ico");
  assert.equal(automatic.preset, undefined);
  assert.equal(resolveAppIcon("Example", "https://example.com", "data:image/jpeg;base64,AA==").src, "data:image/jpeg;base64,AA==");
});

test("bundled merchant logos match the catalog names, aliases and verified websites", () => {
  for (const preset of merchantIconPresets) {
    assert.equal(matchedAppIcon(preset.label, "")?.key, preset.key, preset.label);
    assert.ok(preset.image, preset.key);
    for (const src of new Set([preset.image!.light, preset.image!.dark])) {
      assert.match(src, /^\/app-icons\/merchants\/[a-z0-9-]+\.webp$/);
      const data = readFileSync(new URL(`../client/public${src}`, import.meta.url));
      assert.equal(data.subarray(0, 4).toString(), "RIFF", src);
      assert.equal(data.subarray(8, 12).toString(), "WEBP", src);
      assert.ok(data.length > 20 && data.length < 65_536, src);
    }
  }
  for (const [name, website, key] of [
    ["干杯Cloud", "", "merchant-usvps24"],
    ["干杯 Cloud", "", "merchant-usvps24"],
    ["Zgo", "", "merchant-zgovps"],
    ["大妈", "", "merchant-dmit"],
    ["搬瓦工", "", "merchant-bandwagon"],
    ["未填名称", "https://www.dmit.io/clientarea.php", "merchant-dmit"],
    ["我的服务器", "https://console.po0.io/login", "merchant-po0"],
    ["自定义名称", "https://www.bytevirt.com/clientarea.php", "merchant-bytevirt"],
  ]) assert.equal(matchedAppIcon(name, website)?.key, key);
  for (const [name, website] of [["DMITnot", ""], ["account", ""], ["CC plan", ""], ["Unknown", "https://dmit.io.evil.example"], ["Unknown", "https://evil-po0.io"]])
    assert.equal(matchedAppIcon(name, website), undefined);
  const manual = resolveAppIcon("Notion", "https://notion.so", "merchant-dmit");
  assert.equal(manual.preset?.key, "merchant-dmit");
  assert.equal(manual.src, null);
  assert.equal(resolveAppIcon("DMIT", "https://dmit.io", "generic").preset, undefined);
});
