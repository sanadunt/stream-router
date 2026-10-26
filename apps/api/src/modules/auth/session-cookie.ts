import type { FastifyRequest } from 'fastify';
import { getEnv, type AppEnv, type CookieSecureSetting } from '../../config/env.js';

/**
 * `auto` memakai request.protocol: X-Forwarded-Proto hanya dihormati bila socket berasal dari proxy
 * TRUST_PROXY, jadi client langsung tidak dapat mengklaim HTTPS. Tanpa COOKIE_SECURE, perilaku lama
 * dipertahankan (Secure hanya di production).
 */
export function isSessionCookieSecure(
  setting: CookieSecureSetting,
  nodeEnv: AppEnv['NODE_ENV'],
  protocol: string | undefined
): boolean {
  if (setting === '') return nodeEnv === 'production';
  if (setting === 'auto') return protocol === 'https';
  return setting;
}

// Login dan logout memakai atribut yang sama; browser menolak menghapus cookie bila Secure
// pada Set-Cookie penghapus dikirim lewat HTTP biasa.
export function sessionCookieOptions(request: FastifyRequest) {
  const env = getEnv();
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: isSessionCookieSecure(env.COOKIE_SECURE, env.NODE_ENV, request.protocol)
  };
}
