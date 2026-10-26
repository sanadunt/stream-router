import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../../config/env.js';
import type { MediaMtxSettings } from '../settings/settings-service.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');

export function resolveProjectPath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(rootDir, value);
}

export function renderMediaMtxConfig(settings: MediaMtxSettings): string {
  const recordingRoot = resolveProjectPath(settings.recordingPath);
  const lines = [
    'logLevel: info',
    'logDestinations: [stdout]',
    'readTimeout: 10s',
    'writeTimeout: 10s',
    'authMethod: internal',
    'authInternalUsers:',
    '  - user: any',
    '    pass:',
    '    ips: ["127.0.0.1", "::1"]',
    '    permissions:',
    '      - action: read',
    '        path:',
    '      - action: playback',
    '        path:',
    '      - action: api',
    '      - action: metrics',
    '      - action: pprof',
    'api: yes',
    `apiAddress: 127.0.0.1:${settings.apiPort}`,
    'metrics: yes',
    `metricsAddress: 127.0.0.1:${settings.metricsPort}`,
    'playback: yes',
    `playbackAddress: 127.0.0.1:${settings.playbackPort}`,
    'rtsp: yes',
    `rtspAddress: :${settings.rtspPort}`,
    'rtspTransports: [tcp]',
    'rtmp: yes',
    `rtmpAddress: :${settings.rtmpPort}`,
    'hls: yes',
    `hlsAddress: :${settings.hlsPort}`,
    'webrtc: yes',
    `webrtcAddress: :${settings.webrtcPort}`,
    `webrtcLocalUDPAddress: :${settings.webrtcUdpPort}`,
    'webrtcLocalTCPAddress: ""',
    `webrtcAdditionalHosts: ${JSON.stringify([settings.publicHost])}`,
    'srt: yes',
    `srtAddress: :${settings.srtPort}`,
    'moq: no',
    'pathDefaults:',
    '  record: no',
    `  recordPath: ${JSON.stringify(path.join(recordingRoot, '%path', '%Y', '%m', '%d', '%Y-%m-%d_%H-%M-%S-%f'))}`,
    '  recordFormat: fmp4',
    '  recordPartDuration: 1s',
    '  recordMaxPartSize: 50M',
    `  recordSegmentDuration: ${settings.segmentDurationSeconds}s`,
    '  recordDeleteAfter: 0s',
    'paths: {}',
    ''
  ];
  return lines.join('\n');
}

export function mediaMtxConfigPath(): string {
  return resolveProjectPath(getEnv().MEDIAMTX_CONFIG_PATH);
}

// Nama sementara unik per penulisan agar dua apply bersamaan tidak saling menimpa file .tmp,
// dan isi di-fsync sebelum rename supaya power loss tidak meninggalkan config kosong.
async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeMediaMtxConfig(settings: MediaMtxSettings): Promise<{ previous: string | null; path: string }> {
  const target = mediaMtxConfigPath();
  await mkdir(path.dirname(target), { recursive: true });
  let previous: string | null = null;
  try { previous = await readFile(target, 'utf8'); } catch { previous = null; }
  await writeFileAtomic(target, renderMediaMtxConfig(settings));
  return { previous, path: target };
}

/**
 * Mengembalikan file config. Bila sebelumnya belum ada file, `fallback` (config dari settings lama)
 * ditulis agar config yang ditolak tidak tertinggal. Mengembalikan false bila tidak ada yang dapat dipulihkan.
 */
export async function restoreMediaMtxConfig(previous: string | null, fallback: string | null = null): Promise<boolean> {
  const content = previous ?? fallback;
  if (content === null) return false;
  await writeFileAtomic(mediaMtxConfigPath(), content);
  return true;
}
