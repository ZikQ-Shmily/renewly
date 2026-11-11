import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDateTime,
  localDateTime,
  dateTimeInstant,
  addDateTimeMonths,
  formatDateTime,
  dateTimeRemaining,
} from "../shared/datetime.js";

test("minute timestamps keep hours and minutes and default legacy dates to midnight", () => {
  assert.equal(normalizeDateTime("2026-11-11"), "2026-11-11T00:00");
  assert.equal(normalizeDateTime("2026-11-11T23:59"), "2026-11-11T23:59");
  assert.equal(normalizeDateTime("2024-02-29T00:00"), "2024-02-29T00:00");
  assert.equal(normalizeDateTime("0001-01-01"), "0001-01-01T00:00");
  assert.equal(formatDateTime("2026-11-11"), "2026-11-11 00:00");
  assert.equal(formatDateTime("2026-11-11T18:35"), "2026-11-11 18:35");
  for (const value of [
    "", "2026-11-11 ", "2026-02-29", "2026-04-31", "2026-13-01",
    "2026-00-01", "2026-01-00", "2026-11-11T24:00", "2026-11-11T23:60",
    "2026-11-11T-1:00", "2026-11-11T2:00", "2026-11-11T00:00:00",
    "2026-11-11 12:30", "2026-11-11T12:30Z", "2026-11-11T12:30+08:00", "0000-01-01",
  ]) assert.throws(() => normalizeDateTime(value), RangeError, value);
});

test("calendar renewal keeps minute precision and its original month-end anchor", () => {
  assert.equal(addDateTimeMonths("2026-01-31T18:35", 1), "2026-02-28T18:35");
  assert.equal(addDateTimeMonths("2026-02-28T18:35", 1, 31), "2026-03-31T18:35");
  assert.equal(addDateTimeMonths("2024-01-31T00:05", 1), "2024-02-29T00:05");
  assert.equal(addDateTimeMonths("2026-12-03", 1), "2027-01-03T00:00");
  assert.equal(addDateTimeMonths("2026-01-31T18:35", -1), "2025-12-31T18:35");
  assert.throws(() => addDateTimeMonths("2026-01-01", 1.5), RangeError);
  assert.throws(() => addDateTimeMonths("2026-01-01", 1, 0), RangeError);
  assert.throws(() => addDateTimeMonths("9999-12-01", 1), RangeError);
});

test("time-zone conversion is independent of host time zone, including fractional offsets", () => {
  const now = new Date("2026-11-11T12:34:56.789Z");
  assert.equal(localDateTime(now, "Asia/Shanghai"), "2026-11-11T20:34");
  assert.equal(localDateTime(now, "America/Los_Angeles"), "2026-11-11T04:34");
  assert.equal(localDateTime(now, "Asia/Kathmandu"), "2026-11-11T18:19");
  assert.equal(dateTimeInstant("2026-11-11T20:35", "Asia/Shanghai"), Date.parse("2026-11-11T12:35:00Z"));
  assert.equal(dateTimeInstant("2026-11-11", "Asia/Shanghai"), Date.parse("2026-11-10T16:00:00Z"));
  assert.equal(dateTimeInstant("2026-11-11T18:19", "Asia/Kathmandu"), Date.parse("2026-11-11T12:34:00Z"));
  assert.equal(dateTimeRemaining("2026-11-11T20:35", "Asia/Shanghai", now), 3211);
  assert.throws(() => dateTimeInstant("2026-11-11", "Not/A_TimeZone"), RangeError);
});

test("DST nonexistent minutes are rejected and repeated minutes choose their earlier instant", () => {
  assert.throws(() => dateTimeInstant("2026-03-08T02:30", "America/New_York"), /不存在/);
  assert.equal(dateTimeInstant("2026-11-01T01:30", "America/New_York"), Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(dateTimeInstant("2026-03-08T03:30", "America/New_York"), Date.parse("2026-03-08T07:30:00Z"));
  assert.throws(() => dateTimeInstant("2026-10-04T02:15", "Australia/Lord_Howe"), /不存在/);
  assert.equal(dateTimeInstant("2026-04-05T01:45", "Australia/Lord_Howe"), Date.parse("2026-04-04T14:45:00Z"));
  assert.throws(() => dateTimeInstant("2011-12-30T12:00", "Pacific/Apia"), /不存在/);
});
