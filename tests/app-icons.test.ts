import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appIconPresets, matchedAppIcon, appFaviconUrl, isUploadedAppIcon, resolveAppIcon } from "../client/src/app-icons.js";

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
