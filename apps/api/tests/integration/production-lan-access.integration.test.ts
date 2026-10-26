import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../../scripts/apply-sqlite-migrations.mjs';

// Mode production seperti container Docker: dashboard dibuka lewat http://<IP LAN>:3000 dari host
// lain, sehingga Host/Origin berbeda dari CORS_ORIGIN dan request tidak melewati HTTPS.
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'stream-router-lan-access-'));
const lanHost = '192.168.50.20:3000';
const lanOrigin = `http://${lanHost}`;
const corsOrigin = 'https://cams.example.com';
const adminPassword = 'lan-access-admin-password';

process.env.NODE_ENV = 'production';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3997';
process.env.DATABASE_URL = `file:${path.join(tmpRoot, 'test.db')}`;
process.env.AUTH_SECRET = 'lan-access-auth-secret-0123456789abcdef';
process.env.APP_ENCRYPTION_KEY = 'lan-access-encryption-key-0123456789ab';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = adminPassword;
process.env.OPERATOR_PASSWORD = 'lan-access-operator-password';
process.env.CORS_ORIGIN = corsOrigin;
// Nama komputer/.local yang dipakai membuka dashboard selain lewat IP (allowlist DNS rebinding).
process.env.ALLOWED_HOSTS = 'kamera.lan,PC-KAMERA';
process.env.TRUST_PROXY = 'true';
process.env.COOKIE_SECURE = 'auto';
process.env.MEDIAMTX_ENABLED = 'false';
process.env.MEDIAMTX_PUBLIC_HOST = '192.168.50.20';
// Player WebRTC disajikan reverse proxy HTTPS di bawah sub-path (garis miring akhir dinormalisasi).
process.env.MEDIAMTX_WEBRTC_PUBLIC_URL = 'https://kamera.example.com/webrtc/';
process.env.MEDIAMTX_CONFIG_PATH = path.join(tmpRoot, 'mediamtx.yml');
process.env.RECORDING_PATH = path.join(tmpRoot, 'recordings');
process.env.LOG_LEVEL = 'silent';

await applyMigrations({ databaseUrl: process.env.DATABASE_URL, log: () => undefined });
await mkdir(process.env.RECORDING_PATH, { recursive: true });

// Control API MediaMTX palsu untuk endpoint apply Settings; hanya health check yang dipanggil.
const fakeMediaServer = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(request.url?.startsWith('/v3/paths/list') ? JSON.stringify({ itemCount: 0, items: [] }) : '{}');
});
await new Promise<void>((resolve, reject) => {
  fakeMediaServer.once('error', reject);
  fakeMediaServer.listen(0, '127.0.0.1', resolve);
});
const fakeMediaApiPort = (fakeMediaServer.address() as AddressInfo).port;
// Port yang baru dilepas: health check MediaMTX gagal sehingga apply menjalankan rollback.
const closedPort = await new Promise<number>((resolve, reject) => {
  const probe = http.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});

const { prisma } = await import('../../src/db/client.js');
const { buildApp } = await import('../../src/app.js');
const { ensureRoleCredentials } = await import('../../src/modules/auth/auth-service.js');
const app = await buildApp();
let adminCookie = '';

function sessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] ?? '' : setCookie ?? '';
  return header.split(';')[0] ?? '';
}

function setCookieHeader(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('\n') : String(value ?? '');
}

const secureAttribute = /;\s*Secure(?:;|$)/i;

