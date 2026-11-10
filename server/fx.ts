import type { DB } from "./db.js";
export interface Rates {
  date: string | null;
  fetchedAt: string | null;
  stale: boolean;
  available: boolean;
  rates: Record<string, number>;
}
export function createFx(db: DB, fetcher: typeof fetch = fetch) {
  let pending: Promise<Rates> | null = null;
  function cached(): Rates {
    const row = db
      .prepare("SELECT * FROM exchange_rates WHERE id=1")
      .get() as any;
    return row
      ? {
          date: row.rate_date,
          fetchedAt: row.fetched_at,
          stale: Date.now() - Date.parse(row.fetched_at) > 6 * 3600_000,
          available: true,
          rates: JSON.parse(row.rates_json),
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
    try {
      const response = await fetcher(
        "https://api.frankfurter.dev/v2/rates?base=CNY&quotes=USD,EUR,GBP",
        { signal: AbortSignal.timeout(6000) },
      );
      if (!response.ok) throw new Error("FX upstream unavailable");
      const rows = (await response.json()) as any[];
      if (!Array.isArray(rows)) throw new Error("Invalid FX payload");
      const rates: Record<string, number> = { CNY: 1 },
        dates: string[] = [];
      for (const currency of ["USD", "EUR", "GBP"]) {
        const row = rows.find((r) => r.base === "CNY" && r.quote === currency);
        if (
          !row ||
          typeof row.rate !== "number" ||
          !Number.isFinite(row.rate) ||
          row.rate <= 0 ||
          !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
        )
          throw new Error("Incomplete FX payload");
        rates[currency] = 1 / row.rate;
        dates.push(row.date);
      }
      const fetchedAt = new Date().toISOString(),
        date = dates.sort()[0]!;
      db.prepare(
        "INSERT INTO exchange_rates VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET rate_date=excluded.rate_date,fetched_at=excluded.fetched_at,rates_json=excluded.rates_json",
      ).run(date, fetchedAt, JSON.stringify(rates));
      return { date, fetchedAt, stale: false, available: true, rates };
    } catch {
      return { ...cached(), stale: true };
    }
  }
  return {
    cached,
    async get(): Promise<Rates> {
      const value = cached();
      if (!value.stale) return value;
      if (!pending)
        pending = refresh().finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
