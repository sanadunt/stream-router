import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpegOptionsSchema } from '@stream-router/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  env: { MEDIAMTX_READY_TIMEOUT_MS: 150, MEDIAMTX_CONFIG_PATH: '', NODE_ENV: 'test' },
  configs: new Map<string, Record<string, unknown>>(),
  ready: new Set<string>(),
  calls: [] as string[],
  globalPatches: [] as Array<{ authInternalUsers: Array<{ permissions: Array<{ path: string }> }> }>,
  stateDelayMs: 0,
  health: { ok: true } as { ok: boolean; error?: string },
  healthDelayMs: 0,
  activeHealth: 0,
  maxConcurrentHealth: 0,
  segmentDurationSeconds: 60,
  reapply: { reapplied: 0, failedRouteIds: [] as string[] }
}));

vi.mock('../../src/config/env.js', () => ({ getEnv: () => h.env }));

vi.mock('../../src/modules/settings/settings-service.js', () => ({
  getMediaMtxSettings: vi.fn(async () => ({
    enabled: true,
    version: 'v1.test',
    publicHost: '192.168.1.10',
    recordingPath: 'data/test-recordings',
    rtspPort: 18554,
    rtmpPort: 11935,
    hlsPort: 18888,
    webrtcPort: 18889,
    webrtcUdpPort: 18189,
    srtPort: 18890,
    playbackPort: 19996,
    apiPort: 19997,
    metricsPort: 19998,
    retentionMode: 'DAYS',
    retentionDays: 7,
    retentionMaxGb: 100,
    minFreePercent: 10,
    minFreeGb: 5,
    segmentDurationSeconds: h.segmentDurationSeconds,
    apiUrl: 'http://127.0.0.1:19997',
    rtspUrl: 'rtsp://127.0.0.1:18554',
    playbackUrl: 'http://127.0.0.1:19996'
  })),
  getFfmpegPath: vi.fn(async () => '/opt/ffmpeg')
}));

vi.mock('../../src/modules/logs/log-store.js', () => ({ appendRouteLog: vi.fn(async () => undefined) }));

vi.mock('../../src/modules/workers/ffmpeg-capabilities.js', () => ({
  detectFfmpegCapabilities: vi.fn(async () => ({ rwTimeout: true, rtspTimeout: true, libopus: true }))
}));

vi.mock('../../src/modules/routes/route-service.js', () => ({ getRuntimeRoute: vi.fn(async () => null) }));

vi.mock('../../src/modules/workers/worker-manager.js', () => ({
  workerManager: { reapplyMediaRoutes: vi.fn(async () => h.reapply) }
}));

vi.mock('../../src/modules/mediamtx/mediamtx-client.js', () => ({
  getMediaMtxPathConfig: vi.fn(async (_settings: unknown, name: string) => {
    h.calls.push(`get ${name}`);
    return h.configs.get(name) ?? null;
  }),
  upsertMediaMtxPath: vi.fn(async (_settings: unknown, name: string, config: Record<string, unknown>) => {
    h.calls.push(`upsert ${name}`);
    h.configs.set(name, { ...(h.configs.get(name) ?? {}), ...config });
  }),
  patchMediaMtxPath: vi.fn(async (_settings: unknown, name: string, config: Record<string, unknown>) => {
    h.calls.push(`patch ${name}`);
    h.configs.set(name, { ...(h.configs.get(name) ?? {}), ...config });
  }),
  deleteMediaMtxPath: vi.fn(async (_settings: unknown, name: string) => {
    h.calls.push(`delete ${name}`);
    h.configs.delete(name);
  }),
  listMediaMtxPathConfigNames: vi.fn(async () => {
    h.calls.push('list');
    return [...h.configs.keys()];
  }),
  getMediaMtxPathState: vi.fn(async (_settings: unknown, name: string) => {
    if (h.stateDelayMs) await h.sleep(h.stateDelayMs);
    const ready = h.ready.has(name);
    return { ready, tracks: ready ? ['H264'] : [], bytesReceived: 0 };
  }),
  patchMediaMtxGlobal: vi.fn(async (_settings: unknown, config: (typeof h.globalPatches)[number]) => {
    h.globalPatches.push(config);
  }),
  mediaMtxHealth: vi.fn(async () => {
    h.activeHealth += 1;
    h.maxConcurrentHealth = Math.max(h.maxConcurrentHealth, h.activeHealth);
    if (h.healthDelayMs) await h.sleep(h.healthDelayMs);
    h.activeHealth -= 1;
    return { ...h.health, paths: 0 };
  })
}));

