import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { createSession, createUser } from "../server/auth.js";

const input = { label: "My Stream", website: "https://mystream.example.com", domains: [], aliases: ["我的影音"], icon: "", enabled: true };
test("only administrators can maintain the shared merchant catalog; reads require login and writes require same-origin", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "renewly-merchant-api-"));
  const runtime = await createApp({ config: { dataDir, dbPath: join(dataDir, "test.sqlite"), appUrl: "http://localhost:3000", secret: "a-test-secret-long-enough-for-merchant-api", production: false, port: 3000, registrationEnabled: false, cookieSecure: false, trustProxy: false, bootstrapEmail: "admin@example.com", bootstrapPassword: "merchant-api-admin-password-2026", reminderIntervalMs: 900000, clientDir: join(dataDir, "no-client") } });
  try {
    const admin = runtime.db.prepare("SELECT id FROM users WHERE role='admin'").get() as { id: string };
    const person = await createUser(runtime.db, "reader@example.com", "Reader", "ordinary-merchant-reader-password");
    const adminCookie = `renewly_session=${createSession(runtime.db, admin.id).token}`;
    const userCookie = `renewly_session=${createSession(runtime.db, person.id).token}`;
    const request = (path: string, method = "GET", cookie = "", body?: unknown, origin = "http://localhost:3000") => runtime.app.request(`/api/v1${path}`, { method, headers: { origin, cookie, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request("/merchants")).status, 401);
    assert.equal((await request("/admin/merchants", "POST", userCookie, input)).status, 403);
    assert.equal((await request("/admin/merchants", "POST", adminCookie, input, "https://evil.example")).status, 403);
    const created = await request("/admin/merchants", "POST", adminCookie, input);
    assert.equal(created.status, 201, await created.clone().text());
    const { merchant } = await created.json();
    const key = merchant.key as string;
    assert.ok(key.length <= 40);
    const catalog = await (await request("/merchants", "GET", userCookie)).json();
    assert.equal(catalog.merchants.find((item: any) => item.key === key)?.label, input.label);
    assert.equal((await request(`/admin/merchants/${key}`, "PATCH", userCookie, { label: "Hijacked" })).status, 403);
    assert.equal((await request(`/admin/merchants/${key}`, "PATCH", adminCookie, { enabled: false })).status, 200);
    const disabled = await (await request("/merchants", "GET", userCookie)).json();
    assert.equal(disabled.merchants.find((item: any) => item.key === key)?.enabled, false);
    assert.equal((await request(`/admin/merchants/${key}`, "DELETE", adminCookie)).status, 409);
    assert.equal((await request(`/admin/merchants/${key}`, "PATCH", adminCookie, { enabled: true })).status, 200);
    assert.equal((await request("/admin/merchants/merchant-dmit", "PATCH", adminCookie, { label: "DMIT 自定义", aliases: ["DMIT"], enabled: false })).status, 200);
    assert.equal((await request("/admin/merchants/merchant-dmit", "DELETE", userCookie)).status, 403);
    const reset = await request("/admin/merchants/merchant-dmit", "DELETE", adminCookie);
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).merchant.customized, false);
    assert.equal((await request("/admin/merchants", "POST", adminCookie, { ...input, label: "Bad", icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status, 400);
    assert.equal((runtime.db.prepare("SELECT count(*) n FROM subscriptions").get() as { n: number }).n, 0);
    const aliased = catalog.merchants.filter((item: any) => ["merchant-infuse", "merchant-netease-cloud-music"].includes(item.key));
    assert.equal(aliased.length, 2);
  } finally { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
