import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, RefreshCw } from "lucide-react";
import { api, errorMessage, json } from "./api";
import { Banner, Button, Field } from "./components";
import { ThemeSwitch } from "./ThemeSwitch";
import type { AuthConfig, User } from "./types";

export function Auth({
  config,
  initialError,
  onSignedIn,
  onRetry,
}: {
  config: AuthConfig | null;
  initialError: string;
  onSignedIn: (user: User) => void;
  onRetry: () => void;
}) {
  const [register, setRegister] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [codeNotice, setCodeNotice] = useState("");
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [currentTime, setCurrentTime] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const feedbackVersion = useRef(0);
  const mounted = useRef(true);
  const normalizedEmail = email.trim().toLowerCase();
  const cooldownUntil = cooldowns[normalizedEmail] || 0;
  const resendSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - currentTime) / 1000),
  );
  const validEmail =
    normalizedEmail.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const registrationUnavailable =
    register && (!config?.registrationEnabled || !config.registrationMailAvailable);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      feedbackVersion.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!register || cooldownUntil <= Date.now()) return;
    const tick = () => setCurrentTime(Date.now());
    tick();
    const interval = window.setInterval(() => {
      tick();
      if (Date.now() >= cooldownUntil) window.clearInterval(interval);
    }, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [register, cooldownUntil]);

  useEffect(() => {
    if (config && !config.registrationEnabled && register) {
      setRegister(false);
      feedbackVersion.current += 1;
      setVerificationCode("");
      setCodeNotice("");
      setPassword("");
      setError("");
    }
  }, [config, register]);

  function clearVerificationFeedback() {
    feedbackVersion.current += 1;
    setVerificationCode("");
    setCodeNotice("");
    setError("");
    setCurrentTime(Date.now());
  }

  async function sendCode() {
    if (
      sendingCode ||
      busy ||
      !register ||
      !validEmail ||
      !config?.adminConfigured ||
      registrationUnavailable ||
      cooldownUntil > Date.now()
    ) return;
    const address = normalizedEmail;
    const version = feedbackVersion.current;
    setSendingCode(true);
    setError("");
    setCodeNotice("");
    try {
      const result = await api<{
        message: string;
        retryAfter: number;
        expiresIn: number;
      }>("/auth/register/code", json("POST", { email: address }));
      if (!mounted.current) return;
      // Preserve this address's cooldown even if the user edits the email field.
      const now = Date.now();
      setCooldowns((previous) => ({
        ...previous,
        [address]: now + result.retryAfter * 1000,
      }));
      setCurrentTime(now);
      if (feedbackVersion.current === version) {
        setVerificationCode("");
        setCodeNotice(result.message);
      }
    } catch (e) {
      if (mounted.current && feedbackVersion.current === version)
        setError(errorMessage(e));
    } finally {
      if (mounted.current) setSendingCode(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (register && sendingCode)) return;
    if (registrationUnavailable) {
      setError("注册暂不可用，请稍后重试或联系管理员。");
      return;
    }
    if (register && !/^\d{6}$/.test(verificationCode)) {
      setError("请填写邮箱收到的6位验证码。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>(
        register ? "/auth/register" : "/auth/login",
        json("POST", {
          email: email.trim(),
          password,
          ...(register
            ? { name: name.trim(), verificationCode }
            : {}),
        }),
      );
      setPassword("");
      onSignedIn(result.user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <div className="auth-theme-control"><ThemeSwitch /></div>
      <div className="auth-intro">
        <span className="brand gradient">
          <img src="/favicon.svg?v=20261112-cards" width={26} height={26} alt="" />
          续记 Renewly
        </span>
        <span className="eyebrow gradient">YOUR SUBSCRIPTIONS, ORGANIZED</span>
        <h1>
          每一笔订阅，
          <br />
          <span className="gradient">都心中有数。</span>
        </h1>
        <p>
          集中记录订阅、整理续费预算，
          <br />
          让到期提醒比账单先到一步。
        </p>
        <div className="auth-features">
          <span>
            <i />
            多币种预算
          </span>
          <span>
            <i />
            独立账户空间
          </span>
          <span>
            <i />
            邮件到期提醒
          </span>
        </div>
      </div>
      <section className="panel auth-panel">
        <div className="auth-panel-title">
          <span className="auth-lock">
            <LockKeyhole size={21} />
          </span>
          <h2>{register ? "创建你的订阅空间" : "欢迎回来"}</h2>
          <p>
            {register
              ? "验证邮箱后，即可创建自己的订阅空间。"
              : "登录后继续掌握每一次续费。"}
          </p>
        </div>
        {initialError && (
          <Banner
            tone="error"
            action={
              <Button
                variant="ghost"
                type="button"
                onClick={onRetry}
                aria-label="重新连接服务"
              >
                <RefreshCw size={15} />
              </Button>
            }
          >
            {initialError}
          </Banner>
        )}
        {config && !config.adminConfigured && (
          <Banner>
            管理员尚未初始化。部署者需在服务器配置{" "}
            <code>BOOTSTRAP_ADMIN_EMAIL</code> 和{" "}
            <code>BOOTSTRAP_ADMIN_PASSWORD</code>，然后重启应用。
            <Button variant="ghost" type="button" onClick={onRetry}>
              重新检查
            </Button>
          </Banner>
        )}
        {register && config?.registrationEnabled && !config.registrationMailAvailable && (
          <Banner>
            注册验证码服务暂不可用，请稍后重试或联系管理员。
            <Button variant="ghost" type="button" onClick={onRetry}>
              重新检查
            </Button>
          </Banner>
        )}
        {error && <Banner tone="error">{error}</Banner>}
        <form onSubmit={submit}>
          <fieldset disabled={busy || !config?.adminConfigured || registrationUnavailable}>
            <legend className="sr-only">{register ? "注册" : "登录"}</legend>
            {register && (
              <Field label="你的称呼">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={1}
                  maxLength={60}
                  autoComplete="name"
                  placeholder="如何称呼你"
                />
              </Field>
            )}
            <Field label="邮箱">
              <input
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearVerificationFeedback();
                }}
                type="email"
                required
                autoComplete="username"
                maxLength={254}
                placeholder="you@example.com"
              />
            </Field>
            {register && (
              <div className="field auth-code-field">
                <label htmlFor="registration-code">邮箱验证码</label>
                <div className="auth-code-row">
                  <input
                    id="registration-code"
                    value={verificationCode}
                    onChange={(e) =>
                      setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    required
                    spellCheck={false}
                    aria-describedby="registration-code-help"
                    placeholder="6位验证码"
                  />
                  <Button
                    type="button"
                    onClick={sendCode}
                    busy={sendingCode}
                    disabled={!validEmail || resendSeconds > 0}
                    className="auth-send-code"
                  >
                    {sendingCode
                      ? "发送中…"
                      : resendSeconds > 0
                        ? `${resendSeconds}秒后重发`
                        : cooldownUntil
                          ? "重新发送"
                          : "发送验证码"}
                  </Button>
                </div>
                <small id="registration-code-help">验证码10分钟内有效</small>
                {codeNotice && (
                  <div className="auth-code-notice" role="status" aria-live="polite">
                    <Banner tone="success">{codeNotice}</Banner>
                  </div>
                )}
              </div>
            )}
            <Field
              label="密码"
              help={register ? "至少 12 位，可使用长口令。" : undefined}
            >
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                required
                minLength={register ? 12 : 1}
                maxLength={128}
                autoComplete={register ? "new-password" : "current-password"}
                placeholder={register ? "设置一个安全的密码" : "输入密码"}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={register && (sendingCode || !/^\d{6}$/.test(verificationCode))}
              className="full-width"
            >
              {register ? "创建账户" : "登录空间"}
              <ArrowRight size={16} />
            </Button>
          </fieldset>
        </form>
        {config?.registrationEnabled && (
          <p className="auth-switch">
            {register ? "已有账户？" : "还没有账户？"}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRegister(!register);
                clearVerificationFeedback();
                setPassword("");
              }}
            >
              {register ? "返回登录" : "创建账户"}
            </button>
          </p>
        )}
        <p className="auth-privacy">每个账户独立管理自己的订阅数据。</p>
      </section>
    </main>
  );
}
