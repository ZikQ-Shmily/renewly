import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";
import type { DB } from "./db.js";
import merchantCatalog from "../client/src/merchant-icons.json" with { type: "json" };
import merchantWebsites from "../client/src/merchant-websites.json" with { type: "json" };

export type MerchantCategory = "cloud" | "app";
export interface MerchantCatalogEntry {
  categories: MerchantCategory[];
  key: string;
  label: string;
  website: string;
  domains: string[];
  aliases: string[];
  icon: string;
  image?: { light: string; dark: string };
  color: string;
  enabled: boolean;
  builtin: boolean;
  customized: boolean;
}

export class MerchantError extends Error {
  constructor(public status: 404 | 409, public code: string, message: string) {
    super(message);
  }
}

const reservedHosts = /(?:^|\.)(?:localhost|local|internal|invalid|test|lan|home|localhost\.localdomain)$/i;
export function normalizeMerchantDomain(value: string): string | null {
  const raw = value.trim().toLowerCase().replace(/\.$/, "");
  if (!raw || /[\s/:@?#*\\%\[\]]/.test(raw)) return null;
  const domain = domainToASCII(raw);
  if (!domain || domain.length > 253 || !domain.includes(".") || isIP(domain) || /^[\d.]+$/.test(domain) || reservedHosts.test(domain)) return null;
  if (!domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/[a-z]/.test(domain.split(".").at(-1)!)) return null;
  return domain;
}

function safeRaster(bytes: Buffer, kind: string): boolean {
  if (kind === "png") {
    return bytes.length >= 45
      && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString() === "IHDR"
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048
      && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048
      && bytes.subarray(-8, -4).toString() === "IEND";
  }
  if (kind === "jpeg") {
    if (bytes.length < 15 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
    let position = 2;
    while (position + 3 < bytes.length) {
      if (bytes[position++] !== 0xff) return false;
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === 0xd9 || marker === 0xda || marker === undefined) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return false;
        const height = bytes.readUInt16BE(position + 3), width = bytes.readUInt16BE(position + 5);
        return width > 0 && height > 0 && width <= 2048 && height <= 2048;
      }
      position += length;
    }
    return false;
  }
  if (bytes.length < 25 || bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  const chunk = bytes.subarray(12, 16).toString();
  let width = 0, height = 0;
  if (chunk === "VP8X" && bytes.length >= 30 && bytes.readUInt32LE(16) >= 10) {
    width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
  } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
  }
  return width > 0 && height > 0 && width <= 2048 && height <= 2048;
}

export function isMerchantIcon(value: string): boolean {
  if (value === "") return true;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  return bytes.length <= 65_536 && bytes.toString("base64") === match[2] && safeRaster(bytes, match[1]!);
}

const labelSchema = z.string().trim().min(1, "请填写商家名称。").max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "名称不能包含控制字符。");
const domainSchema = z.string().trim().max(253).transform((value, context) => {
  const normalized = normalizeMerchantDomain(value);
  if (normalized) return normalized;
  context.addIssue({ code: "custom", message: "请填写有效的公开域名，例如 example.com。" });
  return z.NEVER;
});
const websiteSchema = z.string().trim().max(2048).refine(value => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && normalizeMerchantDomain(url.hostname) !== null;
  } catch { return false; }
}, "官网须为不含账号密码的公开 HTTP(S) 地址。");
const unique = (values: string[]) => [...new Set(values)];
const fields = {
  label: labelSchema,
  website: websiteSchema,
  domains: z.array(domainSchema).max(30).transform(unique),
  aliases: z.array(labelSchema).max(30).transform(values => [...new Map(values.map(value => [value.normalize("NFKC").toLowerCase().replace(/\s+/g, ""), value])).values()]),
  icon: z.string().max(90_000).refine(isMerchantIcon, "图标须为不超过 64 KB、尺寸不超过 2048 像素的 PNG、JPEG 或 WebP 图片。"),
  enabled: z.boolean(),
  categories: z.array(z.enum(["cloud", "app"])).min(1).max(2).refine(values => new Set(values).size === values.length, "分类不能重复。"),
};
export const merchantCreateSchema = z.object({
  label: fields.label,
  website: fields.website.default(""),
  domains: fields.domains.default([]),
  aliases: fields.aliases.default([]),
  icon: fields.icon.default(""),
  enabled: fields.enabled.default(true),
  categories: fields.categories.default(["cloud", "app"]),
}).strict();
export const merchantUpdateSchema = z.object(fields).partial().strict().refine(value => Object.keys(value).length > 0, "请填写需要修改的信息。");
type MerchantInput = z.infer<typeof merchantCreateSchema>;

