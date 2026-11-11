import type { Currency, Subscription } from "./types.js";

export const currencies: { value: Currency; label: string }[] = [
  { value: "CNY", label: "¥ 人民币" },
  { value: "USD", label: "$ 美元" },
  { value: "EUR", label: "€ 欧元" },
  { value: "GBP", label: "£ 英镑" },
];
const symbols: Record<Currency, string> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
};
export function money(value: number | null | undefined, currency: Currency) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : symbols[currency] +
        value.toLocaleString("zh-CN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
}
export const periodLabel = (months: number) =>
  ({ 1: "月", 3: "季", 6: "半年", 12: "年", 24: "两年", 36: "三年" })[months] ||
  `${months} 个月`;
export function today(timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function addMonths(date: string, months: number, anchor?: number) {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return "";
  const next = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(anchor || day, last));
  return next.toISOString().slice(0, 10);
}
export function daysUntil(date: string, timeZone: string) {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) -
      Date.parse(`${today(timeZone)}T00:00:00Z`)) /
      86_400_000,
  );
}
export function dueLabel(subscription: Subscription, timeZone: string) {
  if (subscription.status === "archived") return "已归档";
  if (subscription.status === "paused") return "已暂停";
  const days = daysUntil(subscription.nextRenewal, timeZone);
  return days < 0
    ? `已过期 ${Math.abs(days)} 天`
    : days === 0
      ? "今天到期"
      : `${days} 天后`;
}
export function trafficLabel(
  subscription: Pick<
    Subscription,
    "trafficMode" | "trafficQuota" | "trafficUnit"
  >,
) {
  if (subscription.trafficMode === "unlimited") return "不限流量";
  if (
    subscription.trafficMode !== "limited" ||
    subscription.trafficQuota == null
  )
    return "未填写";
  return `${subscription.trafficQuota.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} ${subscription.trafficUnit}`;
}
export function bandwidthLabel(
  subscription: Pick<Subscription, "bandwidthValue" | "bandwidthUnit">,
) {
  return subscription.bandwidthValue == null
    ? "未填写"
    : `${subscription.bandwidthValue.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} ${subscription.bandwidthUnit}`;
}

export function termProgress(item: Subscription, timeZone: string, currentDay = today(timeZone)) {
  const period = item.progressPeriod || item.currentPeriod || {
    startsAt: item.periodStart,
    endsAt: item.nextRenewal,
  };
  const start = Date.parse(`${period.startsAt}T00:00:00Z`);
  const end = Date.parse(`${period.endsAt}T00:00:00Z`);
  const current = Date.parse(`${currentDay}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return { percent: 0, label: "暂无有效账期", tone: "muted" };
  const remaining = Math.round((end - current) / 86_400_000);
  const percent = Math.round(Math.max(0, Math.min(1, (end - current) / (end - start))) * 100);
  return {
    percent,
    label: start > current ? "尚未开始" : remaining < 0 ? "已到期" : remaining === 0 ? "今天到期" : `剩余 ${remaining} 天`,
    tone: start > current ? "normal" : remaining < 0 ? "expired" : remaining <= 7 ? "soon" : "normal",
  };
}
export function timestamp(value: string | undefined, timeZone: string) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}
export function reminderDays(text: string): number[] {
  const values = [
    ...new Set(
      text
        .split(/[,，\s/]+/)
        .filter(Boolean)
        .map(Number),
    ),
  ];
  if (values.some((n) => !Number.isInteger(n) || n < 1 || n > 365))
    throw new Error("提前天数需为 1～365 的整数，以逗号分隔。");
  return values.sort((a, b) => b - a);
}
