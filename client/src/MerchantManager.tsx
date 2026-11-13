import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ArrowLeft, ImagePlus, LoaderCircle, Plus, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Store } from "lucide-react";
import { api, errorMessage, json } from "./api";
import { AppIcon } from "./AppIcon";
import { appIconInitial, builtinIconPresets, isUploadedAppIcon, maxUploadBytes } from "./app-icons";
import { Banner, Button, Field } from "./components";
import { Select } from "./Select";
import type { MerchantCatalogEntry } from "./merchant-catalog";
import "./merchants.css";

interface MerchantManagerProps {
  onCatalogChange?: () => void | Promise<void>;
}

interface MerchantDraft {
  label: string;
  website: string;
  domains: string;
  aliases: string;
  icon: string;
  enabled: boolean;
  categories: ("cloud" | "app")[];
}

const emptyDraft = (): MerchantDraft => ({ label: "", website: "", domains: "", aliases: "", icon: "", enabled: true, categories: ["cloud", "app"] });
const tokens = (value: string) => [...new Set(value.split(/[\n\r,，;；]+/).map(item => item.trim()).filter(Boolean))];
const pageSize = 24;

function websiteLabel(website: string) {
  try { return new URL(website).hostname; } catch { return website || "未填写官网"; }
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

function validateImage(data: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("图片无法解析，请选择有效的 PNG、JPEG 或 WebP。"));
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 2048 && image.naturalHeight <= 2048
      ? resolve() : reject(new Error("图标尺寸需在 1～2048 像素之间。"));
    image.src = data;
  });
}

function IconPreview({ draft, merchant, theme }: { draft: MerchantDraft; merchant: MerchantCatalogEntry | null; theme: "light" | "dark" }) {
  const builtin = builtinIconPresets.find(preset => preset.key === merchant?.key);
  const source = draft.icon || (merchant?.icon ? builtin?.image?.[theme] : merchant?.image?.[theme]);
  return (
    <div className={`merchant-icon-preview merchant-preview-${theme}`}>
      <span className="merchant-preview-icon" data-icon={merchant?.key}>
        {source ? <img src={source} width={40} height={40} alt="" referrerPolicy="no-referrer" />
          : builtin && !builtin.image ? <span className="merchant-preview-mask" style={{ backgroundColor: builtin.color, maskImage: `url(/app-icons/${builtin.key}.svg)`, WebkitMaskImage: `url(/app-icons/${builtin.key}.svg)` }} />
            : <span className="merchant-preview-initial">{appIconInitial(draft.label)}</span>}
      </span>
      <span>{theme === "light" ? "浅色背景" : "深色背景"}</span>
    </div>
  );
}

