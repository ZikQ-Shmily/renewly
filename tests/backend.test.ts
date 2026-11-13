import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addMonths, serializeSubscription, subscriptionSchema, totals } from "../server/domain.js";
import { createSession, createUser, hashPassword, sessionUser } from "../server/auth.js";
import { openDatabase, migrate } from "../server/db.js";
import { createFx } from "../server/fx.js";
import type { Config } from "../server/config.js";
import type { SendMail } from "../server/mail.js";

const testNow = new Date("2026-11-11T12:00:00Z");
const fxFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify([
      { base: "CNY", quote: "USD", rate: 0.15, date: "2026-11-10" },
      { base: "CNY", quote: "EUR", rate: 0.13, date: "2026-11-10" },
      { base: "CNY", quote: "GBP", rate: 0.11, date: "2026-11-10" },
      ...["NGN", "TRY", "PHP", "JPY", "TWD", "HKD"].map(quote => ({ base: "CNY", quote, rate: 10, date: "2026-11-10" })),
    ]),
    { headers: { "content-type": "application/json" } },
  );
function config(dataDir: string): Config {
  return {
    dataDir,
    dbPath: join(dataDir, "test.sqlite"),
    appUrl: "http://localhost:3000",
    secret: "test-app-secret-with-sufficient-length-for-tests",
    production: false,
    port: 3000,
    registrationEnabled: true,
    cookieSecure: false,
    trustProxy: false,
    bootstrapEmail: "admin@example.com",
    bootstrapPassword: "test-admin-password-strong-2026",
    reminderIntervalMs: 900000,
    clientDir: join(dataDir, "no-client"),
  };
}
const input = {
  type: "cloud",
  name: "测试服务器",
  vendor: "Test Cloud",
  website: "https://example.com",
  currency: "CNY",
  purchasePrice: 120,
  renewalPrice: 120,
  billingMonths: 12,
  periodStart: "2026-01-14",
  nextRenewal: "2026-11-14",
  paidAmount: 120,
  region: "香港",
  model: "2c2g",
  trafficMode: "limited",
  trafficQuota: 1,
  trafficUnit: "TB",
  status: "active",
  notes: "",
  reminderDays: [7, 3, 1],
};
async function fixture(sendMail?: SendMail, now: () => Date = () => testNow) {
  const dir = mkdtempSync(join(tmpdir(), "renewly-backend-"));
  const runtime = await createApp({
    config: config(dir),
    fetcher: fxFetch,
    sendMail,
    now,
  });
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
  ) =>
    runtime.app.request(`/api/v1${path}`, {
      method,
      headers: {
        origin: "http://localhost:3000",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const login = async (email: string, password: string) => {
    const res = await request("/auth/login", "POST", { email, password });
    assert.equal(res.status, 200, await res.clone().text());
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  // These fixtures exercise ownership, reminders and account administration;
  // self-registration and its email proof are covered in registration.test.ts.
  const seedAccount = async (email: string, name = email) => {
    const user = await createUser(
      runtime.db,
      email,
      name,
      "normal-user-password-2026",
    );
    const session = createSession(runtime.db, user.id);
    return { user, cookie: `renewly_session=${session.token}` };
  };
  return {
    runtime,
    request,
    login,
    seedAccount,
    cleanup() {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("account ownership, role enforcement, CSRF, and quota validation", async () => {
  const f = await fixture();
  try {
    const { cookie: a } = await f.seedAccount("a@example.com"),
      { cookie: b } = await f.seedAccount("b@example.com");
    const created = await f.request("/subscriptions", "POST", input, a);
    assert.equal(created.status, 201, await created.clone().text());
    const { subscription } = (await created.json()) as any;
    assert.equal(
      (
        (await f
          .request("/subscriptions", "GET", undefined, b)
          .then((r) => r.json())) as any
      ).subscriptions.length,
      0,
    );
    for (const method of ["PUT", "DELETE"])
      assert.equal(
        (
          await f.request(
            `/subscriptions/${subscription.id}`,
            method,
            method === "PUT" ? input : undefined,
            b,
          )
        ).status,
        404,
      );
    assert.equal(
      (
        await f.request(
          `/subscriptions/${subscription.id}/renew`,
          "POST",
          {
            paidAmount: 120,
            periodStart: "2026-11-14",
            nextRenewal: "2027-11-14",
          },
          b,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request("/admin/mail", "GET", undefined, a)).status,
      403,
    );
    assert.equal(
      (await f.request("/admin/mail/logs", "GET", undefined, a)).status,
      403,
    );
    assert.equal((await f.request("/admin/users", "GET", undefined, a)).status, 403);
    assert.equal((await f.request("/admin/users/unknown", "PATCH", { role: "admin" }, a)).status, 403);
    assert.equal(
      (
        await f.runtime.app.request("/api/v1/subscriptions", {
          method: "POST",
          headers: {
            cookie: a,
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/subscriptions",
          "POST",
          { ...input, trafficQuota: 0.0000000000001 },
          a,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/subscriptions",
          "POST",
          { ...input, website: "javascript:alert(1)" },
          a,
        )
      ).status,
      400,
    );
    const prefs = await f.request(
      "/me/notification-settings",
      "PUT",
      {
        recipientEmail: "a@example.com",
        enabled: true,
        reminderDays: [30, 7],
        timeZone: "Asia/Shanghai",
      },
      a,
    );
    assert.equal(prefs.status, 200);
    const updated = (await f
      .request("/subscriptions", "GET", undefined, a)
      .then((r) => r.json())) as any;
    assert.deepEqual(updated.subscriptions[0].reminderDays, [30, 7]);
  } finally {
    f.cleanup();
  }
});

test("renewal retains paid value and calendar anchors; archived budget excluded", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(
      "admin@example.com",
      "test-admin-password-strong-2026",
    );
    const response = await f.request(
      "/subscriptions",
      "POST",
      {
        ...input,
        periodStart: "2026-10-14",
        nextRenewal: "2026-11-14",
        paidAmount: 31,
        renewalPrice: 10,
        billingMonths: 1,
      },
      cookie,
    );
    const { subscription } = (await response.json()) as any;
    const before = (await f
      .request("/dashboard", "GET", undefined, cookie)
      .then((r) => r.json())) as any;
    assert.equal(before.remainingValue, 2.17);
    assert.equal(before.annualTotal, 120);
    assert.equal(before.upcomingTotal, 10);
    const renewed = await f.request(
      `/subscriptions/${subscription.id}/renew`,
      "POST",
      { paidAmount: 10, periodStart: "2026-11-14", nextRenewal: "2026-12-14" },
      cookie,
    );
    assert.equal(renewed.status, 200);
    const after = (await f
      .request("/dashboard", "GET", undefined, cookie)
      .then((r) => r.json())) as any;
    assert.equal(after.remainingValue, 12.17);
    assert.equal(after.upcomingTotal, 0);
    assert.deepEqual(after.subscriptions[0].currentPeriod, { startsAt: "2026-10-14T00:00", endsAt: "2026-11-14T00:00" });
    assert.deepEqual(after.subscriptions[0].progressPeriod, after.subscriptions[0].currentPeriod);
    assert.equal(after.subscriptions[0].periodStart, "2026-11-14T00:00");
    assert.equal(
      (
        f.runtime.db
          .prepare("SELECT COUNT(*) AS n FROM billing_periods")
          .get() as any
      ).n,
      2,
    );
    await f.request(
      `/subscriptions/${subscription.id}`,
      "DELETE",
      undefined,
      cookie,
    );
    const archived = (await f
      .request("/dashboard", "GET", undefined, cookie)
      .then((r) => r.json())) as any;
    assert.equal(archived.annualTotal, 0);
    assert.equal(archived.activeCount, 0);
    assert.equal(addMonths("2027-01-31", 1, 31), "2027-02-28T00:00");
    assert.equal(addMonths("2027-02-28", 1, 31), "2027-03-31T00:00");
    assert.equal(
      subscriptionSchema.safeParse({ ...input, periodStart: "2026-02-30" })
        .success,
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("v1 migration preserves existing subscription and user data and is repeatable", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1,'2026-11-10T00:00:00Z');
      CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,name TEXT,password_hash TEXT,role TEXT,currency TEXT,time_zone TEXT,created_at TEXT);
      INSERT INTO users VALUES('u','legacy@example.com','原有用户','saved-password-hash','admin','CNY','Asia/Shanghai','2026-01-01');
      CREATE TABLE subscriptions(id TEXT PRIMARY KEY,user_id TEXT,type_key TEXT,name TEXT,vendor TEXT,website TEXT,currency TEXT,purchase_minor INTEGER,renewal_minor INTEGER,billing_months INTEGER,billing_anchor_day INTEGER,next_renewal TEXT,status TEXT,notes TEXT,reminder_days TEXT,created_at TEXT,updated_at TEXT);
      INSERT INTO subscriptions VALUES('s','u','cloud','原有服务器','商家','https://example.com','CNY',19900,29900,12,1,'2027-01-01','active','保留备注','[7,3,1]','2026-01-01','2026-01-01');
      CREATE TABLE server_details(subscription_id TEXT PRIMARY KEY,region TEXT,model TEXT,traffic_mode TEXT,traffic_quota_bytes INTEGER,traffic_unit TEXT);
      INSERT INTO server_details VALUES('s','香港','2C2G','limited',200000000000,'GB');
      CREATE TABLE billing_periods(id INTEGER PRIMARY KEY AUTOINCREMENT,subscription_id TEXT,user_id TEXT,starts_at TEXT,ends_at TEXT,paid_minor INTEGER,currency TEXT,created_at TEXT);
      INSERT INTO billing_periods(subscription_id,user_id,starts_at,ends_at,paid_minor,currency,created_at) VALUES('s','u','2026-01-01','2027-01-01',19900,'CNY','2026-01-01');
      CREATE TABLE reminder_deliveries(id TEXT PRIMARY KEY,due_date TEXT);
      INSERT INTO reminder_deliveries VALUES('old-reminder','2027-01-01');
    `);
    migrate(db);
    migrate(db);
    const user = db.prepare("SELECT * FROM users WHERE id='u'").get() as any;
    assert.equal(user.status, "active");
    assert.equal(user.password_hash, "saved-password-hash");
    const row = db.prepare("SELECT * FROM subscriptions WHERE id='s'").get();
    const subscription = serializeSubscription(db, row, "Asia/Shanghai", testNow);
    assert.equal(subscription.purchasePrice, 199);
    assert.equal(subscription.renewalPrice, 299);
    assert.equal(subscription.paidAmount, 199);
    assert.equal(subscription.trafficQuota, 200);
    assert.equal(subscription.trafficDirection, "unknown");
    assert.equal(subscription.notes, "保留备注");
    assert.equal(subscription.autoRenew, false);
    assert.equal(subscription.bandwidthValue, null);
    assert.equal(subscription.bandwidthUnit, "Mbps");
    assert.equal(subscription.nextRenewal, "2027-01-01T00:00");
    assert.equal(subscription.periodStart, "2026-01-01T00:00");
    assert.equal(subscription.model, "2C2G");
    assert.equal(subscription.cpuCores, null);
    assert.equal(subscription.memoryValue, null);
    assert.equal(subscription.diskValue, null);
    assert.equal(subscription.serverIcon, "auto");
    assert.deepEqual(subscription.ipAddresses, []);
    assert.equal((db.prepare("SELECT due_date FROM reminder_deliveries").get() as any).due_date, "2027-01-01T00:00");
    assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }]);
  } finally { db.close(); }
});

test("traffic direction persists, validates and survives edits from older clients", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const created = await f.request("/subscriptions", "POST", { ...input, trafficDirection: "one_way" }, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    assert.equal(item.trafficDirection, "one_way");

    const update = (payload: object) => f.request(`/subscriptions/${item.id}`, "PUT", { ...input, ...payload }, cookie);
    const twoWay = await update({ trafficDirection: "two_way" });
    assert.equal(twoWay.status, 200, await twoWay.clone().text());
    assert.equal((await twoWay.json() as any).subscription.trafficDirection, "two_way");
    const oldClient = await update({ notes: "旧客户端只修改备注" });
    assert.equal(oldClient.status, 200, await oldClient.clone().text());
    assert.equal((await oldClient.json() as any).subscription.trafficDirection, "two_way");

    for (const trafficDirection of [null, "inbound", "双向", 1])
      assert.equal((await update({ trafficDirection })).status, 400);
    const list = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    assert.equal(list.subscriptions[0].trafficDirection, "two_way");
    const cleared = await update({ trafficDirection: "unknown" });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json() as any).subscription.trafficDirection, "unknown");
    const defaulted = await f.request("/subscriptions", "POST", input, cookie);
    assert.equal(defaulted.status, 201);
    assert.equal((await defaulted.json() as any).subscription.trafficDirection, "unknown");
  } finally { f.cleanup(); }
});

test("cloud vendor icons round trip, preserve older client edits and renewals, and stay owner scoped", async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.seedAccount("cloud-icons@example.com");
    const { cookie: other } = await f.seedAccount("other-cloud-icons@example.com");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const created = await f.request("/subscriptions", "POST", { ...input, serverIcon: "aws" }, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    assert.equal(item.serverIcon, "aws");
    assert.equal(item.appIcon, "auto");
    const storedIcon = () => (f.runtime.db.prepare("SELECT icon FROM server_details WHERE subscription_id=?").get(item.id) as any).icon;
    assert.equal(storedIcon(), "aws");

    for (const serverIcon of ["hetzner", "custom-provider", png]) {
      const edited = await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, serverIcon }, cookie);
      assert.equal(edited.status, 200, await edited.clone().text());
      assert.equal((await edited.json() as any).subscription.serverIcon, serverIcon);
      assert.equal(storedIcon(), serverIcon);
    }
    const oldClient = await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, notes: "旧客户端保留自定义商家图标" }, cookie);
    assert.equal(oldClient.status, 200, await oldClient.clone().text());
    assert.equal((await oldClient.json() as any).subscription.serverIcon, png);
    assert.equal(storedIcon(), png);

    const renewal = { paidAmount: 120, periodStart: item.nextRenewal, nextRenewal: addMonths(item.nextRenewal, 12) };
    for (const method of ["PUT", "DELETE"])
      assert.equal((await f.request(`/subscriptions/${item.id}`, method, method === "PUT" ? { ...input, serverIcon: "cloudflare" } : undefined, other)).status, 404);
    assert.equal((await f.request(`/subscriptions/${item.id}/renew`, "POST", renewal, other)).status, 404);
    assert.equal((await f.request("/subscriptions", "GET", undefined, other).then(response => response.json()) as any).subscriptions.length, 0);
    assert.equal(storedIcon(), png);
    const renewed = await f.request(`/subscriptions/${item.id}/renew`, "POST", renewal, cookie);
    assert.equal(renewed.status, 200, await renewed.clone().text());
    assert.equal((await renewed.json() as any).subscription.serverIcon, png);
    assert.equal(storedIcon(), png);
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM billing_periods WHERE subscription_id=?").get(item.id) as any).n, 2);

    for (const serverIcon of [png, undefined]) {
      const result = await f.request("/subscriptions", "POST", { ...input, serverIcon }, cookie);
      assert.equal(result.status, 201, await result.clone().text());
      assert.equal((await result.json() as any).subscription.serverIcon, serverIcon ?? "auto");
    }
    const app = await f.request("/subscriptions", "POST", { ...input, type: "app", appIcon: "notion", serverIcon: "aws" }, cookie);
    assert.equal(app.status, 201, await app.clone().text());
    const appItem = (await app.json() as any).subscription;
    assert.equal(appItem.appIcon, "notion");
    assert.equal(appItem.serverIcon, "auto");
    assert.equal(f.runtime.db.prepare("SELECT * FROM server_details WHERE subscription_id=?").get(appItem.id), undefined);
    const list = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    assert.equal(list.subscriptions.find((subscription: any) => subscription.id === item.id).serverIcon, png);
    const dashboard = await f.request("/dashboard?type=cloud", "GET", undefined, cookie).then(response => response.json()) as any;
    assert.equal(dashboard.subscriptions.find((subscription: any) => subscription.id === item.id).serverIcon, png);
    const cleared = await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, ...renewal, serverIcon: "auto" }, cookie);
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await cleared.json() as any).subscription.serverIcon, "auto");
    assert.equal(storedIcon(), "auto");
  } finally { f.cleanup(); }
});

test("cloud vendor icons reject unsafe, malformed and oversized images without changing stored records", async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.seedAccount("cloud-icon-validation@example.com");
    const created = await f.request("/subscriptions", "POST", { ...input, serverIcon: "aws" }, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    const db = f.runtime.db;
    const snapshot = () => ["subscriptions", "server_details", "billing_periods"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const oversizedPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(65_536)]);
    for (const serverIcon of [null, 1, "", "../aws", "AWS", "a".repeat(41), "javascript:alert(1)", "https://evil.example/logo.png", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/png;base64,bm90LXBpY3R1cmU=", "data:image/jpeg;base64,iVBORw0KGgo=", "data:image/png;base64,iVBORw0KGgp=", `data:image/png;base64,${oversizedPng.toString("base64")}`]) {
      assert.equal((await f.request("/subscriptions", "POST", { ...input, serverIcon }, cookie)).status, 400);
      assert.equal((await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, serverIcon }, cookie)).status, 400);
    }
    assert.deepEqual(snapshot(), before);
    assert.equal((await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any).subscriptions[0].serverIcon, "aws");
  } finally { f.cleanup(); }
});

test("v5 migration marks existing traffic direction unknown and preserves v4 subscription details", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const created = await f.request("/subscriptions", "POST", {
      ...input, cpuCores: 2, memoryValue: 4, memoryUnit: "GB", diskValue: 40, diskUnit: "GB",
      ipAddresses: [{ type: "static", address: "203.0.113.7" }],
    }, cookie);
    assert.equal(created.status, 201);
    const before = (await created.json() as any).subscription;
    // Recreate a v4 schema so the production upgrade path is exercised directly.
    f.runtime.db.exec("ALTER TABLE server_details DROP COLUMN icon; ALTER TABLE server_details DROP COLUMN traffic_direction; DROP TABLE registration_codes; DROP TABLE registration_code_requests; DROP TABLE merchant_overrides; DELETE FROM schema_migrations WHERE version>=5;");
    migrate(f.runtime.db);
    migrate(f.runtime.db);
    const after = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    assert.deepEqual(after.subscriptions[0], before);
    const direction = f.runtime.db.prepare("SELECT traffic_direction FROM server_details WHERE subscription_id=?").get(before.id) as any;
    assert.equal(direction.traffic_direction, "unknown");
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=5").get() as any).n, 1);
    assert.throws(() => f.runtime.db.prepare("UPDATE server_details SET traffic_direction='inbound' WHERE subscription_id=?").run(before.id));
  } finally { f.cleanup(); }
});

test("structured server configuration and static or dynamic IPs round trip and survive older clients", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const configuration = {
      cpuCores: 0.5,
      memoryValue: 512,
      memoryUnit: "MB",
      diskValue: 1.5,
      diskUnit: "TB",
      ipAddresses: [
        { type: "static", address: "203.0.113.10" },
        { type: "static", address: "2001:db8::1" },
        { type: "dynamic", address: "" },
        { type: "dynamic", address: "198.51.100.8" },
      ],
    };
    const created = await f.request("/subscriptions", "POST", { ...input, ...configuration }, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    for (const [key, value] of Object.entries(configuration)) assert.deepEqual(item[key], value);

    const legacyUpdate = await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, name: "旧客户端修改名称" }, cookie);
    assert.equal(legacyUpdate.status, 200, await legacyUpdate.clone().text());
    const preserved = (await legacyUpdate.json() as any).subscription;
    for (const [key, value] of Object.entries(configuration)) assert.deepEqual(preserved[key], value);
    const cleared = await f.request(`/subscriptions/${item.id}`, "PUT", {
      ...input, cpuCores: null, memoryValue: null, diskValue: null, ipAddresses: [],
    }, cookie);
    assert.equal(cleared.status, 200, await cleared.clone().text());
    const empty = (await cleared.json() as any).subscription;
    assert.equal(empty.cpuCores, null);
    assert.equal(empty.memoryValue, null);
    assert.equal(empty.diskValue, null);
    assert.deepEqual(empty.ipAddresses, []);
    assert.equal(empty.model, input.model);

    for (const address of ["", "999.1.1.1", "203.0.113", "2001:db8:::1", "host.example", "https://203.0.113.1"])
      assert.equal(subscriptionSchema.safeParse({ ...input, ipAddresses: [{ type: "static", address }] }).success, false);
    assert.equal(subscriptionSchema.safeParse({ ...input, ipAddresses: [{ type: "dynamic", address: "invalid" }] }).success, false);
    assert.equal(subscriptionSchema.safeParse({ ...input, ipAddresses: Array(21).fill({ type: "dynamic", address: "" }) }).success, false);
    for (const key of ["cpuCores", "memoryValue", "diskValue"])
      for (const value of [0, -1, Infinity, 1e10, "2"])
        assert.equal(subscriptionSchema.safeParse({ ...input, [key]: value }).success, false);
    assert.equal(subscriptionSchema.safeParse({ ...input, memoryUnit: "TB" }).success, false);
    assert.equal(subscriptionSchema.safeParse({ ...input, diskUnit: "MB" }).success, false);

    const { cookie: other } = await f.seedAccount("other-ip@example.com", "其他用户");
    assert.equal((await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, ...configuration }, other)).status, 404);
    assert.equal((await f.request("/subscriptions", "GET", undefined, other).then(r => r.json()) as any).subscriptions.length, 0);
  } finally { f.cleanup(); }
});

test("category dashboards scope budgets, paid value and due items while the overview includes future types", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const create = async (name: string, amount: number, currency = "CNY") => {
      const response = await f.request("/subscriptions", "POST", {
        ...input, name, currency, purchasePrice: amount, renewalPrice: amount, paidAmount: amount,
        billingMonths: 1, periodStart: "2026-11-01T20:00", nextRenewal: "2026-12-01T20:00",
      }, cookie);
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json() as any).subscription;
    };
    const cloud = await create("云服务器", 30);
    const otherType = await create("未来域名类别", 60);
    // Exercise the generic aggregate with a future registered subscription type.
    f.runtime.db.prepare("UPDATE subscriptions SET type_key='domain' WHERE id=?").run(otherType.id);
    const archived = await create("已归档云服务器", 100);
    await f.request(`/subscriptions/${archived.id}`, "DELETE", undefined, cookie);

    const all = await f.request("/dashboard", "GET", undefined, cookie).then(r => r.json()) as any;
    const category = await f.request("/dashboard?type=cloud", "GET", undefined, cookie).then(r => r.json()) as any;
    assert.equal(all.annualTotal, 1080);
    assert.equal(all.remainingValue, 60);
    assert.equal(all.upcomingTotal, 90);
    assert.equal(all.activeCount, 2);
    assert.equal(all.dueCount, 2);
    assert.equal(category.annualTotal, 360);
    assert.equal(category.remainingValue, 20);
    assert.equal(category.upcomingTotal, 30);
    assert.equal(category.activeCount, 1);
    assert.deepEqual(category.nextDue.map((item: any) => item.id), [cloud.id]);
    assert.ok(category.subscriptions.every((item: any) => item.type === "cloud"));
    assert.equal((await f.request("/dashboard?type=unknown", "GET", undefined, cookie)).status, 400);

    const owner = (f.runtime.db.prepare("SELECT user_id FROM subscriptions WHERE id=?").get(cloud.id) as any).user_id;
    f.runtime.db.prepare("UPDATE subscriptions SET currency='GBP' WHERE id=?").run(otherType.id);
    f.runtime.db.prepare("UPDATE billing_periods SET currency='GBP' WHERE subscription_id=?").run(otherType.id);
    assert.equal(totals(f.runtime.db, owner, "Asia/Shanghai", "CNY", {}, testNow, "cloud").totalsPartial, false);
    const partial = totals(f.runtime.db, owner, "Asia/Shanghai", "CNY", {}, testNow);
    assert.equal(partial.totalsPartial, true);
    assert.deepEqual(partial.unconvertedCurrencies, ["GBP"]);
    assert.equal(partial.remainingValue, 20);
  } finally { f.cleanup(); }
});

test("server bandwidth and auto renewal persist without automatically extending the billing period", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const created = await f.request("/subscriptions", "POST", { ...input, bandwidthValue: 1.25, bandwidthUnit: "Gbps", autoRenew: true }, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const { subscription } = await created.json() as any;
    assert.equal(subscription.bandwidthValue, 1.25);
    assert.equal(subscription.bandwidthUnit, "Gbps");
    assert.equal(subscription.autoRenew, true);
    assert.equal(subscription.nextRenewal, input.nextRenewal + "T00:00");
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) AS n FROM billing_periods").get() as any).n, 1);
    const updated = await f.request(`/subscriptions/${subscription.id}`, "PUT", { ...input, bandwidthValue: 100, bandwidthUnit: "Mbps", autoRenew: false }, cookie);
    assert.equal(updated.status, 200, await updated.clone().text());
    const result = await updated.json() as any;
    assert.equal(result.subscription.bandwidthValue, 100);
    assert.equal(result.subscription.bandwidthUnit, "Mbps");
    assert.equal(result.subscription.autoRenew, false);
    for (const value of [0, -1, Infinity, 1e10])
      assert.equal(subscriptionSchema.safeParse({ ...input, bandwidthValue: value }).success, false);
    assert.equal(subscriptionSchema.safeParse({ ...input, bandwidthUnit: "MB/s" }).success, false);
    assert.equal(subscriptionSchema.safeParse({ ...input, autoRenew: "yes" }).success, false);
    const future = await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-12-01", nextRenewal: "2027-01-01" }, cookie);
    const futureItem = (await future.json() as any).subscription;
    assert.equal(futureItem.currentPeriod, null);
    assert.deepEqual(futureItem.progressPeriod, { startsAt: "2026-12-01T00:00", endsAt: "2027-01-01T00:00" });
    const expired = await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-09-01", nextRenewal: "2026-10-01" }, cookie);
    const expiredItem = (await expired.json() as any).subscription;
    assert.equal(expiredItem.currentPeriod, null);
    assert.deepEqual(expiredItem.progressPeriod, { startsAt: "2026-09-01T00:00", endsAt: "2026-10-01T00:00" });
  } finally { f.cleanup(); }
});

test("admin user management protects admins, revokes sessions and enforces account status", async () => {
  const f = await fixture();
  try {
    const adminCookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const { user, cookie: userCookie } = await f.seedAccount("managed@example.com", "普通用户");
    await f.request("/subscriptions", "POST", input, userCookie);
    f.runtime.db.prepare("UPDATE notification_settings SET recipient_email='receive@example.com',email_verified=1 WHERE user_id=?").run(user.id);
    const list = await f.request("/admin/users", "GET", undefined, adminCookie);
    assert.equal(list.status, 200);
    const users = (await list.json() as any).users;
    const managed = users.find((item: any) => item.id === user.id);
    assert.equal(managed.recipientEmail, "receive@example.com");
    assert.equal(managed.email, "managed@example.com");
    assert.equal(managed.emailVerified, true);
    assert.equal(managed.subscriptionCount, 1);
    assert.equal(managed.status, "active");
    assert.equal(JSON.stringify(users).includes("password_hash"), false);
    const adminId = users.find((item: any) => item.role === "admin").id;
    for (const change of [{ role: "user" }, { status: "disabled" }])
      assert.equal((await f.request(`/admin/users/${adminId}`, "PATCH", change, adminCookie)).status, 409);
    assert.equal((await f.request(`/admin/users/${user.id}`, "PATCH", { email: "changed@example.com" }, adminCookie)).status, 400);
    assert.equal((await f.request("/admin/users/nonexistent", "PATCH", { status: "disabled" }, adminCookie)).status, 404);
    const changed = await f.request(`/admin/users/${user.id}`, "PATCH", { name: "修改姓名", role: "admin" }, adminCookie);
    assert.equal(changed.status, 200);
    assert.equal((await changed.json() as any).user.role, "admin");
    assert.equal((await f.request("/me", "GET", undefined, userCookie)).status, 401);
    const secondAdmin = await f.login("managed@example.com", "normal-user-password-2026");
    assert.equal((await f.request(`/admin/users/${user.id}`, "PATCH", { status: "disabled" }, adminCookie)).status, 200);
    assert.equal((await f.request("/me", "GET", undefined, secondAdmin)).status, 401);
    const disabledLogin = await f.request("/auth/login", "POST", { email: "managed@example.com", password: "normal-user-password-2026" });
    assert.equal(disabledLogin.status, 401);
    // Even a surviving or accidentally restored session cannot authorize a disabled user.
    const stray = createSession(f.runtime.db, user.id);
    assert.equal(sessionUser(f.runtime.db, stray.token), null);
    assert.equal((await f.request("/admin/users", "GET", undefined, `renewly_session=${stray.token}`)).status, 401);
    assert.equal((await f.request(`/admin/users/${user.id}`, "PATCH", { status: "active", role: "user" }, adminCookie)).status, 200);
    await f.login("managed@example.com", "normal-user-password-2026");
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE '%user.updated%'").get() as any).n, 3);
  } finally { f.cleanup(); }
});

test("FX first failure is partial, successful rates persist and survive upstream failure", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  try {
    const missing = await createFx(db, async () => {
      throw Error("offline");
    }).get();
    assert.equal(missing.available, false);
    assert.deepEqual(missing.rates, { CNY: 1 });
    const valid = await createFx(db, fxFetch).get();
    assert.equal(valid.available, true);
    assert.equal(valid.rates.USD, 1 / 0.15);
    db.prepare("UPDATE exchange_rates SET fetched_at=?").run(
      "2000-01-01T00:00:00Z",
    );
    const stale = await createFx(db, async () => {
      throw Error("offline");
    }).get();
    assert.equal(stale.stale, true);
    assert.equal(stale.available, true);
    assert.equal(stale.rates.USD, 1 / 0.15);
  } finally {
    db.close();
  }
});

test("App subscriptions round trip, stay owner scoped, renew and aggregate separately in CNY", async () => {
  const f = await fixture();
  try {
    const { cookie, user } = await f.seedAccount("app-owner@example.com");
    const { cookie: other } = await f.seedAccount("other-owner@example.com");
    const appInput = {
      type: "app", name: "Notion", appPlan: "Plus", appChannel: "App Store",
      appAccount: "my-account@example.com", appIcon: "notion", currency: "JPY",
      purchasePrice: 1000, renewalPrice: 1000, paidAmount: 1000, billingMonths: 1,
      periodStart: "2026-11-01T20:00", nextRenewal: "2026-12-01T20:00", autoRenew: true,
    };
    const created = await f.request("/subscriptions", "POST", appInput, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    assert.equal(item.type, "app");
    assert.equal(item.vendor, "");
    assert.equal(item.website, "");
    assert.equal(item.appPlan, "Plus");
    assert.equal(item.appChannel, "App Store");
    assert.equal(item.appAccount, appInput.appAccount);
    assert.equal(item.appIcon, "notion");
    assert.equal(item.autoRenew, true);
    assert.equal(item.currency, "JPY");
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM server_details WHERE subscription_id=?").get(item.id) as any).n, 0);
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM app_details WHERE subscription_id=?").get(item.id) as any).n, 1);
    const update = { ...appInput, name: "Notion Plus", appPlan: "Plus 年度优惠", appAccount: "工作账户", appChannel: "官网" };
    const edited = await f.request(`/subscriptions/${item.id}`, "PUT", update, cookie);
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.equal((await edited.json() as any).subscription.appAccount, "工作账户");
    const olderClient = { ...update } as any;
    for (const key of ["appPlan", "appChannel", "appAccount", "appIcon"]) delete olderClient[key];
    const preserved = await f.request(`/subscriptions/${item.id}`, "PUT", olderClient, cookie);
    assert.equal(preserved.status, 200);
    assert.equal((await preserved.json() as any).subscription.appPlan, "Plus 年度优惠");
    for (const method of ["PUT", "DELETE"])
      assert.equal((await f.request(`/subscriptions/${item.id}`, method, method === "PUT" ? update : undefined, other)).status, 404);
    const renewal = { paidAmount: 1000, periodStart: "2026-12-01T20:00", nextRenewal: "2027-01-01T20:00" };
    assert.equal((await f.request(`/subscriptions/${item.id}/renew`, "POST", renewal, other)).status, 404);
    assert.equal((await f.request("/subscriptions", "GET", undefined, other).then(r => r.json()) as any).subscriptions.length, 0);
    assert.equal((await f.request(`/subscriptions/${item.id}`, "PUT", { ...input, type: "cloud" }, cookie)).status, 400);
    const cloud = await f.request("/subscriptions", "POST", { ...input, purchasePrice: 30, renewalPrice: 30, paidAmount: 30, billingMonths: 1, periodStart: appInput.periodStart, nextRenewal: appInput.nextRenewal }, cookie);
    assert.equal(cloud.status, 201);
    // A legacy preference and old query parameters must never change summary currency.
    f.runtime.db.prepare("UPDATE users SET currency='USD' WHERE id=?").run(user.id);
    const all = await f.request("/dashboard?currency=USD", "GET", undefined, cookie).then(r => r.json()) as any;
    const apps = await f.request("/dashboard?currency=JPY&type=app", "GET", undefined, cookie).then(r => r.json()) as any;
    const clouds = await f.request("/dashboard?type=cloud", "GET", undefined, cookie).then(r => r.json()) as any;
    assert.equal(all.currency, "CNY");
    assert.equal(apps.currency, "CNY");
    assert.equal(apps.annualTotal, 1200);
    assert.equal(clouds.annualTotal, 360);
    assert.equal(all.annualTotal, 1560);
    assert.equal(apps.remainingValue, 66.67);
    assert.equal(all.remainingValue, 86.67);
    assert.equal(apps.upcomingTotal, 100);
    assert.deepEqual(apps.nextDue.map((s: any) => s.id), [item.id]);
    assert.equal(apps.subscriptions[0].currency, "JPY");
    const preferences = await f.request("/me/preferences", "PUT", { currency: "HKD", timeZone: "Asia/Shanghai" }, cookie);
    assert.equal(preferences.status, 200);
    assert.equal((await preferences.json() as any).user.currency, "CNY");
    assert.equal((await f.request("/types", "GET", undefined, cookie).then(r => r.json()) as any).types.some((t: any) => t.key === "app"), true);
    assert.equal((await f.request(`/subscriptions/${item.id}/renew`, "POST", renewal, cookie)).status, 200);
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM billing_periods WHERE subscription_id=?").get(item.id) as any).n, 2);
    await f.request(`/subscriptions/${item.id}`, "DELETE", undefined, cookie);
    const archived = (await f.request("/subscriptions", "GET", undefined, cookie).then(r => r.json()) as any).subscriptions.find((s: any) => s.id === item.id);
    assert.equal(archived.status, "archived");
    assert.equal(archived.appAccount, "工作账户");
    assert.equal((await f.request("/dashboard?type=app", "GET", undefined, cookie).then(r => r.json()) as any).activeCount, 0);
  } finally { f.cleanup(); }
});

test("App purchase channels create, edit and round trip with in-app purchases while rejecting unknown values", async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.seedAccount("app-channels@example.com");
    const appInput = { ...input, type: "app", name: "应用内购测试", appPlan: "Premium", appChannel: "应用内购", appAccount: "个人账户", appIcon: "spotify" };
    const created = await f.request("/subscriptions", "POST", appInput, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    assert.equal(item.appChannel, "应用内购");
    assert.equal((f.runtime.db.prepare("SELECT purchase_channel FROM app_details WHERE subscription_id=?").get(item.id) as any).purchase_channel, "应用内购");

    for (const appChannel of ["官网", "App Store", "Google Play", "其他"]) {
      const originalChannel = await f.request("/subscriptions", "POST", { ...appInput, appChannel }, cookie);
      assert.equal(originalChannel.status, 201, await originalChannel.clone().text());
      assert.equal((await originalChannel.json() as any).subscription.appChannel, appChannel);
      const edited = await f.request(`/subscriptions/${item.id}`, "PUT", { ...appInput, appChannel }, cookie);
      assert.equal(edited.status, 200, await edited.clone().text());
      assert.equal((await edited.json() as any).subscription.appChannel, appChannel);
    }
    const edited = await f.request(`/subscriptions/${item.id}`, "PUT", { ...appInput, appPlan: "Premium 年付" }, cookie);
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.equal((await edited.json() as any).subscription.appChannel, "应用内购");

    for (const appChannel of ["未知渠道", "In-App Purchase", "应用内购买", "", null, 1]) {
      assert.equal((await f.request("/subscriptions", "POST", { ...appInput, appChannel }, cookie)).status, 400);
      assert.equal((await f.request(`/subscriptions/${item.id}`, "PUT", { ...appInput, appChannel }, cookie)).status, 400);
    }
    const list = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    const saved = list.subscriptions.find((subscription: any) => subscription.id === item.id);
    assert.equal(list.subscriptions.length, 5);
    assert.equal(saved.appChannel, "应用内购");
    assert.equal(saved.appPlan, "Premium 年付");
    assert.equal(saved.appAccount, "个人账户");
    assert.equal(saved.appIcon, "spotify");
  } finally { f.cleanup(); }
});

test("v8 migration preserves populated v7 Apps and related data, rolls back failures and is repeatable", async () => {
  const f = await fixture();
  try {
    const { cookie, user } = await f.seedAccount("v8-app-owner@example.com");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const appIds: string[] = [];
    for (const [index, appChannel] of ["官网", "App Store", "Google Play", "其他"].entries()) {
      const created = await f.request("/subscriptions", "POST", {
        ...input, type: "app", name: `迁移应用 ${index}`, currency: "JPY", appChannel,
        appPlan: `保留套餐 ${index}`, appAccount: `saved-account-${index}@example.com`,
        appIcon: index === 0 ? png : "notion", autoRenew: true, notes: `保留备注 ${index}`,
      }, cookie);
      assert.equal(created.status, 201, await created.clone().text());
      appIds.push((await created.json() as any).subscription.id);
    }
    const cloud = await f.request("/subscriptions", "POST", { ...input, currency: "USD", ipAddresses: [{ type: "static", address: "203.0.113.18" }] }, cookie);
    assert.equal(cloud.status, 201, await cloud.clone().text());
    const db = f.runtime.db;
    db.prepare("UPDATE users SET currency='GBP' WHERE id=?").run(user.id);
    db.exec("UPDATE mail_settings SET enabled=1,transport='resend',sender_email='migration@example.com',secrets_cipher='preserved-encrypted-secret'");
    // Recreate the deployed v7 constraint with real App rows before exercising the upgrade.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE app_details_v7(
          subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
          plan TEXT NOT NULL DEFAULT '',
          purchase_channel TEXT NOT NULL DEFAULT '官网' CHECK(purchase_channel IN ('官网','App Store','Google Play','其他')),
          account TEXT NOT NULL DEFAULT '',
          icon TEXT NOT NULL DEFAULT 'auto'
        );
        INSERT INTO app_details_v7 SELECT * FROM app_details;
        DROP TABLE app_details;
        ALTER TABLE app_details_v7 RENAME TO app_details;
        ALTER TABLE server_details DROP COLUMN icon;
        DROP TABLE merchant_overrides; DELETE FROM schema_migrations WHERE version>=8;
      `);
    })();
    assert.throws(() => db.prepare("UPDATE app_details SET purchase_channel='应用内购' WHERE subscription_id=?").run(appIds[0]), /CHECK constraint failed/);
    const tables = ["users", "sessions", "notification_settings", "subscriptions", "server_details", "app_details", "billing_periods", "mail_settings"];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row: any) => {
      if (table === "server_details") { const { icon, ...details } = row; return details; }
      return row;
    })]));
    const before = snapshot();
    const oldSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='app_details'").get();
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(app_details)").all();
    const oldMigrations = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    db.exec("CREATE TRIGGER fail_v8_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=8 BEGIN SELECT RAISE(ABORT,'simulated v8 marker failure'); END");
    assert.throws(() => migrate(db), /simulated v8 marker failure/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='app_details'").get(), oldSchema);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='app_details_v8'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), oldMigrations);
    db.exec("DROP TRIGGER fail_v8_migration");

    migrate(db);
    migrate(db);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<8 ORDER BY version").all(), oldMigrations);
    assert.equal((db.prepare("SELECT MAX(version) version FROM schema_migrations").get() as any).version, 11);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=8").get() as any).n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(app_details)").all(), foreignKeys);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((db.prepare("PRAGMA quick_check").get() as any).quick_check, "ok");
    db.prepare("UPDATE app_details SET purchase_channel='应用内购' WHERE subscription_id=?").run(appIds[0]);
    const listed = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    const migrated = listed.subscriptions.find((subscription: any) => subscription.id === appIds[0]);
    assert.equal(migrated.appChannel, "应用内购");
    assert.equal(migrated.appPlan, "保留套餐 0");
    assert.equal(migrated.appAccount, "saved-account-0@example.com");
    assert.equal(migrated.appIcon, png);
    assert.throws(() => db.prepare("UPDATE app_details SET purchase_channel='未知渠道' WHERE subscription_id=?").run(appIds[0]), /CHECK constraint failed/);
    assert.throws(() => db.prepare("INSERT INTO app_details(subscription_id) VALUES('missing-subscription')").run(), /FOREIGN KEY constraint failed/);
    db.prepare("DELETE FROM subscriptions WHERE id=?").run(appIds[0]);
    assert.equal(db.prepare("SELECT * FROM app_details WHERE subscription_id=?").get(appIds[0]), undefined);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.cleanup(); }
});

