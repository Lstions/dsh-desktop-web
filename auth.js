/**
 * Password, session and TOTP primitives for the desktop Web bridge.
 *
 * Ported from `dsh-web-password-auth` (MIT, github.com/Lstions/dsh-web-password-auth)
 * so the desktop bridge can offer the same real features — password sign-in,
 * persistent sessions, in-app account management and TOTP two-factor — without
 * adding a second plugin whose routing assumptions do not hold for a second
 * listener. Three parts, no Cordis dependency, all independently testable:
 *
 * 1. Session cookies: byte-compatible with `@deepseek-ai/dsh-client-connection`,
 *    so the very same value authenticates against the desktop Host. The Host
 *    accepts `v1.<body>.<hmac>` with a base64url JSON payload bound to one
 *    authority.
 * 2. Password hashing: scrypt, with the parameters stored beside each hash so
 *    they can be raised later.
 * 3. TOTP: RFC 6238 / RFC 4226, verified against the published vectors.
 *
 * @module dsh-desktop-web/auth
 */

import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/** Cookie name prefix shared with the Host's browser authentication. */
const COOKIE_PREFIX = 'dsh-auth-';

/** Cookie value format version the Host verifies. */
const COOKIE_VERSION = 'v1';

/** Signing key length the Host generates. */
const SECRET_BYTES = 32;

