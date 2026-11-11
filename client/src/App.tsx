import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarClock,
  Cloud,
  Hourglass,
  Layers,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import { ApiError, api, errorMessage, json } from "./api";
import { Auth } from "./Auth";
import { Banner, Button, DueBadge, EmptyState } from "./components";
import { SubscriptionEditor, RenewalForm } from "./SubscriptionEditor";
import { AdminMail, ReminderSettings } from "./Settings";
import { Select } from "./Select";
import type {
  AuthConfig,
  Currency,
  Dashboard,
  NotificationSettings,
  Subscription,
  SubscriptionType,
  User,
} from "./types";
import {
  currencies,
  daysUntil,
  money,
  periodLabel,
  trafficLabel,
} from "./utils";

type Page = "overview" | "manage" | "editor" | "renew" | "reminders" | "admin";
const pageTitles: Record<Page, string> = {
  overview: "全部订阅",
  manage: "订阅管理",
  editor: "订阅信息",
  renew: "登记续费",
  reminders: "我的提醒",
  admin: "系统邮件",
};
function hashPage(): Page {
  const value = window.location.hash.slice(1);
  return ["overview", "manage", "reminders", "admin"].includes(value)
    ? (value as Page)
    : "overview";
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [page, setPage] = useState<Page>(hashPage);
  const [category, setCategory] = useState("all");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [types, setTypes] = useState<SubscriptionType[]>([]);
  const [notifications, setNotifications] =
    useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preferencesBusy, setPreferencesBusy] = useState(false);
  const [editorItem, setEditorItem] = useState<Subscription | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [renewalItem, setRenewalItem] = useState<Subscription | null>(null);
  const requestVersion = useRef(0);
  function clearData() {
    requestVersion.current++;
    setDashboard(null);
    setSubscriptions([]);
    setTypes([]);
    setNotifications(null);
    setError("");
    setNotice("");
  }
  const signOutLocally = useCallback(() => {
    requestVersion.current++;
    setUser(null);
    setDashboard(null);
    setSubscriptions([]);
    setNotifications(null);
    setTypes([]);
  }, []);
  async function initialize() {
    setBooting(true);
    setBootError("");
    try {
      const config = await api<AuthConfig>("/auth/config");
      setAuthConfig(config);
      try {
        const result = await api<{ user: User }>("/me");
        setUser(result.user);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
    } catch (e) {
      setBootError(errorMessage(e));
    } finally {
      setBooting(false);
    }
  }
  useEffect(() => {
    void initialize();
    const expired = () => signOutLocally();
    window.addEventListener("renewly:unauthorized", expired);
    const navigate = () => setPage(hashPage());
    window.addEventListener("hashchange", navigate);
    return () => {
      window.removeEventListener("renewly:unauthorized", expired);
      window.removeEventListener("hashchange", navigate);
    };
  }, []);
  useEffect(() => {
    if (user && page === "admin" && user.role !== "admin") navigate("overview");
  }, [user, page]);
  function navigate(next: Page) {
    setPage(next);
    setError("");
    setNotice("");
    if (next !== "editor" && next !== "renew")
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${next}`,
      );
  }
  const loadData = useCallback(async () => {
    if (!user) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const [summary, list, categoryData, notificationData] = await Promise.all(
        [
          api<Dashboard>(`/dashboard?currency=${user.currency}`),
          api<{ subscriptions: Subscription[] }>("/subscriptions"),
          api<{ types: SubscriptionType[] }>("/types"),
          api<NotificationSettings>("/me/notification-settings"),
        ],
      );
      if (version !== requestVersion.current) return;
      setDashboard(summary);
      setSubscriptions(list.subscriptions);
      setTypes(categoryData.types);
      setNotifications(notificationData);
      if (
        new URLSearchParams(window.location.search).get("emailVerified") ===
          "1" &&
        notificationData.emailVerified
      ) {
        setNotice("收件邮箱已验证，可以接收到期提醒。");
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}#reminders`,
        );
        setPage("reminders");
      }
    } catch (e) {
      if (version === requestVersion.current) setError(errorMessage(e));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [user?.id, user?.currency, user?.timeZone]);
  useEffect(() => {
    if (user) void loadData();
  }, [loadData]);
  function signedIn(next: User) {
    clearData();
    setUser(next);
    setCategory("all");
    navigate("overview");
  }
  async function logout() {
    try {
      await api("/auth/logout", json("POST"));
      clearData();
      signOutLocally();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function changeCurrency(currency: Currency) {
    if (!user) return;
    setPreferencesBusy(true);
    try {
      const result = await api<{ user: User }>(
        "/me/preferences",
        json("PUT", { currency, timeZone: user.timeZone }),
      );
      setDashboard(null);
      setUser(result.user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPreferencesBusy(false);
    }
  }
  function edit(item: Subscription | null) {
    setEditorItem(item);
    setDraftKey((n) => n + 1);
    navigate("editor");
  }
  async function saved(message: string) {
    navigate("manage");
    setNotice(message);
    await loadData();
  }
  function notificationChanged(next: NotificationSettings) {
    setNotifications(next);
    if (next.timeZone !== user?.timeZone)
      setUser((previous) =>
        previous ? { ...previous, timeZone: next.timeZone } : null,
      );
    else void loadData();
  }
  const nonArchived = subscriptions.filter((s) => s.status !== "archived");
  const shown = useMemo(
    () =>
      (dashboard?.subscriptions || subscriptions)
        .filter(
          (s) =>
            s.status !== "archived" &&
            (category === "all" || s.type === category),
        )
        .sort((a, b) => a.nextRenewal.localeCompare(b.nextRenewal)),
    [dashboard, subscriptions, category],
  );
  if (booting)
    return (
      <main className="boot">
        <Cloud size={35} className="accent-icon" />
        <span className="brand gradient">续记 Renewly</span>
        <p>
          <LoaderCircle className="spin" size={16} />
          正在连接你的订阅空间…
        </p>
      </main>
    );
  if (!user)
    return (
      <Auth
        config={authConfig}
        initialError={bootError}
        onSignedIn={signedIn}
        onRetry={() => void initialize()}
      />
    );
  const breadcrumb =
    page === "overview"
      ? category === "all"
        ? "全部订阅"
        : types.find((t) => t.key === category)?.name || "订阅总览"
      : pageTitles[page];
  const upcoming = (dashboard?.nextDue || [])
    .filter(
      (s) =>
        s.status === "active" && daysUntil(s.nextRenewal, user.timeZone) >= 0,
    )
    .slice(0, 5);
  const overdue = nonArchived.filter(
    (s) => s.status === "active" && daysUntil(s.nextRenewal, user.timeZone) < 0,
  ).length;
  const mailState = !notifications?.enabled
    ? "已关闭"
    : !notifications?.recipientEmail
      ? "待设置邮箱"
      : !notifications.emailVerified
        ? "待验证"
        : !notifications.mailAvailable
          ? "待管理员配置"
          : "已开启";
  return (
    <div className="workspace">
      <aside className="sidebar">
        <button
          className="brand-button"
          onClick={() => {
            setCategory("all");
            navigate("overview");
          }}
          aria-label="续记总览"
        >
          <span className="brand gradient">续记 Renewly</span>
        </button>
        <p className="brand-sub">你的订阅管理空间</p>
        <p className="nav-caption">订阅分类</p>
        <nav className="nav-group" aria-label="订阅分类">
          <button
            className={`nav-item ${page === "overview" && category === "all" ? "selected" : ""}`}
            aria-current={
              page === "overview" && category === "all" ? "page" : undefined
            }
            onClick={() => {
              setCategory("all");
              navigate("overview");
            }}
          >
            <Layers size={17} />
            <span>全部订阅</span>
            <small>{nonArchived.length}</small>
          </button>
          {types.map((type) => (
            <button
              key={type.key}
              className={`nav-item ${page === "overview" && category === type.key ? "selected" : ""}`}
              aria-current={
                page === "overview" && category === type.key
                  ? "page"
                  : undefined
              }
              onClick={() => {
                setCategory(type.key);
                navigate("overview");
              }}
            >
              <Server size={17} />
              <span>{type.name}</span>
              <small>
                {nonArchived.filter((s) => s.type === type.key).length}
              </small>
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <p className="nav-caption">工作区</p>
        <nav className="nav-group utility-nav" aria-label="工作区">
          <button
            className={`nav-item ${["manage", "editor", "renew"].includes(page) ? "selected" : ""}`}
            onClick={() => navigate("manage")}
          >
            <SlidersHorizontal size={17} />
            <span>订阅管理</span>
          </button>
          <button
            className={`nav-item ${page === "reminders" ? "selected" : ""}`}
            onClick={() => navigate("reminders")}
          >
            <Bell size={17} />
            <span>我的提醒</span>
          </button>
          {user.role === "admin" && (
            <button
              className={`nav-item ${page === "admin" ? "selected" : ""}`}
              onClick={() => navigate("admin")}
            >
              <Settings2 size={17} />
              <span>系统邮件</span>
            </button>
          )}
        </nav>
        <div className="account">
          <span className="avatar">
            {(user.name || user.email).slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{user.name || "我的账户"}</strong>
            <span>{user.email}</span>
          </div>
          <button
            onClick={logout}
            className="icon-button"
            aria-label="退出登录"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="stage">
        <header className="topbar">
          <div className="breadcrumb">
            我的空间<span>/</span>
            <strong>{breadcrumb}</strong>
          </div>
          <div className="topbar-actions">
            <span className="account-role">
              {user.role === "admin" ? "管理员" : "个人账户"}
            </span>
            <label className="currency-control">
              <span>汇总币种</span>
              <Select
                value={user.currency}
                onValueChange={(value) =>
                  void changeCurrency(value as Currency)
                }
                options={currencies}
                disabled={preferencesBusy}
                aria-label="汇总币种"
              />
            </label>
            <button
              type="button"
              className="icon-button mobile-logout"
              onClick={logout}
              aria-label="退出登录"
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="content">
          {error && (
            <Banner
              tone="error"
              action={
                <Button variant="ghost" onClick={loadData} busy={loading}>
                  <RefreshCw size={14} />
                  重试
                </Button>
              }
            >
              {error}
            </Banner>
          )}
          {notice && <Banner tone="success">{notice}</Banner>}
          <div hidden={page !== "overview"}>
            <div className="page-heading">
              <div>
                <span className="eyebrow gradient">SUBSCRIPTION WORKSPACE</span>
                <h1>{category === "all" ? "订阅总览" : `${breadcrumb}订阅`}</h1>
                <p>把订阅的账单、到期与预算，放在一起掌握。</p>
              </div>
              <Button variant="ghost" onClick={loadData} busy={loading}>
                <RefreshCw size={15} />
                刷新
              </Button>
            </div>
            <div className="metrics">
              <div className="panel metric">
                <div className="metric-label">
                  年预计支出
                  <Wallet size={17} />
                </div>
                <strong className="metric-value gradient">
                  {money(dashboard?.annualTotal, user.currency)}
                </strong>
                <p>按续费价年化 · {dashboard?.activeCount ?? "—"} 项有效订阅</p>
              </div>
              <div className="panel metric">
                <div className="metric-label">
                  剩余使用价值
                  <Hourglass size={17} />
                </div>
                <strong className="metric-value gradient">
                  {money(dashboard?.remainingValue, user.currency)}
                </strong>
                <p>已付账期按时间估算</p>
              </div>
              <div className="panel metric">
                <div className="metric-label">
                  30 天待续费
                  <CalendarClock size={17} />
                </div>
                <strong className="metric-value gradient">
                  {money(dashboard?.upcomingTotal, user.currency)}
                </strong>
                <p>{dashboard?.dueCount ?? "—"} 项即将续费 · 提前安排预算</p>
              </div>
            </div>
            {dashboard?.totalsPartial && (
              <Banner>
                部分币种汇率暂不可用（
                {dashboard.unconvertedCurrencies.join("、")}
                ），汇总仅包含可换算的金额。
              </Banner>
            )}
            {overdue > 0 && (
              <Banner
                tone="error"
                action={
                  <Button variant="ghost" onClick={() => navigate("manage")}>
                    前往管理
                  </Button>
                }
              >
                有 {overdue} 项订阅已过期，请核对续费或归档。
              </Banner>
            )}
            <div className="overview-grid">
              <div className="panel">
                <div className="panel-heading">
                  <h2>
                    订阅清单<small>{shown.length} 项</small>
                  </h2>
                  <button
                    className="text-button gradient"
                    onClick={() => navigate("manage")}
                  >
                    管理订阅
                    <ArrowUpRight size={14} />
                  </button>
                </div>
                {loading && !dashboard ? (
                  <div className="panel-loading">
                    <LoaderCircle className="spin" size={17} />
                    正在加载订阅…
                  </div>
                ) : !shown.length ? (
                  <EmptyState
                    title="还没有订阅"
                    detail="先记录一项订阅，开始掌握续费时间与预算。"
                    action={
                      <Button onClick={() => navigate("manage")}>
                        <Plus size={15} />
                        去管理订阅
                      </Button>
                    }
                  />
                ) : (
                  <div className="asset-list">
                    {shown.map((item) => (
                      <div className="asset-row" key={item.id}>
                        <div className="asset-identity">
                          <span className="asset-icon">
                            <Server size={17} />
                          </span>
                          <div>
                            <strong>{item.name}</strong>
                            <p>
                              <a
                                href={item.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="gradient"
                              >
                                {item.vendor}
                              </a>
                              <span> · {item.region}</span>
                            </p>
                            <p className="asset-model">{item.model}</p>
                          </div>
                        </div>
                        <div className="asset-price">
                          {money(item.renewalPrice, item.currency)}
                          <small>/ {periodLabel(item.billingMonths)}</small>
                        </div>
                        <div className="asset-due">
                          <time dateTime={item.nextRenewal}>
                            {item.nextRenewal}
                          </time>
                          <DueBadge item={item} timeZone={user.timeZone} />
                        </div>
                        <div className="traffic-label">
                          <span>套餐流量总额度</span>
                          <strong
                            className={
                              item.trafficMode === "unknown"
                                ? "muted"
                                : "gradient"
                            }
                          >
                            {trafficLabel(item)}
                          </strong>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="panel-footer">
                  按到期时间排列 · 仅展示自己的数据<span>原币续费价格</span>
                </div>
              </div>
              <aside className="stack">
                <div className="panel timeline">
                  <h2>
                    <AlarmClock size={16} />
                    接下来要续费
                  </h2>
                  {upcoming.length ? (
                    upcoming.map((item) => (
                      <div className="timeline-item" key={item.id}>
                        <div className="date-chip">
                          <span>{Number(item.nextRenewal.slice(5, 7))} 月</span>
                          {item.nextRenewal.slice(8)}
                        </div>
                        <div>
                          <strong>{item.name}</strong>
                          <p>
                            {money(item.renewalPrice, item.currency)} /{" "}
                            {periodLabel(item.billingMonths)}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="quiet-empty">未来 30 天暂无待续费项目</p>
                  )}
                </div>
                <div className="panel reminder-status">
                  <h2>提醒状态</h2>
                  <div>
                    <span>站内提醒</span>
                    <span className="badge">已开启</span>
                  </div>
                  <div>
                    <span>邮件提醒</span>
                    <span
                      className={`badge ${mailState === "已开启" ? "" : "muted"}`}
                    >
                      {mailState}
                    </span>
                  </div>
                  <button
                    className="text-button gradient"
                    onClick={() => navigate("reminders")}
                  >
                    设置收件邮箱
                    <ArrowRight size={13} />
                  </button>
                </div>
              </aside>
            </div>
            <div className="rates-footer">
              <span>
                {dashboard?.rates.date
                  ? `汇率日期 ${dashboard.rates.date} · Frankfurter 参考汇率`
                  : "汇率暂不可用 · 原币记录仍可查看"}
                {dashboard?.rates.stale ? " · 沿用缓存" : ""}
              </span>
              <span>剩余使用价值为时间摊销估算</span>
            </div>
          </div>
          <div hidden={page !== "manage"}>
            <Management
              subscriptions={subscriptions}
              user={user}
              onAdd={() => edit(null)}
              onEdit={edit}
              onRenew={(item) => {
                setRenewalItem(item);
                navigate("renew");
              }}
              onArchive={async (item) => {
                await api(
                  `/subscriptions/${encodeURIComponent(item.id)}`,
                  json("DELETE"),
                );
                await loadData();
                setNotice(`“${item.name}”已归档，可从已归档列表编辑恢复。`);
              }}
            />
          </div>
          <div hidden={page !== "editor"}>
            <SubscriptionEditor
              item={editorItem}
              draftKey={draftKey}
              types={types}
              timeZone={user.timeZone}
              defaultDays={notifications?.reminderDays || [7, 3, 1]}
              onSaved={() => saved("订阅已保存。")}
              onCancel={() => navigate("manage")}
            />
          </div>
          <div hidden={page !== "renew"}>
            <RenewalForm
              item={renewalItem}
              onSaved={async () => {
                setRenewalItem(null);
                await saved("续费已登记，账期已更新。");
              }}
              onCancel={() => {
                setRenewalItem(null);
                navigate("manage");
              }}
            />
          </div>
          <div hidden={page !== "reminders"}>
            <ReminderSettings
              settings={notifications}
              user={user}
              onChanged={notificationChanged}
              nextDueCount={dashboard?.dueCount || 0}
            />
          </div>
          {user.role === "admin" && (
            <div hidden={page !== "admin"}>
              <AdminMail user={user} onChanged={loadData} />
            </div>
          )}
          <footer className="app-footer">
            <span className="gradient">续记 Renewly</span>
            <span>每一笔订阅，都心中有数。</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Management({
  subscriptions,
  user,
  onAdd,
  onEdit,
  onRenew,
  onArchive,
}: {
  subscriptions: Subscription[];
  user: User;
  onAdd: () => void;
  onEdit: (item: Subscription) => void;
  onRenew: (item: Subscription) => void;
  onArchive: (item: Subscription) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("current");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const list = subscriptions
    .filter(
      (item) =>
        status === "all" ||
        (status === "current" && item.status !== "archived") ||
        item.status === status,
    )
    .filter((item) =>
      `${item.name} ${item.vendor} ${item.region} ${item.model}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => a.nextRenewal.localeCompare(b.nextRenewal));
  async function archive(item: Subscription) {
    setBusy(item.id);
    setError("");
    try {
      await onArchive(item);
      setConfirmId(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">MANAGE SUBSCRIPTIONS</span>
          <h1>订阅管理</h1>
          <p>记录配置与价格，安排每一次续费。</p>
        </div>
        <Button variant="primary" onClick={onAdd}>
          <Plus size={16} />
          新增订阅
        </Button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <div className="management-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称、商家或地区"
            aria-label="搜索订阅"
          />
        </label>
        <Select
          value={status}
          onValueChange={setStatus}
          aria-label="按订阅状态筛选"
          options={[
            { value: "current", label: "当前订阅" },
            { value: "active", label: "生效中" },
            { value: "paused", label: "已暂停" },
            { value: "archived", label: "已归档" },
            { value: "all", label: "全部记录" },
          ]}
        />
      </div>
      <div className="panel">
        {list.length ? (
          list.map((item) => (
            <div className="management-row" key={item.id}>
              <div>
                <div className="management-name">
                  <strong>{item.name}</strong>
                  <span>{item.vendor}</span>
                  <DueBadge item={item} timeZone={user.timeZone} />
                </div>
                <div className="management-meta">
                  <span>{item.region}</span>
                  <span>{item.model}</span>
                  <span>购买 {money(item.purchasePrice, item.currency)}</span>
                  <span>
                    续费 {money(item.renewalPrice, item.currency)} /{" "}
                    {periodLabel(item.billingMonths)}
                  </span>
                  <span>{item.nextRenewal} 到期</span>
                  <span>流量 {trafficLabel(item)}</span>
                </div>
                {item.notes && <p className="item-notes">{item.notes}</p>}
              </div>
              <div className="row-actions">
                <Button
                  variant="ghost"
                  onClick={() => onEdit(item)}
                  disabled={!!busy}
                >
                  {item.status === "archived" ? "编辑 / 恢复" : "编辑"}
                </Button>
                {item.status !== "archived" && (
                  <>
                    <Button onClick={() => onRenew(item)} disabled={!!busy}>
                      登记续费
                    </Button>
                    {confirmId === item.id ? (
                      <>
                        <Button
                          variant="danger"
                          busy={busy === item.id}
                          onClick={() => archive(item)}
                        >
                          确认归档
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setConfirmId(null)}
                          disabled={!!busy}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => setConfirmId(item.id)}
                        disabled={!!busy}
                      >
                        归档
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <EmptyState
            title={
              query || status !== "current"
                ? "没有匹配的订阅"
                : "从第一项订阅开始"
            }
            detail={
              query || status !== "current"
                ? "可以调整搜索词或筛选条件。"
                : "填写商家、配置、价格和续费日期，其他交给续记。"
            }
            action={
              query || status !== "current" ? undefined : (
                <Button onClick={onAdd} variant="primary">
                  <Plus size={15} />
                  新增订阅
                </Button>
              )
            }
          />
        )}
      </div>
      <p className="management-note">
        “登记续费”用于记录已完成的付款；归档保留历史，可随时恢复。
      </p>
    </section>
  );
}
