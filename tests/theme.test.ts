import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  getThemePreference,
  initializeTheme,
  setThemePreference,
  subscribeTheme,
  THEME_STORAGE_KEY,
} from "../client/src/theme.js";

const bootstrap = readFileSync(
  new URL("../client/public/theme-init.js", import.meta.url),
  "utf8",
);

function createDocument() {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "", backgroundColor: "" } };
  const meta = { content: "", setAttribute(_name: string, value: string) { this.content = value; } };
  return { root, meta, document: { documentElement: root, querySelector: () => meta } };
}

test("the blocking bootstrap applies saved appearance or the OS setting before the app renders", () => {
  for (const scenario of [
    { stored: null, dark: false, expected: "light" },
    { stored: null, dark: true, expected: "dark" },
    { stored: "system", dark: false, expected: "light" },
    { stored: "dark", dark: false, expected: "dark" },
    { stored: "light", dark: true, expected: "light" },
    { stored: "invalid", dark: false, expected: "light" },
  ]) {
    const fixture = createDocument();
    vm.runInNewContext(bootstrap, {
      window: {
        localStorage: { getItem: () => scenario.stored },
        matchMedia: () => ({ matches: scenario.dark }),
      },
      document: fixture.document,
    });
    assert.equal(fixture.root.dataset.theme, scenario.expected);
    assert.equal(fixture.root.style.colorScheme, scenario.expected);
    assert.equal(fixture.meta.content, scenario.expected === "light" ? "#f4f6fb" : "#0d1120");
  }
});

test("blocked browser storage and an unavailable media query do not prevent the initial render", () => {
  const fixture = createDocument();
  vm.runInNewContext(bootstrap, {
    window: {
      localStorage: { getItem: () => { throw new Error("storage blocked"); } },
      matchMedia: () => { throw new Error("media query unavailable"); },
    },
    document: fixture.document,
  });
  assert.equal(fixture.root.dataset.theme, "dark");
  assert.equal(fixture.root.style.backgroundColor, "#0d1120");
});

test("system appearance stays live, manual choice overrides it, and cross-tab changes remain synchronized", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fixture = createDocument();
  let saved: string | null = "dark";
  let blocked = false;
  let onSystemChange: (() => void) | undefined;
  let onStorage: ((event: { key: string | null; newValue: string | null }) => void) | undefined;
  const media = {
    matches: false,
    addEventListener(_type: string, callback: () => void) { onSystemChange = callback; },
  };
  const fakeWindow = {
    localStorage: {
      getItem(key: string) { assert.equal(key, THEME_STORAGE_KEY); return saved; },
      setItem(key: string, value: string) {
        assert.equal(key, THEME_STORAGE_KEY);
        if (blocked) throw new Error("storage blocked");
        saved = value;
      },
    },
    matchMedia() { return media; },
    addEventListener(_type: string, callback: typeof onStorage) { onStorage = callback; },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, "document", { value: fixture.document, configurable: true });
  const snapshots: string[] = [];
  const unsubscribe = subscribeTheme(() => snapshots.push(getThemePreference()));
  try {
    initializeTheme();
    assert.equal(getThemePreference(), "dark");
    assert.equal(fixture.root.dataset.theme, "dark");

    setThemePreference("system");
    assert.equal(saved, "system");
    assert.equal(fixture.root.dataset.theme, "light");
    media.matches = true;
    onSystemChange?.();
    assert.equal(fixture.root.dataset.theme, "dark");

    setThemePreference("light");
    onSystemChange?.();
    assert.equal(fixture.root.dataset.theme, "light");

    blocked = true;
    setThemePreference("dark");
    assert.equal(getThemePreference(), "dark");
    assert.equal(fixture.root.dataset.theme, "dark");
    assert.equal(saved, "light", "blocked persistence does not undo the session choice");

    onStorage?.({ key: THEME_STORAGE_KEY, newValue: "light" });
    assert.equal(getThemePreference(), "light");
    assert.equal(fixture.root.dataset.theme, "light");
    onStorage?.({ key: THEME_STORAGE_KEY, newValue: "invalid" });
    assert.equal(getThemePreference(), "system");
    assert.equal(fixture.root.dataset.theme, "dark");

    saved = null;
    media.matches = false;
    onStorage?.({ key: null, newValue: null });
    assert.equal(fixture.root.dataset.theme, "light");
    assert.equal(fixture.meta.content, "#f4f6fb");
    assert.ok(snapshots.includes("light") && snapshots.includes("dark") && snapshots.includes("system"));
  } finally {
    unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
