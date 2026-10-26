import bcrypt from 'bcryptjs';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        if (!settings.has(where.key)) settings.set(where.key, create.value);
        return { key: where.key, value: settings.get(where.key)! };
      }
    }
  }
}));
vi.mock('../../src/modules/routes/route-service.js', () => ({ audit: async () => undefined }));

const { AppError } = await import('../../src/shared/errors.js');
const { authRoutes } = await import('../../src/modules/auth/auth-routes.js');

const originalCompare = bcrypt.compare.bind(bcrypt) as (password: string, hash: string) => Promise<boolean>;
const compareOrder: string[] = [];
let releaseHeld: () => void = () => undefined;
let held = new Promise<void>((resolve) => { releaseHeld = resolve; });
let app: FastifyInstance;

beforeAll(async () => {
  settings.set('auth.admin.passwordHash', bcrypt.hashSync('password-benar', 4));
  vi.spyOn(bcrypt, 'compare').mockImplementation((async (password: string, hash: string) => {
    compareOrder.push(password);
    if (password === 'tahan') await held;
    return originalCompare(password, hash);
  }) as typeof bcrypt.compare);

  app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => new AppError('RATE_LIMITED', 'Terlalu banyak permintaan', context.statusCode)
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  await app.register(authRoutes);
});

afterAll(async () => {
  releaseHeld();
  await app.close();
  vi.restoreAllMocks();
});

function login(remoteAddress: string, password: string, deviceCookie = '') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress,
    headers: deviceCookie ? { cookie: deviceCookie } : {},
    payload: { role: 'admin', password }
  });
}

function viewerLogin(remoteAddress: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { role: 'viewer' } });
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
}

/** Cookie perangkat login dari respons login Administrator yang berhasil, dalam bentuk header Cookie. */
function deviceCookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = setCookies(response).find((value) => value.startsWith('stream_router_login_device='));
  expect(header).toBeDefined();
  return header!.split(';')[0]!;
}

function errorCode(response: { json: () => unknown }): string | undefined {
  return (response.json() as { error?: { code?: string } }).error?.code;
}

describe('antrean verifikasi password login', () => {
  it('banjir percobaan dari perangkat tak dikenal tidak memblokir browser yang pernah login dan tidak memakai jatah rate limit', async () => {
    // Browser ini pernah login sukses sehingga membawa cookie perangkat dan memakai jalur trusted.
    const firstLogin = await login('10.0.0.1', 'password-benar');
    expect(firstLogin.statusCode).toBe(200);
    const deviceCookie = deviceCookieFrom(firstLogin);
    compareOrder.length = 0;

    // Delapan percobaan dari alamat berbeda memenuhi jalur general; yang pertama tertahan di bcrypt.
    const flood = Array.from({ length: 8 }, (_, index) => login(`10.0.1.${index + 1}`, 'tahan'));
    await vi.waitFor(() => expect(compareOrder).toEqual(['tahan']));

    // Alamat tak dikenal ditolak LOGIN_BUSY berkali-kali, melebihi batas 5/menit.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await login('10.0.2.1', 'password-benar');
      expect(response.statusCode).toBe(429);
      expect(errorCode(response)).toBe('LOGIN_BUSY');
    }
    // Kepercayaan tidak berbasis IP: klien lain di balik IP yang sama (NAT Docker Desktop) tanpa
    // cookie perangkat tetap memakai jalur general.
    expect(errorCode(await login('10.0.0.1', 'password-benar'))).toBe('LOGIN_BUSY');

    // Browser dengan cookie perangkat tetap masuk antrean dari IP mana pun dan dilayani sebelum sisa banjir.
    const trusted = login('10.0.2.1', 'password-benar', deviceCookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseHeld();
    expect((await trusted).statusCode).toBe(200);
    expect(compareOrder.slice(0, 2)).toEqual(['tahan', 'password-benar']);
    for (const response of await Promise.all(flood)) expect(response.statusCode).toBe(401);

    // Penolakan LOGIN_BUSY tidak dihitung sebagai percobaan login alamat tersebut.
    expect((await login('10.0.2.1', 'password-benar')).statusCode).toBe(200);
  });

  it('slot antrean dikembalikan setelah request selesai, termasuk yang ditolak rate limit', async () => {
    held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login('10.0.3.1', 'salah')).statusCode).toBe(401);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login('10.0.3.1', 'salah');
      expect(response.statusCode).toBe(429);
      expect(errorCode(response)).toBe('RATE_LIMITED');
    }
    // Sepuluh request yang ditolak rate limit tidak menahan slot jalur general.
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => login(`10.0.4.${index + 1}`, 'salah')));
    expect(responses.map((response) => response.statusCode)).toEqual(Array(8).fill(401));
  });
});

