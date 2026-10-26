import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ffmpegOptionsSchema } from '@stream-router/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    sleep,
    routes: new Map<string, Record<string, unknown>>(),
    media: new Map<string, { state: string; ready: boolean; path: string; lastError: string | null }>(),
    paths: new Set<string>(),
    cameraOnline: new Map<string, boolean>(),
    readyTimeoutMs: 60,
    maxWorkers: 10,
    storagePaused: false,
    configReloading: false,
    refreshFails: new Set<string>(),
    logs: [] as Array<{ routeId: string; level: string; message: string }>,
    logDelay: null as null | ((message: string) => number),
    failLogs: false,
    failRouteRunUpdate: false,
    spawn: (() => { throw new Error('spawn belum disiapkan'); }) as (command: string, args: string[], options: Record<string, unknown>) => unknown
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: string[], options: Record<string, unknown>) => h.spawn(command, args, options) };
});

vi.mock('../../src/db/client.js', () => ({
  prisma: {
    routeRun: {
      create: vi.fn(async () => ({ id: `run-${Math.random().toString(16).slice(2)}` })),
      update: vi.fn(async () => {
        if (h.failRouteRunUpdate) throw new Error('SQLITE_BUSY: database is locked');
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 0 }))
    }
  }
}));

vi.mock('../../src/modules/routes/route-service.js', () => ({
  audit: vi.fn(async () => undefined),
  getRuntimeRoute: vi.fn(async (id: string) => {
    const route = h.routes.get(id);
    if (!route) throw new Error('ROUTE_NOT_FOUND');
    return route;
  }),
  listAutoStartRoutes: vi.fn(async () => [...h.routes.values()].filter((route) => route.autoStart && route.enabled))
}));

vi.mock('../../src/modules/settings/settings-service.js', () => ({
  getSettings: vi.fn(async () => ({ maxWorkers: h.maxWorkers, gracefulShutdownTimeoutMs: 300, ffmpegPath: '/opt/ffmpeg' })),
  getMediaMtxSettings: vi.fn(async () => ({ enabled: true, rtspUrl: 'rtsp://127.0.0.1:18554' }))
}));

vi.mock('../../src/modules/logs/log-store.js', () => ({
  appendRouteLog: vi.fn(async (routeId: string, level: string, message: string) => {
    const delay = h.logDelay?.(message) ?? 0;
    if (delay) await h.sleep(delay);
    if (h.failLogs) throw new Error('ENOSPC: no space left on device');
    h.logs.push({ routeId, level, message });
  })
}));

vi.mock('../../src/modules/mqtt-bridge/mqtt-bridge-runtime.js', () => ({
  startMqttOnvifBridge: vi.fn(async () => undefined),
  stopMqttOnvifBridge: vi.fn(async () => undefined)
}));

vi.mock('../../src/modules/workers/ffmpeg-capabilities.js', () => ({
  detectFfmpegCapabilities: vi.fn(async () => ({ rwTimeout: true, rtspTimeout: true, libopus: true }))
}));

