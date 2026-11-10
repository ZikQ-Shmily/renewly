import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { DB } from "./db.js";
import type { Config } from "./config.js";
export const tokenHash = (v: string) =>
  createHash("sha256").update(v).digest("hex");
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [, salt, key] = hash.split("$");
  if (!salt || !key) return false;
  const derived = await derive(password, salt),
    expected = Buffer.from(key, "hex");
  return (
    expected.length === derived.length && timingSafeEqual(derived, expected)
  );
}
export function publicUser(row: any) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    currency: row.currency,
    timeZone: row.time_zone,
  };
}
export async function createUser(
  db: DB,
  email: string,
  name: string,
  password: string,
  role: "admin" | "user" = "user",
) {
  const id = randomUUID(),
    hash = await hashPassword(password),
    now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, email, name, hash, role, now);
    db.prepare("INSERT INTO notification_settings(user_id) VALUES(?)").run(id);
  })();
  return db.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
}
export async function bootstrap(db: DB, config: Config) {
  if (db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get())
    return;
  if (config.bootstrapEmail && config.bootstrapPassword) {
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.bootstrapEmail) ||
      config.bootstrapPassword.length < 12 ||
      /replace|change[-_ ]?me/i.test(config.bootstrapPassword)
    )
      throw new Error(
        "Bootstrap admin email/password invalid (password needs at least 12 characters).",
      );
    if (
      db
        .prepare("SELECT id FROM users WHERE email=?")
        .get(config.bootstrapEmail)
    )
      throw new Error("Bootstrap email already belongs to a non-admin user.");
    await createUser(
      db,
      config.bootstrapEmail,
      "管理员",
      config.bootstrapPassword,
      "admin",
    );
  } else if (config.production)
    throw new Error(
      "First startup requires BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD.",
    );
}
export function createSession(db: DB, userId: string) {
  const token = randomBytes(32).toString("base64url"),
    expires = new Date(Date.now() + 30 * day).toISOString();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    tokenHash(token),
    userId,
    expires,
  );
  return { token, expires };
}
const day = 86_400_000;
export function sessionUser(db: DB, token: string | undefined) {
  if (!token) return null;
  return (
    (db
      .prepare(
        "SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
      )
      .get(tokenHash(token), new Date().toISOString()) as any) || null
  );
}
export function encrypt(value: unknown, secret: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      iv,
    );
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}
export function decrypt(value: string, secret: string): Record<string, string> {
  if (!value) return {};
  const [iv, tag, body] = value.split(".");
  if (!iv || !tag || !body) throw new Error("Invalid stored mail credentials.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    Buffer.from(iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(body, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  );
}