export function MerchantManager({ onCatalogChange }: MerchantManagerProps) {
  const [merchants, setMerchants] = useState<MerchantCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MerchantCatalogEntry | null>(null);
  const [draft, setDraft] = useState<MerchantDraft>(emptyDraft);
  const [editError, setEditError] = useState("");
  const [pendingReset, setPendingReset] = useState<MerchantCatalogEntry | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const editorRef = useRef<HTMLFormElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const loadMerchants = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const data = await api<{ merchants: MerchantCatalogEntry[] }>("/merchants", { signal });
      if (!signal?.aborted) setMerchants(data.merchants);
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadMerchants(controller.signal);
    return () => { mounted.current = false; generation.current++; controller.abort(); };
  }, [loadMerchants]);

  useEffect(() => { setPage(1); }, [query, filter, categoryFilter]);
  useEffect(() => {
    if (editorOpen) {
      editorRef.current?.scrollIntoView({ block: "nearest" });
      labelRef.current?.focus({ preventScroll: true });
    }
  }, [editorOpen, editing?.key]);

  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return merchants.filter(merchant => (filter === "all" || merchant.enabled === (filter === "enabled"))
      && (categoryFilter === "all" || merchant.categories?.includes(categoryFilter as "cloud" | "app"))
      && `${merchant.label} ${merchant.website} ${merchant.domains.join(" ")} ${merchant.aliases.join(" ")}`.toLocaleLowerCase().includes(search));
  }, [merchants, query, filter, categoryFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const disabled = loading || busy;

  function startEditing(merchant: MerchantCatalogEntry | null) {
    generation.current++;
    setReading(false);
    setEditing(merchant);
    setDraft(merchant ? {
      label: merchant.label, website: merchant.website,
      domains: merchant.domains.join("\n"), aliases: merchant.aliases.join("、"),
      icon: merchant.icon || "", enabled: merchant.enabled, categories: merchant.categories || ["cloud", "app"],
    } : emptyDraft());
    setEditError("");
    setError("");
    setNotice("");
    setPendingReset(null);
    setEditorOpen(true);
  }

  function closeEditor() {
    generation.current++;
    setReading(false);
    setEditorOpen(false);
    setEditing(null);
    setEditError("");
  }

  async function publishChange(merchant: MerchantCatalogEntry) {
    setMerchants(current => current.some(item => item.key === merchant.key)
      ? current.map(item => item.key === merchant.key ? merchant : item)
      : [merchant, ...current]);
    try { await onCatalogChange?.(); return true; }
    catch { setError("商家已保存，订阅图标暂未刷新。请稍后点击刷新。"); return false; }
  }

  async function refresh() {
    setNotice("");
    await loadMerchants();
    try { await onCatalogChange?.(); }
    catch { setError("商家列表已刷新，订阅图标暂未同步，请稍后重试。"); }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++generation.current;
    setEditError("");
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
      if (!file.size || file.size > maxUploadBytes) throw new Error("图标文件需小于或等于 64 KB。");
      setReading(true);
      const data = await readImage(file);
      if (!isUploadedAppIcon(data)) throw new Error("图标格式无效或文件过大。");
      await validateImage(data);
      if (mounted.current && request === generation.current) setDraft(current => ({ ...current, icon: data }));
    } catch (cause) {
      if (mounted.current && request === generation.current) setEditError(errorMessage(cause));
    } finally {
      if (mounted.current && request === generation.current) setReading(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || reading) return;
    const label = draft.label.trim();
    const aliases = tokens(draft.aliases.replaceAll("、", ","));
    const domains = tokens(draft.domains);
    if (!draft.categories.length) { setEditError("请至少选择一个商家分类。"); return; }
    if (!label || label.length > 100) { setEditError("商家名称需要填写 1～100 个字符。"); return; }
    if (aliases.length > 30 || aliases.some(item => item.length > 100)) { setEditError("最多填写 30 个匹配别名，每个不超过 100 字。"); return; }
    if (domains.length > 30 || domains.some(item => item.length > 253)) { setEditError("最多填写 30 个匹配域名，每个不超过 253 字。"); return; }
    setBusy(true);
    setEditError("");
    setError("");
    setNotice("");
    try {
      const result = await api<{ merchant: MerchantCatalogEntry }>(
        editing ? `/admin/merchants/${encodeURIComponent(editing.key)}` : "/admin/merchants",
        json(editing ? "PATCH" : "POST", { label, website: draft.website.trim(), domains, aliases, icon: draft.icon, enabled: draft.enabled, categories: draft.categories }),
      );
      if (!editing) { setQuery(""); setFilter("all"); setCategoryFilter("all"); setPage(1); }
      closeEditor();
      const synchronized = await publishChange(result.merchant);
      setNotice(synchronized ? "商家信息已保存，自动匹配的订阅图标已更新。" : "商家信息已保存。");
    } catch (cause) { setEditError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function changeStatus(merchant: MerchantCatalogEntry) {
    if (disabled) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ merchant: MerchantCatalogEntry }>(`/admin/merchants/${encodeURIComponent(merchant.key)}`, json("PATCH", { enabled: !merchant.enabled }));
      await publishChange(result.merchant);
      if (editing?.key === merchant.key) setDraft(current => ({ ...current, enabled: result.merchant.enabled }));
      setNotice(merchant.enabled ? "商家已停用，不再参与自动匹配；已有手动选择保留。" : "商家已启用，可用于自动匹配。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function restoreBuiltin() {
    if (!pendingReset || disabled) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ merchant: MerchantCatalogEntry }>(`/admin/merchants/${encodeURIComponent(pendingReset.key)}`, json("DELETE"));
      await publishChange(result.merchant);
      if (editing?.key === pendingReset.key) closeEditor();
      setPendingReset(null);
      setNotice("商家已恢复内置配置。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return (
    <section className="merchants-page">
      <div className="page-heading">
        <div><span className="eyebrow gradient">MERCHANT MANAGEMENT</span><h1>商家管理</h1><p>统一维护商家图标与匹配规则，让订阅自动找到对应商家。</p></div>
        <div className="merchant-heading-actions"><span className="merchant-admin-label"><ShieldCheck size={15} aria-hidden="true" />仅管理员</span><Button type="button" variant="primary" disabled={disabled} onClick={() => startEditing(null)}><Plus size={16} aria-hidden="true" />新增商家</Button></div>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <div role="status" aria-live="polite">{notice && <Banner tone="success">{notice}</Banner>}</div>
      <div className={`merchant-workspace${editorOpen ? " is-editing" : ""}`}>
        <div className="merchant-catalog">
          <div className="panel merchant-toolbar">
            <label className="merchant-search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索商家、别名或域名" aria-label="搜索商家、别名或域名" /></label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter} options={[{ value: "all", label: "全部分类" }, { value: "cloud", label: "云服务器" }, { value: "app", label: "App" }]} aria-label="按商家分类筛选" disabled={disabled} />
            <Select value={filter} onValueChange={setFilter} options={[{ value: "all", label: "全部商家" }, { value: "enabled", label: "已启用" }, { value: "disabled", label: "已停用" }]} aria-label="按商家状态筛选" disabled={disabled} />
            <Button type="button" disabled={disabled} onClick={() => void refresh()} aria-label="刷新商家列表"><RefreshCw size={15} aria-hidden="true" />刷新</Button>
          </div>
          <p className="merchant-result-count" aria-live="polite">{loading ? "正在加载商家…" : `共 ${merchants.length} 家商家 · ${filtered.length} 家符合筛选`}</p>
          {pendingReset && <div className="panel merchant-reset-confirm" role="group" aria-labelledby="merchant-reset-title"><div><h2 id="merchant-reset-title">恢复「{pendingReset.label}」的内置配置？</h2><p>名称、官网、匹配规则和图标会恢复为内置版本，订阅资料保留。</p></div><div className="merchant-row-actions"><Button type="button" disabled={busy} onClick={() => setPendingReset(null)}>取消</Button><Button type="button" disabled={loading} busy={busy} onClick={() => void restoreBuiltin()}>确认恢复</Button></div></div>}
          {loading && !merchants.length ? <div className="panel merchant-empty"><LoaderCircle size={21} className="spin" aria-hidden="true" /><p>正在加载商家…</p></div>
            : !visible.length ? <div className="panel merchant-empty"><Store size={28} aria-hidden="true" /><h2>{merchants.length ? "没有找到匹配的商家" : "暂无商家"}</h2><p>{merchants.length ? "试试其他名称，或新增需要的商家。" : "点击新增商家，填写信息并上传图标。"}</p></div>
              : <div className="merchant-grid">{visible.map(merchant => <article className={`panel merchant-card${!merchant.enabled ? " is-disabled" : ""}${editing?.key === merchant.key && editorOpen ? " is-selected" : ""}`} key={merchant.key}>
                <div className="merchant-card-identity"><AppIcon name={merchant.label} website={merchant.website} value={merchant.key} size={40} fallbackInitial /><div><h2 title={merchant.label}>{merchant.label}</h2><p title={merchant.website}>{websiteLabel(merchant.website)}</p></div><span className={`merchant-state-dot${merchant.enabled ? " is-enabled" : ""}`} role="img" title={merchant.enabled ? "已启用" : "已停用"} aria-label={merchant.enabled ? "已启用" : "已停用"} /></div>
                <div className="merchant-card-tags"><span>{merchant.builtin ? merchant.customized ? "内置 · 已修改" : "内置商家" : "自定义商家"}</span>{merchant.categories?.map(category => <span key={category}>{category === "cloud" ? "云服务器" : "App"}</span>)}{!merchant.enabled && <span>已停用</span>}</div>
                <p className="merchant-match-summary" title={[...merchant.domains, ...merchant.aliases].join(" · ")}>{merchant.domains.length ? merchant.domains.slice(0, 2).join(" · ") : merchant.aliases.filter(alias => alias !== merchant.label).slice(0, 3).join(" · ") || "按商家名称匹配"}</p>
                <div className="merchant-card-actions"><Button type="button" disabled={disabled} onClick={() => startEditing(merchant)}>编辑</Button><Button type="button" disabled={disabled} onClick={() => void changeStatus(merchant)}>{merchant.enabled ? "停用" : "启用"}</Button>{merchant.builtin && merchant.customized && <Button type="button" disabled={disabled} onClick={() => { setPendingReset(merchant); setError(""); setNotice(""); }}><RotateCcw size={13} aria-hidden="true" />恢复内置</Button>}</div>
              </article>)}</div>}
          {pageCount > 1 && <div className="merchant-pagination"><span>第 {currentPage} / {pageCount} 页</span><div><Button type="button" disabled={currentPage === 1 || disabled} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button type="button" disabled={currentPage === pageCount || disabled} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></div>}
          <p className="merchant-catalog-help">商家配置对所有用户生效；用户为单条订阅上传的图标优先保留。</p>
        </div>
        {editorOpen && <form className="panel merchant-editor" onSubmit={event => void save(event)} ref={editorRef} aria-label={editing ? "编辑商家" : "新增商家"}>
          <div className="merchant-editor-heading"><div><span className="eyebrow gradient">{editing ? "EDIT MERCHANT" : "NEW MERCHANT"}</span><h2>{editing ? "编辑商家" : "新增商家"}</h2></div><Button type="button" disabled={busy} onClick={closeEditor} aria-label="关闭商家编辑"><ArrowLeft size={15} aria-hidden="true" />返回</Button></div>
          <div className="merchant-editor-body">
            {editError && <Banner tone="error">{editError}</Banner>}
            <Field label="商家名称 *"><input ref={labelRef} value={draft.label} onChange={event => setDraft(current => ({ ...current, label: event.target.value }))} required maxLength={100} disabled={busy} placeholder="例如：DMIT" /></Field>
            <fieldset className="merchant-categories"><legend>商家分类 *</legend>{([ ["cloud", "云服务器"], ["app", "App"] ] as const).map(([value, label]) => <label className="check" key={value}><input type="checkbox" disabled={busy} checked={draft.categories.includes(value)} onChange={event => setDraft(current => ({ ...current, categories: event.target.checked ? [...current.categories, value] : current.categories.filter(category => category !== value) }))} /><span>{label}</span></label>)}<p>可同时选择两个分类。</p></fieldset>
            <Field label="官方网站" help="官网域名自动参与匹配。"><input type="url" value={draft.website} onChange={event => setDraft(current => ({ ...current, website: event.target.value }))} maxLength={2048} disabled={busy} placeholder="https://example.com" /></Field>
            <div className="merchant-icon-field"><h3>商家图标</h3><div className="merchant-icon-previews"><IconPreview draft={draft} merchant={editing} theme="light" /><IconPreview draft={draft} merchant={editing} theme="dark" /></div><div className="merchant-upload-actions"><label className={`button merchant-upload${busy || reading ? " is-disabled" : ""}`}>{reading ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <ImagePlus size={15} aria-hidden="true" />}{reading ? "读取中…" : "上传图标"}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || reading} onChange={event => void upload(event)} aria-label="上传商家图标" /></label>{draft.icon && <Button type="button" disabled={busy || reading} onClick={() => { generation.current++; setReading(false); setDraft(current => ({ ...current, icon: "" })); }}>{editing?.builtin ? "使用内置图标" : "移除图片"}</Button>}</div><p>一张透明背景图片即可，外框跟随主题。支持 PNG、JPEG、WebP，最大 64 KB。</p></div>
            <Field label="匹配别名" help="商家名称自动参与匹配。其他别名用逗号或换行分隔。"><textarea value={draft.aliases} onChange={event => setDraft(current => ({ ...current, aliases: event.target.value }))} maxLength={2000} disabled={busy} rows={3} placeholder="例如：干杯 Cloud、USVPS24" /></Field>
            <Field label="其他匹配域名" help="填写 example.com，可匹配其子域名。多个域名用逗号或换行分隔。"><textarea value={draft.domains} onChange={event => setDraft(current => ({ ...current, domains: event.target.value }))} maxLength={2000} disabled={busy} rows={3} placeholder="example.com" /></Field>
            <label className="check merchant-enabled-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))} /><span>启用商家，参与自动匹配</span></label>
          </div>
          <div className="merchant-editor-footer"><Button type="button" disabled={busy} onClick={closeEditor}>取消</Button><Button type="submit" variant="primary" disabled={loading || reading} busy={busy}><Save size={15} aria-hidden="true" />保存商家</Button></div>
        </form>}
      </div>
    </section>
  );
}