vi.mock('../../src/modules/mediamtx/mediamtx-runtime.js', () => {
  const disabled = (path = '') => ({ state: 'DISABLED', ready: false, path, lastError: null });
  const ready = (path: string) => ({ state: 'READY', ready: true, path, lastError: null });
  const failed = (path: string, lastError: string) => ({ state: 'ERROR', ready: false, path, lastError });
  return {
    mediaPath: (key: string) => `cameras/${key}`,
    mediaWebrtcPath: (key: string) => `cameras/${key}/webrtc`,
    mediaRouteSnapshot: (id: string) => h.media.get(id) ?? disabled(),
    activeMediaRouteIds: () => [...h.media.keys()],
    isMediaRouteConfigured: (id: string) => h.media.has(id),
    recordingStoragePaused: () => h.storagePaused,
    mediaConfigReloading: () => h.configReloading,
    ensureMediaRoute: vi.fn(async (route: { id: string; cameraKey: string }, signal?: AbortSignal) => {
      const path = `cameras/${route.cameraKey}`;
      h.media.set(route.id, { state: 'CONFIGURING', ready: false, path, lastError: null });
      h.paths.add(path);
      const deadline = Date.now() + h.readyTimeoutMs;
      while (!h.cameraOnline.get(route.id)) {
        if (signal?.aborted) throw signal.reason;
        if (Date.now() >= deadline) {
          h.media.set(route.id, failed(path, 'Source kamera belum mengirim media'));
          throw new Error('Source kamera belum mengirim media');
        }
        await h.sleep(5);
      }
      h.media.set(route.id, ready(path));
      return h.media.get(route.id);
    }),
    checkMediaRoute: vi.fn(async (id: string) => {
      const current = h.media.get(id);
      if (!current) return disabled();
      const next = h.cameraOnline.get(id) && h.paths.has(current.path)
        ? ready(current.path)
        : failed(current.path, 'MediaMTX ingest tidak READY');
      h.media.set(id, next);
      return next;
    }),
    removeMediaRoute: vi.fn(async (id: string, cameraKey: string) => {
      const path = h.media.get(id)?.path ?? (cameraKey ? `cameras/${cameraKey}` : null);
      if (path) h.paths.delete(path);
      h.media.delete(id);
    }),
    reconfigureMediaRouteRecording: vi.fn(async () => 'ACTIVE'),
    refreshMediaRouteConfig: vi.fn(async (route: { id: string }) => {
      if (h.refreshFails.has(route.id)) throw new Error('MediaMTX API 400: source tidak valid');
      return true;
    }),
    applyMediaRouteRecordingState: vi.fn(async (route: { id: string; recordingEnabled: boolean }) => (
      route.recordingEnabled && Boolean(h.media.get(route.id)?.ready)
    )),
    removeUnmanagedMediaPaths: vi.fn(async (keep: Iterable<string>) => {
      const keepKeys = new Set(keep);
      for (const state of h.media.values()) keepKeys.add(state.path.split('/')[1] ?? '');
      const removed = [...h.paths].filter((path) => !keepKeys.has(path.split('/')[1] ?? ''));
      for (const path of removed) h.paths.delete(path);
      return removed;
    })
  };
});

const { WorkerManager } = await import('../../src/modules/workers/worker-manager.js');
const runtime = await import('../../src/modules/mediamtx/mediamtx-runtime.js');
const routeService = await import('../../src/modules/routes/route-service.js');
const { prisma } = await import('../../src/db/client.js');

let pidSequence = 1000;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = ++pidSequence;
  exitCode: number | null = null;
  killed = false;
  closed = false;
  readonly signals: string[] = [];

  constructor(readonly args: string[], readonly options: Record<string, unknown>) {
    super();
    setImmediate(() => this.emit('spawn'));
  }

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.killed = true;
    setImmediate(() => this.finish(null, signal));
    return true;
  }

  crash(code = 1): void {
    this.finish(code, null);
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }
}

const children: FakeChild[] = [];
h.spawn = (_command, args, options) => {
  const child = new FakeChild(args, options);
  children.push(child);
  return child;
};

type Manager = InstanceType<typeof WorkerManager>;
interface ManagerInternals {
  reconcileMediaRoutes(): Promise<void>;
  pendingRetries: Map<string, unknown>;
}

function internals(manager: Manager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function addRoute(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const route = {
    id,
    cameraKey: id,
    name: id,
    description: '',
    inputUrl: `rtsp://127.0.0.1/${id}`,
    inputProtocol: 'RTSP',
    outputs: ['rtmp://127.0.0.1/live/out'],
    enabled: true,
    autoStart: false,
    localViewEnabled: true,
    localAudioMode: 'COPY',
    onlineRelayEnabled: true,
    onlineAudioMode: 'COPY',
    recordingEnabled: false,
    ffmpegMode: 'COPY',
    ffmpegOptions: ffmpegOptionsSchema.parse({}),
    retryPolicy: { initialDelayMs: 20, maxDelayMs: 40, maxRetries: 3, jitterRatio: 0, stableResetMs: 60_000 },
    webrtc: { enabled: false, url: null, mode: 'IFRAME' },
    ...overrides
  };
  h.routes.set(id, route);
  h.cameraOnline.set(id, true);
  return route;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Kondisi tidak tercapai dalam batas waktu');
    await h.sleep(5);
  }
}

function childrenOf(routeId: string): FakeChild[] {
  return children.filter((child) => child.args.some((arg) => arg.endsWith(`/cameras/${routeId}`)));
}

