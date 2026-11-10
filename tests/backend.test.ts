import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addMonths, subscriptionSchema } from "../server/domain.js";
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
async function fixture(sendMail?: SendMail) {
  const dir = mkdtempSync(join(tmpdir(), "renewly-backend-"));
  const runtime = await createApp({
    config: config(dir),
    fetcher: fxFetch,
    sendMail,
    now: () => testNow,
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
  return {
    runtime,
    request,
    login,
    cleanup() {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("account ownership, role enforcement, CSRF, and quota validation", async () => {
  const f = await fixture();
  try {
    const register = async (email: string) => {
      const r = await f.request("/auth/register", "POST", {
        name: email,
        email,
        password: "normal-user-password-2026",
      });
      assert.equal(r.status, 200);
      return r.headers.get("set-cookie")!.split(";")[0]!;
    };
    const a = await register("a@example.com"),
      b = await register("b@example.com");
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
    assert.equal(before.remainingValue, 3);
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
    assert.equal(after.remainingValue, 13);
    assert.equal(after.upcomingTotal, 0);
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
    assert.equal(addMonths("2027-01-31", 1, 31), "2027-02-28");
    assert.equal(addMonths("2027-02-28", 1, 31), "2027-03-31");
    assert.equal(
      subscriptionSchema.safeParse({ ...input, periodStart: "2026-02-30" })
        .success,
      false,
    );
  } finally {
    f.cleanup();
  }
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
    assert.equal(dashboard.remainingValue, 13);
    assert.equal(dashboard.subscriptions[0].nextRenewal, "2026-12-14");
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
      { ...input, reminderDays: [3] },
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