/** One day in milliseconds. */
export const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/** base64url with no padding, `+`→`-`, `/`→`_`. */
export function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/** Strict base64url decode; returns undefined rather than guessing. */
export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  if (value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
  // Round-trip so lenient decoding cannot turn garbage into bytes.
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/**
 * Cookie name for one authority: `dsh-auth-` + base64url(sha256(authority)).
 * @param authority - `host:port` over HTTP, or the origin over HTTPS.
 */
export function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

/**
 * The audience a request's cookie must be bound to.
 * @param headers - node:http request headers.
 * @param secure - whether the listener serves TLS.
 * @returns the authority text, or undefined when Host is missing or unparsable.
 */
export function requestAuthority(headers, secure) {
  const host = headers?.host;
  if (typeof host !== 'string' || host === '') return undefined;
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`);
    return secure ? url.origin : url.host;
  } catch {
    return undefined;
  }
}

/**
 * Mint one session cookie value.
 * @param secret - 32-byte HMAC key.
 * @param authority - request audience.
 * @param issuedAt - issue time in milliseconds.
 * @param expiresAt - expiry time in milliseconds.
 * @returns the cookie value, including the `v1.` prefix.
 */
export function mintCookieValue(secret, authority, issuedAt, expiresAt) {
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  return `${COOKIE_VERSION}.${body}.${signature}`;
}

/**
 * Verify one session cookie value; semantics match the Host's own verifier.
 * @param value - cookie value.
 * @param secret - 32-byte HMAC key.
 * @param authority - expected audience.
 * @param maxAgeMilliseconds - longest accepted issue-to-expiry span.
 * @param now - current time in milliseconds, injectable for tests.
 * @returns the payload, or undefined when any check fails.
 */
export function verifyCookieValue(value, secret, authority, maxAgeMilliseconds, now = Date.now()) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [version, body, encodedSignature] = parts;
  if (version !== COOKIE_VERSION || body === undefined || encodedSignature === undefined) {
    return undefined;
  }

  const actual = decodeBase64Url(encodedSignature);
  if (actual === undefined) return undefined;
  const expected = createHmac('sha256', secret).update(body).digest();
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return undefined;
  }

  const bodyBytes = decodeBase64Url(body);
  if (bodyBytes === undefined) return undefined;
  let payload;
  try {
    payload = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  if (payload.version !== 1) return undefined;
  if (typeof payload.authority !== 'string' || payload.authority !== authority) return undefined;
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) {
    return undefined;
  }
  if (payload.issuedAt > now || payload.expiresAt <= now) return undefined;
  if (payload.expiresAt <= payload.issuedAt) return undefined;
  if (payload.expiresAt - payload.issuedAt > maxAgeMilliseconds) return undefined;
  return payload;
}

/** Read one exact cookie by name from a Cookie header. */
export function readCookieValue(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Serialize Set-Cookie attributes the way the Host does.
 * @param name - cookie name.
 * @param value - cookie value; empty deletes it.
 * @param options - `expiresAt`, `maxAgeSeconds`, and `secure`.
 */
export function sessionCookie(name, value, { expiresAt, maxAgeSeconds, secure }) {
  const parts = [`${name}=${value}`, `Max-Age=${String(maxAgeSeconds)}`, 'Path=/'];
  if (expiresAt !== undefined) parts.push(`Expires=${new Date(expiresAt).toUTCString()}`);
  parts.push('HttpOnly', 'SameSite=Strict');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Delete a cookie: same name, empty value, already expired. */
export function clearCookie(name, secure) {
  return sessionCookie(name, '', { maxAgeSeconds: 0, expiresAt: 0, secure });
}

/** Default scrypt cost: about 66 ms and 32 MiB per verification. */
export const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keylen: 32, saltBytes: 16 };

/**
 * Hash a password.
 *
 * `maxmem` must exceed `128 * N * r`, because Node's 32 MiB default rejects the
 * default cost.
 * @param password - plaintext password.
 * @param params - optional cost overrides.
 * @returns persistable fields, including the parameters used.
 */
export function hashPassword(password, params = {}) {
  const { N, r, p, keylen, saltBytes } = { ...SCRYPT_DEFAULTS, ...params };
  const salt = randomBytes(saltBytes);
  const derived = scryptSync(Buffer.from(password, 'utf8'), salt, keylen, {
    N,
    r,
    p,
    maxmem: Math.max(128 * N * r * 2, 64 * 1024 * 1024),
  });
  return {
    algo: 'scrypt',
    N,
    r,
    p,
    salt: encodeBase64Url(salt),
    hash: encodeBase64Url(derived),
  };
}

/**
 * Check a password against a stored hash.
 * @param password - user input.
 * @param record - a {@link hashPassword} result.
 * @returns whether it matches.
 */
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || typeof record !== 'object' || record === null) return false;
  if (record.algo !== 'scrypt') return false;
  const salt = decodeBase64Url(record.salt);
  const expected = decodeBase64Url(record.hash);
  if (salt === undefined || expected === undefined) return false;
  let derived;
  try {
    derived = scryptSync(Buffer.from(password, 'utf8'), salt, expected.byteLength, {
      N: record.N,
      r: record.r,
      p: record.p,
      maxmem: Math.max(128 * record.N * record.r * 2, 64 * 1024 * 1024),
    });
  } catch {
    // Invalid parameters or an over-long password: treat as a mismatch.
    return false;
  }
  return derived.byteLength === expected.byteLength && timingSafeEqual(derived, expected);
}

/** RFC 4648 base32 alphabet, as authenticator apps use it. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Mint a 160-bit TOTP secret, base32 encoded without padding. */
export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

/** RFC 4648 base32 encode, no padding. */
export function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** RFC 4648 base32 decode; undefined on an illegal character. */
export function decodeBase32(text) {
  if (typeof text !== 'string') return undefined;
  const clean = text.toUpperCase().replaceAll('=', '').replaceAll(' ', '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * The six-digit code for one time step.
 * @param secret - raw secret bytes.
 * @param counter - time step (Unix seconds / 30).
 */
export function totpAt(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(buffer).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** The current time step. */
export function totpCounter(now = Date.now()) {
  return Math.floor(now / 30_000);
}

/**
 * Verify a TOTP code, tolerating one step of clock drift and rejecting replays.
 * @param secretBase32 - base32 secret.
 * @param code - the six digits the user typed.
 * @param lastUsedCounter - highest step already consumed.
 * @param now - current time in milliseconds.
 * @returns the consumed step on success, otherwise undefined.
 */
export function verifyTotp(secretBase32, code, lastUsedCounter, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return undefined;
  const secret = decodeBase32(secretBase32);
  if (secret === undefined || secret.byteLength === 0) return undefined;
  const counter = totpCounter(now);
  const supplied = Buffer.from(code, 'utf8');
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (candidate <= lastUsedCounter) continue;
    const expected = Buffer.from(totpAt(secret, candidate), 'utf8');
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return candidate;
  }
  return undefined;
}

/** Build the `otpauth://` URI an authenticator app imports. */
export function totpUri(secretBase32, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Extract the 32-byte signing key from a credential record.
 * @param record - what the credential store returned.
 * @returns the key, or undefined when the shape is not the expected grant.
 */
export function parseSigningSecret(record) {
  if (typeof record !== 'object' || record === null || record.kind !== 'grant') return undefined;
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || payload.version !== 1) return undefined;
  const secret = decodeBase64Url(payload.secret);
  if (secret === undefined || secret.byteLength !== SECRET_BYTES) return undefined;
  return secret;
}

export { SECRET_BYTES };
