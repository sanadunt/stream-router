import { spawn, type ChildProcess } from 'node:child_process';
import type { RouteStatus } from '@stream-router/contracts';
import { buildFfmpegCommand, redactText } from '@stream-router/ffmpeg';
import { prisma } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';
import { calculateBackoff } from '../../shared/retry.js';
import { eventBus } from '../events/event-bus.js';
import { appendRouteLog, type LogComponent } from '../logs/log-store.js';
import {
  activeMediaRouteIds,
  applyMediaRouteRecordingState,
  checkMediaRoute,
  ensureMediaRoute,
  isMediaRouteConfigured,
  mediaConfigReloading,
  mediaPath,
  mediaWebrtcPath,
  mediaRouteSnapshot,
  reconfigureMediaRouteRecording,
  recordingStoragePaused,
  refreshMediaRouteConfig,
  removeMediaRoute,
  removeUnmanagedMediaPaths
} from '../mediamtx/mediamtx-runtime.js';
import { startMqttOnvifBridge, stopMqttOnvifBridge } from '../mqtt-bridge/mqtt-bridge-runtime.js';
import { audit, getRuntimeRoute, listAutoStartRoutes, type RuntimeRoute } from '../routes/route-service.js';
import { getMediaMtxSettings, getSettings } from '../settings/settings-service.js';
import { detectFfmpegCapabilities } from './ffmpeg-capabilities.js';

const BOOT_START_CONCURRENCY = 4;
const STDERR_TAIL_LINES = 40;
const STDERR_PARTIAL_MAX = 4000;
// Baris progress FFmpeg ("frame=… fps=…" / "size=… time=…") bukan diagnostik dan tidak disimpan.
const FFMPEG_PROGRESS_LINE = /^(?:frame=\s*\d+|size=\s*\S+\s+time=)/;

interface WorkerRecord {
  route: RuntimeRoute;
  process: ChildProcess;
  runId: string;
  status: RouteStatus;
  /** Percobaan relay untuk circuit breaker FFmpeg (terpisah dari retry media). */
  restartCount: number;
  generation: number;
  stopRequested: boolean;
  /** FFmpeg dihentikan monitor karena ingest MediaMTX hilang, bukan karena relay gagal. */
  ingestLost: boolean;
  startedAt: number;
  ffmpegPath: string;
  inputTimeoutOption: 'rw_timeout' | 'timeout' | 'none';
  stableTimer?: NodeJS.Timeout;
  stderrTail: string[];
  stderrPartial: string;
  lastError?: string;
}

type StartKind = 'MANUAL' | 'MEDIA_RETRY' | 'RELAY_RETRY';

interface StartRequest {
  kind: StartKind;
  attempt: number;
  generation: number;
}

export interface WorkerSnapshot {
  routeId: string;
  status: RouteStatus;
  pid: number | null;
  uptimeMs: number;
  restartCount: number;
  lastError: string | null;
}

function logRouteSafely(routeId: string, level: string, message: string, component?: LogComponent): Promise<void> {
  return appendRouteLog(routeId, level, message, component).catch((error: Error) => {
    console.error(`[worker] Gagal menulis log route ${routeId}: ${error.message}`);
  });
}

function settleSafely(promise: Promise<unknown>, context: string): Promise<void> {
  return promise.then(() => undefined, (error: Error) => {
    console.error(`[worker] ${context}: ${error.message}`);
  });
}

export class WorkerManager {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly pendingRetries = new Map<string, { timer: NodeJS.Timeout; restartCount: number; lastError: string | null }>();
  private readonly terminalStates = new Map<string, WorkerSnapshot>();
  private readonly routeOperations = new Map<string, Promise<void>>();
  private readonly incompatibleRwTimeoutPaths = new Set<string>();
  private readonly incompatibleRtspTimeoutPaths = new Set<string>();
  private readonly activeRoutes = new Set<string>();
  /** Route aktif yang menjalankan relay online; relay tanpa worker tidak pernah dilaporkan RUNNING. */
  private readonly relayRoutes = new Set<string>();
  private readonly mediaRecovering = new Set<string>();
  /** handleExit sedang berjalan: worker sudah hilang tetapi retry belum terdaftar. */
  private readonly exiting = new Set<string>();
  /** Dinaikkan oleh Stop dan Start manual; retry yang dijadwalkan sebelumnya menjadi basi. */
  private readonly generations = new Map<string, number>();
  /**
   * Dinaikkan sinkron saat Stop/Restart dipanggil (bukan saat antreannya berjalan), sehingga pemanggil yang
   * mencatat nilainya tahu bila perintah yang datang belakangan sudah menggantikan operasinya.
   */
  private readonly controlEpochs = new Map<string, number>();
  private readonly mediaAborts = new Map<string, AbortController>();
  private reservedWorkerSlots = 0;
  private mediaMonitor: NodeJS.Timeout | undefined;
  private monitorRunning = false;
  private shuttingDown = false;