let manager: Manager;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  h.routes.clear();
  h.media.clear();
  h.paths.clear();
  h.cameraOnline.clear();
  h.refreshFails.clear();
  h.logs.length = 0;
  h.logDelay = null;
  h.failLogs = false;
  h.failRouteRunUpdate = false;
  h.readyTimeoutMs = 60;
  h.maxWorkers = 10;
  h.storagePaused = false;
  h.configReloading = false;
  children.length = 0;
  unhandled.length = 0;
  vi.clearAllMocks();
  process.on('unhandledRejection', onUnhandled);
  manager = new WorkerManager();
});

afterEach(async () => {
  vi.useRealTimers();
  await manager.shutdown();
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('WorkerManager: status route media-only', () => {
  it('Stop dan deinisiasi route media-only mengubah status menjadi STOPPED dan bisa di-Start lagi', async () => {
    addRoute('lokal', { onlineRelayEnabled: false, outputs: [] });
    expect((await manager.start('lokal')).status).toBe('RUNNING');
    const stopped = await manager.stop('lokal');
    expect(stopped.status).toBe('STOPPED');
    expect(manager.snapshot('lokal').status).toBe('STOPPED');
    expect(manager.isActive('lokal')).toBe(false);
    expect(h.paths.has('cameras/lokal')).toBe(false);
    expect(routeService.audit).toHaveBeenCalledWith('ROUTE_STOP', 'lokal', {});

    expect((await manager.start('lokal')).status).toBe('RUNNING');
    expect(runtime.ensureMediaRoute).toHaveBeenCalledTimes(2);
  });

  it('route media-only yang ingest-nya hilang dilaporkan RESTARTING, bukan RUNNING', async () => {
    addRoute('offline', { onlineRelayEnabled: false, outputs: [] });
    await manager.start('offline');
    h.media.set('offline', { state: 'ERROR', ready: false, path: 'cameras/offline', lastError: 'MediaMTX ingest tidak READY' });
    expect(manager.snapshot('offline')).toMatchObject({ status: 'RESTARTING', lastError: 'MediaMTX ingest tidak READY' });
  });
});

describe('WorkerManager: Start pada relay FAILED atau backoff', () => {
  it('Start pada relay FAILED menjalankan FFmpeg baru dengan restartCount 0', async () => {
    addRoute('gagal', { retryPolicy: { initialDelayMs: 20, maxDelayMs: 40, maxRetries: 0, jitterRatio: 0, stableResetMs: 60_000 } });
    await manager.start('gagal');
    await waitFor(() => manager.snapshot('gagal').status === 'RUNNING');
    childrenOf('gagal')[0]!.crash();
    await waitFor(() => manager.snapshot('gagal').status === 'FAILED');

    const started = await manager.start('gagal');
    expect(childrenOf('gagal')).toHaveLength(2);
    expect(started.pid).not.toBeNull();
    expect(started.restartCount).toBe(0);
    await waitFor(() => manager.snapshot('gagal').status === 'RUNNING');
    expect(runtime.ensureMediaRoute).toHaveBeenCalledTimes(1);
  });

  it('Start saat backoff relay langsung mencoba lagi, bukan RUNNING tanpa proses', async () => {
    addRoute('backoff', { retryPolicy: { initialDelayMs: 10_000, maxDelayMs: 10_000, maxRetries: 5, jitterRatio: 0, stableResetMs: 60_000 } });
    await manager.start('backoff');
    await waitFor(() => manager.snapshot('backoff').status === 'RUNNING');
    childrenOf('backoff')[0]!.crash();
    await waitFor(() => internals(manager).pendingRetries.has('backoff'));
    expect(manager.snapshot('backoff').status).toBe('RESTARTING');

    const started = await manager.start('backoff');
    expect(started.pid).not.toBeNull();
    expect(childrenOf('backoff')).toHaveLength(2);
    expect(internals(manager).pendingRetries.has('backoff')).toBe(false);
  });

  it('relay tanpa worker tidak pernah dilaporkan RUNNING saat start gagal setelah media READY', async () => {
    h.maxWorkers = 1;
    addRoute('slot-a');
    addRoute('slot-b');
    const results = await Promise.allSettled([manager.start('slot-a'), manager.start('slot-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe('MAX_WORKERS');
    expect(children).toHaveLength(1);
    const loser = children[0]!.args.some((arg) => arg.endsWith('/cameras/slot-a')) ? 'slot-b' : 'slot-a';
    expect(manager.snapshot(loser).status).toBe('FAILED');
  });
});

describe('WorkerManager: ketahanan handler FFmpeg', () => {
  it('kegagalan tulis log dan RouteRun tidak menggagalkan penjadwalan retry atau membuat unhandled rejection', async () => {
    addRoute('disk-penuh');
    await manager.start('disk-penuh');
    await waitFor(() => manager.snapshot('disk-penuh').status === 'RUNNING');
    h.failLogs = true;
    h.failRouteRunUpdate = true;
    const first = childrenOf('disk-penuh')[0]!;
    first.writeStderr('Connection reset by peer\n');
    first.crash();
    await waitFor(() => childrenOf('disk-penuh').length === 2);
    await waitFor(() => manager.snapshot('disk-penuh').status === 'RUNNING');
    expect(manager.snapshot('disk-penuh').restartCount).toBe(1);
  });

  it('Stop yang datang saat handleExit berjalan tidak dibatalkan oleh retry', async () => {
    addRoute('hilang');
    await manager.start('hilang');
    await waitFor(() => manager.snapshot('hilang').status === 'RUNNING');
    h.logDelay = (message) => message.startsWith('FFmpeg online berhenti') ? 60 : 0;
    childrenOf('hilang')[0]!.crash();
    await waitFor(() => manager.snapshot('hilang').status === 'RESTARTING');
    const stopped = await manager.stop('hilang');
    expect(stopped.status).toBe('STOPPED');
    await h.sleep(150);
    expect(childrenOf('hilang')).toHaveLength(1);
    expect(manager.snapshot('hilang').status).toBe('STOPPED');
    expect(manager.isActive('hilang')).toBe(false);
    expect(h.paths.has('cameras/hilang')).toBe(false);
  });

  it('progress FFmpeg tidak ditulis ke log dan tidak menjadi lastError; deteksi rw_timeout lintas chunk', async () => {
    addRoute('progress', { retryPolicy: { initialDelayMs: 10_000, maxDelayMs: 10_000, maxRetries: 3, jitterRatio: 0, stableResetMs: 60_000 } });
    await manager.start('progress');
    const child = childrenOf('progress')[0]!;
    expect(child.args).toContain('-nostats');
    expect(child.options.shell).toBe(false);
    await waitFor(() => manager.snapshot('progress').status === 'RUNNING');
    child.writeStderr("Output #0, flv, to 'rtmp://127.0.0.1/live/out':\n");
    child.writeStderr('frame=  120 fps= 25 q=-1.0 size=N/A time=00:00:04.80 bitrate=N/A speed=1x\r');
    child.writeStderr('frame=  121 fps= 25 q=-1.0 size=N/A time=00:00:04.84 bitrate=N/A speed=1x\r');
    await waitFor(() => h.logs.some((log) => log.message.startsWith('Output #0')));
    expect(h.logs.some((log) => log.message.includes('frame='))).toBe(false);
    expect(manager.snapshot('progress').lastError).toBeNull();

    child.writeStderr('Option rw_ti');
    child.writeStderr('meout not found.\n');
    child.crash();
    await waitFor(() => internals(manager).pendingRetries.has('progress'));
    expect(h.logs.some((log) => log.message.includes('Build FFmpeg menolak -rw_timeout'))).toBe(true);
    expect(manager.snapshot('progress').lastError).toContain('Option rw_timeout not found');
    expect(manager.snapshot('progress').lastError).not.toContain('frame=');
  });
});

describe('WorkerManager: admission dan circuit breaker', () => {
  it('start kamera sehat tidak menunggu kamera offline yang sedang menunggu READY', async () => {
    h.readyTimeoutMs = 400;
    addRoute('lambat');
    addRoute('sehat');
    h.cameraOnline.set('lambat', false);
    const slow = manager.start('lambat').catch((error: Error) => error);
    await h.sleep(10);
    const started = Date.now();
    await manager.start('sehat');
    expect(Date.now() - started).toBeLessThan(200);
    expect(await slow).toBeInstanceOf(Error);
    expect(manager.snapshot('lambat').status).toBe('RESTARTING');
  });

  it('retry media tidak menghabiskan budget circuit breaker relay', async () => {
    h.readyTimeoutMs = 15;
    addRoute('reboot', { retryPolicy: { initialDelayMs: 5, maxDelayMs: 10, maxRetries: 1, jitterRatio: 0, stableResetMs: 60_000 } });
    h.cameraOnline.set('reboot', false);
    await manager.start('reboot').catch(() => undefined);
    await waitFor(() => manager.snapshot('reboot').restartCount >= 3);
    h.cameraOnline.set('reboot', true);
    await waitFor(() => childrenOf('reboot').length === 1 && manager.snapshot('reboot').status === 'RUNNING');
    expect(manager.snapshot('reboot').restartCount).toBe(0);

    childrenOf('reboot')[0]!.crash();
    await waitFor(() => childrenOf('reboot').length === 2);
    expect(manager.snapshot('reboot').status).not.toBe('FAILED');
  });

  it('exit karena ingest hilang memakai retry media tanpa batas, bukan circuit breaker relay', async () => {
    h.readyTimeoutMs = 15;
    addRoute('flap', { retryPolicy: { initialDelayMs: 5, maxDelayMs: 10, maxRetries: 0, jitterRatio: 0, stableResetMs: 60_000 } });
    await manager.start('flap');
    await waitFor(() => manager.snapshot('flap').status === 'RUNNING');
    h.cameraOnline.set('flap', false);
    await internals(manager).reconcileMediaRoutes();
    expect(childrenOf('flap')[0]!.signals).toEqual(['SIGTERM']);
    await waitFor(() => internals(manager).pendingRetries.has('flap'));
    expect(manager.snapshot('flap').status).toBe('RESTARTING');
    h.cameraOnline.set('flap', true);
    await waitFor(() => childrenOf('flap').length === 2 && manager.snapshot('flap').status === 'RUNNING');
    expect(manager.snapshot('flap').restartCount).toBe(0);
  });
});

describe('WorkerManager: monitor media', () => {
  it('Stop selama recovery monitor membatalkan recovery dan tidak meninggalkan path', async () => {
    h.readyTimeoutMs = 5_000;
    addRoute('cctv', { onlineRelayEnabled: false, outputs: [] });
    await manager.start('cctv');
    h.cameraOnline.set('cctv', false);
    await internals(manager).reconcileMediaRoutes();
    await waitFor(() => vi.mocked(runtime.ensureMediaRoute).mock.calls.length === 2);
    expect(manager.snapshot('cctv').status).toBe('RESTARTING');

    const started = Date.now();
    const stopped = await manager.stop('cctv');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stopped.status).toBe('STOPPED');
    await h.sleep(30);
    expect(h.paths.has('cameras/cctv')).toBe(false);
    expect(h.media.has('cctv')).toBe(false);
    expect(manager.snapshot('cctv').status).toBe('STOPPED');
  });

  it('relay FAILED tetap mendapatkan path MediaMTX kembali tanpa menjalankan ulang relay', async () => {
    addRoute('vps-mati', { retryPolicy: { initialDelayMs: 5, maxDelayMs: 10, maxRetries: 0, jitterRatio: 0, stableResetMs: 60_000 } });
    await manager.start('vps-mati');
    await waitFor(() => manager.snapshot('vps-mati').status === 'RUNNING');
    childrenOf('vps-mati')[0]!.crash();
    await waitFor(() => manager.snapshot('vps-mati').status === 'FAILED');

    h.paths.clear();
    await internals(manager).reconcileMediaRoutes();
    await waitFor(() => h.paths.has('cameras/vps-mati') && Boolean(h.media.get('vps-mati')?.ready));
    expect(manager.snapshot('vps-mati').status).toBe('FAILED');
    expect(childrenOf('vps-mati')).toHaveLength(1);
  });

  it('putaran monitor tidak tumpang tindih saat Control API lambat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    addRoute('lambat-api', { onlineRelayEnabled: false, outputs: [] });
    await manager.start('lambat-api');
    let release: () => void = () => undefined;
    vi.mocked(runtime.checkMediaRoute).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(runtime.mediaRouteSnapshot('lambat-api'));
    }));
    await manager.bootRecovery();
    vi.advanceTimersByTime(5000);
    await h.sleep(5);
    vi.advanceTimersByTime(5000);
    await h.sleep(5);
    expect(runtime.checkMediaRoute).toHaveBeenCalledTimes(1);
    release();
    await h.sleep(5);
    vi.advanceTimersByTime(5000);
    await h.sleep(5);
    expect(runtime.checkMediaRoute).toHaveBeenCalledTimes(2);
  });
});

