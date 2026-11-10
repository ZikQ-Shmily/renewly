export type Currency = "CNY" | "USD" | "EUR" | "GBP";
export interface User {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  currency: Currency;
  timeZone: string;
}
export interface AuthConfig {
  registrationEnabled: boolean;
  adminConfigured: boolean;
}
export interface SubscriptionInput {
  type: "cloud";
  name: string;
  vendor: string;
  website: string;
  currency: Currency;
  purchasePrice: number;
  renewalPrice: number;
  billingMonths: number;
  periodStart: string;
  nextRenewal: string;
  paidAmount: number;
  region: string;
  model: string;
  trafficMode: "limited" | "unlimited" | "unknown";
  trafficQuota: number | null;
  trafficUnit: "GB" | "TB";
  status: "active" | "paused" | "archived";
  notes: string;
  reminderDays: number[];
}
export interface Subscription extends SubscriptionInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  billingAnchorDay?: number;
}
export interface SubscriptionType {
  key: string;
  name: string;
  icon: string;
}
export interface Dashboard {
  currency: Currency;
  annualTotal: number;
  remainingValue: number;
  upcomingTotal: number;
  activeCount: number;
  dueCount: number;
  subscriptions: Subscription[];
  nextDue: Subscription[];
  rates: {
    date: string | null;
    fetchedAt: string | null;
    stale: boolean;
    available: boolean;
  };
  totalsPartial: boolean;
  unconvertedCurrencies: string[];
}
export interface NotificationSettings {
  recipientEmail: string;
  emailVerified: boolean;
  enabled: boolean;
  reminderDays: number[];
  timeZone: string;
  mailAvailable: boolean;
  verificationMessage?: string;
}
export interface MailSettings {
  enabled: boolean;
  transport: "smtp" | "resend";
  senderName: string;
  senderEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassConfigured: boolean;
  resendKeyConfigured: boolean;
}
export interface Delivery {
  id: string;
  subscriptionName?: string;
  daysBefore?: number;
  kind?: string;
  status: string;
  sentAt?: string;
  createdAt: string;
  error?: string;
}
