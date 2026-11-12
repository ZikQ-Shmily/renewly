import merchantCatalog from "./merchant-icons.json" with { type: "json" };

export const maxUploadBytes = 64 * 1024;
const rasterData = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const nameSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export function appIconInitial(name: string): string {
  const normalized = name.trim().normalize("NFC");
  if (!normalized) return "云";
  return nameSegmenter?.segment(normalized)[Symbol.iterator]().next().value?.segment
    ?? Array.from(normalized)[0]
    ?? "云";
}

export const appIconPresets = [
  { key: "notion", label: "Notion", domains: ["notion.so", "notion.com"], names: /\bnotion\b/i, color: "currentColor" },
  { key: "spotify", label: "Spotify", domains: ["spotify.com"], names: /\bspotify\b/i, color: "#1db954" },
  { key: "icloud", label: "iCloud+", domains: ["icloud.com"], names: /\bicloud\b/i, color: "#3690f6" },
  { key: "1password", label: "1Password", domains: ["1password.com", "1password.eu", "1password.ca"], names: /\b1password\b/i, color: "#1979f5" },
  { key: "netflix", label: "Netflix", domains: ["netflix.com"], names: /\bnetflix\b/i, color: "#e72c3b" },
  { key: "youtube", label: "YouTube", domains: ["youtube.com", "youtu.be"], names: /\byoutube\b/i, color: "#ed3542" },
  { key: "microsoft", label: "Microsoft", domains: ["microsoft.com", "office.com", "office365.com", "live.com"], names: /\b(?:microsoft|office\s*365|microsoft\s*365)\b/i, color: "#518ee2" },
  { key: "adobe", label: "Adobe", domains: ["adobe.com"], names: /\badobe\b/i, color: "#e7353d" },
  { key: "chatgpt", label: "ChatGPT", domains: ["chatgpt.com", "openai.com"], names: /\b(?:chatgpt|openai)\b/i, color: "currentColor" },
  { key: "github", label: "GitHub", domains: ["github.com"], names: /\bgithub\b/i, color: "currentColor" },
] as const;

export interface IconPreset {
  key: string;
  label: string;
  domains: readonly string[];
  names: RegExp;
  color: string;
  image?: { light: string; dark: string };
}

function merchantName(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const merchantIconPresets: IconPreset[] = merchantCatalog.map(merchant => ({
  key: merchant.key,
  label: merchant.label,
  domains: merchant.domains,
  // Short aliases (CC, AK, etc.) only match the complete merchant field.
  names: new RegExp(merchant.aliases.map(alias => {
    const name = merchantName(alias);
    return name.length <= 2 ? `^${escapeRegex(name)}$` : `(?:^|[^a-z0-9])${escapeRegex(name)}(?=$|[^a-z0-9])`;
  }).join("|"), "i"),
  color: "currentColor",
  image: { light: merchant.light, dark: merchant.dark },
}));

const allIconPresets: readonly IconPreset[] = [...appIconPresets, ...merchantIconPresets];

function websiteUrl(website: string) {
  try {
    const url = new URL(website);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function matchedAppIcon(name: string, website: string): IconPreset | undefined {
  const host = websiteUrl(website)?.hostname.toLowerCase().replace(/\.$/, "");
  const byDomain = host && allIconPresets.find(preset => preset.domains.some(domain => host === domain || host.endsWith(`.${domain}`)));
  return byDomain || appIconPresets.find(preset => preset.names.test(name.normalize("NFKC")))
    || merchantIconPresets.find(preset => preset.names.test(merchantName(name)));
}

/** Only attempt merchant favicons in the browser; never proxy arbitrary URLs. */
export function appFaviconUrl(website: string): string | null {
  const url = websiteUrl(website);
  if (!url || url.protocol !== "https:" || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host.includes(".") || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|lan|home)$/.test(host)
  ) return null;
  return `${url.origin}/favicon.ico`;
}

export function isUploadedAppIcon(value: string) {
  if (!rasterData.test(value)) return false;
  const payload = value.slice(value.indexOf(",") + 1);
  if (payload.length % 4 !== 0) return false;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return payload.length / 4 * 3 - padding <= maxUploadBytes;
}

export function resolveAppIcon(name: string, website: string, value = "auto") {
  const manual = allIconPresets.find(preset => preset.key === value);
  const automatic = value === "auto" || value === "";
  const preset = manual || (automatic ? matchedAppIcon(name, website) : undefined);
  const src = isUploadedAppIcon(value) ? value : automatic && !preset ? appFaviconUrl(website) : null;
  return { preset, src };
}
