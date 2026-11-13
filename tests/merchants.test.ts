import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate, type DB } from "../server/db.js";
import { createMerchant, isMerchantIcon, listMerchants, MerchantError, merchantCreateSchema, normalizeMerchantDomain, resetMerchant, updateMerchant } from "../server/merchants.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function fixture() {
  const db = openDatabase(":memory:"); migrate(db); return db;
}
function allRows(db: DB) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','merchant_overrides') ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test("merchant catalog preserves existing app keys, colors and aliases and all bundled cloud marks", () => {
  const db = fixture();
  try {
    const catalog = listMerchants(db);
    assert.ok(catalog.length >= 149);
    assert.equal(new Set(catalog.map(entry => entry.key)).size, catalog.length);
    for (const entry of catalog) {
      assert.equal(entry.enabled, true);
      assert.equal(entry.builtin, true);
      assert.equal(entry.customized, false);
      assert.equal(entry.icon, "");
      assert.ok(entry.aliases.includes(entry.label));
    }
    const microsoft = catalog.find(entry => entry.key === "microsoft")!;
    assert.equal(microsoft.color, "#518ee2");
    assert.equal(microsoft.image, undefined);
    assert.ok(microsoft.aliases.includes("Office 365"));
    assert.ok(microsoft.domains.includes("office365.com"));
    assert.ok(catalog.find(entry => entry.key === "merchant-dmit")?.image?.light.startsWith("/app-icons/merchants/"));
    assert.ok(catalog.find(entry => entry.key === "merchant-po0")?.domains.includes("po0.io"));
    catalog[0]!.domains.push("mutated.example.com");
    assert.ok(!listMerchants(db)[0]!.domains.includes("mutated.example.com"));
  } finally { db.close(); }
});