test("v9 migration defaults populated v8 cloud icons and preserves data with rollback and repeatability", async () => {
  const f = await fixture();
  try {
    const { cookie, user } = await f.seedAccount("v9-cloud-owner@example.com");
    const { cookie: other } = await f.seedAccount("v9-other-owner@example.com");
    const cloud = await f.request("/subscriptions", "POST", {
      ...input, currency: "USD", autoRenew: true, trafficDirection: "two_way", bandwidthValue: 1.25, bandwidthUnit: "Gbps",
      cpuCores: 2.5, memoryValue: 512, memoryUnit: "MB", diskValue: 1.5, diskUnit: "TB",
      ipAddresses: [{ type: "static", address: "203.0.113.9" }, { type: "dynamic", address: "" }], notes: "保留云服务器配置",
    }, cookie);
    assert.equal(cloud.status, 201, await cloud.clone().text());
    const cloudItem = (await cloud.json() as any).subscription;
    const renewal = await f.request(`/subscriptions/${cloudItem.id}/renew`, "POST", { paidAmount: 99, periodStart: cloudItem.nextRenewal, nextRenewal: addMonths(cloudItem.nextRenewal, 12) }, cookie);
    assert.equal(renewal.status, 200, await renewal.clone().text());
    const app = await f.request("/subscriptions", "POST", {
      ...input, type: "app", name: "保留应用", currency: "JPY", appPlan: "Premium 年付", appChannel: "应用内购", appAccount: "saved-account@example.com", appIcon: "spotify",
    }, cookie);
    assert.equal(app.status, 201, await app.clone().text());
    const appItem = (await app.json() as any).subscription;
    assert.equal((await f.request("/subscriptions", "POST", { ...input, name: "另一用户的云服务器", currency: "EUR" }, other)).status, 201);
    const beforeList = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    const db = f.runtime.db;
    db.prepare("UPDATE users SET currency='GBP' WHERE id=?").run(user.id);
    db.prepare("UPDATE notification_settings SET recipient_email='saved-recipient@example.com',email_verified=1,reminder_days='[14,7,0]' WHERE user_id=?").run(user.id);
    db.exec("UPDATE mail_settings SET enabled=1,transport='resend',sender_email='saved-sender@example.com',secrets_cipher='preserved-encrypted-secret'");
    db.prepare("INSERT INTO audit_logs(actor_id,action,created_at) VALUES(?,?,?)").run(user.id, "preserved.migration.fixture", testNow.toISOString());
    db.prepare("INSERT INTO reminder_deliveries(id,user_id,subscription_id,subscription_name,due_date,days_before,status,attempts,created_at,updated_at,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "v9-preserved-reminder", user.id, cloudItem.id, cloudItem.name, cloudItem.nextRenewal, 3, "sent", 1, testNow.toISOString(), testNow.toISOString(), testNow.toISOString(),
    );
    // Restore the deployed v8 schema with populated cloud, App, billing and account tables.
    db.exec("ALTER TABLE server_details DROP COLUMN icon; DROP TABLE merchant_overrides; DELETE FROM schema_migrations WHERE version>=9");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const oldMigrations = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    assert.equal((oldMigrations.at(-1) as any).version, 8);
    const oldSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='server_details'").get();
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(server_details)").all();
    db.exec("CREATE TRIGGER fail_v9_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=9 BEGIN SELECT RAISE(ABORT,'simulated v9 marker failure'); END");
    assert.throws(() => migrate(db), /simulated v9 marker failure/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='server_details'").get(), oldSchema);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), oldMigrations);
    db.exec("DROP TRIGGER fail_v9_migration");

    migrate(db);
    assert.deepEqual(snapshot(), { ...before, server_details: before.server_details!.map((row: any) => ({ ...row, icon: "auto" })) });
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<9 ORDER BY version").all(), oldMigrations);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=9").get() as any).n, 1);
    const iconColumn = (db.prepare("PRAGMA table_info(server_details)").all() as any[]).find(column => column.name === "icon");
    assert.equal(iconColumn.notnull, 1);
    assert.equal(iconColumn.dflt_value, "'auto'");
    assert.throws(() => db.prepare("UPDATE server_details SET icon=NULL WHERE subscription_id=?").run(cloudItem.id), /NOT NULL constraint failed/);
    const migratedData = snapshot();
    const migratedMarkers = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const migratedSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='server_details'").get();
    migrate(db);
    assert.deepEqual(snapshot(), migratedData);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), migratedMarkers);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='server_details'").get(), migratedSchema);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(server_details)").all(), foreignKeys);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((db.prepare("PRAGMA quick_check").get() as any).quick_check, "ok");
    const afterList = await f.request("/subscriptions", "GET", undefined, cookie).then(response => response.json()) as any;
    assert.deepEqual(afterList, beforeList);
    assert.equal(afterList.subscriptions.find((subscription: any) => subscription.id === appItem.id).appIcon, "spotify");
    db.prepare("UPDATE server_details SET icon='hetzner' WHERE subscription_id=?").run(cloudItem.id);
    migrate(db);
    assert.equal((db.prepare("SELECT icon FROM server_details WHERE subscription_id=?").get(cloudItem.id) as any).icon, "hetzner");
  } finally { f.cleanup(); }
});

