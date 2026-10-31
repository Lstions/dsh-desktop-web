/**
 * The password gate for the desktop bridge.
 *
 * Real feature parity with `dsh-web-password-auth` (MIT), re-hosted so it guards
 * *this listener* rather than the Host's own port:
 *
 * - first-run account creation, then username + password sign-in;
 * - a persistent signed session cookie that survives browser and app restarts
 *   until sign-out;
 * - in-app account management: change username, change password, sign out;
 * - optional TOTP two-factor with a scannable QR code and replay rejection;
 * - per-source lockout after repeated failures.
 *
 * Three deliberate differences from the upstream plugin, each forced by this
 * bridge being a second listener rather than the Host itself:
 *
 * 1. **Every path is guarded, not just `/`.** Upstream only intercepts `/` and
 *    `/index.html`, relying on the Host's own cookie to protect `/api/*`. Here
 *    the bridge injects the Host's owner cookie upstream, so an unguarded
 *    `/api/remote.mux` would hand out owner access with no password at all.
 *    The gate therefore runs before every forward, including upgrades.
 * 2. **Bootstrap authority comes from the listener, never the socket.** An
 *    upstream proxy would make every request look like `127.0.0.1` and silently
 *    disable a socket-based check, so the loopback test is on the bind address.
 * 3. **Account creation is the only thing the access key still grants.** It is
 *    a bootstrap path, not a bypass: once a password exists, the key opens
 *    nothing and changing the password really does lock the door.
 *
 * Accounts live in the Harness credential store as `desktop-web/*` records, so
 * `$DSH_HOME/.credentials.yaml` stays the single secret store. The gate's own
 * signing key is a *separate* record from the Host's, so revoking gate sessions
 * never disturbs the desktop window's own session.
 *
 * @module dsh-desktop-web/gate
 */

import { randomBytes, createHmac } from 'node:crypto';

import {
  DAY_MILLISECONDS,
  clearCookie,
  hashPassword,
  mintCookieValue,
  readCookieValue,
  requestAuthority,
  sessionCookie,
  totpUri,
  verifyCookieValue,
  verifyPassword,
  verifyTotp,
  cookieName,
  generateTotpSecret,
} from './auth.js';
import { qrDataUri } from './qr.js';
import {
  normalizeConfig,
  publicConfig,
} from './config.js';
import {
  renderAccountPage,
  renderErrorPage,
  renderLoginPage,
  renderSetupPage,
  stringsFor,
} from './pages.js';

/** This bundle's package name, used to find its own Loader row. */
const PLUGIN_PACKAGE = '@local/dsh-desktop-web';

/** Credential record holding the username and password hash. */
const PASSWORD_KEY = 'desktop-web/password';

/** Credential record holding the TOTP secret and consumption state. */
const TOTP_KEY = 'desktop-web/totp';

/** Credential record holding the gate's own cookie-signing key. */
const SESSION_KEY = 'desktop-web/session-key';

/**
 * Credential record holding the revocation generation. Every cookie embeds the
 * generation it was minted under; raising the stored value expires them all.
 */
const GENERATION_KEY = 'desktop-web/generation';

/** Username rule, matching upstream so existing accounts stay portable. */
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * JSON endpoints the in-app Security settings page calls.
 *
 * These mirror `dsh-web-password-auth`'s `/web-auth/*` surface so the page
 * shipped in `client.js` is a straight port: the browser half owns no policy,
 * it only renders this gate's state. They are authenticated by the same session
 * cookie as the HTML pages, so the page needs no separate authorization step.
 */
const API_PREFIX = '/desktop-web';

/** Every JSON endpoint, relative to {@link API_PREFIX}. */
const API_ROUTES = new Set([
  '/status', '/setup', '/username', '/password',
  '/totp/begin', '/totp/confirm', '/totp/cancel', '/totp/disable',
  '/logout', '/config', '/interfaces',
]);

/** Paths the gate answers itself; everything else is application traffic. */
const GATE_PATHS = new Set([
  '/start', '/login', '/setup',
  '/account', '/account/username', '/account/password',
  '/totp/begin', '/totp/confirm', '/totp/cancel', '/totp/disable',
  '/logout',
]);

/**
 * Whether a path belongs to the application's API rather than the shell.
 *
 * API callers must never receive an HTML sign-in page: a 200 with a form body
 * reads as success to a fetch-based client, and the failure then appears far
 * from its cause. They get a plain 401 instead.
 * @param path - request pathname.
 */
