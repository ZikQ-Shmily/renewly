import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { MailService } from "./mail.js";
import { htmlEscape } from "./mail.js";
import type { Config } from "./config.js";
import { localDate, dateDiff } from "./domain.js";

export function createReminders(db: DB, mail: MailService, config: Config) {
  let running = false;

  return async function run(now = new Date()) {
    if (running) return { sent: 0, failed: 0 };
    running = true;
    let sent = 0;
    let failed = 0;

    try {
      const timestamp = now.toISOString();
      db.prepare("DELETE FROM sessions WHERE expires_at<?").run(timestamp);
      db.prepare("DELETE FROM email_verifications WHERE expires_at<?").run(
        timestamp,
      );
      if (!mail.available()) return { sent, failed };

      const abandonedBefore = new Date(
        now.getTime() - 30 * 60_000,
      ).toISOString();
      db.prepare(
        `
        UPDATE reminder_deliveries SET status='failed', error='投递被中断，已达到重试上限。'
        WHERE kind='reminder' AND status='sending' AND updated_at<? AND attempts>=3
      `,
      ).run(abandonedBefore);
      db.prepare(
        `
        UPDATE reminder_deliveries SET status='pending'
        WHERE kind='reminder' AND status='sending' AND updated_at<? AND attempts<3
      `,
      ).run(abandonedBefore);

      const subscriptions = db
        .prepare(
          `
        SELECT s.*,u.time_zone FROM subscriptions s
        JOIN users u ON u.id=s.user_id
        JOIN notification_settings n ON n.user_id=u.id
        WHERE s.status='active' AND u.status='active' AND n.enabled=1 AND n.email_verified=1 AND n.recipient_email!=''
      `,
        )
        .all() as any[];

      for (const subscription of subscriptions) {
        const days = dateDiff(
          subscription.next_renewal,
          localDate(now, subscription.time_zone),
        );
        if (
          !(JSON.parse(subscription.reminder_days) as number[]).includes(days)
        )
          continue;
        db.prepare(
          `
          INSERT OR IGNORE INTO reminder_deliveries(
            id,user_id,subscription_id,subscription_name,due_date,days_before,kind,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,'reminder','pending',?,?)
        `,
        ).run(
          randomUUID(),
          subscription.user_id,
          subscription.id,
          subscription.name,
          subscription.next_renewal,
          days,
          timestamp,
          timestamp,
        );
      }

      // Retry queued deliveries independently of today's reminder-rule match.
      const pending = db
        .prepare(
          `
        SELECT id FROM reminder_deliveries
        WHERE kind='reminder' AND status IN ('pending','failed') AND attempts<3
          AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        ORDER BY created_at LIMIT 200
      `,
        )
        .all(timestamp) as { id: string }[];

      for (const candidate of pending) {
        const delivery = db
          .prepare(
            `
          SELECT d.*,s.name,s.vendor,s.currency,s.renewal_minor,s.reminder_days,s.auto_renew,
            u.time_zone,n.recipient_email
          FROM reminder_deliveries d
          JOIN subscriptions s ON s.id=d.subscription_id AND s.user_id=d.user_id
          JOIN users u ON u.id=d.user_id
          JOIN notification_settings n ON n.user_id=u.id
          WHERE d.id=? AND d.due_date=s.next_renewal AND s.status='active' AND u.status='active'
            AND n.enabled=1 AND n.email_verified=1 AND n.recipient_email!=''
        `,
          )
          .get(candidate.id) as any;
        if (!delivery) continue;
        if (
          !(JSON.parse(delivery.reminder_days) as number[]).includes(
            delivery.days_before,
          )
        )
          continue;
        const days = dateDiff(
          delivery.due_date,
          localDate(now, delivery.time_zone),
        );
        if (days < 0) continue;

        const claim = db
          .prepare(
            `
          UPDATE reminder_deliveries SET status='sending',attempts=attempts+1,updated_at=?
          WHERE id=? AND status IN ('pending','failed') AND attempts=?
        `,
          )
          .run(timestamp, delivery.id, delivery.attempts);
        if (!claim.changes) continue;

        const when = days === 0 ? "今天到期" : `${days}天后到期`;
        const price = new Intl.NumberFormat("zh-CN", {
          style: "currency",
          currency: delivery.currency,
        }).format(delivery.renewal_minor / 100);
        const instruction = delivery.auto_renew
          ? "此订阅已标记商家自动续费，请检查余额并确认商家扣款成功，再在续记登记。"
          : "请前往商家完成续费，并在续记登记。";
        const text = `${delivery.name} ${when}。\n商家：${delivery.vendor}\n续费日期：${delivery.due_date}\n续费价格：${price}\n${instruction}\n${config.appUrl}`;

        try {
          await mail.send({
            to: delivery.recipient_email,
            subject: `续记 · ${delivery.name} ${when}`,
            text,
            html: `<h2>${htmlEscape(delivery.name)} ${when}</h2><p>商家：${htmlEscape(delivery.vendor)}</p><p>续费日期：${delivery.due_date}</p><p>续费价格：${htmlEscape(price)}</p><p>${htmlEscape(instruction)}</p><a href="${htmlEscape(config.appUrl)}">打开续记</a>`,
            idempotencyKey: `renewly-${delivery.id}`,
          });
          db.prepare(
            `
            UPDATE reminder_deliveries SET status='sent',sent_at=?,updated_at=?,error=NULL
            WHERE id=?
          `,
          ).run(timestamp, timestamp, delivery.id);
          sent++;
        } catch (error) {
          db.prepare(
            `
            UPDATE reminder_deliveries SET status='failed',updated_at=?,next_attempt_at=?,error=?
            WHERE id=?
          `,
          ).run(
            timestamp,
            new Date(now.getTime() + 15 * 60_000).toISOString(),
            (error as Error).message.slice(0, 300),
            delivery.id,
          );
          failed++;
        }
      }
      return { sent, failed };
    } finally {
      running = false;
    }
  };
}
