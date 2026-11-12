export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "renewly:appearance";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

let preference: ThemePreference = "system";
let media: MediaQueryList | null = null;
let initialized = false;
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function applyTheme() {
  const resolved = resolveTheme(preference, media?.matches ?? true);
  const background = resolved === "light" ? "#f4f6fb" : "#0d1120";
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.backgroundColor = background;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", background);
}

function notify() {
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  preference = readPreference();
  try {
    media = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    media = null;
  }
  applyTheme();

  const systemChanged = () => {
    if (preference === "system") applyTheme();
  };
  if (media?.addEventListener) media.addEventListener("change", systemChanged);
  else media?.addListener?.(systemChanged);

  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    preference = event.key === null
      ? readPreference()
      : parseThemePreference(event.newValue);
    applyTheme();
    notify();
  });
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setThemePreference(next: ThemePreference) {
  preference = parseThemePreference(next);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked store must not prevent changing appearance for this session.
  }
  applyTheme();
  notify();
}
