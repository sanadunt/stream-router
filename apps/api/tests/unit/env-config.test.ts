import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.js';

const required = {
  AUTH_SECRET: 'a'.repeat(32),
  APP_ENCRYPTION_KEY: 'b'.repeat(32),
  ADMIN_PASSWORD: 'password123',
  OPERATOR_PASSWORD: 'operator-password123'
};

function parse(extra: Record<string, string>) {
  return envSchema.parse({ ...required, ...extra });
}

describe('validasi environment', () => {
  it('menerima variasi boolean umum dan menolak nilai yang tidak dikenali', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'On']) {
      expect(parse({ MEDIAMTX_ENABLED: value }).MEDIAMTX_ENABLED).toBe(true);
    }
    for (const value of ['false', 'FALSE', '0', 'no', 'off', '']) {
      expect(parse({ MEDIAMTX_ENABLED: value }).MEDIAMTX_ENABLED).toBe(false);
    }
    expect(parse({}).STREAM_VIEW_ALLOW_INSECURE_HTTP).toBe(false);
    expect(() => parse({ MEDIAMTX_ENABLED: 'aktif' })).toThrow(/true atau false/);
  });

  it('menormalisasi CORS_ORIGIN menjadi origin tanpa slash akhir', () => {
    expect(parse({ CORS_ORIGIN: 'https://cams.example.com/' }).CORS_ORIGIN).toBe('https://cams.example.com');
    expect(parse({ CORS_ORIGIN: ' http://localhost:5173 ' }).CORS_ORIGIN).toBe('http://localhost:5173');
    expect(parse({}).CORS_ORIGIN).toBe('http://localhost:5173');
    expect(() => parse({ CORS_ORIGIN: 'cams.example.com' })).toThrow(/origin http/);
    expect(() => parse({ CORS_ORIGIN: 'ftp://cams.example.com' })).toThrow(/origin http/);
  });

  it('COOKIE_SECURE menerima auto/true/false, kosong berarti perilaku lama, nilai lain ditolak', () => {
    expect(parse({}).COOKIE_SECURE).toBe('');
    expect(parse({ COOKIE_SECURE: '  ' }).COOKIE_SECURE).toBe('');
    expect(parse({ COOKIE_SECURE: 'auto' }).COOKIE_SECURE).toBe('auto');
    expect(parse({ COOKIE_SECURE: ' AUTO ' }).COOKIE_SECURE).toBe('auto');
    for (const value of ['true', 'TRUE', '1', 'yes']) expect(parse({ COOKIE_SECURE: value }).COOKIE_SECURE).toBe(true);
    for (const value of ['false', 'False', '0', 'off']) expect(parse({ COOKIE_SECURE: value }).COOKIE_SECURE).toBe(false);
    expect(() => parse({ COOKIE_SECURE: 'https' })).toThrow(/auto, true, atau false/);
    expect(() => parse({ COOKIE_SECURE: 'otomatis' })).toThrow(/auto, true, atau false/);
  });

  it('MEDIAMTX_PUBLIC_HOST menerima IP atau hostname saja dan menolak skema, port, atau path', () => {
    expect(parse({}).MEDIAMTX_PUBLIC_HOST).toBe('');
    expect(parse({ MEDIAMTX_PUBLIC_HOST: ' 192.168.1.50 ' }).MEDIAMTX_PUBLIC_HOST).toBe('192.168.1.50');
    expect(parse({ MEDIAMTX_PUBLIC_HOST: 'kamera.lan' }).MEDIAMTX_PUBLIC_HOST).toBe('kamera.lan');
    expect(parse({ MEDIAMTX_PUBLIC_HOST: '[fd00::10]' }).MEDIAMTX_PUBLIC_HOST).toBe('fd00::10');
    expect(parse({ MEDIAMTX_PUBLIC_HOST: 'fd00::10' }).MEDIAMTX_PUBLIC_HOST).toBe('fd00::10');
    for (const value of ['http://192.168.1.50', '192.168.1.50:3000', 'kamera.lan/view', '192.168.1', 'host name']) {
      expect(() => parse({ MEDIAMTX_PUBLIC_HOST: value }), value).toThrow(/tanpa skema dan port/);
    }
  });

  it('nilai hasil parse COOKIE_SECURE dan MEDIAMTX_PUBLIC_HOST tetap sama bila di-String() lalu di-parse ulang', () => {
    // verify-dist mengisi setiap key env boot dengan String(nilai hasil parse schema).
    for (const extra of [{}, { COOKIE_SECURE: 'auto' }, { COOKIE_SECURE: 'yes' }, { COOKIE_SECURE: 'off' }, { MEDIAMTX_PUBLIC_HOST: '[fd00::10]' }]) {
      const first = parse(extra);
      const again = parse({
        COOKIE_SECURE: String(first.COOKIE_SECURE),
        MEDIAMTX_PUBLIC_HOST: String(first.MEDIAMTX_PUBLIC_HOST)
      });
      expect(again.COOKIE_SECURE).toBe(first.COOKIE_SECURE);
      expect(again.MEDIAMTX_PUBLIC_HOST).toBe(first.MEDIAMTX_PUBLIC_HOST);
    }
  });

  it('ALLOWED_HOSTS menerima daftar hostname tanpa skema dan port, lalu menormalisasinya', () => {
    expect(parse({}).ALLOWED_HOSTS).toEqual([]);
    expect(parse({ ALLOWED_HOSTS: ' ' }).ALLOWED_HOSTS).toEqual([]);
    expect(parse({ ALLOWED_HOSTS: 'Kamera.LAN, PC-KAMERA,kamera.lan.,,[fd00::10]' }).ALLOWED_HOSTS)
      .toEqual(['kamera.lan', 'pc-kamera', 'fd00::10']);
    for (const value of ['http://kamera.lan', 'kamera.lan:3000', 'kamera.lan/x', '*', '*.kamera.lan', '192.168.1', 'host name']) {
      expect(() => parse({ ALLOWED_HOSTS: value }), value).toThrow(/hostname tanpa skema dan port/);
    }
    // verify-dist menggabungkan array hasil parse dengan koma lalu mem-parse ulang.
    const first = parse({ ALLOWED_HOSTS: 'kamera.lan,pc-kamera' }).ALLOWED_HOSTS;
    expect(parse({ ALLOWED_HOSTS: first.join(',') }).ALLOWED_HOSTS).toEqual(first);
  });

  it('TRUST_PROXY=true hanya mempercayai proxy loopback, bukan semua hop', () => {
    expect(parse({}).TRUST_PROXY).toBe(false);
    expect(parse({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(parse({ TRUST_PROXY: 'true' }).TRUST_PROXY).toEqual(['loopback']);
    expect(parse({ TRUST_PROXY: '10.0.0.5, 192.168.1.0/24,::1' }).TRUST_PROXY).toEqual(['10.0.0.5', '192.168.1.0/24', '::1']);
    expect(() => parse({ TRUST_PROXY: 'semua' })).toThrow(/IP\/CIDR/);
    expect(() => parse({ TRUST_PROXY: '10.0.0.0/33' })).toThrow(/IP\/CIDR/);
  });

  it('X-Forwarded-For palsu tidak dapat mengganti IP client saat TRUST_PROXY=true', async () => {
    const app = Fastify({ trustProxy: parse({ TRUST_PROXY: 'true' }).TRUST_PROXY });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    const ipFor = async (remoteAddress: string, forwardedFor: string) => (await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor }
    })).json().ip as string;
    try {
      // Akses langsung ke port API dari luar: header diabaikan, termasuk klaim 127.0.0.1.
      expect(await ipFor('203.0.113.9', '127.0.0.1')).toBe('203.0.113.9');
      // nginx lokal menambahkan IP client asli di belakang nilai palsu kiriman client.
      expect(await ipFor('127.0.0.1', '198.51.100.7, 203.0.113.9')).toBe('203.0.113.9');
      // nginx lokal menimpa header dengan $remote_addr seperti contoh DEPLOYMENT.md.
      expect(await ipFor('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    } finally {
      await app.close();
    }
  });
});
