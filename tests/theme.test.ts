import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { initializeTheme } from "../client/src/theme.js";

const bootstrap = readFileSync(
  new URL("../client/public/theme-init.js", import.meta.url),
  "utf8",
);

function createDocument(withMeta = true) {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "", backgroundColor: "" } };
  const meta = { content: "", setAttribute(_name: string, value: string) { this.content = value; } };
  return { root, meta, document: { documentElement: root, querySelector: () => withMeta ? meta : null } };
}

function assertDark(fixture: ReturnType<typeof createDocument>) {
  assert.equal(fixture.root.dataset.theme, "dark", "merchant icons must select dark assets");
  assert.equal(fixture.root.style.colorScheme, "dark");
  assert.equal(fixture.root.style.backgroundColor, "#010102");
  assert.equal(fixture.meta.content, "#010102");
}

test("the blocking bootstrap stays dark regardless of legacy saved appearance or OS preference", () => {
  for (const saved of [null, "light", "dark", "system", "invalid"]) {
    for (const systemDark of [true, false]) {
      const fixture = createDocument();
      let browserPreferenceReads = 0;
      vm.runInNewContext(bootstrap, {
        window: {
          localStorage: { getItem() { browserPreferenceReads++; return saved; } },
          matchMedia() { browserPreferenceReads++; return { matches: systemDark }; },
        },
        document: fixture.document,
      });
      assertDark(fixture);
      assert.equal(browserPreferenceReads, 0, "obsolete browser preferences must not influence startup");
    }
  }
});

test("the early paint bootstrap needs no browser storage, media API or theme-color meta", () => {
  const fixture = createDocument(false);
  vm.runInNewContext(bootstrap, { document: fixture.document });
  assert.equal(fixture.root.dataset.theme, "dark");
  assert.equal(fixture.root.style.colorScheme, "dark");
  assert.equal(fixture.root.style.backgroundColor, "#010102");
});

test("the runtime reapplies dark appearance safely without preference listeners or a DOM", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fixture = createDocument();
  const inaccessible = () => { throw new Error("browser preference APIs are unavailable"); };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      get localStorage() { return inaccessible(); },
      matchMedia: inaccessible,
      addEventListener: inaccessible,
    },
  });
  Object.defineProperty(globalThis, "document", { value: fixture.document, configurable: true });
  try {
    initializeTheme();
    assertDark(fixture);
    fixture.root.dataset.theme = "light";
    fixture.root.style.colorScheme = "light";
    initializeTheme();
    assertDark(fixture);
    Reflect.deleteProperty(globalThis, "document");
    assert.doesNotThrow(initializeTheme, "server-side imports must remain safe");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("the HTML shell declares a dark initial paint before scripts and styles load", () => {
  const html = readFileSync(new URL("../client/index.html", import.meta.url), "utf8");
  const root = /<html\b[^>]*>/i.exec(html)?.[0] || "";
  assert.match(root, /data-theme="dark"/);
  assert.match(root, /color-scheme:\s*dark/);
  assert.match(root, /background-color:\s*#010102/);
  assert.match(html, /<meta name="theme-color" content="#010102"\s*\/>/);
  assert.match(html, /<meta name="color-scheme" content="dark"\s*\/>/);
  assert.ok(html.indexOf('src="/theme-init.js"') < html.indexOf('src="/src/main.tsx"'));
});
