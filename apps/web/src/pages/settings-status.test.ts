import { afterEach, describe, expect, it, vi } from 'vitest';
import { onSessionExpired } from '../api/client';
import { brokerPasswordRequired, fetchFullHealthReport, isFullHealthReport, mediaApplyWarning } from './settings-status';

const fullReport = {
  ok: true,
  timestamp: '2026-10-24T00:00:00.000Z',
  database: { ok: true },
  ffmpeg: { ok: true, version: 'ffmpeg version 7' },
  mediaMtx: { ok: true, enabled: true, version: 'v1.9.0', activeRoutes: 2 },
  workers: { ok: true, active: 1 },
  process: { uptimeSeconds: 10, memory: { rss: 1024 } }
};
const shortReport = { ok: true, timestamp: '2026-10-24T00:00:00.000Z' };
const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'Silakan login terlebih dahulu', details: null, requestId: 'r1' } };

function stubResponses(responses: Record<string, { status: number; body: unknown }>) {
  const fetchMock = vi.fn(async (path: string) => {
    const response = responses[path];
    if (!response) throw new Error(`request tak terduga ke ${path}`);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Settings System Health', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hanya menerima laporan health lengkap, bukan ringkasan {ok, timestamp}', () => {
    expect(isFullHealthReport(fullReport)).toBe(true);
    expect(isFullHealthReport(shortReport)).toBe(false);
    expect(isFullHealthReport({ ...fullReport, process: undefined })).toBe(false);
    expect(isFullHealthReport(null)).toBe(false);
  });

  it('memakai laporan lengkap tanpa request tambahan', async () => {
    const fetchMock = stubResponses({ '/api/health': { status: 200, body: fullReport } });
    await expect(fetchFullHealthReport()).resolves.toEqual(fullReport);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ringkasan health saat sesi berakhir memicu redirect login lewat endpoint admin, bukan merender laporan', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    stubResponses({
      '/api/health': { status: 200, body: shortReport },
      '/api/settings': { status: 401, body: unauthorized }
    });
    await expect(fetchFullHealthReport()).rejects.toThrow('Silakan login terlebih dahulu');
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ringkasan health dengan sesi masih valid menjadi error health, bukan crash render', async () => {
    stubResponses({
      '/api/health': { status: 200, body: shortReport },
      '/api/settings': { status: 200, body: { appName: 'Camera Integration' } }
    });
    await expect(fetchFullHealthReport()).rejects.toThrow('laporan lengkap tidak tersedia');
  });
});

describe('Settings apply MediaMTX', () => {
  it('menampilkan peringatan berisi nama route yang gagal dipasang ulang', () => {
    const names = new Map([['route-1', 'Kamera Lobi']]);
    const warning = mediaApplyWarning({ failedRouteIds: ['route-1', 'route-2'] }, names);
    expect(warning).toContain('2 route aktif gagal dipasang ulang: Kamera Lobi, route-2');
  });

  it('tidak memberi peringatan saat semua route berhasil atau respons tidak memuat daftar', () => {
    expect(mediaApplyWarning({ failedRouteIds: [] }, new Map())).toBe('');
    expect(mediaApplyWarning({}, new Map())).toBe('');
    expect(mediaApplyWarning(undefined, new Map())).toBe('');
  });
});

describe('Settings broker MQTT', () => {
  const stored = { protocol: 'mqtt', host: 'broker.local', port: 1883, passwordConfigured: true };

  it('mewajibkan password diketik ulang saat protocol, host, atau port broker berpassword berubah', () => {
    expect(brokerPasswordRequired(stored, { protocol: 'mqtt', host: ' broker.local ', port: 1883 })).toBe(false);
    expect(brokerPasswordRequired(stored, { protocol: 'mqtts', host: 'broker.local', port: 1883 })).toBe(true);
    expect(brokerPasswordRequired(stored, { protocol: 'mqtt', host: 'broker.baru', port: 1883 })).toBe(true);
    expect(brokerPasswordRequired(stored, { protocol: 'mqtt', host: 'broker.local', port: 8883 })).toBe(true);
  });

  it('tidak mewajibkan password untuk broker baru atau broker tanpa password', () => {
    expect(brokerPasswordRequired(null, { protocol: 'mqtt', host: 'x', port: 1 })).toBe(false);
    expect(brokerPasswordRequired({ ...stored, passwordConfigured: false }, { protocol: 'ws', host: 'x', port: 1 })).toBe(false);
  });
});
