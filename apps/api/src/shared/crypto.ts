import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptString(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptString(payload: string, secret: string): string {
  const [version, ivPart, tagPart, cipherPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !cipherPart) throw new Error('Encrypted payload tidak valid');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

export const SESSION_TTL_SECONDS = 86400;

export function signSession(payload: object, secret: string, ttlSeconds = SESSION_TTL_SECONDS): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifySession<T>(token: string, secret: string, maxAgeSeconds = SESSION_TTL_SECONDS): T | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    if (!body || !signature) return null;
    const expected = createHmac('sha256', secret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: unknown };
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (parsed.exp < now) return null;
    // exp ditulis oleh penanda tangan; server tetap membatasi masa hidup token ke maxAgeSeconds.
    if (parsed.exp > now + maxAgeSeconds) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
