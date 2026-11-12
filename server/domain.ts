import { z } from "zod";
import { isIP } from "node:net";
import type { DB } from "./db.js";
import { normalizeDateTime, dateTimeInstant, addDateTimeMonths, localDateTime } from "../shared/datetime.js";
export const currencies = ["CNY", "USD", "EUR", "GBP", "NGN", "TRY", "PHP", "JPY", "TWD", "HKD"] as const;
export const dayMs = 86_400_000;
export function validDate(s: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
  );
}
export const dateSchema = z.string().transform((value, context) => {
  try { return normalizeDateTime(value); }
  catch {
    context.addIssue({ code: "custom", message: "日期时间格式无效，请填写到小时和分钟。" });
    return z.NEVER;
  }
});
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
const serverNumber = z.number().finite().positive().max(1e9).nullable();
const ipAddressSchema = z.object({
  type: z.enum(["static", "dynamic"]),
  address: z.string().trim().max(128),
}).refine(
  value => (value.type === "dynamic" && value.address === "") || isIP(value.address) !== 0,
  { message: "请填写有效的 IPv4 或 IPv6 地址。", path: ["address"] },
);
const appIconSchema = z.string().max(90_000).default("auto").refine(value => {
  if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) return true;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length > 65_536 || bytes.toString("base64") !== match[2]) return false;
  return match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === "jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
}, "图标须为内置图标，或不超过 64 KB 的 PNG、JPEG、WebP 图片。");
export const subscriptionSchema = z
  .object({
    type: z.enum(["cloud", "app"]),
    name: z.string().trim().min(1).max(100),
    vendor: z.string().trim().max(100).default(""),
    website: z.union([z.literal(""), z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          ["https:", "http:"].includes(u.protocol) && !u.username && !u.password
        );
      }, "网站须为 HTTP(S) 地址")]).default(""),
    appPlan: z.string().trim().max(200).default(""),
    appChannel: z.enum(["官网", "App Store", "Google Play", "其他"]).default("官网"),
    appAccount: z.string().trim().max(254).default(""),
    appIcon: appIconSchema,
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
    cpuCores: serverNumber.default(null),
    memoryValue: serverNumber.default(null),
    memoryUnit: z.enum(["MB", "GB"]).default("GB"),
    diskValue: serverNumber.default(null),
    diskUnit: z.enum(["GB", "TB"]).default("GB"),
    ipAddresses: z.array(ipAddressSchema).max(20, "每台服务器最多记录 20 个 IP 地址。").default([]),
    trafficMode: z.enum(["limited", "unlimited", "unknown"]).default("unknown"),
    trafficQuota: z.number().finite().positive().nullable().optional(),
    trafficUnit: z.enum(["GB", "TB"]).default("GB"),
    trafficDirection: z.enum(["one_way", "two_way", "unknown"]).default("unknown"),
    bandwidthValue: z.number().finite().positive().max(1e9).nullable().default(null),
    bandwidthUnit: z.enum(["Mbps", "Gbps"]).default("Mbps"),
    autoRenew: z.boolean().default(false),
    status: z.enum(["active", "paused", "archived"]).default("active"),
    notes: z.string().max(4000).default(""),
    reminderDays: daysSchema.optional(),
  })
  .superRefine((v, c) => {
    if (v.type === "cloud") {
      if (!v.vendor) c.addIssue({ code: "custom", message: "请填写商家 / 服务商", path: ["vendor"] });
      if (!v.website) c.addIssue({ code: "custom", message: "请填写商家网站", path: ["website"] });
    }
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
      v.type === "cloud" && v.trafficMode === "limited" &&
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
  return localDateTime(now, timeZone).slice(0, 10);
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
  anchorDay = Number(date.slice(8, 10)),
) {
  return addDateTimeMonths(date, months, anchorDay);
}
export function dateDiff(a: string, b: string) {
  return Math.round(
    (Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / dayMs,
  );
}
export function shiftCalendarDays(value: string, days: number) {
  const normalized = normalizeDateTime(value);
  const date = new Date(`${normalized}Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 16);
}
/** Calendar recurrences in a DST gap run at the next valid local minute. */
export function recurringInstant(value: string, timeZone: string) {
  const normalized = normalizeDateTime(value);
  const localEpoch = Date.parse(`${normalized}Z`);
  for (let minute = 0; minute <= 26 * 60; minute++) {
    const candidate = new Date(localEpoch + minute * 60_000).toISOString().slice(0, 16);
    try { return dateTimeInstant(candidate, timeZone); } catch { /* Try the next minute in a DST gap. */ }
  }
  throw new RangeError("当前时区没有有效的提醒时刻。");
}
export function serverConfiguration(details: any) {
  return {
    cpuCores: details?.cpu_cores ?? null,
    memoryValue: details?.memory_value ?? null,
    memoryUnit: details?.memory_unit || "GB",
    diskValue: details?.disk_value ?? null,
    diskUnit: details?.disk_unit || "GB",
    ipAddresses: JSON.parse(details?.ip_addresses || "[]") as { type: "static" | "dynamic"; address: string }[],
    trafficDirection: details?.traffic_direction || "unknown",
  };
}
export function appConfiguration(details: any) {
  return {
    appPlan: details?.plan || "",
    appChannel: details?.purchase_channel || "官网",
    appAccount: details?.account || "",
    appIcon: details?.icon || "auto",
  };
}
export function serializeSubscription(db: DB, row: any, timeZone?: string, now = new Date()) {
  const details = db
    .prepare("SELECT * FROM server_details WHERE subscription_id=?")
    .get(row.id) as any;
  const period = db
    .prepare(
      "SELECT * FROM billing_periods WHERE subscription_id=? AND user_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(row.id, row.user_id) as any;
  const zone = timeZone || (db.prepare("SELECT time_zone FROM users WHERE id=?").get(row.user_id) as { time_zone: string }).time_zone;
  const instant = (value: string) => dateTimeInstant(value, zone);
  const timestamp = now.getTime();
  const periods = db.prepare("SELECT starts_at,ends_at FROM billing_periods WHERE subscription_id=? AND user_id=? ORDER BY starts_at DESC,id DESC").all(row.id, row.user_id) as { starts_at: string; ends_at: string }[];
  const current = periods.find(p => instant(p.starts_at) <= timestamp && instant(p.ends_at) > timestamp);
  const upcoming = periods.filter(p => instant(p.starts_at) > timestamp).at(-1);
  const expired = periods.filter(p => instant(p.ends_at) <= timestamp).sort((a,b) => instant(b.ends_at) - instant(a.ends_at))[0];
  const serializePeriod = (p: typeof current) => p ? { startsAt: p.starts_at, endsAt: p.ends_at } : null;
  return {
    id: row.id,
    type: row.type_key,
    name: row.name,
    vendor: row.vendor,
    website: row.website,
    ...appConfiguration(db.prepare("SELECT * FROM app_details WHERE subscription_id=?").get(row.id)),
    currency: row.currency,
    purchasePrice: row.purchase_minor / 100,
    renewalPrice: row.renewal_minor / 100,
    billingMonths: row.billing_months,
    billingAnchorDay: row.billing_anchor_day,
    periodStart: period.starts_at,
    nextRenewal: row.next_renewal,
    paidAmount: period.paid_minor / 100,
    currentPeriod: serializePeriod(current),
    progressPeriod: serializePeriod(current || upcoming || expired),
    region: details?.region || "",
    model: details?.model || "",
    ...serverConfiguration(details),
    trafficMode: details?.traffic_mode || "unknown",
    trafficQuota:
      details?.traffic_quota_bytes == null
        ? null
        : details.traffic_quota_bytes /
          (details.traffic_unit === "TB" ? 1e12 : 1e9),
    trafficUnit: details?.traffic_unit || "GB",
    bandwidthValue: details?.bandwidth_value ?? null,
    bandwidthUnit: details?.bandwidth_unit || "Mbps",
    autoRenew: !!row.auto_renew,
    status: row.status,
    notes: row.notes,
    reminderDays: JSON.parse(row.reminder_days),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function listSubscriptions(db: DB, userId: string, timeZone?: string, now = new Date()) {
  return (
    db
      .prepare(
        "SELECT * FROM subscriptions WHERE user_id=? ORDER BY next_renewal,name",
      )
      .all(userId) as any[]
  ).map((r) => serializeSubscription(db, r, timeZone, now));
}
export function totals(
  db: DB,
  userId: string,
  timeZone: string,
  target: string,
  rates: Record<string, number>,
  now = new Date(),
  typeKey?: string,
) {
  const all = listSubscriptions(db, userId, timeZone, now).filter(subscription => !typeKey || subscription.type === typeKey),
    active = all.filter((s) => s.status === "active"),
    timestamp = now.getTime(),
    missing = new Set<string>();
  const instant = (value: string) => dateTimeInstant(value, timeZone);
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
    if (instant(s.nextRenewal) >= timestamp) {
      for (let i = 0; i < 36; i++) {
        const due =
          i === 0
            ? s.nextRenewal
            : addMonths(s.nextRenewal, i * s.billingMonths, s.billingAnchorDay);
        if (recurringInstant(due, timeZone) - timestamp > 30 * dayMs) break;
        upcomingTotal += convert(s.renewalPrice, s.currency);
      }
    }
  }
  const periods = db.prepare(
    "SELECT p.* FROM billing_periods p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.user_id=? AND s.user_id=? AND s.status!='archived'" + (typeKey ? " AND s.type_key=?" : ""),
  ).all(...(typeKey ? [userId, userId, typeKey] : [userId, userId])) as any[];
  for (const p of periods) {
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (instant(p.ends_at) - timestamp) / (instant(p.ends_at) - instant(p.starts_at)),
      ),
    );
    remainingValue += convert((p.paid_minor / 100) * fraction, p.currency);
  }
  const nextDue = active.filter(
    (s) =>
      instant(s.nextRenewal) >= timestamp &&
      instant(s.nextRenewal) - timestamp <= 30 * dayMs,
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
