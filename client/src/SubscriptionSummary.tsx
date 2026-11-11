import { Server } from "lucide-react";
import { DueBadge } from "./components";
import type { Subscription } from "./types";
import { bandwidthLabel, formatDateTime, money, periodLabel, termProgress, trafficLabel } from "./utils";

export function TermProgress({ item, timeZone }: { item: Subscription; timeZone: string }) {
  const progress = termProgress(item, timeZone);
  return (
    <div className={`term-progress ${progress.tone}`}>
      <span>账期剩余</span>
      <div className="term-track" role="progressbar" aria-label={`${item.name}账期剩余`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={`${progress.percent}% · ${progress.label}`}>
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <span className="term-note">{progress.percent}% · {progress.label}</span>
    </div>
  );
}

export function SubscriptionColumns() {
  return <div className="subscription-columns subscription-data-grid" aria-hidden="true"><span>订阅 / 商家</span><span>地区 · 型号</span><span>带宽</span><span>流量额度</span><span>续费价格</span><span>下次续费</span></div>;
}

export function SubscriptionSummary({ item, timeZone }: { item: Subscription; timeZone: string }) {
  return (
    <article className="subscription-summary">
      <div className="subscription-data-grid">
        <div className="subscription-identity"><Server size={18} aria-hidden="true" /><div><strong>{item.name}</strong><div className="subscription-vendor"><a href={item.website} target="_blank" rel="noopener noreferrer" className="gradient">{item.vendor}</a>{item.autoRenew && <span className="auto-renew-tag">自动续费</span>}</div></div></div>
        <span className="subscription-spec">{[item.region, item.model].filter(Boolean).join(" · ") || "未填写配置"}</span>
        <span className={`subscription-bandwidth ${item.bandwidthValue == null ? "muted" : ""}`}><span className="mobile-cell-label">带宽 </span>{bandwidthLabel(item)}</span>
        <span className="subscription-traffic"><span className="mobile-cell-label">流量 </span>{trafficLabel(item)}</span>
        <span className="subscription-price">{money(item.renewalPrice, item.currency)}<small>/ {periodLabel(item.billingMonths)}</small></span>
        <div className="subscription-due"><time dateTime={item.nextRenewal} aria-label={`${formatDateTime(item.nextRenewal)} ${timeZone}`}><span>{formatDateTime(item.nextRenewal).slice(0, 10)}</span><small>{formatDateTime(item.nextRenewal).slice(11)}</small></time><DueBadge item={item} timeZone={timeZone} /></div>
      </div>
      <TermProgress item={item} timeZone={timeZone} />
    </article>
  );
}
