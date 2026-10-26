import { spawn } from 'node:child_process';
import { access, statfs } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { redactText } from '@stream-router/ffmpeg';
import { getEnv } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import type { RuntimeRoute } from '../routes/route-service.js';
import { appendRouteLog } from '../logs/log-store.js';
import { getFfmpegPath, getMediaMtxSettings, type MediaMtxSettings } from '../settings/settings-service.js';
import {
  deleteMediaMtxPath,
  getMediaMtxPathConfig,
  getMediaMtxPathState,
  listMediaMtxPathConfigNames,
  type MediaMtxPathConfig,
  mediaMtxHealth,
  patchMediaMtxGlobal,
  patchMediaMtxPath,
  upsertMediaMtxPath
} from './mediamtx-client.js';
import {
  mediaMtxConfigPath,
  renderMediaMtxConfig,
  resolveProjectPath,
  restoreMediaMtxConfig,
  writeMediaMtxConfig
} from './mediamtx-config.js';
import { detectFfmpegCapabilities } from '../workers/ffmpeg-capabilities.js';

export type MediaRouteState = 'DISABLED' | 'CONFIGURING' | 'READY' | 'ERROR';

export interface MediaRouteSnapshot {
  state: MediaRouteState;
  ready: boolean;
  path: string;
  opusPath: string | null;
  opusReady: boolean;
  localWebrtcUrl: string | null;
  tracks: string[];
  codecCompatible: boolean | null;
  codecMessage: string | null;
  lastError: string | null;
  checkedAt: string | null;
}

const states = new Map<string, MediaRouteSnapshot>();
const localPaths = new Map<string, string>();
const opusPaths = new Map<string, string>();
// Path yang boleh dibaca publik (WebRTC lokal) per route; dipelihara oleh ensure/remove tanpa query DB.
const publicReadPaths = new Map<string, string>();
// Dinaikkan removeMediaRoute agar ensure yang masih berjalan tidak menulis ulang state route yang sudah dilepas.
const mediaGenerations = new Map<string, number>();
let permissionSync: Promise<void> = Promise.resolve();
let configApply: Promise<unknown> = Promise.resolve();
// Apply konfigurasi sedang berjalan: reload file membuang path Control API, jadi monitor tidak boleh
// menilai (atau memulihkan) path sampai apply dan pemasangan ulang selesai.
let configApplyDepth = 0;
let storagePaused = false;
const hookScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../scripts/recording-segment-hook.mjs');
let binaryVersionPromise: Promise<{ available: boolean; version: string | null }> | undefined;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function browserCodecStatus(tracks: string[]): { compatible: boolean; message: string } {
  const normalized = tracks.map((track) => track.toUpperCase());
  const unsupported = normalized.filter((track) => (
    track.includes('H265')
    || track.includes('HEVC')
    || track.includes('MJPEG')
    || track.includes('MPEG-4 VIDEO')
    || track.includes('MPEG-4 AUDIO')
    || track.includes('AAC')
    || track.includes('MP3')
    || track.includes('AC-3')
  ));
  return unsupported.length
    ? { compatible: false, message: `Codec browser tidak kompatibel: ${unsupported.join(', ')}` }
    : { compatible: true, message: tracks.length ? `Codec terdeteksi: ${tracks.join(', ')}` : 'Codec belum dilaporkan' };
}

export function mediaPath(cameraKey: string): string {
  return `cameras/${cameraKey}`;
}

export function mediaWebrtcPath(cameraKey: string): string {
  return `${mediaPath(cameraKey)}/webrtc`;
}

export function audioTranscodeCommand(
  settings: Pick<MediaMtxSettings, 'rtspPort'>,
  ffmpegPath: string,
  sourcePath: string,
  targetPath: string,
  bitrateKbps: number
): string {
  const input = `rtsp://127.0.0.1:${settings.rtspPort}/${sourcePath}`;
  const output = `rtsp://127.0.0.1:${settings.rtspPort}/${targetPath}`;
  return [
    shellQuote(ffmpegPath),
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-rtsp_transport', 'tcp', '-i', shellQuote(input),
    '-map', '0:v?', '-map', '0:a?',
    '-c:v', 'copy',
    '-c:a', 'libopus', '-b:a', `${bitrateKbps}k`, '-ar', '48000', '-ac', '2',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', shellQuote(output)
  ].join(' ');
}

