import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.js';
import { signSession, verifySession } from '../../shared/crypto.js';
import { getCredentialVersion, type CredentialRole } from './auth-service.js';
import { sessionCookieOptions } from './session-cookie.js';

/**
 * Cookie perangkat login: penanda bertanda tangan bahwa browser ini pernah login sebagai
 * Administrator/Operator. Dipakai sebagai pengganti IP client untuk jalur antrean bcrypt `trusted`
 * dan bucket rate limit login sendiri, karena di Docker Desktop semua klien LAN terlihat dari satu
 * IP gateway. Cookie ini bukan sesi: tidak memberi akses ke endpoint mana pun.
 */
export const LOGIN_DEVICE_COOKIE = 'stream_router_login_device';
const LOGIN_DEVICE_TTL_SECONDS = 30 * 86_400;
// Hanya dikirim browser ke endpoint login, tidak ke request API lain.
const LOGIN_DEVICE_PATH = '/api/auth/login';

interface LoginDevicePayload {
  kind: 'login-device';
  id: string;
  role: CredentialRole;
  credentialVersion: string;
}

// Kunci HMAC diturunkan terpisah dari kunci cookie sesi, sehingga token perangkat tidak pernah
// diterima sebagai sesi dan sebaliknya.
function loginDeviceSecret(): string {
  return createHmac('sha256', getEnv().AUTH_SECRET).update('stream-router:login-device:v1').digest('base64url');
}

/**
 * ID perangkat dari cookie yang valid, atau null. Perangkat ikut dicabut saat password role yang
 * tercatat di cookie diganti (versi credential berubah).
 */
export async function trustedLoginDeviceId(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies[LOGIN_DEVICE_COOKIE];
  if (!token) return null;
  const payload = verifySession<Partial<LoginDevicePayload>>(token, loginDeviceSecret(), LOGIN_DEVICE_TTL_SECONDS);
  if (
    !payload
    || payload.kind !== 'login-device'
    || typeof payload.id !== 'string'
    || !payload.id
    || (payload.role !== 'admin' && payload.role !== 'operator')
    || typeof payload.credentialVersion !== 'string'
  ) return null;
  const currentVersion = await getCredentialVersion(payload.role);
  return currentVersion !== null && currentVersion === payload.credentialVersion ? payload.id : null;
}

/** Dipanggil setelah login Administrator/Operator berhasil; masa berlaku diperpanjang tiap login. */
export function issueLoginDevice(
  request: FastifyRequest,
  reply: FastifyReply,
  role: CredentialRole,
  credentialVersion: string,
  existingId?: string | null
): void {
  const payload: LoginDevicePayload = { kind: 'login-device', id: existingId || randomUUID(), role, credentialVersion };
  reply.setCookie(LOGIN_DEVICE_COOKIE, signSession(payload, loginDeviceSecret(), LOGIN_DEVICE_TTL_SECONDS), {
    ...sessionCookieOptions(request),
    path: LOGIN_DEVICE_PATH,
    maxAge: LOGIN_DEVICE_TTL_SECONDS
  });
}
