/**
 * Serve this desktop application's own Web GUI to another address.
 *
 * The desktop app already runs a complete Web Host for its own window: the
 * `webServer` listener and the `connection` authentication that the window's
 * page uses. This plugin publishes that same Host on a second listener, so a
 * browser and the desktop window are two clients of one process — every
 * session, plugin, workspace and background job is shared, because nothing is
 * duplicated.
 *
 * Running inside the Host removes the two problems an external proxy has:
 * the Host port is known (`ctx.webServer.getOrigin()`), and authentication is
 * granted by the Host itself (`ctx.connection.authenticatedUrl()`), so no
 * credential file is read and no cookie is forged. The plugin performs a
 * single internal token exchange, keeps the resulting session cookie in
 * memory, and injects it upstream. The browser only ever holds this plugin's
 * own access cookie.
 *
 * @module @local/dsh-desktop-web
 */

import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createGate } from './gate.js';
import {
  DEFAULT_PORT,
  interfaceOfAddress,
  listInterfaces,
  resolveBindings,
} from './interfaces.js';

/** Plugin identity used by the Loader. */
export const name = 'desktop-web';

/** Services this plugin cannot run without. */
export const inject = ['webServer', 'connection', 'credentials'];

/** Browser cookie carrying this plugin's access key. */
const ACCESS_COOKIE = 'dsh-bridge';

/** Query parameter that performs the one-time key handshake. */
const ACCESS_QUERY = 'key';

/** Where the served URL is reported back to the user. */
const URL_FILE = 'desktop-web.url';

/**
 * Parse a `host:port` listen value, accepting a bracketed IPv6 host.
 * @param value - configured listen address.
 * @returns the bind host and port.
 */
function parseListen(value) {
  const text = String(value ?? '127.0.0.1:8090').trim();
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(text);
  if (bracketed !== null) return { host: bracketed[1], port: Number(bracketed[2]) };
  const at = text.lastIndexOf(':');
  if (at === -1) return { host: text, port: 8090 };
  return { host: text.slice(0, at), port: Number(text.slice(at + 1)) };
}

/**
 * Constant-time comparison that tolerates different lengths.
 * @param actual - presented value.
 * @param expected - configured value.
 * @returns whether they match.
 */
