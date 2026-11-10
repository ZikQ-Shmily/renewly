import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarCheck2, Save } from "lucide-react";
import { api, errorMessage, json } from "./api";
import { Banner, Button, Field } from "./components";
import type {
  Currency,
  Subscription,
  SubscriptionInput,
  SubscriptionType,
} from "./types";
import {
  addMonths,
  currencies,
  money,
  periodLabel,
  reminderDays,
  today,
} from "./utils";

interface EditorProps {
  item: Subscription | null;
  draftKey: number;
  types: SubscriptionType[];
  timeZone: string;
  defaultDays: number[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
}
type Draft = Omit<
  SubscriptionInput,
  | "purchasePrice"
  | "renewalPrice"
  | "billingMonths"
  | "paidAmount"
  | "trafficQuota"
  | "reminderDays"
> & {
  purchasePrice: string;
  renewalPrice: string;
  billingMonths: string;
  paidAmount: string;
  trafficQuota: string;
  reminderDays: string;
};
function initialDraft(
  item: Subscription | null,
  timeZone: string,
  defaultDays: number[],
): Draft {
  const start = today(timeZone);
  return item
    ? {
        ...item,
        purchasePrice: String(item.purchasePrice),
        renewalPrice: String(item.renewalPrice),
        paidAmount: String(item.paidAmount),
        billingMonths: String(item.billingMonths),
        trafficQuota:
          item.trafficQuota == null ? "" : String(item.trafficQuota),
        reminderDays: item.reminderDays.join(", "),
      }
    : {
        type: "cloud",
        name: "",
        vendor: "",
        website: "",
        currency: "CNY",
        purchasePrice: "",
        renewalPrice: "",
        paidAmount: "",
        billingMonths: "12",
        periodStart: start,
        nextRenewal: addMonths(start, 12),
        region: "",
        model: "",
        trafficMode: "unknown",
        trafficQuota: "",
        trafficUnit: "GB",
        status: "active",
        notes: "",
        reminderDays: defaultDays.join(", "),
      };
}

export function SubscriptionEditor({
  item,
  draftKey,
  types,
  timeZone,
  defaultDays,
  onSaved,
  onCancel,
}: EditorProps) {
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(item, timeZone, defaultDays),
  );
  const [endEdited, setEndEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(initialDraft(item, timeZone, defaultDays));
    setEndEdited(false);
    setError("");
  }, [draftKey]);
  function field<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => {
      const next = { ...previous, [key]: value };
      if (
        !item &&
        !endEdited &&
        (key === "billingMonths" || key === "periodStart")
      )
        next.nextRenewal = addMonths(
          next.periodStart,
          Number(next.billingMonths),
        );
      return next;
    });
  }
  function unit(value: "GB" | "TB") {
    setDraft((previous) => ({
      ...previous,
      trafficUnit: value,
      trafficQuota:
        previous.trafficQuota === ""
          ? ""
          : String(
              Number(
                (
                  (Number(previous.trafficQuota) *
                    (previous.trafficUnit === "TB" ? 1000 : 1)) /
                  (value === "TB" ? 1000 : 1)
                ).toPrecision(15),
              ),
            ),
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (draft.nextRenewal <= draft.periodStart)
        throw new Error("续费日期需要晚于本期开始日期。");
      const website = new URL(draft.website);
      if (!["http:", "https:"].includes(website.protocol))
        throw new Error("商家网站只支持 HTTP 或 HTTPS 地址。");
      const quota =
        draft.trafficMode === "limited" ? Number(draft.trafficQuota) : null;
      if (
        draft.trafficMode === "limited" &&
        (quota == null ||
          !Number.isFinite(quota) ||
          quota <= 0 ||
          !Number.isSafeInteger(
            Math.round(quota * (draft.trafficUnit === "TB" ? 1e12 : 1e9)),
          ))
      )
        throw new Error("请填写有效且大于 0 的套餐流量总额度。");
      const data: SubscriptionInput = {
        ...draft,
        purchasePrice: Number(draft.purchasePrice),
        renewalPrice: Number(draft.renewalPrice),
        paidAmount: Number(draft.paidAmount),
        billingMonths: Number(draft.billingMonths),
        trafficQuota: quota,
        reminderDays: reminderDays(draft.reminderDays),
      };
      setBusy(true);
      await api(
        item
          ? `/subscriptions/${encodeURIComponent(item.id)}`
          : "/subscriptions",
        json(item ? "PUT" : "POST", data),
      );
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={item ? "编辑订阅" : "新增订阅"}>
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">SUBSCRIPTION DETAILS</span>
          <h1>{item ? "编辑订阅" : "新增订阅"}</h1>
          <p>首购价、续费价与本期实付分别记录。</p>
        </div>
        <Button onClick={onCancel} disabled={busy}>
          <ArrowLeft size={15} />
          返回列表
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <form className="panel" onSubmit={submit}>
        <fieldset disabled={busy} className="subscription-form">
          <legend className="sr-only">订阅信息</legend>
          <h2 className="form-section first">通用订阅信息</h2>
          <Field label="订阅类型">
            {types.length > 1 ? (
              <select
                value={draft.type}
                onChange={(e) => field("type", e.target.value as "cloud")}
              >
                {types.map((type) => (
                  <option key={type.key} value={type.key}>
                    {type.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="static-field">
                {types[0]?.name || "云服务器"}
              </span>
            )}
          </Field>
          <Field label="订阅名称 *">
            <input
              value={draft.name}
              onChange={(e) => field("name", e.target.value)}
              placeholder="例如：香港 · 主站"
              required
              maxLength={100}
            />
          </Field>
          <Field label="商家 / 服务商 *">
            <input
              value={draft.vendor}
              onChange={(e) => field("vendor", e.target.value)}
              placeholder="例如：腾讯云"
              required
              maxLength={100}
            />
          </Field>
          <Field label="商家网站 *">
            <input
              value={draft.website}
              onChange={(e) => field("website", e.target.value)}
              placeholder="https://"
              type="url"
              required
              maxLength={1000}
            />
          </Field>
          <h2 className="form-section">云服务器信息</h2>
          <Field label="地区 *">
            <input
              value={draft.region}
              onChange={(e) => field("region", e.target.value)}
              placeholder="例如：中国香港"
              required
              maxLength={100}
            />
          </Field>
          <Field label="型号 / 配置 *">
            <input
              value={draft.model}
              onChange={(e) => field("model", e.target.value)}
              placeholder="例如：2 核 / 2 GB / 40 GB"
              required
              maxLength={200}
            />
          </Field>
          <Field label="流量额度类型">
            <select
              value={draft.trafficMode}
              onChange={(e) =>
                field("trafficMode", e.target.value as Draft["trafficMode"])
              }
            >
              <option value="unknown">未填写</option>
              <option value="limited">有限额度</option>
              <option value="unlimited">不限流量</option>
            </select>
          </Field>
          <Field label="流量单位" help="1 TB = 1000 GB">
            <select
              value={draft.trafficUnit}
              onChange={(e) => unit(e.target.value as "GB" | "TB")}
              disabled={draft.trafficMode !== "limited"}
            >
              <option value="GB">GB</option>
              <option value="TB">TB</option>
            </select>
          </Field>
          <Field label="套餐流量总额度">
            <input
              value={draft.trafficQuota}
              onChange={(e) => field("trafficQuota", e.target.value)}
              type="number"
              min="0"
              step="any"
              required={draft.trafficMode === "limited"}
              disabled={draft.trafficMode !== "limited"}
              placeholder="填写商家标注额度"
            />
          </Field>
          <h2 className="form-section">价格与账期</h2>
          <Field label="价格币种">
            <select
              value={draft.currency}
              onChange={(e) => field("currency", e.target.value as Currency)}
            >
              {currencies.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="计费周期">
            <select
              value={draft.billingMonths}
              onChange={(e) => field("billingMonths", e.target.value)}
            >
              {[1, 3, 6, 12, 24, 36].map((months) => (
                <option key={months} value={months}>
                  {periodLabel(months)}付
                </option>
              ))}
            </select>
          </Field>
          <Field label="购买价格 *">
            <input
              value={draft.purchasePrice}
              onChange={(e) => field("purchasePrice", e.target.value)}
              type="number"
              min="0"
              step="0.01"
              required
            />
          </Field>
          <Field label="下次续费价格 *">
            <input
              value={draft.renewalPrice}
              onChange={(e) => field("renewalPrice", e.target.value)}
              type="number"
              min="0"
              step="0.01"
              required
            />
          </Field>
          <Field label="本期实付金额 *" help="用于计算本期剩余使用价值">
            <input
              value={draft.paidAmount}
              onChange={(e) => field("paidAmount", e.target.value)}
              type="number"
              min="0"
              step="0.01"
              required
            />
          </Field>
          <Field label="本期开始日期 *">
            <input
              value={draft.periodStart}
              onChange={(e) => field("periodStart", e.target.value)}
              type="date"
              required
            />
          </Field>
          <Field label="本期截止 / 下次续费日期 *">
            <input
              value={draft.nextRenewal}
              onChange={(e) => {
                setEndEdited(true);
                field("nextRenewal", e.target.value);
              }}
              type="date"
              required
            />
          </Field>
          <Field label="订阅状态">
            <select
              value={draft.status}
              onChange={(e) =>
                field("status", e.target.value as Draft["status"])
              }
            >
              <option value="active">生效中</option>
              <option value="paused">暂停续费</option>
              <option value="archived">已归档</option>
            </select>
          </Field>
          <Field label="提前提醒天数" help="以逗号分隔，留空则关闭该订阅提醒">
            <input
              value={draft.reminderDays}
              onChange={(e) => field("reminderDays", e.target.value)}
              placeholder="7, 3, 1"
              maxLength={100}
            />
          </Field>
          <Field label="备注" wide>
            <textarea
              value={draft.notes}
              onChange={(e) => field("notes", e.target.value)}
              rows={3}
              maxLength={3000}
              placeholder="可记录用途或其他说明"
            />
          </Field>
          <div className="annual-preview wide">
            <span>
              年预计支出<small>按当前续费价年化</small>
            </span>
            <strong className="gradient">
              {money(
                (Number(draft.renewalPrice || 0) * 12) /
                  Number(draft.billingMonths),
                draft.currency,
              )}{" "}
              / 年
            </strong>
          </div>
        </fieldset>
        <div className="form-footer">
          <span className="muted small">保存到当前用户的订阅空间</span>
          <Button type="submit" variant="primary" busy={busy}>
            <Save size={15} />
            保存订阅
          </Button>
        </div>
      </form>
    </section>
  );
}

export function RenewalForm({
  item,
  onSaved,
  onCancel,
}: {
  item: Subscription | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [endEdited, setEndEdited] = useState(false);
  useEffect(() => {
    if (item) {
      setAmount(String(item.renewalPrice));
      setStart(item.nextRenewal);
      setEnd(
        addMonths(item.nextRenewal, item.billingMonths, item.billingAnchorDay),
      );
      setEndEdited(false);
      setError("");
    }
  }, [item?.id]);
  if (!item) return null;
  const subscription = item;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (start < subscription.nextRenewal || end <= start) {
      setError("新账期开始不能早于现有截止日期，且截止日期应晚于开始日期。");
      return;
    }
    setBusy(true);
    try {
      await api(
        `/subscriptions/${encodeURIComponent(subscription.id)}/renew`,
        json("POST", {
          paidAmount: Number(amount),
          periodStart: start,
          nextRenewal: end,
        }),
      );
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">RECORD A RENEWAL</span>
          <h1>登记续费</h1>
          <p>
            {item.name} · {item.vendor}
          </p>
        </div>
        <Button onClick={onCancel} disabled={busy}>
          <ArrowLeft size={15} />
          返回列表
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <Banner>
        请在商家完成付款后登记。续费会新增实付账期，保留此前的付款记录。
      </Banner>
      <form className="panel" onSubmit={submit}>
        <fieldset className="subscription-form" disabled={busy}>
          <legend className="sr-only">本次续费</legend>
          <Field label={`本次实付金额（${item.currency}）*`}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              type="number"
              min="0"
              step="0.01"
              required
            />
          </Field>
          <Field label="新账期开始 *">
            <input
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                if (!endEdited)
                  setEnd(
                    addMonths(
                      e.target.value,
                      item.billingMonths,
                      item.billingAnchorDay,
                    ),
                  );
              }}
              type="date"
              min={item.nextRenewal}
              required
            />
          </Field>
          <Field label="下次续费日期 *">
            <input
              value={end}
              onChange={(e) => {
                setEndEdited(true);
                setEnd(e.target.value);
              }}
              type="date"
              required
            />
          </Field>
        </fieldset>
        <div className="form-footer">
          <span className="muted small">
            下一周期：每{periodLabel(item.billingMonths)}
          </span>
          <Button type="submit" variant="primary" busy={busy}>
            <CalendarCheck2 size={16} />
            确认已续费
          </Button>
        </div>
      </form>
    </section>
  );
}
