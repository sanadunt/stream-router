import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      }
    }
  }
}));

const { verifyRole } = await import('../../src/modules/auth/auth-service.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifikasi password', () => {
  it('menjalankan bcrypt satu per satu dan menolak antrean yang terlalu panjang', async () => {
    settings.set('auth.admin.passwordHash', bcrypt.hashSync('password-benar', 4));
    const original = bcrypt.compare.bind(bcrypt) as (password: string, hash: string) => Promise<boolean>;
    let active = 0;
    let maxActive = 0;
    vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string, hash: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await original(password, hash);
      } finally {
        active -= 1;
      }
    }) as typeof bcrypt.compare);

    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => (
      verifyRole('admin', index === 0 ? 'password-benar' : 'salah')
    )));
    expect(maxActive).toBe(1);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled.map((result) => result.value)).toEqual([true, false, false, false, false, false, false, false]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.reason).toMatchObject({ code: 'LOGIN_BUSY', statusCode: 429 });

    // Antrean pulih setelah verifikasi sebelumnya selesai.
    await expect(verifyRole('admin', 'password-benar')).resolves.toBe(true);
    await expect(verifyRole('viewer', '')).resolves.toBe(true);
  });
});