beforeAll(async () => {
  await ensureRoleCredentials();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: lanHost, origin: lanOrigin },
    payload: { role: 'admin', password: adminPassword }
  });
  expect(login.statusCode).toBe(200);
  adminCookie = sessionCookie(login.headers['set-cookie']);
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => fakeMediaServer.close(() => resolve()));
  await prisma.$disconnect();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('akses LAN mode production (Docker/Windows)', () => {
  it('COOKIE_SECURE=auto: login dan logout lewat HTTP tanpa Secure', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: lanHost },
      payload: { role: 'viewer' }
    });
    expect(login.statusCode).toBe(200);
    const created = setCookieHeader(login);
    expect(created).toContain('stream_router_session=');
    expect(created).toContain('HttpOnly');
    expect(created).toContain('SameSite=Strict');
    expect(created).not.toMatch(secureAttribute);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { host: lanHost, origin: lanOrigin, cookie: sessionCookie(login.headers['set-cookie']) }
    });
    expect(logout.statusCode).toBe(200);
    const cleared = setCookieHeader(logout);
    expect(cleared).toContain('stream_router_session=;');
    expect(cleared).not.toMatch(secureAttribute);
  });

  it('COOKIE_SECURE=auto: memasang Secure saat request datang lewat reverse proxy HTTPS tepercaya', async () => {
    const headers = { host: 'cams.example.com', 'x-forwarded-proto': 'https' };
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { role: 'viewer' } });
    expect(login.statusCode).toBe(200);
    expect(setCookieHeader(login)).toMatch(secureAttribute);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, origin: corsOrigin, cookie: sessionCookie(login.headers['set-cookie']) }
    });
    expect(logout.statusCode).toBe(200);
    expect(setCookieHeader(logout)).toContain('stream_router_session=;');
    expect(setCookieHeader(logout)).toMatch(secureAttribute);
  });

  it('X-Forwarded-Proto dari client yang bukan proxy tepercaya tidak membuat cookie Secure', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '192.168.50.77',
      headers: { host: lanHost, 'x-forwarded-proto': 'https' },
      payload: { role: 'viewer' }
    });
    expect(login.statusCode).toBe(200);
    expect(setCookieHeader(login)).not.toMatch(secureAttribute);
  });

  it('menerima mutasi dari Origin yang sama dengan Host request maupun dari CORS_ORIGIN', async () => {
    const sameOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { host: lanHost, origin: lanOrigin, cookie: adminCookie },
      payload: { appName: 'Kamera LAN' }
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.json().appName).toBe('Kamera LAN');

    const configuredOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { host: '127.0.0.1:3000', origin: corsOrigin, cookie: adminCookie },
      payload: { appName: 'Kamera Proxy' }
    });
    expect(configuredOrigin.statusCode).toBe(200);

    const behindTrustedProxy = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { host: 'kamera.lan', 'x-forwarded-proto': 'https', origin: 'https://kamera.lan', cookie: adminCookie },
      payload: { appName: 'Kamera TLS' }
    });
    expect(behindTrustedProxy.statusCode).toBe(200);
  });

  it('tetap menolak Origin asing dengan CSRF_ORIGIN_REJECTED walau membawa sesi Admin', async () => {
    const attempts = [
      { remoteAddress: '127.0.0.1', headers: { host: lanHost, origin: 'http://evil.example' } },
      // Origin HTTPS untuk request HTTP biasa bukan origin yang sama.
      { remoteAddress: '127.0.0.1', headers: { host: lanHost, origin: `https://${lanHost}` } },
      // Klaim HTTPS lewat X-Forwarded-Proto hanya dipercaya dari proxy TRUST_PROXY.
      { remoteAddress: '192.168.50.77', headers: { host: lanHost, origin: `https://${lanHost}`, 'x-forwarded-proto': 'https' } }
    ];
    for (const { remoteAddress, headers } of attempts) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        remoteAddress,
        headers: { ...headers, cookie: adminCookie },
        payload: { appName: 'Diubah Penyerang' }
      });
      expect(response.statusCode, headers.origin).toBe(403);
      expect(response.json().error.code).toBe('CSRF_ORIGIN_REJECTED');
    }
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: adminCookie } });
    expect(settings.json().appName).not.toBe('Diubah Penyerang');
  });

  it('request gaya DNS rebinding ditolak sebelum route berjalan, termasuk login Viewer tanpa password', async () => {
    // Domain penyerang di-resolve ke IP server: Origin dan Host sama-sama domain penyerang, sehingga
    // tanpa allowlist Host halaman penyerang dapat login Viewer dan memakai cookie miliknya sendiri.
    const headers = { host: 'rebind.attacker.example:3000', origin: 'http://rebind.attacker.example:3000' };
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { role: 'viewer' } });
    expect(login.statusCode).toBe(421);
    expect(login.json().error).toMatchObject({ code: 'HOST_NOT_ALLOWED', details: null });
    expect(login.json().error.message).toMatch(/ALLOWED_HOSTS/);
    expect(login.headers['set-cookie']).toBeUndefined();

    const attempts = [
      { method: 'GET' as const, url: '/api/auth/me' },
      { method: 'GET' as const, url: '/api/viewer/routes' },
      { method: 'GET' as const, url: '/api/health' },
      { method: 'GET' as const, url: '/' },
      { method: 'GET' as const, url: '/halaman-dashboard' },
      { method: 'PATCH' as const, url: '/api/settings', payload: { appName: 'Rebind' } },
      { method: 'POST' as const, url: '/api/settings/mediamtx/apply', payload: {} },
      { method: 'POST' as const, url: '/api/auth/logout' }
    ];
    // Cookie sesi sah pun tidak membuat domain penyerang diterima.
    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers: { ...headers, cookie: adminCookie } });
      expect(response.statusCode, attempt.url).toBe(421);
      expect(response.json().error.code, attempt.url).toBe('HOST_NOT_ALLOWED');
    }
    for (const host of ['192.168.50.20.nip.io:3000', 'evil@192.168.50.20:3000', 'localhost.attacker.example']) {
      const response = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(response.statusCode, host).toBe(421);
    }
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: adminCookie } });
    expect(settings.json().appName).not.toBe('Rebind');
  });

  it('allowlist Host tetap menerima IP LAN, localhost, host CORS_ORIGIN, dan ALLOWED_HOSTS', async () => {
    for (const host of [lanHost, '127.0.0.1:3000', '[::1]:3000', 'localhost:3000', 'cams.example.com', 'kamera.lan', 'PC-Kamera:3000', 'kamera.lan.:3000']) {
      const health = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(health.statusCode, host).toBe(200);
    }
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'pc-kamera:3000', origin: 'http://pc-kamera:3000' },
      payload: { role: 'viewer' }
    });
    expect(login.statusCode).toBe(200);
    expect(setCookieHeader(login)).toContain('stream_router_session=');
  });

  it('MEDIAMTX_PUBLIC_HOST menjadi public host default; host tersimpan di Settings tetap menang', async () => {
    const publicHost = async () => (await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: adminCookie }
    })).json().mediaMtx.publicHost as string;
    const save = (value: string) => prisma.appSetting.upsert({
      where: { key: 'mediamtx.publicHost' },
      update: { value },
      create: { key: 'mediamtx.publicHost', value, isSecret: false }
    });

    expect(await publicHost()).toBe('192.168.50.20');
    // Nilai loopback lama di Settings diperlakukan sebagai belum diatur.
    await save('127.0.0.1');
    expect(await publicHost()).toBe('192.168.50.20');
    await save('192.168.50.99');
    expect(await publicHost()).toBe('192.168.50.99');
    await prisma.appSetting.delete({ where: { key: 'mediamtx.publicHost' } });
  });

  it('MEDIAMTX_WEBRTC_PUBLIC_URL tampil di Settings dan menjadi dasar URL player WebRTC HTTPS', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: adminCookie } });
    const mediaMtx = response.json().mediaMtx as { webrtcPublicUrl: string; publicHost: string; webrtcPort: number };
    expect(mediaMtx.webrtcPublicUrl).toBe('https://kamera.example.com/webrtc');
    const { localWebrtcUrl } = await import('../../src/modules/mediamtx/mediamtx-runtime.js');
    expect(localWebrtcUrl(mediaMtx, 'cameras/gerbang')).toBe('https://kamera.example.com/webrtc/cameras/gerbang/');
    // Field ini hanya dari env: endpoint yang menyimpan setting MediaMTX menolaknya walau payload lain valid.
    const validApplyBody = {
      enabled: false,
      publicHost: '',
      recordingPath: (response.json().mediaMtx as { recordingPath: string }).recordingPath,
      rtspPort: 18554,
      rtmpPort: 11935,
      hlsPort: 18888,
      webrtcPort: 18889,
      webrtcUdpPort: 18189,
      srtPort: 18890,
      playbackPort: 19996,
      apiPort: fakeMediaApiPort,
      metricsPort: 19998,
      retentionMode: 'DAYS',
      retentionDays: 30,
      retentionMaxGb: 100,
      minFreePercent: 1,
      minFreeGb: 1,
      segmentDurationSeconds: 3600
    };
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/settings/mediamtx/apply',
      headers: { cookie: adminCookie, origin: corsOrigin },
      payload: { ...validApplyBody, webrtcPublicUrl: 'https://attacker.example' }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('VALIDATION_ERROR');
    const after = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: adminCookie } });
    expect(after.json().mediaMtx.webrtcPublicUrl).toBe('https://kamera.example.com/webrtc');
  });

  it('Apply MediaMTX tidak membekukan MEDIAMTX_PUBLIC_HOST ke database dan publicHost dapat dikosongkan', async () => {
    const settingsResponse = async () => (await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { host: lanHost, cookie: adminCookie }
    })).json().mediaMtx as Record<string, unknown>;
    const storedHost = async () => (await prisma.appSetting.findUnique({ where: { key: 'mediamtx.publicHost' } }))?.value ?? null;
    const initial = await settingsResponse();
    expect(initial).toMatchObject({ publicHost: '192.168.50.20', publicHostConfigured: '', publicHostDefault: '192.168.50.20' });
    const body = {
      enabled: false,
      publicHost: '',
      recordingPath: initial.recordingPath,
      rtspPort: 18554,
      rtmpPort: 11935,
      hlsPort: 18888,
      webrtcPort: 18889,
      webrtcUdpPort: 18189,
      srtPort: 18890,
      playbackPort: 19996,
      apiPort: fakeMediaApiPort,
      metricsPort: 19998,
      retentionMode: 'DAYS',
      retentionDays: 30,
      retentionMaxGb: 100,
      minFreePercent: 1,
      minFreeGb: 1,
      segmentDurationSeconds: 3600
    };
    const apply = (overrides: Record<string, unknown>) => app.inject({
      method: 'POST',
      url: '/api/settings/mediamtx/apply',
      headers: { host: lanHost, origin: lanOrigin, cookie: adminCookie },
      payload: { ...body, ...overrides }
    });

    // Form versi lama mengirim balik host hasil fallback HOST_LAN_IP saat mengubah retention.
    const echoed = await apply({ publicHost: '192.168.50.20', retentionDays: 45 });
    expect(echoed.statusCode, echoed.body).toBe(200);
    expect(await storedHost()).toBeNull();
    expect((await settingsResponse()).retentionDays).toBe(45);

    const explicit = await apply({ publicHost: '192.168.50.99' });
    expect(explicit.statusCode, explicit.body).toBe(200);
    expect(await storedHost()).toBe('192.168.50.99');
    expect(await settingsResponse()).toMatchObject({ publicHost: '192.168.50.99', publicHostConfigured: '192.168.50.99' });

    // Mengosongkan field mengembalikan host ke MEDIAMTX_PUBLIC_HOST (dulu ditolak 400 VALIDATION_ERROR).
    const cleared = await apply({ publicHost: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await storedHost()).toBeNull();
    expect(await settingsResponse()).toMatchObject({ publicHost: '192.168.50.20', publicHostConfigured: '' });

    // Apply gagal: rollback memulihkan nilai tersimpan sebelumnya (kosong), bukan host hasil fallback.
    const failed = await apply({ publicHost: '192.168.50.77', apiPort: closedPort });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe('MEDIAMTX_CONFIG_REJECTED');
    expect(await storedHost()).toBeNull();
    expect(await settingsResponse()).toMatchObject({ publicHost: '192.168.50.20', apiPort: fakeMediaApiPort });

    // Rollback juga mempertahankan host eksplisit yang tersimpan sebelumnya.
    expect((await apply({ publicHost: '192.168.50.99' })).statusCode).toBe(200);
    expect((await apply({ publicHost: '', apiPort: closedPort })).statusCode).toBe(502);
    expect(await storedHost()).toBe('192.168.50.99');
    expect((await apply({ publicHost: '' })).statusCode).toBe(200);
    expect(await storedHost()).toBeNull();
  }, 30_000);
});