const runtime = await import('../../src/modules/mediamtx/mediamtx-runtime.js');
const config = await import('../../src/modules/mediamtx/mediamtx-config.js');
const settingsService = await import('../../src/modules/settings/settings-service.js');
const routeService = await import('../../src/modules/routes/route-service.js');

let tmpDir = '';

function route(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    cameraKey: id,
    name: id,
    description: '',
    inputUrl: `rtsp://user:pass@192.168.1.20/${id}`,
    inputProtocol: 'RTSP' as const,
    outputs: [],
    enabled: true,
    autoStart: false,
    localViewEnabled: true,
    localAudioMode: 'COPY' as const,
    onlineRelayEnabled: false,
    onlineAudioMode: 'COPY' as const,
    recordingEnabled: true,
    recordingRetentionMode: 'INHERIT' as const,
    recordingRetentionDays: null,
    recordingRetentionGb: null,
    ffmpegMode: 'COPY' as const,
    ffmpegOptions: ffmpegOptionsSchema.parse({}),
    retryPolicy: { initialDelayMs: 1000, maxDelayMs: 60000, maxRetries: 10, jitterRatio: 0, stableResetMs: 60000 },
    webrtc: { enabled: false, url: null, mode: 'IFRAME' as const },
    ...overrides
  };
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'stream-router-mediamtx-'));
  h.env.MEDIAMTX_CONFIG_PATH = path.join(tmpDir, 'mediamtx.yml');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.configs.clear();
  h.ready.clear();
  h.calls.length = 0;
  h.globalPatches.length = 0;
  h.stateDelayMs = 0;
  h.health = { ok: true };
  h.healthDelayMs = 0;
  h.activeHealth = 0;
  h.maxConcurrentHealth = 0;
  h.segmentDurationSeconds = 60;
  h.reapply = { reapplied: 0, failedRouteIds: [] };
  runtime.setRecordingStoragePaused(false);
  vi.clearAllMocks();
});

