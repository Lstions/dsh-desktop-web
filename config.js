/**
 * Read and write this plugin's own row configuration.
 *
 * The bridge's listen addresses, access key and policy knobs are ordinary
 * Loader row config, so the panel edits the *live* row through
 * `ctx.configEditor` rather than keeping a parallel settings file. That means a
 * save goes through the same validation and the same profile patch a human
 * would edit by hand, and there is exactly one source of truth.
 *
 * One consequence drives the whole shape of this module: the listeners are
 * opened in `apply`, so changing an address cannot take effect without the row
 * restarting. A save therefore reports `restartRequired` and the panel says so,
 * instead of pretending the new address is already serving.
 *
 * @module dsh-desktop-web/config
 */

import { DEFAULT_PORT } from './interfaces.js';

/**
 * The subset of config this panel exposes, with the shape each field takes.
 *
 * Only values the panel can validate without guessing are listed; anything not
 * named here is preserved untouched on save, so a hand-written patch keeps
 * working.
 */
export const EDITABLE_FIELDS = ['bind', 'port', 'listen', 'accessKey', 'sessionDays', 'bootstrapLoopbackOnly', 'maxAttempts', 'lockoutMs', 'minPasswordLength', 'totpIssuer', 'totpAvailable'];

/** Hostname or IPv4/IPv6 literal, optionally with an explicit port. */
const ADDRESS_PATTERN = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/u;

/**
 * Normalize the listen list into the address strings a user sees.
 * @param value - configured `listen` value (string or list).
 * @returns the addresses, in configured order.
 */
export function listenList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? '').trim())
      .filter((entry) => entry !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}

/**
 * Validate one address entry.
 * @param entry - raw address text.
 * @returns an error code, or undefined when acceptable.
 */
export function addressProblem(entry) {
  const text = String(entry ?? '').trim();
  if (text === '') return 'addressEmpty';
  if (!ADDRESS_PATTERN.test(text)) return 'addressInvalid';
  // A bare port is refused here because the panel shows full addresses and a
  // typo'd "8091" would silently bind loopback on a different port than read.
  if (/^\d+$/u.test(text)) return 'addressNeedsHost';
  const portText = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : undefined;
  if (portText !== undefined && !/^\d+$/u.test(portText)) return 'addressInvalid';
  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'portInvalid';
  }
  // A wildcard is what the Host's own carrier refuses; accept the same rule so
  // the panel cannot configure an address that is guaranteed to fail at bind.
  const host = text.startsWith('[')
    ? text.slice(1, text.indexOf(']'))
    : portText === undefined ? text : text.slice(0, text.lastIndexOf(':'));
  if (host === '0.0.0.0' || host === '::' || host === '') return 'addressWildcard';
  return undefined;
}

/**
 * Validate and normalize a whole save request.
 *
 * @param current - the row's current config.
 * @param input - what the panel submitted.
 * @returns `{ ok: true, next }` with the config to persist, or `{ ok: false, error, field }`.
 */
export function normalizeConfig(current, input) {
  const next = { ...current };

  // Interface names are the preferred form: they survive an address change.
  if (input.bind !== undefined) {
    const names = Array.isArray(input.bind) ? input.bind : [input.bind];
    const seen = new Set();
    const cleaned = [];
    for (const raw of names) {
      const name = String(raw ?? '').trim();
      if (name === '') continue;
      if (name.length > 128) return { ok: false, error: 'interfaceInvalid', field: 'bind' };
      if (seen.has(name)) continue;
      seen.add(name);
      cleaned.push(name);
    }
    next.bind = cleaned;
  }

  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'portInvalid', field: 'port' };
    }
    next.port = port;
  }

  if (input.listen !== undefined) {
    const addresses = listenList(input.listen);
    const seen = new Set();
    const cleaned = [];
    for (const entry of addresses) {
      const problem = addressProblem(entry);
      if (problem !== undefined) return { ok: false, error: problem, field: 'listen' };
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(entry);
    }
    next.listen = cleaned;
  }

  // One of the two forms must produce at least one listener. Interface names
  // win at runtime, so a stale `listen` list alone is not enough once `bind`
  // is set — but requiring both to be non-empty would block either migration
  // direction, so the check is "at least one".
  const bindCount = Array.isArray(next.bind) ? next.bind.length : 0;
  const listenCount = listenList(next.listen).length;
  if (bindCount === 0 && listenCount === 0) {
    return { ok: false, error: 'bindEmpty', field: 'bind' };
  }

  if (input.accessKey !== undefined) {
    const key = String(input.accessKey ?? '').trim();
    // An empty key means "generate one per launch", which is a real choice and
    // not an error; a short key would be a false sense of security.
    if (key !== '' && key.length < 16) return { ok: false, error: 'accessKeyTooShort', field: 'accessKey' };
    next.accessKey = key;
  }

  const numberField = (name, min, max) => {
    if (input[name] === undefined) return undefined;
    const value = Number(input[name]);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      return { ok: false, error: 'numberOutOfRange', field: name };
    }
    next[name] = value;
    return undefined;
  };

  const sessionProblem = numberField('sessionDays', 1, 3650);
  if (sessionProblem !== undefined) return sessionProblem;
  const attemptsProblem = numberField('maxAttempts', 1, 100);
  if (attemptsProblem !== undefined) return attemptsProblem;
  const lockoutProblem = numberField('lockoutMs', 1000, 86_400_000);
  if (lockoutProblem !== undefined) return lockoutProblem;
  const minPasswordProblem = numberField('minPasswordLength', 4, 256);
  if (minPasswordProblem !== undefined) return minPasswordProblem;

  if (input.bootstrapLoopbackOnly !== undefined) next.bootstrapLoopbackOnly = input.bootstrapLoopbackOnly === true;
  if (input.totpAvailable !== undefined) next.totpAvailable = input.totpAvailable === true;

  if (input.totpIssuer !== undefined) {
    const issuer = String(input.totpIssuer ?? '').trim();
    if (issuer === '' || issuer.length > 64) return { ok: false, error: 'issuerInvalid', field: 'totpIssuer' };
    next.totpIssuer = issuer;
  }

  return { ok: true, next };
}

/**
 * Project the row config into the shape the panel renders.
 * @param config - live row config.
 * @returns the editable view.
 */
export function publicConfig(config) {
  const source = config ?? {};
  const bind = Array.isArray(source.bind)
    ? source.bind.map((name) => String(name ?? '').trim()).filter((name) => name !== '')
    : [];
  return {
    bind,
    port: Number.isInteger(source.port) ? source.port : DEFAULT_PORT,
    listen: listenList(source.listen),
    accessKey: typeof source.accessKey === 'string' ? source.accessKey : '',
    sessionDays: source.sessionDays ?? 30,
    bootstrapLoopbackOnly: source.bootstrapLoopbackOnly !== false,
    maxAttempts: source.maxAttempts ?? 5,
    lockoutMs: source.lockoutMs ?? 300_000,
    minPasswordLength: source.minPasswordLength ?? 8,
    totpIssuer: source.totpIssuer ?? 'DSH',
    totpAvailable: source.totpAvailable !== false,
  };
}
