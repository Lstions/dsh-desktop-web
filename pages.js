/**
 * Server-rendered pages for the desktop bridge's password gate.
 *
 * These pages must render before any client bundle loads, because the response
 * they replace is what makes the browser request the application at all. Visually
 * they follow the host product's own dark/light palette; the CSS custom
 * properties (`--dsw-alias-*`) are not available this early, so the values
 * behind them are copied as literals rather than invented.
 *
 * All user-visible text lives in {@link STRINGS}, English and Chinese, chosen
 * per request from the browser's Accept-Language and the account's preference.
 *
 * @module dsh-desktop-web/pages
 */

/** Page strings. Adding one requires both languages. */
export const STRINGS = {
  en: {
    loginTitle: 'Sign in',
    loginSubtitle: 'This DeepSeek Harness requires a password.',
    setupTitle: 'Create your account',
    setupSubtitle: 'First run. Choose the username and password for this harness.',
    accountTitle: 'Security',
    accountSubtitle: 'Manage the password and two-factor authentication for this harness.',
    username: 'Username',
    password: 'Password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    totpCode: '6-digit code',
    totpCodeHint: 'From your authenticator app',
    signIn: 'Sign in',
    createAccount: 'Create account',
    save: 'Save',
    signOut: 'Sign out',
    usernameInvalid: 'Use 1-64 letters, digits, dots, dashes or underscores.',
    passwordsDoNotMatch: 'The two passwords do not match.',
    passwordTooShort: 'Use at least {min} characters.',
    wrongCredentials: 'Wrong username or password.',
    wrongTotp: 'Wrong or already-used code.',
    passwordChanged: 'Password changed. Every session was signed out; sign in again.',
    usernameChanged: 'Username updated.',
    lockedOut: 'Too many attempts. Try again in {minutes} minute(s).',
    tokenDisabled: 'The launch-token link is disabled on this bridge; sign in with your password.',
    bootstrapWarning: 'Anyone who can reach this page before you set a password becomes the owner. Set it now.',
    localOnly: 'Account creation is limited to this machine. Open the bridge on the host to finish setup.',
    needTotp: 'Two-factor authentication is enabled. Enter the code from your authenticator.',
    totpEnabled: 'Two-factor authentication is on.',
    totpDisabled: 'Two-factor authentication is off.',
    totpBegin: 'Enable two-factor authentication',
    totpConfirm: 'Confirm and enable',
    totpCancel: 'Cancel',
    totpDisable: 'Turn off two-factor',
    totpScanHint: 'Scan this code with your authenticator app, or enter the key below by hand.',
    totpSecretLabel: 'Setup key',
    currentPassword: 'Current password',
    setupRequired: 'Set up an account',
    back: 'Back',
    keyNote: 'Access key accepted. Set a password to stop using it.',
    notFound: 'Not found',
    methodNotAllowed: 'Method not allowed',
    serverError: 'The bridge could not complete that request.',
  },
  zh: {
    loginTitle: '登录',
    loginSubtitle: '此 DeepSeek Harness 需要密码。',
    setupTitle: '创建账户',
    setupSubtitle: '首次运行。请为这个 Harness 设置用户名与密码。',
    accountTitle: '安全',
    accountSubtitle: '管理这个 Harness 的密码与两步验证。',
    username: '用户名',
    password: '密码',
    newPassword: '新密码',
    confirmPassword: '确认新密码',
    totpCode: '6 位验证码',
    totpCodeHint: '来自你的验证器 App',
    signIn: '登录',
    createAccount: '创建账户',
    save: '保存',
    signOut: '退出登录',
    usernameInvalid: '请使用 1-64 位字母、数字、点、短横线或下划线。',
    passwordsDoNotMatch: '两次输入的密码不一致。',
    passwordTooShort: '至少 {min} 个字符。',
    wrongCredentials: '用户名或密码错误。',
    wrongTotp: '验证码错误或已使用。',
    passwordChanged: '密码已修改，所有会话已退出，请重新登录。',
    usernameChanged: '用户名已更新。',
    lockedOut: '尝试次数过多，请 {minutes} 分钟后再试。',
    tokenDisabled: '此桥接已停用启动令牌入口，请用密码登录。',
    bootstrapWarning: '在你设置密码之前，任何能访问此页面的人都会成为主人。请立即设置。',
    localOnly: '仅允许在本机创建账户。请在主机上打开此桥接完成设置。',
    needTotp: '已开启两步验证，请输入验证器中的验证码。',
    totpEnabled: '两步验证已开启。',
    totpDisabled: '两步验证已关闭。',
    totpBegin: '开启两步验证',
    totpConfirm: '确认开启',
    totpCancel: '取消',
    totpDisable: '关闭两步验证',
    totpScanHint: '用验证器 App 扫描此二维码，或手动输入下面的密钥。',
    totpSecretLabel: '设置密钥',
    currentPassword: '当前密码',
    setupRequired: '设置账户',
    back: '返回',
    keyNote: '访问密钥已通过。设置密码后即可不再使用密钥。',
    notFound: '未找到',
    methodNotAllowed: '方法不允许',
    serverError: '桥接无法完成该请求。',
  },
};

