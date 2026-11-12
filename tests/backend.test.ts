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
    assert.deepEqual(subscription.ipAddresses, []);
    assert.equal((db.prepare("SELECT due_date FROM reminder_deliveries").get() as any).due_date, "2027-01-01T00:00");
    assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }]);
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
    f.runtime.db.exec("ALTER TABLE server_details DROP COLUMN traffic_direction; DROP TABLE registration_codes; DROP TABLE registration_code_requests; DELETE FROM schema_migrations WHERE version>=5;");
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
    for (const column of ["cpu_cores", "memory_value", "memory_unit", "disk_value", "disk_unit", "ip_addresses", "traffic_direction"])
      f.runtime.db.exec(`ALTER TABLE server_details DROP COLUMN ${column}`);
    f.runtime.db.exec("UPDATE subscriptions SET next_renewal=substr(next_renewal,1,10); UPDATE billing_periods SET starts_at=substr(starts_at,1,10),ends_at=substr(ends_at,1,10); UPDATE reminder_deliveries SET due_date=substr(due_date,1,10); DROP TABLE registration_codes; DROP TABLE registration_code_requests; DELETE FROM schema_migrations WHERE version>=3;");
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
