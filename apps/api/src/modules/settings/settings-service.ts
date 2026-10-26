import type { Prisma } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import type { MediaMtxSettingsInput } from '@stream-router/contracts';
import { databaseFilePath } from './storage-browser.js';
import { networkInterfaces } from 'node:os';

const keys = {
  appName: 'app.name',
  maxWorkers: 'app.maxWorkers',
  logRetentionDays: 'app.logRetentionDays',
  gracefulShutdownTimeoutMs: 'app.gracefulShutdownTimeoutMs',
  ffmpegPath: 'app.ffmpegPath'
} as const;

const mediaKeys = {
  enabled: 'mediamtx.enabled',
  publicHost: 'mediamtx.publicHost',
  recordingPath: 'mediamtx.recordingPath',
  rtspPort: 'mediamtx.rtspPort',
  rtmpPort: 'mediamtx.rtmpPort',
  hlsPort: 'mediamtx.hlsPort',
  webrtcPort: 'mediamtx.webrtcPort',
  webrtcUdpPort: 'mediamtx.webrtcUdpPort',
  srtPort: 'mediamtx.srtPort',
  playbackPort: 'mediamtx.playbackPort',
  apiPort: 'mediamtx.apiPort',
  metricsPort: 'mediamtx.metricsPort',
  retentionMode: 'recording.retentionMode',
  retentionDays: 'recording.retentionDays',
  retentionMaxGb: 'recording.retentionMaxGb',
  minFreePercent: 'recording.minFreePercent',
  minFreeGb: 'recording.minFreeGb',
  segmentDurationSeconds: 'recording.segmentDurationSeconds'
} as const;

type PartialWithUndefined<T> = { [K in keyof T]?: T[K] | undefined };
type SettingsInput = { [K in keyof typeof keys]?: string | number | undefined } & {
  mediaMtx?: PartialWithUndefined<MediaMtxSettingsInput> | undefined;
};

export interface MediaMtxSettings extends MediaMtxSettingsInput {
  version: string;
  apiUrl: string;
  rtspUrl: string;
  playbackUrl: string;
  /** MEDIAMTX_WEBRTC_PUBLIC_URL tanpa garis miring akhir; '' = http://<publicHost>:<webrtcPort>. */
  webrtcPublicUrl: string;
}

/**
 * `publicHost` adalah host efektif. `publicHostConfigured` hanya nilai yang disimpan Admin di
 * Settings ('' = belum diatur) dan `publicHostDefault` host yang dipakai bila kosong
 * (MEDIAMTX_PUBLIC_HOST atau deteksi otomatis), sehingga form tidak mengirim balik fallback.
 */
export interface MediaMtxSettingsDetails extends MediaMtxSettings {
  publicHostConfigured: string;
  publicHostDefault: string;
}

function numeric(map: Map<string, string>, key: string, fallback: number): number {
  return Number(map.get(key) ?? fallback);
}

function boolean(map: Map<string, string>, key: string, fallback: boolean): boolean {
  const value = map.get(key);
  return value === undefined ? fallback : value === 'true';
}

function retentionMode(map: Map<string, string>): MediaMtxSettingsInput['retentionMode'] {
  const value = map.get(mediaKeys.retentionMode);
  return value === 'SIZE' || value === 'DAYS_OR_SIZE' ? value : 'DAYS';
}

type PublicHostCandidate = {
  name: string;
  address: string;
  family: string | number;
  internal: boolean;
};

function publicHostCandidates(): PublicHostCandidate[] {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (
    (addresses ?? []).map((address) => ({ name, ...address }))
  ));
}