/**
 * Pick the string table for a locale.
 * @param locale - locale or Accept-Language text.
 * @returns the table, falling back to English.
 */
export function stringsFor(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en;
}

/** Interpolate `{name}` placeholders in one message. */
export function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (whole, key) => (key in params ? String(params[key]) : whole));
}

/** Escape text for both element content and quoted attributes. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The shared stylesheet.
 *
 * Mirrors the product's own tokens as literals and follows the OS light/dark
 * preference. A visible focus ring is included because this page sits in front
 * of every keyboard and screen-reader user.
 */
const STYLE = `
:root{
  color-scheme:dark;
  --bg:#151517;--panel:#2c2c2e;--panel-2:#353638;
  --text:#f9fafb;--muted:#cfd3d6;--border:#ffffff33;
  --accent:#f9fafb;--accent-text:#0f1115;--danger:#f25a5a;--ok:#22c55e;--ring:#f9fafb;
}
@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;
    --bg:#f7f7f8;--panel:#fff;--panel-2:#f5f6f7;
    --text:#0f1115;--muted:#61666b;--border:#00000029;
    --accent:#0f1115;--accent-text:#fff;--danger:#ec1313;--ok:#22c55e;--ring:#0f1115;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px}
.card.wide{max-width:560px}
h1{margin:0 0 6px;font-size:20px;font-weight:500;letter-spacing:-0.01em}
h2{margin:26px 0 4px;font-size:15px;font-weight:500}
.sub{margin:0 0 20px;color:var(--muted);font-size:13px}
label{display:block;margin:14px 0 6px;font-size:13px;color:var(--muted)}
input[type=text],input[type=password],input[type=tel]{width:100%;height:36px;padding:0 12px;border-radius:8px;
  font-size:14px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);font-family:inherit}
input:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 20%,transparent)}
button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button{margin-top:20px;width:100%;height:36px;padding:0 14px;border-radius:8px;border:1px solid transparent;
  background:var(--accent);color:var(--accent-text);font-size:14px;font-weight:500;font-family:inherit;cursor:pointer}
button:hover:not(:disabled){opacity:.88}
button:disabled{opacity:.45;cursor:default}
button.secondary{background:var(--panel-2);color:var(--text);border-color:var(--border)}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
.row{display:flex;gap:10px}
.row>button{margin-top:0}
.msg{margin:16px 0 0;padding:10px 12px;border-radius:8px;font-size:13px}
.msg.error{background:color-mix(in srgb,var(--danger) 14%,transparent);color:var(--danger)}
.msg.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.msg.note{background:var(--panel-2);color:var(--muted)}
.hint{margin:8px 0 0;font-size:12.5px;color:var(--muted)}
.qr{display:block;margin:12px 0 14px;border-radius:8px;background:#fff;padding:8px;width:220px;max-width:100%;height:auto}
.secret{display:block;margin:10px 0 0;padding:12px;border-radius:8px;background:var(--panel-2);
  border:1px solid var(--border);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;user-select:all}
.divider{height:1px;background:var(--border);margin:24px 0}
.status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
.dot.off{background:var(--muted)}
a{color:var(--text)}
@media (max-width:480px){
  input[type=text],input[type=password],input[type=tel]{font-size:16px}
}
`;

