import type { Currency, Subscription } from "./types.js";
import { addDateTimeMonths, dateTimeInstant, dateTimeRemaining, formatDateTime, localDateTime } from "../../shared/datetime.js";
export { formatDateTime };

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
  return localDateTime(new Date(), timeZone).slice(0, 10);
}
export function addMonths(date: string, months: number, anchor?: number) {
  try { return addDateTimeMonths(date, months, anchor); } catch { return ""; }
}
export function daysUntil(date: string, timeZone: string) {
  try { return dateTimeRemaining(date, timeZone) / 86_400_000; } catch { return NaN; }
}
export function durationLabel(milliseconds: number) {
  const total = Math.ceil(Math.abs(milliseconds) / 60_000);
  if (!total) return "不足 1 分钟";
  const days = Math.floor(total / 1440), hours = Math.floor(total % 1440 / 60), minutes = total % 60;
  return [days ? `${days} 天` : "", hours ? `${hours} 小时` : "", !days && minutes ? `${minutes} 分钟` : ""].filter(Boolean).join(" ");
}
export function dueLabel(subscription: Subscription, timeZone: string) {
  if (subscription.status === "archived") return "已归档";
  if (subscription.status === "paused") return "已暂停";
  try {
    const remaining = dateTimeRemaining(subscription.nextRenewal, timeZone);
    return remaining <= 0 ? `已过期 ${durationLabel(remaining)}` : `剩余 ${durationLabel(remaining)}`;
  } catch { return "时间无效"; }
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

export function configurationLabel(item: Subscription) {
  const parts = [
    item.cpuCores != null ? `${item.cpuCores} 核` : "",
    item.memoryValue != null ? `${item.memoryValue} ${item.memoryUnit || "GB"} 内存` : "",
    item.diskValue != null ? `${item.diskValue} ${item.diskUnit || "GB"} 磁盘` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : item.model || "未填写配置";
}

export function termProgress(item: Subscription, timeZone: string, currentTime?: string | Date) {
  const period = item.progressPeriod || item.currentPeriod || {
    startsAt: item.periodStart,
    endsAt: item.nextRenewal,
  };
  let start: number, end: number, current: number;
  try {
    start = dateTimeInstant(period.startsAt, timeZone);
    end = dateTimeInstant(period.endsAt, timeZone);
    current = currentTime instanceof Date ? currentTime.getTime() : currentTime ? dateTimeInstant(currentTime, timeZone) : Date.now();
  } catch { return { percent: 0, label: "暂无有效账期", tone: "muted" }; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return { percent: 0, label: "暂无有效账期", tone: "muted" };
  const remaining = end - current;
  const percent = Math.round(Math.max(0, Math.min(1, (end - current) / (end - start))) * 100);
  return {
    percent,
    label: start > current ? "尚未开始" : remaining <= 0 ? "已到期" : `剩余 ${durationLabel(remaining)}`,
    tone: start > current ? "normal" : remaining <= 0 ? "expired" : remaining <= 7 * 86_400_000 ? "soon" : "normal",
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