test("v7 upgrade preserves foreign-currency cloud records, paid history and mail while pinning summaries to CNY", async () => {
  const f = await fixture();
  try {
    const { cookie, user } = await f.seedAccount("migrate-app@example.com");
    const response = await f.request("/subscriptions", "POST", { ...input, currency: "USD", ipAddresses: [{ type: "static", address: "203.0.113.17" }], autoRenew: true }, cookie);
    assert.equal(response.status, 201);
    const before = (await response.json() as any).subscription;
    const periods = f.runtime.db.prepare("SELECT * FROM billing_periods").all();
    const mail = f.runtime.db.prepare("SELECT * FROM mail_settings").all();
    f.runtime.db.prepare("UPDATE users SET currency='GBP' WHERE id=?").run(user.id);
    f.runtime.db.exec("DROP TABLE app_details; ALTER TABLE server_details DROP COLUMN icon; DROP TABLE merchant_overrides; DELETE FROM schema_migrations WHERE version>=7;");
    migrate(f.runtime.db); migrate(f.runtime.db);
    assert.equal((f.runtime.db.prepare("SELECT currency FROM users WHERE id=?").get(user.id) as any).currency, "CNY");
    assert.deepEqual((await f.request("/subscriptions", "GET", undefined, cookie).then(r => r.json()) as any).subscriptions[0], before);
    assert.deepEqual(f.runtime.db.prepare("SELECT * FROM billing_periods").all(), periods);
    assert.deepEqual(f.runtime.db.prepare("SELECT * FROM mail_settings").all(), mail);
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=7").get() as any).n, 1);
    assert.equal((f.runtime.db.prepare("PRAGMA foreign_key_check").all()).length, 0);
    assert.equal((f.runtime.db.prepare("PRAGMA quick_check").get() as any).quick_check, "ok");
  } finally { f.cleanup(); }
});

