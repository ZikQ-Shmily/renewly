import { useSyncExternalStore } from "react";
import { builtinIconPresets, merchantName, type IconPreset } from "./app-icons.js";

export interface MerchantCatalogEntry {
  key: string;
  label: string;
  website: string;
  domains: string[];
  aliases: string[];
  categories: ("cloud" | "app")[];
  icon: string;
  image?: { light: string; dark: string };
  color: string;
  enabled: boolean;
  builtin: boolean;
  customized: boolean;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function merchantPreset(entry: MerchantCatalogEntry): IconPreset {
  const aliases = [...new Set([entry.label, ...entry.aliases].map(merchantName).filter(Boolean))];
  return {
    key: entry.key, label: entry.label, domains: entry.domains, enabled: entry.enabled, website: entry.website, aliases: entry.aliases, categories: entry.categories,
    names: new RegExp(aliases.map(name => name.length <= 2
      ? `^${escapeRegex(name)}$`
      : `(?:^|[^a-z0-9])${escapeRegex(name)}(?=$|[^a-z0-9])`).join("|"), "i"),
    color: entry.color,
    image: entry.icon ? { light: entry.icon, dark: entry.icon } : entry.image,
  };
}

/** Only unambiguous exact names or aliases may fill a form field. */
export function merchantWebsiteForName(name: string, entries: readonly IconPreset[], category?: "cloud" | "app"): string {
  const normalized = merchantName(name);
  if (!normalized) return "";
  const matches = entries.filter(entry => entry.enabled !== false && entry.website && (!category || !entry.categories || entry.categories.includes(category)) &&
    [entry.label, ...(entry.aliases || [])].some(alias => merchantName(alias) === normalized));
  return matches.length === 1 ? matches[0]!.website! : "";
}

let catalog: readonly IconPreset[] = builtinIconPresets;
const listeners = new Set<() => void>();
function publish(next: readonly IconPreset[]) {
  catalog = next;
  for (const listener of listeners) listener();
}
export function setMerchantCatalog(entries: MerchantCatalogEntry[]) { publish(entries.map(merchantPreset)); }
export function clearMerchantCatalog() { publish(builtinIconPresets); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useMerchantCatalog() { return useSyncExternalStore(subscribe, () => catalog, () => builtinIconPresets); }