/**
 * Wrap body markup in a complete document.
 * @param options - `t`, `title`, `body`, and optional `wide`.
 */
function document({ t, title, body, wide = false }) {
  return `<!doctype html>
<html lang="${t === STRINGS.zh ? 'zh' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card${wide ? ' wide' : ''}">
${body}
</div>
</body>
</html>`;
}

/**
 * Render one message block, or nothing.
 * @param t - string table.
 * @param kind - `error`, `ok`, or `note`.
 * @param code - string key.
 * @param params - placeholder values.
 */
function message(t, kind, code, params) {
  if (!code) return '';
  const text = format(t[code] ?? code, params);
  // Errors must reach screen readers: the page reloads, so focus stays put.
  const role = kind === 'error' ? ' role="alert"' : '';
  return `<p class="msg ${kind}"${role}>${escapeHtml(text)}</p>`;
}

/**
 * The sign-in page.
 * @param options - `t`, `error`, `errorParams`, `needsTotp`, `username`,
 *   `notice`, and `showKeyHint`.
 */
export function renderLoginPage({ t, error, errorParams, needsTotp = false, username = '', notice }) {
  const body = `
<h1>${escapeHtml(t.loginTitle)}</h1>
<p class="sub">${escapeHtml(needsTotp ? t.needTotp : t.loginSubtitle)}</p>
${message(t, 'error', error, errorParams)}
${message(t, 'note', notice)}
<form method="POST" action="login" autocomplete="on">
  <label for="u">${escapeHtml(t.username)}</label>
  <input id="u" name="username" type="text" value="${escapeHtml(username)}" autocomplete="username" required${error ? '' : ' autofocus'}>
  <label for="p">${escapeHtml(t.password)}</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required${error ? ' autofocus' : ''}>
  ${needsTotp ? `
  <label for="c">${escapeHtml(t.totpCode)}</label>
  <input id="c" name="totp" type="tel" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
         autocomplete="one-time-code" placeholder="000000" required>
  <p class="hint">${escapeHtml(t.totpCodeHint)}</p>` : ''}
  <button type="submit">${escapeHtml(t.signIn)}</button>
</form>`;
  return document({ t, title: t.loginTitle, body });
}

/**
 * First-run account creation.
 * @param options - `t`, `error`, and `localOnly`.
 */
export function renderSetupPage({ t, error, localOnly = false }) {
  if (localOnly) {
    const body = `
<h1>${escapeHtml(t.setupTitle)}</h1>
<p class="sub">${escapeHtml(t.setupSubtitle)}</p>
${message(t, 'note', 'localOnly')}`;
    return document({ t, title: t.setupTitle, body });
  }
  const body = `
<h1>${escapeHtml(t.setupTitle)}</h1>
<p class="sub">${escapeHtml(t.setupSubtitle)}</p>
${message(t, 'note', 'bootstrapWarning')}
${message(t, 'error', error)}
<form method="POST" action="setup" autocomplete="on">
  <label for="u">${escapeHtml(t.username)}</label>
  <input id="u" name="username" type="text" autocomplete="username" required autofocus>
  <label for="p">${escapeHtml(t.newPassword)}</label>
  <input id="p" name="password" type="password" autocomplete="new-password" minlength="8" required>
  <label for="p2">${escapeHtml(t.confirmPassword)}</label>
  <input id="p2" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
  <button type="submit">${escapeHtml(t.createAccount)}</button>
</form>`;
  return document({ t, title: t.setupTitle, body });
}