test("all new original currencies validate and unsafe or oversized App images are rejected", () => {
  const app = { ...input, type: "app", vendor: "", website: "", appPlan: "Plus", appChannel: "Google Play" };
  for (const appIcon of ["auto", "generic", "notion", "spotify", "icloud", "1password", "netflix", "youtube", "microsoft", "adobe", "chatgpt", "github"])
    assert.equal(subscriptionSchema.parse({ ...app, appIcon }).appIcon, appIcon);
  for (const currency of ["CNY", "USD", "EUR", "GBP", "NGN", "TRY", "PHP", "JPY", "TWD", "HKD"])
    assert.equal(subscriptionSchema.parse({ ...app, currency }).currency, currency);
  for (const website of ["javascript:alert(1)", "https://name:password@example.com"])
    assert.equal(subscriptionSchema.safeParse({ ...app, website }).success, false);
  for (const appIcon of ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "javascript:alert(1)", "https://evil.example/logo.png", "data:image/png;base64,bm90LXBpY3R1cmU=", "data:image/png;base64," + Buffer.alloc(70_000).toString("base64")])
    assert.equal(subscriptionSchema.safeParse({ ...app, appIcon }).success, false);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(subscriptionSchema.parse({ ...app, appIcon: png }).appIcon, png);
  assert.equal(subscriptionSchema.safeParse({ ...input, vendor: "", website: "" }).success, false);
});