describe('WorkerManager: sisa proses dan shutdown', () => {
  it('Stop menghapus path MediaMTX sisa proses sebelumnya walau route tidak aktif', async () => {
    addRoute('yatim', { onlineRelayEnabled: false, outputs: [] });
    h.paths.add('cameras/yatim');
    const stopped = await manager.stop('yatim');
    expect(stopped.status).toBe('STOPPED');
    expect(runtime.removeMediaRoute).toHaveBeenCalledWith('yatim', 'yatim');
    expect(h.paths.has('cameras/yatim')).toBe(false);
    expect(routeService.audit).toHaveBeenCalledWith('ROUTE_STOP_IDEMPOTENT', 'yatim', {});
  });

  it('boot recovery hanya mempertahankan path route autoStart tanpa menutup RouteRun relay yang baru berjalan', async () => {
    addRoute('auto', { autoStart: true, onlineRelayEnabled: false, outputs: [] });
    addRoute('manual', { onlineRelayEnabled: false, outputs: [] });
    h.paths.add('cameras/auto');
    h.paths.add('cameras/manual');
    await manager.bootRecovery();
    // RouteRun terbuka dari proses sebelumnya sudah ditutup server.ts sebelum HTTP dibuka.
    expect(prisma.routeRun.updateMany).not.toHaveBeenCalled();
    expect(runtime.removeUnmanagedMediaPaths).toHaveBeenCalledWith(['auto']);
    expect(h.paths.has('cameras/manual')).toBe(false);
    expect(manager.snapshot('auto').status).toBe('RUNNING');
  });

  it('boot recovery menjalankan route autoStart paralel sehingga kamera offline tidak menunda kamera lain', async () => {
    h.readyTimeoutMs = 300;
    for (const id of ['off-1', 'off-2', 'on-1']) addRoute(id, { autoStart: true, onlineRelayEnabled: false, outputs: [] });
    h.cameraOnline.set('off-1', false);
    h.cameraOnline.set('off-2', false);
    const started = Date.now();
    await manager.bootRecovery();
    expect(Date.now() - started).toBeLessThan(550);
    expect(manager.snapshot('on-1').status).toBe('RUNNING');
    expect(manager.snapshot('off-1').status).toBe('RESTARTING');
  });

  it('shutdown hanya menghentikan relay dan mempertahankan path MediaMTX tanpa audit ROUTE_STOP', async () => {
    addRoute('rekam', { onlineRelayEnabled: false, outputs: [], recordingEnabled: true });
    addRoute('siar');
    await manager.start('rekam');
    await manager.start('siar');
    await waitFor(() => manager.snapshot('siar').status === 'RUNNING');
    vi.mocked(routeService.audit).mockClear();
    await manager.shutdown();
    expect(childrenOf('siar')[0]!.signals).toContain('SIGTERM');
    expect(runtime.removeMediaRoute).not.toHaveBeenCalled();
    expect(h.paths.has('cameras/rekam')).toBe(true);
    expect(h.paths.has('cameras/siar')).toBe(true);
    expect(routeService.audit).not.toHaveBeenCalled();
  });
});