test("merchant uploads persist across database reopen; overrides, reversible disable and builtin reset keep original marks", () => {
  const dir = mkdtempSync(join(tmpdir(), "renewly-merchants-"));
  const path = join(dir, "test.sqlite");
  let db = openDatabase(path); migrate(db);
  try {
    const builtin = listMerchants(db).find(entry => entry.key === "merchant-dmit")!;
    const changed = updateMerchant(db, builtin.key, { label: "我的 DMIT", aliases: ["自定义大妈"], website: "https://www.dmit.io/clientarea", icon: png });
    assert.equal(changed.customized, true);
    assert.equal(changed.builtin, true);
    assert.equal(changed.icon, png);
    assert.equal(changed.image, undefined, "Uploaded bytes appear only once in catalog JSON");
    const custom = createMerchant(db, { label: "我家云", website: "https://www.custom-merchant.example.com/billing", aliases: ["家庭 云", "家庭云"], icon: png });
    assert.match(custom.key, /^merchant-custom-[a-f0-9]{24}$/);
    assert.ok(custom.key.length <= 40, "Existing subscription icon validation still accepts custom keys");
    assert.equal(custom.builtin, false);
    assert.equal(custom.customized, true);
    assert.deepEqual(custom.domains, ["custom-merchant.example.com"]);
    assert.deepEqual(custom.aliases, ["我家云", "家庭云"]);
    db.close(); db = openDatabase(path); migrate(db);
    assert.equal(listMerchants(db).find(entry => entry.key === custom.key)?.icon, png);
    assert.equal(listMerchants(db).find(entry => entry.key === builtin.key)?.label, "我的 DMIT");
    const disabled = updateMerchant(db, custom.key, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.icon, png, "Disabled manual selections retain their image");
    assert.equal(updateMerchant(db, custom.key, { enabled: true }).enabled, true);
    assert.throws(() => resetMerchant(db, custom.key), (error: unknown) => error instanceof MerchantError && error.code === "MERCHANT_NOT_BUILTIN");
    assert.deepEqual(resetMerchant(db, builtin.key), builtin);
    assert.equal(listMerchants(db).find(entry => entry.key === custom.key)?.icon, png);
    assert.throws(() => updateMerchant(db, "missing", { enabled: false }), (error: unknown) => error instanceof MerchantError && error.status === 404);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("merchant validation rejects unsafe icons and nonpublic domains without changing a saved override", () => {
  const db = fixture();
  try {
    const saved = createMerchant(db, { label: "安全商家", domains: ["Example.COM."], icon: png });
    assert.deepEqual(saved.domains, ["example.com"]);
    assert.equal(isMerchantIcon(png), true);
    const before = db.prepare("SELECT * FROM merchant_overrides ORDER BY key").all();
    const huge = "data:image/png;base64," + Buffer.alloc(65_537).toString("base64");
    const giantPng = Buffer.from(png.split(",")[1]!, "base64"); giantPng.writeUInt32BE(2049, 16);
    for (const icon of [
      "https://example.com/icon.png", "/app-icons/merchants/po0.webp", "data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,PGh0bWw+",
      "data:image/png;base64,AAAA", "data:image/jpeg;base64,/9j/", "data:image/webp;base64,UklGRg==", huge,
      "data:image/png;base64," + giantPng.toString("base64"),
      png + "\n", png.replace("png", "jpeg"),
    ]) {
      assert.throws(() => updateMerchant(db, saved.key, { icon }), { name: "ZodError" });
      assert.deepEqual(db.prepare("SELECT * FROM merchant_overrides ORDER BY key").all(), before);
    }
    for (const domain of ["localhost", "thing.localhost", "private.internal", "router.lan", "app.test", "127.0.0.1", "[::1]", "*.example.com", "https://example.com", "user@example.com", "example.com/path", "example.com:443", "-bad.example.com", "example..com"])
      assert.equal(normalizeMerchantDomain(domain), null, domain);
    for (const website of ["javascript:alert(1)", "data:text/html,test", "https://user:pass@example.com", "http://127.0.0.1", "https://localhost/"])
      assert.equal(merchantCreateSchema.safeParse({ label: "安全商家", website }).success, false, website);
    assert.equal(normalizeMerchantDomain("例子.中国"), "xn--fsqu00a.xn--fiqs8s");
    assert.equal(merchantCreateSchema.safeParse({ label: "x", enabled: 1 }).success, false);
    assert.equal(merchantCreateSchema.safeParse({ label: "x", key: "admin-controlled-key" }).success, false);
  } finally { db.close(); }
});

test("merchant matching conflicts are explicit and disabled entries can be maintained without losing manual references", () => {
  const db = fixture();
  try {
    assert.throws(() => createMerchant(db, { label: "Other", domains: ["dmit.io"] }), (error: unknown) => error instanceof MerchantError && error.code === "MERCHANT_DOMAIN_CONFLICT");
    assert.throws(() => createMerchant(db, { label: "Other", aliases: ["ＤＭＩＴ"] }), (error: unknown) => error instanceof MerchantError && error.code === "MERCHANT_ALIAS_CONFLICT");
    const archived = createMerchant(db, { label: "保留的图标", domains: ["dmit.io"], icon: png, enabled: false });
    assert.equal(archived.icon, png);
    assert.equal(listMerchants(db).find(entry => entry.key === archived.key)?.enabled, false);
    assert.throws(() => updateMerchant(db, archived.key, { enabled: true }), (error: unknown) => error instanceof MerchantError && error.code === "MERCHANT_DOMAIN_CONFLICT");
    assert.equal(listMerchants(db).find(entry => entry.key === archived.key)?.enabled, false);
    updateMerchant(db, archived.key, { domains: ["another.example.com"], enabled: true });
    assert.equal(listMerchants(db).find(entry => entry.key === archived.key)?.enabled, true);
    assert.throws(() => updateMerchant(db, archived.key, {}), { name: "ZodError" });
  } finally { db.close(); }
});

test("restoring a builtin refuses domain or alias conflicts without losing either saved override", () => {
  for (const conflict of ["domain", "alias"]) {
    const db = fixture();
    try {
      updateMerchant(db, "merchant-dmit", { label: "迁移后的商家", website: "https://moved-merchant.example.com", domains: [], aliases: ["迁移别名"] });
      const custom = createMerchant(db, { label: "另一家商家", domains: conflict === "domain" ? ["dmit.io"] : [], aliases: conflict === "alias" ? ["DMIT"] : [], icon: png });
      const before = db.prepare("SELECT * FROM merchant_overrides ORDER BY key").all();
      assert.throws(() => resetMerchant(db, "merchant-dmit"), (error: unknown) => error instanceof MerchantError && error.code === (conflict === "domain" ? "MERCHANT_DOMAIN_CONFLICT" : "MERCHANT_ALIAS_CONFLICT"));
      assert.deepEqual(db.prepare("SELECT * FROM merchant_overrides ORDER BY key").all(), before);
      updateMerchant(db, custom.key, { enabled: false });
      const restored = resetMerchant(db, "merchant-dmit");
      assert.equal(restored.customized, false);
      assert.equal(restored.enabled, true);
      assert.equal(listMerchants(db).find(entry => entry.key === custom.key)?.icon, png);
    } finally { db.close(); }
  }
});

test("v10 merchant migration preserves populated v9 data, rolls back a failed marker and is repeatable", () => {
  const db = fixture();
  try {
    db.exec(`
      INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u','saved@example.com','用户','saved-hash','admin','2026-11-13');
      INSERT INTO subscriptions(id,user_id,type_key,name,vendor,website,currency,purchase_minor,renewal_minor,billing_months,billing_anchor_day,next_renewal,created_at,updated_at)
        VALUES('cloud','u','cloud','服务器','DMIT','https://dmit.io','USD',12000,13000,12,13,'2027-11-13T12:30','2026-11-13','2026-11-13'),
              ('app','u','app','应用','Notion','https://notion.so','CNY',1000,1000,1,13,'2026-12-13T00:00','2026-11-13','2026-11-13');
      INSERT INTO server_details(subscription_id,region,model,traffic_mode,icon) VALUES('cloud','香港','1C1G','unlimited','merchant-dmit');
      INSERT INTO app_details(subscription_id,plan,purchase_channel,account,icon) VALUES('app','Plus','应用内购','saved-account','notion');
      INSERT INTO billing_periods(subscription_id,user_id,starts_at,ends_at,paid_minor,currency,created_at) VALUES('cloud','u','2026-11-13T12:30','2027-11-13T12:30',12000,'USD','2026-11-13');
      INSERT INTO notification_settings(user_id,recipient_email) VALUES('u','saved-recipient@example.com');
      UPDATE mail_settings SET sender_email='saved-sender@example.com',secrets_cipher='saved-encrypted-secret';
      DROP TABLE merchant_overrides;
      DELETE FROM schema_migrations WHERE version=10;
    `);
    const before = allRows(db), markers = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    db.exec("CREATE TRIGGER fail_v10 BEFORE INSERT ON schema_migrations WHEN NEW.version=10 BEGIN SELECT RAISE(ABORT,'simulated v10 failure'); END");
    assert.throws(() => migrate(db), /simulated v10 failure/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='merchant_overrides'").get(), undefined);
    assert.deepEqual(allRows(db), before);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
    db.exec("DROP TRIGGER fail_v10");
    migrate(db);
    assert.deepEqual(allRows(db), before);
    assert.deepEqual(db.prepare("SELECT * FROM merchant_overrides").all(), []);
    assert.equal((db.prepare("SELECT max(version) n FROM schema_migrations").get() as { n: number }).n, 10);
    const saved = createMerchant(db, { label: "升级后商家", icon: png });
    const markerAfter = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    migrate(db);
    assert.deepEqual(allRows(db), before);
    assert.equal(listMerchants(db).find(entry => entry.key === saved.key)?.icon, png);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markerAfter);
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});