test("automatic-renewal Apps still send shared reminder emails without extending their paid period", async () => {
  const messages: Parameters<SendMail>[0][] = [];
  const f = await fixture(async message => { messages.push(message); });
  try {
    const admin = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const { cookie, user } = await f.seedAccount("app-reminder@example.com");
    await f.request("/admin/mail", "PUT", { enabled: true, transport: "resend", senderEmail: "sender@example.com", resendApiKey: "example-test-app-reminder-key" }, admin);
    f.runtime.db.prepare("UPDATE notification_settings SET recipient_email='app-recipient@example.com',email_verified=1 WHERE user_id=?").run(user.id);
    const created = await f.request("/subscriptions", "POST", { ...input, type: "app", name: "Spotify", vendor: "Spotify", website: "", currency: "NGN", appPlan: "Premium", appChannel: "官网", appAccount: "personal-account", autoRenew: true, reminderDays: [3] }, cookie);
    assert.equal(created.status, 201, await created.clone().text());
    const item = (await created.json() as any).subscription;
    assert.deepEqual(await f.runtime.runReminders(testNow), { sent: 1, failed: 0 });
    assert.equal(messages[0]!.to, "app-recipient@example.com");
    assert.match(messages[0]!.subject, /Spotify/);
    assert.match(messages[0]!.text, /自动续费/);
    assert.match(messages[0]!.text, /NGN|₦/);
    assert.equal((f.runtime.db.prepare("SELECT next_renewal FROM subscriptions WHERE id=?").get(item.id) as any).next_renewal, item.nextRenewal);
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM billing_periods WHERE subscription_id=?").get(item.id) as any).n, 1);
    assert.deepEqual(await f.runtime.runReminders(testNow), { sent: 0, failed: 0 });
  } finally { f.cleanup(); }
});