  snapshot(routeId: string): WorkerSnapshot {
    const worker = this.workers.get(routeId);
    if (worker) {
      return {
        routeId,
        status: worker.status,
        pid: worker.process.pid ?? null,
        uptimeMs: Math.max(0, Date.now() - worker.startedAt),
        restartCount: worker.restartCount,
        lastError: worker.lastError ?? null
      };
    }
    const pending = this.pendingRetries.get(routeId);
    if (pending) return { routeId, status: 'RESTARTING', pid: null, uptimeMs: 0, restartCount: pending.restartCount, lastError: pending.lastError };
    const terminal = this.terminalStates.get(routeId);
    const base = { routeId, pid: null, uptimeMs: 0, restartCount: terminal?.restartCount ?? 0, lastError: terminal?.lastError ?? null };
    if (!this.activeRoutes.has(routeId)) return { ...base, status: 'STOPPED' };
    const status = terminal?.status ?? 'STARTING';
    if (status === 'STARTING' || status === 'RESTARTING' || status === 'FAILED' || status === 'STOPPING') return { ...base, status };
    // RUNNING tanpa proses hanya sah untuk route media-only yang ingest-nya READY.
    const media = mediaRouteSnapshot(routeId);
    if (!this.relayRoutes.has(routeId) && media.ready) return { ...base, status: 'RUNNING' };
    return { ...base, status: 'RESTARTING', lastError: media.lastError ?? base.lastError };
  }

  allSnapshots(): WorkerSnapshot[] {
    return [...new Set([...this.activeRoutes, ...this.workers.keys()])].map((id) => this.snapshot(id));
  }

  isActive(routeId: string): boolean {
    return this.activeRoutes.has(routeId);
  }

  controlEpoch(routeId: string): number {
    return this.controlEpochs.get(routeId) ?? 0;
  }

  /** True bila Stop/Restart/Deinitialize/Delete atau shutdown datang setelah `epoch` dicatat. */
  isSuperseded(routeId: string, epoch: number): boolean {
    return this.shuttingDown || this.controlEpoch(routeId) !== epoch;
  }

  /** Pre-check slot relay sebelum edit me-restart route; slot milik worker route ini sendiri ikut dihitung bebas. */
  async assertRelayAdmission(routeId: string): Promise<void> {
    const maxWorkers = Number((await getSettings()).maxWorkers);
    if (!this.workers.has(routeId) && this.workers.size + this.reservedWorkerSlots >= maxWorkers) {
      throw new AppError('MAX_WORKERS', 'Batas worker aktif tercapai', 409);
    }
  }

  start(routeId: string): Promise<WorkerSnapshot> {
    return this.enqueue(routeId, () => this.startWithRecovery(routeId, { kind: 'MANUAL', attempt: 0, generation: this.generation(routeId) }));
  }

  private startRetry(routeId: string, kind: StartKind, attempt: number, generation: number): Promise<WorkerSnapshot> {
    return this.enqueue(routeId, () => this.startWithRecovery(routeId, { kind, attempt, generation }));
  }

  private async startWithRecovery(routeId: string, request: StartRequest): Promise<WorkerSnapshot> {
    const abort = new AbortController();
    this.mediaAborts.set(routeId, abort);
    try {
      return await this.startInternal(routeId, request, abort.signal);
    } catch (error) {
      await this.handleStartFailure(routeId, request, error as Error, abort.signal).catch((failure: Error) => {
        console.error(`[worker] Penanganan start gagal untuk route ${routeId}: ${failure.message}`);
      });
      throw error;
    } finally {
      if (this.mediaAborts.get(routeId) === abort) this.mediaAborts.delete(routeId);
    }
  }

