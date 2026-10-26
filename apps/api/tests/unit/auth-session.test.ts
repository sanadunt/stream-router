import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => {
  process.env.AUTH_SECRET = 'unit-auth-secret-0123456789012345678901';
  process.env.APP_ENCRYPTION_KEY = 'unit-encryption-key-01234567890123456';
  process.env.ADMIN_PASSWORD = 'unit-admin-password';
  process.env.OPERATOR_PASSWORD = 'unit-operator-password';
  return new Map<string, string>();
});

vi.mock('../../src/db/client.js', () => ({
  prisma: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = settings.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      },
      upsert: async ({ where, update, create }: {
        where: { key: string };
        update: { value?: string };
        create: { key: string; value: string };
      }) => {
        const value = settings.has(where.key) ? update.value ?? settings.get(where.key)! : create.value;
        settings.set(where.key, value);
        return { key: where.key, value };
      }
    },
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations)
  }
}));

const { signSession } = await import('../../src/shared/crypto.js');
const { currentSession } = await import('../../src/plugins/auth.js');
const { ensureRoleCredentials, getCredentialVersion } = await import('../../src/modules/auth/auth-service.js');

function requestWith(payload: object): FastifyRequest {
  const token = signSession(payload, process.env.AUTH_SECRET!);
  return { cookies: { stream_router_session: token } } as unknown as FastifyRequest;
}

describe('versi credential sesi', () => {
  beforeEach(() => settings.clear());

  it('fail closed untuk Administrator/Operator bila versi belum tersimpan', async () => {
    expect(await getCredentialVersion('admin')).toBeNull();
    expect(await getCredentialVersion('operator')).toBeNull();
    expect(await currentSession(requestWith({ username: 'admin', role: 'admin', credentialVersion: '0' }))).toBeNull();
    expect(await currentSession(requestWith({ username: 'admin', role: 'admin' }))).toBeNull();
  });

  it('Viewer tetap memakai versi 0 dan role tidak dikenal ditolak', async () => {
    expect(await currentSession(requestWith({ username: 'viewer', role: 'viewer', credentialVersion: '0' })))
      .toEqual({ username: 'viewer', role: 'viewer', credentialVersion: '0' });
    expect(await currentSession(requestWith({ username: 'root', role: 'root', credentialVersion: '0' }))).toBeNull();
  });

  it('bootstrap membuat versi acak tanpa merotasi versi yang sudah ada', async () => {
    settings.set('auth.admin.passwordHash', 'hash-lama');
    settings.set('auth.operator.passwordHash', 'hash-lama');
    settings.set('auth.operator.credentialVersion', 'versi-operator-lama');
    await ensureRoleCredentials();

    const adminVersion = await getCredentialVersion('admin');
    expect(adminVersion).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getCredentialVersion('operator')).toBe('versi-operator-lama');
    expect(settings.get('auth.admin.passwordHash')).toBe('hash-lama');

    expect(await currentSession(requestWith({ username: 'admin', role: 'admin', credentialVersion: '0' }))).toBeNull();
    expect(await currentSession(requestWith({ username: 'admin', role: 'admin', credentialVersion: adminVersion })))
      .toMatchObject({ role: 'admin' });

    await ensureRoleCredentials();
    expect(await getCredentialVersion('admin')).toBe(adminVersion);
  });
});