test("FX loads every original currency, keeps valid quotes during partial failures and does not invent missing rates", async () => {
  const db = openDatabase(":memory:"); migrate(db);
  try {
    let requested = "";
    const rates = await createFx(db, async (url, options) => { requested = String(url); assert.ok(options?.signal); return fxFetch(url, options); }).get();
    for (const currency of ["NGN", "TRY", "PHP", "JPY", "TWD", "HKD"]) {
      assert.ok(requested.includes(currency)); assert.equal(rates.rates[currency], 0.1);
    }
    assert.equal(rates.stale, false);
    db.prepare("UPDATE exchange_rates SET fetched_at='2000-01-01T00:00:00Z'").run();
    const partial = await createFx(db, async () => new Response(JSON.stringify([
      { base: "CNY", quote: "USD", rate: 0.2, date: "2026-11-12" },
      { base: "CNY", quote: "NGN", rate: -1, date: "2026-11-12" },
      { base: "CNY", quote: "JPY", rate: 20, date: "2026-02-30" },
    ]))).get();
    assert.equal(partial.rates.USD, 5);
    assert.equal(partial.rates.NGN, 0.1);
    assert.equal(partial.rates.JPY, 0.1);
    assert.equal(partial.stale, true);
    db.prepare("DELETE FROM exchange_rates").run();
    const freshPartial = await createFx(db, async () => new Response(JSON.stringify([{ base: "CNY", quote: "USD", rate: 0.2, date: "2026-11-12" }]))).get();
    assert.deepEqual(freshPartial.rates, { CNY: 1, USD: 5 });
    assert.equal(freshPartial.stale, true);
    assert.equal(freshPartial.available, true);
  } finally { db.close(); }
});

