import { useState, type FormEvent } from "react";
import { ArrowRight, Cloud, LockKeyhole, RefreshCw } from "lucide-react";
import { api, errorMessage, json } from "./api";
import { Banner, Button, Field } from "./components";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>(
        register ? "/auth/register" : "/auth/login",
        json("POST", {
          email: email.trim(),
          password,
          ...(register ? { name: name.trim() } : {}),
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
      <div className="auth-intro">
        <span className="brand gradient">
          <Cloud size={26} aria-hidden="true" />
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
              ? "注册后即可管理自己的订阅。"
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
        {error && <Banner tone="error">{error}</Banner>}
        <form onSubmit={submit}>
          <fieldset disabled={busy || !config?.adminConfigured}>
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
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                required
                autoComplete="username"
                maxLength={254}
                placeholder="you@example.com"
              />
            </Field>
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
              onClick={() => {
                setRegister(!register);
                setError("");
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
