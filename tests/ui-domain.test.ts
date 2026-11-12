import test from "node:test";
import assert from "node:assert/strict";
import { termProgress, durationLabel, trafficLabel } from "../client/src/utils.js";
import { parseNumberInput } from "../client/src/number.js";
import type { Subscription } from "../client/src/types.js";

test("traffic labels retain quota and distinguish single and bidirectional accounting", () => {
  const quota = { trafficMode: "limited", trafficQuota: 300, trafficUnit: "GB" } as const;
  assert.equal(trafficLabel({ ...quota, trafficDirection: "one_way" }), "300 GB · 单向");
  assert.equal(trafficLabel({ ...quota, trafficDirection: "two_way" }), "300 GB · 双向");
  assert.equal(trafficLabel({ ...quota, trafficDirection: "unknown" }), "300 GB");
  assert.equal(trafficLabel({ ...quota, trafficMode: "unlimited", trafficDirection: "two_way" }), "不限流量 · 双向");
  assert.equal(trafficLabel({ ...quota, trafficMode: "unknown", trafficDirection: "one_way" }), "单向");
});

test("progress uses the paid period covering today after early renewal", () => {
  const item = {
    periodStart: "2026-12-03", nextRenewal: "2027-01-03",
    progressPeriod: { startsAt: "2026-11-03", endsAt: "2026-12-03" },
  } as Subscription;
  assert.deepEqual(termProgress(item, "Asia/Shanghai", "2026-11-11"), {
    percent: 73.33, label: "剩余 22 天", tone: "normal",
  });
  assert.equal(termProgress(item, "Asia/Shanghai", "2026-12-03").label, "已到期");
  assert.deepEqual(termProgress(item, "Asia/Shanghai", "2026-12-04"), {
    percent: 0, label: "已到期", tone: "expired",
  });
});

test("progress changes at the exact minute in the account time zone", () => {
  const item = { periodStart: "2026-11-11T19:30", nextRenewal: "2026-11-11T20:30" } as Subscription;
  assert.deepEqual(termProgress(item, "Asia/Shanghai", new Date("2026-11-11T12:00:00Z")), { percent: 50, label: "剩余 30 分钟", tone: "urgent" });
  assert.equal(termProgress(item, "Asia/Shanghai", new Date("2026-11-11T12:30:00Z")).label, "已到期");
  assert.equal(durationLabel(90 * 60_000), "1 小时 30 分钟");
});

test("future and invalid periods stay bounded and have clear labels", () => {
  const future = { periodStart: "2026-12-03", nextRenewal: "2027-01-03" } as Subscription;
  assert.deepEqual(termProgress(future, "Asia/Shanghai", "2026-11-11"), {
    percent: 100, label: "尚未开始", tone: "normal",
  });
  assert.equal(termProgress({ ...future, nextRenewal: "2026-12-03" }, "UTC", "2026-11-11").label, "暂无有效账期");
  assert.equal(termProgress(future, "UTC", new Date(NaN)).tone, "muted");
});

test("progress color follows the unrounded remaining period ratio", () => {
  const item = { periodStart: "2026-01-01", nextRenewal: "2026-04-11" } as Subscription;
  const end = Date.parse("2026-04-11T00:00:00Z");
  const duration = 100 * 86_400_000;
  const cases = [
    { ratio: 1, tone: "normal" },
    { ratio: 0.50001, tone: "normal" },
    { ratio: 0.5, tone: "warning" },
    { ratio: 0.20001, tone: "warning" },
    { ratio: 0.2, tone: "soon" },
    { ratio: 0.10001, tone: "soon" },
    { ratio: 0.1, tone: "urgent" },
    { ratio: 0, tone: "expired" },
  ];
  for (const { ratio, tone } of cases) {
    const progress = termProgress(item, "UTC", new Date(end - duration * ratio));
    assert.equal(progress.tone, tone, `remaining ratio ${ratio}`);
    assert.equal(progress.percent, Math.round(ratio * 10_000) / 100);
  }
});

test("annual billing progress retains small daily and hourly changes", () => {
  const item = { periodStart: "2026-01-01", nextRenewal: "2027-01-01" } as Subscription;
  assert.equal(termProgress(item, "UTC", "2026-12-31").percent, 0.27);
  assert.equal(termProgress(item, "UTC", "2026-12-31T23:00").percent, 0.01);
  assert.equal(termProgress(item, "UTC", "2027-01-01").percent, 0);
  assert.equal(termProgress(item, "UTC", "2025-12-31").percent, 100);
});

test("upcoming deadlines intensify progress color for short billing periods", () => {
  const item = { periodStart: "2026-11-01", nextRenewal: "2026-11-11" } as Subscription;
  assert.equal(termProgress(item, "UTC", "2026-11-03").tone, "normal");
  assert.equal(termProgress(item, "UTC", "2026-11-04").tone, "soon");
  assert.equal(termProgress(item, "UTC", "2026-11-10").tone, "urgent");
  assert.equal(termProgress(item, "UTC", "2026-11-11").tone, "expired");
});

test("text number inputs reject missing and malformed amounts instead of saving zero", () => {
  for (const value of ["", " ", "-1", "1e3", "Infinity", "298.999", "1,000"])
    assert.throws(() => parseNumberInput(value, "本期费用", { max: 1e9, decimalPlaces: 2 }));
  assert.equal(parseNumberInput("0", "本期费用", { decimalPlaces: 2 }), 0);
  assert.equal(parseNumberInput("298.90", "本期费用", { decimalPlaces: 2 }), 298.9);
  assert.equal(parseNumberInput("465", "端口", { min: 1, max: 65535, integer: true }), 465);
  for (const value of ["", "0", "65536", "465.5"])
    assert.throws(() => parseNumberInput(value, "端口", { min: 1, max: 65535, integer: true }));
});
