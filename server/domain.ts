import { z } from "zod";
import type { DB } from "./db.js";
export const currencies = ["CNY", "USD", "EUR", "GBP"] as const;
export const dayMs = 86_400_000;
export function validDate(s: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
  );
}
export const dateSchema = z.string().refine(validDate, "日期格式无效");
export const daysSchema = z
  .array(z.number().int().min(0).max(365))
  .max(12)
  .transform((v) => [...new Set(v)].sort((a, b) => b - a));
const money = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000_000)
  .refine(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001,
    "价格最多保留两位小数",
  );
export const subscriptionSchema = z
  .object({
    type: z.literal("cloud"),
    name: z.string().trim().min(1).max(100),
    vendor: z.string().trim().min(1).max(100),
    website: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
        );
      }, "网站须为 HTTP(S) 地址"),
    currency: z.enum(currencies),
    purchasePrice: money,
    renewalPrice: money,
    paidAmount: money,
    billingMonths: z
      .number()
      .int()
      .refine((v) => [1, 3, 6, 12, 24, 36].includes(v), "计费周期无效"),
    periodStart: dateSchema,
    nextRenewal: dateSchema,
    region: z.string().trim().max(100).default(""),
    model: z.string().trim().max(200).default(""),
    trafficMode: z.enum(["limited", "unlimited", "unknown"]).default("unknown"),
    trafficQuota: z.number().finite().positive().nullable().optional(),
    trafficUnit: z.enum(["GB", "TB"]).default("GB"),
    status: z.enum(["active", "paused", "archived"]).default("active"),
    notes: z.string().max(4000).default(""),
    reminderDays: daysSchema.optional(),
  })
  .superRefine((v, c) => {
    if (v.nextRenewal <= v.periodStart)
      c.addIssue({
        code: "custom",
        message: "续费日期需要晚于账期开始日期",
        path: ["nextRenewal"],
      });
    const quota =
      v.trafficQuota == null
        ? 0
        : Math.round(v.trafficQuota * (v.trafficUnit === "TB" ? 1e12 : 1e9));
    if (
      v.trafficMode === "limited" &&
      (!v.trafficQuota || !Number.isSafeInteger(quota) || quota < 1)
    )
      c.addIssue({
        code: "custom",
        message: "请填写有效的套餐流量总额度",
        path: ["trafficQuota"],
      });
  });
export type SubscriptionInput = z.infer<typeof subscriptionSchema>;
export function localDate(now: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((k) => p.find((x) => x.type === k)!.value)
    .join("-");
}
export function validTimeZone(v: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}
export const timeZoneSchema = z
  .string()
  .max(80)
  .refine(validTimeZone, "时区无效");
export function addMonths(
  date: string,
  months: number,
  anchorDay = Number(date.slice(8)),
) {
  const d = new Date(`${date}T00:00:00Z`),
    n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0),
  ).getUTCDate();
  n.setUTCDate(Math.min(anchorDay, last));
  return n.toISOString().slice(0, 10);
}
export function dateDiff(a: string, b: string) {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / dayMs,
  );
}
export function serializeSubscription(db: DB, row: any) {
  const details = db
    .prepare("SELECT * FROM server_details WHERE subscription_id=?")
    .get(row.id) as any;
  const period = db
    .prepare(
      "SELECT * FROM billing_periods WHERE subscription_id=? AND user_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(row.id, row.user_id) as any;
  return {
    id: row.id,
    type: row.type_key,
    name: row.name,
    vendor: row.vendor,
    website: row.website,
    currency: row.currency,
    purchasePrice: row.purchase_minor / 100,
    renewalPrice: row.renewal_minor / 100,
    billingMonths: row.billing_months,
    billingAnchorDay: row.billing_anchor_day,
    periodStart: period.starts_at,
    nextRenewal: row.next_renewal,
    paidAmount: period.paid_minor / 100,
    region: details?.region || "",
    model: details?.model || "",
    trafficMode: details?.traffic_mode || "unknown",
    trafficQuota:
      details?.traffic_quota_bytes == null
        ? null
        : details.traffic_quota_bytes /
          (details.traffic_unit === "TB" ? 1e12 : 1e9),
    trafficUnit: details?.traffic_unit || "GB",
    status: row.status,
    notes: row.notes,
    reminderDays: JSON.parse(row.reminder_days),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function listSubscriptions(db: DB, userId: string) {
  return (
    db
      .prepare(
        "SELECT * FROM subscriptions WHERE user_id=? ORDER BY next_renewal,name",
      )
      .all(userId) as any[]
  ).map((r) => serializeSubscription(db, r));
}
export function totals(
  db: DB,
  userId: string,
  timeZone: string,
  target: string,
  rates: Record<string, number>,
  now = new Date(),
) {
  const all = listSubscriptions(db, userId),
    active = all.filter((s) => s.status === "active"),
    today = localDate(now, timeZone),
    missing = new Set<string>();
  const convert = (value: number, from: string) => {
    if (from === target) return value;
    if (rates[from] && rates[target])
      return (value * rates[from]) / rates[target];
    missing.add(from);
    return 0;
  };
  let annualTotal = 0,
    remainingValue = 0,
    upcomingTotal = 0;
  for (const s of active) {
    annualTotal += convert((s.renewalPrice * 12) / s.billingMonths, s.currency);
    if (s.nextRenewal >= today) {
      for (let i = 0; i < 36; i++) {
        const due =
          i === 0
            ? s.nextRenewal
            : addMonths(s.nextRenewal, i * s.billingMonths, s.billingAnchorDay);
        if (dateDiff(due, today) > 30) break;
        upcomingTotal += convert(s.renewalPrice, s.currency);
      }
    }
  }
  const periods = db
    .prepare(
      "SELECT p.* FROM billing_periods p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.user_id=? AND s.status!='archived'",
    )
    .all(userId) as any[];
  for (const p of periods) {
    const fraction = Math.max(
      0,
      Math.min(
        1,
        dateDiff(p.ends_at, today) / dateDiff(p.ends_at, p.starts_at),
      ),
    );
    remainingValue += convert((p.paid_minor / 100) * fraction, p.currency);
  }
  const nextDue = active.filter(
    (s) =>
      dateDiff(s.nextRenewal, today) >= 0 &&
      dateDiff(s.nextRenewal, today) <= 30,
  );
  const round = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  return {
    currency: target,
    annualTotal: round(annualTotal),
    remainingValue: round(remainingValue),
    upcomingTotal: round(upcomingTotal),
    activeCount: active.length,
    dueCount: nextDue.length,
    subscriptions: all,
    nextDue,
    totalsPartial: missing.size > 0,
    unconvertedCurrencies: [...missing],
  };
}
