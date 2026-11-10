import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface Config {
  dataDir: string;
  dbPath: string;
  appUrl: string;
  secret: string;
  production: boolean;
  port: number;
  registrationEnabled: boolean;
  cookieSecure: boolean;
  trustProxy: boolean;
  bootstrapEmail: string;
  bootstrapPassword: string;
  reminderIntervalMs: number;
  clientDir: string;
}
const bool = (value: string | undefined, fallback: boolean) =>
  value == null ? fallback : ["true", "1"].includes(value.toLowerCase());
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const dataDir = resolve(env.DATA_DIR || "./data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let secret = env.APP_SECRET || "";
  if (!secret && !production) {
    const file = join(dataDir, ".app-secret");
    if (existsSync(file)) secret = readFileSync(file, "utf8").trim();
    else {
      secret = randomBytes(32).toString("base64url");
      writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  if (
    secret.length < 32 ||
    /replace|change[-_ ]?me|your[-_ ]?secret/i.test(secret)
  )
    throw new Error(
      "APP_SECRET must be a unique secret of at least 32 characters.",
    );
  if (production && !env.APP_URL)
    throw new Error("APP_URL is required in production.");
  const url = new URL(env.APP_URL || "http://localhost:3000");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("APP_URL must be an HTTP(S) origin without a path.");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const interval = Number(env.REMINDER_INTERVAL_MS || 900_000);
  return {
    dataDir,
    dbPath: join(dataDir, "renewly.sqlite"),
    appUrl: url.origin,
    secret,
    production,
    port,
    registrationEnabled: bool(env.ALLOW_REGISTRATION, true),
    cookieSecure: bool(env.COOKIE_SECURE, production),
    trustProxy: bool(env.TRUST_PROXY, false),
    bootstrapEmail: (env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase(),
    bootstrapPassword: env.BOOTSTRAP_ADMIN_PASSWORD || "",
    reminderIntervalMs: Number.isFinite(interval)
      ? Math.max(60_000, interval)
      : 900_000,
    clientDir: resolve(env.CLIENT_DIR || "dist/client"),
  };
}