describe('rate limit login di balik satu IP NAT', () => {
  it('login Viewer tanpa password tidak memakai jatah percobaan password Administrator', async () => {
    // Banyak layar monitor Viewer dari IP gateway yang sama.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await viewerLogin('10.0.5.1')).statusCode).toBe(200);
    }
    expect((await login('10.0.5.1', 'password-benar')).statusCode).toBe(200);

    // Sebaliknya, percobaan password yang habis tidak menghalangi login Viewer.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login('10.0.6.1', 'salah')).statusCode).toBe(401);
    }
    expect(errorCode(await login('10.0.6.1', 'password-benar'))).toBe('RATE_LIMITED');
    expect((await viewerLogin('10.0.6.1')).statusCode).toBe(200);
  });

  it('login Viewer tetap memiliki batas sendiri per IP', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 61; attempt += 1) statuses.push((await viewerLogin('10.0.6.2')).statusCode);
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(200));
    expect(statuses[60]).toBe(429);
  });

  it('browser dengan cookie perangkat memakai bucket sendiri sehingga klien lain di IP yang sama tidak dapat menguncinya', async () => {
    const firstLogin = await login('10.0.7.1', 'password-benar');
    expect(firstLogin.statusCode).toBe(200);
    const deviceCookie = deviceCookieFrom(firstLogin);
    const attributes = setCookies(firstLogin).find((value) => value.startsWith('stream_router_login_device='))!;
    expect(attributes).toMatch(/HttpOnly/i);
    expect(attributes).toMatch(/SameSite=Strict/i);
    expect(attributes).toMatch(/Path=\/api\/auth\/login/);
    expect(attributes).toMatch(/Max-Age=2592000/);

    // Perangkat lain di LAN (IP gateway yang sama, tanpa cookie) menghabiskan sisa jatah 5/menit
    // bucket IP (login pertama di atas juga terhitung karena belum membawa cookie perangkat).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await login('10.0.7.1', 'salah')).statusCode).toBe(401);
    }
    expect(errorCode(await login('10.0.7.1', 'password-benar'))).toBe('RATE_LIMITED');
    // Administrator yang pernah login dari browser ini tetap dapat masuk.
    expect((await login('10.0.7.1', 'password-benar', deviceCookie)).statusCode).toBe(200);

    // Cookie yang diubah tidak dipercaya dan kembali ke bucket IP yang sudah habis.
    const [name, value] = deviceCookie.split('=') as [string, string];
    const tampered = `${name}=${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(errorCode(await login('10.0.7.1', 'password-benar', tampered))).toBe('RATE_LIMITED');
  });

  it('cookie perangkat dicabut saat password role diganti dan tidak berlaku sebagai cookie sesi', async () => {
    const firstLogin = await login('10.0.8.1', 'password-benar');
    const deviceCookie = deviceCookieFrom(firstLogin);
    const sessionAsDevice = setCookies(firstLogin).find((value) => value.startsWith('stream_router_session='))!.split(';')[0]!;
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: deviceCookie.replace('stream_router_login_device=', 'stream_router_session=') }
    });
    expect(me.statusCode).toBe(401);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await login('10.0.8.1', 'salah')).statusCode).toBe(401);
    }
    // Token sesi yang ditempel sebagai cookie perangkat tidak memberi bucket sendiri.
    expect(errorCode(await login('10.0.8.1', 'password-benar', sessionAsDevice.replace('stream_router_session=', 'stream_router_login_device=')))).toBe('RATE_LIMITED');

    // Password diganti: versi credential berubah sehingga cookie perangkat lama tidak dipercaya lagi.
    const previousVersion = settings.get('auth.admin.credentialVersion');
    settings.set('auth.admin.credentialVersion', 'versi-baru-setelah-ganti-password');
    try {
      expect(errorCode(await login('10.0.8.1', 'password-benar', deviceCookie))).toBe('RATE_LIMITED');
    } finally {
      if (previousVersion === undefined) settings.delete('auth.admin.credentialVersion');
      else settings.set('auth.admin.credentialVersion', previousVersion);
    }
    expect((await login('10.0.8.1', 'password-benar', deviceCookie)).statusCode).toBe(200);
  });
});
