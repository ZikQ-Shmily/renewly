import nodemailer from "nodemailer";
import { randomBytes, randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { Config } from "./config.js";
import { decrypt, encrypt, tokenHash } from "./auth.js";
export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
};
export type SendMail = (message: MailMessage) => Promise<void>;
export const htmlEscape = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function createMail(
  db: DB,
  config: Config,
  fetcher: typeof fetch = fetch,
  overrideSend?: SendMail,
) {
  const row = () =>
    db.prepare("SELECT * FROM mail_settings WHERE id=1").get() as any;
  const secrets = () => decrypt(row().secrets_cipher, config.secret);
  function settings() {
    const r = row(),
      s = secrets();
    return {
      enabled: !!r.enabled,
      transport: r.transport,
      senderName: r.sender_name,
      senderEmail: r.sender_email,
      smtpHost: r.smtp_host,
      smtpPort: r.smtp_port,
      smtpSecure: !!r.smtp_secure,
      smtpUser: r.smtp_user,
      smtpPassConfigured: !!s.smtpPass,
      resendKeyConfigured: !!s.resendApiKey,
    };
  }
  function available() {
    try {
      const r = settings();
      return (
        r.enabled &&
        !!r.senderEmail &&
        (r.transport === "smtp"
          ? !!r.smtpHost && r.smtpPassConfigured && !!r.smtpUser
          : r.resendKeyConfigured)
      );
    } catch {
      return false;
    }
  }
  function save(v: any, actor: string) {
    const old = row(),
      s = secrets();
    if (v.smtpPass?.trim()) s.smtpPass = v.smtpPass;
    if (v.resendApiKey?.trim()) s.resendApiKey = v.resendApiKey;
    const input = {
      enabled: v.enabled ?? !!old.enabled,
      transport: v.transport ?? old.transport,
      senderName: v.senderName ?? old.sender_name,
      senderEmail: v.senderEmail ?? old.sender_email,
      smtpHost: v.smtpHost ?? old.smtp_host,
      smtpPort: v.smtpPort ?? old.smtp_port,
      smtpSecure: v.smtpSecure ?? !!old.smtp_secure,
      smtpUser: v.smtpUser ?? old.smtp_user,
    };
    if (
      input.enabled &&
      (!input.senderEmail ||
        (input.transport === "smtp"
          ? !input.smtpHost || !input.smtpUser || !s.smtpPass
          : !s.resendApiKey))
    )
      throw new Error("启用邮件前，请补全发件人和所选服务的凭据。");
    db.transaction(() => {
      db.prepare(
        "UPDATE mail_settings SET enabled=?,transport=?,sender_name=?,sender_email=?,smtp_host=?,smtp_port=?,smtp_secure=?,smtp_user=?,secrets_cipher=? WHERE id=1",
      ).run(
        Number(input.enabled),
        input.transport,
        input.senderName,
        input.senderEmail,
        input.smtpHost,
        input.smtpPort,
        Number(input.smtpSecure),
        input.smtpUser,
        encrypt(s, config.secret),
      );
      db.prepare(
        "INSERT INTO audit_logs(actor_id,action,created_at) VALUES(?,?,?)",
      ).run(actor, "mail_settings_updated", new Date().toISOString());
    })();
    return settings();
  }
  async function send(message: MailMessage) {
    if (!available()) throw new Error("管理员尚未配置或启用邮件服务。");
    if (overrideSend) return overrideSend(message);
    const r = row(),
      s = secrets(),
      from = { name: r.sender_name, address: r.sender_email };
    if (r.transport === "resend") {
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${s.resendApiKey}`,
          "Content-Type": "application/json",
          ...(message.idempotencyKey
            ? { "Idempotency-Key": message.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from: `${r.sender_name.replace(/[\r\n<>]/g, "")} <${r.sender_email}>`,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(`邮件接口投递失败（HTTP ${response.status}）。`);
      return;
    }
    const transport = nodemailer.createTransport({
      host: r.smtp_host,
      port: r.smtp_port,
      secure: !!r.smtp_secure,
      requireTLS: !r.smtp_secure,
      auth: { user: r.smtp_user, pass: s.smtpPass },
      connectionTimeout: 10000,
      socketTimeout: 15000,
    });
    try {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (error) {
      const code = (error as any)?.code;
      throw new Error(
        `SMTP 投递失败${typeof code === "string" && /^[A-Z0-9_]{1,30}$/.test(code) ? `（${code}）` : ""}。`,
      );
    } finally {
      transport.close();
    }
  }
  function deliveryLog(
    userId: string,
    kind: string,
    status: string,
    error?: string,
  ) {
    const id = randomUUID(),
      now = new Date().toISOString();
    db.prepare(
      "INSERT INTO reminder_deliveries(id,user_id,kind,status,attempts,created_at,updated_at,sent_at,error) VALUES(?,?,?,?,1,?,?,?,?)",
    ).run(
      id,
      userId,
      kind,
      status,
      now,
      now,
      status === "sent" ? now : null,
      error || null,
    );
    return id;
  }
  async function verification(userId: string) {
    if (!available()) throw new Error("管理员尚未配置或启用邮件服务。");
    const token = randomBytes(32).toString("base64url"),
      url = `${config.appUrl}/api/v1/notifications/verify?token=${token}`,
      deliveryId = randomUUID(),
      now = new Date().toISOString();
    const recipientEmail = db.transaction(() => {
      const prefs = db
        .prepare(
          "SELECT recipient_email FROM notification_settings WHERE user_id=?",
        )
        .get(userId) as { recipient_email: string } | undefined;
      if (!prefs?.recipient_email) throw new Error("请先保存收件邮箱。");
      const recent = db
        .prepare(
          "SELECT COUNT(*) AS n FROM reminder_deliveries WHERE user_id=? AND kind='verification' AND created_at>?",
        )
        .get(userId, new Date(Date.now() - 15 * 60_000).toISOString()) as {
        n: number;
      };
      if (recent.n >= 3) throw new Error("验证邮件发送过于频繁，请稍后再试。");
      db.prepare(
        "INSERT INTO reminder_deliveries(id,user_id,kind,status,attempts,created_at,updated_at) VALUES(?,?,'verification','sending',1,?,?)",
      ).run(deliveryId, userId, now, now);
      db.prepare("DELETE FROM email_verifications WHERE user_id=?").run(userId);
      db.prepare("INSERT INTO email_verifications VALUES(?,?,?,?)").run(
        tokenHash(token),
        userId,
        prefs.recipient_email,
        new Date(Date.now() + 24 * 3600_000).toISOString(),
      );
      return prefs.recipient_email;
    })();
    try {
      await send({
        to: recipientEmail,
        subject: "续记 · 验证你的提醒邮箱",
        text: `请打开链接验证你的提醒邮箱（24小时有效）：${url}`,
        html: `<h2>验证你的提醒邮箱</h2><p>你正在设置续记到期提醒收件地址。</p><p><a href="${htmlEscape(url)}">确认此邮箱属于我</a></p><p>链接24小时有效。如果不是你发起的请求，请忽略。</p>`,
        idempotencyKey: `renewly-verification-${deliveryId}`,
      });
      db.prepare(
        "UPDATE reminder_deliveries SET status='sent',sent_at=?,updated_at=? WHERE id=?",
      ).run(new Date().toISOString(), new Date().toISOString(), deliveryId);
    } catch (error) {
      db.transaction(() => {
        db.prepare(
          "UPDATE reminder_deliveries SET status='failed',error=?,updated_at=? WHERE id=?",
        ).run(
          (error as Error).message.slice(0, 300),
          new Date().toISOString(),
          deliveryId,
        );
        db.prepare("DELETE FROM email_verifications WHERE token_hash=?").run(
          tokenHash(token),
        );
      })();
      throw error;
    }
    return now;
  }
  return { settings, save, available, send, verification, deliveryLog };
}
export type MailService = ReturnType<typeof createMail>;