function secretMatches(actual, expected) {
  const left = Buffer.from(String(actual ?? ''), 'utf8');
  const right = Buffer.from(String(expected ?? ''), 'utf8');
  if (left.length !== right.length || right.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Collect `name=value` pairs from every Cookie header.
 * @param header - IncomingMessage Cookie header value.
 * @returns a name-to-value map.
 */
function parseCookieHeader(header) {
  const jar = new Map();
  if (typeof header !== 'string') return jar;
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    const key = segment.slice(0, at).trim();
    if (key !== '') jar.set(key, segment.slice(at + 1).trim());
  }
  return jar;
}

/**
 * Read one query parameter without constructing a URL for relative targets.
 * @param query - raw query string.
 * @param wanted - parameter name.
 * @returns the decoded value, or undefined.
 */
function queryValue(query, wanted) {
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    const key = at === -1 ? pair : pair.slice(0, at);
    if (key !== wanted) continue;
    try {
      return decodeURIComponent((at === -1 ? '' : pair.slice(at + 1)).replaceAll('+', ' '));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Split a request target into path and query.
 * @param target - request target from the request line.
 * @returns the two halves; the query may be empty.
 */
function splitTarget(target) {
  const at = target.indexOf('?');
  return at === -1 ? [target, ''] : [target.slice(0, at), target.slice(at + 1)];
}

/**
 * Rebuild a query string without one parameter.
 * @param query - raw query string.
 * @param unwanted - parameter name to drop.
 * @returns the remaining query, possibly empty.
 */
function withoutQuery(query, unwanted) {
  return query
    .split('&')
    .filter((pair) => pair !== '' && (pair.indexOf('=') === -1 ? pair : pair.slice(0, pair.indexOf('='))) !== unwanted)
    .join('&');
}

/**
 * Normalize the `listen` setting into a list of `{ host, port }` bindings.
 *
 * A single string stays supported for existing profiles; an array binds one
 * listener per entry, which is how one desktop app serves several networks
 * (loopback, LAN, tailnet) at once. A bare port means loopback, matching a
 * human reading "8091" as "just this machine".
 * @param value - configured `listen` value.
 * @returns the bindings to open.
 */
function parseListens(value) {
  const entries = Array.isArray(value) ? value : [value ?? '127.0.0.1:8091'];
  const bindings = [];
  const seen = new Set();
  for (const entry of entries) {
    const text = String(entry ?? '').trim();
    if (text === '') continue;
    const binding = /^\d+$/u.test(text)
      ? { host: '127.0.0.1', port: Number(text) }
      : parseListen(text);
    if (!Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65535) {
      throw new Error(`desktop-web: listen ${JSON.stringify(text)} has no usable port`);
    }
    const key = `${binding.host}:${binding.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push(binding);
  }
  if (bindings.length === 0) {
    throw new Error('desktop-web: listen names no address; configure at least one host:port');
  }
  return bindings;
}

/**
 * Decide which addresses to bind, preferring interface names over fixed IPs.
 *
 * This is the whole point of the `bind` form: a laptop that gets a new DHCP
 * lease, or a tailnet that renumbers, keeps working because the address is read
 * from the named interface at every launch instead of being frozen in the
 * config.
 *
 * `bind` wins over `listen` when both are present, so migrating does not create
 * duplicate listeners. A name that is not currently available is reported and
 * skipped; if none of them resolve (Wi-Fi off at boot) the bridge still comes up
 * on loopback rather than failing the whole plugin, so the panel stays reachable
 * to fix it.
 *
 * @param settings - the row config.
 * @returns `{ bindings, warnings, source }`.
 */
function planBindings(settings) {
  const names = (Array.isArray(settings.bind) ? settings.bind : [])
    .map((name) => String(name ?? '').trim())
    .filter((name) => name !== '');
  const port = Number.isInteger(settings.port) ? settings.port : DEFAULT_PORT;
  const warnings = [];

  if (names.length > 0) {
    const resolved = resolveBindings(names, port);
    warnings.push(...resolved.warnings);
    if (resolved.bindings.length > 0) {
      return { bindings: resolved.bindings, warnings, source: 'bind' };
    }
    warnings.push(`none of the configured interfaces is usable; falling back to loopback:${port}`);
    return { bindings: [{ host: '127.0.0.1', port, interface: undefined }], warnings, source: 'fallback' };
  }

  return { bindings: parseListens(settings.listen), warnings, source: 'listen' };
}

/**
 * Adjust an upstream response's headers for the browser.
 *
 * Two things must not survive the hop:
 *
 * 1. **Upstream session cookies.** The browser never holds a DSH credential;
 *    only this plugin's own cookie crosses the boundary.
 * 2. **Cacheability of HTML documents.** The index embeds the client module
 *    graph together with its current revisions. A browser that reuses a cached
 *    copy keeps requesting revisions the Host has since dropped, and every one
 *    of those bundle URLs is a 404 — which the app surfaces much later as
 *    "Failed to load plugins / @…: import failed". Documents are therefore
 *    marked uncacheable; content-hashed assets keep whatever caching they had.
 *
 * @param upstream - headers as received from the Host.
 * @returns headers safe to send to the browser.
 */
export function browserHeaders(upstream) {
  const headers = { ...upstream };
  delete headers['set-cookie'];

  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('text/html')) {
    headers['cache-control'] = 'no-store, must-revalidate';
    delete headers.etag;
    delete headers['last-modified'];
    delete headers.expires;
  }
  return headers;
}

/**
 * Publish this application's Web GUI on one or more additional listeners.
 * @param ctx - profile context carrying the Web carrier and Connection.
 * @param config - `listen`, `accessKey`, and `reportFile` settings.
 */
export function apply(ctx, config) {
  const settings = config ?? {};
  const plan = planBindings(settings);
  const bindings = plan.bindings;
  const credentials = ctx.credentials;

  for (const warning of plan.warnings) {
    ctx.logger('desktop-web').warn(warning);
  }

  const accessKey = typeof settings.accessKey === 'string' && settings.accessKey !== ''
    ? settings.accessKey
    : randomBytes(18).toString('base64url');

  /** Upstream authority and the internal session cookie, resolved lazily. */
  let cached;

  /**
   * Addresses this process actually bound, published once listening starts.
   *
   * The configuration panel distinguishes "saved in the patch" from "listening
   * right now", and only this process knows the second.
   */
  let boundAddresses = [];

  /**
   * Resolve the upstream origin and its session cookie, exchanging the running
   * Host's own launch token once. The Host port is stable for this process, so
   * the result is cached for the process lifetime.
   * @returns the upstream authority and injected cookie header.
   */
  async function resolveUpstream() {
    if (cached !== undefined) return cached;
    const origin = new URL(ctx.webServer.getOrigin());
    const tokenized = new URL(ctx.connection.authenticatedUrl(origin.origin));
    const cookie = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          protocol: tokenized.protocol,
          hostname: tokenized.hostname,
          port: tokenized.port,
          path: `${tokenized.pathname}${tokenized.search}`,
          method: 'GET',
          headers: { host: origin.host, accept: 'text/html' },
        },
        (response) => {
          const header = response.headers['set-cookie'];
          response.resume();
          response.on('end', () => {
            const values = header === undefined ? [] : Array.isArray(header) ? header : [header];
            const pairs = values.map((value) => String(value).split(';', 1)[0]).filter((value) => value.includes('='));
            resolve(pairs.length === 0 ? undefined : pairs.join('; '));
          });
        },
      );
      request.setTimeout(15000, () => request.destroy(new Error('desktop-web: upstream token exchange timed out')));
      request.on('error', reject);
      request.end();
    });
    if (cookie === undefined) {
      throw new Error('desktop-web: the Host did not answer the launch-token exchange');
    }
    cached = { authority: origin.host, cookie };
    return cached;
  }

  /**
   * Rewrite one request's headers for the upstream Host.
   * @param upstream - resolved upstream authority and cookie.
   * @param incoming - headers from the browser request.
   * @param withBody - whether a body follows, which keeps framing headers.
   * @returns the headers to send upstream.
   */
  function upstreamHeaders(upstream, incoming, withBody) {
    const headers = {};
    for (const [rawName, value] of Object.entries(incoming)) {
      const key = rawName.toLowerCase();
      if (value === undefined) continue;
      // Authority, credentials and framing are all owned here.
      if (key === 'host' || key === 'origin' || key === 'cookie' || key === 'expect') continue;
      if (key === 'connection' && !withBody) continue;
      headers[key] = value;
    }
    headers.host = upstream.authority;
    if (incoming.origin !== undefined) headers.origin = `http://${upstream.authority}`;
    headers.cookie = upstream.cookie;
    return headers;
  }

  /**
   * Answer one request with a short diagnostic body.
   * @param response - browser response.
   * @param status - HTTP status code.
   * @param message - text shown to the browser.
   */
  function deny(response, status, message) {
    const body = Buffer.from(`dsh desktop web: ${message}\n`, 'utf8');
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      connection: 'close',
    });
    response.end(body);
  }

  /**
   * Forward one ordinary HTTP request to the Host.
   * @param request - browser request.
   * @param response - browser response.
   * @param gate - the password gate guarding this listener.
   */
  async function forward(request, response, gate) {
    const [path, query] = splitTarget(request.url ?? '/');
    if (queryValue(query, ACCESS_QUERY) !== undefined) {
      // Handshake: a correct key becomes the access cookie, and the key is
      // dropped from the URL the browser keeps. It no longer signs anyone in
      // once an account exists; it only bootstraps account creation.
      if (!secretMatches(queryValue(query, ACCESS_QUERY), accessKey)) {
        deny(response, 401, 'invalid access key');
        return;
      }
      const remaining = withoutQuery(query, ACCESS_QUERY);
      const location = path === '/' ? './' : `${path}${remaining === '' ? '' : `?${remaining}`}`;
      response.writeHead(303, {
        location,
        'set-cookie': `${ACCESS_COOKIE}=${accessKey}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict`,
        'cache-control': 'no-store',
        'content-length': '0',
        connection: 'close',
      });
      response.end();
      return;
    }

    // The gate guards every path, not just the shell: this listener injects the
    // Host's owner cookie upstream, so an unguarded `/api/*` would hand out
    // owner access with no password at all.
    const allowed = await gate.handle(request, response, path);
    if (!allowed) return;

    let upstream;
    try {
      upstream = await resolveUpstream();
    } catch (error) {
      deny(response, 503, error instanceof Error ? error.message : String(error));
      return;
    }

    const target = httpRequest({
      host: '127.0.0.1',
      port: Number(upstream.authority.slice(upstream.authority.lastIndexOf(':') + 1)),
      method: request.method,
      path: request.url ?? '/',
      headers: upstreamHeaders(upstream, request.headers, request.method !== 'GET' && request.method !== 'HEAD'),
    });
    target.setTimeout(0);
    target.on('error', (error) => {
      if (!response.headersSent) deny(response, 502, `upstream request failed: ${error.message}`);
      else response.destroy();
    });
    target.on('response', (answer) => {
      const headers = browserHeaders(answer.headers);
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
      answer.pipe(response);
      answer.on('error', () => response.destroy());
    });
    request.pipe(target);
  }

  /**
   * Forward one protocol upgrade, such as the Remote mux WebSocket.
   * @param request - browser upgrade request.
   * @param socket - browser socket.
   * @param head - bytes already read past the request head.
   * @param gate - the password gate guarding this listener.
   */
  async function forwardUpgrade(request, socket, head, gate) {
    // The upgrade carries a live authenticated stream, so it must clear the
    // same gate as HTTP: an unchecked upgrade would bypass the password entirely.
    if (!await gate.mayForward(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let upstream;
    try {
      upstream = await resolveUpstream();
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const authority = upstream.authority;
    const socketTarget = netConnect(Number(authority.slice(authority.lastIndexOf(':') + 1)), '127.0.0.1');
    socketTarget.on('error', () => socket.destroy());
    socket.on('error', () => socketTarget.destroy());
    socketTarget.on('connect', () => {
      const forwarded = upstreamHeaders(upstream, request.headers, true);
      const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
      for (const [key, value] of Object.entries(forwarded)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const entry of value) lines.push(`${key}: ${entry}`);
        else lines.push(`${key}: ${value}`);
      }
      lines.push('', '');
      socketTarget.write(lines.join('\r\n'));
      if (head.length > 0) socketTarget.write(head);
      socket.pipe(socketTarget);
      socketTarget.pipe(socket);
    });
    socketTarget.on('close', () => socket.destroy());
  }

  /** Every bound listener, closed together when the plugin unloads. */
  const servers = [];

  // Cordis treats an effect's returned value as a disposal handle, not as a
  // setup promise: returning one from an async function silently loses the
  // listened socket's lifetime and swallows listen failures. So the effect
  // returns its disposer synchronously and the asynchronous start reports its
  // own failures through the logger.
  const reportPath = typeof settings.reportFile === 'string' && settings.reportFile !== ''
    ? settings.reportFile
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), URL_FILE);

  const started = (async () => {
    // One listener per configured address. A failure to bind one address must
    // not take down the others: a tailnet address can be missing while WSL
    // holds a port, and the user still wants loopback to work.
    const bound = [];
    await Promise.all(bindings.map(async (binding) => {
      // One gate per listener: bootstrap authority is a property of the bind
      // address, so the loopback listener may create the first account while a
      // LAN or tailnet listener may not.
      const gate = createGate({
        credentials,
        logger: ctx.logger('desktop-web'),
        listenHost: binding.host,
        // This listener serves plain HTTP: TLS belongs to the reverse proxy in
        // front of it, which also means the gate's cookie cannot be `Secure`.
        secure: false,
        sessionDays: settings.sessionDays ?? 30,
        minPasswordLength: settings.minPasswordLength ?? 8,
        maxAttempts: settings.maxAttempts ?? 5,
        lockoutMs: settings.lockoutMs ?? 300_000,
        totpIssuer: settings.totpIssuer ?? 'DSH',
        totpAvailable: settings.totpAvailable ?? true,
        bootstrapLoopbackOnly: settings.bootstrapLoopbackOnly ?? true,
        // The Security panel is reachable over the bridge too, so this listener
        // needs the same configuration surface as the Host-mounted one.
        // A save reconciles the Loader row, which disposes these servers;
        // `server.close()` only stops accepting, so the in-flight response
        // still completes before the new listeners take over.
        configEditor: ctx.get('configEditor'),
        liveConfig: settings,
        liveListen: () => boundAddresses,
        listInterfaces,
        accessKeyValid: (request) => {
          const [, query] = splitTarget(request.url ?? '/');
          if (secretMatches(queryValue(query, ACCESS_QUERY), accessKey)) return true;
          const jar = parseCookieHeader(request.headers.cookie);
          return secretMatches(jar.get(ACCESS_COOKIE), accessKey);
        },
      });

      const server = createServer((request, response) => {
        forward(request, response, gate).catch((error) => {
          if (!response.headersSent) deny(response, 500, error instanceof Error ? error.message : String(error));
          else response.destroy();
        });
      });
      server.on('upgrade', (request, socket, head) => {
        forwardUpgrade(request, socket, head, gate).catch(() => socket.destroy());
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(binding.port, binding.host, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        // Report the address that failed and keep the remaining listeners.
        ctx.logger('desktop-web').warn(
          `cannot listen on ${binding.host}:${binding.port}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      server.on('error', (error) => ctx.logger('desktop-web').warn(error));
      servers.push(server);
      bound.push({ host: binding.host, port: server.address().port });
    }));

    if (bound.length === 0) throw new Error('desktop-web: no configured address could be bound');

    // Publish what actually bound so the configuration panel can show the
    // difference between "saved" and "listening right now".
    boundAddresses = bound.map(({ host, port }) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`));

    const addresses = bound.map(({ host, port }) => ({
      shown: host.includes(':') ? `[${host}]` : host,
      port,
    }));
    ctx.logger('desktop-web').info(
      `serving this desktop Host at ${addresses.map((a) => `${a.shown}:${a.port}`).join(', ')}`,
    );

    // The desktop Host runs without a console, so leave the keyed URLs where a
    // human can read them instead of relying on log output.
    try {
      await mkdir(join(reportPath, '..'), { recursive: true });
      await writeFile(
        reportPath,
        [
          '# DeepSeek Harness desktop Web access',
          '#',
          '# Open one of these URLs once per browser. It sets the access cookie',
          '# and the browser then uses the bare address for 1 year.',
          '',
          ...addresses.map(({ shown, port }) => `http://${shown}:${port}/?${ACCESS_QUERY}=${accessKey}`),
          '',
          `# upstream: ${ctx.webServer.getOrigin()}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
    } catch (error) {
      ctx.logger('desktop-web').warn(`could not write ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  started.catch((error) => {
    ctx.logger('desktop-web').error(error);
  });

  // The Security panel is a Client plugin, so it runs wherever the Web UI runs.
  // That includes the desktop window, whose `dsh-app://app/*` requests for
  // anything outside the built dist are forwarded to this Host — not to the
  // bridge listener. Mounting the same JSON API here is what lets the panel
  // read state in both places; without it the panel renders and then fails to
  // load, which reads as a broken plugin.
  //
  // A plugin Web route is NOT behind the Host's fence by default: `/` answers
  // 401 while a bare prefix route answers 200. These routes manage the account,
  // so they must apply the same admission the rest of the Host does, or any
  // local process could change the bridge password. `requestRejection` covers
  // the Host/Origin checks and `admit` the signed credential.
  const connection = ctx.connection;

  /** Whether this request carries the Host's own owner credential. */
  function hostOwnerAdmitted(request) {
    if (connection.requestRejection(request) !== undefined) return false;
    const admission = connection.admit(request);
    return admission?.rejection === undefined && admission?.peer?.principal?.kind === 'owner';
  }

  const hostGate = createGate({
    credentials,
    logger: ctx.logger('desktop-web'),
    listenHost: '127.0.0.1',
    secure: false,
    sessionDays: settings.sessionDays ?? 30,
    minPasswordLength: settings.minPasswordLength ?? 8,
    maxAttempts: settings.maxAttempts ?? 5,
    lockoutMs: settings.lockoutMs ?? 300_000,
    totpIssuer: settings.totpIssuer ?? 'DSH',
    totpAvailable: settings.totpAvailable ?? true,
    bootstrapLoopbackOnly: settings.bootstrapLoopbackOnly ?? true,
    // The admission check above already established the caller is this Host's
    // owner, so the panel manages the account instead of being sent to sign in.
    trustedCaller: true,
    // The configuration panel writes through the Loader, so a saved address is
    // the same value a hand-edited patch would carry. Optional: a profile
    // without a writable patch still reads configuration, just not saves.
    configEditor: ctx.get('configEditor'),
    liveConfig: settings,
    listInterfaces,
    // What this process actually bound, which is what "effective" means to the
    // panel until the row restarts with a new address.
    liveListen: () => boundAddresses,
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/desktop-web',
    handler: (request, response) => {
      if (!hostOwnerAdmitted(request)) {
        response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('authentication required');
        return;
      }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      void hostGate.handle(request, response, path).catch((error) => {
        ctx.logger('desktop-web').warn(error);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: 'serverError' }));
        } else {
          response.destroy();
        }
      });
    },
  }), 'desktop-web: host api route');

  ctx.effect(() => () => {
    started.catch(() => {});
    return Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  }, 'desktop-web.listen');
}
