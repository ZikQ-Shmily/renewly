import test from "node:test";
import assert from "node:assert/strict";
import { registrationEmail, renewalReminderEmail, type RenewalReminderInput } from "../server/email-templates.js";

const reminder: RenewalReminderInput = {
  name: "香港主站服务器",
  vendor: "Example Cloud",
  price: "¥138.00",
  dueTime: "2026-11-15 17:13",
  timeZone: "Asia/Shanghai",
  when: "3天后到期",
  autoRenew: false,
  appUrl: "https://renewly.example.com",
};

test("registration email delivers a copyable six-digit code, expiry and a matching plain-text alternative", () => {
  const email = registrationEmail({ code: "012345" });
  assert.equal(email.subject, "续记 · 注册验证码");
  assert.match(email.html, />012345<\/span>/);
  assert.match(email.text, /验证码：012345\n10分钟内有效/);
  assert.match(email.html, /10 分钟内有效/);
  assert.match(email.text, /请勿向他人透露验证码/);
  assert.match(email.text, /如果不是你本人发起的注册请求，请忽略此邮件/);
  assert.match(email.text, /此邮件用于验证注册邮箱，不代表账户已创建/);
  const preheader = email.html.match(/<div[^>]*>(.*?)<\/div>/)?.[1];
  assert.ok(preheader);
  assert.equal(preheader.includes("012345"), false, "mailbox preview must not reveal the verification code");
  assert.equal(email.html.includes("<a "), false, "verification should stay focused on the code rather than an unrelated CTA");
});

test("registration rejects malformed or injectable codes instead of rendering an unsafe message", () => {
  for (const code of ["12345", "1234567", "12x456", "123 45", "１２３４５６", "<img>", "123456\n", " 123456"])
    assert.throws(() => registrationEmail({ code }), TypeError);
});

test("reminder preserves currency, exact minute/time zone, merchant and the manual renewal instructions in both alternatives", () => {
  const email = renewalReminderEmail(reminder);
  assert.equal(email.subject, "续记 · 香港主站服务器 3天后到期");
  assert.match(email.html, /订阅即将到期/);
  for (const value of [reminder.name, reminder.vendor, reminder.price, reminder.dueTime, reminder.timeZone]) {
    assert.ok(email.html.includes(value));
    assert.ok(email.text.includes(value));
  }
  assert.match(email.text, /续费时间：2026-11-15 17:13（Asia\/Shanghai）/);
  assert.match(email.text, /请前往商家完成续费，并在续记登记。/);
  assert.match(email.html, /href="https:\/\/renewly\.example\.com\/#overview"[^>]*>查看订阅 →<\/a>/);
  assert.match(email.html, /href="https:\/\/renewly\.example\.com\/#reminders"/);
  assert.equal(email.html.includes(">自动续费</strong>"), false);
});

test("automatic renewal gets the same expiry reminder but asks the user to confirm the merchant's charge", () => {
  const email = renewalReminderEmail({ ...reminder, autoRenew: true, when: "今天到期" });
  assert.match(email.subject, /今天到期$/);
  assert.match(email.html, /订阅今天到期/);
  assert.match(email.html, />自动续费<\/strong>/);
  assert.match(email.text, /已标记商家自动续费。请检查余额并确认商家扣款成功，再在续记登记。/);
  assert.match(email.html, /已标记商家自动续费。请检查余额并确认商家扣款成功，再在续记登记。/);
  assert.doesNotMatch(email.text, /已自动扣款|已自动续费|续费成功|服务已停止/);
  const due = renewalReminderEmail({ ...reminder, when: "已到续费时间" });
  assert.match(due.html, /class="rn-text rn-heading"[^>]*>已到订阅续费时间<\/td>/);
});

test("untrusted subscription fields are HTML-escaped, while subjects are kept to one line", () => {
  const unsafe = '<img src=x onerror="alert(1)"> & \'test\'';
  const email = renewalReminderEmail({ ...reminder, name: `${unsafe}\r\nInjected: value`, vendor: unsafe, price: unsafe, dueTime: unsafe, timeZone: unsafe, when: unsafe });
  assert.ok(email.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;"));
  assert.doesNotMatch(email.html, /<img\b|<script\b|<iframe\b/i);
  assert.doesNotMatch(email.subject, /[\r\n]/);
  assert.ok(email.text.includes(unsafe), "plain-text content remains literal data");
});

test("only an HTTP(S) application origin can be used for the email links", () => {
  for (const appUrl of ["javascript:alert(1)", "data:text/html,bad", "//evil.example", "/relative", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=secret", "https://example.com/#bad", "https://example.com/\n", "https://example.com/\"onmouseover=\"bad"])
    assert.throws(() => renewalReminderEmail({ ...reminder, appUrl }));
  const local = renewalReminderEmail({ ...reminder, appUrl: "http://localhost:3000/" });
  assert.match(local.html, /href="http:\/\/localhost:3000\/#reminders"/);
  assert.match(local.text, /查看订阅：http:\/\/localhost:3000\//);
});

test("both templates provide an image-free table layout and retain the light fallback when dark-mode CSS is ignored", () => {
  for (const email of [registrationEmail({ code: "654321" }), renewalReminderEmail(reminder)]) {
    assert.match(email.html, /<html lang="zh-CN">/);
    assert.match(email.html, /<table role="presentation"/);
    assert.match(email.html, /<meta name="color-scheme" content="light dark">/);
    assert.match(email.html, /@media \(prefers-color-scheme: dark\)/);
    assert.doesNotMatch(email.html, /<script\b|<img\b|<link\b|\bsrc=|url\(|@import|<form\b/i);
    const withoutStyles = email.html.replace(/<style>[\s\S]*?<\/style>/, "");
    assert.match(withoutStyles, /class="rn-panel" style="[^"]*background-color:#ffffff/);
    assert.match(withoutStyles, /class="rn-text rn-heading" style="[^"]*color:#243047/);
    assert.match(email.text, /此邮件由系统发送，请勿直接回复。/);
  }
});
