import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.js';
import { isSessionCookieSecure } from '../../src/modules/auth/session-cookie.js';
import {
  allowedRequestHostnames,
  isAllowedRequestHost,
  isAllowedRequestOrigin,
  isSameOriginRequest,
  requestHostname
} from '../../src/shared/request-origin.js';

const trustLoopbackProxy = envSchema.parse({
  AUTH_SECRET: 'a'.repeat(32),
  APP_ENCRYPTION_KEY: 'b'.repeat(32),
  ADMIN_PASSWORD: 'password123',
  OPERATOR_PASSWORD: 'operator-password123',
  TRUST_PROXY: 'true'
}).TRUST_PROXY;

describe('atribut Secure cookie sesi', () => {
  it('tanpa COOKIE_SECURE tetap mengikuti NODE_ENV seperti sebelumnya', () => {
    expect(isSessionCookieSecure('', 'production', 'http')).toBe(true);
    expect(isSessionCookieSecure('', 'development', 'https')).toBe(false);
    expect(isSessionCookieSecure('', 'test', 'http')).toBe(false);
  });

  it('COOKIE_SECURE=auto hanya memasang Secure untuk request HTTPS', () => {
    expect(isSessionCookieSecure('auto', 'production', 'http')).toBe(false);
    expect(isSessionCookieSecure('auto', 'production', 'https')).toBe(true);
    expect(isSessionCookieSecure('auto', 'production', undefined)).toBe(false);
    expect(isSessionCookieSecure('auto', 'development', 'https')).toBe(true);
  });

  it('COOKIE_SECURE=true/false mengabaikan NODE_ENV dan protocol', () => {
    expect(isSessionCookieSecure(true, 'development', 'http')).toBe(true);
    expect(isSessionCookieSecure(false, 'production', 'https')).toBe(false);
  });
});

describe('pemeriksaan origin request', () => {
  it('menerima Origin yang sama dengan protocol dan Host request', () => {
    expect(isSameOriginRequest('http://192.168.1.10:3000', 'http', '192.168.1.10:3000')).toBe(true);
    expect(isSameOriginRequest('https://kamera.example.com', 'https', 'kamera.example.com')).toBe(true);
    expect(isSameOriginRequest('http://[fd00::10]:3000', 'http', '[fd00::10]:3000')).toBe(true);
    // Huruf besar dan port default pada Host tidak membuat origin yang sama ditolak.
    expect(isSameOriginRequest('http://kamera.lan', 'http', 'Kamera.LAN:80')).toBe(true);
  });

  it('menolak Origin asing, beda protocol, beda port, atau Host yang tidak wajar', () => {
    expect(isSameOriginRequest('http://evil.example', 'http', '192.168.1.10:3000')).toBe(false);
    expect(isSameOriginRequest('https://192.168.1.10:3000', 'http', '192.168.1.10:3000')).toBe(false);
    expect(isSameOriginRequest('http://192.168.1.10:3001', 'http', '192.168.1.10:3000')).toBe(false);
    expect(isSameOriginRequest('null', 'http', '192.168.1.10:3000')).toBe(false);
    expect(isSameOriginRequest('http://192.168.1.10:3000', 'http', undefined)).toBe(false);
    expect(isSameOriginRequest('http://192.168.1.10:3000', 'ws', '192.168.1.10:3000')).toBe(false);
    // Tanpa validasi Host, `evil@192.168.1.10:3000` akan dibaca URL sebagai userinfo + host target.
    expect(isSameOriginRequest('http://192.168.1.10:3000', 'http', 'evil@192.168.1.10:3000')).toBe(false);
    expect(isSameOriginRequest('http://192.168.1.10:3000', 'http', '192.168.1.10:3000/x')).toBe(false);
  });

  it('CORS_ORIGIN tetap diterima walau berbeda dari Host', () => {
    expect(isAllowedRequestOrigin('https://cams.example.com', 'https://cams.example.com', 'http', '127.0.0.1:3000')).toBe(true);
    expect(isAllowedRequestOrigin('https://evil.example', 'https://cams.example.com', 'http', '127.0.0.1:3000')).toBe(false);
  });

  it('allowlist Host menerima IP literal, localhost, host CORS_ORIGIN, MEDIAMTX_PUBLIC_HOST, dan ALLOWED_HOSTS', () => {
    const allowed = allowedRequestHostnames({
      corsOrigin: 'https://cams.example.com',
      publicHost: 'media.lan',
      allowedHosts: ['pc-kamera']
    });
    for (const host of [
      '192.168.1.10:3000', '127.0.0.1:3000', '127.0.0.1', '[::1]:3000', '[fd00::10]', '0.0.0.0:3000',
      'localhost:3000', 'LOCALHOST', 'localhost.:3000', 'cams.example.com', 'Cams.Example.com:443',
      'media.lan:3000', 'PC-KAMERA:3000', undefined, ''
    ]) {
      expect(isAllowedRequestHost(host, allowed), String(host)).toBe(true);
    }
  });

  it('allowlist Host menolak domain DNS rebinding dan Host yang tidak wajar', () => {
    const allowed = allowedRequestHostnames({ corsOrigin: 'http://localhost:3000', publicHost: '192.168.1.10' });
    for (const host of [
      'rebind.attacker.example:3000', 'rebind.attacker.example', '192.168.1.10.nip.io:3000',
      'localhost.attacker.example', 'cams.example.com', 'evil@192.168.1.10:3000', '192.168.1.10:3000/x',
      'pc-kamera:3000', '[zz::1]:3000'
    ]) {
      expect(isAllowedRequestHost(host, allowed), host).toBe(false);
    }
  });

  it('requestHostname membuang port, kurung IPv6, dan titik akhir', () => {
    expect(requestHostname('Kamera.LAN:3000')).toBe('kamera.lan');
    expect(requestHostname('[FD00::10]:3000')).toBe('fd00::10');
    expect(requestHostname('kamera.lan.')).toBe('kamera.lan');
    expect(requestHostname('x@kamera.lan')).toBeNull();
  });

  it('X-Forwarded-Proto palsu dari client langsung tidak mengubah protocol cookie maupun origin', async () => {
    const app = Fastify({ trustProxy: trustLoopbackProxy });
    app.get('/probe', async (request) => ({
      secure: isSessionCookieSecure('auto', 'production', request.protocol),
      sameOrigin: isSameOriginRequest('https://192.168.1.10:3000', request.protocol, request.headers.host)
    }));
    const probe = async (remoteAddress: string) => (await app.inject({
      method: 'GET',
      url: '/probe',
      remoteAddress,
      headers: { host: '192.168.1.10:3000', 'x-forwarded-proto': 'https' }
    })).json() as { secure: boolean; sameOrigin: boolean };
    try {
      expect(await probe('192.168.1.77')).toEqual({ secure: false, sameOrigin: false });
      // Reverse proxy TLS di host yang sama (TRUST_PROXY=true) dipercaya.
      expect(await probe('127.0.0.1')).toEqual({ secure: true, sameOrigin: true });
    } finally {
      await app.close();
    }
  });
});
