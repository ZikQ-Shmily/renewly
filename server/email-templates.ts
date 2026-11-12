export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);

const subjectText = (value: string) => value.replace(/[\r\n]+/g, " ");

function applicationOrigin(value: string) {
  if (/[\u0000-\u0020\u007f]/.test(value))
    throw new TypeError("Email application URL must be an HTTP(S) origin.");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) throw new TypeError("Email application URL must be an HTTP(S) origin.");
  return url.origin;
}

const font = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif';

function frame(options: { title: string; preheader: string; category: string; content: string; footer: string }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    table { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
    a { text-decoration: none; }
    @media (max-width: 530px) {
      .rn-outer { padding: 20px 12px !important; }
      .rn-inner { padding: 24px 20px !important; }
      .rn-footer { padding: 16px 20px !important; }
      .rn-heading { font-size: 22px !important; }
      .rn-summary { padding: 16px !important; }
      .rn-detail-column { display: block !important; width: 100% !important; }
      .rn-detail-second { padding-top: 14px !important; padding-left: 0 !important; }
      .rn-code { font-size: 32px !important; letter-spacing: 5px !important; padding-left: 5px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .rn-background { background-color: #0d1120 !important; }
      .rn-panel { background-color: #161e31 !important; border-color: #29334a !important; }
      .rn-text { color: #edf2ff !important; }
      .rn-secondary { color: #bcc8df !important; }
      .rn-muted { color: #8d9dbb !important; }
      .rn-brand, .rn-link, .rn-accent { color: #6e97f2 !important; }
      .rn-inset { background-color: #10182a !important; border-color: #29334a !important; }
      .rn-divider { border-color: #29334a !important; }
      .rn-soft { background-color: #202e48 !important; }
      .rn-button { background-color: #477ff3 !important; border-color: #477ff3 !important; color: #ffffff !important; }
    }
  </style>
</head>
<body class="rn-background" style="margin:0;padding:0;background-color:#f4f6fb;color:#243047;font-family:${font};-webkit-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(options.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="rn-background" style="width:100%;background-color:#f4f6fb;">
    <tr><td align="center" class="rn-outer" style="padding:40px 20px;">
      <!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="rn-panel" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #dfe5f0;border-radius:14px;overflow:hidden;">
        <tr><td height="4" style="height:4px;font-size:0;line-height:0;background-color:#477ff3;background-image:linear-gradient(110deg,#477ff3 0%,#9291dc 55%,#d99a7c 100%);">&nbsp;</td></tr>
        <tr><td class="rn-inner" style="padding:30px 32px 28px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
            <tr><td class="rn-brand" style="font-family:${font};font-size:18px;line-height:27px;font-weight:600;letter-spacing:-.35px;color:#3768e8;">续记 <span class="rn-muted" style="margin-left:6px;font-size:13px;font-weight:400;letter-spacing:0;color:#61718b;">Renewly</span></td></tr>
            <tr><td class="rn-accent" style="padding-top:28px;font-size:11px;line-height:19px;font-weight:500;color:#3768e8;letter-spacing:1.6px;">${escapeHtml(options.category)}</td></tr>
          </table>
          ${options.content}
        </td></tr>
        <tr><td class="rn-footer rn-muted rn-divider" style="padding:18px 32px 22px;border-top:1px solid #dfe5f0;font-size:11px;line-height:20px;color:#61718b;">${options.footer}</td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

export function registrationEmail({ code }: { code: string }): EmailContent {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new TypeError("Registration email requires a six-digit code.");
  const subject = "续记 · 注册验证码";
  return {
    subject,
    text: `验证你的注册邮箱\n\n欢迎使用续记 Renewly。请在注册页面输入以下验证码，完成邮箱验证。\n\n你的注册验证码：${code}\n10分钟内有效 · 仅可使用一次\n\n请勿向他人透露验证码。续记不会要求你通过邮件提供密码或验证码。\n如果不是你本人发起的注册请求，请忽略此邮件。\n\n此邮件用于验证注册邮箱，不代表账户已创建。\n续记 Renewly · 每一笔订阅，都心中有数。\n此邮件由系统发送，请勿直接回复。`,
    html: frame({
      title: subject,
      preheader: "完成邮箱验证，开启你的订阅管理空间。验证码10分钟内有效。",
      category: "VERIFY YOUR EMAIL",
      content: `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
            <tr><td class="rn-text rn-heading" style="padding-top:8px;font-size:24px;line-height:35px;font-weight:600;letter-spacing:-.4px;color:#243047;">验证你的注册邮箱</td></tr>
            <tr><td class="rn-secondary" style="padding-top:12px;font-size:14px;line-height:23px;color:#52627d;">欢迎使用续记 Renewly。请在注册页面输入以下验证码，完成邮箱验证。</td></tr>
            <tr><td style="padding:24px 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="rn-inset" style="width:100%;background-color:#f8fafd;border:1px solid #dfe5f0;border-radius:10px;">
                <tr><td align="center" class="rn-muted" style="padding:22px 20px 9px;font-size:12px;line-height:20px;color:#61718b;">你的注册验证码</td></tr>
                <tr><td align="center" class="rn-accent" style="padding:0 20px;color:#3768e8;"><span class="rn-code" style="padding-left:7px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;line-height:50px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:7px;">${code}</span></td></tr>
                <tr><td align="center" class="rn-secondary" style="padding:10px 20px 22px;font-size:12px;line-height:20px;color:#52627d;">10 分钟内有效 · 仅可使用一次</td></tr>
              </table>
            </td></tr>
            <tr><td class="rn-secondary" style="font-size:13px;line-height:22px;color:#52627d;">请勿向他人透露验证码。续记不会要求你通过邮件提供密码或验证码。</td></tr>
            <tr><td class="rn-muted" style="padding-top:10px;font-size:12px;line-height:20px;color:#61718b;">如果不是你本人发起的注册请求，请忽略此邮件。</td></tr>
          </table>`,
      footer: `此邮件用于验证注册邮箱，不代表账户已创建。<br><br>续记 Renewly · 每一笔订阅，都心中有数。<br>此邮件由系统发送，请勿直接回复。`,
    }),
  };
}

export interface RenewalReminderInput {
  name: string;
  vendor: string;
  price: string;
  dueTime: string;
  timeZone: string;
  when: string;
  autoRenew: boolean;
  appUrl: string;
}

export function renewalReminderEmail(input: RenewalReminderInput): EmailContent {
  const origin = applicationOrigin(input.appUrl);
  const subject = `续记 · ${subjectText(input.name)} ${subjectText(input.when)}`;
  const headline = input.when === "已到续费时间"
    ? "已到订阅续费时间"
    : input.when === "今天到期" ? "你的订阅今天到期" : "你的订阅即将到期";
  const days = input.when.match(/^(\d+)天后到期$/)?.[1];
  const lead = input.when === "已到续费时间"
    ? "已到你记录的续费时间，请确认商家账单与续费状态。"
    : input.when === "今天到期"
      ? "请留意今天的续费时间，并确认商家的续费安排。"
      : days ? `距离续费还有 ${days} 天，提前安排，让每一笔订阅都心中有数。` : "请确认下方订阅的续费安排。";
  const instruction = input.autoRenew
    ? "此订阅已标记商家自动续费。请检查余额并确认商家扣款成功，再在续记登记。"
    : "请前往商家完成续费，并在续记登记。";
  const dueTime = `${input.dueTime}（${input.timeZone}）`;
  return {
    subject,
    text: `${input.name} ${input.when}。\n商家：${input.vendor}\n续费时间：${dueTime}\n续费价格：${input.price}\n${input.autoRenew ? "自动续费\n" : ""}${instruction}\n\n查看订阅：${origin}/#overview\n以商家实际账单与续费状态为准。\n\n你收到此邮件，是因为已在续记开启订阅到期提醒。\n管理提醒设置：${origin}/#reminders\n此邮件由系统发送，请勿直接回复。`,
    html: frame({
      title: subject,
      preheader: `${input.name} ${input.when}，续费价格 ${input.price}。`,
      category: "RENEWAL REMINDER",
      content: `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
            <tr><td class="rn-text rn-heading" style="padding-top:8px;font-size:24px;line-height:35px;font-weight:600;letter-spacing:-.4px;color:#243047;">${headline}</td></tr>
            <tr><td class="rn-secondary" style="padding-top:12px;font-size:14px;line-height:23px;color:#52627d;">${escapeHtml(lead)}</td></tr>
            <tr><td style="padding-top:24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="rn-inset" style="width:100%;background-color:#f8fafd;border:1px solid #dfe5f0;border-radius:10px;">
                <tr><td class="rn-summary" style="padding:20px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;">
                    <tr><td class="rn-text" style="font-size:16px;line-height:26px;font-weight:500;color:#243047;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(input.name)}</td></tr>
                    <tr><td class="rn-muted rn-divider" style="padding:4px 0 16px;border-bottom:1px solid #dfe5f0;font-size:12px;line-height:20px;color:#61718b;overflow-wrap:anywhere;word-break:break-word;">商家 · ${escapeHtml(input.vendor)}</td></tr>
                    <tr><td style="padding-top:17px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;">
                        <tr>
                          <td valign="top" width="50%" class="rn-detail-column" style="width:50%;">
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;">
                              <tr><td class="rn-muted" style="padding-bottom:5px;font-size:12px;line-height:20px;color:#61718b;">续费价格</td></tr>
                              <tr><td class="rn-text" style="font-size:25px;line-height:36px;font-weight:600;letter-spacing:-.5px;font-variant-numeric:tabular-nums;color:#243047;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(input.price)}</td></tr>
                            </table>
                          </td>
                          <td valign="top" width="50%" class="rn-detail-column rn-detail-second" style="width:50%;padding-left:18px;">
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;table-layout:fixed;">
                              <tr><td class="rn-muted" style="padding-bottom:5px;font-size:12px;line-height:20px;color:#61718b;">续费时间</td></tr>
                              <tr><td class="rn-text" style="font-size:14px;line-height:25px;font-weight:500;font-variant-numeric:tabular-nums;color:#243047;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(input.dueTime)}</td></tr>
                              <tr><td class="rn-muted" style="font-size:11px;line-height:19px;color:#61718b;overflow-wrap:anywhere;word-break:break-word;">时区 · ${escapeHtml(input.timeZone)}</td></tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>
                </td></tr>
              </table>
            </td></tr>
            <tr><td style="padding-top:22px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="rn-soft" style="width:100%;background-color:#edf3ff;border-radius:8px;">
                <tr><td class="rn-secondary" style="padding:12px 14px;font-size:13px;line-height:22px;color:#52627d;">${input.autoRenew ? '<strong class="rn-accent" style="display:block;margin-bottom:4px;font-weight:500;color:#3768e8;">自动续费</strong>' : ""}${escapeHtml(instruction)}</td></tr>
              </table>
            </td></tr>
            <tr><td style="padding-top:22px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr><td align="center" bgcolor="#3768e8" class="rn-button" style="background-color:#3768e8;border:1px solid #3768e8;border-radius:8px;mso-padding-alt:11px 23px;"><a href="${escapeHtml(`${origin}/#overview`)}" class="rn-button" style="display:inline-block;padding:11px 23px;border:1px solid #3768e8;border-radius:8px;background-color:#3768e8;font-size:14px;line-height:23px;font-weight:500;color:#ffffff;text-decoration:none;mso-padding-alt:0;">查看订阅 →</a></td></tr>
              </table>
            </td></tr>
            <tr><td class="rn-muted" style="padding-top:12px;font-size:12px;line-height:20px;color:#61718b;">以商家实际账单与续费状态为准。</td></tr>
          </table>`,
      footer: `你收到此邮件，是因为已在续记开启订阅到期提醒。<br><a href="${escapeHtml(`${origin}/#reminders`)}" class="rn-link" style="color:#3768e8;text-decoration:none;">管理提醒设置</a> · 此邮件由系统发送，请勿直接回复。`,
    }),
  };
}
