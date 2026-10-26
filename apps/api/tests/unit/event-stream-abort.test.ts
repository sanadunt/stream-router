import http from 'node:http';
import type { AddressInfo } from 'node:net';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sessionGate = vi.hoisted(() => ({
  calls: 0,
  wait: Promise.resolve() as Promise<void>
}));

vi.mock('../../src/plugins/auth.js', () => ({
  requireAuth: async () => undefined,
  currentSession: async () => {
    sessionGate.calls += 1;
    await sessionGate.wait;
    return { username: 'admin', role: 'admin', credentialVersion: 'v1' };
  }
}));
vi.mock('../../src/modules/routes/route-service.js', () => ({ listViewerRoutes: async () => [] }));

const { eventRoutes } = await import('../../src/modules/events/event-routes.js');

let app: FastifyInstance;
let port = 0;

beforeAll(async () => {
  app = Fastify();
  await app.register(cookie);
  await app.register(eventRoutes);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app.close();
});

interface OpenStream {
  status: number;
  close: () => void;
}

function openStream(): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/events',
      headers: { cookie: 'stream_router_session=sesi-admin' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve({ status: response.statusCode ?? 0, close: () => request.destroy() });
        return;
      }
      response.once('data', () => resolve({ status: 200, close: () => request.destroy() }));
    });
    request.once('error', reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stream SSE /api/events', () => {
  it('koneksi yang ditutup client selama pemeriksaan sesi tidak menahan slot per sesi', async () => {
    let release: () => void = () => undefined;
    sessionGate.wait = new Promise<void>((resolve) => { release = resolve; });
    const aborted: http.ClientRequest[] = [];
    for (let index = 0; index < 3; index += 1) {
      const before = sessionGate.calls;
      const request = http.get({
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { cookie: 'stream_router_session=sesi-admin' }
      });
      request.on('error', () => undefined);
      aborted.push(request);
      await vi.waitFor(() => expect(sessionGate.calls).toBe(before + 1));
    }
    for (const request of aborted) request.destroy();
    await sleep(50);
    release();
    await sleep(50);

    // Batas delapan stream per sesi tetap tersedia penuh bagi tab yang benar-benar terbuka.
    const streams = await Promise.all(Array.from({ length: 8 }, () => openStream()));
    try {
      expect(streams.map((stream) => stream.status)).toEqual(Array(8).fill(200));
      const extra = await openStream();
      extra.close();
      expect(extra.status).toBe(429);
    } finally {
      for (const stream of streams) stream.close();
    }

    // Slot dilepas saat tab ditutup.
    await sleep(50);
    const reopened = await openStream();
    reopened.close();
    expect(reopened.status).toBe(200);
  });
});
