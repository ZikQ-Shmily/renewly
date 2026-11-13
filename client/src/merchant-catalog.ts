import { useSyncExternalStore } from "react";
import { builtinIconPresets, merchantName, type IconPreset } from "./app-icons";

export interface MerchantCatalogEntry {
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

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function merchantPreset(entry: MerchantCatalogEntry): IconPreset {
  const aliases = [...new Set([entry.label, ...entry.aliases].map(merchantName).filter(Boolean))];
  return {
    key: entry.key, label: entry.label, domains: entry.domains, enabled: entry.enabled,
    names: new RegExp(aliases.map(name => name.length <= 2
      ? `^${escapeRegex(name)}$`
      : `(?:^|[^a-z0-9])${escapeRegex(name)}(?=$|[^a-z0-9])`).join("|"), "i"),
    color: entry.color,
    image: entry.icon ? { light: entry.icon, dark: entry.icon } : entry.image,
  };
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
