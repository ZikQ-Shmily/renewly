import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarCheck2, Plus, Save, X } from "lucide-react";
import { api, errorMessage, json } from "./api";
import { Banner, Button, Field } from "./components";
import { Select } from "./Select";
import { NumberInput, parseNumberInput } from "./NumberInput";
import { AppIconPicker } from "./AppIcon";
import { dateTimeInstant, normalizeDateTime } from "../../shared/datetime.js";
import type {
  Currency,
  Subscription,
  SubscriptionInput,
  SubscriptionType,
  ServerIpAddress,
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
  category: "cloud" | "app";
  types: SubscriptionType[];
  timeZone: string;
  defaultDays: number[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
}
type Draft = Omit<
  SubscriptionInput,
  | "renewalPrice"
  | "billingMonths"
  | "paidAmount"
  | "trafficQuota"
  | "trafficDirection"
  | "bandwidthValue"
  | "cpuCores"
  | "memoryValue"
  | "memoryUnit"
  | "diskValue"
  | "diskUnit"
  | "ipAddresses"
  | "reminderDays"
  | "appPlan"
  | "appChannel"
  | "appAccount"
  | "appIcon"
  | "serverIcon"
> & {
  renewalPrice: string;
  billingMonths: string;
  paidAmount: string;
  trafficQuota: string;
  trafficDirection: "one_way" | "two_way" | "unknown";
  bandwidthValue: string;
  cpuCores: string;
  memoryValue: string;
  memoryUnit: "MB" | "GB";
  diskValue: string;
  diskUnit: "GB" | "TB";
  ipAddresses: ServerIpAddress[];
  reminderDays: string;
  appPlan: string;
  appChannel: string;
  appAccount: string;
  appIcon: string;
  serverIcon: string;
};
function initialDraft(
  item: Subscription | null,
  category: "cloud" | "app",
  timeZone: string,
  defaultDays: number[],
): Draft {
  const start = `${today(timeZone)}T00:00`;
  return item
    ? {
        ...item,
        appPlan: item.appPlan || "",
        appChannel: item.appChannel || "官网",
        appAccount: item.appAccount || "",
        appIcon: item.appIcon || "auto",
        serverIcon: item.serverIcon || "auto",
        periodStart: normalizeDateTime(item.periodStart),
        nextRenewal: normalizeDateTime(item.nextRenewal),
        renewalPrice: String(item.renewalPrice),
        paidAmount: String(item.paidAmount),
        billingMonths: String(item.billingMonths),
        trafficQuota:
          item.trafficQuota == null ? "" : String(item.trafficQuota),
        trafficDirection: item.trafficDirection || "unknown",
        bandwidthValue:
          item.bandwidthValue == null ? "" : String(item.bandwidthValue),
        bandwidthUnit: item.bandwidthUnit || "Mbps",
        cpuCores: item.cpuCores == null ? "" : String(item.cpuCores),
        memoryValue: item.memoryValue == null ? "" : String(item.memoryValue),
        memoryUnit: item.memoryUnit || "GB",
        diskValue: item.diskValue == null ? "" : String(item.diskValue),
        diskUnit: item.diskUnit || "GB",
        ipAddresses: item.ipAddresses?.map((address) => ({ ...address })) || [],
        autoRenew: item.autoRenew || false,
        reminderDays: item.reminderDays.join(", "),
      }
    : {
        type: category,
        name: "",
        vendor: "",
        website: "",
        currency: "CNY",
        purchasePrice: 0,
        renewalPrice: "",
        paidAmount: "",
        billingMonths: category === "app" ? "1" : "12",
        periodStart: start,
        nextRenewal: addMonths(start, category === "app" ? 1 : 12),
        appPlan: "",
        appChannel: "官网",
        appAccount: "",
        appIcon: "auto",
        serverIcon: "auto",
        region: "",
        model: "",
        cpuCores: "",
        memoryValue: "",
        memoryUnit: "GB",
        diskValue: "",
        diskUnit: "GB",
        ipAddresses: [],
        trafficMode: "unknown",
        trafficDirection: "unknown",
        trafficQuota: "",
        trafficUnit: "GB",
        bandwidthValue: "",
        bandwidthUnit: "Mbps",
        autoRenew: false,
        status: "active",
        notes: "",
        reminderDays: defaultDays.join(", "),
      };
}

export function SubscriptionEditor({
  item,
  draftKey,
  category,
  types,
  timeZone,
  defaultDays,
  onSaved,
  onCancel,
}: EditorProps) {
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(item, category, timeZone, defaultDays),
  );
  const [endEdited, setEndEdited] = useState(false);
  const [differentRenewal, setDifferentRenewal] = useState(
    item != null && item.renewalPrice !== item.paidAmount,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(initialDraft(item, category, timeZone, defaultDays));
    setEndEdited(false);
    setDifferentRenewal(item != null && item.renewalPrice !== item.paidAmount);
    setError("");
  }, [draftKey]);
  const isApp = draft.type === "app";
  const categoryName = isApp ? "App 订阅" : "云服务器";
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
        !/^[0-9]+(?:[.][0-9]+)?$/.test(previous.trafficQuota.trim())
          ? previous.trafficQuota
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
  function toggleDifferentRenewal(checked: boolean) {
    setDifferentRenewal(checked);
    if (checked && !draft.renewalPrice.trim())
      field("renewalPrice", draft.paidAmount);
  }
  function ipAddress(index: number, value: Partial<ServerIpAddress>) {
    setDraft((previous) => ({
      ...previous,
      ipAddresses: previous.ipAddresses.map((address, entryIndex) =>
        entryIndex === index ? { ...address, ...value } : address,
      ),
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const periodStart = normalizeDateTime(draft.periodStart);
      const nextRenewal = normalizeDateTime(draft.nextRenewal);
      if (
        dateTimeInstant(nextRenewal, timeZone) <=
        dateTimeInstant(periodStart, timeZone)
      )
        throw new Error("续费时间需要晚于本期开始时间。");
      if (!isApp || draft.website.trim()) {
        const website = new URL(draft.website.trim());
        if (!["http:", "https:"].includes(website.protocol) || website.username || website.password)
          throw new Error("网站只支持不含账户或密码的 HTTP 或 HTTPS 地址。");
      }
      const quota =
        draft.trafficMode === "limited"
          ? parseNumberInput(draft.trafficQuota, "套餐流量总额度")
          : null;
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
      const paidAmount = parseNumberInput(draft.paidAmount, "本期费用", {
        max: 1_000_000_000,
        decimalPlaces: 2,
      });
      const renewalPrice = differentRenewal
        ? parseNumberInput(draft.renewalPrice, "下次续费价格", {
            max: 1_000_000_000,
            decimalPlaces: 2,
          })
        : paidAmount;
      const bandwidthValue = draft.bandwidthValue.trim()
        ? parseNumberInput(draft.bandwidthValue, "套餐带宽", { max: 1e9 })
        : null;
      if (bandwidthValue != null && bandwidthValue <= 0)
        throw new Error("套餐带宽需要大于 0，或留空表示未填写。");
      const configurationNumber = (value: string, label: string) => {
        if (!value.trim()) return null;
        const number = parseNumberInput(value, label, { max: 1e9 });
        if (number <= 0) throw new Error(`${label}需要大于 0，或留空表示未填写。`);
        return number;
      };
      const ipAddresses = draft.ipAddresses.map((address) => ({
        ...address,
        address: address.address.trim(),
      }));
      if (ipAddresses.some((address) => address.type === "static" && !address.address))
        throw new Error("请填写静态 IP 地址，或移除空白条目。");
      const data: SubscriptionInput = {
        ...draft,
        website: draft.website.trim(),
        periodStart,
        nextRenewal,
        purchasePrice: item?.purchasePrice ?? paidAmount,
        renewalPrice,
        paidAmount,
        billingMonths: Number(draft.billingMonths),
        trafficQuota: quota,
        bandwidthValue,
        cpuCores: configurationNumber(draft.cpuCores, "CPU 核数"),
        memoryValue: configurationNumber(draft.memoryValue, "内存"),
        diskValue: configurationNumber(draft.diskValue, "磁盘"),
        ipAddresses,
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
  const previewPriceText = (
    differentRenewal ? draft.renewalPrice : draft.paidAmount
  ).trim();
  const previewPrice = /^[0-9]+(?:[.][0-9]+)?$/.test(previewPriceText)
    ? Number(previewPriceText)
    : null;
  return (
    <section aria-label={`${item ? "编辑" : "新增"}${categoryName}`}>
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">{isApp ? "APP SUBSCRIPTION" : "SERVER DETAILS"}</span>
          <h1>{item ? "编辑" : "新增"}{categoryName}</h1>
          <p>录入一次费用，安排下一次续费。</p>
        </div>
        <Button onClick={onCancel} disabled={busy}>
          <ArrowLeft size={15} />
          返回{categoryName}
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <form className="panel" onSubmit={submit}>
        <fieldset disabled={busy} className="subscription-form">
          <legend className="sr-only">订阅信息</legend>
          <h2 className="form-section first">通用订阅信息</h2>
          <Field label="订阅类型">
            <span className="static-field">
              {types.find((type) => type.key === draft.type)?.name || categoryName}
            </span>
          </Field>
          <Field label={isApp ? "App 名称 *" : "订阅名称 *"}>
            <input
              value={draft.name}
              onChange={(e) => field("name", e.target.value)}
              placeholder={isApp ? "例如：Notion、iCloud+" : "例如：香港 · 主站"}
              required
              maxLength={100}
            />
          </Field>
          {isApp && <Field label="套餐 / 版本">
            <input
              value={draft.appPlan}
              onChange={(e) => field("appPlan", e.target.value)}
              placeholder="例如：Plus、200 GB"
              maxLength={100}
            />
          </Field>}
          <Field label={isApp ? "服务商" : "商家 / 服务商 *"}>
            <input
              value={draft.vendor}
              onChange={(e) => field("vendor", e.target.value)}
              placeholder={isApp ? "例如：Apple、Notion" : "例如：腾讯云"}
              required={!isApp}
              maxLength={100}
            />
          </Field>
          <Field label={isApp ? "官网 / 管理地址" : "商家网站 *"}>
            <input
              value={draft.website}
              onChange={(e) => field("website", e.target.value)}
              placeholder="https://"
              type="url"
              required={!isApp}
              maxLength={1000}
            />
          </Field>
          {isApp && <>
            <Field label="购买渠道">
              <Select
                value={draft.appChannel}
                onValueChange={(value) => field("appChannel", value)}
                options={["官网", "App Store", "Google Play", "应用内购", "其他"].map((value) => ({ value, label: value }))}
                name="appChannel"
                aria-label="购买渠道"
                disabled={busy}
              />
            </Field>
            <Field label="订阅账户" help="只记录邮箱或用户名，无需填写密码。">
              <input
                value={draft.appAccount}
                onChange={(e) => field("appAccount", e.target.value)}
                placeholder="邮箱或用户名（选填）"
                maxLength={200}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            <div className="wide">
              <AppIconPicker
                name={draft.name}
                website={draft.website}
                value={draft.appIcon}
                onChange={(value) => field("appIcon", value)}
                disabled={busy}
              />
            </div>
          </>}
          {!isApp && <>
          <div className="wide">
            <AppIconPicker
              label="商家图标"
              name={draft.vendor}
              website={draft.website}
              value={draft.serverIcon}
              onChange={(value) => field("serverIcon", value)}
              fallbackInitial
              disabled={busy}
            />
          </div>
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
          <div className="cloud-config-grid wide">
            <Field label="CPU">
              <div className="cloud-unit-input">
                <NumberInput
                  value={draft.cpuCores}
                  onChange={(e) => field("cpuCores", e.target.value)}
                  placeholder="未填写"
                  aria-label="CPU 核数"
                  maxLength={24}
                />
                <span className="cloud-unit-label">核</span>
              </div>
            </Field>
            <Field label="内存">
              <div className="field-combo">
                <NumberInput
                  value={draft.memoryValue}
                  onChange={(e) => field("memoryValue", e.target.value)}
                  placeholder="未填写"
                  aria-label="内存数值"
                  maxLength={24}
                />
                <Select
                  value={draft.memoryUnit}
                  onValueChange={(value) => field("memoryUnit", value as Draft["memoryUnit"])}
                  options={[{ value: "GB", label: "GB" }, { value: "MB", label: "MB" }]}
                  aria-label="内存单位"
                  name="memoryUnit"
                  disabled={busy}
                />
              </div>
            </Field>
            <Field label="磁盘">
              <div className="field-combo">
                <NumberInput
                  value={draft.diskValue}
                  onChange={(e) => field("diskValue", e.target.value)}
                  placeholder="未填写"
                  aria-label="磁盘数值"
                  maxLength={24}
                />
                <Select
                  value={draft.diskUnit}
                  onValueChange={(value) => field("diskUnit", value as Draft["diskUnit"])}
                  options={[{ value: "GB", label: "GB" }, { value: "TB", label: "TB" }]}
                  aria-label="磁盘单位"
                  name="diskUnit"
                  disabled={busy}
                />
              </div>
            </Field>
          </div>
          {draft.model && (
            <Field label="原配置（兼容记录）" wide>
              <input
                value={draft.model}
                onChange={(e) => field("model", e.target.value)}
                maxLength={200}
              />
            </Field>
          )}
          <Field label="套餐带宽" help="选填，填写商家标称带宽">
            <div className="field-combo">
              <NumberInput
                value={draft.bandwidthValue}
                onChange={(e) => field("bandwidthValue", e.target.value)}
                placeholder="未填写"
                aria-label="带宽数值"
                maxLength={24}
              />
              <Select
                value={draft.bandwidthUnit}
                onValueChange={(value) =>
                  field("bandwidthUnit", value as Draft["bandwidthUnit"])
                }
                options={[
                  { value: "Mbps", label: "Mbps" },
                  { value: "Gbps", label: "Gbps" },
                ]}
                aria-label="带宽单位"
                name="bandwidthUnit"
                disabled={busy}
              />
            </div>
          </Field>
          <Field label="流量额度类型">
            <Select
              value={draft.trafficMode}
              onValueChange={(value) =>
                field("trafficMode", value as Draft["trafficMode"])
              }
              options={[
                { value: "unknown", label: "未填写" },
                { value: "limited", label: "有限额度" },
                { value: "unlimited", label: "不限流量" },
              ]}
              aria-label="流量额度类型"
              name="trafficMode"
              disabled={busy}
            />
          </Field>
          <Field label="流量计费方向">
            <Select
              value={draft.trafficDirection}
              onValueChange={(value) =>
                field("trafficDirection", value as Draft["trafficDirection"])
              }
              options={[
                { value: "unknown", label: "未填写" },
                { value: "one_way", label: "单向" },
                { value: "two_way", label: "双向" },
              ]}
              aria-label="流量计费方向"
              name="trafficDirection"
              disabled={busy}
            />
          </Field>
          <Field label="套餐流量总额度" help="1 TB = 1000 GB" wide>
            <div className="field-combo">
              <NumberInput
                value={draft.trafficQuota}
                onChange={(e) => field("trafficQuota", e.target.value)}
                required={draft.trafficMode === "limited"}
                disabled={draft.trafficMode !== "limited"}
                placeholder="填写商家标注额度"
                aria-label="套餐流量总额度"
                maxLength={24}
              />
              <Select
                value={draft.trafficUnit}
                onValueChange={(value) => unit(value as "GB" | "TB")}
                options={[
                  { value: "GB", label: "GB" },
                  { value: "TB", label: "TB" },
                ]}
                aria-label="流量单位"
                name="trafficUnit"
                disabled={busy || draft.trafficMode !== "limited"}
              />
            </div>
          </Field>
          <div className="cloud-ip-heading wide">
            <h2>IP 地址</h2>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || draft.ipAddresses.length >= 20}
              onClick={() => field("ipAddresses", [...draft.ipAddresses, { type: "static", address: "" }])}
            >
              <Plus size={14} />
              添加 IP
            </Button>
          </div>
          <div className="cloud-ip-list wide">
            {draft.ipAddresses.map((address, index) => (
              <div className="cloud-ip-row" key={index}>
                <Field label="地址类型">
                  <Select
                    value={address.type}
                    onValueChange={(value) => ipAddress(index, { type: value as ServerIpAddress["type"] })}
                    options={[{ value: "static", label: "静态 IP" }, { value: "dynamic", label: "动态 IP" }]}
                    aria-label={`第 ${index + 1} 个 IP 地址类型`}
                    name={`ipType-${index}`}
                    disabled={busy}
                  />
                </Field>
                <Field label={address.type === "dynamic" ? "当前 IP（选填）" : "IP 地址"}>
                  <input
                    value={address.address}
                    onChange={(e) => ipAddress(index, { address: e.target.value })}
                    aria-label={`第 ${index + 1} 个 IP 地址`}
                    placeholder="IPv4 或 IPv6"
                    maxLength={45}
                    required={address.type === "static"}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  className="cloud-ip-remove"
                  aria-label={`移除第 ${index + 1} 个 IP`}
                  onClick={() => field("ipAddresses", draft.ipAddresses.filter((_, entryIndex) => entryIndex !== index))}
                >
                  <X size={15} />
                </Button>
              </div>
            ))}
            <p className="muted small cloud-ip-help">
              {draft.ipAddresses.length ? "支持 IPv4 和 IPv6，动态 IP 可手动更新当前地址。" : "可添加静态或动态 IP，支持 IPv4 和 IPv6。"}
            </p>
          </div>
          </>}
          <h2 className="form-section">价格与账期</h2>
          <div className="price-fields wide">
            <Field label="本期费用 *">
              <NumberInput
                value={draft.paidAmount}
                onChange={(e) => field("paidAmount", e.target.value)}
                decimalPlaces={2}
                required
                maxLength={24}
              />
            </Field>
            <Field label="价格币种">
              <Select
                value={draft.currency}
                onValueChange={(value) => field("currency", value as Currency)}
                options={currencies}
                aria-label="价格币种"
                name="currency"
                disabled={busy}
              />
            </Field>
            <Field label="计费周期">
              <Select
                value={draft.billingMonths}
                onValueChange={(value) => field("billingMonths", value)}
                options={[1, 3, 6, 12, 24, 36].map((months) => ({
                  value: String(months),
                  label: `${periodLabel(months)}付`,
                }))}
                aria-label="计费周期"
                name="billingMonths"
                disabled={busy}
              />
            </Field>
          </div>
          <div className="renewal-price-toggle wide">
            <label className="check">
              <input
                type="checkbox"
                checked={differentRenewal}
                onChange={(e) => toggleDifferentRenewal(e.target.checked)}
              />
              下次续费价格不同
            </label>
          </div>
          {differentRenewal && (
            <div className="renewal-price-field wide">
              <Field label="下次续费价格 *">
                <NumberInput
                  value={draft.renewalPrice}
                  onChange={(e) => field("renewalPrice", e.target.value)}
                  decimalPlaces={2}
                  required
                  maxLength={24}
                />
              </Field>
              <p className="muted small">适用于首购优惠、折扣或调价。</p>
            </div>
          )}
          <Field label="本期开始时间 *">
            <input
              value={draft.periodStart}
              onChange={(e) => field("periodStart", e.target.value)}
              type="datetime-local"
              step={60}
              required
            />
          </Field>
          <Field label="本期截止 / 下次续费时间 *">
            <input
              value={draft.nextRenewal}
              onChange={(e) => {
                setEndEdited(true);
                field("nextRenewal", e.target.value);
              }}
              type="datetime-local"
              step={60}
              required
            />
          </Field>
          <p className="muted small wide">
            按账户时区 {timeZone} 填写，未指定时间默认为 00:00。
          </p>
          <div className="auto-renew-setting wide">
            <label className="switch-control">
              <input
                type="checkbox"
                role="switch"
                checked={draft.autoRenew}
                onChange={(e) => field("autoRenew", e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span>自动续费</span>
            </label>
            <p className="muted small">自动续费同样发送到期提醒；确认商家扣款成功后，再登记续费。</p>
          </div>
          {isApp && <p className="muted small wide">邮件提醒沿用「我的提醒」中的收件邮箱，发件服务由管理员统一配置。</p>}
          <Field label="订阅状态">
            <Select
              value={draft.status}
              onValueChange={(value) =>
                field("status", value as Draft["status"])
              }
              options={[
                { value: "active", label: "生效中" },
                { value: "paused", label: "暂停续费" },
                { value: "archived", label: "已归档" },
              ]}
              aria-label="订阅状态"
              name="status"
              disabled={busy}
            />
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
                previewPrice == null
                  ? null
                  : (previewPrice * 12) / Number(draft.billingMonths),
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
  timeZone,
  onSaved,
  onCancel,
}: {
  item: Subscription | null;
  timeZone: string;
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
      const nextRenewal = normalizeDateTime(item.nextRenewal);
      setStart(nextRenewal);
      setEnd(
        addMonths(nextRenewal, item.billingMonths, item.billingAnchorDay),
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
    try {
      const periodStart = normalizeDateTime(start);
      const nextRenewal = normalizeDateTime(end);
      const startInstant = dateTimeInstant(periodStart, timeZone);
      if (
        startInstant < dateTimeInstant(subscription.nextRenewal, timeZone) ||
        dateTimeInstant(nextRenewal, timeZone) <= startInstant
      )
        throw new Error("新账期开始不能早于现有截止时间，且截止时间应晚于开始时间。");
      const paidAmount = parseNumberInput(amount, "本次实付金额", {
        max: 1_000_000_000,
        decimalPlaces: 2,
      });
      setBusy(true);
      await api(
        `/subscriptions/${encodeURIComponent(subscription.id)}/renew`,
        json("POST", {
          paidAmount,
          periodStart,
          nextRenewal,
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
        {item.autoRenew && "已开启商家自动续费的订阅，也请在确认扣款后登记。"}
      </Banner>
      <form className="panel" onSubmit={submit}>
        <fieldset className="subscription-form" disabled={busy}>
          <legend className="sr-only">本次续费</legend>
          <Field label={`本次实付金额（${item.currency}）*`}>
            <NumberInput
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              decimalPlaces={2}
              required
              maxLength={24}
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
              type="datetime-local"
              step={60}
              min={normalizeDateTime(item.nextRenewal)}
              required
            />
          </Field>
          <Field label="下次续费时间 *">
            <input
              value={end}
              onChange={(e) => {
                setEndEdited(true);
                setEnd(e.target.value);
              }}
              type="datetime-local"
              step={60}
              required
            />
          </Field>
          <p className="muted small wide">
            按账户时区 {timeZone} 填写，未指定时间默认为 00:00。
          </p>
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
