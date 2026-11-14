/**
 * The browser half: the Security page inside the Harness settings dialog.
 *
 * This is a dynamic Client plugin. The Host's module loader executes it as
 * `window.__ModuleLoader__.load({ id, factory })`, and `factory` receives a
 * `require` that resolves platform modules from the shared table — React comes
 * from there, so nothing is bundled and no second React is installed.
 *
 * Structure follows `dsh-web-password-auth`: {@link SecuritySection} owns state
 * and requests, while {@link SecurityView} is a pure renderer. Keeping the view
 * pure is what lets a missing translation key or a throwing branch be caught by
 * a render test before it ships as a blank panel.
 *
 * Two surfaces mount the same component — Settings → Security, and this
 * plugin's own page under Plugins — so there is one copy of the logic. The
 * detail-page entry renders `null` for every subject that is not this plugin,
 * which is that slot's contract.
 *
 * Presentation uses the `--dsw-alias-*` theme tokens, so it follows the active
 * theme instead of hard-coding colours.
 */

window.__ModuleLoader__.load({
  // Must equal the package name: the loader keys factories by the id a bundle
  // registers, and the Host's roster keys the same bundle by its package name.
  // A mismatch registers one bundle under two ids and fails boot with
  // "duplicate factory registration".
  id: 'dsh-desktop-web',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    // ── styles ────────────────────────────────────────────────────────────
    // The stylesheet must be created as an UNTAGGED `<style>`. The Host's client
    // loader claims untagged styles created while a bundle factory runs and
    // re-hosts them into the rendering root; a style that already carries
    // `data-plugin` is excluded by that claim (`style:not([data-plugin])`) and
    // stays in `document.head`, where it does nothing.
    //
    // This cost a whole debugging round: the panel rendered with no styling at
    // all while the CSS looked correct.
    //
    // Layout rules that took a second round to get right:
    // - Address rows are a grid `minmax(0,1fr) auto`, never a flex row with a
    //   `width:100%` input: that combination pushes the remove button onto its
    //   own line, which is what the first version looked like.
    // - Only the 14 theme variables the Host actually provides may be used.
    //   Invented names (`--dsw-alias-border-l4`, `bg-layer-3`, `label-tertiary`)
    //   silently resolve to nothing, so borders and surfaces disappear and the
    //   result reads as "unstyled" rather than "wrong colour".
    const CSS = [
      // page + surfaces
      '.dw_page{display:flex;flex-direction:column;gap:16px;max-width:640px;padding:2px 0 8px}',
      '.dw_panel{display:flex;flex-direction:column;gap:32px;max-width:640px;margin:0 auto}',
      '.dw_card{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'border-radius:12px;overflow:hidden}',
      '.dw_cardHead{padding:14px 16px 0;display:flex;flex-direction:column;gap:4px}',
      '.dw_cardBody{padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px}',
      '.dw_cardFoot{display:flex;align-items:center;justify-content:flex-end;gap:12px;',
      'padding:10px 16px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      // type
      '.dw_title{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:22px;',
      'color:var(--dsw-alias-label-primary)}',
      '.dw_desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dw_help{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);opacity:.85}',
      // fields
      '.dw_group{display:flex;flex-direction:column;gap:8px}',
      '.dw_groupLabel{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dw_field{display:flex;flex-direction:column;gap:6px}',
      '.dw_label{font-size:12px;font-weight:500;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dw_fieldGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.dw_input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border-radius:8px;',
      'border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;transition:border-color .12s ease}',
      '.dw_input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.6}',
      '.dw_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dw_input:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);',
      'cursor:not-allowed}',
      '.dw_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      // address rows: grid so the remove button never wraps below the input
      '.dw_addrList{display:flex;flex-direction:column;gap:8px}',
      '.dw_addrRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}',
      '.dw_removeBtn{width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;',
      'border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}',
      '.dw_removeBtn:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-alias-state-error-primary)}',
      '.dw_removeBtn:disabled{opacity:.45;cursor:not-allowed}',
      // read-only readout: a labelled surface for what is actually bound, with
      // one chip per address carrying a small "listening" dot.
      '.dw_readout{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0;',
      'padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.dw_readoutLabel{flex:none;font-size:12px;font-weight:600;line-height:18px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dw_chips{display:flex;flex-wrap:wrap;gap:8px;min-width:0}',
      '.dw_chip{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:3px 9px;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:16px;',
      'overflow-wrap:anywhere}',
      '.dw_chip::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;',
      'background:var(--dsw-alias-state-success-primary)}',
      // interface picker: one selectable row per NIC, showing its current IPs
      '.dw_nicList{display:flex;flex-direction:column;gap:2px}',
      '.dw_nicRow{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start;',
      'padding:8px 9px;border-radius:8px;cursor:pointer}',
      '.dw_nicRow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dw_nicRow input[type=checkbox]{width:16px;height:16px;margin:2px 0 0;flex:none;cursor:pointer;',
      'accent-color:var(--dsw-alias-brand-primary)}',
      '.dw_nicRow input[type=checkbox]:disabled{cursor:not-allowed;opacity:.5}',
      '.dw_nicText{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dw_nicName{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;',
      'color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.dw_badge{flex:none;padding:0 6px;border-radius:5px;font-size:11px;line-height:16px;font-weight:400;',
      'background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);',
      'color:var(--dsw-alias-label-secondary)}',
      '.dw_nicIps{display:flex;flex-wrap:wrap;gap:6px}',
      '.dw_ip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;',
      'line-height:16px;padding:2px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);',
      'border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.dw_fieldNarrow{max-width:180px}',
      // toggles: label left, control right
      '.dw_toggleRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}',
      '.dw_toggleText{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dw_toggleTitle{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dw_toggleRow input[type=checkbox]{width:16px;height:16px;margin:0;flex:none;cursor:pointer;',
      'accent-color:var(--dsw-alias-brand-primary)}',
      '.dw_toggleRow input[type=checkbox]:disabled{cursor:not-allowed;opacity:.5}',
      // buttons
      '.dw_button{height:32px;padding:0 13px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;',
      'border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);white-space:nowrap;transition:border-color .12s ease,opacity .12s ease}',
      '.dw_button:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}',
      '.dw_button:disabled{opacity:.42;cursor:not-allowed}',
      '.dw_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);',
      'color:#fff;font-weight:500}',
      '.dw_primary:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);opacity:.92}',
      '.dw_danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);',
      'background:transparent}',
      '.dw_danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary)}',
      '.dw_quiet{background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.dw_actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
      // focus ring: keyboard only
      '.dw_input:focus-visible,.dw_button:focus-visible,.dw_removeBtn:focus-visible{',
      'outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      // notices
      '.dw_note{margin:0;font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;',
      'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.dw_noteError{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dw_noteOk{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}',
      // status + misc
      '.dw_status{display:inline-flex;align-items:center;gap:6px;font-size:12px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dw_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}',
      '.dw_dotOff{background:var(--dsw-alias-state-idle-primary)}',
      '.dw_qr{display:block;width:200px;max-width:100%;height:auto;margin:2px 0;border-radius:8px;',
      'background:#fff;padding:8px;box-sizing:border-box}',
      '.dw_secret{display:block;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);',
      'border:.5px solid var(--dsw-alias-border-l1);',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;',
      'word-break:break-all;user-select:all;color:var(--dsw-alias-label-primary)}',
      '.dw_uri{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);',
      'word-break:break-all;opacity:.85}',
      '.dw_detail{padding-top:4px}',
      '@keyframes dwSpin{to{transform:rotate(360deg)}}',
      '.dw_spinner{width:15px;height:15px;border-radius:50%;flex:none;',
      'border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);',
      'animation:dwSpin .8s linear infinite}',
      '.dw_loading{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;',
      'color:var(--dsw-alias-label-secondary)}',
      // narrow panels: collapse the multi-column grids first
      '@media (max-width:420px){.dw_fieldGrid{grid-template-columns:1fr}',
      '.dw_cardHead{padding:12px 12px 0}.dw_cardBody{padding:12px}',
      '.dw_cardFoot{padding:10px 12px}}',
    ].join('');


    // The stylesheet must be created as an UNTAGGED `<style>`. The Host's client
    // loader claims untagged styles created while a bundle factory runs and
    // re-hosts them into the rendering root; a style that already carries
    // `data-plugin` is excluded by that claim (`style:not([data-plugin])`) and
    // stays in `document.head`, where it does nothing.
    //
    // This cost a whole debugging round: the panel rendered with no styling at
    // all while the CSS looked correct.
    const CSS_TAG = 'dsh-desktop-web/panel.css';

    // A dynamic Client half can own a stylesheet in two ways:
    //   * `styles.insert(css)` — the sandboxed form, cleaned up with the run;
    //   * a plain <style> in `document.head` — the ordinary bundle form.
    // Neither is guaranteed: the sandbox exposes no `window`/`document`, and
    // `document.head` can be null while the parser is still building it. Losing
    // the stylesheet must only cost the panel its looks, never the module
    // import — an exception here is reported by the Host as
    // "import failed", which hides the real cause completely.
    try {
      if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') {
        styles.insert(CSS);
      } else if (typeof document !== 'undefined' && document.head !== null && document.head !== undefined) {
        // Drop a previous copy so a reloaded bundle cannot stack stylesheets.
        for (const stale of document.querySelectorAll(`style[data-plugin-css="${CSS_TAG}"]`)) {
          stale.remove();
        }
        const tag = document.createElement('style');
        // A marker only; `data-plugin` stays unset so the Host's loader claims it.
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    } catch (failure) {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('desktop-web: could not apply the stylesheet', failure);
      }
    }

    // ── strings ───────────────────────────────────────────────────────────

    /** Dictionary namespace for the locale service. */
    const NS = 'desktop-web';

    const ZH = {
      nav: '安全',
      heading: '登录与安全',
      intro: '此桥接用用户名和密码登录。密码只保护浏览器访问，桌面窗口本身不受影响。',
      account: '账户',
      signedInAs: '当前登录：{username}',
      sessionNote: '会话有效期 {days} 天，之后需要重新登录。',
      setupTitle: '创建密码账户',
      setupIntro: '创建用户名和密码后，即可在手机或另一台电脑上用浏览器访问这个桌面版。',
      createAccount: '创建账户',
      accountExists: '账户已存在。',
      createdAccount: '账户已创建。',
      noAccount: '尚未创建账户。',
      usernameLabel: '用户名',
      changeUsername: '保存用户名',
      usernameHint: '显示在登录页，也用作验证器里的条目名。',
      usernameInvalid: '请使用 1-64 位字母、数字、点、短横线或下划线。',
      usernameChanged: '用户名已修改。',
      scanHint: '用验证器 App 扫描，或手动输入密钥。',
      changePassword: '修改密码',
      newPassword: '新密码',
      confirmPassword: '确认新密码',
      save: '保存',
      twoFactor: '两步验证',
      twoFactorOn: '两步验证已开启',
      twoFactorOff: '两步验证已关闭',
      twoFactorIntro: '开启后，每次密码登录还需要输入验证器 App 里的 6 位验证码。',
      enable: '开启',
      disable: '关闭',
      confirmCode: '6 位验证码',
      setupHint: '把这个密钥加到验证器 App，然后输入当前验证码确认。',
      secret: '密钥',
      cancel: '取消',
      confirm: '确认',
      signOut: '退出登录',
      signOutHint: '退出会立即让当前会话失效，下次访问需要重新登录。',
      signedOut: '已退出登录。浏览器访问需要重新输入密码。',
      passwordTooShort: '密码至少 {min} 个字符。',
      passwordChanged: '密码已修改。浏览器访问需要用新密码重新登录。',
      passwordsDoNotMatch: '两次输入的密码不一致。',
      wrongTotp: '验证码错误或已使用。',
      totpEnabled: '两步验证已开启。',
      totpDisabled: '两步验证已关闭。',
      loading: '读取中…',
      saveFailed: '保存失败，请重试。',
      loadFailed: '读取状态失败。',
      retry: '重试',
      bridge: '桥接设置',
      bridgeIntro: '浏览器用这些地址访问这个桌面应用。保存后立即生效：配置写入 profile，并重新绑定监听。',
      bridgeUnavailable: '当前 profile 不允许写入配置，只能查看。',
      listenLabel: '监听地址',
      listenHint: '形如 192.168.1.10:8091，或 [::1]:8091。不要用 0.0.0.0，Host 会拒绝通配绑定。',
      addAddress: '添加地址',
      removeAddress: '删除',
      effectiveLabel: '正在监听',
      effectiveNone: '尚未绑定任何地址',
      sessionDaysLabel: '会话有效期（天）',
      maxAttemptsLabel: '失败次数上限',
      lockoutMsLabel: '锁定时长（毫秒）',
      minPasswordLabel: '最小密码长度',
      bootstrapLabel: '只允许本机创建账户',
      totpAvailableLabel: '允许开启两步验证',
      issuerLabel: '验证器显示名',
      accessKeyLabel: '桥接访问密钥',
      accessKeyHint: '留空则每次启动随机生成，带密钥的 URL 写在 ~/.dsh/desktop-web.url。',
      interfacesLabel: '网卡',
      interfacesHint: '勾选要监听的网卡。地址会在每次启动时按网卡读取，IP 变了也不会失效。',
      refreshInterfaces: '刷新网卡',
      noInterfaces: '没有找到带 IPv4 地址的网卡。',
      loopbackBadge: '回环',
      portLabel: '端口',
      listenLegacyLabel: '手动指定地址（高级）',
      listenLegacyHint: '固定 IP，地址变化后会失效。已勾选网卡时这里会被忽略。',
      deriveFromListen: '从手动地址生成网卡选择',
      deriveFailed: '有地址不属于任何当前网卡，无法自动转换。',
      bindEmpty: '至少选择一个网卡，或保留一条手动地址。',
      interfaceInvalid: '网卡名不合法。',
      saveConfig: '保存配置',
      configSaved: '配置已保存。',
      addressInvalid: '地址格式不对，需要 主机:端口。',
      addressEmpty: '地址不能为空。',
      addressNeedsHost: '请写完整的主机:端口，不要只写端口。',
      addressWildcard: '不能用 0.0.0.0 或 [::]，请写具体网卡地址。',
      portInvalid: '端口必须在 1-65535 之间。',
      listenEmpty: '至少要有一个监听地址。',
      accessKeyTooShort: '访问密钥至少 16 个字符，或留空自动生成。',
      numberOutOfRange: '数值超出允许范围。',
      issuerInvalid: '验证器显示名不能为空，且不超过 64 个字符。',
      configNotEditable: '当前 profile 不允许写入配置。',
      configWriteFailed: '写入配置失败。',
    };

    const EN = {
      nav: 'Security',
      heading: 'Sign-in and security',
      intro: 'This bridge signs in with a username and password. The password guards browser access only; the desktop window itself is unaffected.',
      account: 'Account',
      signedInAs: 'Signed in as {username}',
      sessionNote: 'Sessions last {days} days, then you sign in again.',
      setupTitle: 'Create a password account',
      setupIntro: 'Once a username and password exist, you can reach this desktop app from a phone or another computer.',
      createAccount: 'Create account',
      accountExists: 'An account already exists.',
      createdAccount: 'Account created.',
      noAccount: 'No account has been created yet.',
      usernameLabel: 'Username',
      changeUsername: 'Save username',
      usernameHint: 'Shown on the sign-in screen and as your authenticator entry.',
      usernameInvalid: 'Use 1-64 letters, digits, dots, dashes or underscores.',
      usernameChanged: 'Username changed.',
      scanHint: 'Scan this, or enter the key manually.',
      changePassword: 'Change password',
      newPassword: 'New password',
      confirmPassword: 'Confirm new password',
      save: 'Save',
      twoFactor: 'Two-factor authentication',
      twoFactorOn: 'Two-factor authentication is on',
      twoFactorOff: 'Two-factor authentication is off',
      twoFactorIntro: 'When on, every password sign-in also asks for the 6-digit code from your authenticator app.',
      enable: 'Turn on',
      disable: 'Turn off',
      confirmCode: '6-digit code',
      setupHint: 'Add this secret to your authenticator app, then enter the current code to confirm.',
      secret: 'Secret key',
      cancel: 'Cancel',
      confirm: 'Confirm',
      signOut: 'Sign out',
      signOutHint: 'Signing out revokes this session immediately; the next visit asks for the password again.',
      signedOut: 'Signed out. Browser access now needs the password again.',
      passwordTooShort: 'Use at least {min} characters.',
      passwordChanged: 'Password changed. Browser access now needs the new password.',
      passwordsDoNotMatch: 'The two passwords do not match.',
      wrongTotp: 'Wrong or already-used code.',
      totpEnabled: 'Two-factor authentication is on.',
      totpDisabled: 'Two-factor authentication is off.',
      loading: 'Loading…',
      saveFailed: 'Could not save. Try again.',
      loadFailed: 'Could not read the current state.',
      retry: 'Retry',
      bridge: 'Bridge',
      bridgeIntro: 'Browsers reach this desktop app at these addresses. Saves apply immediately: the profile is updated and the listeners rebind.',
      bridgeUnavailable: 'This profile does not allow configuration writes, so the values are read-only.',
      listenLabel: 'Listen addresses',
      listenHint: 'Like 192.168.1.10:8091, or [::1]:8091. Do not use 0.0.0.0 — the Host refuses wildcard binds.',
      addAddress: 'Add address',
      removeAddress: 'Remove',
      effectiveLabel: 'Listening now',
      effectiveNone: 'Nothing bound yet',
      sessionDaysLabel: 'Session lifetime (days)',
      maxAttemptsLabel: 'Failures before lockout',
      lockoutMsLabel: 'Lockout (ms)',
      minPasswordLabel: 'Minimum password length',
      bootstrapLabel: 'Only this machine may create the account',
      totpAvailableLabel: 'Allow two-factor enrolment',
      issuerLabel: 'Authenticator display name',
      accessKeyLabel: 'Bridge access key',
      accessKeyHint: 'Leave empty to generate one per launch; the keyed URLs are written to ~/.dsh/desktop-web.url.',
      interfacesLabel: 'Network interfaces',
      interfacesHint: 'Pick the interfaces to serve. The address is read from the interface at every launch, so a changed IP keeps working.',
      refreshInterfaces: 'Refresh interfaces',
      noInterfaces: 'No interface with an IPv4 address was found.',
      loopbackBadge: 'Loopback',
      portLabel: 'Port',
      listenLegacyLabel: 'Explicit addresses (advanced)',
      listenLegacyHint: 'Fixed IPs; these break when the address changes. They are ignored while interfaces are selected.',
      deriveFromListen: 'Derive interfaces from explicit addresses',
      deriveFailed: 'Some addresses belong to no current interface, so they cannot be derived.',
      bindEmpty: 'Select at least one interface, or keep one explicit address.',
      interfaceInvalid: 'That interface name is not valid.',
      saveConfig: 'Save configuration',
      configSaved: 'Configuration saved.',
      addressInvalid: 'That address is not valid; use host:port.',
      addressEmpty: 'Addresses cannot be empty.',
      addressNeedsHost: 'Write the whole host:port, not just the port.',
      addressWildcard: 'Use a concrete interface address, not 0.0.0.0 or [::].',
      portInvalid: 'The port must be between 1 and 65535.',
      listenEmpty: 'Keep at least one listen address.',
      accessKeyTooShort: 'Use at least 16 characters, or leave it empty to generate one.',
      numberOutOfRange: 'That number is outside the allowed range.',
      issuerInvalid: 'The display name cannot be empty and must stay within 64 characters.',
      configNotEditable: 'This profile does not allow configuration writes.',
      configWriteFailed: 'Could not write the configuration.',
    };

    /**
     * Wrap the locale binding as a translator.
     *
     * `t` is a function `t(key, params)`, not a dictionary object. Property
     * access therefore yields undefined and would blank the panel, so every
     * lookup goes through the call, falling back to the key itself.
     * @param source - locale binding function, or a dictionary in tests.
     * @returns a translator.
     */
    const translator = (source) => (key, params) => {
      let text;
      if (typeof source === 'function') text = source(key, params);
      else if (source !== undefined && source !== null) text = source[key];
      if (typeof text !== 'string' || text === '') text = key;
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/g, (whole, name) => (
        params[name] === undefined ? whole : String(params[name])));
    };

    // ── data access ───────────────────────────────────────────────────────

    /** Endpoint prefix, served by this plugin's own gate. */
    const BASE = 'desktop-web';

    /**
     * Whether this page can reach the bridge's sign-in page.
     *
     * The panel runs in two places. Over the bridge listener the page sits at
     * the gate's root, where `/login` exists and a session expiry should send
     * the browser there. Inside the desktop window the page is served from the
     * app protocol, where no `/login` exists — redirecting would land on a 404,
     * so those flows report inline instead.
     */
    const canRedirectToSignIn = () => {
      try {
        // The gate serves the shell at its own root; the app protocol cannot.
        return window.location.protocol === 'http:' || window.location.protocol === 'https:';
      } catch {
        return false;
      }
    };

    /** Send the browser to the sign-in page when that page exists. */
    const goToSignIn = (query) => {
      if (canRedirectToSignIn()) window.location.replace(`login${query ?? ''}`);
    };

    /**
     * Call one JSON endpoint.
     * @param path - endpoint, relative to {@link BASE}.
     * @param options - fetch options.
     * @returns the status code and the parsed body.
     */
    const call = async (path, options) => {
      const response = await fetch(BASE + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...options,
      });
      let body = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      return { status: response.status, ...body };
    };

    // ── pure view ─────────────────────────────────────────────────────────

    /**
     * One card with a heading and, optionally, an explanatory line.
     * @param {string} title - localized heading.
     * @param {string|undefined} description - localized sub-line.
     * @param {Array} children - card body nodes.
     * @param {Array} [footer] - footer nodes, when the card ends in one action.
     */
    function card(el, title, description, children, footer) {
      return el('section', { className: 'dw_card' },
        el('div', { className: 'dw_cardHead' },
          el('h2', { className: 'dw_title' }, title),
          description === undefined ? null : el('p', { className: 'dw_desc' }, description)),
        el('div', { className: 'dw_cardBody' }, ...children),
        footer === undefined || footer.length === 0
          ? null
          : el('div', { className: 'dw_cardFoot' }, ...footer));
    }

    /** A labelled text or password field. */
    function field(el, options) {
      const { id, label, type, value, onChange, disabled, hint, mono } = options;
      return el('div', { className: 'dw_field' },
        el('label', { className: 'dw_label', htmlFor: id }, label),
        el('input', {
          id,
          className: mono === true ? 'dw_input dw_mono' : 'dw_input',
          type,
          value,
          disabled,
          onChange,
          autoComplete: type === 'password' ? 'new-password' : 'off',
        }),
        hint === undefined ? null : el('p', { className: 'dw_help' }, hint));
    }

    /** The inline result line: success or failure. */
    function noticeLine(el, error, notice) {
      if (error !== undefined) return el('p', { className: 'dw_note dw_noteError', role: 'alert' }, error);
      if (notice !== undefined) return el('p', { className: 'dw_note dw_noteOk', role: 'status' }, notice);
      return null;
    }

    /**
     * Render the Security page. Pure: it reads props and calls callbacks only.
     * @param props - view input.
     * @returns a React element.
     */
    function SecurityView(props) {
      const { tr, phase, busy, error, notice, form, pending, actions } = props;
      const status = props.status ?? {};
      const el = react.createElement;

      if (phase === 'loading') {
        return el('div', { className: 'dw_page' },
          el('div', { className: 'dw_card' },
            el('div', { className: 'dw_cardBody' },
              el('div', { className: 'dw_loading', role: 'status' },
                el('span', { className: 'dw_spinner', 'aria-hidden': 'true' }),
                el('span', null, tr('loading'))))));
      }
      if (phase === 'failed') {
        return el('div', { className: 'dw_page' },
          el('div', { className: 'dw_card' },
            el('div', { className: 'dw_cardBody' },
              el('p', { className: 'dw_note dw_noteError', role: 'alert' }, tr('loadFailed')),
              el('div', { className: 'dw_actions' },
                el('button', { className: 'dw_button', onClick: actions.reload }, tr('retry'))))));
      }

      const hasAccount = status.hasAccount !== false;
      const totpEnabled = status.totpEnabled === true;
      const usernameDraft = form.username ?? status.username ?? '';

      // No account yet: the only useful action is creating one.
      if (!hasAccount) {
        return el('div', { className: 'dw_page' },
          card(el, tr('setupTitle'), tr('setupIntro'), [
            field(el, {
              id: 'dw-new-user', label: tr('usernameLabel'), type: 'text',
              value: usernameDraft, disabled: busy,
              onChange: (event) => actions.setUsername(event.target.value),
            }),
            field(el, {
              id: 'dw-new-pass', label: tr('newPassword'), type: 'password',
              value: form.password ?? '', disabled: busy,
              onChange: (event) => actions.setPassword(event.target.value),
            }),
            field(el, {
              id: 'dw-new-pass2', label: tr('confirmPassword'), type: 'password',
              value: form.confirm ?? '', disabled: busy,
              onChange: (event) => actions.setConfirm(event.target.value),
            }),
            noticeLine(el, error, notice),
          ], [
            el('button', {
              className: 'dw_button dw_primary', onClick: actions.submitSetup,
              disabled: busy || (form.password ?? '').length === 0,
            }, tr('createAccount')),
          ]));
      }

      /** The six-digit code input. */
      const codeInput = (id) => el('input', {
        id, className: 'dw_input dw_mono', inputMode: 'numeric', maxLength: 6, placeholder: '000000',
        value: form.code ?? '', disabled: busy,
        onChange: (event) => actions.setCode(String(event.target.value).replace(/\D/gu, '')),
      });

      const totpBody = pending === undefined
        ? (totpEnabled
          ? [
            el('div', { className: 'dw_field' },
              el('label', { className: 'dw_label', htmlFor: 'dw-code-off' }, tr('confirmCode')),
              codeInput('dw-code-off')),
            el('div', { className: 'dw_actions' },
              el('button', {
                className: 'dw_button dw_danger', onClick: actions.disableTotp,
                disabled: busy || (form.code ?? '').length !== 6,
              }, tr('disable'))),
          ]
          : [
            el('p', { className: 'dw_help' }, tr('twoFactorIntro')),
            el('div', { className: 'dw_actions' },
              el('button', { className: 'dw_button', onClick: actions.beginTotp, disabled: busy }, tr('enable'))),
          ])
        : [
          el('p', { className: 'dw_help' }, tr('setupHint')),
          pending.qrDataUri === undefined
            ? null
            : el('img', {
              className: 'dw_qr', src: pending.qrDataUri, alt: tr('setupHint'),
              width: 200, height: 200,
            }),
          el('p', { className: 'dw_help' }, tr('scanHint')),
          el('label', { className: 'dw_label' }, tr('secret')),
          el('code', { className: 'dw_secret' }, pending.secret),
          el('p', { className: 'dw_uri' }, pending.uri),
          el('div', { className: 'dw_field' },
            el('label', { className: 'dw_label', htmlFor: 'dw-code-on' }, tr('confirmCode')),
            codeInput('dw-code-on')),
          el('div', { className: 'dw_actions' },
            el('button', { className: 'dw_button dw_quiet', onClick: actions.cancelTotp, disabled: busy }, tr('cancel')),
            el('button', {
              className: 'dw_button dw_primary', onClick: actions.confirmTotp,
              disabled: busy || (form.code ?? '').length !== 6,
            }, tr('confirm'))),
        ];

      return el('div', { className: 'dw_page' },

        card(el, tr('account'), tr('signedInAs', { username: status.username ?? '' }), [
          el('p', { className: 'dw_help' }, tr('sessionNote', { days: String(status.sessionDays ?? '') })),
          field(el, {
            id: 'dw-user', label: tr('usernameLabel'), type: 'text',
            value: usernameDraft, disabled: busy, hint: tr('usernameHint'),
            onChange: (event) => actions.setUsername(event.target.value),
          }),
          el('div', { className: 'dw_actions' },
            el('button', { className: 'dw_button', onClick: actions.submitUsername, disabled: busy },
              tr('changeUsername'))),
        ]),

        card(el, tr('changePassword'), undefined, [
          field(el, {
            id: 'dw-pass', label: tr('newPassword'), type: 'password',
            value: form.password ?? '', disabled: busy,
            onChange: (event) => actions.setPassword(event.target.value),
          }),
          field(el, {
            id: 'dw-pass2', label: tr('confirmPassword'), type: 'password',
            value: form.confirm ?? '', disabled: busy,
            onChange: (event) => actions.setConfirm(event.target.value),
          }),
          el('div', { className: 'dw_actions' },
            el('button', {
              className: 'dw_button dw_primary', onClick: actions.submitPassword,
              disabled: busy || (form.password ?? '').length === 0,
            }, tr('save'))),
        ]),

        card(el, tr('twoFactor'), undefined, [
          el('p', { className: 'dw_status' },
            el('span', { className: `dw_dot${totpEnabled ? '' : ' dw_dotOff'}`, 'aria-hidden': 'true' }),
            tr(totpEnabled ? 'twoFactorOn' : 'twoFactorOff')),
          ...totpBody,
        ]),

        card(el, tr('signOut'), tr('signOutHint'), [
          el('div', { className: 'dw_actions' },
            el('button', { className: 'dw_button dw_danger', onClick: actions.signOut, disabled: busy },
              tr('signOut'))),
        ]),

        noticeLine(el, error, notice));
    }

    /**
     * Render the bridge configuration editor. Pure, like {@link SecurityView}.
     *
     * Addresses are edited as text rows rather than parsed host/port pairs: the
     * config is a list of "host:port" strings, and one text field per address
     * keeps a half-typed value intact instead of snapping it while typing.
     *
     * @param props - view input.
     * @returns a React element.
     */
    function BridgeConfigView(props) {
      const {
        tr, phase, editable, busy, error, notice, values, actions,
        interfaces = [],
      } = props;
      // The container passes the selection explicitly, but falling back to the
      // config keeps the view renderable on its own (and in tests).
      const selectedBind = props.selectedBind ?? values.bind ?? [];
      const el = react.createElement;

      if (phase === 'loading') {
        return el('div', { className: 'dw_page' },
          el('div', { className: 'dw_card' },
            el('div', { className: 'dw_cardBody' },
              el('div', { className: 'dw_loading', role: 'status' },
                el('span', { className: 'dw_spinner', 'aria-hidden': 'true' }),
                el('span', null, tr('loading'))))));
      }
      if (phase === 'failed') {
        return el('div', { className: 'dw_page' },
          el('div', { className: 'dw_card' },
            el('div', { className: 'dw_cardBody' },
              el('p', { className: 'dw_note dw_noteError', role: 'alert' }, tr('loadFailed')),
              el('div', { className: 'dw_actions' },
                el('button', { className: 'dw_button', onClick: actions.reloadConfig }, tr('retry'))))));
      }

      const addresses = values.listen ?? [];
      const effective = values.effective ?? [];
      const disabled = busy || editable !== true;

      const numberField = (id, label, value, onChange) => el('div', { className: 'dw_field' },
        el('label', { className: 'dw_label', htmlFor: id }, label),
        el('input', {
          id, className: 'dw_input', type: 'number', value: String(value ?? ''),
          disabled, onChange: (event) => onChange(event.target.value),
        }));

      const toggle = (id, title, checked, onChange) => el('label', { className: 'dw_toggleRow', htmlFor: id },
        el('span', { className: 'dw_toggleText' },
          el('span', { className: 'dw_toggleTitle' }, title)),
        el('input', {
          id, type: 'checkbox', checked, disabled,
          onChange: (event) => onChange(event.target.checked),
        }));

      return el('div', { className: 'dw_page' },
        el('section', { className: 'dw_card' },
          el('div', { className: 'dw_cardHead' },
            el('h2', { className: 'dw_title' }, tr('bridge')),
            el('p', { className: 'dw_desc' }, tr('bridgeIntro'))),
          el('div', { className: 'dw_cardBody' },

            editable === true ? null : el('p', { className: 'dw_note dw_noteError', role: 'alert' }, tr('bridgeUnavailable')),

            // What is actually bound right now. A save rebinds within the
            // request, so this normally matches the saved list; it differs only
            // if a bind failed, which is exactly when the user needs the truth.
            el('div', { className: 'dw_readout' },
              el('span', { className: 'dw_readoutLabel' }, tr('effectiveLabel')),
              effective.length === 0
                ? el('span', { className: 'dw_help' }, tr('effectiveNone'))
                : el('div', { className: 'dw_chips' },
                  effective.map((address) => el('span', { key: address, className: 'dw_chip' }, address)))),

            // Interfaces first: this is the form that survives an address change.
            el('div', { className: 'dw_group' },
              el('span', { className: 'dw_groupLabel' }, tr('interfacesLabel')),
              interfaces.length === 0
                ? el('p', { className: 'dw_help' }, tr('noInterfaces'))
                : el('div', { className: 'dw_nicList' },
                  interfaces.map((iface) => el('label', { className: 'dw_nicRow', key: iface.name },
                    el('input', {
                      type: 'checkbox', checked: selectedBind.includes(iface.name), disabled,
                      onChange: (event) => actions.toggleInterface(iface.name, event.target.checked),
                    }),
                    el('span', { className: 'dw_nicText' },
                      el('span', { className: 'dw_nicName' },
                        iface.name,
                        iface.internal === true ? el('span', { className: 'dw_badge' }, tr('loopbackBadge')) : null),
                      el('span', { className: 'dw_nicIps' },
                        iface.addresses.map((address) => el('span', { key: address, className: 'dw_ip' }, address))))))),
              el('div', { className: 'dw_actions' },
                el('button', {
                  className: 'dw_button dw_quiet', type: 'button', disabled,
                  onClick: actions.refreshInterfaces,
                }, tr('refreshInterfaces'))),
              el('div', { className: 'dw_field dw_fieldNarrow' },
                el('label', { className: 'dw_label', htmlFor: 'dw-port' }, tr('portLabel')),
                el('input', {
                  id: 'dw-port', className: 'dw_input', type: 'number',
                  value: String(values.port ?? ''), disabled,
                  onChange: (event) => actions.setPort(event.target.value),
                })),
              el('p', { className: 'dw_help' }, tr('interfacesHint'))),

            // Explicit addresses stay available for anything an interface name
            // cannot express, but they are the fragile form.
            el('div', { className: 'dw_group' },
              el('span', { className: 'dw_groupLabel' }, tr('listenLegacyLabel')),
              addresses.length === 0
                ? el('p', { className: 'dw_help' }, tr('listenEmpty'))
                : el('div', { className: 'dw_addrList' },
                  addresses.map((address, index) => el('div', { className: 'dw_addrRow', key: `addr-${index}` },
                    el('input', {
                      className: 'dw_input dw_mono', type: 'text', value: address, disabled,
                      'aria-label': `${tr('listenLabel')} ${index + 1}`,
                      placeholder: '127.0.0.1:8091',
                      onChange: (event) => actions.setAddress(index, event.target.value),
                    }),
                    el('button', {
                      className: 'dw_removeBtn', type: 'button', disabled,
                      title: tr('removeAddress'), 'aria-label': tr('removeAddress'),
                      onClick: () => actions.removeAddress(index),
                    }, '\u2715')))),
              el('div', { className: 'dw_actions' },
                el('button', {
                  className: 'dw_button dw_quiet', type: 'button', disabled,
                  onClick: actions.addAddress,
                }, tr('addAddress')),
                el('button', {
                  className: 'dw_button dw_quiet', type: 'button', disabled,
                  onClick: actions.deriveFromListen,
                }, tr('deriveFromListen'))),
              el('p', { className: 'dw_help' }, tr('listenLegacyHint'))),

            el('div', { className: 'dw_fieldGrid' },
              numberField('dw-session-days', tr('sessionDaysLabel'), values.sessionDays, actions.setSessionDays),
              numberField('dw-max-attempts', tr('maxAttemptsLabel'), values.maxAttempts, actions.setMaxAttempts),
              numberField('dw-lockout-ms', tr('lockoutMsLabel'), values.lockoutMs, actions.setLockoutMs),
              numberField('dw-min-password', tr('minPasswordLabel'), values.minPasswordLength, actions.setMinPassword)),

            field(el, {
              id: 'dw-issuer', label: tr('issuerLabel'), type: 'text',
              value: values.totpIssuer ?? '', disabled,
              onChange: (event) => actions.setIssuer(event.target.value),
            }),

            el('div', { className: 'dw_group' },
              toggle('dw-bootstrap', tr('bootstrapLabel'), values.bootstrapLoopbackOnly !== false, actions.setBootstrap),
              toggle('dw-totp-available', tr('totpAvailableLabel'), values.totpAvailable !== false, actions.setTotpAvailable)),

            field(el, {
              id: 'dw-access-key', label: tr('accessKeyLabel'), type: 'text',
              value: values.accessKey ?? '', disabled, mono: true,
              onChange: (event) => actions.setAccessKey(event.target.value),
              hint: tr('accessKeyHint'),
            }),

            noticeLine(el, error, notice),
          ),
          el('div', { className: 'dw_cardFoot' },
            el('button', {
              className: 'dw_button dw_primary', type: 'button', disabled,
              onClick: actions.saveConfig,
            }, tr('saveConfig')))));
    }

    // ── stateful container ────────────────────────────────────────────────

    /**
     * The Security section: owns the server state and hands it to the view.
     * @param props - slot props, including locale's `t`.
     * @returns a React element.
     */
    function SecuritySection(props) {
      const tr = translator(props?.t);
      const [phase, setPhase] = react.useState('loading');
      const [status, setStatus] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(undefined);
      const [notice, setNotice] = react.useState(undefined);
      const [pending, setPending] = react.useState(undefined);
      const [form, setForm] = react.useState({ username: undefined, password: '', confirm: '', code: '' });

      const minLength = status.minPasswordLength ?? 8;

      const reload = () => {
        void (async () => {
          try {
            const body = await call('/status');
            // `/status` answers without a session and reports `hasAccount`, so a
            // 401 here means the endpoint is missing rather than "sign in": the
            // panel also runs inside the desktop window, which has no `/login`
            // page to redirect to. Treat a non-answer as a load failure.
            if (body.ok !== true) { setPhase('failed'); return; }
            setStatus(body);
            setForm((current) => ({ ...current, username: current.username ?? body.username ?? '' }));
            setPhase('ready');
          } catch {
            setPhase('failed');
          }
        })();
      };

      react.useEffect(reload, []);

      /** Run one request with the shared busy/error envelope. */
      const run = async (task) => {
        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        try {
          await task();
        } catch {
          setError(tr('saveFailed'));
        } finally {
          setBusy(false);
        }
      };

      const submitSetup = () => {
        void run(async () => {
          const body = await call('/setup', {
            method: 'POST',
            body: JSON.stringify({
              username: form.username, password: form.password, confirm: form.confirm,
            }),
          });
          if (body.status === 401) { goToSignIn(); setError(tr('saveFailed')); return; }
          if (body.ok !== true) {
            setError(body.error === 'passwordTooShort' ? tr('passwordTooShort', { min: minLength })
              : body.error === 'passwordsDoNotMatch' ? tr('passwordsDoNotMatch')
                : body.error === 'usernameInvalid' ? tr('usernameInvalid')
                  : body.error === 'accountExists' ? tr('accountExists')
                    : tr('saveFailed'));
            return;
          }
          setForm((current) => ({ ...current, password: '', confirm: '' }));
          setNotice(tr('createdAccount'));
          reload();
        });
      };

      const submitUsername = () => {
        void run(async () => {
          const body = await call('/username', {
            method: 'POST',
            body: JSON.stringify({ username: form.username }),
          });
          if (body.status === 401) { goToSignIn(); setError(tr('saveFailed')); return; }
          if (body.ok !== true) {
            setError(body.error === 'usernameInvalid' ? tr('usernameInvalid') : tr('saveFailed'));
            return;
          }
          setNotice(tr('usernameChanged'));
          reload();
        });
      };

      const submitPassword = () => {
        void run(async () => {
          if (form.password.length < minLength) { setError(tr('passwordTooShort', { min: minLength })); return; }
          if (form.password !== form.confirm) { setError(tr('passwordsDoNotMatch')); return; }
          const body = await call('/password', {
            method: 'POST',
            body: JSON.stringify({ password: form.password, confirm: form.confirm }),
          });
          if (body.status === 401) { goToSignIn(); setError(tr('saveFailed')); return; }
          if (body.ok !== true) {
            setError(body.error === 'passwordTooShort' ? tr('passwordTooShort', { min: minLength })
              : body.error === 'passwordsDoNotMatch' ? tr('passwordsDoNotMatch')
                : tr('saveFailed'));
            return;
          }
          // Changing the password revokes every session, including this one, so
          // say so on the sign-in page rather than looking like a random logout.
          if (canRedirectToSignIn()) goToSignIn('?notice=passwordChanged'); else { setForm((current) => ({ ...current, password: '', confirm: '' })); setNotice(tr('passwordChanged')); }
        });
      };

      const beginTotp = () => {
        void run(async () => {
          const body = await call('/totp/begin', { method: 'POST' });
          if (body.ok !== true) { setError(tr('saveFailed')); return; }
          setPending({ secret: body.secret, uri: body.otpauthUri, qrDataUri: body.qrDataUri });
          setForm((current) => ({ ...current, code: '' }));
        });
      };

      const confirmTotp = () => {
        void run(async () => {
          const body = await call('/totp/confirm', { method: 'POST', body: JSON.stringify({ code: form.code }) });
          if (body.ok !== true) { setError(body.error === 'wrongTotp' ? tr('wrongTotp') : tr('saveFailed')); return; }
          setPending(undefined);
          setForm((current) => ({ ...current, code: '' }));
          setNotice(tr('totpEnabled'));
          reload();
        });
      };

      const disableTotp = () => {
        void run(async () => {
          const body = await call('/totp/disable', { method: 'POST', body: JSON.stringify({ code: form.code }) });
          if (body.ok !== true) { setError(body.error === 'wrongTotp' ? tr('wrongTotp') : tr('saveFailed')); return; }
          setForm((current) => ({ ...current, code: '' }));
          setNotice(tr('totpDisabled'));
          reload();
        });
      };

      const cancelTotp = () => {
        void run(async () => {
          // Never leave an unconfirmed draft behind: otherwise a key that never
          // took effect would linger in the record.
          await call('/totp/cancel', { method: 'POST', body: '{}' });
          setPending(undefined);
          setForm((current) => ({ ...current, code: '' }));
          reload();
        });
      };

      const signOut = () => {
        void run(async () => {
          await call('/logout', { method: 'POST' });
          // Over the bridge the sign-in page is the right destination. In the
          // desktop window there is none, so say what happened instead of
          // silently doing nothing.
          if (canRedirectToSignIn()) goToSignIn();
          else setNotice(tr('signedOut'));
        });
      };

      return react.createElement(SecurityView, {
        tr, phase, status, busy, error, notice, form, pending,
        actions: {
          reload, submitSetup, submitPassword, submitUsername,
          beginTotp, confirmTotp, disableTotp, cancelTotp, signOut,
          setPassword: (value) => setForm((current) => ({ ...current, password: value })),
          setConfirm: (value) => setForm((current) => ({ ...current, confirm: value })),
          setCode: (value) => setForm((current) => ({ ...current, code: value })),
          setUsername: (value) => setForm((current) => ({ ...current, username: value })),
        },
      });
    }

    /**
     * Bridge configuration editor: loads the live row config, validates locally,
     * and saves through the Host.
     *
     * Kept in its own component so a configuration failure cannot blank the
     * account panel, and so the two halves load independently.
     *
     * @param props - slot props, including locale's `t`.
     * @returns a React element, or null when the panel has no configuration UI.
     */
    function BridgeConfigSection(props) {
      const tr = translator(props?.t);
      const [phase, setPhase] = react.useState('loading');
      const [editable, setEditable] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(undefined);
      const [notice, setNotice] = react.useState(undefined);
      const [values, setValues] = react.useState({ bind: [], port: 8091, listen: [], effective: [] });
      // Enumerated separately from the config: interfaces come from the machine,
      // not from the saved row, and change while the app runs.
      const [interfaces, setInterfaces] = react.useState([]);

      /** Map a server error code onto a localized message. */
      const messageFor = (code) => {
        const known = [
          'addressInvalid', 'addressEmpty', 'addressNeedsHost', 'addressWildcard',
          'portInvalid', 'listenEmpty', 'bindEmpty', 'interfaceInvalid',
          'accessKeyTooShort', 'numberOutOfRange',
          'issuerInvalid', 'configNotEditable', 'configWriteFailed',
        ];
        if (typeof code === 'string' && known.includes(code)) return tr(code);
        if (code === 'unauthenticated') return tr('saveFailed');
        return tr('saveFailed');
      };

      const reloadConfig = () => {
        void (async () => {
          try {
            const body = await call('/config');
            if (body.ok !== true) { setPhase('failed'); return; }
            setEditable(body.editable === true);
            setInterfaces(Array.isArray(body.interfaces) ? body.interfaces : []);
            setValues({
              ...body.config,
              effective: body.effective?.listen ?? [],
            });
            setPhase('ready');
          } catch {
            setPhase('failed');
          }
        })();
      };

      react.useEffect(reloadConfig, []);

      /** Patch one configuration field. */
      const setField = (name, value) => setValues((current) => ({ ...current, [name]: value }));

      const setAddress = (index, value) => setValues((current) => {
        const listen = [...(current.listen ?? [])];
        listen[index] = value;
        return { ...current, listen };
      });

      const addAddress = () => setValues((current) => {
        const listen = [...(current.listen ?? [])];
        // Seed with the same host as the last row so adding a second port on
        // the same interface is one edit, not retyping the address.
        const last = listen[listen.length - 1] ?? '';
        const colon = last.lastIndexOf(':');
        listen.push(colon > 0 ? last.slice(0, colon + 1) : '');
        return { ...current, listen };
      });

      const removeAddress = (index) => setValues((current) => ({
        ...current,
        listen: (current.listen ?? []).filter((_, position) => position !== index),
      }));

      const setPort = (value) => setField('port', value);

      /** Select or deselect one interface; the saved value is its name. */
      const toggleInterface = (name, checked) => setValues((current) => {
        const bind = [...(current.bind ?? [])];
        const at = bind.indexOf(name);
        if (checked && at < 0) bind.push(name);
        if (!checked && at >= 0) bind.splice(at, 1);
        return { ...current, bind };
      });

      /** Re-read the machine's interfaces; addresses change while it runs. */
      const refreshInterfaces = () => {
        void (async () => {
          try {
            const body = await call('/interfaces');
            if (body.ok === true) {
              setInterfaces(Array.isArray(body.interfaces) ? body.interfaces : []);
            }
          } catch {
            // Keep the previous list; the button can simply be pressed again.
          }
        })();
      };

      /**
       * Turn the explicit addresses into interface selections.
       *
       * This is the migration path off hard-coded IPs. An address that belongs
       * to no current interface cannot be derived, so it is reported instead of
       * being dropped silently.
       */
      const deriveFromListen = () => {
        const bind = [...(values.bind ?? [])];
        const unresolved = [];
        for (const entry of values.listen ?? []) {
          const text = String(entry ?? '').trim();
          if (text === '') continue;
          const host = text.includes(':') ? text.slice(0, text.lastIndexOf(':')) : '127.0.0.1';
          const match = interfaces.find((candidate) => candidate.addresses.includes(host));
          if (match === undefined) unresolved.push(text);
          else if (!bind.includes(match.name)) bind.push(match.name);
        }
        setError(unresolved.length === 0 ? undefined : tr('deriveFailed'));
        setNotice(undefined);
        setValues((current) => ({ ...current, bind }));
      };

      const saveConfig = () => {
        void (async () => {
          setBusy(true);
          setError(undefined);
          setNotice(undefined);
          try {
            const body = await call('/config', {
              method: 'POST',
              body: JSON.stringify({
                bind: values.bind ?? [],
                port: Number(values.port),
                listen: values.listen,
                accessKey: values.accessKey,
                sessionDays: Number(values.sessionDays),
                maxAttempts: Number(values.maxAttempts),
                lockoutMs: Number(values.lockoutMs),
                minPasswordLength: Number(values.minPasswordLength),
                totpIssuer: values.totpIssuer,
                bootstrapLoopbackOnly: values.bootstrapLoopbackOnly !== false,
                totpAvailable: values.totpAvailable !== false,
              }),
            });
            if (body.ok !== true) { setError(messageFor(body.error)); return; }
            setNotice(tr('configSaved'));
            // Re-read so the panel shows what was actually persisted rather
            // than what was typed, including any normalization.
            reloadConfig();
          } catch {
            setError(tr('saveFailed'));
          } finally {
            setBusy(false);
          }
        })();
      };

      return react.createElement(BridgeConfigView, {
        tr, phase, editable, busy, error, notice, values,
        interfaces,
        selectedBind: values.bind ?? [],
        actions: {
          reloadConfig, saveConfig, setAddress, addAddress, removeAddress,
          toggleInterface, refreshInterfaces, deriveFromListen, setPort,
          setAccessKey: (value) => setField('accessKey', value),
          setSessionDays: (value) => setField('sessionDays', value),
          setMaxAttempts: (value) => setField('maxAttempts', value),
          setLockoutMs: (value) => setField('lockoutMs', value),
          setMinPassword: (value) => setField('minPasswordLength', value),
          setIssuer: (value) => setField('totpIssuer', value),
          setBootstrap: (value) => setField('bootstrapLoopbackOnly', value),
          setTotpAvailable: (value) => setField('totpAvailable', value),
        },
      });
    }

    /** This bundle's package name. */
    const OUR_PACKAGE = 'dsh-desktop-web';

    /**
     * Whether a plugin detail page is showing this bundle.
     *
     * `plugins.detail.section` renders for *every* plugin, so the entry must
     * filter by subject or this panel would appear on all of them.
     * @param subject - the detail page's subject.
     * @returns true when it belongs to this bundle.
     */
    const belongsToUs = (subject) => {
      if (subject === undefined || subject === null) return false;
      if (subject.kind === 'bundle') return subject.pkg?.name === OUR_PACKAGE;
      if (subject.kind === 'row') {
        return subject.row?.moduleName === OUR_PACKAGE || subject.pkg?.name === OUR_PACKAGE;
      }
      return false;
    };

    /**
     * The whole panel: account security, then the bridge configuration.
     *
     * The two halves load independently, so a configuration error never blanks
     * the account editor and vice versa.
     * @param props - slot props, including locale's `t`.
     * @returns a React element.
     */
    function Panel(props) {
      const el = react.createElement;
      // Both halves render their own cards, so the panel only spaces them.
      return el('div', { className: 'dw_panel' },
        el(SecuritySection, props),
        el(BridgeConfigSection, props));
    }

    /**
     * The section shown on this bundle's own page under Plugins.
     * @param props - detail props, including `subject` and locale's `t`.
     * @returns a React element, or null for other plugins.
     */
    function PluginDetailSection(props) {
      if (!belongsToUs(props?.subject)) return null;
      return react.createElement('div', { className: 'dw_detail' },
        react.createElement(Panel, props));
    }

    // ── registration ──────────────────────────────────────────────────────

    /** Only the services this file actually uses; extra waits blank the panel. */
    const inject = ['slots', 'locale'];

    /**
     * Register the dictionaries and both surfaces.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'desktop-web: dictionaries');
      const bound = ctx.locale.bind(NS);
      const tr = translator(bound);

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'desktop-web',
        order: 25,
        label: () => tr('nav'),
        locale: NS,
      }, Panel));

      // The same panel under Plugins, so managing the account does not require
      // hunting for it in Settings.
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'desktop-web.detail',
        order: 20,
        locale: NS,
      }, PluginDetailSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Panel = Panel;
    exports.SecuritySection = SecuritySection;
    exports.SecurityView = SecurityView;
    exports.BridgeConfigSection = BridgeConfigSection;
    exports.BridgeConfigView = BridgeConfigView;
    exports.PluginDetailSection = PluginDetailSection;
    exports.belongsToUs = belongsToUs;
    exports.translator = translator;
    exports.ZH = ZH;
    exports.EN = EN;
    return module.exports;
  },
});