  private async handleStartFailure(routeId: string, request: StartRequest, error: Error, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.shuttingDown || !this.activeRoutes.has(routeId)) return;
    if (this.workers.has(routeId) || this.pendingRetries.has(routeId)) return;
    const media = mediaRouteSnapshot(routeId);
    if (!media.ready && media.state === 'ERROR') {
      const attempt = request.kind === 'MEDIA_RETRY' ? request.attempt + 1 : 1;
      await this.scheduleMediaStartRetry(routeId, attempt, error, this.generation(routeId));
      return;
    }
    // Tidak ada retry otomatis untuk kegagalan ini: tampilkan FAILED, bukan STARTING/RUNNING yang basi.
    const lastError = redactText(error.message).slice(-2000);
    this.setTerminal(routeId, media.ready && !this.relayRoutes.has(routeId) ? 'RUNNING' : 'FAILED', request.attempt, lastError);
    this.publishStatus(routeId);
  }

  private async startInternal(routeId: string, request: StartRequest, signal: AbortSignal): Promise<WorkerSnapshot> {
    const manual = request.kind === 'MANUAL';
    // Retry yang dijadwalkan sebelum Stop/Start manual tidak boleh menghidupkan route lagi.
    if (!manual && request.generation !== this.generation(routeId)) return this.snapshot(routeId);
    const existing = this.workers.get(routeId);
    if (existing && ['STARTING', 'RUNNING', 'RESTARTING'].includes(existing.status)) {
      if (manual) await audit('ROUTE_START_IDEMPOTENT', routeId, { status: existing.status });
      return this.snapshot(routeId);
    }
    if (this.shuttingDown) throw new AppError('SHUTTING_DOWN', 'Aplikasi sedang shutdown', 503);
    const settings = await getSettings();
    const route = await getRuntimeRoute(routeId);
    if (!route.enabled) throw new AppError('ROUTE_DISABLED', 'Route sedang disabled', 409);
    const mediaReady = this.activeRoutes.has(routeId) && mediaRouteSnapshot(routeId).ready;
    if (manual && mediaReady && !route.onlineRelayEnabled) return this.snapshot(routeId);
    const maxWorkers = Number(settings.maxWorkers);
    // Pre-check murah: relay di atas batas gagal cepat tanpa menyalakan media lebih dulu.
    if (route.onlineRelayEnabled && this.workers.size + this.reservedWorkerSlots >= maxWorkers) {
      throw new AppError('MAX_WORKERS', 'Batas worker aktif tercapai', 409);
    }
    // Start berlanjut: Start manual membatalkan retry tertunda (backoff/FAILED) dan langsung mencoba lagi.
    this.cancelPendingRetry(routeId);
    if (manual) this.bumpGeneration(routeId);
    const generation = this.generation(routeId);
    this.activeRoutes.add(routeId);
    if (route.onlineRelayEnabled) this.relayRoutes.add(routeId);
    else this.relayRoutes.delete(routeId);
    const shownAttempt = manual ? 0 : request.attempt;
    this.setTerminal(routeId, manual ? 'STARTING' : 'RESTARTING', shownAttempt, null);
    this.publishStatus(routeId);
    if (!mediaReady) {
      this.mediaRecovering.add(routeId);
      try {
        await ensureMediaRoute(route, signal);
      } finally {
        this.mediaRecovering.delete(routeId);
      }
      await startMqttOnvifBridge(routeId).catch((error: Error) => (
        logRouteSafely(routeId, 'error', `Gagal memulai MQTT→ONVIF bridge: ${error.message}`, 'SYSTEM')
      ));
    } else if (!manual) {
      // Monitor dapat menandai path READY sebelum retry berjalan sehingga ensure dilewati. Config path tetap
      // ditulis ulang dari database agar perubahan selama source belum READY (mis. Recording) sampai ke MediaMTX.
      await refreshMediaRouteConfig(route).catch((error: Error) => (
        logRouteSafely(routeId, 'warn', `Gagal menulis ulang config path MediaMTX: ${error.message}`, 'MEDIAMTX')
      ));
    }
    if (!route.onlineRelayEnabled) {
      this.setTerminal(routeId, 'RUNNING', shownAttempt, null);
      this.publishStatus(routeId);
      await audit('ROUTE_START', routeId, { mediaOnly: true });
      return this.snapshot(routeId);
    }
    // Circuit breaker relay memakai hitungan sendiri: retry media tidak menghabiskan budget relay.
    const relayAttempt = request.kind === 'RELAY_RETRY' ? request.attempt : 0;
    return this.spawnRelay(routeId, route, settings, { manual, relayAttempt, generation, maxWorkers, signal });
  }

  private async spawnRelay(
    routeId: string,
    route: RuntimeRoute,
    settings: Record<string, unknown>,
    options: { manual: boolean; relayAttempt: number; generation: number; maxWorkers: number; signal: AbortSignal }
  ): Promise<WorkerSnapshot> {
    // Reservasi slot atomik (tanpa await antara cek dan increment) agar start paralel tidak melewati maxWorkers.
    if (this.workers.size + this.reservedWorkerSlots >= options.maxWorkers) {
      throw new AppError('MAX_WORKERS', 'Batas worker aktif tercapai', 409);
    }
    this.reservedWorkerSlots += 1;
    let record: WorkerRecord;
    let child: ChildProcess;
    try {
      const ffmpegPath = String(settings.ffmpegPath);
      const capabilities = await detectFfmpegCapabilities(ffmpegPath);
      const inputTimeoutOption = capabilities.rwTimeout && !this.incompatibleRwTimeoutPaths.has(ffmpegPath)
        ? 'rw_timeout'
        : route.inputProtocol === 'RTSP' && capabilities.rtspTimeout && !this.incompatibleRtspTimeoutPaths.has(ffmpegPath)
          ? 'timeout'
          : 'none';
      const command = buildFfmpegCommand({
        ffmpegPath,
        inputUrl: `${(await getMediaMtxSettings()).rtspUrl}/${route.onlineAudioMode === 'OPUS' ? mediaWebrtcPath(route.cameraKey) : mediaPath(route.cameraKey)}`,
        inputProtocol: 'RTSP',
        outputs: route.outputs,
        mode: route.ffmpegMode,
        audioMode: route.onlineAudioMode === 'OPUS' ? 'COPY' : route.onlineAudioMode,
        options: route.ffmpegOptions,
        inputTimeoutOption
      });

      const status: RouteStatus = options.manual ? 'STARTING' : 'RESTARTING';
      const run = await prisma.routeRun.create({
        data: { routeId, status, restartCount: options.relayAttempt }
      });
      if (inputTimeoutOption === 'timeout') {
        await logRouteSafely(routeId, 'info', 'Binary FFmpeg tidak mendukung -rw_timeout; menggunakan fallback RTSP -timeout.');
      } else if (inputTimeoutOption === 'none') {
        await logRouteSafely(routeId, 'warn', 'Binary FFmpeg tidak menyediakan timeout network yang kompatibel; opsi timeout CLI dinonaktifkan.');
      }
      await logRouteSafely(routeId, 'info', `Menjalankan relay online: ${command.executable} ${command.redactedArgs.join(' ')}`, 'FFMPEG_ONLINE');
      if (route.onlineAudioMode === 'OPUS') {
        await logRouteSafely(routeId, 'info', 'Audio online memakai path Opus bersama; destinasi RTMP harus mendukung enhanced RTMP/Opus.', 'FFMPEG_ONLINE');
      }
      if (options.signal.aborted) {
        await settleSafely(prisma.routeRun.update({ where: { id: run.id }, data: { status: 'STOPPED', stoppedAt: new Date() } }), 'Gagal menutup RouteRun');
        throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Start relay dibatalkan');
      }

      child = spawn(command.executable, command.args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      record = {
        route,
        process: child,
        runId: run.id,
        status,
        restartCount: options.relayAttempt,
        generation: options.generation,
        stopRequested: false,
        ingestLost: false,
        startedAt: Date.now(),
        ffmpegPath,
        inputTimeoutOption,
        stderrTail: [],
        stderrPartial: ''
      };
      this.workers.set(routeId, record);
    } finally {
      this.reservedWorkerSlots -= 1;
    }
    this.publish(record);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) void logRouteSafely(routeId, 'stdout', text, 'FFMPEG_ONLINE');
    });
    child.stderr?.on('data', (chunk: Buffer) => this.captureStderr(routeId, record, chunk.toString('utf8')));

    child.once('spawn', () => {
      record.status = 'RUNNING';
      record.startedAt = Date.now();
      void settleSafely(prisma.routeRun.update({
        where: { id: record.runId },
        data: { status: 'RUNNING', pid: child.pid ?? null, startedAt: new Date() }
      }), `Gagal memperbarui RouteRun route ${routeId}`);
      record.stableTimer = setTimeout(() => { record.restartCount = 0; }, route.retryPolicy.stableResetMs);
      this.publish(record);
    });

    child.once('error', (error) => {
      const message = redactText(error.message);
      record.lastError = message;
      void logRouteSafely(routeId, 'error', message, 'FFMPEG_ONLINE');
    });

    child.once('close', (code, signal) => {
      void this.handleExit(routeId, record, code, signal).catch((error: Error) => {
        console.error(`[worker] Penanganan exit FFmpeg route ${routeId} gagal: ${error.message}`);
      });
    });
    await audit(options.manual ? 'ROUTE_START' : 'ROUTE_AUTO_RESTART', routeId, { restartCount: options.relayAttempt });
    return this.snapshot(routeId);
  }

  private captureStderr(routeId: string, record: WorkerRecord, text: string): void {
    const lines = `${record.stderrPartial}${text}`.split(/\r\n|\r|\n/);
    record.stderrPartial = lines.pop() ?? '';
    if (record.stderrPartial.length > STDERR_PARTIAL_MAX) {
      lines.push(record.stderrPartial);
      record.stderrPartial = '';
    }
    this.recordStderrLines(routeId, record, lines);
  }

  private recordStderrLines(routeId: string, record: WorkerRecord, lines: string[]): void {
    const kept = lines
      .map((line) => line.trim())
      .filter((line) => line && !FFMPEG_PROGRESS_LINE.test(line))
      .map((line) => redactText(line));
    if (!kept.length) return;
    record.stderrTail.push(...kept);
    if (record.stderrTail.length > STDERR_TAIL_LINES) record.stderrTail.splice(0, record.stderrTail.length - STDERR_TAIL_LINES);
    void logRouteSafely(routeId, 'ffmpeg', kept.join('\n'), 'FFMPEG_ONLINE');
  }

  stop(routeId: string, manual = true): Promise<WorkerSnapshot> {
    this.bumpControlEpoch(routeId);
    this.abortMediaOperation(routeId);
    return this.enqueue(routeId, () => this.stopInternal(routeId, { manual, keepMedia: false }));
  }

  private async stopInternal(routeId: string, options: { manual: boolean; keepMedia: boolean }): Promise<WorkerSnapshot> {
    this.bumpGeneration(routeId);
    const reason = options.keepMedia ? 'server_shutdown' : options.manual ? 'route_stopped' : 'route_restarting';
    await settleSafely(stopMqttOnvifBridge(routeId, reason), `Gagal menghentikan MQTT bridge route ${routeId}`);
    const previous = this.terminalStates.get(routeId);
    const pending = this.pendingRetries.get(routeId);
    const wasActive = this.activeRoutes.has(routeId) || Boolean(pending);
    this.cancelPendingRetry(routeId);
    let restartCount = pending?.restartCount ?? previous?.restartCount ?? 0;
    let lastError = pending?.lastError ?? previous?.lastError ?? null;
    if (this.activeRoutes.has(routeId)) this.setTerminal(routeId, 'STOPPING', restartCount, lastError);

    const worker = this.workers.get(routeId);
    if (worker) {
      worker.stopRequested = true;
      worker.status = 'STOPPING';
      if (worker.stableTimer) clearTimeout(worker.stableTimer);
      this.publish(worker);
      restartCount = worker.restartCount;
      lastError = worker.lastError ?? lastError;

      const child = worker.process;
      const settings = await getSettings();
      const timeoutMs = Number(settings.gracefulShutdownTimeoutMs);
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, timeoutMs);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!options.keepMedia) {
      // Selalu lepas path MediaMTX, termasuk sisa proses API sebelumnya yang tidak tercatat di activeRoutes.
      const route = await getRuntimeRoute(routeId).catch(() => null);
      if (route || isMediaRouteConfigured(routeId)) {
        await removeMediaRoute(routeId, route?.cameraKey ?? '').catch((error: Error) => (
          logRouteSafely(routeId, 'warn', `Gagal melepas MediaMTX path: ${error.message}`, 'MEDIAMTX')
        ));
      }
    }
    this.deactivate(routeId);
    this.setTerminal(routeId, 'STOPPED', restartCount, lastError);
    eventBus.publish({ type: 'worker.stopped', routeId, data: this.snapshot(routeId) });
    if (options.manual) await audit(worker || wasActive ? 'ROUTE_STOP' : 'ROUTE_STOP_IDEMPOTENT', routeId, {});
    return this.snapshot(routeId);
  }

  restart(routeId: string): Promise<WorkerSnapshot> {
    this.bumpControlEpoch(routeId);
    this.abortMediaOperation(routeId);
    return this.enqueue(routeId, async () => {
      await this.stopInternal(routeId, { manual: true, keepMedia: false });
      await audit('ROUTE_RESTART', routeId, {});
      return this.startWithRecovery(routeId, { kind: 'MANUAL', attempt: 0, generation: this.generation(routeId) });
    });
  }

  /**
   * Menjalankan ulang konfigurasi yang sudah dipulihkan setelah edit gagal diterapkan. Berupa stop+start
   * agar path MediaMTX percobaan yang gagal (mis. Camera ID baru) ikut dilepas. Tidak melakukan apa pun bila
   * Stop/Restart/Deinitialize datang setelah `epoch`: perintah itulah yang menentukan runtime.
   */
  rollbackRestart(routeId: string, epoch: number): Promise<WorkerSnapshot> {
    return this.enqueue(routeId, async () => {
      if (this.isSuperseded(routeId, epoch)) return this.snapshot(routeId);
      await this.stopInternal(routeId, { manual: false, keepMedia: false });
      return this.startWithRecovery(routeId, { kind: 'MANUAL', attempt: 0, generation: this.generation(routeId) });
    });
  }

  /**
   * Menulis ulang config path MediaMTX route aktif dari database lewat antrean per route, tanpa menunggu READY.
   * Dipakai saat Recording diubah ketika source belum READY: tidak ada restart yang akan memasang flag record.
   */
  refreshMediaConfig(routeId: string): Promise<boolean> {
    return this.enqueue(routeId, async () => {
      if (this.shuttingDown || !this.activeRoutes.has(routeId) || !isMediaRouteConfigured(routeId)) return false;
      return refreshMediaRouteConfig(await getRuntimeRoute(routeId));
    });
  }

  reconfigureRecording(routeId: string): Promise<WorkerSnapshot> {
    return this.enqueue(routeId, async () => {
      if (!this.activeRoutes.has(routeId)) {
        throw new AppError(
          'ROUTE_NOT_INITIALIZED',
          'Route belum diinisiasi. Konfigurasi tersimpan, tetapi Recording baru berjalan setelah route diinisiasi.',
          409
        );
      }
      const route = await getRuntimeRoute(routeId);
      await reconfigureMediaRouteRecording(route);
      eventBus.publish({ type: 'worker.status', routeId, data: this.snapshot(routeId) });
      await audit('ROUTE_RECORDING_HOT_APPLY', routeId, { enabled: route.recordingEnabled });
      return this.snapshot(routeId);
    });
  }

  /**
   * Memasang ulang config path MediaMTX untuk route aktif setelah apply settings, berurutan dengan
   * start/stop per route. Kegagalan per route dicatat dan tidak menggagalkan route lain.
   */
  async reapplyMediaRoutes(): Promise<{ reapplied: number; failedRouteIds: string[] }> {
    const results = await Promise.all([...this.activeRoutes].map((routeId) => this.enqueue(routeId, async () => {
      if (this.shuttingDown || !this.activeRoutes.has(routeId) || !isMediaRouteConfigured(routeId)) return 'skipped' as const;
      const route = await getRuntimeRoute(routeId);
      return await refreshMediaRouteConfig(route) ? 'reapplied' as const : 'skipped' as const;
    }).catch(async (error: Error) => {
      await logRouteSafely(routeId, 'warn', `Gagal memasang ulang path MediaMTX setelah apply settings: ${error.message}`, 'MEDIAMTX');
      return routeId;
    })));
    return {
      reapplied: results.filter((result) => result === 'reapplied').length,
      failedRouteIds: results.filter((result) => result !== 'reapplied' && result !== 'skipped')
    };
  }

  /**
   * Menerapkan pause/resume storage recording ke route aktif lewat antrean per route (hanya flag record).
   * Tidak pernah melempar error.
   */
  async applyRecordingStoragePause(): Promise<void> {
    await Promise.all([...this.activeRoutes].map((routeId) => this.enqueue(routeId, async () => {
      if (this.shuttingDown || !this.activeRoutes.has(routeId)) return;
      const route = await getRuntimeRoute(routeId);
      if (await applyMediaRouteRecordingState(route)) {
        await logRouteSafely(
          routeId,
          'info',
          recordingStoragePaused() ? 'Recording dipause karena storage di bawah batas aman' : 'Recording dilanjutkan karena storage kembali aman',
          'RECORDING'
        );
      }
    }).catch((error: Error) => (
      logRouteSafely(routeId, 'warn', `Gagal menerapkan status pause recording: ${error.message}`, 'RECORDING')
    ))));
  }

  async bootRecovery(): Promise<void> {
    this.startMediaMonitor();
    const routes = await listAutoStartRoutes();
    await this.reconcileLeftovers(routes);
    let next = 0;
    const runNext = async (): Promise<void> => {
      while (next < routes.length) {
        const route = routes[next++]!;
        try { await this.start(route.id); } catch (error) {
          await this.handleBootStartFailure(route, error as Error);
        }
      }
    };
    // Start paralel terbatas: kamera offline tidak menunda kamera lain; batas maxWorkers dijaga reservasi slot.
    await Promise.all(Array.from({ length: Math.min(BOOT_START_CONCURRENCY, routes.length) }, runNext));
  }

  /**
   * Path route autoStart dipertahankan saat boot agar recording tidak terputus. Bila start gagal sebelum route
   * aktif (mis. MAX_WORKERS atau error database), tidak ada monitor, retry, maupun Stop yang mengelola path itu,
   * jadi path sisa proses sebelumnya dilepas agar MediaMTX tidak menarik/merekam kamera yang tampil STOPPED.
   */
  private async handleBootStartFailure(route: RuntimeRoute, error: Error): Promise<void> {
    if (this.shuttingDown) return;
    const reason = redactText(error.message);
    if (this.activeRoutes.has(route.id)) {
      const note = this.pendingRetries.has(route.id) ? 'retry otomatis tetap aktif' : 'route tetap diawasi monitor';
      await logRouteSafely(route.id, 'warn', `Auto-start belum berhasil; ${note}: ${reason}`, 'SYSTEM');
      return;
    }
    await logRouteSafely(route.id, 'error', `Auto-start gagal sehingga route tidak berjalan; path MediaMTX sisa proses sebelumnya dilepas: ${reason}`, 'SYSTEM');
    await this.enqueue(route.id, async () => {
      if (this.shuttingDown || this.activeRoutes.has(route.id)) return;
      await removeMediaRoute(route.id, route.cameraKey);
    }).catch((failure: Error) => (
      logRouteSafely(route.id, 'warn', `Gagal melepas MediaMTX path: ${failure.message}`, 'MEDIAMTX')
    ));
  }

  /**
   * Merapikan path MediaMTX yatim dari proses API sebelumnya yang berhenti tanpa shutdown(). RouteRun terbuka
   * sudah ditutup server.ts sebelum HTTP dibuka; menutupnya lagi di sini dapat mengenai run relay yang baru
   * di-Start operator.
   */
  private async reconcileLeftovers(autoStartRoutes: RuntimeRoute[]): Promise<void> {
    try {
      const removed = await removeUnmanagedMediaPaths(autoStartRoutes.map((route) => route.cameraKey));
      if (removed.length) console.info(`[mediamtx] Path yatim dari proses sebelumnya dihapus: ${removed.join(', ')}`);
    } catch (error) {
      console.warn(`[mediamtx] Gagal merapikan path MediaMTX dari proses sebelumnya: ${(error as Error).message}`);
    }
  }

  private async scheduleMediaStartRetry(routeId: string, attempt: number, error: Error, generation: number): Promise<void> {
    if (this.shuttingDown || !this.activeRoutes.has(routeId)) return;
    const route = await getRuntimeRoute(routeId).catch(() => null);
    if (this.shuttingDown || this.generation(routeId) !== generation || !this.activeRoutes.has(routeId)) return;
    if (!route?.enabled) {
      this.deactivate(routeId);
      return;
    }
    this.cancelPendingRetry(routeId);
    const delay = calculateBackoff(
      Math.min(attempt, 32),
      route.retryPolicy.initialDelayMs,
      route.retryPolicy.maxDelayMs,
      route.retryPolicy.jitterRatio
    );
    const lastError = redactText(error.message).slice(-2000);
    const timer = setTimeout(() => {
      if (this.pendingRetries.get(routeId)?.timer !== timer) return;
      this.pendingRetries.delete(routeId);
      void this.startRetry(routeId, 'MEDIA_RETRY', attempt, generation).catch(() => undefined);
    }, delay);
    timer.unref();
    this.pendingRetries.set(routeId, { timer, restartCount: attempt, lastError });
    this.setTerminal(routeId, 'RESTARTING', attempt, lastError);
    eventBus.publish({
      type: 'worker.restarting',
      routeId,
      data: { delay, attempt, component: 'MEDIAMTX', unlimited: true }
    });
    await logRouteSafely(
      routeId,
      'warn',
      `Source kamera belum READY; retry MediaMTX ke-${attempt} dalam ${Math.max(1, Math.ceil(delay / 1000))} detik`,
      'SYSTEM'
    );
  }

  /**
   * Shutdown proses hanya menghentikan relay FFmpeg dan MQTT bridge. Path MediaMTX (ingest, WebRTC lokal,
   * recording) tetap berjalan dan diadopsi lagi oleh bootRecovery tanpa jeda recording.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.mediaMonitor) clearInterval(this.mediaMonitor);
    this.mediaMonitor = undefined;
    for (const routeId of [...this.pendingRetries.keys()]) this.cancelPendingRetry(routeId);
    for (const routeId of [...this.mediaAborts.keys()]) this.abortMediaOperation(routeId);
    const routeIds = new Set([...this.activeRoutes, ...this.workers.keys()]);
    await Promise.allSettled([...routeIds].map((id) => this.enqueue(id, () => this.stopInternal(id, { manual: false, keepMedia: true }))));
  }

  private async handleExit(routeId: string, record: WorkerRecord, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (record.stableTimer) clearTimeout(record.stableTimer);
    if (record.stderrPartial) {
      this.recordStderrLines(routeId, record, [record.stderrPartial]);
      record.stderrPartial = '';
    }
    const isCurrent = this.workers.get(routeId) === record;
    if (!isCurrent) return;
    this.workers.delete(routeId);
    const abnormal = !record.stopRequested && !this.shuttingDown;
    const lastError = record.lastError ?? (record.stderrTail.length ? record.stderrTail.slice(-10).join('\n').slice(-2000) : null);
    const stillWanted = () => !this.shuttingDown && this.generation(routeId) === record.generation && this.activeRoutes.has(routeId);
    if (abnormal && stillWanted()) {
      // Status langsung RESTARTING: retry baru terdaftar setelah beberapa langkah async di bawah.
      this.exiting.add(routeId);
      this.setTerminal(routeId, 'RESTARTING', record.restartCount, lastError);
      this.publishStatus(routeId);
    }
    try {
      // Kegagalan DB/log tidak boleh menghentikan penjadwalan retry di bawah.
      await settleSafely(prisma.routeRun.update({
        where: { id: record.runId },
        data: {
          status: abnormal ? 'RESTARTING' : 'STOPPED',
          stoppedAt: new Date(),
          exitCode: code,
          signal: signal ?? null,
          lastError: lastError ? redactText(lastError).slice(-4000) : null
        }
      }), `Gagal memperbarui RouteRun route ${routeId}`);
      await logRouteSafely(routeId, abnormal ? 'warn' : 'info', `FFmpeg online berhenti code=${String(code)} signal=${String(signal)}`, 'FFMPEG_ONLINE');
      // Stop manual/shutdown: stopInternal yang menetapkan status akhir.
      if (!abnormal) return;

      const stderr = record.stderrTail.join('\n');
      if (record.inputTimeoutOption === 'rw_timeout' && /Option rw_timeout not found/i.test(stderr)) {
        this.incompatibleRwTimeoutPaths.add(record.ffmpegPath);
        await logRouteSafely(routeId, 'warn', 'Build FFmpeg menolak -rw_timeout saat runtime; retry berikutnya memakai fallback yang kompatibel.', 'FFMPEG_ONLINE');
      } else if (record.inputTimeoutOption === 'timeout' && /Option timeout not found/i.test(stderr)) {
        this.incompatibleRtspTimeoutPaths.add(record.ffmpegPath);
        await logRouteSafely(routeId, 'warn', 'Build FFmpeg menolak -timeout saat runtime; retry berikutnya berjalan tanpa timeout CLI.', 'FFMPEG_ONLINE');
      }
      const route = await getRuntimeRoute(routeId).catch(() => record.route);
      if (route.onlineAudioMode === 'OPUS') {
        await logRouteSafely(routeId, 'warn', 'Relay Opus gagal. Periksa apakah destinasi mendukung enhanced RTMP/Opus; fallback ke AAC tidak dilakukan otomatis.', 'FFMPEG_ONLINE');
      }
      if (!stillWanted()) return;

      if (record.ingestLost || !mediaRouteSnapshot(routeId).ready) {
        // Exit karena ingest MediaMTX hilang bukan kegagalan relay: retry media tanpa batas, bukan circuit breaker.
        await this.scheduleMediaStartRetry(routeId, 1, new Error(lastError ?? 'MediaMTX ingest tidak tersedia'), record.generation);
        return;
      }
      const nextAttempt = record.restartCount + 1;
      if (route.enabled && nextAttempt <= route.retryPolicy.maxRetries) {
        const delay = calculateBackoff(nextAttempt, route.retryPolicy.initialDelayMs, route.retryPolicy.maxDelayMs, route.retryPolicy.jitterRatio);
        eventBus.publish({ type: 'worker.restarting', routeId, data: { delay, attempt: nextAttempt } });
        const timer = setTimeout(() => {
          if (this.pendingRetries.get(routeId)?.timer !== timer) return;
          this.pendingRetries.delete(routeId);
          void this.startRetry(routeId, 'RELAY_RETRY', nextAttempt, record.generation).catch((error: Error) => (
            logRouteSafely(routeId, 'error', `Restart relay online gagal: ${error.message}`, 'FFMPEG_ONLINE')
          ));
        }, delay);
        timer.unref();
        this.pendingRetries.set(routeId, { timer, restartCount: nextAttempt, lastError });
        return;
      }
      this.setTerminal(routeId, 'FAILED', nextAttempt, lastError);
      eventBus.publish({ type: 'worker.failed', routeId, data: { restartCount: nextAttempt, lastError } });
      await settleSafely(prisma.routeRun.update({ where: { id: record.runId }, data: { status: 'FAILED' } }), `Gagal menandai RouteRun FAILED route ${routeId}`);
    } finally {
      this.exiting.delete(routeId);
    }
  }

  private publish(record: WorkerRecord): void {
    eventBus.publish({ type: 'worker.status', routeId: record.route.id, data: this.snapshot(record.route.id) });
  }

  private publishStatus(routeId: string): void {
    eventBus.publish({ type: 'worker.status', routeId, data: this.snapshot(routeId) });
  }

  private setTerminal(routeId: string, status: RouteStatus, restartCount: number, lastError: string | null): void {
    this.terminalStates.set(routeId, { routeId, status, pid: null, uptimeMs: 0, restartCount, lastError });
  }

  private generation(routeId: string): number {
    return this.generations.get(routeId) ?? 0;
  }

  private bumpGeneration(routeId: string): void {
    this.generations.set(routeId, this.generation(routeId) + 1);
  }

  private bumpControlEpoch(routeId: string): void {
    this.controlEpochs.set(routeId, this.controlEpoch(routeId) + 1);
  }

  private cancelPendingRetry(routeId: string): void {
    const pending = this.pendingRetries.get(routeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRetries.delete(routeId);
  }

  private deactivate(routeId: string): void {
    this.activeRoutes.delete(routeId);
    this.relayRoutes.delete(routeId);
  }

  /** Menghentikan tunggu READY yang sedang berjalan agar Stop/Restart tidak menunggu timeout kamera offline. */
  private abortMediaOperation(routeId: string): void {
    this.mediaAborts.get(routeId)?.abort(
      new AppError('MEDIAMTX_START_CANCELLED', 'Inisiasi MediaMTX dibatalkan karena route dihentikan', 409)
    );
  }

  private startMediaMonitor(): void {
    if (this.mediaMonitor) return;
    this.mediaMonitor = setInterval(() => {
      // Lewati tick bila putaran sebelumnya belum selesai (Control API lambat) agar tidak menumpuk.
      if (this.monitorRunning) return;
      this.monitorRunning = true;
      void this.reconcileMediaRoutes()
        .catch((error: Error) => {
          console.error(`[mediamtx] Reconcile runtime gagal: ${error.message}`);
        })
        .finally(() => { this.monitorRunning = false; });
    }, 5000);
    this.mediaMonitor.unref();
  }

  private routeBusy(routeId: string): boolean {
    return this.routeOperations.has(routeId) || this.mediaRecovering.has(routeId) || this.exiting.has(routeId);
  }

  private async reconcileMediaRoutes(): Promise<void> {
    // Selama apply settings, path Control API dibuang reload file lalu dipasang ulang; menilai atau memulihkan
    // path di tengahnya hanya membuat status palsu dan ensure yang bersaing dengan reload.
    if (this.shuttingDown || mediaConfigReloading()) return;
    const routeIds = activeMediaRouteIds().filter((routeId) => this.activeRoutes.has(routeId));
    if (!routeIds.length) return;
    const settings = await getMediaMtxSettings();
    for (const routeId of routeIds) {
      if (this.shuttingDown) return;
      // Route yang sedang start/stop/restart/exit ditangani operasinya sendiri.
      if (!this.activeRoutes.has(routeId) || this.routeBusy(routeId)) continue;
      const status = await checkMediaRoute(routeId, settings);
      if (status.ready) continue;
      if (!this.activeRoutes.has(routeId) || this.routeBusy(routeId)) continue;
      await settleSafely(stopMqttOnvifBridge(routeId, 'route_failed'), `Gagal menghentikan MQTT bridge route ${routeId}`);
      const worker = this.workers.get(routeId);
      if (worker && worker.process.exitCode === null && !worker.process.killed) {
        worker.lastError = status.lastError ?? 'MediaMTX ingest tidak tersedia';
        worker.ingestLost = true;
        worker.process.kill('SIGTERM');
        continue;
      }
      // Relay FAILED juga dipulihkan media-nya (local view + recording); retry relay punya jalurnya sendiri.
      if (worker || this.pendingRetries.has(routeId)) continue;
      void this.enqueue(routeId, () => this.recoverMedia(routeId)).catch((error: Error) => (
        logRouteSafely(routeId, 'warn', `Recovery MediaMTX belum berhasil: ${error.message}`, 'MEDIAMTX')
      ));
    }
  }

  private async recoverMedia(routeId: string): Promise<void> {
    if (this.shuttingDown || !this.activeRoutes.has(routeId) || this.workers.has(routeId) || this.pendingRetries.has(routeId)) return;
    if (mediaRouteSnapshot(routeId).ready) return;
    const generation = this.generation(routeId);
    const route = await getRuntimeRoute(routeId);
    const abort = new AbortController();
    this.mediaAborts.set(routeId, abort);
    this.mediaRecovering.add(routeId);
    try {
      await ensureMediaRoute(route, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return;
      throw error;
    } finally {
      this.mediaRecovering.delete(routeId);
      if (this.mediaAborts.get(routeId) === abort) this.mediaAborts.delete(routeId);
    }
    if (this.shuttingDown || this.generation(routeId) !== generation || !this.activeRoutes.has(routeId)) return;
    await startMqttOnvifBridge(routeId).catch((error: Error) => (
      logRouteSafely(routeId, 'error', `Gagal memulai MQTT→ONVIF bridge: ${error.message}`, 'SYSTEM')
    ));
    // Memulihkan media tidak menyentuh circuit breaker relay: relay FAILED tetap FAILED.
    if (!this.relayRoutes.has(routeId)) this.setTerminal(routeId, 'RUNNING', 0, null);
    this.publishStatus(routeId);
  }

  private enqueue<T>(routeId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.routeOperations.get(routeId) ?? Promise.resolve();
    const operationPromise = previous.catch(() => undefined).then(operation);
    const settled = operationPromise.then(() => undefined, () => undefined);
    this.routeOperations.set(routeId, settled);
    void settled.finally(() => {
      if (this.routeOperations.get(routeId) === settled) this.routeOperations.delete(routeId);
    });
    return operationPromise;
  }
}

export const workerManager = new WorkerManager();