describe('WorkerManager: operasi lintas route lewat antrean', () => {
  it('pause storage hanya mem-patch route yang masih aktif, berurutan dengan Stop', async () => {
    addRoute('rec-a', { onlineRelayEnabled: false, outputs: [], recordingEnabled: true });
    addRoute('rec-b', { onlineRelayEnabled: false, outputs: [], recordingEnabled: true });
    await manager.start('rec-a');
    await manager.start('rec-b');
    h.storagePaused = true;
    const stopping = manager.stop('rec-a');
    await manager.applyRecordingStoragePause();
    await stopping;
    const patched = vi.mocked(runtime.applyMediaRouteRecordingState).mock.calls.map(([route]) => (route as { id: string }).id);
    expect(patched).toEqual(['rec-b']);
    expect(h.paths.has('cameras/rec-a')).toBe(false);
    expect(h.logs.some((log) => log.routeId === 'rec-b' && log.message.includes('dipause'))).toBe(true);
  });

  it('pemasangan ulang path setelah apply settings bersifat best-effort per route', async () => {
    for (const id of ['re-1', 're-2', 're-3']) addRoute(id, { onlineRelayEnabled: false, outputs: [] });
    for (const id of ['re-1', 're-2', 're-3']) await manager.start(id);
    h.refreshFails.add('re-2');
    const result = await manager.reapplyMediaRoutes();
    expect(result).toEqual({ reapplied: 2, failedRouteIds: ['re-2'] });
    expect(h.logs.some((log) => log.routeId === 're-2' && log.message.includes('Gagal memasang ulang path MediaMTX'))).toBe(true);
  });
});