describe('MediaMTX runtime: sinkronisasi state dan path', () => {
  it('sinkronisasi permission tidak membaca DB per route dan upsert tidak mengunduh daftar path', async () => {
    for (const id of ['perm-a', 'perm-b', 'perm-c']) h.ready.add(`cameras/${id}`);
    await runtime.ensureMediaRoute(route('perm-a'));
    await runtime.ensureMediaRoute(route('perm-b', { localViewEnabled: false }));
    await runtime.ensureMediaRoute(route('perm-c'));
    expect(routeService.getRuntimeRoute).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('list');
    const permissions = h.globalPatches.at(-1)!.authInternalUsers[1]!.permissions.map((item) => item.path);
    expect(permissions).toEqual(expect.arrayContaining(['cameras/perm-a', 'cameras/perm-c']));
    expect(permissions).not.toContain('cameras/perm-b');
    for (const id of ['perm-a', 'perm-b', 'perm-c']) await runtime.removeMediaRoute(id, id);
    expect(h.globalPatches.at(-1)!.authInternalUsers[1]!.permissions.map((item) => item.path))
      .not.toEqual(expect.arrayContaining(['cameras/perm-a']));
  });

  it('ensure yang masih menunggu READY tidak menulis ulang state setelah route dilepas', async () => {
    const pending = runtime.ensureMediaRoute(route('race-ensure')).catch((error: Error) => error);
    await h.sleep(20);
    await runtime.removeMediaRoute('race-ensure', 'race-ensure');
    expect(await pending).toBeInstanceOf(Error);
    expect(runtime.mediaRouteSnapshot('race-ensure').state).toBe('DISABLED');
    expect(runtime.activeMediaRouteIds()).not.toContain('race-ensure');
  });

  it('cek monitor yang lambat tidak menghidupkan kembali state route yang sudah dilepas', async () => {
    h.ready.add('cameras/race-check');
    await runtime.ensureMediaRoute(route('race-check'));
    h.ready.delete('cameras/race-check');
    h.stateDelayMs = 40;
    const check = runtime.checkMediaRoute('race-check');
    await h.sleep(10);
    await runtime.removeMediaRoute('race-check', 'race-check');
    await check;
    expect(runtime.activeMediaRouteIds()).not.toContain('race-check');
  });

  it('AbortSignal menghentikan tunggu READY tanpa menunggu timeout', async () => {
    h.env.MEDIAMTX_READY_TIMEOUT_MS = 5000;
    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = runtime.ensureMediaRoute(route('abort-wait'), controller.signal).catch((error: Error) => error);
      await h.sleep(30);
      controller.abort();
      const error = await pending as Error & { code?: string };
      expect(Date.now() - started).toBeLessThan(1000);
      expect(error.code).toBe('MEDIAMTX_START_CANCELLED');
      expect(runtime.mediaRouteSnapshot('abort-wait').state).not.toBe('ERROR');
    } finally {
      h.env.MEDIAMTX_READY_TIMEOUT_MS = 150;
      await runtime.removeMediaRoute('abort-wait', 'abort-wait');
    }
  });

  it('melepas path Opus lama setelah Camera ID route berubah', async () => {
    h.ready.add('cameras/kunci-lama');
    h.ready.add('cameras/kunci-lama/webrtc');
    await runtime.ensureMediaRoute(route('opus-rename', { cameraKey: 'kunci-lama', localAudioMode: 'OPUS' }));
    expect(h.configs.has('cameras/kunci-lama/webrtc')).toBe(true);
    await runtime.removeMediaRoute('opus-rename', 'kunci-baru');
    expect(h.configs.has('cameras/kunci-lama')).toBe(false);
    expect(h.configs.has('cameras/kunci-lama/webrtc')).toBe(false);
  });

  it('menghapus path cameras/* yatim tanpa menyentuh route yang dipertahankan atau terdaftar', async () => {
    h.ready.add('cameras/terdaftar');
    await runtime.ensureMediaRoute(route('terdaftar'));
    for (const name of ['cameras/auto', 'cameras/auto/webrtc', 'cameras/lama', 'cameras/lama/webrtc', 'lain/path']) {
      h.configs.set(name, {});
    }
    const removed = await runtime.removeUnmanagedMediaPaths(['auto']);
    expect(removed.sort()).toEqual(['cameras/lama', 'cameras/lama/webrtc']);
    expect([...h.configs.keys()].sort()).toEqual(['cameras/auto', 'cameras/auto/webrtc', 'cameras/terdaftar', 'lain/path']);
    await runtime.removeMediaRoute('terdaftar', 'terdaftar');
  });
});

