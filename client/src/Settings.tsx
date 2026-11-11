import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  LockKeyhole,
  Mail,
  MailCheck,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import { api, errorMessage, json } from "./api";
import { Banner, Button, DeliveryList, Field } from "./components";
import { Select } from "./Select";
import { NumberInput, parseNumberInput } from "./NumberInput";
import type {
  Delivery,
  MailSettings,
  NotificationSettings,
  User,
} from "./types";
import { reminderDays } from "./utils";

const zones = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
];
const commonDays = [30, 7, 3, 1];

export function ReminderSettings({
  settings,
  user,
  onChanged,
  nextDueCount,
}: {
  settings: NotificationSettings | null;
  user: User;
  onChanged: (settings: NotificationSettings) => void;
  nextDueCount: number;
}) {
  const [recipient, setRecipient] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState<number[]>([7, 3, 1]);
  const [extraDays, setExtraDays] = useState("");
  const [zone, setZone] = useState(user.timeZone);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [logError, setLogError] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  useEffect(() => {
    if (settings && !dirty) {
      setRecipient(settings.recipientEmail || "");
      setEnabled(settings.enabled);
      setDays(settings.reminderDays.filter((n) => commonDays.includes(n)));
      setExtraDays(
        settings.reminderDays.filter((n) => !commonDays.includes(n)).join(", "),
      );
      setZone(settings.timeZone || user.timeZone);
    }
  }, [settings, dirty, user.timeZone]);
  async function loadLogs() {
    setLogsLoading(true);
    setLogError("");
    try {
      const data = await api<{ deliveries: Delivery[] }>("/me/reminder-log");
      setDeliveries(data.deliveries);
    } catch (e) {
      setLogError(errorMessage(e));
    } finally {
      setLogsLoading(false);
    }
  }
  useEffect(() => {
    void loadLogs();
  }, [user.id]);
  const verified =
    !!settings?.emailVerified && settings.recipientEmail === recipient.trim();
  const hasUnsavedEmail = settings?.recipientEmail !== recipient.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    setError("");
    try {
      const selectedDays = [
        ...new Set([...days, ...reminderDays(extraDays)]),
      ].sort((a, b) => b - a);
      setBusy(true);
      const saved = await api<NotificationSettings>(
        "/me/notification-settings",
        json("PUT", {
          recipientEmail: recipient.trim(),
          enabled,
          reminderDays: selectedDays,
          timeZone: zone,
        }),
      );
      setDirty(false);
      onChanged(saved);
      const message = saved.emailVerified
        ? "提醒设置已保存。"
        : saved.recipientEmail
          ? "提醒设置已保存，请完成收件邮箱验证。"
          : "提醒设置已保存。";
      setNotice(
        saved.verificationMessage
          ? `${message} ${saved.verificationMessage}`
          : message,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setSending(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ message: string }>(
        "/me/notification-settings/send-verification",
        json("POST"),
      );
      setNotice(result.message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }
  const mailState = !settings?.mailAvailable
    ? "邮件服务待管理员配置"
    : !settings.recipientEmail
      ? "待设置收件邮箱"
      : !settings.emailVerified
        ? "收件邮箱待验证"
        : !settings.enabled
          ? "邮件提醒已关闭"
          : "邮件提醒已开启";
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">PERSONAL NOTIFICATIONS</span>
          <h1>我的提醒</h1>
          <p>留下收件邮箱，续费提醒就会送到你手边。</p>
        </div>
        <span className="badge muted">{mailState}</span>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      <div className="settings-grid">
        <form className="panel" onSubmit={submit}>
          <div className="panel-heading">
            <h2>
              <Mail size={17} />
              邮件提醒
            </h2>
            <span className={`badge ${verified ? "" : "muted"}`}>
              {verified ? "已验证" : recipient ? "待验证" : "未设置"}
            </span>
          </div>
          <fieldset className="form-body" disabled={busy}>
            <legend className="sr-only">收件与提醒偏好</legend>
            <Banner>
              {settings?.mailAvailable
                ? "发信服务由管理员统一维护。收件邮箱验证后，网页关闭也可收到提醒。"
                : "管理员尚未启用邮件服务。你可以先保存收件邮箱，站内到期列表仍可查看。"}
            </Banner>
            <Field
              label="收件邮箱"
              help="可以与登录邮箱不同；修改后需要重新验证。"
            >
              <input
                type="email"
                autoComplete="email"
                value={recipient}
                required={enabled}
                onChange={(e) => {
                  setRecipient(e.target.value);
                  setDirty(true);
                }}
                placeholder="your@email.com"
                maxLength={254}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setDirty(true);
                }}
              />
              接收邮件提醒
            </label>
            <div>
              <p className="control-label">默认提前提醒</p>
              <div className="check-row">
                {commonDays.map((day) => (
                  <label className="check" key={day}>
                    <input
                      type="checkbox"
                      checked={days.includes(day)}
                      onChange={(e) => {
                        setDays((current) =>
                          e.target.checked
                            ? [...current, day]
                            : current.filter((n) => n !== day),
                        );
                        setDirty(true);
                      }}
                    />
                    {day} 天
                  </label>
                ))}
              </div>
            </div>
            <Field
              label="其他提前天数"
              help="可选，以逗号分隔，范围 1～365 天。"
            >
              <input
                value={extraDays}
                onChange={(e) => {
                  setExtraDays(e.target.value);
                  setDirty(true);
                }}
                placeholder="例如：14, 60"
                maxLength={100}
              />
            </Field>
            <Field label="账户时区" help="订阅时间、倒计时和邮件提醒均按此时区计算。修改时区会改变已有时间对应的实际时刻。">
              <Select
                value={zone}
                onValueChange={(value) => {
                  setZone(value);
                  setDirty(true);
                }}
                options={[...new Set([zone, ...zones])].map((value) => ({
                  value,
                  label: value,
                }))}
                aria-label="提醒时区"
                name="timeZone"
                disabled={busy}
              />
            </Field>
            {!verified && settings?.recipientEmail && (
              <Button
                type="button"
                onClick={verify}
                busy={sending}
                disabled={!settings.mailAvailable || hasUnsavedEmail}
              >
                <MailCheck size={15} />
                重新发送验证邮件
              </Button>
            )}
          </fieldset>
          <div className="form-footer">
            <span className="muted small">订阅可单独设置提醒天数</span>
            <Button type="submit" variant="primary" busy={busy}>
              <Save size={15} />
              保存提醒设置
            </Button>
          </div>
        </form>
        <aside className="stack">
          <div className="panel mail-preview">
            <MailCheck size={23} className="accent-icon" />
            <h2>续费提醒，提前到达</h2>
            <p className="muted small">
              当前有 <strong className="gradient">{nextDueCount}</strong>{" "}
              项订阅将在 30 天内续费。
            </p>
            <div className="mail-sheet">
              <span className="eyebrow gradient">RENEWLY NOTIFICATION</span>
              <h3>订阅即将到期</h3>
              <p>邮件会包含订阅名称、商家、到期时间（含时区）与原币续费价格。</p>
              <div className="mail-sign">提前安排续费，让服务持续在线。</div>
            </div>
            <p className="muted small">
              确认续费需前往商家付款，再在续记中登记。
            </p>
          </div>
          <div className="panel">
            <div className="panel-heading">
              <h2>最近投递</h2>
              <Button
                variant="ghost"
                type="button"
                onClick={loadLogs}
                busy={logsLoading}
                aria-label="刷新本人投递记录"
              >
                <RefreshCw size={14} />
              </Button>
            </div>
            {logError ? (
              <div className="panel-body">
                <Banner tone="error">{logError}</Banner>
              </div>
            ) : (
              <DeliveryList
                deliveries={deliveries.slice(0, 12)}
                timeZone={user.timeZone}
                loading={logsLoading}
              />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

const blankMail: MailSettings = {
  enabled: false,
  transport: "smtp",
  senderName: "续记",
  senderEmail: "",
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "",
  smtpPassConfigured: false,
  resendKeyConfigured: false,
};
export function AdminMail({
  user,
  onChanged,
}: {
  user: User;
  onChanged: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<MailSettings>(blankMail);
  const [draft, setDraft] = useState<MailSettings>(blankMail);
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpPass, setSmtpPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [logError, setLogError] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  async function loadLogs() {
    setLogsLoading(true);
    setLogError("");
    try {
      const data = await api<{ deliveries: Delivery[] }>("/admin/mail/logs");
      setDeliveries(data.deliveries);
    } catch (e) {
      setLogError(errorMessage(e));
    } finally {
      setLogsLoading(false);
    }
  }
  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const data = await api<MailSettings>("/admin/mail");
      setSettings(data);
      setDraft(data);
      setSmtpPort(String(data.smtpPort));
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (user.role === "admin") {
      void loadSettings();
      void loadLogs();
    }
  }, [user.id, user.role]);
  function field<K extends keyof MailSettings>(key: K, value: MailSettings[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (
      draft.enabled &&
      draft.transport === "smtp" &&
      !settings.smtpPassConfigured &&
      !smtpPass.trim()
    ) {
      setError("首次启用 SMTP 时需要填写密码或授权码。");
      return;
    }
    if (
      draft.enabled &&
      draft.transport === "resend" &&
      !settings.resendKeyConfigured &&
      !apiKey.trim()
    ) {
      setError("首次启用 Resend 时需要填写 API Key。");
      return;
    }
    setBusy(true);
    try {
      const port = draft.transport === "smtp"
        ? parseNumberInput(smtpPort, "SMTP 端口", { min: 1, max: 65535, integer: true })
        : settings.smtpPort;
      const {
        smtpPassConfigured: _smtp,
        resendKeyConfigured: _api,
        ...publicFields
      } = draft;
      const result = await api<MailSettings>(
        "/admin/mail",
        json("PUT", {
          ...publicFields,
          smtpPort: port,
          ...(smtpPass ? { smtpPass } : {}),
          ...(apiKey ? { resendApiKey: apiKey } : {}),
        }),
      );
      setSettings(result);
      setDraft(result);
      setSmtpPort(String(result.smtpPort));
      setSmtpPass("");
      setApiKey("");
      setDirty(false);
      setNotice("邮件配置已保存。");
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function test(event: FormEvent) {
    event.preventDefault();
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ message: string }>(
        "/admin/mail/test",
        json("POST", { recipientEmail: testEmail.trim() }),
      );
      setNotice(result.message);
      await loadLogs();
    } catch (e) {
      setError(errorMessage(e));
      await loadLogs();
    } finally {
      setTesting(false);
    }
  }
  const configured =
    settings.transport === "smtp"
      ? settings.smtpPassConfigured
      : settings.resendKeyConfigured;
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">SYSTEM MAIL SERVICE</span>
          <h1>系统邮件服务</h1>
          <p>统一配置发信服务，为用户投递到期提醒。</p>
        </div>
        <span className="badge warning">
          <ShieldCheck size={13} />
          仅管理员
        </span>
      </div>
      {error && (
        <Banner
          tone="error"
          action={
            loading ? undefined : (
              <Button variant="ghost" onClick={loadSettings}>
                重新加载
              </Button>
            )
          }
        >
          {error}
        </Banner>
      )}
      {notice && <Banner tone="success">{notice}</Banner>}
      <div className="settings-grid">
        <form className="panel" onSubmit={submit}>
          <div className="panel-heading">
            <h2>发送设置</h2>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={loading || busy}
                onChange={(e) => field("enabled", e.target.checked)}
              />
              启用服务
            </label>
          </div>
          <fieldset className="form-body" disabled={loading || busy}>
            <legend className="sr-only">全站发信配置</legend>
            <Field label="发信方式">
              <Select
                value={draft.transport}
                onValueChange={(value) =>
                  field("transport", value as MailSettings["transport"])
                }
                options={[
                  { value: "smtp", label: "SMTP / 邮箱授权码" },
                  { value: "resend", label: "Resend API" },
                ]}
                aria-label="发信方式"
                name="transport"
                disabled={loading || busy}
              />
            </Field>
            <div className="form-columns">
              <Field label="发件人名称 *">
                <input
                  value={draft.senderName}
                  onChange={(e) => field("senderName", e.target.value)}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="发件邮箱 *">
                <input
                  value={draft.senderEmail}
                  onChange={(e) => field("senderEmail", e.target.value)}
                  required
                  type="email"
                  placeholder="reminders@example.com"
                  maxLength={254}
                />
              </Field>
            </div>
            {draft.transport === "smtp" ? (
              <>
                <div className="form-columns">
                  <Field label="SMTP 服务器">
                    <input
                      value={draft.smtpHost}
                      onChange={(e) => field("smtpHost", e.target.value)}
                      required={draft.enabled}
                      placeholder="smtp.example.com"
                      maxLength={255}
                    />
                  </Field>
                  <Field label="端口">
                    <NumberInput
                      value={smtpPort}
                      onChange={(e) => { setSmtpPort(e.target.value); setDirty(true); }}
                      integer
                      required
                    />
                  </Field>
                </div>
                <Field label="SMTP 用户名">
                  <input
                    value={draft.smtpUser}
                    onChange={(e) => field("smtpUser", e.target.value)}
                    required={draft.enabled}
                    autoComplete="off"
                    maxLength={254}
                  />
                </Field>
                <Field
                  label="SMTP 密码 / 授权码"
                  help={
                    settings.smtpPassConfigured
                      ? "已配置。留空将保留现有凭据。"
                      : "使用邮箱服务商提供的密码或授权码。"
                  }
                >
                  <input
                    value={smtpPass}
                    onChange={(e) => {
                      setSmtpPass(e.target.value);
                      setDirty(true);
                    }}
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      settings.smtpPassConfigured
                        ? "已配置 · 留空保留"
                        : "填写密码或授权码"
                    }
                    maxLength={1000}
                  />
                </Field>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.smtpSecure}
                    onChange={(e) => field("smtpSecure", e.target.checked)}
                  />
                  TLS 直连（通常使用 465 端口）
                </label>
                <p className="muted small">
                  非 TLS 直连通常使用 587 端口，由服务端要求 STARTTLS 加密。
                </p>
              </>
            ) : (
              <Field
                label="Resend API Key"
                help="发件地址需要使用 Resend 已验证的域名；留空可保留已配置的密钥。"
              >
                <input
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setDirty(true);
                  }}
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    settings.resendKeyConfigured
                      ? "已配置 · 留空保留"
                      : "填写 API Key"
                  }
                  maxLength={1000}
                />
              </Field>
            )}
            <p className="secret-note">
              <LockKeyhole size={14} />
              凭据仅供服务端使用，保存后不回显。
            </p>
          </fieldset>
          <div className="form-footer">
            <span
              className={`badge ${settings.enabled && configured ? "" : "muted"}`}
            >
              {loading
                ? "正在加载"
                : settings.enabled && configured
                  ? "服务已启用"
                  : "服务未启用"}
            </span>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={loading}
            >
              <Save size={15} />
              保存邮件配置
            </Button>
          </div>
        </form>
        <aside className="stack">
          <form className="panel panel-body" onSubmit={test}>
            <Send className="accent-icon" size={23} />
            <h2>测试投递</h2>
            <p className="muted small">
              使用已保存的发信配置发送一封测试邮件。
            </p>
            <Field label="测试收件邮箱">
              <input
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                type="email"
                required
                placeholder="admin@example.com"
                maxLength={254}
              />
            </Field>
            <Button
              type="submit"
              busy={testing}
              disabled={loading || !settings.enabled || !configured || dirty}
              className="full-width"
            >
              <Send size={15} />
              发送测试邮件
            </Button>
            {dirty && <p className="muted small">请先保存配置，再测试投递。</p>}
          </form>
          <div className="panel">
            <div className="panel-heading">
              <h2>全站投递记录</h2>
              <Button
                variant="ghost"
                onClick={loadLogs}
                busy={logsLoading}
                aria-label="刷新全站投递记录"
              >
                <RefreshCw size={14} />
              </Button>
            </div>
            {logError ? (
              <div className="panel-body">
                <Banner tone="error">{logError}</Banner>
              </div>
            ) : (
              <DeliveryList
                deliveries={deliveries.slice(0, 20)}
                timeZone={user.timeZone}
                loading={logsLoading}
              />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