function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

/** Session cookie prefix; one cookie per authority. */
const GATE_COOKIE_PREFIX = 'dsh-gate-';

/**
 * Map a request's preferred language to a string table.
 * @param request - incoming request.
 */
function localeOf(request) {
  const header = request.headers['accept-language'];
  const accepted = typeof header === 'string' ? header : '';
  return /(^|,)\s*zh/iu.test(accepted) ? stringsFor('zh') : stringsFor('en');
}

/** Read and parse a URL-encoded body, bounded in size. */
async function readForm(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Send an HTML response. */
function sendHtml(response, status, body) {
  const buffer = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(buffer.length),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  response.end(buffer);
}

/** Send a plain-text response. */
function sendText(response, status, text) {
  const buffer = Buffer.from(`${text}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(buffer.length),
    'cache-control': 'no-store',
  });
  response.end(buffer);
}

/** Send a JSON response. */
function sendJson(response, status, body) {
  const buffer = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buffer.length),
    'cache-control': 'no-store',
  });
  response.end(buffer);
}

/** Read and JSON-parse a request body, bounded in size. */
async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** Send a 303 redirect. */
function redirect(response, location) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

/**
 * Whether a bind address names the loopback interface.
 * @param host - configured bind address.
 */
export function isLoopbackAddress(host) {
  return host === '127.0.0.1'
    || host === '::1'
    || host === 'localhost'
    || /^127\./u.test(host);
}

/**
 * Build the password gate.
 *
 * @param options - collaborators and settings.
 * @returns the gate: `handle`, `authenticated`, and `ready`.
 */
export function createGate(options) {
  const {
    credentials,
    logger,
    listenHost,
    secure,
    sessionDays = 30,
    minPasswordLength = 8,
    maxAttempts = 5,
    lockoutMs = 300_000,
    totpIssuer = 'DSH',
    totpAvailable = true,
    bootstrapLoopbackOnly = true,
    trustedCaller = false,
    /**
     * `ctx.configEditor`, when the profile has a writable patch. Undefined means
     * the panel can display configuration but not save it.
     */
    configEditor,
    /** This row's config as this process actually loaded it. */
    liveConfig,
    /** Addresses this process actually bound, for the effective-view display. */
    liveListen,
    /**
     * Network-interface enumerator. Injected rather than imported so the gate
     * stays testable without a real NIC list.
     */
    listInterfaces,
  } = options;

  /** Consecutive failures per source address. */
  const failures = new Map();

  /** Session lifetime in milliseconds. */
  const sessionMaxAge = sessionDays * DAY_MILLISECONDS;

  /** Cached signing key; loaded once and re-read after a rotation. */
  let signingKey;

  /**
   * Cached revocation generation. Cookies carry the generation they were minted
   * under, so raising the stored value invalidates every session at once
   * without needing to remember individual cookies. That is what makes sign-out
   * and password change *server-side*: clearing the browser cookie alone leaves
   * a copy that still verifies.
   */
  let generationCache;

  /** Read (and cache) the current revocation generation. */
  async function ensureGeneration() {
    if (generationCache !== undefined) return generationCache;
    const record = await credentials.modifyRecord(GENERATION_KEY, async (current) => {
      if (current?.kind === 'grant' && Number.isSafeInteger(current.payload?.value)) return undefined;
      return { kind: 'grant', payload: { version: 1, value: 1 } };
    });
    generationCache = Number(record?.kind === 'grant' ? record.payload?.value : 1);
    return generationCache;
  }

  /** Raise the generation, invalidating every issued cookie. */
  async function revokeAllSessions() {
    const record = await credentials.modifyRecord(GENERATION_KEY, async (current) => {
      const value = Number(current?.kind === 'grant' && Number.isSafeInteger(current.payload?.value)
        ? current.payload.value
        : 1);
      return { kind: 'grant', payload: { version: 1, value: value + 1 } };
    });
    generationCache = Number(record?.kind === 'grant' ? record.payload?.value : 2);
    return generationCache;
  }

  /**
   * Load or create the gate's signing key. Keeping it in the credential store
   * (rather than memory) is what lets a browser stay signed in across a desktop
   * app restart.
   */
  async function ensureSigningKey() {
    if (signingKey !== undefined) return signingKey;
    const record = await credentials.modifyRecord(SESSION_KEY, async (current) => {
      if (current?.kind === 'grant' && typeof current.payload?.secret === 'string') return undefined;
      return {
        kind: 'grant',
        payload: { version: 1, secret: randomBytes(32).toString('base64url') },
      };
    });
    const secret = record?.kind === 'grant' ? record.payload?.secret : undefined;
    signingKey = Buffer.from(secret ?? '', 'base64url');
    if (signingKey.byteLength !== 32) {
      throw new Error('desktop-web: the gate signing key is missing or malformed');
    }
    return signingKey;
  }

  /**
   * The key actually used to sign cookies: the stored secret bound to the
   * current revocation generation.
   *
   * The cookie payload format is the Host's (it has no room for extra fields),
   * so revocation is expressed by changing the *key* instead: raising the
   * generation yields a different derived key, and every cookie signed under
   * the previous one stops verifying. The stored secret itself is untouched, so
   * no long-lived material has to be rotated.
   */
  async function effectiveKey() {
    const base = await ensureSigningKey();
    const generation = await ensureGeneration();
    return createHmac('sha256', base).update(`generation:${generation}`).digest();
  }

  /** Discard cached key material so both records are re-read. */
  function forgetKeys() {
    signingKey = undefined;
    generationCache = undefined;
  }

  /** The cookie name for one authority. */
  const cookieNameFor = (authority) => cookieName(`${GATE_COOKIE_PREFIX}${authority}`);

  /** The request's cookie audience, or undefined. */
  const authorityOf = (request) => requestAuthority(request.headers, secure);

  /** Read the stored account record. */
  const readAccount = () => credentials.readRecord(PASSWORD_KEY);

  /** Whether an account exists. */
  const hasAccount = async () => {
    const record = await readAccount();
    return record?.kind === 'grant' && record.payload?.version === 1;
  };

  /** Read the stored TOTP record. */
  const readTotp = () => credentials.readRecord(TOTP_KEY);

  /** Whether TOTP is enabled. */
  const totpEnabled = async () => {
    if (!totpAvailable) return false;
    const record = await readTotp();
    return record?.kind === 'grant' && record.payload?.enabled === true;
  };

  /**
   * Whether this listener may create the first account. The decision is about
   * the listener, never the socket, so a proxy cannot launder a remote
   * connection into a local one.
   */
  const mayBootstrap = () => !bootstrapLoopbackOnly || isLoopbackAddress(listenHost);

  /**
   * Whether the request carries a valid gate session.
   *
   * On a `trustedCaller` mount the request has already cleared the Host's own
   * browser-trust fence and cookie authentication — that mount exists solely so
   * the desktop window's own page can manage the account — so identity is not
   * re-established here.
   *
   * @param request - incoming request.
   */
  async function authenticated(request) {
    if (trustedCaller) return true;
    const authority = authorityOf(request);
    if (authority === undefined) return false;
    const raw = readCookieValue(request.headers.cookie, cookieNameFor(authority));
    if (raw === undefined) return false;
    let key;
    try {
      key = await effectiveKey();
    } catch {
      return false;
    }
    return verifyCookieValue(raw, key, authority, sessionMaxAge) !== undefined;
  }

  /** Issue a session cookie after sign-in. */
  async function issueSession(response, request) {
    const authority = authorityOf(request);
    if (authority === undefined) return false;
    const key = await effectiveKey();
    const now = Date.now();
    const expiresAt = now + sessionMaxAge;
    const value = mintCookieValue(key, authority, now, expiresAt);
    response.setHeader('set-cookie', sessionCookie(cookieNameFor(authority), value, {
      expiresAt,
      maxAgeSeconds: Math.floor(sessionMaxAge / 1000),
      secure,
    }));
    return true;
  }

  /**
   * Remaining lockout for one source, in milliseconds.
   *
   * An entry with no lockout yet must survive: its `count` is the running
   * failure tally, so deleting it here would give every attempt a fresh budget
   * and the limit could never be reached.
   */
  function lockoutFor(source) {
    const entry = failures.get(source);
    if (entry === undefined) return 0;
    if (entry.lockedUntil > Date.now()) return entry.lockedUntil - Date.now();
    // The lockout has expired: clear it and resume counting from zero.
    if (entry.lockedUntil !== 0) failures.delete(source);
    return 0;
  }

  /**
   * Record one failure. The attempt that reaches the limit is the last one
   * still allowed to try a password, so the lockout starts counting from the
   * next request; clearing the counter here would let the attacker resume
   * immediately with a fresh budget.
   */
  function recordFailure(source) {
    const entry = failures.get(source) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= maxAttempts) entry.lockedUntil = Date.now() + lockoutMs;
    failures.set(source, entry);
  }

  /** The rate-limit key for a request. */
  const sourceOf = (request) => request.socket?.remoteAddress ?? 'unknown';

  /** Render the account page with an optional message. */
  async function accountPage(t, error, notice) {
    const record = await readAccount();
    return renderAccountPage({
      t,
      username: record?.payload?.username ?? '',
      totpEnabled: await totpEnabled(),
      totpAvailable,
      error,
      notice,
    });
  }

  /**
   * Whether a request may pass through to the Host.
   *
   * Only a live password session grants this. Holding the bridge access key is
   * *not* enough once it has done its one job of reaching the setup page —
   * otherwise the key would be a permanent backdoor around the password.
   * @param request - incoming request.
   */
  async function mayForward(request) {
    if (!await hasAccount()) return false;
    return authenticated(request);
  }

  /**
   * Addresses this process actually bound.
   *
   * The caller may pass a thunk, because the listeners open asynchronously
   * after the gate is constructed; reading it lazily keeps the panel showing
   * what is really listening rather than the pre-bind configuration.
   * @returns the bound address list, or an empty list before binding.
   */
  function resolveLiveListen() {
    const value = options.liveListen;
    if (typeof value === 'function') {
      try {
        const read = value();
        return Array.isArray(read) ? read : [];
      } catch {
        return [];
      }
    }
    return Array.isArray(value) ? value : [];
  }

  /**
   * Read or write this plugin's own row configuration.
   *
   * The bridge's addresses and policy live in the Loader row, not in a private
   * settings file, so this reads the live config and writes through
   * `ctx.configEditor` — the same validated path a human editing the profile
   * patch takes. When the configEditor is unavailable (a profile without a
   * writable patch) the read still works and the write reports why it cannot.
   *
   * @param request - incoming request.
   * @param response - response to write.
   * @param method - request method.
   */
  async function handleConfig(request, response, method) {
    const readLive = () => {
      const editor = configEditor;
      if (editor === undefined || editor === null) return undefined;
      const entry = editor.entries().find((candidate) => candidate.options?.name === PLUGIN_PACKAGE);
      return entry;
    };

    if (method === 'GET') {
      const interfaces = typeof listInterfaces === 'function' ? listInterfaces() : [];
      const entry = readLive();
      if (entry === undefined) {
        // No editable row (or no editor): still report what this process is
        // actually running, which is what the panel needs to display.
        sendJson(response, 200, {
          ok: true,
          editable: false,
          config: publicConfig(options.liveConfig ?? {}),
          effective: { listen: resolveLiveListen() },
          interfaces,
        });
        return;
      }
      const entryConfig = entry.options?.config ?? {};
      sendJson(response, 200, {
        ok: true,
        editable: true,
        config: publicConfig(entryConfig),
        effective: { listen: resolveLiveListen() },
        interfaces,
      });
      return;
    }

    // POST: validate, then persist through the Loader so the row restarts with
    // the new config on the next activation.
    const editor = configEditor;
    if (editor === undefined || editor === null) {
      sendJson(response, 503, { ok: false, error: 'configNotEditable' });
      return;
    }
    const entry = editor.entries().find((candidate) => candidate.options?.name === PLUGIN_PACKAGE);
    if (entry === undefined) {
      sendJson(response, 503, { ok: false, error: 'configNotEditable' });
      return;
    }

    const body = await readJson(request);
    const current = entry.options?.config ?? {};
    const result = normalizeConfig(current, body);
    if (result.ok !== true) {
      sendJson(response, 400, { ok: false, error: result.error, field: result.field });
      return;
    }
    try {
      await editor.edit(entry, () => result.next);
    } catch (error) {
      logger?.warn?.(error);
      sendJson(response, 500, { ok: false, error: 'configWriteFailed' });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      config: publicConfig(result.next),
    });
  }

  /**
   * Answer one JSON API request from the in-app settings page.
   *
   * The page authenticates with the same session cookie as the HTML pages, so
   * a 401 here means the session died (sign-out elsewhere, or a password
   * change) and the client sends the browser back to the sign-in page.
   *
   * @param request - incoming request.
   * @param response - response to write.
   * @param route - endpoint name, relative to {@link API_PREFIX}.
   */
  async function handleApi(request, response, route) {
    const method = request.method ?? 'GET';
    // Reads: `/status`, `/config` and `/interfaces` answer GET. Writes and the
    // rest are POST-only.
    const allowed = route === '/config'
      ? (method === 'GET' || method === 'POST')
      : route === '/interfaces'
        ? method === 'GET'
        : method === 'POST' || (route === '/status' && method === 'GET');
    if (!allowed) {
      sendJson(response, 405, { ok: false, error: 'methodNotAllowed' });
      return;
    }

    // Creating the very first account is allowed without a session, exactly as
    // the HTML setup page is; every other endpoint needs a live one.
    if (route === '/setup' && !await hasAccount()) {
      if (!mayBootstrap()) {
        sendJson(response, 403, { ok: false, error: 'bootstrapLocalOnly' });
        return;
      }
      const body = await readJson(request);
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const confirm = String(body.confirm ?? '');
      if (!USERNAME_PATTERN.test(username)) {
        sendJson(response, 400, { ok: false, error: 'usernameInvalid' });
        return;
      }
      if (password.length < minPasswordLength) {
        sendJson(response, 400, { ok: false, error: 'passwordTooShort' });
        return;
      }
      if (password !== confirm) {
        sendJson(response, 400, { ok: false, error: 'passwordsDoNotMatch' });
        return;
      }
      await credentials.modifyRecord(PASSWORD_KEY, async (current) => {
        if (current?.kind === 'grant' && current.payload?.version === 1) return undefined;
        return { kind: 'grant', payload: { version: 1, username, hash: hashPassword(password) } };
      });
      await issueSession(response, request);
      sendJson(response, 200, { ok: true });
      return;
    }

    // `/status` tells the panel which shape to render. It must answer before a
    // session exists — the create-account form needs it — while never leaking
    // the username to an unauthenticated caller. So an unauthenticated request
    // learns only whether an account exists, which the sign-in page reveals
    // anyway by being a sign-in page.
    if (route === '/status') {
      const record = await readAccount();
      const hasAccount = record?.kind === 'grant';
      const signedIn = hasAccount && await authenticated(request);
      sendJson(response, 200, {
        ok: true,
        hasAccount,
        username: signedIn ? record.payload?.username ?? '' : '',
        totpEnabled: hasAccount && await totpEnabled(),
        totpAvailable,
        sessionDays,
        minPasswordLength,
      });
      return;
    }

    if (!await authenticated(request)) {
      sendJson(response, 401, { ok: false, error: 'unauthenticated' });
      return;
    }

    if (route === '/config') {
      await handleConfig(request, response, method);
      return;
    }

    // Interfaces change while the app runs (Wi-Fi joins, a cable is pulled), so
    // the panel re-reads them on demand instead of caching them in the config.
    if (route === '/interfaces') {
      sendJson(response, 200, {
        ok: true,
        interfaces: typeof listInterfaces === 'function' ? listInterfaces() : [],
      });
      return;
    }

    if (route === '/setup') {
      // An account already exists: the page shows the account editor instead.
      sendJson(response, 409, { ok: false, error: 'accountExists' });
      return;
    }

    if (route === '/username') {
      const body = await readJson(request);
      const username = String(body.username ?? '').trim();
      if (!USERNAME_PATTERN.test(username)) {
        sendJson(response, 400, { ok: false, error: 'usernameInvalid' });
        return;
      }
      await credentials.modifyRecord(PASSWORD_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        return { kind: 'grant', payload: { ...current.payload, username } };
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (route === '/password') {
      const body = await readJson(request);
      const password = String(body.password ?? '');
      const confirm = String(body.confirm ?? '');
      if (password.length < minPasswordLength) {
        sendJson(response, 400, { ok: false, error: 'passwordTooShort' });
        return;
      }
      if (password !== confirm) {
        sendJson(response, 400, { ok: false, error: 'passwordsDoNotMatch' });
        return;
      }
      await credentials.modifyRecord(PASSWORD_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        return { kind: 'grant', payload: { ...current.payload, hash: hashPassword(password) } };
      });
      // Only a password change revokes every session; a username change keeps it.
      await revokeAllSessions();
      sendJson(response, 200, { ok: true, revokedAll: true });
      return;
    }

    if (route === '/logout') {
      await revokeAllSessions();
      const authority = authorityOf(request);
      if (authority !== undefined) {
        response.setHeader('set-cookie', clearCookie(cookieNameFor(authority), secure));
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (route === '/totp/begin') {
      if (!totpAvailable) {
        sendJson(response, 400, { ok: false, error: 'totpUnavailable' });
        return;
      }
      if (await totpEnabled()) {
        // Going through begin on an enabled account would silently disable it.
        sendJson(response, 409, { ok: false, error: 'totpAlreadyEnabled' });
        return;
      }
      const secret = generateTotpSecret();
      await credentials.modifyRecord(TOTP_KEY, async () => ({
        kind: 'grant',
        payload: { version: 1, secret, enabled: false, lastUsedCounter: 0 },
      }));
      const record = await readAccount();
      const uri = totpUri(secret, record?.payload?.username ?? '', totpIssuer);
      sendJson(response, 200, { ok: true, secret, otpauthUri: uri, qrDataUri: qrDataUri(uri) });
      return;
    }

    if (route === '/totp/cancel') {
      const record = await readTotp();
      // Only an unconfirmed draft may be discarded this way.
      if (record?.kind === 'grant' && record.payload?.enabled !== true) {
        await credentials.deleteRecord(TOTP_KEY);
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (route === '/totp/confirm') {
      const body = await readJson(request);
      const record = await readTotp();
      const used = verifyTotp(
        record?.payload?.secret,
        String(body.code ?? ''),
        record?.payload?.lastUsedCounter ?? 0,
      );
      if (used === undefined) {
        sendJson(response, 400, { ok: false, error: 'wrongTotp' });
        return;
      }
      await credentials.modifyRecord(TOTP_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        // Do not consume the step: enrolment is already authenticated, and
        // consuming it would make the next sign-in look like a replay.
        return { kind: 'grant', payload: { ...current.payload, enabled: true, lastUsedCounter: 0 } };
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (route === '/totp/disable') {
      const body = await readJson(request);
      const record = await readTotp();
      const used = verifyTotp(
        record?.payload?.secret,
        String(body.code ?? ''),
        record?.payload?.lastUsedCounter ?? 0,
      );
      if (used === undefined) {
        sendJson(response, 400, { ok: false, error: 'wrongTotp' });
        return;
      }
      await credentials.deleteRecord(TOTP_KEY);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 404, { ok: false, error: 'notFound' });
  }

  /**
   * Answer one request, or allow it through.
   * @param request - incoming request.
   * @param response - response to write.
   * @param path - pathname.
   * @returns whether the request may proceed upstream.
   */
  async function handle(request, response, path) {
    const method = request.method ?? 'GET';
    const t = localeOf(request);

    // The in-app Security page talks JSON; it must be answered before the
    // catalogue of HTML routes, which would otherwise treat it as app traffic.
    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      const route = path.slice(API_PREFIX.length) || '/';
      if (!API_ROUTES.has(route)) {
        sendJson(response, 404, { ok: false, error: 'notFound' });
        return false;
      }
      try {
        await handleApi(request, response, route);
      } catch (error) {
        logger?.warn?.(error);
        if (!response.headersSent) sendJson(response, 500, { ok: false, error: 'serverError' });
        else response.destroy();
      }
      return false;
    }

    if (!GATE_PATHS.has(path)) {
      const account = await hasAccount();

      // API traffic must never receive an HTML page: a 200 carrying a login or
      // setup form reads as success to a fetch-based client, and the failure
      // then surfaces far from its cause. No account also means no credential
      // can exist, so the answer is the same 401 either way.
      if (isApiPath(path)) {
        if (account && await mayForward(request)) return true;
        sendText(response, 401, 'authentication required');
        return false;
      }

      // No account yet: whoever holds the bridge access key may create it, and
      // a loopback listener needs no key at all. Either way the shell itself
      // must not render before an account exists.
      if (!account) {
        const keyHolder = options.accessKeyValid?.(request) === true;
        sendHtml(response, 200, renderSetupPage({
          t,
          localOnly: !keyHolder && !mayBootstrap(),
        }));
        return false;
      }
      if (await mayForward(request)) return true;

      sendHtml(response, 200, renderLoginPage({
        t,
        needsTotp: await totpEnabled(),
        username: (await readAccount())?.payload?.username ?? '',
      }));
      return false;
    }

    if (path === '/start') {
      redirect(response, (await hasAccount()) ? './login' : './setup');
      return false;
    }

    if (path === '/login') {
      if (method === 'POST') {
        await handleLoginPost(request, response, t);
        return false;
      }
      sendHtml(response, 200, renderLoginPage({
        t,
        needsTotp: await totpEnabled(),
        username: (await readAccount())?.payload?.username ?? '',
      }));
      return false;
    }

    if (path === '/setup') {
      if (method === 'POST') {
        await handleSetupPost(request, response, t);
        return false;
      }
      sendHtml(response, 200, renderSetupPage({ t, localOnly: !mayBootstrap() }));
      return false;
    }

    // Everything below requires a live session.
    if (!await authenticated(request)) {
      redirect(response, 'login');
      return false;
    }

    if (path === '/logout') {
      // Signing out must end the session at the server: clearing the browser's
      // copy alone leaves any other copy of the same cookie valid.
      await revokeAllSessions();
      const authority = authorityOf(request);
      if (authority !== undefined) {
        response.setHeader('set-cookie', clearCookie(cookieNameFor(authority), secure));
      }
      redirect(response, 'login');
      return false;
    }

    if (path === '/account') {
      const pending = await readTotp();
      const record = await readAccount();
      const pendingTotp = pending?.kind === 'grant' && pending.payload?.enabled !== true
        ? {
          secret: pending.payload.secret,
          qrDataUri: qrDataUri(totpUri(
            pending.payload.secret,
            record?.payload?.username ?? '',
            totpIssuer,
          )),
        }
        : undefined;
      sendHtml(response, 200, renderAccountPage({
        t,
        username: record?.payload?.username ?? '',
        totpEnabled: await totpEnabled(),
        totpAvailable,
        pendingTotp,
        notice: undefined,
      }));
      return false;
    }

    if (method !== 'POST') {
      sendText(response, 405, t.methodNotAllowed);
      return false;
    }

    if (path === '/account/username') {
      const form = await readForm(request);
      const username = String(form.get('username') ?? '').trim();
      if (!USERNAME_PATTERN.test(username)) {
        sendHtml(response, 400, await accountPage(t, 'usernameInvalid'));
        return false;
      }
      await credentials.modifyRecord(PASSWORD_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        return { kind: 'grant', payload: { ...current.payload, username } };
      });
      sendHtml(response, 200, await accountPage(t, undefined, 'usernameChanged'));
      return false;
    }

    if (path === '/account/password') {
      const form = await readForm(request);
      const password = String(form.get('password') ?? '');
      const confirm = String(form.get('confirm') ?? '');
      if (password.length < minPasswordLength) {
        sendHtml(response, 400, await accountPage(t, 'passwordTooShort'));
        return false;
      }
      if (password !== confirm) {
        sendHtml(response, 400, await accountPage(t, 'passwordsDoNotMatch'));
        return false;
      }
      await credentials.modifyRecord(PASSWORD_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        return { kind: 'grant', payload: { ...current.payload, hash: hashPassword(password) } };
      });
      // Raising the generation expires every outstanding session at the server,
      // so a copy of an old cookie cannot be replayed. The stored signing secret
      // is left alone, and the Host's own key is never touched, so the desktop
      // window keeps working.
      await revokeAllSessions();
      const authority = authorityOf(request);
      if (authority !== undefined) {
        response.setHeader('set-cookie', clearCookie(cookieNameFor(authority), secure));
      }
      sendHtml(response, 200, renderLoginPage({ t, notice: 'passwordChanged', needsTotp: await totpEnabled() }));
      return false;
    }

    if (path === '/totp/begin') {
      if (!totpAvailable) {
        sendText(response, 404, t.notFound);
        return false;
      }
      if (await totpEnabled()) {
        // Going through begin on an enabled account would silently disable it.
        sendHtml(response, 409, await accountPage(t, 'wrongTotp'));
        return false;
      }
      await credentials.modifyRecord(TOTP_KEY, async () => ({
        kind: 'grant',
        payload: { version: 1, secret: generateTotpSecret(), enabled: false, lastUsedCounter: 0 },
      }));
      redirect(response, '../account');
      return false;
    }

    if (path === '/totp/cancel') {
      const record = await readTotp();
      if (record?.kind === 'grant' && record.payload?.enabled !== true) {
        await credentials.deleteRecord(TOTP_KEY);
      }
      redirect(response, '../account');
      return false;
    }

    if (path === '/totp/confirm') {
      const form = await readForm(request);
      const record = await readTotp();
      const used = verifyTotp(
        record?.payload?.secret,
        String(form.get('code') ?? ''),
        record?.payload?.lastUsedCounter ?? 0,
      );
      if (used === undefined) {
        sendHtml(response, 400, await accountPage(t, 'wrongTotp'));
        return false;
      }
      await credentials.modifyRecord(TOTP_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        // Do not consume the step here: enrolment is already authenticated,
        // and consuming it would make the next sign-in look like a replay.
        return { kind: 'grant', payload: { ...current.payload, enabled: true, lastUsedCounter: 0 } };
      });
      sendHtml(response, 200, renderAccountPage({
        t,
        username: (await readAccount())?.payload?.username ?? '',
        totpEnabled: true,
        totpAvailable,
        notice: 'totpEnabled',
      }));
      return false;
    }

    if (path === '/totp/disable') {
      const form = await readForm(request);
      const record = await readTotp();
      const used = verifyTotp(
        record?.payload?.secret,
        String(form.get('code') ?? ''),
        record?.payload?.lastUsedCounter ?? 0,
      );
      if (used === undefined) {
        sendHtml(response, 400, await accountPage(t, 'wrongTotp'));
        return false;
      }
      await credentials.deleteRecord(TOTP_KEY);
      sendHtml(response, 200, renderAccountPage({
        t,
        username: (await readAccount())?.payload?.username ?? '',
        totpEnabled: false,
        totpAvailable,
        notice: 'totpDisabled',
      }));
      return false;
    }

    sendText(response, 404, t.notFound);
    return false;
  }

  /** Handle POST /login. */
  async function handleLoginPost(request, response, t) {
    const source = sourceOf(request);
    const locked = lockoutFor(source);
    if (locked > 0) {
      sendHtml(response, 429, renderLoginPage({
        t,
        error: 'lockedOut',
        errorParams: { minutes: Math.ceil(locked / 60_000) },
      }));
      return;
    }
    const form = await readForm(request);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    const record = await readAccount();
    const payload = record?.kind === 'grant' ? record.payload : undefined;
    const userMatches = payload?.username === username;
    const passwordMatches = userMatches && verifyPassword(password, payload?.hash);
    if (!userMatches || !passwordMatches) {
      recordFailure(source);
      sendHtml(response, 401, renderLoginPage({
        t, error: 'wrongCredentials', username, needsTotp: await totpEnabled(),
      }));
      return;
    }
    if (await totpEnabled()) {
      const code = String(form.get('totp') ?? '');
      const totpRecord = await readTotp();
      const used = verifyTotp(
        totpRecord?.payload?.secret,
        code,
        totpRecord?.payload?.lastUsedCounter ?? 0,
      );
      if (used === undefined) {
        recordFailure(source);
        sendHtml(response, 401, renderLoginPage({
          t, error: 'wrongTotp', username, needsTotp: true,
        }));
        return;
      }
      // Consume the step so the same code cannot be replayed.
      await credentials.modifyRecord(TOTP_KEY, async (current) => {
        if (current?.kind !== 'grant') return undefined;
        return { kind: 'grant', payload: { ...current.payload, lastUsedCounter: used } };
      });
    }
    failures.delete(source);
    if (!await issueSession(response, request)) {
      sendHtml(response, 500, renderErrorPage({ t, status: 500, message: t.serverError }));
      return;
    }
    redirect(response, './');
  }

  /** Handle POST /setup: create the first account. */
  async function handleSetupPost(request, response, t) {
    if (await hasAccount()) {
      redirect(response, 'login');
      return;
    }
    if (!mayBootstrap()) {
      sendHtml(response, 403, renderSetupPage({ t, localOnly: true }));
      return;
    }
    const form = await readForm(request);
    const username = String(form.get('username') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (!USERNAME_PATTERN.test(username)) {
      sendHtml(response, 400, renderSetupPage({ t, error: 'usernameInvalid' }));
      return;
    }
    if (password.length < minPasswordLength) {
      sendHtml(response, 400, renderSetupPage({ t, error: 'passwordTooShort' }));
      return;
    }
    if (password !== confirm) {
      sendHtml(response, 400, renderSetupPage({ t, error: 'passwordsDoNotMatch' }));
      return;
    }
    await credentials.modifyRecord(PASSWORD_KEY, async (current) => {
      // A concurrent setup must not overwrite the account that won the race.
      if (current?.kind === 'grant' && current.payload?.version === 1) return undefined;
      return { kind: 'grant', payload: { version: 1, username, hash: hashPassword(password) } };
    });
    if (!await issueSession(response, request)) {
      sendHtml(response, 500, renderErrorPage({ t, status: 500, message: t.serverError }));
      return;
    }
    redirect(response, './');
  }

  return {
    handle,
    authenticated,
    mayForward,
    hasAccount,
    totpEnabled,
    mayBootstrap,
    ensureSigningKey,
  };
}