const appCatalog = [
  { key: "notion", label: "Notion", domains: ["notion.so", "notion.com"], aliases: ["Notion"], color: "currentColor" },
  { key: "spotify", label: "Spotify", domains: ["spotify.com"], aliases: ["Spotify"], color: "#1db954" },
  { key: "icloud", label: "iCloud+", domains: ["icloud.com"], aliases: ["iCloud", "iCloud+"], color: "#3690f6" },
  { key: "1password", label: "1Password", domains: ["1password.com", "1password.eu", "1password.ca"], aliases: ["1Password"], color: "#1979f5" },
  { key: "netflix", label: "Netflix", domains: ["netflix.com"], aliases: ["Netflix"], color: "#e72c3b" },
  { key: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be"], aliases: ["YouTube"], color: "#ed3542" },
  { key: "microsoft", label: "Microsoft", domains: ["microsoft.com", "office.com", "office365.com", "live.com"], aliases: ["Microsoft", "Office 365", "Microsoft 365"], color: "#518ee2" },
  { key: "adobe", label: "Adobe", domains: ["adobe.com"], aliases: ["Adobe"], color: "#e7353d" },
  { key: "chatgpt", label: "ChatGPT", domains: ["chatgpt.com", "openai.com"], aliases: ["ChatGPT", "OpenAI"], color: "currentColor" },
  { key: "github", label: "GitHub", domains: ["github.com"], aliases: ["GitHub"], color: "currentColor" },
  { key: "iqiyi", label: "爱奇艺", domains: ["www.iqiyi.com", "iqiyi.com"], aliases: ["爱奇艺", "iQIYI"], color: "#00be5a" },
  { key: "youku", label: "优酷", domains: ["www.youku.com", "youku.com"], aliases: ["优酷", "Youku"], color: "#1677ff" },
  { key: "tencent-video", label: "腾讯视频", domains: ["v.qq.com"], aliases: ["腾讯视频", "Tencent Video"], color: "#ee8637" },
  { key: "bilibili", label: "哔哩哔哩", domains: ["www.bilibili.com", "bilibili.com"], aliases: ["哔哩哔哩", "Bilibili", "B站"], color: "#fb7299" },
  { key: "mangotv", label: "芒果 TV", domains: ["www.mgtv.com", "mgtv.com"], aliases: ["芒果TV", "芒果 TV", "芒果视频"], color: "#f58924" },
  { key: "qq-music", label: "QQ音乐", domains: ["y.qq.com"], aliases: ["QQ音乐", "QQ Music"], color: "#2caf62" },
  { key: "kugou", label: "酷狗音乐", domains: ["www.kugou.com", "kugou.com"], aliases: ["酷狗音乐", "酷狗", "KuGou"], color: "#1686e8" },
  { key: "kuwo", label: "酷我音乐", domains: ["www.kuwo.cn", "kuwo.cn"], aliases: ["酷我音乐", "酷我", "Kuwo"], color: "#f3a924" },
  { key: "baidu-pan", label: "百度网盘", domains: ["pan.baidu.com"], aliases: ["百度网盘", "百度云盘"], color: "#2674ee" },
  { key: "quark-pan", label: "夸克网盘", domains: ["pan.quark.cn"], aliases: ["夸克网盘"], color: "#4176f7" },
];

function websiteDomains(website: string) {
  if (!website) return [];
  try {
    const domain = normalizeMerchantDomain(new URL(website).hostname.replace(/^www\./i, ""));
    return domain ? [domain] : [];
  } catch { return []; }
}
function complete(entry: MerchantCatalogEntry): MerchantCatalogEntry {
  return { ...entry, domains: unique([...entry.domains, ...websiteDomains(entry.website)]), aliases: unique([entry.label, ...entry.aliases]) };
}
const builtinCatalog: MerchantCatalogEntry[] = [
  ...appCatalog.map(entry => complete({ ...entry, categories: ["app"], website: `https://${entry.domains[0]}/`, icon: "", enabled: true, builtin: true, customized: false })),
  ...merchantCatalog.map(entry => complete({ key: entry.key, label: entry.label, categories: ["merchant-infuse", "merchant-netease-cloud-music"].includes(entry.key) ? ["app"] : ["cloud"], domains: [...entry.domains], aliases: [...entry.aliases], website: entry.domains.length ? `https://${entry.domains[0]}/` : (merchantWebsites as Record<string, string>)[entry.key] || "", color: "currentColor", image: { light: entry.light, dark: entry.dark }, icon: "", enabled: true, builtin: true, customized: false })),
];
const builtinByKey = new Map(builtinCatalog.map(entry => [entry.key, entry]));
interface MerchantRow { key: string; label: string; website: string; domains_json: string; aliases_json: string; icon: string; enabled: number; is_custom: number; categories_json: string | null }
function merged(base: MerchantCatalogEntry | undefined, row: MerchantRow): MerchantCatalogEntry {
  return complete({
    categories: row.categories_json ? JSON.parse(row.categories_json) : [...(base?.categories || ["cloud", "app"])],
    key: row.key, label: row.label, website: row.website, domains: JSON.parse(row.domains_json), aliases: JSON.parse(row.aliases_json),
    color: base?.color || "currentColor", icon: row.icon,
    ...(!row.icon && base?.image ? { image: { ...base.image } } : {}),
    enabled: row.enabled === 1, builtin: Boolean(base), customized: true,
  });
}

/** Includes disabled records so previously selected manual icons remain resolvable. */
export function listMerchants(db: DB): MerchantCatalogEntry[] {
  const rows = db.prepare("SELECT * FROM merchant_overrides ORDER BY created_at,key").all() as MerchantRow[];
  const overrides = new Map(rows.map(row => [row.key, row]));
  return [
    ...builtinCatalog.map(base => overrides.has(base.key) ? merged(base, overrides.get(base.key)!) : complete({ ...base, domains: [...base.domains], aliases: [...base.aliases], ...(base.image ? { image: { ...base.image } } : {}) })),
    ...rows.filter(row => !builtinByKey.has(row.key)).map(row => merged(undefined, row)),
  ];
}

function inputFor(entry: MerchantCatalogEntry): MerchantInput {
  const implicitDomains = websiteDomains(entry.website);
  const name = entry.label.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return { label: entry.label, website: entry.website, domains: entry.domains.filter(domain => !implicitDomains.includes(domain)), aliases: entry.aliases.filter(alias => alias.normalize("NFKC").toLowerCase().replace(/\s+/g, "") !== name), icon: entry.icon, enabled: entry.enabled, categories: [...entry.categories] };
}
function write(db: DB, key: string, input: MerchantInput, custom: boolean) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO merchant_overrides(key,label,website,domains_json,aliases_json,icon,enabled,is_custom,created_at,updated_at,categories_json)
    VALUES(@key,@label,@website,@domains,@aliases,@icon,@enabled,@custom,@now,@now,@categories)
    ON CONFLICT(key) DO UPDATE SET label=excluded.label,website=excluded.website,domains_json=excluded.domains_json,aliases_json=excluded.aliases_json,icon=excluded.icon,enabled=excluded.enabled,updated_at=excluded.updated_at,categories_json=excluded.categories_json`)
    .run({ key, label: input.label, website: input.website, domains: JSON.stringify(input.domains), aliases: JSON.stringify(input.aliases), icon: input.icon, enabled: input.enabled ? 1 : 0, custom: custom ? 1 : 0, now, categories: JSON.stringify(input.categories) });
}

function assertNoConflicts(db: DB, key: string, input: MerchantInput) {
  if (!input.enabled) return;
  const domains = new Set([...input.domains, ...websiteDomains(input.website)]);
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const aliases = new Set([input.label, ...input.aliases].map(normalize));
  for (const entry of listMerchants(db)) {
    if (entry.key === key || !entry.enabled) continue;
    if (entry.domains.some(domain => domains.has(domain)))
      throw new MerchantError(409, "MERCHANT_DOMAIN_CONFLICT", `域名已配置在「${entry.label}」，请编辑现有商家或调整域名。`);
    if (entry.aliases.some(alias => aliases.has(normalize(alias))))
      throw new MerchantError(409, "MERCHANT_ALIAS_CONFLICT", `名称或别名已配置在「${entry.label}」，请编辑现有商家或调整别名。`);
  }
}

export function createMerchant(db: DB, raw: unknown): MerchantCatalogEntry {
  const input = merchantCreateSchema.parse(raw);
  const key = `merchant-custom-${randomBytes(12).toString("hex")}`;
  db.transaction(() => {
    if ((db.prepare("SELECT count(*) n FROM merchant_overrides WHERE is_custom=1").get() as { n: number }).n >= 500)
      throw new MerchantError(409, "MERCHANT_LIMIT", "自定义商家最多支持 500 家，请先整理现有商家。");
    assertNoConflicts(db, key, input);
    write(db, key, input, true);
  })();
  return merged(undefined, db.prepare("SELECT * FROM merchant_overrides WHERE key=?").get(key) as MerchantRow);
}

export function updateMerchant(db: DB, key: string, raw: unknown): MerchantCatalogEntry {
  const patch = merchantUpdateSchema.parse(raw);
  db.transaction(() => {
    const current = listMerchants(db).find(entry => entry.key === key);
    if (!current) throw new MerchantError(404, "MERCHANT_NOT_FOUND", "商家不存在。");
    const input = merchantCreateSchema.parse({ ...inputFor(current), ...patch });
    assertNoConflicts(db, key, input);
    write(db, key, input, !current.builtin);
  })();
  return merged(builtinByKey.get(key), db.prepare("SELECT * FROM merchant_overrides WHERE key=?").get(key) as MerchantRow);
}

/** Restore a built-in entry. Custom entries are disabled reversibly via updateMerchant. */
export function resetMerchant(db: DB, key: string): MerchantCatalogEntry {
  const base = builtinByKey.get(key);
  if (!base) {
    if (db.prepare("SELECT 1 FROM merchant_overrides WHERE key=?").get(key))
      throw new MerchantError(409, "MERCHANT_NOT_BUILTIN", "自定义商家可停用或重新启用，无法恢复为内置配置。");
    throw new MerchantError(404, "MERCHANT_NOT_FOUND", "商家不存在。");
  }
  db.transaction(() => {
    assertNoConflicts(db, key, inputFor(base));
    db.prepare("DELETE FROM merchant_overrides WHERE key=?").run(key);
  })();
  return complete({ ...base, domains: [...base.domains], aliases: [...base.aliases], ...(base.image ? { image: { ...base.image } } : {}) });
}
