import type { Prisma, StreamRoute } from '@prisma/client';
import type {
  CreateRouteInput,
  FfmpegOptions,
  RecordingRetentionMode,
  RetryPolicy,
  UpdateRouteInput,
  WebrtcOptions
} from '@stream-router/contracts';
import { redactUrl } from '@stream-router/ffmpeg';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { decryptString, encryptString } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { assertSsrfPolicy, detectInputProtocol, parseOutputUrl, parseWebrtcUrl } from '../../shared/url-policy.js';
import { ptzSummary } from '../ptz/ptz-service.js';
import { mediaRouteSnapshot, recordingStoragePaused } from '../mediamtx/mediamtx-runtime.js';

function webrtcPolicy() {
  const env = getEnv();
  return {
    allowedOrigins: env.WEBRTC_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    allowInsecure: env.NODE_ENV !== 'production'
  };
}

export interface RuntimeRoute {
  id: string;
  cameraKey: string;
  name: string;
  description: string;
  inputUrl: string;
  inputProtocol: 'RTSP' | 'RTMP';
  outputs: string[];
  enabled: boolean;
  autoStart: boolean;
  localViewEnabled: boolean;
  localAudioMode: 'COPY' | 'OPUS';
  onlineRelayEnabled: boolean;
  onlineAudioMode: 'COPY' | 'AAC' | 'OPUS';
  recordingEnabled: boolean;
  recordingRetentionMode: RecordingRetentionMode;
  recordingRetentionDays: number | null;
  recordingRetentionGb: number | null;
  ffmpegMode: 'COPY' | 'TRANSCODE';
  ffmpegOptions: FfmpegOptions;
  retryPolicy: RetryPolicy;
  webrtc: WebrtcOptions;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function defaults(): { ffmpegOptions: FfmpegOptions; retryPolicy: RetryPolicy; webrtc: WebrtcOptions } {
  const env = getEnv();
  return {
    ffmpegOptions: {
      videoBitrateKbps: 2500,
      audioBitrateKbps: 128,
      preset: 'veryfast',
      gop: 50
    },
    retryPolicy: {
      initialDelayMs: env.DEFAULT_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: env.DEFAULT_RETRY_MAX_DELAY_MS,
      maxRetries: env.DEFAULT_MAX_RETRIES,
      jitterRatio: 0.2,
      stableResetMs: 60000
    },
    webrtc: {
      enabled: false,
      url: undefined,
      mode: 'IFRAME'
    }
  };
}

function inputHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '-';
  }
}

export function decryptRoute(row: StreamRoute): RuntimeRoute {
  const secret = getEnv().APP_ENCRYPTION_KEY;
  const fallback = defaults();
  return {
    id: row.id,
    cameraKey: row.cameraKey ?? `route-${row.id.replaceAll('-', '').slice(0, 12)}`,
    name: row.name,
    description: row.description,
    inputUrl: decryptString(row.inputUrlEncrypted, secret),
    inputProtocol: row.inputProtocol as 'RTSP' | 'RTMP',
    outputs: parseJson<string[]>(decryptString(row.outputsEncrypted, secret), []),
    enabled: row.enabled,
    autoStart: row.autoStart,
    localViewEnabled: row.localViewEnabled,
    localAudioMode: row.localAudioMode as 'COPY' | 'OPUS',
    onlineRelayEnabled: row.onlineRelayEnabled,
    onlineAudioMode: row.onlineAudioMode as 'COPY' | 'AAC' | 'OPUS',
    recordingEnabled: row.recordingEnabled,
    recordingRetentionMode: row.recordingRetentionMode as RecordingRetentionMode,
    recordingRetentionDays: row.recordingRetentionDays,
    recordingRetentionGb: row.recordingRetentionGb,
    ffmpegMode: row.ffmpegMode as 'COPY' | 'TRANSCODE',
    ffmpegOptions: { ...fallback.ffmpegOptions, ...parseJson<Partial<FfmpegOptions>>(row.ffmpegOptions, {}) },
    retryPolicy: { ...fallback.retryPolicy, ...parseJson<Partial<RetryPolicy>>(row.retryPolicy, {}) },
    webrtc: {
      enabled: row.webrtcEnabled,
      url: row.webrtcUrlEncrypted ? decryptString(row.webrtcUrlEncrypted, secret) : undefined,
      mode: row.webrtcMode as 'IFRAME' | 'WHEP'
    }
  };
}

