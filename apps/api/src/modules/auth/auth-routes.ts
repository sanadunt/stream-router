import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env.js';
import { SESSION_TTL_SECONDS, signSession } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { currentSession, requireRoles } from '../../plugins/auth.js';
import { sessionCookieOptions } from './session-cookie.js';
import { issueLoginDevice, trustedLoginDeviceId } from './login-device.js';
import { audit } from '../routes/route-service.js';
import {
  ensureCredentialVersion,
  reservePasswordCheck,
  updateRolePassword,
  userRoleValues,
  verifyRole,
  type PasswordCheckSlot
} from './auth-service.js';

const loginSchema = z.object({
  role: z.enum(userRoleValues),
  password: z.string().max(500).optional().default('')
}).strict();

const passwordRoleSchema = z.enum(['admin', 'operator']);
const passwordUpdateSchema = z.object({
  currentAdminPassword: z.string().min(1).max(500),
  newPassword: z.string()
    .min(8, 'Password baru minimal 8 karakter')
    .max(128, 'Password baru maksimal 128 karakter')
}).strict();

type LoginBody = z.infer<typeof loginSchema>;
interface PendingLogin {
  body: LoginBody;
  slot: PasswordCheckSlot | undefined;
  deviceId: string | null;
}
const pendingLogins = new WeakMap<FastifyRequest, PendingLogin>();

// Percobaan password Administrator/Operator dibatasi ketat. Login Viewer tidak memakai password
// maupun bcrypt, jadi memakai bucket sendiri yang longgar agar banyak layar monitor di belakang
// satu IP NAT (mis. Docker Desktop) tidak menghabiskan jatah login Administrator.
export const PASSWORD_LOGIN_LIMIT_PER_MINUTE = 5;
export const VIEWER_LOGIN_LIMIT_PER_MINUTE = 60;

/**
 * Kunci rate limit login. Browser dengan cookie perangkat login yang valid memakai bucket sendiri,
 * sehingga klien lain di balik IP yang sama tidak dapat membuat Administrator yang pernah login dari
 * browser tersebut terkena RATE_LIMITED. Klien tanpa cookie tetap berbagi bucket per IP.
 */
function loginRateLimitKey(request: FastifyRequest): string {
  const pending = pendingLogins.get(request);
  if (pending?.body.role === 'viewer') return `viewer:${request.ip}`;
  if (pending?.deviceId) return `device:${pending.deviceId}`;
  return `password:${request.ip}`;
}

/**
 * Berjalan sebelum hook rate limit login (route ini memasang rate limit di preHandler): request
 * yang ditolak LOGIN_BUSY karena antrean bcrypt penuh tidak memakai jatah 5/menit pemanggilnya.
 */
async function reserveLoginCheck(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = loginSchema.parse(request.body);
  if (body.role !== 'viewer' && body.password.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Password wajib diisi', 400);
  }
  const deviceId = body.role === 'viewer' ? null : await trustedLoginDeviceId(request);
  const slot = body.role === 'viewer' ? undefined : reservePasswordCheck(deviceId ? 'trusted' : 'general');
  pendingLogins.set(request, { body, slot, deviceId });
  // Slot yang tidak sempat dipakai (rate limit, client menutup koneksi) dikembalikan ke antrean.
  if (slot) reply.raw.once('close', () => slot.cancel());
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', {
    config: {
      rateLimit: {
        hook: 'preHandler',
        timeWindow: '1 minute',
        keyGenerator: loginRateLimitKey,
        max: (_request: FastifyRequest, key: string) => (
          key.startsWith('viewer:') ? VIEWER_LOGIN_LIMIT_PER_MINUTE : PASSWORD_LOGIN_LIMIT_PER_MINUTE
        )
      }
    },
    preHandler: reserveLoginCheck,
    onResponse: async (request) => {
      pendingLogins.get(request)?.slot?.cancel();
    }
  }, async (request, reply) => {
    const pending = pendingLogins.get(request);
    const body = pending?.body ?? loginSchema.parse(request.body);
    if (!await verifyRole(body.role, body.password, pending?.slot ?? 'general')) {
      return reply.code(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Username atau password salah', details: null, requestId: request.id }
      });
    }
    const env = getEnv();
    const credentialVersion = await ensureCredentialVersion(body.role);
    const token = signSession({ username: body.role, role: body.role, credentialVersion }, env.AUTH_SECRET);
    reply.setCookie('stream_router_session', token, { ...sessionCookieOptions(request), maxAge: SESSION_TTL_SECONDS });
    if (body.role !== 'viewer') issueLoginDevice(request, reply, body.role, credentialVersion, pending?.deviceId);
    return { user: { username: body.role, role: body.role } };
  });

  app.patch('/api/auth/passwords/:role', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request) => {
    const { role } = z.object({ role: passwordRoleSchema }).parse(request.params);
    const body = passwordUpdateSchema.parse(request.body);
    // Hanya sesi Administrator yang sampai ke sini, jadi verifikasinya memakai jalur trusted.
    if (!await verifyRole('admin', body.currentAdminPassword, 'trusted')) {
      throw new AppError('INVALID_CURRENT_PASSWORD', 'Password Administrator saat ini salah', 401);
    }
    if (await verifyRole(role, body.newPassword, 'trusted')) {
      throw new AppError('PASSWORD_UNCHANGED', 'Password baru harus berbeda dari password yang sedang digunakan', 400);
    }
    await updateRolePassword(role, body.newPassword);
    await audit('AUTH_PASSWORD_UPDATE', null, { role, sessionsRevoked: true });
    return { ok: true, role, sessionsRevoked: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.clearCookie('stream_router_session', sessionCookieOptions(request));
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Belum login', details: null, requestId: request.id } });
    return { user: { username: session.username, role: session.role } };
  });
}
