import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.js";
import type { Config } from "./config.js";
import { hashPassword } from "./auth.js";
import type { MailService } from "./mail.js";
import { registrationEmail } from "./email-templates.js";

const minute = 60_000;
const hour = 60 * minute;
export const registrationCodeLifetime = 10 * minute;
export const registrationCodeCooldown = minute;
const maxAttempts = 5;
const hourlyEmailLimit = 5;
const hourlyIpLimit = 20;
const hourlyGlobalLimit = 100;

export class RegistrationError extends Error {
  constructor(
    public status: 400 | 409 | 429 | 503,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

type Challenge = {
  email: string;
  id: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
  status: "sending" | "sent";
};

export function createRegistration(
  db: DB,
  config: Config,
  mail: MailService,
  clock: () => Date = () => new Date(),
) {
  const digest = (purpose: string, value: string) =>
    createHmac("sha256", config.secret).update(`${purpose}\0${value}`).digest("hex");
  const challenge = (email: string) =>
    db.prepare("SELECT * FROM registration_codes WHERE email=?").get(email) as Challenge | undefined;
  function requireMail() {
    if (!mail.available())
      throw new RegistrationError(503, "REGISTRATION_MAIL_UNAVAILABLE", "注册验证邮件暂时无法发送，请稍后再试或联系管理员。");
  }
  const exists = (email: string) => !!db.prepare("SELECT id FROM users WHERE email=?").get(email);
  function requireNewEmail(email: string) {
    if (exists(email)) throw new RegistrationError(409, "EMAIL_EXISTS", "此邮箱已注册，请直接登录。");
  }
  function blocked(message: string, retryAfter: number): never {
    throw new RegistrationError(429, "REGISTRATION_CODE_RATE_LIMIT", message, retryAfter);
  }
  function valid(row: Challenge | undefined, now: number, code: string, pinnedId?: string) {
    if (!row || row.status !== "sent" || row.expires_at <= now || row.attempts >= maxAttempts || (pinnedId && row.id !== pinnedId)) return false;
    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(digest("registration-code", `${row.email}\0${row.id}\0${code}`), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  function invalidCode(): never {
    throw new RegistrationError(400, "REGISTRATION_CODE_INVALID", "验证码不正确、已过期或已失效，请检查邮箱或重新获取验证码。");
  }

  async function sendCode(email: string, ip: string) {
    requireMail();
    const now = clock().getTime();
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const ipHash = digest("registration-ip", ip);
    // Reserve every send before awaiting SMTP. These durable limits also apply
    // after a restart and count failed deliveries to avoid hammering the sender.
    db.transaction(() => {
      requireNewEmail(email);
      db.prepare("DELETE FROM registration_codes WHERE email IN (SELECT email FROM registration_codes WHERE expires_at<=? LIMIT 1000)").run(now);
      db.prepare("DELETE FROM registration_code_requests WHERE id IN (SELECT id FROM registration_code_requests WHERE created_at<=? LIMIT 1000)").run(now - hour);
      const latest = db.prepare("SELECT MAX(created_at) AS created_at FROM registration_code_requests WHERE email=?").get(email) as { created_at: number | null };
      if (latest.created_at != null && latest.created_at + registrationCodeCooldown > now)
        blocked("请稍后再获取验证码。", Math.ceil((latest.created_at + registrationCodeCooldown - now) / 1000));
      const counts = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(email=?),0) AS email_count,
        COALESCE(SUM(ip_hash=?),0) AS ip_count,
        MIN(CASE WHEN email=? THEN created_at END) AS email_oldest,
        MIN(CASE WHEN ip_hash=? THEN created_at END) AS ip_oldest,
        MIN(created_at) AS oldest
        FROM registration_code_requests WHERE created_at>?`).get(email, ipHash, email, ipHash, now - hour) as { total: number; email_count: number; ip_count: number; email_oldest: number | null; ip_oldest: number | null; oldest: number | null };
      const retryUntil = Math.max(
        counts.email_count >= hourlyEmailLimit ? (counts.email_oldest ?? now) + hour : 0,
        counts.ip_count >= hourlyIpLimit ? (counts.ip_oldest ?? now) + hour : 0,
        counts.total >= hourlyGlobalLimit ? (counts.oldest ?? now) + hour : 0,
      );
      if (retryUntil > now)
        blocked("验证码发送过于频繁，请稍后再试。", Math.max(1, Math.ceil((retryUntil - now) / 1000)));
      db.prepare("INSERT INTO registration_code_requests(id,email,ip_hash,created_at) VALUES(?,?,?,?)").run(id, email, ipHash, now);
      db.prepare(`INSERT INTO registration_codes(email,id,code_hash,expires_at,attempts,status) VALUES(?,?,?,?,0,'sending')
        ON CONFLICT(email) DO UPDATE SET id=excluded.id,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,status='sending'`).run(
        email, id, digest("registration-code", `${email}\0${id}\0${code}`), now + registrationCodeLifetime,
      );
    })();
    try {
      await mail.send({
        to: email,
        ...registrationEmail({ code }),
        idempotencyKey: `renewly-registration-${id}`,
      });
      db.prepare("UPDATE registration_codes SET status='sent' WHERE email=? AND id=?").run(email, id);
    } catch {
      // A slow older delivery must never invalidate a more recent challenge.
      db.prepare("DELETE FROM registration_codes WHERE email=? AND id=?").run(email, id);
      throw new RegistrationError(503, "REGISTRATION_MAIL_FAILED", "验证码邮件发送失败，请稍后重试或联系管理员。");
    }
    return { message: "验证码已发送，请查收邮箱。", retryAfter: 60, expiresIn: 600 };
  }

  async function register(input: { email: string; name: string; password: string; verificationCode: string }) {
    requireMail();
    // Keep wrong-attempt increments outside a throwing transaction; otherwise
    // SQLite would roll them back along with the validation error.
    const pinnedId = db.transaction(() => {
      requireNewEmail(input.email);
      const row = challenge(input.email);
      if (!valid(row, clock().getTime(), input.verificationCode)) {
        if (row && row.status === "sent" && row.expires_at > clock().getTime() && row.attempts < maxAttempts)
          db.prepare("UPDATE registration_codes SET attempts=attempts+1 WHERE email=? AND id=?").run(input.email, row.id);
        return null;
      }
      return row!.id;
    })();
    if (!pinnedId) invalidCode();
    const passwordHash = await hashPassword(input.password);
    // Password derivation yields: another request may consume, resend or exhaust
    // this challenge meanwhile. Revalidate and consume with the user insertion.
    const user = db.transaction(() => {
      requireNewEmail(input.email);
      if (!valid(challenge(input.email), clock().getTime(), input.verificationCode, pinnedId)) invalidCode();
      const id = randomUUID();
      db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'user',?)").run(id, input.email, input.name, passwordHash, clock().toISOString());
      db.prepare("INSERT INTO notification_settings(user_id,recipient_email,email_verified) VALUES(?,?,1)").run(id, input.email);
      db.prepare("DELETE FROM registration_codes WHERE email=? AND id=?").run(input.email, pinnedId);
      return db.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
    })();
    return user;
  }
  return { sendCode, register };
}