function bareHost(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isWildcard(value: string): boolean {
  const host = bareHost(value);
  return !host || host === '0.0.0.0' || host === '::';
}

function isLoopbackOrWildcard(value: string): boolean {
  const host = bareHost(value);
  return isWildcard(host)
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1';
}

function candidateScore(candidate: PublicHostCandidate): number {
  const { name, address } = candidate;
  let score = 0;
  if (/^(?:en|eth|eno|ens|enp|wlan|wlp)/i.test(name)) score += 100;
  if (/(?:docker|veth|br-|virbr|utun|tun|tap|vmnet|tailscale)/i.test(name)) score -= 200;
  if (/^192\.168\./.test(address)) score += 50;
  else if (/^10\./.test(address)) score += 40;
  else if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(address)) score += 30;
  else if (/^169\.254\./.test(address)) score -= 100;
  else score += 10;
  return score;
}

/**
 * Resolve legacy loopback defaults to the most likely LAN-facing IPv4. Nilai loopback hanya
 * dianggap "belum diatur" bila berasal dari Settings (default lama 127.0.0.1). `defaultHost`
 * (MEDIAMTX_PUBLIC_HOST) yang diisi dipakai apa adanya, termasuk loopback untuk mode akses lokal
 * (BIND_ADDRESS=127.0.0.1): browser di komputer yang sama mengganti host loopback URL WHEP dengan
 * host halaman. Tanpa keduanya, di container interface yang terlihat hanya IP jaringan Docker.
 */
export function resolveMediaPublicHost(
  configuredHost: string,
  options: { defaultHost?: string; candidates?: PublicHostCandidate[] } = {}
): string {
  const configured = configuredHost.trim();
  if (!isLoopbackOrWildcard(configured)) return configured;
  const fallback = options.defaultHost?.trim() ?? '';
  if (!isWildcard(fallback)) return fallback;
  const selected = (options.candidates ?? publicHostCandidates())
    .filter((candidate) => (
      !candidate.internal
      && (candidate.family === 'IPv4' || candidate.family === 4)
      && !isLoopbackOrWildcard(candidate.address)
    ))
    .sort((left, right) => candidateScore(right) - candidateScore(left) || left.name.localeCompare(right.name))[0];
  return selected?.address ?? (configured || '127.0.0.1');
}

/** Host tersimpan di Settings; nilai loopback lama berarti belum diatur. */
function configuredPublicHost(stored: string | undefined): string {
  const host = stored?.trim() ?? '';
  return isLoopbackOrWildcard(host) ? '' : host;
}

/**
 * Nilai publicHost yang disimpan, atau null bila baris Settings dihapus sehingga host kembali
 * mengikuti MEDIAMTX_PUBLIC_HOST (HOST_LAN_IP di Docker) atau deteksi otomatis. Kosong, `auto`,
 * loopback, nilai yang sama dengan MEDIAMTX_PUBLIC_HOST, dan host otomatis yang dikirim balik form
 * saat belum ada nilai tersimpan tidak disimpan, agar penyimpanan form lain (mis. retention) tidak
 * membekukan IP LAN lama ke database.
 */
export function publicHostToStore(
  submitted: string,
  current: Pick<MediaMtxSettingsDetails, 'publicHostConfigured' | 'publicHostDefault'>,
  envDefault: string
): string | null {
  const host = submitted.trim();
  if (isLoopbackOrWildcard(host) || host.toLowerCase() === 'auto') return null;
  if (envDefault.trim() && bareHost(host) === bareHost(envDefault)) return null;
  if (!current.publicHostConfigured && bareHost(host) === bareHost(current.publicHostDefault)) return null;
  return host;
}