describe('MediaMTX runtime: apply settings dan recording', () => {
  it('memasang ulang config path tanpa menunggu kamera offline READY', async () => {
    h.env.MEDIAMTX_READY_TIMEOUT_MS = 5000;
    try {
      h.ready.add('cameras/refresh-offline');
      await runtime.ensureMediaRoute(route('refresh-offline'));
      h.ready.delete('cameras/refresh-offline');
      h.configs.clear();
      h.segmentDurationSeconds = 300;
      const started = Date.now();
      expect(await runtime.refreshMediaRouteConfig(route('refresh-offline'))).toBe(true);
      expect(Date.now() - started).toBeLessThan(200);
      expect(h.configs.get('cameras/refresh-offline')).toMatchObject({ record: true, recordSegmentDuration: '300s' });
      expect(await runtime.refreshMediaRouteConfig(route('refresh-offline', { cameraKey: 'kunci-baru' }))).toBe(false);
    } finally {
      h.env.MEDIAMTX_READY_TIMEOUT_MS = 150;
      await runtime.removeMediaRoute('refresh-offline', 'refresh-offline');
    }
  });

  it('apply berhasil walau ada route gagal dipasang ulang; rollback hanya saat health gagal', async () => {
    await writeFile(h.env.MEDIAMTX_CONFIG_PATH, 'config-lama\n');
    h.reapply = { reapplied: 2, failedRouteIds: ['kamera-offline'] };
    const result = await runtime.applyMediaMtxConfiguration();
    expect(result).toMatchObject({ ok: true, reappliedRoutes: 2, failedRouteIds: ['kamera-offline'] });
    expect(await readFile(h.env.MEDIAMTX_CONFIG_PATH, 'utf8')).toContain('recordSegmentDuration: 60s');

    await writeFile(h.env.MEDIAMTX_CONFIG_PATH, 'config-lama\n');
    h.health = { ok: false, error: 'connection refused' };
    await expect(runtime.applyMediaMtxConfiguration()).rejects.toThrow('telah di-rollback: connection refused');
    expect(await readFile(h.env.MEDIAMTX_CONFIG_PATH, 'utf8')).toBe('config-lama\n');
  });

  it('rollback tanpa file sebelumnya menulis config dari settings lama dan apply diserialisasi', async () => {
    await rm(h.env.MEDIAMTX_CONFIG_PATH, { force: true });
    h.health = { ok: false, error: 'health check gagal' };
    h.segmentDurationSeconds = 900;
    const previousSettings = { ...await settingsService.getMediaMtxSettings(), segmentDurationSeconds: 120 };
    await expect(runtime.applyMediaMtxConfiguration(previousSettings)).rejects.toThrow('telah di-rollback');
    const restored = await readFile(h.env.MEDIAMTX_CONFIG_PATH, 'utf8');
    expect(restored).toBe(config.renderMediaMtxConfig(previousSettings));

    await rm(h.env.MEDIAMTX_CONFIG_PATH, { force: true });
    await expect(runtime.applyMediaMtxConfiguration()).rejects.toThrow('Tidak ada file konfigurasi sebelumnya');

    h.health = { ok: true };
    h.healthDelayMs = 30;
    await Promise.all([runtime.applyMediaMtxConfiguration(), runtime.applyMediaMtxConfiguration()]);
    expect(h.maxConcurrentHealth).toBe(1);
  });

  it('penulisan config bersamaan memakai file sementara unik dan tidak meninggalkan sisa', async () => {
    const settings = await settingsService.getMediaMtxSettings();
    await Promise.all(Array.from({ length: 6 }, () => config.writeMediaMtxConfig(settings)));
    const files = await readdir(tmpDir);
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(h.env.MEDIAMTX_CONFIG_PATH, 'utf8')).toBe(config.renderMediaMtxConfig(settings));
  });

  it('pause storage hanya mem-patch flag record pada path READY tanpa melempar error', async () => {
    h.ready.add('cameras/pause-ready');
    await runtime.ensureMediaRoute(route('pause-ready'));
    runtime.setRecordingStoragePaused(true);
    expect(await runtime.applyMediaRouteRecordingState(route('pause-ready'))).toBe(true);
    expect(h.configs.get('cameras/pause-ready')).toMatchObject({ record: false, source: expect.stringContaining('rtsp://') });
    runtime.setRecordingStoragePaused(false);
    expect(await runtime.applyMediaRouteRecordingState(route('pause-ready'))).toBe(true);
    expect(h.configs.get('cameras/pause-ready')).toMatchObject({ record: true, recordFormat: 'fmp4' });

    expect(await runtime.applyMediaRouteRecordingState(route('pause-ready', { recordingEnabled: false }))).toBe(false);
    h.configs.delete('cameras/pause-ready');
    expect(await runtime.applyMediaRouteRecordingState(route('pause-ready'))).toBe(false);
    expect(h.configs.has('cameras/pause-ready')).toBe(false);
    expect(await runtime.applyMediaRouteRecordingState(route('belum-ready'))).toBe(false);
    await runtime.removeMediaRoute('pause-ready', 'pause-ready');
  });
});

