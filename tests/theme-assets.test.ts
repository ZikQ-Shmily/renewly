import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import type { Config } from "../server/config.js";

test("theme bootstrap is served as same-origin JavaScript before the SPA fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "renewly-theme-assets-"));
  const script = "document.documentElement.dataset.theme = 'light';";
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Renewly</title>");
  writeFileSync(join(dir, "theme-init.js"), script);
  const config: Config = {
    dataDir: dir,
    dbPath: join(dir, "test.sqlite"),
    appUrl: "http://localhost:3000",
    secret: "theme-assets-test-secret-with-sufficient-length",
    production: false,
    port: 3000,
    registrationEnabled: false,
    cookieSecure: false,
    trustProxy: false,
    bootstrapEmail: "",
    bootstrapPassword: "",
    reminderIntervalMs: 900000,
    clientDir: dir,
  };
  const runtime = await createApp({
    config,
    fetcher: async () => new Response("[]", { headers: { "content-type": "application/json" } }),
  });
  try {
    const response = await runtime.app.request("/theme-init.js");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /javascript/);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(await response.text(), script);
    assert.match(response.headers.get("content-security-policy") || "", /script-src 'self'(?:;|$)/);
  } finally {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