test("concurrent renewal requests append exactly one paid billing period", async () => {
  const f = await fixture();
  try {
    const cookie = await f.login(
      "admin@example.com",
      "test-admin-password-strong-2026",
    );
    const created = await f.request(
      "/subscriptions",
      "POST",
      {
        ...input,
        periodStart: "2026-10-14",
        nextRenewal: "2026-11-14",
        paidAmount: 31,
        renewalPrice: 10,
        billingMonths: 1,
      },
      cookie,
    );
    assert.equal(created.status, 201);
    const { subscription } = (await created.json()) as any;
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        f.request(
          `/subscriptions/${subscription.id}/renew`,
          "POST",
          {
            paidAmount: 10,
            periodStart: "2026-11-14",
            nextRenewal: "2026-12-14",
          },
          cookie,
        ),
      ),
    );
    assert.equal(
      responses.filter((response) => response.status === 200).length,
      1,
    );
    assert.equal(
      responses.filter((response) => response.status === 409).length,
      9,
    );
    const periods = f.runtime.db
      .prepare(
        "SELECT COUNT(*) AS count FROM billing_periods WHERE subscription_id=?",
      )
      .get(subscription.id) as { count: number };
    assert.equal(periods.count, 2);
    const dashboard = (await f
      .request("/dashboard", "GET", undefined, cookie)
      .then((response) => response.json())) as any;
    assert.equal(dashboard.remainingValue, 12.17);
    assert.equal(dashboard.subscriptions[0].nextRenewal, "2026-12-14T00:00");
  } finally {
    f.cleanup();
  }
});

test("concurrent recipient updates reserve at most three verification sends", async () => {
  const messages: Parameters<SendMail>[0][] = [];
  const f = await fixture(async (message) => {
    messages.push(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  try {
    const cookie = await f.login(
      "admin@example.com",
      "test-admin-password-strong-2026",
    );
    const configured = await f.request(
      "/admin/mail",
      "PUT",
      {
        enabled: true,
        transport: "resend",
        senderName: "续记",
        senderEmail: "sender@example.com",
        resendApiKey: "example-key-for-concurrency-test",
      },
      cookie,
    );
    assert.equal(configured.status, 200);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        f.request(
          "/me/notification-settings",
          "PUT",
          {
            recipientEmail: `recipient-${index}@example.com`,
            enabled: true,
            reminderDays: [7, 3, 1],
            timeZone: "Asia/Shanghai",
          },
          cookie,
        ),
      ),
    );
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(messages.length, 3);
    const deliveries = f.runtime.db
      .prepare(
        "SELECT status FROM reminder_deliveries WHERE kind='verification'",
      )
      .all() as { status: string }[];
    assert.equal(deliveries.length, 3);
    assert.ok(deliveries.every((delivery) => delivery.status === "sent"));
    const denied = await f.request(
      "/me/notification-settings/send-verification",
      "POST",
      {},
      cookie,
    );
    assert.equal(denied.status, 503);
    assert.equal(messages.length, 3);
  } finally {
    f.cleanup();
  }
});

test("encrypted admin credentials, recipient verification, reminder dedupe and retry", async () => {
  const messages: any[] = [];
  let failReminder = true;
  const f = await fixture(async (message) => {
    if (message.subject.includes("天后到期") && failReminder)
      throw Error("simulated temporary failure");
    messages.push(message);
  });
  try {
    const cookie = await f.login(
      "admin@example.com",
      "test-admin-password-strong-2026",
    );
    const key = "example-mail-api-key-not-a-real-secret";
    const saved = await f.request(
      "/admin/mail",
      "PUT",
      {
        enabled: true,
        transport: "resend",
        senderName: "续记",
        senderEmail: "sender@example.com",
        resendApiKey: key,
      },
      cookie,
    );
    assert.equal(saved.status, 200, await saved.clone().text());
    const publicSettings = (await saved.json()) as any;
    assert.equal(publicSettings.resendKeyConfigured, true);
    assert.equal(JSON.stringify(publicSettings).includes(key), false);
    assert.equal(
      (
        f.runtime.db
          .prepare("SELECT secrets_cipher FROM mail_settings")
          .get() as any
      ).secrets_cipher.includes(key),
      false,
    );
    const prefs = await f.request(
      "/me/notification-settings",
      "PUT",
      {
        recipientEmail: "recipient@example.com",
        enabled: true,
        reminderDays: [3],
        timeZone: "Asia/Shanghai",
      },
      cookie,
    );
    assert.equal(prefs.status, 200);
    assert.equal(messages.length, 1);
    await f.request(
      "/subscriptions",
      "POST",
      { ...input, reminderDays: [3], autoRenew: true },
      cookie,
    );
    assert.deepEqual(await f.runtime.runReminders(testNow), {
      sent: 0,
      failed: 0,
    });
    const token = new URL(
      messages[0].text.match(/https?:\/\/\S+/)[0],
    ).searchParams.get("token");
    const verified = await f.request(`/notifications/verify?token=${token}`);
    assert.equal(verified.status, 303);
    assert.equal(
      (await f.request(`/notifications/verify?token=${token}`)).status,
      400,
    );
    const beforeMidnight = new Date("2026-11-11T15:59:00Z");
    assert.deepEqual(await f.runtime.runReminders(beforeMidnight), {
      sent: 0,
      failed: 1,
    });
    assert.deepEqual(await f.runtime.runReminders(beforeMidnight), {
      sent: 0,
      failed: 0,
    });
    failReminder = false;
    assert.deepEqual(
      await f.runtime.runReminders(
        new Date(beforeMidnight.getTime() + 17 * 60_000),
      ),
      { sent: 1, failed: 0 },
    );
    assert.deepEqual(
      await f.runtime.runReminders(
        new Date(beforeMidnight.getTime() + 32 * 60_000),
      ),
      { sent: 0, failed: 0 },
    );
    assert.match(messages[1].subject, /2天后到期/);
    assert.match(messages[1].text, /商家自动续费.*检查余额.*确认商家扣款成功/);
    assert.equal(
      (
        f.runtime.db
          .prepare(
            "SELECT COUNT(*) AS n FROM reminder_deliveries WHERE kind='reminder'",
          )
          .get() as any
      ).n,
      1,
    );
    const log = (await f
      .request("/me/reminder-log", "GET", undefined, cookie)
      .then((r) => r.json())) as any;
    assert.equal(
      log.deliveries.filter((r: any) => r.kind === "reminder")[0].status,
      "sent",
    );
  } finally {
    f.cleanup();
  }
});

test("disabled users are excluded from both reminder enqueue and queued retries", async () => {
  let attempts = 0;
  const f = await fixture(async () => {
    attempts++;
    if (attempts === 1) throw Error("temporary mail failure");
  });
  try {
    const adminCookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const { user, cookie } = await f.seedAccount("disabled-reminder@example.com", "提醒测试");
    await f.request("/admin/mail", "PUT", { enabled: true, transport: "resend", senderName: "续记", senderEmail: "sender@example.com", resendApiKey: "example-key-reminder-status-test" }, adminCookie);
    f.runtime.db.prepare("UPDATE notification_settings SET recipient_email='reminder@example.com',email_verified=1 WHERE user_id=?").run(user.id);
    await f.request("/subscriptions", "POST", { ...input, autoRenew: true, reminderDays: [3] }, cookie);
    assert.deepEqual(await f.runtime.runReminders(testNow), { sent: 0, failed: 1 });
    await f.request(`/admin/users/${user.id}`, "PATCH", { status: "disabled" }, adminCookie);
    assert.deepEqual(await f.runtime.runReminders(new Date(testNow.getTime() + 16 * 60_000)), { sent: 0, failed: 0 });
    assert.equal(attempts, 1);
    f.runtime.db.prepare("DELETE FROM reminder_deliveries WHERE kind='reminder'").run();
    assert.deepEqual(await f.runtime.runReminders(new Date(testNow.getTime() + 32 * 60_000)), { sent: 0, failed: 0 });
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) AS n FROM reminder_deliveries WHERE kind='reminder'").get() as any).n, 0);
    await f.request(`/admin/users/${user.id}`, "PATCH", { status: "active" }, adminCookie);
    assert.deepEqual(await f.runtime.runReminders(new Date(testNow.getTime() + 48 * 60_000)), { sent: 1, failed: 0 });
    assert.equal(attempts, 2);
  } finally { f.cleanup(); }
});