describe('MediaMTX runtime: error operasional dan apply terserialisasi', () => {
  it('kamera offline, MediaMTX dinonaktifkan, dan Control API gagal menjadi AppError dengan alasan', async () => {
    const offline = await runtime.ensureMediaRoute(route('err-offline')).catch((error: unknown) => error);
    expect(offline).toMatchObject({ code: 'MEDIAMTX_INGEST_NOT_READY', statusCode: 503, message: 'Source kamera belum mengirim media' });
    await runtime.removeMediaRoute('err-offline', 'err-offline');

    const disabledSettings = { ...await settingsService.getMediaMtxSettings(), enabled: false };
    vi.mocked(settingsService.getMediaMtxSettings).mockResolvedValueOnce(disabledSettings);
    await expect(runtime.ensureMediaRoute(route('err-disabled'))).rejects.toMatchObject({ code: 'MEDIAMTX_DISABLED', statusCode: 409 });

    const client = await import('../../src/modules/mediamtx/mediamtx-client.js');
    vi.mocked(client.upsertMediaMtxPath).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:19997'));
    const unavailable = await runtime.ensureMediaRoute(route('err-api')).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({ code: 'MEDIAMTX_UNAVAILABLE', statusCode: 502 });
    expect((unavailable as Error).message).toContain('ECONNREFUSED');
    await runtime.removeMediaRoute('err-api', 'err-api');
  });

  it('apply menandai path belum READY sebelum reload dan monitor ditahan selama apply', async () => {
    h.ready.add('cameras/apply-state');
    await runtime.ensureMediaRoute(route('apply-state'));
    expect(runtime.mediaRouteSnapshot('apply-state').ready).toBe(true);
    const client = await import('../../src/modules/mediamtx/mediamtx-client.js');
    const seen: Array<{ ready: boolean; reloading: boolean }> = [];
    vi.mocked(client.mediaMtxHealth).mockImplementationOnce(async () => {
      seen.push({ ready: runtime.mediaRouteSnapshot('apply-state').ready, reloading: runtime.mediaConfigReloading() });
      return { ok: true, paths: 0 };
    });
    await runtime.applyMediaMtxConfiguration();
    expect(seen).toEqual([{ ready: false, reloading: true }]);
    expect(runtime.mediaConfigReloading()).toBe(false);
    // Monitor yang mengembalikan READY setelah apply selesai.
    expect((await runtime.checkMediaRoute('apply-state')).ready).toBe(true);
    await runtime.removeMediaRoute('apply-state', 'apply-state');
  });

  it('task dalam lock apply tidak tumpang tindih dengan apply lain', async () => {
    const order: string[] = [];
    h.healthDelayMs = 20;
    await Promise.all([
      runtime.withMediaMtxConfigLock(async (apply) => {
        order.push('a:mulai');
        await h.sleep(30);
        await apply();
        order.push('a:selesai');
      }),
      runtime.withMediaMtxConfigLock(async () => {
        order.push('b:mulai');
        order.push('b:selesai');
      })
    ]);
    expect(order).toEqual(['a:mulai', 'a:selesai', 'b:mulai', 'b:selesai']);
  });

  it('cleanup boot tidak menghapus path route yang di-Start selama daftar path diunduh', async () => {
    h.configs.set('cameras/yatim-boot', {});
    h.ready.add('cameras/start-saat-boot');
    const client = await import('../../src/modules/mediamtx/mediamtx-client.js');
    vi.mocked(client.listMediaMtxPathConfigNames).mockImplementationOnce(async () => {
      const names = [...h.configs.keys(), 'cameras/start-saat-boot'];
      await runtime.ensureMediaRoute(route('start-saat-boot'));
      return names;
    });
    const removed = await runtime.removeUnmanagedMediaPaths([]);
    expect(removed).toEqual(['cameras/yatim-boot']);
    expect(h.configs.has('cameras/start-saat-boot')).toBe(true);
    await runtime.removeMediaRoute('start-saat-boot', 'start-saat-boot');
  });

  it('cleanup boot tidak menyentuh MediaMTX ketika MediaMTX dinonaktifkan', async () => {
    h.configs.set('cameras/milik-proses-lain', {});
    const client = await import('../../src/modules/mediamtx/mediamtx-client.js');
    const disabledSettings = { ...await settingsService.getMediaMtxSettings(), enabled: false };
    vi.mocked(settingsService.getMediaMtxSettings).mockResolvedValueOnce(disabledSettings);
    vi.mocked(client.listMediaMtxPathConfigNames).mockClear();
    expect(await runtime.removeUnmanagedMediaPaths([])).toEqual([]);
    expect(client.listMediaMtxPathConfigNames).not.toHaveBeenCalled();
    expect(h.configs.has('cameras/milik-proses-lain')).toBe(true);
    h.configs.delete('cameras/milik-proses-lain');
  });
});