describe('WorkerManager: boot autoStart yang gagal sebelum route aktif', () => {
  it('melepas path sisa proses sebelumnya dan tidak mengklaim retry yang tidak ada', async () => {
    h.maxWorkers = 1;
    addRoute('boot-blocker');
    await manager.start('boot-blocker');
    addRoute('boot-auto', { autoStart: true });
    h.paths.add('cameras/boot-auto');
    await manager.bootRecovery();
    const loser = 'boot-auto';
    await waitFor(() => !h.paths.has(`cameras/${loser}`));
    expect(manager.isActive(loser)).toBe(false);
    expect(manager.snapshot(loser).status).toBe('STOPPED');
    const messages = h.logs.filter((log) => log.routeId === loser).map((log) => log.message);
    expect(messages.some((message) => message.includes('Auto-start gagal sehingga route tidak berjalan'))).toBe(true);
    expect(messages.some((message) => message.includes('retry otomatis tetap aktif'))).toBe(false);
  });

  it('route autoStart yang gagal tetapi sudah aktif mempertahankan path dan retry media', async () => {
    h.readyTimeoutMs = 15;
    addRoute('boot-offline', { autoStart: true, onlineRelayEnabled: false, outputs: [], retryPolicy: { initialDelayMs: 10_000, maxDelayMs: 10_000, maxRetries: 3, jitterRatio: 0, stableResetMs: 60_000 } });
    h.cameraOnline.set('boot-offline', false);
    await manager.bootRecovery();
    expect(manager.isActive('boot-offline')).toBe(true);
    expect(h.paths.has('cameras/boot-offline')).toBe(true);
    expect(h.logs.some((log) => log.routeId === 'boot-offline' && log.message.includes('retry otomatis tetap aktif'))).toBe(true);
  });
});