export async function getMediaMtxSettings(): Promise<MediaMtxSettingsDetails> {
  const env = getEnv();
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(mediaKeys) } } });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const apiPort = numeric(map, mediaKeys.apiPort, 19997);
  const rtspPort = numeric(map, mediaKeys.rtspPort, 18554);
  const playbackPort = numeric(map, mediaKeys.playbackPort, 19996);
  const publicHostConfigured = configuredPublicHost(map.get(mediaKeys.publicHost));
  const publicHostDefault = resolveMediaPublicHost('', { defaultHost: env.MEDIAMTX_PUBLIC_HOST });
  return {
    enabled: boolean(map, mediaKeys.enabled, env.MEDIAMTX_ENABLED),
    version: env.MEDIAMTX_VERSION,
    publicHost: publicHostConfigured || publicHostDefault,
    publicHostConfigured,
    publicHostDefault,
    recordingPath: map.get(mediaKeys.recordingPath) ?? env.RECORDING_PATH,
    rtspPort,
    rtmpPort: numeric(map, mediaKeys.rtmpPort, 11935),
    hlsPort: numeric(map, mediaKeys.hlsPort, 18888),
    webrtcPort: numeric(map, mediaKeys.webrtcPort, 18889),
    webrtcPublicUrl: env.MEDIAMTX_WEBRTC_PUBLIC_URL,
    webrtcUdpPort: numeric(map, mediaKeys.webrtcUdpPort, 18189),
    srtPort: numeric(map, mediaKeys.srtPort, 18890),
    playbackPort,
    apiPort,
    metricsPort: numeric(map, mediaKeys.metricsPort, 19998),
    retentionMode: retentionMode(map),
    retentionDays: numeric(map, mediaKeys.retentionDays, 30),
    retentionMaxGb: numeric(map, mediaKeys.retentionMaxGb, 100),
    minFreePercent: numeric(map, mediaKeys.minFreePercent, 15),
    minFreeGb: numeric(map, mediaKeys.minFreeGb, 20),
    segmentDurationSeconds: numeric(map, mediaKeys.segmentDurationSeconds, 3600),
    apiUrl: `http://127.0.0.1:${apiPort}`,
    rtspUrl: `rtsp://127.0.0.1:${rtspPort}`,
    playbackUrl: `http://127.0.0.1:${playbackPort}`
  };
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const env = getEnv();
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(keys) } } });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    appName: map.get(keys.appName) ?? env.PUBLIC_APP_NAME,
    maxWorkers: Number(map.get(keys.maxWorkers) ?? env.MAX_WORKERS),
    logRetentionDays: Number(map.get(keys.logRetentionDays) ?? env.LOG_RETENTION_DAYS),
    gracefulShutdownTimeoutMs: Number(map.get(keys.gracefulShutdownTimeoutMs) ?? env.FFMPEG_STOP_TIMEOUT_MS),
    ffmpegPath: map.get(keys.ffmpegPath) ?? env.FFMPEG_PATH,
    databasePath: databaseFilePath(),
    mediaMtx: await getMediaMtxSettings()
  };
}

export async function getFfmpegPath(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: keys.ffmpegPath } });
  return row?.value ?? getEnv().FFMPEG_PATH;
}

export async function updateSettings(input: SettingsInput): Promise<Record<string, unknown>> {
  const { mediaMtx, ...general } = input;
  const operations: Prisma.PrismaPromise<unknown>[] = Object.entries(general)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => prisma.appSetting.upsert({
    where: { key: keys[name as keyof typeof keys] },
    update: { value: String(value) },
    create: { key: keys[name as keyof typeof keys], value: String(value), isSecret: false }
  }));
  const current = mediaMtx?.publicHost === undefined ? null : await getMediaMtxSettings();
  for (const [name, value] of Object.entries(mediaMtx ?? {})) {
    if (value === undefined) continue;
    const key = mediaKeys[name as keyof typeof mediaKeys];
    if (!key) continue;
    if (key === mediaKeys.publicHost && current) {
      const host = publicHostToStore(String(value), current, getEnv().MEDIAMTX_PUBLIC_HOST);
      if (host === null) {
        operations.push(prisma.appSetting.deleteMany({ where: { key } }));
        continue;
      }
      operations.push(prisma.appSetting.upsert({
        where: { key },
        update: { value: host },
        create: { key, value: host, isSecret: false }
      }));
      continue;
    }
    operations.push(prisma.appSetting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { key, value: String(value), isSecret: false }
    }));
  }
  if (operations.length) await prisma.$transaction(operations);
  return getSettings();
}
