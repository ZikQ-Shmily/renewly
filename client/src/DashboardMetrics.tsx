import { CalendarClock, Hourglass, Wallet } from "lucide-react";
import { Banner } from "./components";
import type { Currency, Dashboard } from "./types";
import { money } from "./utils";

export function DashboardMetrics({ dashboard, currency, scope }: {
  dashboard: Dashboard | null;
  currency: Currency;
  scope: string;
}) {
  return <>
    <div className="metrics" aria-label={`${scope}价格统计`}>
      <div className="panel metric">
        <div className="metric-label">年预计支出<Wallet size={17} /></div>
        <strong className="metric-value gradient">{money(dashboard?.annualTotal, currency)}</strong>
        <p>{scope} · {dashboard?.activeCount ?? "—"} 项有效订阅</p>
      </div>
      <div className="panel metric">
        <div className="metric-label">剩余使用价值<Hourglass size={17} /></div>
        <strong className="metric-value gradient">{money(dashboard?.remainingValue, currency)}</strong>
        <p>{scope} · 已付账期按时间估算</p>
      </div>
      <div className="panel metric">
        <div className="metric-label">30 天待续费<CalendarClock size={17} /></div>
        <strong className="metric-value gradient">{money(dashboard?.upcomingTotal, currency)}</strong>
        <p>{scope} · {dashboard?.dueCount ?? "—"} 项即将续费</p>
      </div>
    </div>
    {dashboard?.totalsPartial && <Banner>部分币种汇率暂不可用（{dashboard.unconvertedCurrencies.join("、")}），汇总仅包含可换算的金额。</Banner>}
  </>;
}

export function RatesFooter({ dashboard }: { dashboard: Dashboard | null }) {
  return <div className="rates-footer">
    <span>{dashboard?.rates.date ? `汇率日期 ${dashboard.rates.date} · Frankfurter 参考汇率` : "汇率暂不可用 · 原币记录仍可查看"}{dashboard?.rates.stale ? " · 沿用缓存" : ""}</span>
    <span>剩余使用价值为时间摊销估算</span>
  </div>;
}
