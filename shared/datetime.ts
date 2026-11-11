const minuteMs = 60_000;
const dayMs = 86_400_000;

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

function wallInstant(parts: DateTimeParts) {
  // Date.UTC treats years 0–99 as 1900–1999; setUTCFullYear preserves them.
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function parseDateTime(value: string): DateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) throw new RangeError("日期和时间格式无效，请使用 YYYY-MM-DDTHH:mm。");
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: 0,
  };
  const date = new Date(wallInstant(parts));
  if (
    parts.year < 1 || parts.year > 9999 ||
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() + 1 !== parts.month ||
    date.getUTCDate() !== parts.day ||
    date.getUTCHours() !== parts.hour ||
    date.getUTCMinutes() !== parts.minute
  ) throw new RangeError("日期或小时、分钟无效。");
  return parts;
}

function formatParts(parts: DateTimeParts) {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Persist local wall-clock minutes; old day-only values mean midnight. */
export function normalizeDateTime(value: string): string {
  return formatParts(parseDateTime(value));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone,
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function zonedParts(instant: number | Date, timeZone: string): DateTimeParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (key: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(part => part.type === key)?.value);
  const year = read("year");
  return {
    year: parts.find(part => part.type === "era")?.value === "BC" ? 1 - year : year,
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** The current minute in the user's configured IANA time zone. */
export function localDateTime(now: Date, timeZone: string): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError("日期无效。");
  const parts = zonedParts(now, timeZone);
  if (parts.year < 1 || parts.year > 9999) throw new RangeError("日期超出支持范围。");
  return formatParts(parts);
}

function offsetAt(instant: number, timeZone: string) {
  const secondInstant = Math.floor(instant / 1000) * 1000;
  return wallInstant(zonedParts(secondInstant, timeZone)) - secondInstant;
}

const instantCache = new Map<string, number>();

/**
 * Convert local wall time to an instant without using the server/browser zone.
 * DST gaps are rejected; when a minute occurs twice, choose its earlier instant.
 */
export function dateTimeInstant(value: string, timeZone: string): number {
  const normalized = normalizeDateTime(value);
  const key = `${timeZone}\n${normalized}`;
  const cached = instantCache.get(key);
  if (cached != null) return cached;
  const wall = wallInstant(parseDateTime(normalized));
  // Sampling both sides also covers large historical offset/date-line changes.
  const offsets = new Set([-2, -1, 0, 1, 2].map(days => offsetAt(wall + days * dayMs, timeZone)));
  for (const offset of offsets) offsets.add(offsetAt(wall - offset, timeZone));
  const candidates = [...offsets]
    .map(offset => wall - offset)
    .filter(instant => {
      const parts = zonedParts(instant, timeZone);
      return parts.second === 0 && formatParts(parts) === normalized;
    });
  if (!candidates.length)
    throw new RangeError("该时间在所选时区不存在，请调整小时和分钟。");
  const result = Math.min(...candidates);
  if (instantCache.size >= 4096) instantCache.delete(instantCache.keys().next().value!);
  instantCache.set(key, result);
  return result;
}

/** Add calendar months while keeping the chosen local hour and minute. */
export function addDateTimeMonths(value: string, months: number, anchorDay?: number): string {
  if (!Number.isInteger(months)) throw new RangeError("月份增量需要为整数。");
  const parts = parseDateTime(value);
  const anchor = anchorDay ?? parts.day;
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > 31)
    throw new RangeError("账期锚点需要为 1–31 日。");
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1 + months, 1);
  date.setUTCHours(parts.hour, parts.minute, 0, 0);
  const nextMonth = new Date(date);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(anchor, nextMonth.getUTCDate()));
  return normalizeDateTime(formatParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: 0,
  }));
}

export function formatDateTime(value: string): string {
  return normalizeDateTime(value).replace("T", " ");
}

export function dateTimeRemaining(value: string, timeZone: string, now = new Date()): number {
  return dateTimeInstant(value, timeZone) - now.getTime();
}

export { minuteMs, dayMs };
