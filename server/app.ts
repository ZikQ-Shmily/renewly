import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { openDatabase, migrate, type DB } from "./db.js";
import {
  bootstrap,
  createSession,
  createUser,
  hashPassword,
  publicUser,
  sessionUser,
  tokenHash,
  verifyPassword,
} from "./auth.js";
import {
  currencies,
  appConfiguration,
  dateSchema,
  daysSchema,
  listSubscriptions,
  serverConfiguration,
  serializeSubscription,
  subscriptionSchema,
  timeZoneSchema,
  totals,
} from "./domain.js";
import { createFx } from "./fx.js";
import { createMail, type SendMail } from "./mail.js";
import { createReminders } from "./reminders.js";
import { createRegistration, RegistrationError } from "./registration.js";
import { dateTimeInstant } from "../shared/datetime.js";
import { listMerchants, createMerchant, updateMerchant, resetMerchant, MerchantError } from "./merchants.js";

class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (
  status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
  code: string,
  message: string,
): never => {
  throw new ApiError(status, code, message);
};
const email = z.string().trim().toLowerCase().max(254).email("邮箱格式无效");
const password = z
  .string()
  .min(12, "密码至少12个字符")
  .max(128, "密码最多128个字符");
const mailSchema = z.object({
  enabled: z.boolean().optional(),
  transport: z.enum(["smtp", "resend"]).optional(),
  senderName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((v) => !/[\r\n]/.test(v))
    .optional(),
  senderEmail: z.union([email, z.literal("")]).optional(),
  smtpHost: z.string().trim().max(253).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().max(254).optional(),
  smtpPass: z.string().max(4096).optional(),
  resendApiKey: z.string().max(4096).optional(),
});
const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  role: z.enum(["user", "admin"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine(value => Object.keys(value).length > 0, "请填写需要更新的信息。");
const cookieName = "renewly_session";
export interface AppOptions {
  config?: Config;
  db?: DB;
  fetcher?: typeof fetch;
  sendMail?: SendMail;
  now?: () => Date;
}
export async function createApp(options: AppOptions = {}) {
  const config = options.config || loadConfig(),
    db = options.db || openDatabase(config.dbPath),
    clock = options.now || (() => new Date());
  migrate(db);
  await bootstrap(db, config);
  const fx = createFx(db, options.fetcher),
    mail = createMail(db, config, options.fetcher, options.sendMail),
    registration = createRegistration(db, config, mail, clock),
    runReminders = createReminders(db, mail, config);
  const dummyHash = await hashPassword(randomUUID());
  const app = new Hono<{ Variables: { user: any } }>();
  const limits = new Map<string, { count: number; until: number }>();
  function rate(key: string, max: number, period: number) {
    const now = Date.now();
    if (limits.size > 10000)
      for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    const item = limits.get(key);
    if (!item || item.until < now) {
      limits.set(key, { count: 1, until: now + period });
      return;
    }
    if (++item.count > max)
      fail(429, "RATE_LIMIT", "操作过于频繁，请稍后再试。");
  }
  const ip = (c: any) =>
    config.trustProxy
      ? (c.req.header("x-forwarded-for") || "unknown")
          .split(",")[0]
          .trim()
          .slice(0, 100)
      : c.env?.incoming?.socket?.remoteAddress || "local";
  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    }),
  );
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 131072,
      onError: (c) =>
        c.json(
          { error: { code: "BODY_TOO_LARGE", message: "请求内容过大。" } },
          413,
        ),
    }),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/api/v1/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const devOrigins = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ];
      if (
        !origin ||
        (origin !== config.appUrl &&
          (config.production || !devOrigins.includes(origin)))
      )
        fail(403, "INVALID_ORIGIN", "请求来源校验失败，请从本站页面操作。");
      if (c.req.header("sec-fetch-site") === "cross-site")
        fail(403, "INVALID_ORIGIN", "跨站请求已被拒绝。");
    }
    const publicPaths = [
      "/api/v1/auth/config",
      "/api/v1/auth/login",
      "/api/v1/auth/register",
      "/api/v1/auth/register/code",
      "/api/v1/notifications/verify",
    ];
    if (!publicPaths.includes(c.req.path)) {
      const user = sessionUser(db, getCookie(c, cookieName));
      if (!user) fail(401, "UNAUTHENTICATED", "请先登录。");
      c.set("user", user);
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof MerchantError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof RegistrationError) {
      if (error.retryAfter) c.header("Retry-After", String(error.retryAfter));
      return c.json({ error: { code: error.code, message: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } }, error.status);
    }
    if (error instanceof ApiError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: error.issues[0]?.message || "输入内容无效。",
          },
        },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json(
        { error: { code: "INVALID_JSON", message: "请求 JSON 格式无效。" } },
        400,
      );
    console.error("Request failed:", error.name);
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "服务暂时不可用，请稍后重试。",
        },
      },
      500,
    );
  });
  app.get("/api/health", (c) => {
    db.prepare("SELECT 1").get();
    return c.json({ status: "ok", version: "0.1.0", db: "ok" });
  });
  const userId = (c: any) => c.get("user").id as string;
  const admin = (c: any) => {
    if (c.get("user").role !== "admin")
      fail(403, "FORBIDDEN", "此功能仅供管理员使用。");
  };
  function attachSession(c: any, user: any) {
    const session = createSession(db, user.id);
    setCookie(c, cookieName, session.token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "Lax",
      path: "/",
      expires: new Date(session.expires),
    });
    return c.json({ user: publicUser(user) });
  }
  function owned(id: string, owner: string) {
    const row = db
      .prepare("SELECT * FROM subscriptions WHERE id=? AND user_id=?")
      .get(id, owner) as any;
    if (!row) fail(404, "NOT_FOUND", "订阅不存在。");
    return row;
  }
  const getPrefs = (id: string) => {
    const p = db
      .prepare(
        "SELECT n.*,u.time_zone FROM notification_settings n JOIN users u ON u.id=n.user_id WHERE user_id=?",
      )
      .get(id) as any;
    return {
      recipientEmail: p.recipient_email,
      emailVerified: !!p.email_verified,
      enabled: !!p.enabled,
      reminderDays: JSON.parse(p.reminder_days),
      timeZone: p.time_zone,
      mailAvailable: mail.available(),
    };
  };
  app.get("/api/v1/auth/config", (c) =>
    c.json({
      registrationEnabled: config.registrationEnabled,
      registrationVerificationRequired: true,
      registrationMailAvailable: mail.available(),
      adminConfigured: !!db
        .prepare("SELECT id FROM users WHERE role='admin' LIMIT 1")
        .get(),
    }),
  );
  app.post("/api/v1/auth/register/code", async (c) => {
    if (!config.registrationEnabled)
      fail(403, "REGISTRATION_DISABLED", "注册已关闭，请联系管理员。");
    const v = z.object({ email }).parse(await c.req.json());
    return c.json(await registration.sendCode(v.email, ip(c)));
  });
  app.post("/api/v1/auth/register", async (c) => {
    if (!config.registrationEnabled)
      fail(403, "REGISTRATION_DISABLED", "注册已关闭，请联系管理员。");
    rate(`register:${ip(c)}`, 6, 3600_000);
    const v = z
      .object({ email, password, name: z.string().trim().min(1).max(60), verificationCode: z.string().trim().regex(/^\d{6}$/, "请输入6位邮箱验证码。") })
      .parse(await c.req.json());
    const user = await registration.register(v);
    return attachSession(c, user);
  });
  app.post("/api/v1/auth/login", async (c) => {
    rate(`login:${ip(c)}`, 30, 15 * 60_000);
    const v = z
      .object({ email, password: z.string().min(1).max(128) })
      .parse(await c.req.json());
    rate(`login-email:${v.email}`, 15, 15 * 60_000);
    const user = db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(v.email) as any;
    const okay = await verifyPassword(
      v.password,
      user?.password_hash || dummyHash,
    );
    // Password derivation is asynchronous: account access may change meanwhile.
    const current = user
      ? db.prepare("SELECT * FROM users WHERE id=?").get(user.id) as any
      : null;
    if (!current || !okay || current.status !== "active" || current.password_hash !== user.password_hash)
      fail(401, "INVALID_CREDENTIALS", "邮箱或密码不正确，或账号已停用。");
    return attachSession(c, current);
  });
  app.post("/api/v1/auth/logout", (c) => {
    const token = getCookie(c, cookieName);
    if (token)
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
        tokenHash(token),
      );
    deleteCookie(c, cookieName, {
      path: "/",
      secure: config.cookieSecure,
      sameSite: "Lax",
    });
    return c.json({ ok: true });
  });
  app.get("/api/v1/me", (c) => c.json({ user: publicUser(c.get("user")) }));
  function validatePeriod(start: string, end: string, timeZone: string) {
    let startsAt: number, endsAt: number;
    try {
      startsAt = dateTimeInstant(start, timeZone);
      endsAt = dateTimeInstant(end, timeZone);
    } catch {
      return fail(400, "INVALID_DATE_TIME", "日期时间在当前账户时区无效，请检查日期、小时和分钟（含夏令时调整）。");
    }
    if (endsAt <= startsAt) fail(400, "INVALID_PERIOD", "账期截止时间需要晚于开始时间。");
    return { startsAt, endsAt };
  }
  function validateStoredTimeZone(owner: string, timeZone: string) {
    const values = db.prepare("SELECT next_renewal AS value FROM subscriptions WHERE user_id=? UNION SELECT starts_at AS value FROM billing_periods WHERE user_id=? UNION SELECT ends_at AS value FROM billing_periods WHERE user_id=?").all(owner, owner, owner) as { value: string }[];
    try { values.forEach(({ value }) => dateTimeInstant(value, timeZone)); }
    catch { fail(400, "INVALID_TIME_ZONE_SCHEDULE", "已有账期时间在此时区无效，请先核对夏令时切换日期的小时和分钟。"); }
  }
  app.put("/api/v1/me/preferences", async (c) => {
    const v = z
      .object({ currency: z.enum(currencies), timeZone: timeZoneSchema })
      .parse(await c.req.json());
    validateStoredTimeZone(userId(c), v.timeZone);
    db.prepare("UPDATE users SET currency=?,time_zone=? WHERE id=?").run(
      "CNY",
      v.timeZone,
      userId(c),
    );
    return c.json({
      user: publicUser(
        db.prepare("SELECT * FROM users WHERE id=?").get(userId(c)),
      ),
    });
  });
  app.get("/api/v1/types", (c) =>
    c.json({ types: [{ key: "app", name: "App 订阅", icon: "app-window" }, { key: "cloud", name: "云服务器", icon: "server" }] }),
  );
  app.get("/api/v1/subscriptions", (c) =>
    c.json({ subscriptions: listSubscriptions(db, userId(c), c.get("user").time_zone, clock()) }),
  );
  app.post("/api/v1/subscriptions", async (c) => {
    const v = subscriptionSchema.parse(await c.req.json()),
      id = randomUUID(),
      owner = userId(c),
      now = clock().toISOString();
    const reminderDays = v.reminderDays ?? getPrefs(owner).reminderDays;
    validatePeriod(v.periodStart, v.nextRenewal, c.get("user").time_zone);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO subscriptions(id,user_id,type_key,name,vendor,website,currency,purchase_minor,renewal_minor,billing_months,billing_anchor_day,next_renewal,status,notes,reminder_days,created_at,updated_at,auto_renew) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        owner,
        v.type,
        v.name,
        v.vendor,
        v.website,
        v.currency,
        Math.round(v.purchasePrice * 100),
        Math.round(v.renewalPrice * 100),
        v.billingMonths,
        Math.max(
          Number(v.periodStart.slice(8, 10)),
          Number(v.nextRenewal.slice(8, 10)),
        ),
        v.nextRenewal,
        v.status,
        v.notes,
        JSON.stringify(reminderDays),
        now,
        now,
        Number(v.autoRenew),
      );
      if (v.type === "cloud") db.prepare("INSERT INTO server_details(subscription_id,region,model,traffic_mode,traffic_quota_bytes,traffic_unit,bandwidth_value,bandwidth_unit,cpu_cores,memory_value,memory_unit,disk_value,disk_unit,ip_addresses,traffic_direction,icon) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        id,
        v.region,
        v.model,
        v.trafficMode,
        v.trafficMode === "limited"
          ? Math.round(v.trafficQuota! * (v.trafficUnit === "TB" ? 1e12 : 1e9))
          : null,
        v.trafficUnit,
        v.bandwidthValue,
        v.bandwidthUnit,
        v.cpuCores,
        v.memoryValue,
        v.memoryUnit,
        v.diskValue,
        v.diskUnit,
        JSON.stringify(v.ipAddresses),
        v.trafficDirection,
        v.serverIcon,
      );
      else db.prepare("INSERT INTO app_details(subscription_id,plan,purchase_channel,account,icon) VALUES(?,?,?,?,?)").run(id,v.appPlan,v.appChannel,v.appAccount,v.appIcon);
      db.prepare(
        "INSERT INTO billing_periods(subscription_id,user_id,starts_at,ends_at,paid_minor,currency,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        owner,
        v.periodStart,
        v.nextRenewal,
        Math.round(v.paidAmount * 100),
        v.currency,
        now,
      );
    })();
    return c.json(
      { subscription: serializeSubscription(db, owned(id, owner), c.get("user").time_zone, clock()) },
      201,
    );
  });
  app.put("/api/v1/subscriptions/:id", async (c) => {
    const old = owned(c.req.param("id"), userId(c));
    const details = db.prepare("SELECT * FROM server_details WHERE subscription_id=?").get(old.id);
    const appDetails = db.prepare("SELECT * FROM app_details WHERE subscription_id=?").get(old.id);
    const payload = z.object({}).catchall(z.unknown()).parse(await c.req.json());
    // Preserve stored detail fields omitted by older clients.
    const v = subscriptionSchema.parse({ ...serverConfiguration(details), ...appConfiguration(appDetails), ...payload });
    if (v.type !== old.type_key) fail(400, "IMMUTABLE_SUBSCRIPTION_TYPE", "订阅类别不能在编辑时更改，请在对应类别新增记录。");
    const now = clock().toISOString();
    const timeZone = c.get("user").time_zone;
    const instants = validatePeriod(v.periodStart, v.nextRenewal, timeZone);
    const period = db
      .prepare(
        "SELECT * FROM billing_periods WHERE subscription_id=? AND user_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(old.id, userId(c)) as any;
    const previous = db
      .prepare(
        "SELECT MAX(ends_at) AS ends_at FROM billing_periods WHERE subscription_id=? AND user_id=? AND id!=?",
      )
      .get(old.id, userId(c), period.id) as any;
    if (previous.ends_at && instants.startsAt < dateTimeInstant(previous.ends_at, timeZone))
      fail(
        400,
        "OVERLAPPING_PERIOD",
        "账期开始日期不能与已保存的历史账期重叠。",
      );
    const anchor =
      v.periodStart !== period.starts_at ||
      v.nextRenewal !== old.next_renewal ||
      v.billingMonths !== old.billing_months
        ? Math.max(
            Number(v.periodStart.slice(8, 10)),
            Number(v.nextRenewal.slice(8, 10)),
          )
        : old.billing_anchor_day;
    db.transaction(() => {
      db.prepare(
        "UPDATE subscriptions SET name=?,vendor=?,website=?,currency=?,purchase_minor=?,renewal_minor=?,billing_months=?,billing_anchor_day=?,next_renewal=?,status=?,notes=?,reminder_days=?,updated_at=?,auto_renew=? WHERE id=? AND user_id=?",
      ).run(
        v.name,
        v.vendor,
        v.website,
        v.currency,
        Math.round(v.purchasePrice * 100),
        Math.round(v.renewalPrice * 100),
        v.billingMonths,
        anchor,
        v.nextRenewal,
        v.status,
        v.notes,
        JSON.stringify(v.reminderDays ?? JSON.parse(old.reminder_days)),
        now,
        Number(v.autoRenew),
        old.id,
        userId(c),
      );
      if (v.type === "cloud") db.prepare(
        "UPDATE server_details SET region=?,model=?,traffic_mode=?,traffic_quota_bytes=?,traffic_unit=?,bandwidth_value=?,bandwidth_unit=?,cpu_cores=?,memory_value=?,memory_unit=?,disk_value=?,disk_unit=?,ip_addresses=?,traffic_direction=?,icon=? WHERE subscription_id=?",
      ).run(
        v.region,
        v.model,
        v.trafficMode,
        v.trafficMode === "limited"
          ? Math.round(v.trafficQuota! * (v.trafficUnit === "TB" ? 1e12 : 1e9))
          : null,
        v.trafficUnit,
        v.bandwidthValue,
        v.bandwidthUnit,
        v.cpuCores,
        v.memoryValue,
        v.memoryUnit,
        v.diskValue,
        v.diskUnit,
        JSON.stringify(v.ipAddresses),
        v.trafficDirection,
        v.serverIcon,
        old.id,
      );
      else db.prepare("INSERT INTO app_details(subscription_id,plan,purchase_channel,account,icon) VALUES(?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET plan=excluded.plan,purchase_channel=excluded.purchase_channel,account=excluded.account,icon=excluded.icon").run(old.id,v.appPlan,v.appChannel,v.appAccount,v.appIcon);
      db.prepare(
        "UPDATE billing_periods SET starts_at=?,ends_at=?,paid_minor=?,currency=? WHERE id=? AND user_id=?",
      ).run(
        v.periodStart,
        v.nextRenewal,
        Math.round(v.paidAmount * 100),
        v.currency,
        period.id,
        userId(c),
      );
    })();
    return c.json({
      subscription: serializeSubscription(db, owned(old.id, userId(c)), c.get("user").time_zone, clock()),
    });
  });
  app.delete("/api/v1/subscriptions/:id", (c) => {
    owned(c.req.param("id"), userId(c));
    db.prepare(
      "UPDATE subscriptions SET status='archived',updated_at=? WHERE id=? AND user_id=?",
    ).run(clock().toISOString(), c.req.param("id"), userId(c));
    return c.json({ ok: true });
  });
  app.post("/api/v1/subscriptions/:id/renew", async (c) => {
    const old = owned(c.req.param("id"), userId(c)),
      v = z
        .object({
          paidAmount: z
            .number()
            .finite()
            .min(0)
            .max(1e9)
            .refine(
              (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001,
              "金额最多保留两位小数",
            ),
          periodStart: dateSchema,
          nextRenewal: dateSchema,
        })
        .parse(await c.req.json());
    const instants = validatePeriod(v.periodStart, v.nextRenewal, c.get("user").time_zone);
    if (instants.startsAt < dateTimeInstant(old.next_renewal, c.get("user").time_zone))
      fail(
        400,
        "INVALID_PERIOD",
        "新账期应从旧账期结束后开始，且截止日期晚于开始日期。",
      );
    const now = clock().toISOString();
    db.transaction(() => {
      const current = owned(old.id, userId(c));
      if (
        current.next_renewal !== old.next_renewal ||
        current.updated_at !== old.updated_at
      )
        fail(409, "SUBSCRIPTION_CHANGED", "订阅已更新，请刷新后核对账期。");
      db.prepare(
        "INSERT INTO billing_periods(subscription_id,user_id,starts_at,ends_at,paid_minor,currency,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        old.id,
        userId(c),
        v.periodStart,
        v.nextRenewal,
        Math.round(v.paidAmount * 100),
        old.currency,
        now,
      );
      db.prepare(
        "UPDATE subscriptions SET next_renewal=?,status='active',updated_at=? WHERE id=? AND user_id=?",
      ).run(v.nextRenewal, now, old.id, userId(c));
    })();
    return c.json({
      subscription: serializeSubscription(db, owned(old.id, userId(c)), c.get("user").time_zone, clock()),
    });
  });
  app.get("/api/v1/exchange-rates", async (c) => c.json(await fx.get()));
  app.get("/api/v1/dashboard", async (c) => {
    const typeKey = z.enum(["cloud", "app"]).optional().parse(c.req.query("type"));
    const target = "CNY",
      rates = await fx.get();
    return c.json({
      ...totals(
        db,
        userId(c),
        c.get("user").time_zone,
        target,
        rates.rates,
        clock(),
        typeKey,
      ),
      rates: {
        date: rates.date,
        fetchedAt: rates.fetchedAt,
        stale: rates.stale,
        available: rates.available,
      },
    });
  });
  app.get("/api/v1/me/notification-settings", (c) =>
    c.json(getPrefs(userId(c))),
  );
  app.put("/api/v1/me/notification-settings", async (c) => {
    const v = z
        .object({
          recipientEmail: z.union([email, z.literal("")]),
          enabled: z.boolean(),
          reminderDays: daysSchema,
          timeZone: timeZoneSchema,
        })
        .parse(await c.req.json()),
      old = getPrefs(userId(c)),
      changed = old.recipientEmail !== v.recipientEmail;
    validateStoredTimeZone(userId(c), v.timeZone);
    db.transaction(() => {
      db.prepare(
        "UPDATE notification_settings SET recipient_email=?,email_verified=?,enabled=?,reminder_days=? WHERE user_id=?",
      ).run(
        v.recipientEmail,
        changed ? 0 : Number(old.emailVerified),
        Number(v.enabled),
        JSON.stringify(v.reminderDays),
        userId(c),
      );
      db.prepare("UPDATE users SET time_zone=? WHERE id=?").run(
        v.timeZone,
        userId(c),
      );
      db.prepare(
        "UPDATE subscriptions SET reminder_days=? WHERE user_id=? AND reminder_days=?",
      ).run(
        JSON.stringify(v.reminderDays),
        userId(c),
        JSON.stringify(old.reminderDays),
      );
      if (changed)
        db.prepare("DELETE FROM email_verifications WHERE user_id=?").run(
          userId(c),
        );
    })();
    let verificationMessage: string | undefined;
    if (changed && v.recipientEmail && mail.available()) {
      try {
        await mail.verification(userId(c));
        verificationMessage = "验证邮件已发送。";
      } catch (error) {
        verificationMessage = (error as Error).message;
      }
    }
    return c.json({
      ...getPrefs(userId(c)),
      ...(verificationMessage ? { verificationMessage } : {}),
    });
  });
  app.post("/api/v1/me/notification-settings/send-verification", async (c) => {
    rate(`verify:${userId(c)}`, 3, 15 * 60_000);
    try {
      await mail.verification(userId(c));
    } catch (error) {
      fail(503, "MAIL_UNAVAILABLE", (error as Error).message);
    }
    return c.json({ ok: true, message: "验证邮件已发送，请查看收件箱。" });
  });
  app.get("/api/v1/notifications/verify", (c) => {
    const token = c.req.query("token") || "";
    if (token.length > 200)
      fail(400, "INVALID_TOKEN", "验证链接无效或已过期。");
    const record = db
      .prepare(
        "SELECT * FROM email_verifications WHERE token_hash=? AND expires_at>?",
      )
      .get(tokenHash(token), clock().toISOString()) as any;
    if (!record) fail(400, "INVALID_TOKEN", "验证链接无效或已过期。");
    const changed = db.transaction(() => {
      const result = db
        .prepare(
          "UPDATE notification_settings SET email_verified=1 WHERE user_id=? AND recipient_email=?",
        )
        .run(record.user_id, record.email);
      db.prepare("DELETE FROM email_verifications WHERE token_hash=?").run(
        tokenHash(token),
      );
      return result.changes;
    })();
    if (!changed) fail(400, "INVALID_TOKEN", "收件邮箱已更改，请重新验证。");
    return c.redirect("/?emailVerified=1#reminders", 303);
  });
  const logs = (owner?: string) => {
    const query = owner
      ? "SELECT * FROM reminder_deliveries WHERE user_id=? ORDER BY created_at DESC LIMIT 100"
      : "SELECT * FROM reminder_deliveries ORDER BY created_at DESC LIMIT 100";
    const rows = (
      owner ? db.prepare(query).all(owner) : db.prepare(query).all()
    ) as any[];
    return rows.map((r) => ({
      id: r.id,
      subscriptionName: r.subscription_name || undefined,
      daysBefore: r.days_before ?? undefined,
      status: r.status,
      kind: r.kind,
      sentAt: r.sent_at || undefined,
      createdAt: r.created_at,
      error: r.error || undefined,
    }));
  };
  app.get("/api/v1/me/reminder-log", (c) =>
    c.json({ deliveries: logs(userId(c)) }),
  );
  const managedUsersQuery = `
    SELECT u.id,u.name,u.email,u.role,u.status,u.created_at,
      n.recipient_email,n.email_verified,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id=u.id AND s.status!='archived') AS subscription_count
    FROM users u LEFT JOIN notification_settings n ON n.user_id=u.id
  `;
  const managedUser = (row: any) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    recipientEmail: row.recipient_email || "",
    emailVerified: !!row.email_verified,
    subscriptionCount: row.subscription_count,
    createdAt: row.created_at,
  });
  app.get("/api/v1/merchants", (c) => c.json({ merchants: listMerchants(db) }));
  app.post("/api/v1/admin/merchants", async (c) => {
    admin(c);
    return c.json({ merchant: createMerchant(db, await c.req.json()) }, 201);
  });
  app.patch("/api/v1/admin/merchants/:key", async (c) => {
    admin(c);
    return c.json({ merchant: updateMerchant(db, c.req.param("key"), await c.req.json()) });
  });
  app.delete("/api/v1/admin/merchants/:key", (c) => {
    admin(c);
    return c.json({ merchant: resetMerchant(db, c.req.param("key")) });
  });
  app.get("/api/v1/admin/users", (c) => {
    admin(c);
    const rows = db.prepare(`${managedUsersQuery} ORDER BY u.created_at,u.email`).all();
    return c.json({ users: rows.map(managedUser) });
  });
  app.patch("/api/v1/admin/users/:id", async (c) => {
    admin(c);
    const changes = userUpdateSchema.parse(await c.req.json());
    const targetId = c.req.param("id");
    db.transaction(() => {
      // Recheck authorization after parsing the asynchronous request body.
      const actor = db.prepare("SELECT role,status FROM users WHERE id=?").get(userId(c)) as any;
      if (actor?.role !== "admin" || actor.status !== "active")
        fail(403, "FORBIDDEN", "此功能仅供管理员使用。");
      const old = db.prepare("SELECT id,name,role,status FROM users WHERE id=?").get(targetId) as any;
      if (!old) fail(404, "USER_NOT_FOUND", "用户不存在。");
      const next = { ...old, ...changes };
      if (targetId === userId(c) && (next.role !== "admin" || next.status !== "active"))
        fail(409, "CURRENT_ADMIN_PROTECTED", "不能降权或停用当前登录管理员。");
      if (old.role === "admin" && old.status === "active" && (next.role !== "admin" || next.status !== "active")) {
        const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get() as { n: number };
        if (count.n <= 1) fail(409, "LAST_ADMIN_PROTECTED", "请保留至少一位正常的管理员。");
      }
      db.prepare("UPDATE users SET name=?,role=?,status=? WHERE id=?").run(next.name, next.role, next.status, targetId);
      if (next.status === "disabled" || next.role !== old.role)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(targetId);
      if (next.status === "disabled")
        db.prepare("DELETE FROM email_verifications WHERE user_id=?").run(targetId);
      db.prepare("INSERT INTO audit_logs(actor_id,action,created_at) VALUES(?,?,?)").run(
        userId(c), JSON.stringify({ action: "user.updated", targetId, changes }), clock().toISOString(),
      );
    })();
    return c.json({ user: managedUser(db.prepare(`${managedUsersQuery} WHERE u.id=?`).get(targetId)) });
  });
  app.get("/api/v1/admin/mail", (c) => {
    admin(c);
    return c.json(mail.settings());
  });
  app.put("/api/v1/admin/mail", async (c) => {
    admin(c);
    const v = mailSchema.parse(await c.req.json());
    try {
      return c.json(mail.save(v, userId(c)));
    } catch (error) {
      fail(400, "MAIL_CONFIG_INVALID", (error as Error).message);
    }
  });
  app.post("/api/v1/admin/mail/test", async (c) => {
    admin(c);
    rate(`mailtest:${userId(c)}`, 6, 15 * 60_000);
    const v = z.object({ recipientEmail: email }).parse(await c.req.json());
    try {
      await mail.send({
        to: v.recipientEmail,
        subject: "续记 · 邮件服务测试",
        text: "这是一封续记邮件服务测试邮件。发信服务已成功连接。",
        html: "<h2>续记邮件服务测试</h2><p>发信服务已成功连接。</p>",
      });
      mail.deliveryLog(userId(c), "test", "sent");
    } catch (error) {
      mail.deliveryLog(userId(c), "test", "failed", (error as Error).message);
      fail(503, "MAIL_DELIVERY_FAILED", (error as Error).message);
    }
    return c.json({ ok: true, message: "测试邮件已提交投递，请检查收件箱。" });
  });
  app.get("/api/v1/admin/mail/logs", (c) => {
    admin(c);
    return c.json({ deliveries: logs() });
  });
  app.all("/api/*", (c) =>
    c.json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }, 404),
  );
  if (existsSync(join(config.clientDir, "index.html"))) {
    app.use("/assets/*", serveStatic({ root: config.clientDir }));
    app.use("/favicon.svg", serveStatic({ root: config.clientDir }));
    app.use("/app-icons/*", serveStatic({ root: config.clientDir }));
    app.use("/theme-init.js", async (c, next) => {
      c.header("Cache-Control", "no-cache");
      await next();
    }, serveStatic({ root: config.clientDir }));
    app.get("*", (c) => {
      c.header("Cache-Control", "no-cache");
      return c.html(readFileSync(join(config.clientDir, "index.html"), "utf8"));
    });
  } else
    app.get("*", (c) =>
      c.text(
        "Renewly API is running. Run npm run build to build the frontend.",
        200,
      ),
    );
  return { app, db, config, fx, mail, runReminders, close: () => db.close() };
}
