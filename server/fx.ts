import type { DB } from "./db.js";
import { currencies, validDate } from "./domain.js";
export interface Rates {
  date: string | null;
  fetchedAt: string | null;
  stale: boolean;
  available: boolean;
  rates: Record<string, number>;
}
export function createFx(db: DB, fetcher: typeof fetch = fetch) {
  let pending: Promise<Rates> | null = null;
  let retryAfter = 0;
  const foreign = currencies.filter(currency => currency !== "CNY");
  function cached(): Rates {
    const row = db
      .prepare("SELECT * FROM exchange_rates WHERE id=1")
      .get() as any;
    let stored: Record<string, unknown> = {};
    try {
      const value = row ? JSON.parse(row.rates_json) : {};
      if (value && typeof value === "object" && !Array.isArray(value)) stored = value;
    } catch { /* Ignore a damaged cache and refresh it from the provider. */ }
    const rates: Record<string, number> = { CNY: 1 };
    for (const currency of foreign) {
      const rate = stored[currency];
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0)
        rates[currency] = rate;
    }
    return row
      ? {
          date: row.rate_date,
          fetchedAt: row.fetched_at,
          stale: !Number.isFinite(Date.parse(row.fetched_at)) || Date.now() - Date.parse(row.fetched_at) > 6 * 3600_000 || foreign.some(currency => !rates[currency]),
          available: Object.keys(rates).length > 1,
          rates,
        }
      : {
          date: null,
          fetchedAt: null,
          stale: true,
          available: false,
          rates: { CNY: 1 },
        };
  }
  async function refresh() {
    const previous = cached();
    try {
      const response = await fetcher(
        `https://api.frankfurter.dev/v2/rates?base=CNY&quotes=${foreign.join(",")}`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!response.ok) throw new Error("FX upstream unavailable");
      const rows = (await response.json()) as any[];
      if (!Array.isArray(rows)) throw new Error("Invalid FX payload");
      const rates: Record<string, number> = { ...previous.rates, CNY: 1 },
        dates: string[] = [];
      let updated = 0;
      for (const currency of foreign) {
        const matches = rows.filter((r) => r && r.base === "CNY" && r.quote === currency);
        const row = matches.length === 1 ? matches[0] : null;
        if (
          !row ||
          typeof row.rate !== "number" ||
          !Number.isFinite(row.rate) ||
          row.rate <= 0 ||
          typeof row.date !== "string" || !validDate(row.date) || !Number.isFinite(1 / row.rate)
        )
          continue;
        rates[currency] = 1 / row.rate;
        dates.push(row.date);
        updated++;
      }
      if (!updated) throw new Error("No valid FX rates");
      const complete = updated === foreign.length;
      // A partial response keeps valid cached quotes without claiming they were refreshed.
      const fetchedAt = complete || !previous.fetchedAt ? new Date().toISOString() : previous.fetchedAt;
      if (!complete && previous.date) dates.push(previous.date);
      const date = dates.sort()[0]!;
      db.prepare(
        "INSERT INTO exchange_rates VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET rate_date=excluded.rate_date,fetched_at=excluded.fetched_at,rates_json=excluded.rates_json",
      ).run(date, fetchedAt, JSON.stringify(rates));
      retryAfter = complete ? 0 : Date.now() + 5 * 60_000;
      return { date, fetchedAt, stale: !complete, available: true, rates };
    } catch {
      retryAfter = Date.now() + 5 * 60_000;
      return { ...cached(), stale: true };
    }
  }
  return {
    cached,
    async get(): Promise<Rates> {
      const value = cached();
      if (!value.stale || Date.now() < retryAfter) return value;
      if (!pending)
        pending = refresh().finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
