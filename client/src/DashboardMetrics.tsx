import { Banner } from "./components";
import type { Currency, Dashboard } from "./types";
import { money } from "./utils";

export function DashboardMetrics({ dashboard, currency, scope }: {
  dashboard: Dashboard | null;
  currency: Currency;
  scope: string;
}) {
  return <>
    <dl className="panel metrics" aria-label={`${scope}价格统计`}>
      <div className="metric">
        <dt className="metric-label">年预计支出</dt>
        <dd className="metric-value">{money(dashboard?.annualTotal, currency)}</dd>
      </div>
      <div className="metric">
        <dt className="metric-label">剩余使用价值</dt>
        <dd className="metric-value">{money(dashboard?.remainingValue, currency)}</dd>
      </div>
      <div className="metric">
        <dt className="metric-label">30 天待续费</dt>
        <dd className="metric-value">{money(dashboard?.upcomingTotal, currency)}</dd>
      </div>
    </dl>
    {dashboard?.totalsPartial && <Banner>部分币种汇率暂不可用（{dashboard.unconvertedCurrencies.join("、")}），汇总仅包含可换算的金额。</Banner>}
  </>;
}

export function RatesFooter({ dashboard }: { dashboard: Dashboard | null }) {
  return <div className="rates-footer">
    <span>{dashboard?.rates.date ? `汇率日期 ${dashboard.rates.date} · Frankfurter 参考汇率` : "汇率暂不可用 · 原币记录仍可查看"}{dashboard?.rates.stale ? " · 沿用缓存" : ""}</span>
    <span>剩余使用价值为时间摊销估算</span>
  </div>;
}
