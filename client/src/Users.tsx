import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, RefreshCw, Save, Search, ShieldCheck, Users } from "lucide-react";
import { api, errorMessage, json } from "./api";
import { Banner, Button, Field } from "./components";
import { Select } from "./Select";
import type { AdminUser, User } from "./types";
import "./users.css";

interface UserManagementProps {
  currentUser: User;
  onSelfUpdated?: (user: User) => void;
}

type UserRole = AdminUser["role"];

function registeredDate(value: string, timeZone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function UserManagement({
  currentUser,
  onSelfUpdated,
}: UserManagementProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [editError, setEditError] = useState("");
  const [pendingStatus, setPendingStatus] = useState<AdminUser | null>(null);

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ users: AdminUser[] }>("/admin/users", { signal });
      if (!signal?.aborted) setUsers(data.users);
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentUser.role !== "admin") {
      setUsers([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setEditing(null);
    setPendingStatus(null);
    setNotice("");
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, [currentUser.id, currentUser.role, loadUsers]);

  const filtered = users.filter((user) =>
    `${user.name} ${user.email}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const disabled = loading || busy;

  function startEditing(user: AdminUser) {
    setEditing(user);
    setName(user.name);
    setRole(user.role);
    setEditError("");
    setPendingStatus(null);
    setNotice("");
    setError("");
  }

  function replaceUser(user: AdminUser) {
    setUsers((current) => current.map((item) => item.id === user.id ? user : item));
    if (user.id === currentUser.id) {
      onSelfUpdated?.({ ...currentUser, name: user.name, role: user.role });
    }
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || disabled) return;
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 60) {
      setEditError("姓名需要填写 1～60 个字符。");
      return;
    }
    setBusy(true);
    setEditError("");
    setNotice("");
    try {
      const result = await api<{ user: AdminUser }>(
        `/admin/users/${encodeURIComponent(editing.id)}`,
        json("PATCH", {
          name: trimmedName,
          ...(editing.id === currentUser.id ? {} : { role }),
        }),
      );
      replaceUser(result.user);
      setEditing(null);
      setNotice("用户信息已保存。");
    } catch (cause) {
      setEditError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus() {
    if (!pendingStatus || disabled || pendingStatus.id === currentUser.id) return;
    const status = pendingStatus.status === "active" ? "disabled" : "active";
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ user: AdminUser }>(
        `/admin/users/${encodeURIComponent(pendingStatus.id)}`,
        json("PATCH", { status }),
      );
      replaceUser(result.user);
      setPendingStatus(null);
      if (editing?.id === result.user.id) setEditing(result.user);
      setNotice(`账号已${status === "active" ? "启用" : "停用"}。`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (currentUser.role !== "admin") {
    return <Banner tone="error">只有管理员可以管理用户。</Banner>;
  }

  return (
    <section className="users-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow gradient">USER MANAGEMENT</span>
          <h1>用户管理</h1>
          <p>管理账号角色与状态，各用户的订阅数据独立。</p>
        </div>
        <span className="users-admin-label"><ShieldCheck size={16} aria-hidden="true" />仅管理员可见</span>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      <div role="status" aria-live="polite">
        {notice && <Banner tone="success">{notice}</Banner>}
      </div>

      <div className="panel users-panel">
        <div className="users-toolbar">
          <label className="users-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索姓名或登录邮箱"
              aria-label="搜索姓名或登录邮箱"
            />
          </label>
          <span className="users-count" aria-live="polite">{loading ? "正在加载…" : `${filtered.length} 位用户`}</span>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => { setNotice(""); void loadUsers(); }}
          ><RefreshCw size={14} aria-hidden="true" />刷新</Button>
        </div>

        {pendingStatus && (
          <div className="users-status-confirm" role="group" aria-labelledby="users-status-confirm-title">
            <div>
              <h2 id="users-status-confirm-title">{pendingStatus.status === "active" ? "停用" : "启用"}「{pendingStatus.name}」？</h2>
              <p className="users-confirm-email">{pendingStatus.email}</p>
              <p>{pendingStatus.status === "active"
                ? "停用后，该用户将无法登录，现有登录会话会失效；订阅数据保留。"
                : "启用后，该用户可以重新登录并管理自己的订阅。"}</p>
            </div>
            <div className="users-confirm-actions">
              <Button type="button" disabled={busy} onClick={() => setPendingStatus(null)}>取消</Button>
              <Button type="button" variant={pendingStatus.status === "active" ? "danger" : "primary"} disabled={loading} busy={busy} onClick={() => void changeStatus()}>
                确认{pendingStatus.status === "active" ? "停用" : "启用"}
              </Button>
            </div>
          </div>
        )}

        {loading && !users.length ? (
          <p className="users-empty"><LoaderCircle className="spin" size={18} aria-hidden="true" />正在加载用户…</p>
        ) : (
          <table className="users-table">
            <caption className="sr-only">用户账号列表</caption>
            <thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">订阅</th><th scope="col">账号状态</th><th scope="col">注册日期</th><th scope="col">操作</th></tr></thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id}>
                  <td className="users-identity"><strong>{user.name}{user.id === currentUser.id && <span className="users-current-label"> · 当前账号</span>}</strong><span>{user.email}</span></td>
                  <td data-label="角色" className="users-role">{user.role === "admin" ? "管理员" : "普通用户"}</td>
                  <td data-label="订阅" className="users-subscription-count">{user.subscriptionCount} 项</td>
                  <td data-label="状态"><span className={`users-status ${user.status === "disabled" ? "is-disabled" : ""}`}>{user.status === "active" ? "正常" : "已停用"}</span></td>
                  <td data-label="注册日期" className="users-created"><time dateTime={user.createdAt}>{registeredDate(user.createdAt, currentUser.timeZone)}</time></td>
                  <td className="users-actions">
                    <button type="button" className="users-text-button" disabled={disabled} onClick={() => startEditing(user)} aria-label={`编辑 ${user.name}`}>编辑</button>
                    <button
                      type="button"
                      className="users-text-button"
                      disabled={disabled || user.id === currentUser.id}
                      aria-label={`${user.status === "active" ? "停用" : "启用"} ${user.name}`}
                      onClick={() => { setPendingStatus(user); setError(""); setNotice(""); setEditError(""); }}
                    >{user.status === "active" ? "停用" : "启用"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !filtered.length && (
          <div className="users-empty"><Users size={20} aria-hidden="true" /><p>{query.trim() ? "没有匹配的用户" : error ? "用户列表加载失败，请重试。" : "暂无用户"}</p></div>
        )}
        <div className="users-panel-footer"><span>邮件发送配置由管理员统一设置</span><span>用户自行设置收件邮箱</span></div>
      </div>

      {editing && (
        <form className="panel users-editor" onSubmit={saveUser} aria-labelledby="users-editor-title">
          <div className="users-editor-heading"><h2 id="users-editor-title">编辑用户</h2><button type="button" className="users-text-button" disabled={busy} onClick={() => setEditing(null)}>取消</button></div>
          {editError && <Banner tone="error">{editError}</Banner>}
          <fieldset disabled={disabled} className="users-edit-fields">
            <legend className="sr-only">用户资料与权限</legend>
            <Field label="姓名"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required autoComplete="off" /></Field>
            <Field label="用户角色">
              <Select
                aria-label="用户角色"
                value={role}
                onValueChange={(value) => setRole(value as UserRole)}
                disabled={disabled || editing.id === currentUser.id}
                options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]}
              />
            </Field>
            <Field label="登录邮箱"><input type="email" value={editing.email} readOnly /></Field>
            <Field label="收件邮箱" help="由该用户在“我的提醒”中设置。"><input value={editing.recipientEmail || "未设置收件邮箱"} readOnly /><span className="users-verification">{editing.recipientEmail ? editing.emailVerified ? "收件邮箱已验证" : "收件邮箱待验证" : "尚未设置"}</span></Field>
          </fieldset>
          <p className="users-editor-note">{editing.id === currentUser.id
            ? "当前登录管理员不能在此降权或停用。"
            : "普通用户仅管理自己的订阅和收件邮箱；管理员可管理用户及系统发信设置。角色变更后，该用户需重新登录。"}</p>
          <div className="users-editor-footer"><Button type="submit" variant="primary" disabled={loading} busy={busy}><Save size={15} aria-hidden="true" />保存修改</Button></div>
        </form>
      )}
    </section>
  );
}