test("in-flight login rechecks account status and password before creating a session", async (t) => {
  const f = await fixture();
  try {
    const adminCookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const { user } = await f.seedAccount("login-race@example.com", "并发登录测试");
    let snapshotRead = () => {};
    const prepare = f.runtime.db.prepare.bind(f.runtime.db);
    t.mock.method(f.runtime.db, "prepare", (sql: string) => {
      const statement = prepare(sql);
      if (sql === "SELECT * FROM users WHERE email=?") {
        const get = statement.get.bind(statement);
        t.mock.method(statement, "get", (...values: unknown[]) => {
          const row = get(...values);
          if (values[0] === user.email) snapshotRead();
          return row;
        });
      }
      return statement;
    });
    function beginLogin() {
      const read = new Promise<void>(resolve => { snapshotRead = resolve; });
      const response = f.request("/auth/login", "POST", {
        email: user.email, password: "normal-user-password-2026",
      });
      return { read, response };
    }
    const disabledLogin = beginLogin();
    // Wait for the old active row to be read, without relying on wall-clock sleeps.
    await disabledLogin.read;
    const disabled = await f.request(`/admin/users/${user.id}`, "PATCH", { status: "disabled" }, adminCookie);
    assert.equal(disabled.status, 200);
    const rejected = await disabledLogin.response;
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get("set-cookie"), null);
    const sessionCount = () => (f.runtime.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(user.id) as { n: number }).n;
    assert.equal(sessionCount(), 0);
    await f.request(`/admin/users/${user.id}`, "PATCH", { status: "active" }, adminCookie);
    assert.equal(sessionCount(), 0, "re-enabling cannot revive an in-flight login session");

    const nextHash = await hashPassword("replacement-user-password-2026");
    const passwordChangedLogin = beginLogin();
    await passwordChangedLogin.read;
    f.runtime.db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(nextHash, user.id);
    const changedResponse = await passwordChangedLogin.response;
    assert.equal(changedResponse.status, 401);
    assert.equal(changedResponse.headers.get("set-cookie"), null);
    assert.equal(sessionCount(), 0);
  } finally { f.cleanup(); }
});

test("minute billing boundaries persist, calculate paid value, and reject nonexistent account times", async () => {
  let now = new Date("2026-11-11T12:00:00Z");
  const f = await fixture(undefined, () => now);
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const response = await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-11-11T19:30", nextRenewal: "2026-11-11T20:30", paidAmount: 100, billingMonths: 1 }, cookie);
    assert.equal(response.status, 201, await response.clone().text());
    const item = (await response.json() as any).subscription;
    assert.equal(item.nextRenewal, "2026-11-11T20:30");
    assert.equal(item.currentPeriod.endsAt, "2026-11-11T20:30");
    const summary = () => f.request("/dashboard", "GET", undefined, cookie).then(r => r.json()) as Promise<any>;
    assert.equal((await summary()).remainingValue, 50);
    now = new Date("2026-11-11T12:29:00Z");
    assert.equal((await summary()).remainingValue, 1.67);
    now = new Date("2026-11-11T12:31:00Z");
    assert.equal((await summary()).remainingValue, 0);
    assert.equal((await summary()).dueCount, 0);
    const renewal = await f.request(`/subscriptions/${item.id}/renew`, "POST", { paidAmount: 100, periodStart: item.nextRenewal, nextRenewal: addMonths(item.nextRenewal, 1) }, cookie);
    assert.equal(renewal.status, 200, await renewal.clone().text());
    assert.equal((await renewal.json() as any).subscription.nextRenewal, "2026-12-11T20:30");
    for (const nextRenewal of ["2026-11-11T19:29", "2026-11-11T24:00", "2026-02-30T12:00"])
      assert.equal((await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-11-11T19:30", nextRenewal }, cookie)).status, 400);
    assert.equal((await f.request("/me/preferences", "PUT", { currency: "CNY", timeZone: "America/New_York" }, cookie)).status, 200);
    assert.equal((await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-03-08T02:30", nextRenewal: "2026-04-08T02:30" }, cookie)).status, 400);
  } finally { f.cleanup(); }
});

test("minute reminders wait for the matching local time and preserve midnight delivery dedupe during v3 migration", async () => {
  const messages: Parameters<SendMail>[0][] = [];
  const f = await fixture(async message => { messages.push(message); });
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    const mail = await f.request("/admin/mail", "PUT", { enabled: true, transport: "resend", senderName: "续记", senderEmail: "sender@example.com", resendApiKey: "example-key-minute-reminders" }, cookie);
    assert.equal(mail.status, 200);
    f.runtime.db.prepare("UPDATE notification_settings SET recipient_email='reminder@example.com',email_verified=1").run();
    const created = await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-10-14T18:35", nextRenewal: "2026-11-14T18:35", reminderDays: [3], autoRenew: true }, cookie);
    assert.equal(created.status, 201);
    assert.deepEqual(await f.runtime.runReminders(new Date("2026-11-11T10:34:59Z")), { sent: 0, failed: 0 });
    assert.deepEqual(await f.runtime.runReminders(new Date("2026-11-11T10:35:00Z")), { sent: 1, failed: 0 });
    assert.deepEqual(await f.runtime.runReminders(new Date("2026-11-11T10:36:00Z")), { sent: 0, failed: 0 });
    assert.match(messages[0].text, /2026-11-14 18:35（Asia\/Shanghai）/);
    assert.match(messages[0].text, /商家自动续费/);
    const sameDay = await f.request("/subscriptions", "POST", { ...input, periodStart: "2026-10-14T18:35", nextRenewal: "2026-11-14T18:35", reminderDays: [1] }, cookie);
    assert.equal(sameDay.status, 201);
    assert.deepEqual(await f.runtime.runReminders(new Date("2026-11-14T00:00:00Z")), { sent: 1, failed: 0 });
    assert.match(messages[1].subject, /今天到期/);
    assert.doesNotMatch(messages[1].subject, /已到续费时间/);

    // Recreate the old date-only database representation and its sent delivery.
    for (const column of ["cpu_cores", "memory_value", "memory_unit", "disk_value", "disk_unit", "ip_addresses", "traffic_direction", "icon"])
      f.runtime.db.exec(`ALTER TABLE server_details DROP COLUMN ${column}`);
    f.runtime.db.exec("UPDATE subscriptions SET next_renewal=substr(next_renewal,1,10); UPDATE billing_periods SET starts_at=substr(starts_at,1,10),ends_at=substr(ends_at,1,10); UPDATE reminder_deliveries SET due_date=substr(due_date,1,10); DROP TABLE registration_codes; DROP TABLE registration_code_requests; DROP TABLE merchant_overrides; DELETE FROM schema_migrations WHERE version>=3;");
    migrate(f.runtime.db);
    migrate(f.runtime.db);
    assert.equal((f.runtime.db.prepare("SELECT due_date FROM reminder_deliveries WHERE kind='reminder'").get() as any).due_date, "2026-11-14T00:00");
    assert.deepEqual(await f.runtime.runReminders(new Date("2026-11-11T10:37:00Z")), { sent: 0, failed: 0 });
    assert.equal(messages.length, 2);
    assert.equal((f.runtime.db.prepare("SELECT COUNT(*) n FROM reminder_deliveries WHERE kind='reminder'").get() as any).n, 2);
  } finally { f.cleanup(); }
});

test("a skipped historical local day does not interrupt other reminder deliveries", async () => {
  const messages: Parameters<SendMail>[0][] = [];
  const f = await fixture(async message => { messages.push(message); });
  try {
    const cookie = await f.login("admin@example.com", "test-admin-password-strong-2026");
    await f.request("/me/preferences", "PUT", { currency: "CNY", timeZone: "Pacific/Apia" }, cookie);
    await f.request("/admin/mail", "PUT", { enabled: true, transport: "resend", senderName: "续记", senderEmail: "sender@example.com", resendApiKey: "example-key-historical-day" }, cookie);
    f.runtime.db.prepare("UPDATE notification_settings SET recipient_email='reminder@example.com',email_verified=1").run();
    const historical = await f.request("/subscriptions", "POST", { ...input, name: "历史订阅", periodStart: "2011-11-30T12:00", nextRenewal: "2011-12-31T12:00", reminderDays: [1] }, cookie);
    assert.equal(historical.status, 201);
    const current = await f.request("/subscriptions", "POST", { ...input, name: "正常订阅", reminderDays: [2] }, cookie);
    assert.equal(current.status, 201);
    assert.deepEqual(await f.runtime.runReminders(testNow), { sent: 1, failed: 0 });
    assert.match(messages[0].subject, /正常订阅/);
  } finally { f.cleanup(); }
});
