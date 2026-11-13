import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  AppWindow,
  Bell,
  GripVertical,
  Layers,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Store,
  Users,
} from "lucide-react";
import { ApiError, api, errorMessage, json } from "./api";
import { Auth } from "./Auth";
import { Banner, Button, DueBadge, EmptyState } from "./components";
import { SubscriptionEditor, RenewalForm } from "./SubscriptionEditor";
import { AdminMail, ReminderSettings } from "./Settings";
import { Select } from "./Select";
import { UserManagement } from "./Users";
import { TermProgress } from "./SubscriptionSummary";
import { DashboardMetrics, RatesFooter } from "./DashboardMetrics";
import { ThemeSwitch } from "./ThemeSwitch";
import { AppIcon } from "./AppIcon";
import { MerchantManager } from "./MerchantManager";
import { clearMerchantCatalog, setMerchantCatalog, type MerchantCatalogEntry } from "./merchant-catalog";
import type {
  AuthConfig,
  Dashboard,
  NotificationSettings,
  Subscription,
  SubscriptionType,
  User,
} from "./types";
import {
  daysUntil,
  money,
  periodLabel,
  trafficLabel,
  bandwidthLabel,
  formatDateTime,
  configurationLabel,
} from "./utils";

type Page = "overview" | "manage" | "editor" | "renew" | "reminders" | "admin" | "users" | "merchants";
const pageTitles: Record<Page, string> = {
  overview: "全部订阅",
  manage: "云服务器",
  editor: "订阅信息",
  renew: "登记续费",
  reminders: "我的提醒",
  admin: "系统邮件",
  users: "用户管理",
  merchants: "商家管理",
};
function hashRoute(): { page: Page; category: string } {
  const value = window.location.hash.slice(1);
  const category = /^category\/([a-z][a-z0-9_-]*)$/.exec(value)?.[1];
  if (category) return { page: "manage", category: ["cloud", "app"].includes(category) ? category : "cloud" };
  if (value === "manage") return { page: "manage", category: "cloud" };
  return {
    page: ["overview", "reminders", "admin", "users", "merchants"].includes(value) ? value as Page : "overview",
    category: "cloud",
  };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [page, setPage] = useState<Page>(() => hashRoute().page);
  const [category, setCategory] = useState(() => hashRoute().category);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [categoryDashboard, setCategoryDashboard] = useState<Dashboard | null>(null);
  const [loadedCategory, setLoadedCategory] = useState("");
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [types, setTypes] = useState<SubscriptionType[]>([]);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  const [draggingCategory, setDraggingCategory] = useState<string | null>(null);
  const [notifications, setNotifications] =
    useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorItem, setEditorItem] = useState<Subscription | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [renewalItem, setRenewalItem] = useState<Subscription | null>(null);
  const requestVersion = useRef(0);
  const catalogRequestVersion = useRef(0);
  useEffect(() => {
    if (!user) { setCategoryOrder([]); return; }
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`renewly:category-order:${user.id}`) || "[]");
      setCategoryOrder(Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === "string"))] : []);
    } catch {
      setCategoryOrder([]);
    }
  }, [user?.id]);
  function clearData() {
    requestVersion.current++;
    catalogRequestVersion.current++;
    clearMerchantCatalog();
    setDashboard(null);
    setCategoryDashboard(null);
    setSubscriptions([]);
    setTypes([]);
    setNotifications(null);
    setError("");
    setNotice("");
  }
  const signOutLocally = useCallback(() => {
    requestVersion.current++;
    catalogRequestVersion.current++;
    clearMerchantCatalog();
    setUser(null);
    setDashboard(null);
    setCategoryDashboard(null);
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
    const navigate = () => {
      const route = hashRoute();
      setPage(route.page);
      setCategory(route.category);
    };
    window.addEventListener("hashchange", navigate);
    return () => {
      window.removeEventListener("renewly:unauthorized", expired);
      window.removeEventListener("hashchange", navigate);
    };
  }, []);
  useEffect(() => {
    if (user && ["admin", "users", "merchants"].includes(page) && user.role !== "admin") navigate("overview");
  }, [user, page]);
  function navigate(next: Page, nextCategory = category) {
    if (nextCategory !== category) {
      setCategoryDashboard(null);
      setCategory(nextCategory);
    }
    setPage(next);
    setError("");
    setNotice("");
    if (next !== "editor" && next !== "renew")
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${next === "manage" ? `category/${nextCategory}` : next}`,
      );
  }
  const loadData = useCallback(async () => {
    if (!user) return;
    const version = ++requestVersion.current;
    const catalogVersion = ++catalogRequestVersion.current;
    setLoading(true);
    setError("");
    try {
      const [summary, list, categoryData, notificationData, merchantData] = await Promise.all(
        [
          api<Dashboard>("/dashboard"),
          api<{ subscriptions: Subscription[] }>("/subscriptions"),
          api<{ types: SubscriptionType[] }>("/types"),
          api<NotificationSettings>("/me/notification-settings"),
          api<{ merchants: MerchantCatalogEntry[] }>("/merchants"),
        ],
      );
      const scoped = categoryData.types.some((type) => type.key === category)
        ? await api<Dashboard>(`/dashboard?type=${encodeURIComponent(category)}`)
        : null;
      if (version !== requestVersion.current) return;
      if (catalogVersion === catalogRequestVersion.current) setMerchantCatalog(merchantData.merchants);
      setCategoryDashboard(scoped);
      setLoadedCategory(category);
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
  }, [user?.id, user?.currency, user?.timeZone, category]);
  const refreshMerchantCatalog = useCallback(async () => {
    if (!user) return;
    const version = ++catalogRequestVersion.current;
    const data = await api<{ merchants: MerchantCatalogEntry[] }>("/merchants");
    if (version === catalogRequestVersion.current) setMerchantCatalog(data.merchants);
  }, [user?.id]);
  useEffect(() => {
    if (user) void loadData();
  }, [loadData]);
  useEffect(() => {
    if (!user) return;
    const refresh = () => { if (document.visibilityState === "visible") void loadData(); };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [loadData]);
  function signedIn(next: User) {
    clearData();
    setUser(next);
    setCategory("cloud");
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
  function edit(item: Subscription | null) {
    setEditorItem(item);
    setDraftKey((n) => n + 1);
    navigate("editor", item?.type || category);
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
  if (booting)
    return (
      <main className="boot">
        <img src="/favicon.svg?v=20261112-cards" width={35} height={35} alt="" />
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
  const categoryName = types.find((type) => type.key === category)?.name || "云服务器";
  const orderedTypes = [...types].sort((a, b) => {
    const position = (key: string) => {
      const index = categoryOrder.indexOf(key);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return position(a.key) - position(b.key);
  });
  function moveCategory(from: string, to: string) {
    const keys = orderedTypes.map((type) => type.key);
    const fromIndex = keys.indexOf(from);
    const toIndex = keys.indexOf(to);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    keys.splice(toIndex, 0, ...keys.splice(fromIndex, 1));
    setCategoryOrder(keys);
    try { localStorage.setItem(`renewly:category-order:${user!.id}`, JSON.stringify(keys)); } catch { /* Keep the order for this session. */ }
  }
  const breadcrumb = ["manage", "editor", "renew"].includes(page)
    ? page === "manage" ? categoryName : `${categoryName} / ${pageTitles[page]}`
    : pageTitles[page];
  const upcoming = (dashboard?.nextDue || []).filter(
    (item) => item.status === "active" && daysUntil(item.nextRenewal, user.timeZone) >= 0,
  );
  return (
    <div className="workspace">
      <aside className="sidebar">
        <button
          className="brand-button"
          onClick={() => {
            setCategory("cloud");
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
            className={`nav-item ${page === "overview" ? "selected" : ""}`}
            aria-current={
              page === "overview" ? "page" : undefined
            }
            onClick={() => {
              setCategory("cloud");
              navigate("overview");
            }}
          >
            <Layers size={17} />
            <span>全部订阅</span>
            <small>{nonArchived.length}</small>
          </button>
          {orderedTypes.map((type, index) => (
            <div key={type.key} className={`category-nav-row ${draggingCategory === type.key ? "dragging" : ""}`} data-category-key={type.key}
              onDragOver={(event) => { if (draggingCategory) { event.preventDefault(); if (draggingCategory !== type.key) moveCategory(draggingCategory, type.key); } }}
              onDrop={(event) => { event.preventDefault(); if (draggingCategory) moveCategory(draggingCategory, type.key); setDraggingCategory(null); }}>
            <button
              className={`nav-item ${["manage", "editor", "renew"].includes(page) && category === type.key ? "selected" : ""}`}
              aria-current={
                ["manage", "editor", "renew"].includes(page) && category === type.key
                  ? "page"
                  : undefined
              }
              onClick={() => {
                navigate("manage", type.key);
              }}
            >
              {type.key === "app" ? <AppWindow size={17} /> : <Server size={17} />}
              <span>{type.name}</span>
              <small>
                {nonArchived.filter((s) => s.type === type.key).length}
              </small>
            </button>
            <button
              type="button"
              className="category-drag-handle"
              draggable
              aria-label={`调整${type.name}顺序`}
              title="拖动调整顺序；也可以使用方向键"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", type.key);
                setDraggingCategory(type.key);
              }}
              onDragEnd={() => setDraggingCategory(null)}
              onPointerDown={(event) => {
                if (event.pointerType !== "touch") return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                setDraggingCategory(type.key);
              }}
              onPointerUp={(event) => {
                if (event.pointerType !== "touch") return;
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-category-key]");
                const targetKey = target?.dataset.categoryKey;
                if (targetKey) moveCategory(type.key, targetKey);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                setDraggingCategory(null);
              }}
              onPointerMove={(event) => {
                if (event.pointerType !== "touch" || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const targetKey = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-category-key]")?.dataset.categoryKey;
                if (targetKey && targetKey !== type.key) moveCategory(type.key, targetKey);
              }}
              onPointerCancel={() => setDraggingCategory(null)}
              onLostPointerCapture={() => setDraggingCategory(null)}
              onKeyDown={(event) => {
                const direction = ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : 0;
                const target = orderedTypes[index + direction];
                if (direction && target) { event.preventDefault(); moveCategory(type.key, target.key); }
              }}
            ><GripVertical size={15} /></button>
            </div>
          ))}
        </nav>
        <div className="nav-divider" />
        <p className="nav-caption">工作区</p>
        <nav className="nav-group utility-nav" aria-label="工作区">
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
        {user.role === "admin" && <><div className="nav-divider" /><p className="nav-caption">管理</p><nav className="nav-group admin-nav" aria-label="管理"><button className={`nav-item ${page === "users" ? "selected" : ""}`} aria-current={page === "users" ? "page" : undefined} onClick={() => navigate("users")}><Users size={17} /><span>用户管理</span></button><button className={`nav-item ${page === "merchants" ? "selected" : ""}`} aria-current={page === "merchants" ? "page" : undefined} onClick={() => navigate("merchants")}><Store size={17} /><span>商家管理</span></button></nav></>}
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
            <ThemeSwitch />
            <span className="account-role">
              {user.role === "admin" ? "管理员" : "个人账户"}
            </span>
            <span className="summary-currency">汇总：¥ 人民币</span>
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
                <span className="eyebrow gradient">SUBSCRIPTION OVERVIEW</span>
                <h1>全部订阅</h1>
                <p>所有订阅的支出与续费安排。</p>
              </div>
              <Button variant="ghost" onClick={loadData} busy={loading}>
                <RefreshCw size={15} />刷新
              </Button>
            </div>
            <DashboardMetrics dashboard={dashboard} currency="CNY" scope="全部订阅类别" />
            <section className="panel upcoming-panel" aria-label="接下来要续费">
              <div className="panel-heading">
                <h2><AlarmClock size={16} />接下来要续费</h2>
                <span className="small muted">未来 30 天</span>
              </div>
              {loading && !dashboard ? <div className="panel-loading"><LoaderCircle className="spin" size={17} />正在加载…</div> : upcoming.length ? (
                upcoming.map((item) => (
                  <div className="upcoming-row" key={item.id}>
                    <time dateTime={item.nextRenewal} aria-label={`${formatDateTime(item.nextRenewal)} ${user.timeZone}`}>
                      <strong>{formatDateTime(item.nextRenewal).slice(0, 10)}</strong>
                      <span>{formatDateTime(item.nextRenewal).slice(11)}</span>
                    </time>
                    <div className="upcoming-name">
                      <button className="text-button" onClick={() => edit(item)}>{item.name}</button>
                      <small>{types.find((type) => type.key === item.type)?.name || item.type} · {item.vendor}</small>
                    </div>
                    <div className="upcoming-price">{money(item.renewalPrice, item.currency)}<small>/ {periodLabel(item.billingMonths)}</small></div>
                    <DueBadge item={item} timeZone={user.timeZone} />
                  </div>
                ))
              ) : <p className="quiet-empty">未来 30 天暂无待续费项目</p>}
            </section>
            <RatesFooter dashboard={dashboard} />
          </div>
          <div hidden={page !== "manage"}>
            <Management
              key={category}
              subscriptions={subscriptions.filter((item) => item.type === category)}
              user={user}
              title={categoryName}
              category={category === "app" ? "app" : "cloud"}
              dashboard={loadedCategory === category ? categoryDashboard : null}
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
              category={category === "app" ? "app" : "cloud"}
              timeZone={user.timeZone}
              defaultDays={notifications?.reminderDays || [7, 3, 1]}
              onSaved={() => saved("订阅已保存。")}
              onCancel={() => navigate("manage")}
            />
          </div>
          <div hidden={page !== "renew"}>
            <RenewalForm
              item={renewalItem}
              timeZone={user.timeZone}
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
          {user.role === "admin" && page === "users" && <UserManagement currentUser={user} onSelfUpdated={setUser} />}
          {user.role === "admin" && page === "merchants" && <MerchantManager onCatalogChange={refreshMerchantCatalog} />}
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
  title,
  category,
  dashboard,
  onAdd,
  onEdit,
  onRenew,
  onArchive,
}: {
  subscriptions: Subscription[];
  user: User;
  title: string;
  category: "cloud" | "app";
  dashboard: Dashboard | null;
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
  const isApp = category === "app";
  const list = subscriptions
    .filter(
      (item) =>
        status === "all" ||
        (status === "current" && item.status !== "archived") ||
        item.status === status,
    )
    .filter((item) =>
      `${item.name} ${item.vendor} ${item.appPlan || ""} ${item.appAccount || ""} ${item.region} ${configurationLabel(item)} ${(item.ipAddresses || []).map((ip) => ip.address).join(" ")}`
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
          <span className="eyebrow gradient">{isApp ? "APP SUBSCRIPTIONS" : "CLOUD SERVERS"}</span>
          <h1>{title}<small className="category-count">{subscriptions.filter((item) => item.status !== "archived").length} {isApp ? "项" : "台"}</small></h1>
          <p>{isApp ? "从效率工具到影音服务，让每一次续费都有提醒。" : "记录配置、IP 与价格，安排每一次续费。"}</p>
        </div>
        <Button variant="primary" onClick={onAdd}>
          <Plus size={16} />
          {isApp ? "新增订阅" : "新增服务器"}
        </Button>
      </div>
      <DashboardMetrics dashboard={dashboard} currency="CNY" scope={`仅${title}`} />
      {error && <Banner tone="error">{error}</Banner>}
      <div className="management-toolbar">
        <label className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isApp ? "搜索 App、套餐或账户" : "搜索名称、商家、地区或 IP"}
            aria-label={isApp ? "搜索 App 订阅" : "搜索服务器"}
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
            <article className="management-row" key={item.id}>
              <div className={`management-header ${isApp ? "" : "cloud-management-header"}`}>
                {isApp ? <div className="management-name">
                  <AppIcon name={item.name} website={item.website} value={item.appIcon} />
                  <div className="management-title">
                    <strong>{item.name}</strong>
                    {item.autoRenew && <span className="auto-renew-tag">自动续费</span>}
                  </div>
                  <span className="management-vendor">{item.vendor}</span>
                </div> : <>
                  <AppIcon name={item.vendor} website={item.website} value={item.serverIcon} fallbackInitial />
                  <strong className="cloud-management-vendor" title={item.vendor}>{item.vendor}</strong>
                  <div className="cloud-management-title">
                    <span className="cloud-management-subscription" title={item.name}>{item.name}</span>
                    {item.autoRenew && <span className="auto-renew-tag">自动续费</span>}
                  </div>
                </>}
                <DueBadge item={item} timeZone={user.timeZone} />
              </div>
              <div className="management-body">
                <div className="management-details">
                  <dl className={`management-meta ${isApp ? "app-subscription-meta" : ""}`}>
                    {isApp ? <>
                      <div><dt>套餐 / 版本</dt><dd>{item.appPlan || "未填写"}</dd></div>
                      <div><dt>购买渠道</dt><dd>{item.appChannel || "官网"}</dd></div>
                    </> : <>
                    <div>
                      <dt>地区</dt>
                      <dd>{item.region || "未填写"}</dd>
                    </div>
                    <div>
                      <dt>型号 / 配置</dt>
                      <dd>{configurationLabel(item)}</dd>
                    </div>
                    <div>
                      <dt>购买价格</dt>
                      <dd>{money(item.purchasePrice, item.currency)}</dd>
                    </div>
                    </>}
                    <div>
                      <dt>续费价格</dt>
                      <dd>{money(item.renewalPrice, item.currency)} / {periodLabel(item.billingMonths)}</dd>
                    </div>
                    <div>
                      <dt>下次续费</dt>
                      <dd><time dateTime={item.nextRenewal}>{formatDateTime(item.nextRenewal)}</time></dd>
                    </div>
                    {!isApp && <><div>
                      <dt>套餐流量</dt>
                      <dd>{trafficLabel(item)}</dd>
                    </div>
                    <div>
                      <dt>套餐带宽</dt>
                      <dd>{bandwidthLabel(item)}</dd>
                    </div>
                    </>}
                  </dl>
                  {isApp && <p className="app-subscription-account">账户：{item.appAccount || "未填写"}</p>}
                  {!isApp && item.model && (item.cpuCores != null || item.memoryValue != null || item.diskValue != null) &&
                    <p className="item-notes">原配置：{item.model}</p>}
                  {!isApp && !!item.ipAddresses?.length && <div className="server-ip-list">{item.ipAddresses.map((ip, index) => (
                    <span className="server-ip" key={index}><span>{ip.type === "dynamic" ? "动态 IP" : "静态 IP"}</span><code>{ip.address || "当前地址未填写"}</code></span>
                  ))}</div>}
                  {item.notes && <p className="item-notes">{item.notes}</p>}
                </div>
                <div className="row-actions">
                  <Button
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
              <TermProgress item={item} timeZone={user.timeZone} />
            </article>
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
                : isApp ? "填写 App、套餐、费用和续费时间，安排下一次提醒。" : "填写商家、配置、价格和续费日期，其他交给续记。"
            }
            action={
              query || status !== "current" ? undefined : (
                <Button onClick={onAdd} variant="primary">
                  <Plus size={15} />
                  {isApp ? "新增订阅" : "新增服务器"}
                </Button>
              )
            }
          />
        )}
      </div>
      <RatesFooter dashboard={dashboard} />
      <p className="management-note">
        “登记续费”用于记录已完成的付款；归档保留历史，可随时恢复。
      </p>
    </section>
  );
}
