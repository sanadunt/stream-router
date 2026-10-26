import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteMediaMtxPath, upsertMediaMtxPath } from '../../src/modules/mediamtx/mediamtx-client.js';

const settings = { apiUrl: 'http://127.0.0.1:19997' } as Parameters<typeof upsertMediaMtxPath>[0];

function stubFetch(existing: Set<string>): string[] {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const name = decodeURIComponent(url.pathname.split('/').slice(5).join('/'));
    if (url.pathname.startsWith('/v3/config/paths/get/')) {
      return existing.has(name)
        ? new Response(JSON.stringify({ name }), { status: 200 })
        : new Response('path not found', { status: 404 });
    }
    return new Response(null, { status: 200 });
  }));
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MediaMTX client', () => {
  it('upsert dan delete memeriksa satu path tanpa mengunduh seluruh daftar config', async () => {
    const requests = stubFetch(new Set(['cameras/ada']));
    await upsertMediaMtxPath(settings, 'cameras/baru', { record: false });
    await upsertMediaMtxPath(settings, 'cameras/ada', { record: true });
    await deleteMediaMtxPath(settings, 'cameras/tidak-ada');
    await deleteMediaMtxPath(settings, 'cameras/ada');
    expect(requests).toEqual([
      'GET /v3/config/paths/get/cameras%2Fbaru',
      'POST /v3/config/paths/add/cameras%2Fbaru',
      'GET /v3/config/paths/get/cameras%2Fada',
      'PATCH /v3/config/paths/patch/cameras%2Fada',
      'GET /v3/config/paths/get/cameras%2Ftidak-ada',
      'GET /v3/config/paths/get/cameras%2Fada',
      'DELETE /v3/config/paths/delete/cameras%2Fada'
    ]);
    expect(requests.some((request) => request.includes('/v3/config/paths/list'))).toBe(false);
  });
});
