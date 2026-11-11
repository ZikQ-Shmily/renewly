import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export type DB = Database.Database;
export function openDatabase(path: string): DB {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (path !== ":memory:" && existsSync(path)) chmodSync(path, 0o600);
  return db;
}
export function migrate(db: DB) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  const version = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  if ((version.version || 0) < 1) db.transaction(() => {
    db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','admin')),currency TEXT NOT NULL DEFAULT 'CNY',time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai',created_at TEXT NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE notification_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,recipient_email TEXT NOT NULL DEFAULT '',email_verified INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,reminder_days TEXT NOT NULL DEFAULT '[7,3,1]');
      CREATE TABLE subscriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,type_key TEXT NOT NULL DEFAULT 'cloud',name TEXT NOT NULL,vendor TEXT NOT NULL,website TEXT NOT NULL,currency TEXT NOT NULL,purchase_minor INTEGER NOT NULL,renewal_minor INTEGER NOT NULL,billing_months INTEGER NOT NULL,billing_anchor_day INTEGER NOT NULL,next_renewal TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',notes TEXT NOT NULL DEFAULT '',reminder_days TEXT NOT NULL DEFAULT '[7,3,1]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX subscriptions_owner ON subscriptions(user_id,status,next_renewal);
      CREATE INDEX subscriptions_due ON subscriptions(status,next_renewal);
      CREATE TABLE server_details(subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,region TEXT NOT NULL,model TEXT NOT NULL,traffic_mode TEXT NOT NULL,traffic_quota_bytes INTEGER,traffic_unit TEXT NOT NULL DEFAULT 'GB');
      CREATE TABLE billing_periods(id INTEGER PRIMARY KEY AUTOINCREMENT,subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,paid_minor INTEGER NOT NULL,currency TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX billing_periods_owner ON billing_periods(user_id,subscription_id,ends_at);
      CREATE TABLE exchange_rates(id INTEGER PRIMARY KEY CHECK(id=1),rate_date TEXT NOT NULL,fetched_at TEXT NOT NULL,rates_json TEXT NOT NULL);
      CREATE TABLE mail_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,transport TEXT NOT NULL DEFAULT 'smtp',sender_name TEXT NOT NULL DEFAULT '续记',sender_email TEXT NOT NULL DEFAULT '',smtp_host TEXT NOT NULL DEFAULT '',smtp_port INTEGER NOT NULL DEFAULT 465,smtp_secure INTEGER NOT NULL DEFAULT 1,smtp_user TEXT NOT NULL DEFAULT '',secrets_cipher TEXT NOT NULL DEFAULT '');
      INSERT INTO mail_settings(id) VALUES(1);
      CREATE TABLE email_verifications(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,email TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE INDEX verification_user ON email_verifications(user_id);
      CREATE TABLE reminder_deliveries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),subscription_id TEXT REFERENCES subscriptions(id),subscription_name TEXT,due_date TEXT,days_before INTEGER,channel TEXT NOT NULL DEFAULT 'email',kind TEXT NOT NULL DEFAULT 'reminder',status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,sent_at TEXT,next_attempt_at TEXT,error TEXT,UNIQUE(subscription_id,due_date,days_before,channel));
      CREATE INDEX deliveries_owner ON reminder_deliveries(user_id,created_at);
      CREATE TABLE audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(
      new Date().toISOString(),
    );
  })();
  if ((version.version || 0) < 2) db.transaction(() => {
    db.exec(`
      ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled'));
      ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(auto_renew IN (0,1));
      ALTER TABLE server_details ADD COLUMN bandwidth_value REAL CHECK(bandwidth_value > 0);
      ALTER TABLE server_details ADD COLUMN bandwidth_unit TEXT NOT NULL DEFAULT 'Mbps' CHECK(bandwidth_unit IN ('Mbps','Gbps'));
    `);
    db.prepare("INSERT INTO schema_migrations VALUES(2,?)").run(new Date().toISOString());
  })();
  if ((version.version || 0) < 3) db.transaction(() => {
    db.exec(`
      UPDATE subscriptions SET next_renewal=next_renewal || 'T00:00' WHERE length(next_renewal)=10;
      UPDATE billing_periods SET starts_at=starts_at || 'T00:00' WHERE length(starts_at)=10;
      UPDATE billing_periods SET ends_at=ends_at || 'T00:00' WHERE length(ends_at)=10;
      UPDATE reminder_deliveries SET due_date=due_date || 'T00:00' WHERE length(due_date)=10;
    `);
    db.prepare("INSERT INTO schema_migrations VALUES(3,?)").run(new Date().toISOString());
  })();
  if ((version.version || 0) < 4) db.transaction(() => {
    db.exec(`
      ALTER TABLE server_details ADD COLUMN cpu_cores REAL CHECK(cpu_cores > 0);
      ALTER TABLE server_details ADD COLUMN memory_value REAL CHECK(memory_value > 0);
      ALTER TABLE server_details ADD COLUMN memory_unit TEXT NOT NULL DEFAULT 'GB' CHECK(memory_unit IN ('MB','GB'));
      ALTER TABLE server_details ADD COLUMN disk_value REAL CHECK(disk_value > 0);
      ALTER TABLE server_details ADD COLUMN disk_unit TEXT NOT NULL DEFAULT 'GB' CHECK(disk_unit IN ('GB','TB'));
      ALTER TABLE server_details ADD COLUMN ip_addresses TEXT NOT NULL DEFAULT '[]';
    `);
    db.prepare("INSERT INTO schema_migrations VALUES(4,?)").run(new Date().toISOString());
  })();
  if ((version.version || 0) < 5) db.transaction(() => {
    db.exec("ALTER TABLE server_details ADD COLUMN traffic_direction TEXT NOT NULL DEFAULT 'unknown' CHECK(traffic_direction IN ('one_way','two_way','unknown'))");
    db.prepare("INSERT INTO schema_migrations VALUES(5,?)").run(new Date().toISOString());
  })();
}
