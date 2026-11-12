import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import type { Config } from "../server/config.js";
import type { MailMessage, SendMail } from "../server/mail.js";
import { createRegistration, RegistrationError } from "../server/registration.js";

const origin = "http://localhost:3000";
const password = "registration-test-password-2026";
const address = "new@example.com";
const codeOf = (message: MailMessage) => {
  const match = message.text.match(/\b\d{6}\b/);
  assert.ok(match, "a six-digit code must be present in the delivered mail");
  return match[0];
};
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";

async function fixture(deliver?: SendMail, enabled = true) {
  let instant = new Date("2026-11-12T08:00:00Z").getTime();
  const clock = () => new Date(instant);
  const config: Config = {
    dataDir: ".",
    dbPath: ":memory:",
    appUrl: origin,
    secret: "registration-test-secret-with-sufficient-entropy",
    production: false,
    port: 3000,
    registrationEnabled: enabled,
    cookieSecure: false,
    trustProxy: true,
    bootstrapEmail: "admin@example.com",
    bootstrapPassword: password,
    reminderIntervalMs: 60_000,
    clientDir: "/no-renewly-registration-test-client",
  };
  const messages: MailMessage[] = [];
  const runtime = await createApp({
    config,
    db: openDatabase(":memory:"),
    now: clock,
    fetcher: async () => { throw new Error("No network access expected in registration tests"); },
    sendMail: async (message) => {
      messages.push(message);
      await deliver?.(message);
    },
  });
  const admin = runtime.db.prepare("SELECT id FROM users WHERE role='admin'").get() as { id: string };
  const enableMail = () => runtime.mail.save({
    enabled: true,
    transport: "smtp",
    senderEmail: "sender@example.com",
    smtpHost: "smtp.example.com",
    smtpUser: "sender@example.com",
    smtpPass: "injected-test-mail-password",
  }, admin.id);
  const service = () => createRegistration(runtime.db, config, runtime.mail, clock);
  const request = async (path: string, body?: unknown, ip = "192.0.2.1", requestOrigin = origin) => runtime.app.request(`/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin: requestOrigin, "x-forwarded-for": ip, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const signup = (verificationCode: string, email = address) => ({ email, name: "测试用户", password, verificationCode });
  const count = (table: string) => (runtime.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { runtime, config, messages, request, enableMail, signup, service, count, advance: (ms: number) => { instant += ms; }, close: runtime.close };
}

test("self-registration fails closed without mail; existing users can still sign in; registration switch is enforced", async () => {
  const f = await fixture();
  try {
    const status = await f.request("/auth/config").then(r => r.json()) as any;
    assert.equal(status.registrationVerificationRequired, true);
    assert.equal(status.registrationMailAvailable, false);
    for (const [path, body] of [["/auth/register/code", { email: address }], ["/auth/register", f.signup("123456")]] as const) {
      const response = await f.request(path, body);
      assert.equal(response.status, 503);
      assert.equal(response.headers.has("set-cookie"), false);
    }
    assert.equal(f.count("registration_code_requests"), 0);
    assert.equal(f.count("users"), 1);
    assert.equal((await f.request("/auth/login", { email: "admin@example.com", password })).status, 200);
    f.enableMail();
    f.config.registrationEnabled = false;
    assert.equal((await f.request("/auth/register/code", { email: address })).status, 403);
    assert.equal((await f.request("/auth/register", f.signup("123456"))).status, 403);
    assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});

test("six-digit email verification creates exactly one account/session and pre-verifies its reminder address", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    const status = await f.request("/auth/config").then(r => r.json()) as any;
    assert.equal(status.registrationMailAvailable, true);
    const response = await f.request("/auth/register/code", { email: " NEW@Example.com " });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { message: "验证码已发送，请查收邮箱。", retryAfter: 60, expiresIn: 600 });
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(f.count("users"), 1);
    const message = f.messages[0]!;
    assert.equal(message.to, address);
    assert.equal(message.subject, "续记 · 注册验证码");
    assert.match(message.html, /<html lang="zh-CN">/);
    assert.match(message.html, /VERIFY YOUR EMAIL/);
    assert.match(message.html, /@media \(prefers-color-scheme: dark\)/);
    assert.match(message.text, /此邮件用于验证注册邮箱，不代表账户已创建。/);
    assert.match(message.idempotencyKey!, /^renewly-registration-/);
    const code = codeOf(message);
    const stored = f.runtime.db.prepare("SELECT * FROM registration_codes").get() as any;
    assert.equal(stored.status, "sent");
    assert.match(stored.code_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.code_hash, code);
    assert.equal("code" in stored, false);
    const requestRow = f.runtime.db.prepare("SELECT * FROM registration_code_requests").get() as any;
    assert.match(requestRow.ip_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(requestRow.ip_hash, "192.0.2.1");
    const signedUp = await f.request("/auth/register", f.signup(code, " NEW@Example.com "));
    assert.equal(signedUp.status, 200, await signedUp.clone().text());
    assert.match(signedUp.headers.get("set-cookie")!, /renewly_session=.+;.*HttpOnly/);
    const user = (await signedUp.json() as any).user;
    assert.equal(user.role, "user");
    assert.equal(user.email, address);
    assert.equal(f.count("users"), 2);
    assert.equal(f.count("sessions"), 1);
    assert.equal(f.count("registration_codes"), 0);
    const prefs = f.runtime.db.prepare("SELECT recipient_email,email_verified FROM notification_settings WHERE user_id=?").get(user.id);
    assert.deepEqual(prefs, { recipient_email: address, email_verified: 1 });
    assert.equal((await f.request("/auth/register", f.signup(code))).status, 409);
    assert.equal((await f.request("/auth/register/code", { email: address })).status, 409);
    assert.equal(f.count("sessions"), 1);
    assert.equal(f.messages.length, 1);
  } finally { f.close(); }
});

test("missing/malformed/wrong-address codes and cross-site sending cannot bypass email verification", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    assert.equal((await f.request("/auth/register/code", { email: address }, undefined, "https://evil.example")).status, 403);
    assert.equal((await f.request("/auth/register/code", { email: "invalid" })).status, 400);
    assert.equal(f.messages.length, 0);
    await f.request("/auth/register/code", { email: address });
    const { verificationCode, ...missingCode } = f.signup(codeOf(f.messages[0]!));
    assert.equal((await f.request("/auth/register", missingCode)).status, 400);
    assert.equal((await f.request("/auth/register", f.signup("12345a"))).status, 400);
    assert.equal((await f.request("/auth/register", f.signup(verificationCode, "other@example.com"))).status, 400);
    assert.equal(f.count("users"), 1);
    assert.equal(f.count("sessions"), 0);
  } finally { f.close(); }
});

test("the fifth incorrect attempt locks a code persistently even with a correct sixth attempt", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.request("/auth/register/code", { email: address });
    const code = codeOf(f.messages[0]!);
    for (let i = 0; i < 5; i++)
      assert.equal((await f.request("/auth/register", f.signup(wrongCode(code)), `192.0.2.${i + 1}`)).status, 400);
    const row = f.runtime.db.prepare("SELECT attempts FROM registration_codes WHERE email=?").get(address) as any;
    assert.equal(row.attempts, 5);
    await assert.rejects(() => f.service().register(f.signup(code)), (error: any) => error.code === "REGISTRATION_CODE_INVALID");
    assert.equal(f.count("users"), 1);
    assert.equal(f.count("sessions"), 0);
  } finally { f.close(); }
});

test("codes expire at ten minutes; expiration during password hashing also rejects the registration", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.service().sendCode(address, "192.0.2.1");
    const code = codeOf(f.messages[0]!);
    f.advance(600_000);
    await assert.rejects(() => f.service().register(f.signup(code)), RegistrationError);
    await f.service().sendCode(address, "192.0.2.1");
    const pending = f.service().register(f.signup(codeOf(f.messages[1]!)));
    f.advance(600_000);
    await assert.rejects(pending, (error: any) => error.code === "REGISTRATION_CODE_INVALID");
    assert.equal(f.count("users"), 1);
  } finally { f.close(); }
});

test("resending reserves a sixty-second cooldown and invalidates the previous challenge, including in-flight signups", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.request("/auth/register/code", { email: address });
    const first = f.runtime.db.prepare("SELECT * FROM registration_codes").get() as any;
    const tooSoon = await f.request("/auth/register/code", { email: address });
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.headers.get("retry-after"), "60");
    assert.equal(f.messages.length, 1);
    const pending = f.service().register(f.signup(codeOf(f.messages[0]!)));
    f.advance(60_000);
    assert.equal((await f.request("/auth/register/code", { email: address })).status, 200);
    const second = f.runtime.db.prepare("SELECT * FROM registration_codes").get() as any;
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.code_hash, first.code_hash);
    await assert.rejects(pending, (error: any) => error.code === "REGISTRATION_CODE_INVALID");
    const newUser = await f.service().register(f.signup(codeOf(f.messages[1]!)));
    assert.equal(newUser.email, address);
  } finally { f.close(); }
});

test("a correct code is consumed once when concurrent registrations race", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.service().sendCode(address, "192.0.2.1");
    const code = codeOf(f.messages[0]!);
    const results = await Promise.all([
      f.request("/auth/register", f.signup(code)),
      f.request("/auth/register", f.signup(code)),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(f.count("users"), 2);
    assert.equal(f.count("sessions"), 1);
    assert.equal(f.count("registration_codes"), 0);
  } finally { f.close(); }
});

test("exhausting a challenge during password hashing prevents an earlier valid request from creating an account", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.service().sendCode(address, "192.0.2.1");
    const code = codeOf(f.messages[0]!);
    const pending = f.service().register(f.signup(code));
    const result = assert.rejects(pending, (error: any) => error.code === "REGISTRATION_CODE_INVALID");
    for (let i = 0; i < 5; i++)
      await assert.rejects(() => f.service().register(f.signup(wrongCode(code))), RegistrationError);
    await result;
    assert.equal(f.count("users"), 1);
    assert.equal(f.count("sessions"), 0);
  } finally { f.close(); }
});

test("user creation, verified preferences and code consumption roll back together on a database failure", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.service().sendCode(address, "192.0.2.1");
    const code = codeOf(f.messages[0]!);
    f.runtime.db.exec("CREATE TRIGGER fail_registration_prefs BEFORE INSERT ON notification_settings BEGIN SELECT RAISE(ABORT,'test preference insertion failure'); END;");
    await assert.rejects(() => f.service().register(f.signup(code)), /test preference insertion failure/);
    assert.equal(f.count("users"), 1);
    assert.equal(f.count("sessions"), 0);
    assert.equal(f.count("registration_codes"), 1);
    f.runtime.db.exec("DROP TRIGGER fail_registration_prefs");
    assert.equal((await f.service().register(f.signup(code))).email, address);
    assert.equal(f.count("registration_codes"), 0);
  } finally { f.close(); }
});

test("concurrent sends are reserved before awaiting mail; sending challenges cannot register", async () => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { start(); await gate; });
  try {
    f.enableMail();
    const pending = f.request("/auth/register/code", { email: address });
    await started;
    assert.equal((await f.request("/auth/register/code", { email: address })).status, 429);
    assert.equal((await f.request("/auth/register", f.signup(codeOf(f.messages[0]!)))).status, 400);
    release();
    assert.equal((await pending).status, 200);
    assert.equal(f.messages.length, 1);
    assert.equal((await f.request("/auth/register", f.signup(codeOf(f.messages[0]!)))).status, 200);
  } finally { release(); f.close(); }
});

test("failed mail deletes its challenge, hides transport details and permits a later retry without bypassing limits", async () => {
  let fail = true;
  const f = await fixture(async () => { if (fail) throw new Error("provider secret and smtp details"); });
  try {
    f.enableMail();
    const response = await f.request("/auth/register/code", { email: address });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /REGISTRATION_MAIL_FAILED/);
    assert.doesNotMatch(body, /provider secret/);
    assert.equal(f.count("registration_codes"), 0);
    assert.equal(f.count("registration_code_requests"), 1);
    assert.equal((await f.request("/auth/register", f.signup(codeOf(f.messages[0]!)))).status, 400);
    assert.equal((await f.request("/auth/register/code", { email: address })).status, 429);
    f.advance(60_000);
    fail = false;
    assert.equal((await f.request("/auth/register/code", { email: address })).status, 200);
    assert.equal((await f.request("/auth/register", f.signup(codeOf(f.messages[1]!)))).status, 200);
  } finally { f.close(); }
});

test("a stale delivery failure cannot delete a newer successfully sent code", async () => {
  const deliveries: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const starters: (() => void)[] = [];
  const started = () => new Promise<void>(resolve => { starters.push(resolve); });
  const f = await fixture(() => new Promise<void>((resolve, reject) => { deliveries.push({ resolve, reject }); starters.shift()!(); }));
  try {
    f.enableMail();
    const firstStarted = started();
    const oldDelivery = f.service().sendCode(address, "192.0.2.1");
    // Attach the rejection observer immediately while the older mail is pending.
    const oldResult = assert.rejects(oldDelivery, (error: any) => error.code === "REGISTRATION_MAIL_FAILED");
    await firstStarted;
    f.advance(60_000);
    const nextStarted = started();
    const newDelivery = f.service().sendCode(address, "192.0.2.1");
    await nextStarted;
    const current = f.runtime.db.prepare("SELECT id FROM registration_codes").get() as any;
    deliveries[1]!.resolve();
    await newDelivery;
    deliveries[0]!.reject(new Error("stale SMTP failure"));
    await oldResult;
    assert.deepEqual(f.runtime.db.prepare("SELECT id,status FROM registration_codes").get(), { id: current.id, status: "sent" });
    assert.equal((await f.service().register(f.signup(codeOf(f.messages[1]!)))).email, address);
  } finally { f.close(); }
});

test("persistent per-email, per-IP and global caps survive recreating the registration service and expire after an hour", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    for (let i = 0; i < 5; i++) {
      await f.service().sendCode(address, "192.0.2.1");
      f.advance(60_000);
    }
    await assert.rejects(() => f.service().sendCode(address, "192.0.2.99"), (error: any) => error.status === 429);
    for (let i = 0; i < 15; i++) await f.service().sendCode(`ip-${i}@example.com`, "192.0.2.1");
    await assert.rejects(() => f.service().sendCode("ip-limited@example.com", "192.0.2.1"), (error: any) => error.status === 429);
    for (let i = 0; i < 80; i++) await f.service().sendCode(`global-${i}@example.com`, `198.51.100.${i}`);
    await assert.rejects(() => f.service().sendCode("global-limited@example.com", "203.0.113.1"), (error: any) => error.status === 429);
    assert.equal(f.messages.length, 100);
    f.advance(3_600_000);
    await f.service().sendCode(address, "192.0.2.1");
    assert.equal(f.count("registration_code_requests"), 1);
    assert.equal(f.count("registration_codes"), 1);
  } finally { f.close(); }
});

test("Retry-After reflects the constrained email window instead of an unrelated older request", async () => {
  const f = await fixture();
  try {
    f.enableMail();
    await f.service().sendCode("earlier@example.com", "203.0.113.1");
    f.advance(600_000);
    for (let i = 0; i < 5; i++) {
      await f.service().sendCode(address, "192.0.2.1");
      f.advance(60_000);
    }
    await assert.rejects(() => f.service().sendCode(address, "192.0.2.2"), (error: any) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 3300);
      return true;
    });
  } finally { f.close(); }
});
