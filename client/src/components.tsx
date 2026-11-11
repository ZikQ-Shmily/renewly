import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  LoaderCircle,
  Server,
} from "lucide-react";
import type { Delivery, Subscription } from "./types";
import { daysUntil, dueLabel, timestamp } from "./utils";

export function Button({
  children,
  busy,
  variant = "secondary",
  className = "",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  busy?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
      {children}
    </button>
  );
}
export function Banner({
  children,
  tone = "info",
  action,
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success";
  action?: ReactNode;
}) {
  const Icon =
    tone === "error" ? AlertCircle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div
      className={`banner ${tone}`}
      role={tone === "error" ? "alert" : undefined}
    >
      <Icon size={17} aria-hidden="true" />
      <div>{children}</div>
      {action}
    </div>
  );
}
export function Field({
  label,
  children,
  help,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  help?: string;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Server size={25} aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
export function DueBadge({
  item,
  timeZone,
}: {
  item: Subscription;
  timeZone: string;
}) {
  const urgent =
    item.status === "active" && daysUntil(item.nextRenewal, timeZone) <= 7;
  const expired = item.status === "active" && daysUntil(item.nextRenewal, timeZone) < 0;
  return (
    <span className={`badge ${expired ? "expired" : urgent ? "warning" : "muted"}`}>
      {dueLabel(item, timeZone)}
    </span>
  );
}
const deliveryLabels: Record<string, string> = {
  sent: "已发送",
  success: "已发送",
  delivered: "已送达",
  pending: "待发送",
  sending: "发送中",
  failed: "失败",
  retry: "待重试",
  skipped: "已跳过",
};
export function DeliveryList({
  deliveries,
  timeZone,
  loading = false,
}: {
  deliveries: Delivery[];
  timeZone: string;
  loading?: boolean;
}) {
  if (loading)
    return (
      <p className="panel-loading">
        <LoaderCircle className="spin" size={17} />
        正在加载投递记录…
      </p>
    );
  if (!deliveries.length) return <p className="quiet-empty">暂无投递记录</p>;
  return (
    <div className="delivery-list">
      {deliveries.map((item) => (
        <div className="delivery" key={item.id}>
          <div>
            <strong>{item.subscriptionName || "邮件通知"}</strong>
            <p>
              {item.daysBefore != null ? `提前 ${item.daysBefore} 天 · ` : ""}
              {timestamp(item.sentAt || item.createdAt, timeZone)}
            </p>
            {item.error && <p className="error-text">{item.error}</p>}
          </div>
          <span
            className={`badge ${item.status === "failed" ? "warning" : item.status === "sent" || item.status === "delivered" ? "" : "muted"}`}
          >
            {deliveryLabels[item.status] || item.status}
          </span>
        </div>
      ))}
    </div>
  );
}