export function mediaRouteSnapshot(routeId: string, cameraKey = ''): MediaRouteSnapshot {
  return states.get(routeId) ?? {
    state: 'DISABLED',
    ready: false,
    path: cameraKey ? mediaPath(cameraKey) : '',
    opusPath: null,
    opusReady: false,
    localWebrtcUrl: null,
    tracks: [],
    codecCompatible: null,
    codecMessage: null,
    lastError: null,
    checkedAt: null
  };
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function localWebrtcUrl(
  settings: Pick<MediaMtxSettings, 'publicHost' | 'webrtcPort'>,
  pathName: string
): string {
  return `http://${urlHost(settings.publicHost)}:${settings.webrtcPort}/${pathName}`;
}

export function recordingPathOptions(
  settings: Pick<MediaMtxSettings, 'recordingPath' | 'segmentDurationSeconds'>,
  enabled: boolean
): MediaMtxPathConfig {
  const recordingRoot = resolveProjectPath(settings.recordingPath);
  return {
    record: enabled,
    recordPath: path.join(recordingRoot, '%path', '%Y', '%m', '%d', '%Y-%m-%d_%H-%M-%S-%f'),
    recordFormat: 'fmp4',
    recordPartDuration: '1s',
    recordMaxPartSize: '50M',
    recordSegmentDuration: `${settings.segmentDurationSeconds}s`,
    recordDeleteAfter: '0s',
    runOnRecordSegmentCreate: `${shellQuote(process.execPath)} ${shellQuote(hookScript)} create`,
    runOnRecordSegmentComplete: `${shellQuote(process.execPath)} ${shellQuote(hookScript)} complete`
  };
}

function mediaGeneration(routeId: string): number {
  return mediaGenerations.get(routeId) ?? 0;
}

async function patchReadPermissions(settings: MediaMtxSettings): Promise<void> {
  const permissions = [...new Set(publicReadPaths.values())].sort().map((pathName) => ({
    action: 'read',
    path: pathName
  }));
  await patchMediaMtxGlobal(settings, {
    webrtcIPsFromInterfaces: true,
    webrtcAdditionalHosts: [settings.publicHost],
    authMethod: 'internal',
    authInternalUsers: [
      {
        user: 'any',
        pass: '',
        ips: ['127.0.0.1', '::1'],
        permissions: [
          { action: 'read', path: '' },
          { action: 'publish', path: '' },
          { action: 'playback', path: '' },
          { action: 'api', path: '' },
          { action: 'metrics', path: '' },
          { action: 'pprof', path: '' }
        ]
      },
      {
        user: 'any',
        pass: '',
        ips: [],
        permissions
      }
    ]
  });
}

// Diserialisasi dan daftar path dihitung saat PATCH dijalankan, sehingga PATCH terakhir selalu memuat state terbaru.
function syncMediaMtxReadPermissions(settings: MediaMtxSettings): Promise<void> {
  const run = permissionSync.catch(() => undefined).then(() => patchReadPermissions(settings));
  permissionSync = run.catch(() => undefined);
  return run;
}

function routeCancelledError(): AppError {
  return new AppError('MEDIAMTX_START_CANCELLED', 'Inisiasi MediaMTX dibatalkan karena route dihentikan', 409);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof AppError ? signal.reason : routeCancelledError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function waitReady(
  settings: MediaMtxSettings,
  pathName: string,
  timeoutMs = getEnv().MEDIAMTX_READY_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ tracks: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Media path belum ready';
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    try {
      const status = await getMediaMtxPathState(settings, pathName);
      if (status.ready) return { tracks: status.tracks };
      lastError = 'Source kamera belum mengirim media';
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(500, signal);
  }
  throwIfCancelled(signal);
  // Kamera offline adalah kondisi operasional yang diharapkan: AppError agar alasannya sampai ke operator.
  throw new AppError('MEDIAMTX_INGEST_NOT_READY', redactText(lastError), 503);
}

function mediaMtxDisabledError(): AppError {
  return new AppError('MEDIAMTX_DISABLED', 'MediaMTX dinonaktifkan pada Settings', 409);
}

interface MediaRoutePlan {
  pathName: string;
  opusPathName: string;
  localPathName: string;
  localNeedsOpus: boolean;
  needsOpus: boolean;
}

function mediaRoutePlan(route: RuntimeRoute): MediaRoutePlan {
  const pathName = mediaPath(route.cameraKey);
  const localNeedsOpus = route.localViewEnabled && route.localAudioMode === 'OPUS';
  const onlineNeedsOpus = route.onlineRelayEnabled && route.onlineAudioMode === 'OPUS';
  const opusPathName = mediaWebrtcPath(route.cameraKey);
  return {
    pathName,
    opusPathName,
    localPathName: localNeedsOpus ? opusPathName : pathName,
    localNeedsOpus,
    needsOpus: localNeedsOpus || onlineNeedsOpus
  };
}

async function upsertMediaRoutePaths(settings: MediaMtxSettings, route: RuntimeRoute, plan: MediaRoutePlan): Promise<void> {
  const ffmpegPath = plan.needsOpus ? await getFfmpegPath() : '';
  if (plan.needsOpus) {
    const capabilities = await detectFfmpegCapabilities(ffmpegPath);
    if (!capabilities.libopus) {
      throw new AppError(
        'FFMPEG_LIBOPUS_UNAVAILABLE',
        'FFmpeg tidak menyediakan encoder libopus. Gunakan build FFmpeg dengan libopus atau pilih audio Copy/AAC.',
        409
      );
    }
    await upsertMediaMtxPath(settings, plan.opusPathName, {
      source: 'publisher',
      sourceOnDemand: false,
      record: false
    });
  } else {
    await deleteMediaMtxPath(settings, plan.opusPathName).catch(() => undefined);
  }
  await upsertMediaMtxPath(settings, plan.pathName, {
    ...recordingPathOptions(settings, route.recordingEnabled && !storagePaused),
    source: route.inputUrl,
    sourceOnDemand: false,
    rtspTransport: route.inputProtocol === 'RTSP' ? 'tcp' : 'automatic',
    runOnReady: plan.needsOpus
      ? audioTranscodeCommand(settings, ffmpegPath, plan.pathName, plan.opusPathName, route.ffmpegOptions.audioBitrateKbps)
      : '',
    runOnReadyRestart: plan.needsOpus
  });
}

export async function ensureMediaRoute(route: RuntimeRoute, signal?: AbortSignal): Promise<MediaRouteSnapshot> {
  const generation = mediaGeneration(route.id);
  const current = () => mediaGeneration(route.id) === generation;
  const settings = await getMediaMtxSettings();
  const plan = mediaRoutePlan(route);
  const { pathName, opusPathName, localPathName, localNeedsOpus, needsOpus } = plan;
  if (!settings.enabled) throw mediaMtxDisabledError();
  throwIfCancelled(signal);
  if (!current()) throw routeCancelledError();
  states.set(route.id, {
    state: 'CONFIGURING',
    ready: false,
    path: pathName,
    opusPath: needsOpus ? opusPathName : null,
    opusReady: false,
    localWebrtcUrl: localWebrtcUrl(settings, localPathName),
    tracks: [],
    codecCompatible: null,
    codecMessage: null,
    lastError: null,
    checkedAt: new Date().toISOString()
  });
  if (route.localViewEnabled) publicReadPaths.set(route.id, localPathName);
  else publicReadPaths.delete(route.id);
  try {
    await syncMediaMtxReadPermissions(settings);
    throwIfCancelled(signal);
    await upsertMediaRoutePaths(settings, route, plan);
    const ingestReady = await waitReady(settings, pathName, undefined, signal);
    const opusReady = needsOpus ? await waitReady(settings, opusPathName, undefined, signal) : null;
    const localReady = localNeedsOpus && opusReady ? opusReady : ingestReady;
    const codec = browserCodecStatus(localReady.tracks);
    if (!current()) throw routeCancelledError();
    localPaths.set(route.id, localPathName);
    if (needsOpus) opusPaths.set(route.id, opusPathName);
    else opusPaths.delete(route.id);
    const snapshot: MediaRouteSnapshot = {
      state: 'READY',
      ready: true,
      path: pathName,
      opusPath: needsOpus ? opusPathName : null,
      opusReady: Boolean(opusReady),
      localWebrtcUrl: localWebrtcUrl(settings, localPathName),
      tracks: localReady.tracks,
      codecCompatible: codec.compatible,
      codecMessage: codec.message,
      lastError: null,
      checkedAt: new Date().toISOString()
    };
    states.set(route.id, snapshot);
    await syncMediaMtxReadPermissions(settings);
    await appendRouteLog(route.id, 'info', `MediaMTX path ${pathName} READY`, 'MEDIAMTX');
    return snapshot;
  } catch (error) {
    // Route dihentikan atau dilepas di tengah jalan: jangan tulis ulang state yang sudah dibersihkan.
    if (signal?.aborted || !current()) throw error;
    const snapshot: MediaRouteSnapshot = {
      state: 'ERROR',
      ready: false,
      path: pathName,
      opusPath: needsOpus ? opusPathName : null,
      opusReady: false,
      localWebrtcUrl: localWebrtcUrl(settings, localPathName),
      tracks: [],
      codecCompatible: null,
      codecMessage: null,
      lastError: (error as Error).message,
      checkedAt: new Date().toISOString()
    };
    states.set(route.id, snapshot);
    await appendRouteLog(route.id, 'error', `MediaMTX gagal: ${(error as Error).message}`, 'MEDIAMTX');
    // Kegagalan Control API (koneksi ditolak, 4xx/5xx) juga kondisi operasional: alasannya dibawa ke operator.
    throw error instanceof AppError
      ? error
      : new AppError('MEDIAMTX_UNAVAILABLE', `MediaMTX gagal: ${redactText((error as Error).message)}`, 502);
  }
}

/**
 * Menulis ulang config path route yang sudah terdaftar (setelah apply settings/reload file MediaMTX)
 * tanpa menunggu READY: MediaMTX menarik ulang source sendiri, monitor melaporkan kesiapannya.
 */
export async function refreshMediaRouteConfig(route: RuntimeRoute): Promise<boolean> {
  const current = states.get(route.id);
  const plan = mediaRoutePlan(route);
  // Camera ID berubah: route sedang menunggu restart yang akan memasang path baru.
  if (!current || current.path !== plan.pathName) return false;
  const settings = await getMediaMtxSettings();
  if (!settings.enabled) throw mediaMtxDisabledError();
  await upsertMediaRoutePaths(settings, route, plan);
  const latest = states.get(route.id);
  if (latest) states.set(route.id, { ...latest, localWebrtcUrl: localWebrtcUrl(settings, plan.localPathName) });
  return true;
}

/**
 * Menerapkan pause/resume storage ke path yang sudah READY (hanya flag record). Path yang belum READY
 * memakai status pause terbaru pada ensureMediaRoute berikutnya.
 */
export async function applyMediaRouteRecordingState(route: RuntimeRoute): Promise<boolean> {
  const current = states.get(route.id);
  if (!route.recordingEnabled || !current?.ready) return false;
  const settings = await getMediaMtxSettings();
  if (!await getMediaMtxPathConfig(settings, current.path)) return false;
  const enabled = !storagePaused;
  await patchMediaMtxPath(settings, current.path, enabled ? recordingPathOptions(settings, true) : { record: false });
  return true;
}

export async function reconfigureMediaRouteRecording(route: RuntimeRoute): Promise<'ACTIVE' | 'INACTIVE'> {
  const snapshot = states.get(route.id);
  if (!snapshot?.ready) {
    throw new AppError(
      'MEDIAMTX_INGEST_NOT_READY',
      'Ingest MediaMTX belum READY. Inisiasi route terlebih dahulu sebelum mengubah Recording.',
      409
    );
  }
  if (route.recordingEnabled && storagePaused) {
    throw new AppError(
      'RECORDING_STORAGE_PAUSED',
      'Recording sedang dipause karena batas aman storage. Kosongkan storage sebelum mengaktifkan kembali.',
      409
    );
  }
  const settings = await getMediaMtxSettings();
  const pathName = mediaPath(route.cameraKey);
  const desired = route.recordingEnabled;
  await upsertMediaMtxPath(settings, pathName, desired
    ? recordingPathOptions(settings, true)
    : { record: false });
  const applied = await getMediaMtxPathConfig(settings, pathName);
  if (applied?.record !== desired) {
    throw new AppError(
      'MEDIAMTX_RECORDING_APPLY_FAILED',
      `MediaMTX tidak menerapkan Recording ${desired ? 'ON' : 'OFF'} pada path ${pathName}`,
      502
    );
  }
  await waitReady(settings, pathName, 5_000);
  states.set(route.id, { ...snapshot, checkedAt: new Date().toISOString(), lastError: null });
  await appendRouteLog(
    route.id,
    'info',
    `Recording ${desired ? 'diaktifkan' : 'dinonaktifkan'} melalui hot apply tanpa inisiasi ulang`,
    'RECORDING'
  );
  return desired ? 'ACTIVE' : 'INACTIVE';
}

export function recordingStoragePaused(): boolean {
  return storagePaused;
}

export function setRecordingStoragePaused(value: boolean): void {
  storagePaused = value;
}

export async function checkMediaRoute(routeId: string, knownSettings?: MediaMtxSettings): Promise<MediaRouteSnapshot> {
  const current = states.get(routeId);
  if (!current) return mediaRouteSnapshot(routeId);
  const settings = knownSettings ?? await getMediaMtxSettings();
  // Hasil cek hanya ditulis bila state belum diganti/dilepas oleh ensure atau stop selama request berjalan.
  const unchanged = () => states.get(routeId) === current;
  try {
    const status = await getMediaMtxPathState(settings, current.path);
    if (!status.ready) throw new Error('MediaMTX ingest tidak READY');
    const opusPath = opusPaths.get(routeId);
    const opusStatus = opusPath ? await getMediaMtxPathState(settings, opusPath) : null;
    if (opusStatus && !opusStatus.ready) throw new Error('Path audio Opus bersama tidak READY');
    const localPath = localPaths.get(routeId) ?? current.path;
    const localStatus = localPath === current.path ? status : opusStatus ?? await getMediaMtxPathState(settings, localPath);
    if (!localStatus.ready) throw new Error('Path WebRTC audio Opus tidak READY');
    const codec = browserCodecStatus(localStatus.tracks);
    const next: MediaRouteSnapshot = {
      ...current,
      state: 'READY',
      ready: true,
      opusReady: Boolean(opusStatus?.ready),
      tracks: localStatus.tracks,
      codecCompatible: codec.compatible,
      codecMessage: codec.message,
      lastError: null,
      checkedAt: new Date().toISOString()
    };
    if (!unchanged()) return states.get(routeId) ?? mediaRouteSnapshot(routeId);
    states.set(routeId, next);
    return next;
  } catch (error) {
    const next: MediaRouteSnapshot = {
      ...current,
      state: 'ERROR',
      ready: false,
      tracks: [],
      codecCompatible: null,
      codecMessage: null,
      lastError: (error as Error).message,
      checkedAt: new Date().toISOString()
    };
    if (!unchanged()) return states.get(routeId) ?? mediaRouteSnapshot(routeId);
    states.set(routeId, next);
    if (current.state !== 'ERROR' || current.lastError !== next.lastError) {
      await appendRouteLog(routeId, 'error', `MediaMTX ingest tidak tersedia: ${next.lastError}`, 'MEDIAMTX');
    }
    return next;
  }
}

export function activeMediaRouteIds(): string[] {
  return [...states.keys()];
}

export function isMediaRouteConfigured(routeId: string): boolean {
  return states.has(routeId);
}

export async function removeMediaRoute(routeId: string, cameraKey: string): Promise<void> {
  mediaGenerations.set(routeId, mediaGeneration(routeId) + 1);
  // Path yang dipasang tercatat di state (Camera ID lama); DB mungkin sudah memuat Camera ID baru.
  const configuredPath = states.get(routeId)?.path ?? (cameraKey ? mediaPath(cameraKey) : null);
  const hadPublicPath = publicReadPaths.delete(routeId);
  try {
    if (!configuredPath) return;
    const settings = await getMediaMtxSettings();
    try {
      await deleteMediaMtxPath(settings, configuredPath);
      await deleteMediaMtxPath(settings, `${configuredPath}/webrtc`).catch(() => undefined);
    } finally {
      if (hadPublicPath) await syncMediaMtxReadPermissions(settings).catch(() => undefined);
    }
  } finally {
    states.delete(routeId);
    localPaths.delete(routeId);
    opusPaths.delete(routeId);
  }
}

/**
 * Menghapus path `cameras/*` yang tertinggal dari proses API sebelumnya (crash/SIGKILL atau shutdown)
 * dan tidak dimiliki route yang akan diadopsi. Path route yang terdaftar di proses ini selalu dipertahankan.
 */
export async function removeUnmanagedMediaPaths(keepCameraKeys: Iterable<string>): Promise<string[]> {
  const keep = new Set(keepCameraKeys);
  // Dicek ulang tepat sebelum tiap delete: route yang di-Start selama daftar diunduh sudah memasang path-nya.
  const managedKeys = () => new Set([...states.values()].flatMap((state) => state.path.split('/')[1] ?? []));
  const settings = await getMediaMtxSettings();
  // Proses dengan MediaMTX nonaktif (mis. pemeriksaan build) tidak boleh menyentuh MediaMTX lain di host yang sama.
  if (!settings.enabled) return [];
  const names = await listMediaMtxPathConfigNames(settings);
  const removed: string[] = [];
  for (const name of names) {
    const [prefix, key] = name.split('/');
    if (prefix !== 'cameras' || !key || keep.has(key) || managedKeys().has(key)) continue;
    await deleteMediaMtxPath(settings, name);
    removed.push(name);
  }
  return removed;
}

export function mediaConfigReloading(): boolean {
  return configApplyDepth > 0;
}

/**
 * Reload file MediaMTX membuang path Control API sehingga relay FFmpeg terputus. State ditandai belum READY
 * sebelum file ditulis agar exit akibat apply masuk retry media, bukan circuit breaker relay; ensure atau
 * monitor yang mengembalikan READY.
 */
function markMediaRoutesReloading(): void {
  const checkedAt = new Date().toISOString();
  for (const [routeId, state] of states) {
    states.set(routeId, { ...state, state: 'CONFIGURING', ready: false, opusReady: false, checkedAt });
  }
}

async function applyMediaMtxConfigurationLocked(rollbackSettings?: MediaMtxSettings): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  markMediaRoutesReloading();
  const written = await writeMediaMtxConfig(settings);
  let health: Awaited<ReturnType<typeof mediaMtxHealth>>;
  try {
    await new Promise((resolve) => setTimeout(resolve, 750));
    health = await mediaMtxHealth(settings);
    if (!health.ok) {
      throw new Error(health.error ?? 'health check gagal');
    }
  } catch (error) {
    const restored = await restoreMediaMtxConfig(
      written.previous,
      rollbackSettings ? renderMediaMtxConfig(rollbackSettings) : null
    );
    const reason = redactText((error as Error).message);
    throw new AppError('MEDIAMTX_CONFIG_REJECTED', restored
      ? `Konfigurasi MediaMTX ditolak dan telah di-rollback: ${reason}`
      : `Konfigurasi MediaMTX ditolak: ${reason}. Tidak ada file konfigurasi sebelumnya untuk di-rollback.`, 502);
  }
  // Rollback hanya ditentukan oleh health MediaMTX; kamera offline tidak boleh menggagalkan apply.
  const routes = await reapplyActiveMediaRoutes();
  return {
    ...health,
    configPath: written.path,
    version: settings.version,
    reappliedRoutes: routes.reapplied,
    failedRouteIds: routes.failedRouteIds
  };
}

export type MediaMtxApply = (rollbackSettings?: MediaMtxSettings) => Promise<Record<string, unknown>>;

/**
 * Menjalankan task secara eksklusif terhadap apply MediaMTX lain. Task menerima `apply` versi tanpa lock,
 * sehingga baca settings lama, tulis settings baru, apply file, dan rollback DB berada dalam satu antrean.
 */
export function withMediaMtxConfigLock<T>(task: (apply: MediaMtxApply) => Promise<T>): Promise<T> {
  const run = configApply.catch(() => undefined).then(async () => {
    configApplyDepth += 1;
    try {
      return await task(applyMediaMtxConfigurationLocked);
    } finally {
      configApplyDepth -= 1;
    }
  });
  configApply = run.catch(() => undefined);
  return run;
}

/** Apply diserialisasi agar dua request tidak saling menimpa file maupun rollback. */
export function applyMediaMtxConfiguration(rollbackSettings?: MediaMtxSettings): Promise<Record<string, unknown>> {
  return withMediaMtxConfigLock((apply) => apply(rollbackSettings));
}

/**
 * Memasang ulang path route aktif (reload file MediaMTX membuang path dari Control API) lewat antrean
 * per-route WorkerManager, best-effort per route. Tidak pernah melempar error.
 */
export async function reapplyActiveMediaRoutes(): Promise<{ reapplied: number; failedRouteIds: string[] }> {
  const { workerManager } = await import('../workers/worker-manager.js');
  const result = await workerManager.reapplyMediaRoutes();
  try {
    await syncMediaMtxReadPermissions(await getMediaMtxSettings());
  } catch (error) {
    console.error(`[mediamtx] Sinkronisasi permission baca gagal: ${(error as Error).message}`);
  }
  return result;
}

export async function testMediaMtxConnection(): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  const health = await mediaMtxHealth(settings);
  return { ...health, version: settings.version, apiUrl: settings.apiUrl };
}

