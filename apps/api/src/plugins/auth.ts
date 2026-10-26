import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnv } from '../config/env.js';
import { verifySession } from '../shared/crypto.js';
import { getCredentialVersion, isUserRole, type UserRole } from '../modules/auth/auth-service.js';

export interface SessionPayload {
  username: string;
  role: UserRole;
  credentialVersion: string;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!await currentSession(request)) {
    await reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Silakan login terlebih dahulu', details: null, requestId: request.id }
    });
  }
}

export async function currentSession(request: FastifyRequest): Promise<SessionPayload | null> {
  const token = request.cookies.stream_router_session;
  const session = token ? verifySession<Partial<SessionPayload>>(token, getEnv().AUTH_SECRET) : null;
  if (!session || typeof session.username !== 'string' || !isUserRole(session.role)) return null;
  if (typeof session.credentialVersion !== 'string') return null;
  const currentVersion = await getCredentialVersion(session.role);
  if (currentVersion === null || session.credentialVersion !== currentVersion) return null;
  return { username: session.username, role: session.role, credentialVersion: session.credentialVersion };
}

export function requireRoles(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = await currentSession(request);
    if (!session) {
      await reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Silakan login terlebih dahulu', details: null, requestId: request.id } });
      return;
    }
    if (!roles.includes(session.role)) {
      await reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Role Anda tidak memiliki akses ke tindakan ini', details: null, requestId: request.id } });
    }
  };
}
