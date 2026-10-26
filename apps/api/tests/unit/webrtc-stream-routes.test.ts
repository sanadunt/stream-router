import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  headers: {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'content-length': '12345',
    'content-range': 'bytes 0-12344/99999'
  },
  localMp4Response: vi.fn(),
  localMp4Head: vi.fn()
}));

vi.mock('../../src/plugins/auth.js', () => ({
  requireAuth: async () => undefined,
  requireRoles: () => async () => undefined
}));

vi.mock('../../src/modules/ptz/ptz-controller.js', () => ({
  releasePtzTarget: async () => undefined
}));

vi.mock('../../src/modules/webrtc-streams/webrtc-stream-service.js', () => ({
  createWebrtcStream: vi.fn(),
  deleteWebrtcStream: vi.fn(),
  getWebrtcStream: vi.fn(),
  listMp4Files: vi.fn(),
  listWebrtcStreams: vi.fn(),
  localMp4Head: service.localMp4Head,
  localMp4Response: service.localMp4Response,
  toWebrtcStreamEditDto: vi.fn(),
  toWebrtcStreamDto: vi.fn(),
  updateWebrtcStream: vi.fn()
}));

const { webrtcStreamRoutes } = await import('../../src/modules/webrtc-streams/webrtc-stream-routes.js');
const app = Fastify();
await app.register(webrtcStreamRoutes);
await app.ready();

afterAll(async () => {
  await app.close();
});

describe('Viewer stream file: HEAD tanpa membaca file', () => {
  beforeEach(() => {
    service.localMp4Response.mockReset();
    service.localMp4Head.mockReset();
    service.localMp4Head.mockResolvedValue({ status: 206, headers: service.headers });
    service.localMp4Response.mockImplementation(async () => ({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      stream: Readable.from([Buffer.from('mp4!')])
    }));
  });

  it('HEAD memakai metadata saja dan mempertahankan content-length asli', async () => {
    const response = await app.inject({
      method: 'HEAD',
      url: '/api/viewer/stream-files/stream-1',
      headers: { range: 'bytes=0-' }
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-length']).toBe('12345');
    expect(response.headers['content-range']).toBe('bytes 0-12344/99999');
    expect(response.rawPayload).toHaveLength(0);
    expect(service.localMp4Head).toHaveBeenCalledWith('stream-1', 'bytes=0-');
    expect(service.localMp4Response).not.toHaveBeenCalled();
  });

  it('GET tetap mengalirkan isi file', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/viewer/stream-files/stream-1' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('mp4!');
    expect(service.localMp4Response).toHaveBeenCalledWith('stream-1', undefined);
    expect(service.localMp4Head).not.toHaveBeenCalled();
  });
});