// Field yang mengubah path MediaMTX atau argumen FFmpeg. recordingEnabled di-hot-apply terpisah; nama,
// deskripsi, autoStart, retention, retryPolicy, dan webrtc dibaca ulang dari database saat dibutuhkan.
const RESTART_FIELDS = [
  'cameraKey',
  'inputUrl',
  'outputs',
  'onlineRelayEnabled',
  'onlineAudioMode',
  'localViewEnabled',
  'localAudioMode',
  'ffmpegMode',
  'ffmpegOptions'
] as const satisfies ReadonlyArray<keyof RuntimeRoute>;

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  ));
}

// Dibandingkan per nilai karena editor selalu mengirim seluruh field, termasuk yang tidak berubah.
export function runtimeRouteChanges(previous: RuntimeRoute, next: RuntimeRoute): Array<typeof RESTART_FIELDS[number]> {
  return RESTART_FIELDS.filter((field) => stableJson(previous[field]) !== stableJson(next[field]));
}

export function toRouteDto(row: StreamRoute): Record<string, unknown> {
  const route = decryptRoute(row);
  const media = mediaRouteSnapshot(row.id, route.cameraKey);
  return {
    id: route.id,
    cameraKey: route.cameraKey,
    name: route.name,
    description: route.description,
    inputProtocol: route.inputProtocol,
    inputHost: inputHost(route.inputUrl),
    inputUrlMasked: redactUrl(route.inputUrl),
    outputsMasked: route.outputs.map(redactUrl),
    outputCount: route.outputs.length,
    enabled: route.enabled,
    autoStart: route.autoStart,
    localViewEnabled: route.localViewEnabled,
    localAudioMode: route.localAudioMode,
    onlineRelayEnabled: route.onlineRelayEnabled,
    onlineAudioMode: route.onlineAudioMode,
    recordingEnabled: route.recordingEnabled,
    recordingRetentionMode: route.recordingRetentionMode,
    recordingRetentionDays: route.recordingRetentionDays,
    recordingRetentionGb: route.recordingRetentionGb,
    ffmpegMode: route.ffmpegMode,
    ffmpegOptions: route.ffmpegOptions,
    retryPolicy: route.retryPolicy,
    webrtc: {
      enabled: route.webrtc.enabled,
      mode: route.webrtc.mode,
      urlMasked: route.webrtc.url ? redactUrl(route.webrtc.url) : undefined
    },
    ptz: ptzSummary(row, 'ROUTE', row.id),
    mqttBridgeEnabled: row.mqttBridgeEnabled,
    media,
    components: {
      ingest: {
        enabled: route.enabled,
        state: media.state,
        ready: media.ready,
        lastError: media.lastError
      },
      local: {
        enabled: route.localViewEnabled,
        ready: route.localViewEnabled && media.ready,
        url: route.localViewEnabled ? media.localWebrtcUrl : null,
        codecCompatible: media.codecCompatible,
        codecMessage: media.codecMessage
      },
      recording: {
        enabled: route.recordingEnabled,
        active: route.recordingEnabled && media.ready && !recordingStoragePaused(),
        storagePaused: recordingStoragePaused()
      },
      online: {
        enabled: route.onlineRelayEnabled,
        configured: route.outputs.length > 0,
        videoMode: route.ffmpegMode,
        audioMode: route.onlineAudioMode,
        opusReady: route.onlineAudioMode !== 'OPUS' || media.opusReady
      },
      ptz: {
        enabled: row.ptzEnabled,
        ingestReady: media.ready
      }
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function toRouteEditDto(row: StreamRoute): Record<string, unknown> {
  const route = decryptRoute(row);
  return {
    ...toRouteDto(row),
    inputUrl: route.inputUrl,
    outputs: route.outputs,
    webrtc: {
      enabled: route.webrtc.enabled,
      mode: route.webrtc.mode,
      url: route.webrtc.url,
      urlMasked: route.webrtc.url ? redactUrl(route.webrtc.url) : undefined
    }
  };
}

export function toViewerDto(row: StreamRoute) {
  const route = decryptRoute(row);
  const media = mediaRouteSnapshot(row.id, route.cameraKey);
  const local = route.localViewEnabled && media.ready && media.localWebrtcUrl
    ? {
      url: media.localWebrtcUrl,
      mode: 'IFRAME' as const,
      compatible: media.codecCompatible !== false,
      codecMessage: media.codecMessage
    }
    : null;
  const online = route.webrtc.enabled && route.webrtc.url
    ? { url: route.webrtc.url, mode: route.webrtc.mode }
    : null;
  if (!local && !online) return null;
  return {
    id: route.id,
    name: route.name,
    description: route.description,
    webrtc: local ?? online,
    sources: { local, online, preferred: local ? 'local' : 'online' },
    ptz: ptzSummary(row, 'ROUTE', row.id, true)
  };
}

function validateUrls(inputUrl: string, outputs: string[]): 'RTSP' | 'RTMP' {
  const protocol = detectInputProtocol(inputUrl);
  assertSsrfPolicy(inputUrl);
  for (const output of outputs) {
    parseOutputUrl(output);
    assertSsrfPolicy(output);
  }
  return protocol;
}

function slugCameraKey(value: string): string {
  const slug = value.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 100);
  return slug || 'camera';
}

async function cameraKeyTaken(candidate: string, excludeId?: string): Promise<boolean> {
  const route = await prisma.streamRoute.findFirst({
    where: { cameraKey: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true }
  });
  if (route) return true;
  // Arsip route yang sudah dihapus tetap memakai Camera ID-nya. Key otomatis tidak boleh mewarisinya,
  // karena retention dan kuota route baru akan berlaku pada footage kamera lama.
  const recording = await prisma.recordingSegment.findFirst({
    where: {
      cameraKey: candidate,
      ...(excludeId ? { OR: [{ routeId: null }, { routeId: { not: excludeId } }] } : {})
    },
    select: { id: true }
  });
  return Boolean(recording);
}

export async function availableCameraKey(preferred: string, excludeId?: string): Promise<string> {
  const base = slugCameraKey(preferred);
  let candidate = base;
  let suffix = 1;
  while (await cameraKeyTaken(candidate, excludeId)) {
    suffix += 1;
    candidate = `${base.slice(0, Math.max(1, 116 - String(suffix).length))}-${suffix}`;
  }
  return candidate;
}

const CAMERA_KEY_ATTEMPTS = 5;

function cameraKeyConflict(): AppError {
  return new AppError('CAMERA_KEY_CONFLICT', 'Camera ID sudah dipakai route lain', 409);
}

// Pemeriksaan findFirst tidak atomik; insert/update paralel dengan key sama berakhir di unique index.
function isCameraKeyUniqueError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return target === undefined || String(target).includes('cameraKey');
}

async function explicitCameraKey(value: string, excludeId?: string): Promise<string> {
  const existing = await prisma.streamRoute.findFirst({
    where: { cameraKey: value, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true }
  });
  if (existing) throw cameraKeyConflict();
  return value;
}

function validateRecordingRetention(
  mode: RecordingRetentionMode,
  days: number | null,
  maxGb: number | null
): void {
  if ((mode === 'DAYS' || mode === 'DAYS_OR_SIZE') && days == null) {
    throw new AppError('RECORDING_RETENTION_DAYS_REQUIRED', 'Jumlah hari wajib diisi untuk kebijakan retention ini', 400);
  }
  if ((mode === 'SIZE' || mode === 'DAYS_OR_SIZE') && maxGb == null) {
    throw new AppError('RECORDING_RETENTION_SIZE_REQUIRED', 'Batas kapasitas GB wajib diisi untuk kebijakan retention ini', 400);
  }
}

export async function listRoutes(): Promise<StreamRoute[]> {
  return prisma.streamRoute.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function listViewerRoutes(): Promise<StreamRoute[]> {
  return prisma.streamRoute.findMany({
    where: { enabled: true, OR: [{ localViewEnabled: true }, { webrtcEnabled: true }] },
    orderBy: { name: 'asc' }
  });
}

export async function getRouteRow(id: string): Promise<StreamRoute> {
  const row = await prisma.streamRoute.findUnique({ where: { id } });
  if (!row) throw new AppError('ROUTE_NOT_FOUND', 'Route tidak ditemukan', 404);
  return row;
}

export async function getRuntimeRoute(id: string): Promise<RuntimeRoute> {
  return decryptRoute(await getRouteRow(id));
}

export async function createRoute(input: CreateRouteInput): Promise<StreamRoute> {
  if (input.onlineRelayEnabled && input.outputs.length === 0) {
    throw new AppError('ONLINE_OUTPUT_REQUIRED', 'Minimal satu output wajib diisi saat Relay Online aktif', 400);
  }
  const inputProtocol = validateUrls(input.inputUrl, input.outputs);
  const secret = getEnv().APP_ENCRYPTION_KEY;
  const base = defaults();
  const webrtcInput = input.webrtc ?? base.webrtc;
  if (webrtcInput.enabled && !webrtcInput.url) {
    throw new AppError('WEBRTC_URL_REQUIRED', 'WebRTC URL wajib diisi saat WebRTC viewer diaktifkan', 400);
  }
  if (webrtcInput.url) parseWebrtcUrl(webrtcInput.url, webrtcPolicy());
  validateRecordingRetention(
    input.recordingRetentionMode,
    input.recordingRetentionDays ?? null,
    input.recordingRetentionGb ?? null
  );
  const data = {
    name: input.name,
    description: input.description,
    inputUrlEncrypted: encryptString(input.inputUrl, secret),
    inputProtocol,
    outputsEncrypted: encryptString(JSON.stringify(input.outputs), secret),
    enabled: input.enabled,
    autoStart: input.autoStart,
    localViewEnabled: input.localViewEnabled,
    localAudioMode: input.localAudioMode,
    onlineRelayEnabled: input.onlineRelayEnabled,
    onlineAudioMode: input.onlineAudioMode,
    recordingEnabled: input.recordingEnabled,
    recordingRetentionMode: input.recordingRetentionMode,
    recordingRetentionDays: input.recordingRetentionDays ?? null,
    recordingRetentionGb: input.recordingRetentionGb ?? null,
    ffmpegMode: input.ffmpegMode,
    ffmpegOptions: JSON.stringify({ ...base.ffmpegOptions, ...input.ffmpegOptions }),
    retryPolicy: JSON.stringify({ ...base.retryPolicy, ...input.retryPolicy }),
    webrtcEnabled: webrtcInput.enabled,
    webrtcUrlEncrypted: webrtcInput.url ? encryptString(webrtcInput.url, secret) : null,
    webrtcMode: webrtcInput.mode
  };
  for (let attempt = 1; attempt <= CAMERA_KEY_ATTEMPTS; attempt += 1) {
    const cameraKey = input.cameraKey
      ? await explicitCameraKey(input.cameraKey)
      : await availableCameraKey(input.name);
    try {
      const row = await prisma.streamRoute.create({ data: { ...data, cameraKey } });
      await audit('ROUTE_CREATE', row.id, { name: row.name });
      return row;
    } catch (error) {
      // Key eksplisit adalah pilihan admin; key otomatis dicari ulang ke suffix berikutnya.
      if (!isCameraKeyUniqueError(error)) throw error;
      if (input.cameraKey) throw cameraKeyConflict();
    }
  }
  throw cameraKeyConflict();
}

export async function updateRoute(id: string, input: UpdateRouteInput): Promise<StreamRoute> {
  const current = await getRuntimeRoute(id);
  const nextInput = input.inputUrl ?? current.inputUrl;
  const nextOutputs = input.outputs ?? current.outputs;
  const inputProtocol = validateUrls(nextInput, nextOutputs);
  const onlineRelayEnabled = input.onlineRelayEnabled ?? current.onlineRelayEnabled;
  if (onlineRelayEnabled && nextOutputs.length === 0) {
    throw new AppError('ONLINE_OUTPUT_REQUIRED', 'Minimal satu output wajib diisi saat Relay Online aktif', 400);
  }
  if (input.cameraKey !== undefined && input.cameraKey !== current.cameraKey) {
    const recordingCount = await prisma.recordingSegment.count({ where: { routeId: id } });
    if (recordingCount > 0) {
      throw new AppError('CAMERA_KEY_LOCKED', 'Camera ID tidak dapat diubah setelah recording pertama dibuat', 409);
    }
  }
  validateRecordingRetention(
    input.recordingRetentionMode ?? current.recordingRetentionMode,
    input.recordingRetentionDays !== undefined ? input.recordingRetentionDays : current.recordingRetentionDays,
    input.recordingRetentionGb !== undefined ? input.recordingRetentionGb : current.recordingRetentionGb
  );
  const secret = getEnv().APP_ENCRYPTION_KEY;
  const data: Prisma.StreamRouteUpdateInput = {
    inputProtocol,
    ...(input.cameraKey !== undefined ? { cameraKey: await explicitCameraKey(input.cameraKey, id) } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.inputUrl !== undefined ? { inputUrlEncrypted: encryptString(input.inputUrl, secret) } : {}),
    ...(input.outputs !== undefined ? { outputsEncrypted: encryptString(JSON.stringify(input.outputs), secret) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.autoStart !== undefined ? { autoStart: input.autoStart } : {}),
    ...(input.localViewEnabled !== undefined ? { localViewEnabled: input.localViewEnabled } : {}),
    ...(input.localAudioMode !== undefined ? { localAudioMode: input.localAudioMode } : {}),
    ...(input.onlineRelayEnabled !== undefined ? { onlineRelayEnabled: input.onlineRelayEnabled } : {}),
    ...(input.onlineAudioMode !== undefined ? { onlineAudioMode: input.onlineAudioMode } : {}),
    ...(input.recordingEnabled !== undefined ? { recordingEnabled: input.recordingEnabled } : {}),
    ...(input.recordingRetentionMode !== undefined ? { recordingRetentionMode: input.recordingRetentionMode } : {}),
    ...(input.recordingRetentionDays !== undefined ? { recordingRetentionDays: input.recordingRetentionDays } : {}),
    ...(input.recordingRetentionGb !== undefined ? { recordingRetentionGb: input.recordingRetentionGb } : {}),
    ...(input.ffmpegMode !== undefined ? { ffmpegMode: input.ffmpegMode } : {}),
    ...(input.ffmpegOptions !== undefined ? { ffmpegOptions: JSON.stringify({ ...current.ffmpegOptions, ...input.ffmpegOptions }) } : {}),
    ...(input.retryPolicy !== undefined ? { retryPolicy: JSON.stringify({ ...current.retryPolicy, ...input.retryPolicy }) } : {}),
    ...(input.webrtc !== undefined ? (() => {
      const nextEnabled = input.webrtc.enabled ?? current.webrtc.enabled;
      const nextUrl = input.webrtc.url !== undefined ? input.webrtc.url : current.webrtc.url;
      if (nextEnabled && !nextUrl) {
        throw new AppError('WEBRTC_URL_REQUIRED', 'WebRTC URL wajib diisi saat WebRTC viewer diaktifkan', 400);
      }
      if (input.webrtc.url) parseWebrtcUrl(input.webrtc.url, webrtcPolicy());
      return {
        webrtcEnabled: nextEnabled,
        webrtcMode: input.webrtc.mode ?? current.webrtc.mode,
        ...(input.webrtc.url !== undefined
          ? { webrtcUrlEncrypted: input.webrtc.url ? encryptString(input.webrtc.url, secret) : null }
          : {})
      };
    })() : {})
  };
  const row = await prisma.streamRoute.update({ where: { id }, data }).catch((error: unknown) => {
    throw isCameraKeyUniqueError(error) ? cameraKeyConflict() : error;
  });
  await audit('ROUTE_UPDATE', row.id, { changed: Object.keys(input) });
  return row;
}

// Seluruh kolom yang dapat ditulis updateRoute. Rollback menulis nilai mentah ini apa adanya; memutar ulang
// lewat updateRoute tidak cukup karena url kosong berarti "pertahankan" dan ffmpegOptions di-merge.
const EDITABLE_ROUTE_COLUMNS = [
  'cameraKey', 'name', 'description', 'inputUrlEncrypted', 'inputProtocol', 'outputsEncrypted', 'enabled',
  'autoStart', 'localViewEnabled', 'localAudioMode', 'onlineRelayEnabled', 'onlineAudioMode', 'recordingEnabled',
  'recordingRetentionMode', 'recordingRetentionDays', 'recordingRetentionGb', 'ffmpegMode', 'ffmpegOptions',
  'retryPolicy', 'webrtcEnabled', 'webrtcUrlEncrypted', 'webrtcMode'
] as const satisfies ReadonlyArray<keyof StreamRoute>;

/**
 * Rollback edit yang gagal diterapkan: hanya kolom yang diubah edit itu (`before` → `written`), dan hanya bila
 * kolom tersebut masih memuat nilai tulisan edit itu. Penulisan lain yang datang belakangan (mis. Deinitialize
 * menulis enabled=false atau edit berikutnya) tidak pernah ditimpa. Setiap kolom ditulis atomik bersyarat.
 */
export async function restoreRouteChanges(before: StreamRoute, written: StreamRoute): Promise<string[]> {
  const restored: string[] = [];
  for (const column of EDITABLE_ROUTE_COLUMNS) {
    if (before[column] === written[column]) continue;
    const { count } = await prisma.streamRoute.updateMany({
      where: { id: before.id, [column]: written[column] } as Prisma.StreamRouteWhereInput,
      data: { [column]: before[column] } as Prisma.StreamRouteUpdateManyMutationInput
    }).catch((error: unknown) => {
      // Camera ID lama sudah dipakai route lain: kolom itu dibiarkan, kolom lain tetap dipulihkan.
      if (isCameraKeyUniqueError(error)) return { count: 0 };
      throw error;
    });
    if (count) restored.push(column);
  }
  if (restored.length) {
    await audit('ROUTE_UPDATE_ROLLBACK', before.id, { name: before.name, cameraKey: before.cameraKey, columns: restored });
  }
  return restored;
}

export async function deleteRoute(id: string): Promise<void> {
  const row = await getRouteRow(id);
  // AuditLog.routeId menjadi null setelah route dihapus, jadi identitas route disimpan di metadata.
  await audit('ROUTE_DELETE', id, { routeId: id, name: row.name, cameraKey: row.cameraKey });
  await prisma.streamRoute.delete({ where: { id } });
}

export async function listAutoStartRoutes(): Promise<RuntimeRoute[]> {
  const rows = await prisma.streamRoute.findMany({ where: { enabled: true, autoStart: true } });
  return rows.map(decryptRoute);
}

export async function audit(action: string, routeId: string | null, metadata: unknown): Promise<void> {
  await prisma.auditLog.create({
    data: { action, routeId, metadataJson: JSON.stringify(metadata ?? {}) }
  });
}