/**
 * The account/security page.
 * @param options - current state plus optional messages.
 */
export function renderAccountPage({
  t,
  username = '',
  totpEnabled = false,
  totpAvailable = true,
  error,
  notice,
  keyNote = false,
  pendingTotp,
}) {
  const totpSection = (() => {
    if (pendingTotp) {
      return `
<h2>${escapeHtml(t.totpBegin)}</h2>
<p class="hint">${escapeHtml(t.totpScanHint)}</p>
<img class="qr" src="${escapeHtml(pendingTotp.qrDataUri)}" alt="" width="220" height="220">
<code class="secret">${escapeHtml(pendingTotp.secret)}</code>
<form method="POST" action="totp/confirm" autocomplete="off">
  <label for="c">${escapeHtml(t.totpCode)}</label>
  <input id="c" name="code" type="tel" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
         autocomplete="one-time-code" placeholder="000000" required autofocus>
  <div class="row" style="margin-top:20px">
    <button type="submit">${escapeHtml(t.totpConfirm)}</button>
    <button class="secondary" type="submit" formaction="totp/cancel" formnovalidate>${escapeHtml(t.totpCancel)}</button>
  </div>
</form>`;
    }
    if (!totpAvailable) return '';
    if (totpEnabled) {
      return `
<h2>${escapeHtml(t.accountTitle)}</h2>
<p class="status"><span class="dot"></span>${escapeHtml(t.totpEnabled)}</p>
<form method="POST" action="totp/disable" autocomplete="off">
  <label for="dc">${escapeHtml(t.totpCode)}</label>
  <input id="dc" name="code" type="tel" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
         autocomplete="one-time-code" placeholder="000000" required>
  <button class="danger" type="submit">${escapeHtml(t.totpDisable)}</button>
</form>`;
    }
    return `
<h2>${escapeHtml(t.accountTitle)}</h2>
<p class="status"><span class="dot off"></span>${escapeHtml(t.totpDisabled)}</p>
<form method="POST" action="totp/begin"><button class="secondary" type="submit">${escapeHtml(t.totpBegin)}</button></form>`;
  })();

  const body = `
<h1>${escapeHtml(t.accountTitle)}</h1>
<p class="sub">${escapeHtml(t.accountSubtitle)}</p>
${message(t, 'ok', notice)}
${message(t, 'note', keyNote ? 'keyNote' : undefined)}
${message(t, 'error', error)}
<form method="POST" action="account/username" autocomplete="off">
  <label for="u">${escapeHtml(t.username)}</label>
  <input id="u" name="username" type="text" value="${escapeHtml(username)}" autocomplete="username" required>
  <button class="secondary" type="submit">${escapeHtml(t.save)}</button>
</form>
<form method="POST" action="account/password" autocomplete="off">
  <label for="np">${escapeHtml(t.newPassword)}</label>
  <input id="np" name="password" type="password" autocomplete="new-password" minlength="8" required>
  <label for="np2">${escapeHtml(t.confirmPassword)}</label>
  <input id="np2" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
  <button class="secondary" type="submit">${escapeHtml(t.save)}</button>
</form>
<div class="divider"></div>
${totpSection}
<div class="divider"></div>
<form method="POST" action="logout">
  <button class="danger" type="submit">${escapeHtml(t.signOut)}</button>
</form>`;
  return document({ t, title: t.accountTitle, body, wide: true });
}

/**
 * A minimal, readable failure page.
 * @param options - `t`, `status`, and `message`.
 */
export function renderErrorPage({ t, status, message: text }) {
  const body = `
<h1>${escapeHtml(String(status))}</h1>
<p class="sub">${escapeHtml(text)}</p>
<form method="GET" action="login"><button class="secondary" type="submit">${escapeHtml(t.back)}</button></form>`;
  return document({ t, title: String(status), body });
}