async function httpListener(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function mediaMtxBinaryHealth(version: string): Promise<{ available: boolean; version: string | null }> {
  if (binaryVersionPromise) return binaryVersionPromise;
  const healthPromise = (async (): Promise<{ available: boolean; version: string | null }> => {
    const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
    const executable = resolveProjectPath(
      path.join('.runtime', 'mediamtx', version, `${process.platform}-${architecture}`, 'mediamtx')
    );
    try {
      await access(executable);
    } catch {
      return { available: false, version: null };
    }
    return new Promise<{ available: boolean; version: string | null }>((resolve) => {
      const child = spawn(executable, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      child.once('error', () => resolve({ available: true, version }));
      child.once('close', () => resolve({ available: true, version: output.trim() || version }));
    });
  })();
  binaryVersionPromise = healthPromise;
  return healthPromise;
}

export async function mediaMtxRuntimeHealth(): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  const controlApi = await mediaMtxHealth(settings);
  const recordingRoot = resolveProjectPath(settings.recordingPath);
  const [binary, configAvailable, playback, metrics, hls, webrtc, disk] = await Promise.all([
    mediaMtxBinaryHealth(settings.version),
    access(mediaMtxConfigPath()).then(() => true).catch(() => false),
    httpListener(settings.playbackUrl),
    httpListener(`http://127.0.0.1:${settings.metricsPort}/metrics`),
    httpListener(`http://127.0.0.1:${settings.hlsPort}`),
    httpListener(`http://127.0.0.1:${settings.webrtcPort}`),
    statfs(recordingRoot).then((value) => ({
      ok: true as const,
      totalBytes: Number(value.blocks) * Number(value.bsize),
      freeBytes: Number(value.bavail) * Number(value.bsize)
    })).catch((error: Error) => ({ ok: false as const, error: error.message }))
  ]);
  const stateItems = [...states.values()];
  const storageUnhealthy = !disk.ok || recordingStoragePaused();
  const error = controlApi.error
    ?? (!disk.ok ? disk.error : undefined)
    ?? (recordingStoragePaused() ? 'Recording dipause karena ruang kosong berada di bawah batas aman' : undefined);
  return {
    ok: controlApi.ok && !storageUnhealthy,
    error,
    enabled: settings.enabled,
    version: settings.version,
    binary: { ...binary, platform: process.platform, architecture: process.arch },
    service: {
      running: controlApi.ok,
      mode: getEnv().NODE_ENV === 'development' ? 'npm-dev-child' : 'system-service'
    },
    controlApi,
    config: { available: configAvailable },
    ingestPaths: {
      configured: stateItems.length,
      ready: stateItems.filter((state) => state.ready).length,
      apiReported: controlApi.paths ?? 0
    },
    playback: { ok: playback, internal: true },
    metrics: { ok: metrics, internal: true },
    recordingStorage: { ...disk, paused: recordingStoragePaused() },
    listeners: {
      rtsp: { port: settings.rtspPort, ok: controlApi.ok, probe: 'control-api' },
      rtmp: { port: settings.rtmpPort, ok: controlApi.ok, probe: 'control-api' },
      hls: { port: settings.hlsPort, ok: hls },
      webrtc: { port: settings.webrtcPort, ok: webrtc },
      webrtcIceUdp: { port: settings.webrtcUdpPort, configured: true },
      srtUdp: { port: settings.srtPort, configured: true }
    },
    paths: controlApi.paths,
    activeRoutes: stateItems.filter((state) => state.ready).length
  };
}