describe('WorkerManager: config path dari database saat source belum READY', () => {
  it('retry media yang mendapati path sudah READY tetap menulis ulang config path dari database', async () => {
    h.readyTimeoutMs = 15;
    addRoute('rec-retry', { onlineRelayEnabled: false, outputs: [], retryPolicy: { initialDelayMs: 60, maxDelayMs: 60, maxRetries: 3, jitterRatio: 0, stableResetMs: 60_000 } });
    h.cameraOnline.set('rec-retry', false);
    await manager.start('rec-retry').catch(() => undefined);
    expect(internals(manager).pendingRetries.has('rec-retry')).toBe(true);
    // Recording diubah saat offline lalu monitor menandai path READY sebelum retry berjalan.
    h.routes.set('rec-retry', { ...h.routes.get('rec-retry')!, recordingEnabled: true });
    h.cameraOnline.set('rec-retry', true);
    await internals(manager).reconcileMediaRoutes();
    expect(h.media.get('rec-retry')?.ready).toBe(true);
    await waitFor(() => manager.snapshot('rec-retry').status === 'RUNNING' && !internals(manager).pendingRetries.has('rec-retry'));
    expect(runtime.refreshMediaRouteConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 'rec-retry', recordingEnabled: true }));
  });

  it('refreshMediaConfig berjalan lewat antrean route dan dilewati untuk route yang tidak aktif', async () => {
    h.readyTimeoutMs = 15;
    addRoute('rec-queue', { onlineRelayEnabled: false, outputs: [], retryPolicy: { initialDelayMs: 10_000, maxDelayMs: 10_000, maxRetries: 3, jitterRatio: 0, stableResetMs: 60_000 } });
    h.cameraOnline.set('rec-queue', false);
    await manager.start('rec-queue').catch(() => undefined);
    expect(await manager.refreshMediaConfig('rec-queue')).toBe(true);
    await manager.stop('rec-queue');
    vi.mocked(runtime.refreshMediaRouteConfig).mockClear();
    expect(await manager.refreshMediaConfig('rec-queue')).toBe(false);
    expect(runtime.refreshMediaRouteConfig).not.toHaveBeenCalled();
  });

  it('exit relay saat reload config MediaMTX masuk retry media, bukan circuit breaker relay', async () => {
    addRoute('apply-reload', { retryPolicy: { initialDelayMs: 5, maxDelayMs: 10, maxRetries: 0, jitterRatio: 0, stableResetMs: 60_000 } });
    await manager.start('apply-reload');
    await waitFor(() => manager.snapshot('apply-reload').status === 'RUNNING');
    // applyMediaMtxConfiguration menandai state belum READY sebelum file ditulis; reload memutus FFmpeg.
    h.configReloading = true;
    h.media.set('apply-reload', { ...h.media.get('apply-reload')!, state: 'CONFIGURING', ready: false });
    childrenOf('apply-reload')[0]!.crash();
    await waitFor(() => internals(manager).pendingRetries.has('apply-reload'));
    h.configReloading = false;
    await waitFor(() => childrenOf('apply-reload').length === 2 && manager.snapshot('apply-reload').status === 'RUNNING');
    expect(manager.snapshot('apply-reload').restartCount).toBe(0);
  });

  it('monitor tidak menilai path selama apply config MediaMTX berjalan', async () => {
    addRoute('apply-monitor', { onlineRelayEnabled: false, outputs: [] });
    await manager.start('apply-monitor');
    h.configReloading = true;
    await internals(manager).reconcileMediaRoutes();
    expect(runtime.checkMediaRoute).not.toHaveBeenCalled();
  });
});

