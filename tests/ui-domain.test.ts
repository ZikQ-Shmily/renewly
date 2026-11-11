import test from "node:test";
import assert from "node:assert/strict";
import { termProgress } from "../client/src/utils.js";
import { parseNumberInput } from "../client/src/number.js";
import type { Subscription } from "../client/src/types.js";

test("progress uses the paid period covering today after early renewal", () => {
  const item = {
    periodStart: "2026-12-03", nextRenewal: "2027-01-03",
    progressPeriod: { startsAt: "2026-11-03", endsAt: "2026-12-03" },
  } as Subscription;
  assert.deepEqual(termProgress(item, "Asia/Shanghai", "2026-11-11"), {
    percent: 73, label: "剩余 22 天", tone: "normal",
  });
  assert.equal(termProgress(item, "Asia/Shanghai", "2026-12-03").label, "今天到期");
  assert.deepEqual(termProgress(item, "Asia/Shanghai", "2026-12-04"), {
    percent: 0, label: "已到期", tone: "expired",
  });
});

test("future and invalid periods stay bounded and have clear labels", () => {
  const future = { periodStart: "2026-12-03", nextRenewal: "2027-01-03" } as Subscription;
  assert.deepEqual(termProgress(future, "Asia/Shanghai", "2026-11-11"), {
    percent: 100, label: "尚未开始", tone: "normal",
  });
  assert.equal(termProgress({ ...future, nextRenewal: "2026-12-03" }, "UTC", "2026-11-11").label, "暂无有效账期");
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