describe('WorkerManager: rollback edit tidak menghidupkan route yang sudah digantikan', () => {
  it('Stop selama restart edit membuat epoch basi sehingga rollbackRestart tidak menjalankan route lagi', async () => {
    h.readyTimeoutMs = 2_000;
    addRoute('edit-stop');
    await manager.start('edit-stop');
    await waitFor(() => manager.snapshot('edit-stop').status === 'RUNNING');
    h.cameraOnline.set('edit-stop', false);
    const restarting = manager.restart('edit-stop');
    const epoch = manager.controlEpoch('edit-stop');
    await waitFor(() => h.media.get('edit-stop')?.state === 'CONFIGURING');
    expect(manager.isSuperseded('edit-stop', epoch)).toBe(false);
    const stopped = await manager.stop('edit-stop');
    expect(stopped.status).toBe('STOPPED');
    expect((await restarting.catch((error: { code?: string }) => error) as { code?: string }).code).toBe('MEDIAMTX_START_CANCELLED');
    expect(manager.isSuperseded('edit-stop', epoch)).toBe(true);

    h.cameraOnline.set('edit-stop', true);
    expect((await manager.rollbackRestart('edit-stop', epoch)).status).toBe('STOPPED');
    expect(manager.isActive('edit-stop')).toBe(false);
    expect(childrenOf('edit-stop')).toHaveLength(1);
    expect(h.paths.has('cameras/edit-stop')).toBe(false);
  });

  it('rollbackRestart melepas path percobaan gagal (Camera ID baru) sebelum menjalankan konfigurasi lama', async () => {
    h.readyTimeoutMs = 15;
    addRoute('edit-key', { onlineRelayEnabled: false, outputs: [] });
    await manager.start('edit-key');
    h.routes.set('edit-key', { ...h.routes.get('edit-key')!, cameraKey: 'edit-key-baru' });
    h.cameraOnline.set('edit-key', false);
    const restarting = manager.restart('edit-key');
    const epoch = manager.controlEpoch('edit-key');
    await expect(restarting).rejects.toThrow('Source kamera belum mengirim media');
    expect(h.paths.has('cameras/edit-key-baru')).toBe(true);

    h.routes.set('edit-key', { ...h.routes.get('edit-key')!, cameraKey: 'edit-key' });
    h.cameraOnline.set('edit-key', true);
    expect((await manager.rollbackRestart('edit-key', epoch)).status).toBe('RUNNING');
    expect(h.paths.has('cameras/edit-key-baru')).toBe(false);
    expect(h.paths.has('cameras/edit-key')).toBe(true);
  });

  it('pre-check slot relay memperhitungkan worker milik route itu sendiri', async () => {
    h.maxWorkers = 1;
    addRoute('slot-own');
    addRoute('slot-other');
    await manager.start('slot-own');
    await expect(manager.assertRelayAdmission('slot-own')).resolves.toBeUndefined();
    await expect(manager.assertRelayAdmission('slot-other')).rejects.toMatchObject({ code: 'MAX_WORKERS' });
  });
});
