import { constants as fsConstants, createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  statfs,
  unlink
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';
import { appendRouteLog } from '../logs/log-store.js';
import {
  recordingStoragePaused,
  setRecordingStoragePaused
} from '../mediamtx/mediamtx-runtime.js';
import { getFfmpegPath, getMediaMtxSettings } from '../settings/settings-service.js';
import { resolveProjectPath } from '../mediamtx/mediamtx-config.js';

// Hanya berisi file yang belum COMPLETE pada scan terakhir; dipangkas setiap scan.
const stableFiles = new Map<string, { size: number; seenAt: number }>();
const indexFailures = new Map<string, number>();
// Recording yang gagal dihapus (EACCES, EBUSY, EIO) dilewati sementara agar file
// tertua yang sama tidak menghentikan cleanup pada setiap putaran.
const deleteRetryAt = new Map<string, number>();
const playbackOptimizationJobs = new Map<string, Promise<string>>();
// File sumber yang sementara diputar apa adanya (bukan fMP4, optimasi gagal, atau
// storage tidak cukup). Diingat selama TTL cache agar seluruh HTTP Range satu sesi
// playback berasal dari file yang sama dan remux yang gagal tidak diulang setiap seek.
const playbackPassthrough = new Map<string, number>();
const playbackCacheTimers = new Map<string, NodeJS.Timeout>();
const remuxWaiters: Array<() => void> = [];
const PLAYBACK_CACHE_DIRECTORY = '.playback-cache';
const PLAYBACK_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const PLAYBACK_REMUX_CONCURRENCY = 2;
const RECONCILE_BATCH_SIZE = 500;
const CLEANUP_PAGE_SIZE = 500;
const MAX_INDEX_ATTEMPTS = 3;
const DELETE_RETRY_DELAY_MS = 10 * 60 * 1000;
// Bila seluruh volume read-only atau permission salah, setiap recording gagal dihapus;
// hanya beberapa kegagalan pertama per pass cleanup yang dicatat satu per satu.
const DELETE_FAILURE_LOG_LIMIT = 5;
const DELETED_ROW_RETENTION_MS = 7 * 86_400_000;
const ACTIVE_REFRESH_INTERVAL_MS = 5_000;
let activeRemuxJobs = 0;
let reservedRemuxBytes = 0;
let activeRefresh: Promise<void> | undefined;
let activeRefreshedAt = 0;
let scanInFlight: Promise<void> | undefined;
let cleanupInFlight: Promise<void> | undefined;
let initialRecordingPass: Promise<void> | undefined;
let scanTimer: NodeJS.Timeout | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;
let managerRunning = false;

export type EffectiveRecordingRetention = {
  mode: 'DAYS' | 'SIZE' | 'DAYS_OR_SIZE';
  days: number;
  maxGb: number;
};

export function resolveRecordingRetention(
  mode: 'INHERIT' | 'DAYS' | 'SIZE' | 'DAYS_OR_SIZE',
  days: number | null,
  maxGb: number | null,
  defaults: EffectiveRecordingRetention
): EffectiveRecordingRetention {
  if (mode === 'INHERIT') return defaults;
  return {
    mode,
    days: days ?? defaults.days,
    maxGb: maxGb ?? defaults.maxGb
  };
}

function retentionUsesDays(mode: EffectiveRecordingRetention['mode']): boolean {
  return mode === 'DAYS' || mode === 'DAYS_OR_SIZE';
}

function retentionUsesSize(mode: EffectiveRecordingRetention['mode']): boolean {
  return mode === 'SIZE' || mode === 'DAYS_OR_SIZE';
}

export function planRecordingQuotaCleanup(
  rows: Array<{ id: string; sizeBytes: number; protected: boolean }>,
  limitBytes: number
): { deleteIds: string[]; usedBytes: number; projectedBytes: number } {
  const usedBytes = rows.reduce((total, row) => total + row.sizeBytes, 0);
  let projectedBytes = usedBytes;
  const deleteIds: string[] = [];
  for (const row of rows) {
    if (projectedBytes <= limitBytes) break;
    if (row.protected) continue;
    deleteIds.push(row.id);
    projectedBytes -= row.sizeBytes;
  }
  return { deleteIds, usedBytes, projectedBytes };
}

export function evaluateStoragePressure(
  totalBytes: number,
  freeBytes: number,
  minFreePercent: number,
  minFreeGb: number,
  wasPaused: boolean
): {
  thresholdBytes: number;
  recoveryBytes: number;
  needsCleanup: boolean;
  paused: boolean;
} {
  const thresholdBytes = Math.max(totalBytes * minFreePercent / 100, minFreeGb * 1024 ** 3);
  const recoveryBytes = thresholdBytes + Math.max(totalBytes * 0.05, 5 * 1024 ** 3);
  return {
    thresholdBytes,
    recoveryBytes,
    needsCleanup: freeBytes < thresholdBytes,
    paused: wasPaused ? freeBytes < recoveryBytes : freeBytes < thresholdBytes
  };
}

function safeRelative(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('RECORDING_PATH_INVALID', 'Path recording berada di luar storage root', 400);
  }
  return relative;
}

export function parseRecordingDuration(value: string): number {
  if (!value) return 0;
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  let result = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    result += Number(match[1]) * (units[match[2] ?? ''] ?? 0);
  }
  return Math.round(result);
}

export function resolveObservedDuration(
  hookDurationMs: number,
  probedDurationMs: number,
  startTimeMs: number,
  modifiedTimeMs: number
): number {
  if (Number.isFinite(hookDurationMs) && hookDurationMs > 0) return Math.round(hookDurationMs);
  if (Number.isFinite(probedDurationMs) && probedDurationMs > 0) return Math.round(probedDurationMs);
  const filesystemDuration = modifiedTimeMs - startTimeMs;
  return Number.isFinite(filesystemDuration) && filesystemDuration > 0
    ? Math.max(1, Math.round(filesystemDuration))
    : 1;
}

function execFileText(command: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function probeRecordingDuration(file: string): Promise<number> {
  const ffmpegPath = await getFfmpegPath();
  const ffprobePath = path.join(
    path.dirname(ffmpegPath),
    path.basename(ffmpegPath).replace(/^ffmpeg(?:\.exe)?$/i, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  );
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file
  ];
  try {
    const output = await execFileText(ffprobePath, args);
    const seconds = Number(output.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  } catch {
    if (ffprobePath === 'ffprobe') return 0;
    try {
      const output = await execFileText('ffprobe', args);
      const seconds = Number(output.trim());
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
    } catch {
      return 0;
    }
  }
}

export function parseRecordingStart(file: string): Date | null {
  const match = path.basename(file).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, micros = '0'] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(micros.slice(0, 3).padEnd(3, '0'))
  );
  return Number.isNaN(date.valueOf()) ? null : date;
}

function topLevelMp4Boxes(buffer: Buffer): { boxes: Set<string>; error: string | null } {
  let offset = 0;
  const boxes = new Set<string>();
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return { boxes, error: 'Ukuran box MP4 tidak aman' };
      }
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < headerSize) return { boxes, error: `Box MP4 ${type || '?'} tidak valid` };
    boxes.add(type);
    if (offset + size > buffer.length) break;
    offset += size;
  }
  return { boxes, error: null };
}

export function isFragmentedMp4Buffer(buffer: Buffer): boolean {
  const { boxes, error } = topLevelMp4Boxes(buffer);
  return !error && boxes.has('ftyp') && boxes.has('moov') && boxes.has('moof');
}

export function inspectFmp4Buffer(buffer: Buffer): { ok: boolean; error: string | null } {
  const { boxes, error } = topLevelMp4Boxes(buffer);
  if (error) return { ok: false, error };
  if (!boxes.has('ftyp')) return { ok: false, error: 'Header fMP4 (ftyp) tidak ditemukan' };
  if (!boxes.has('moov')) return { ok: false, error: 'Metadata fMP4 (moov) tidak ditemukan' };
  if (!boxes.has('moof') && !boxes.has('mdat')) {
    return { ok: false, error: 'Data fragment fMP4 tidak ditemukan' };
  }
  return { ok: true, error: null };
}

async function inspectFmp4File(file: string): Promise<{ ok: boolean; error: string | null }> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (info.size < 24) return { ok: false, error: 'File terlalu kecil untuk menjadi fMP4 valid' };
    const length = Math.min(info.size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return inspectFmp4Buffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function fragmentedMp4File(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return isFragmentedMp4Buffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function playbackCachePath(storageRoot: string, recordingId: string): string {
  return path.join(path.resolve(storageRoot), PLAYBACK_CACHE_DIRECTORY, `${recordingId}.mp4`);
}

function schedulePlaybackCacheCleanup(cacheFile: string): void {
  const current = playbackCacheTimers.get(cacheFile);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    playbackCacheTimers.delete(cacheFile);
    void unlink(cacheFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'EBUSY') {
        console.error(`[recording] Gagal membersihkan playback cache: ${error.message}`);
      }
    });
  }, PLAYBACK_CACHE_TTL_MS);
  timer.unref();
  playbackCacheTimers.set(cacheFile, timer);
}

/**
 * Menghapus cache playback. Saat startup seluruh isi dihapus; saat storage pressure
 * file sementara milik remux yang sedang berjalan dibiarkan. Mengembalikan jumlah file.
 */
async function clearPlaybackCache(storageRoot: string, keepTemporary = false): Promise<number> {
  const directory = path.join(path.resolve(storageRoot), PLAYBACK_CACHE_DIRECTORY);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const removed = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mp4') && !(keepTemporary && entry.name.startsWith('.')))
    .map(async (entry) => {
      const file = path.join(directory, entry.name);
      const timer = playbackCacheTimers.get(file);
      if (timer) clearTimeout(timer);
      playbackCacheTimers.delete(file);
      return unlink(file).then(() => true, () => false);
    }));
  return removed.filter(Boolean).length;
}

function rememberPlaybackPassthrough(sourceFile: string): void {
  const now = Date.now();
  for (const [file, expiresAt] of playbackPassthrough) {
    if (expiresAt <= now) playbackPassthrough.delete(file);
  }
  playbackPassthrough.set(sourceFile, now + PLAYBACK_CACHE_TTL_MS);
}

async function acquireRemuxSlot(): Promise<void> {
  if (activeRemuxJobs < PLAYBACK_REMUX_CONCURRENCY) {
    activeRemuxJobs += 1;
    return;
  }
  // Slot diserahkan langsung oleh releaseRemuxSlot sehingga jumlah job aktif tetap.
  await new Promise<void>((resolve) => remuxWaiters.push(resolve));
}

function releaseRemuxSlot(): void {
  const next = remuxWaiters.shift();
  if (next) next();
  else activeRemuxJobs -= 1;
}

async function optimizeRecordingForPlayback(
  row: { id: string; routeId: string | null; storageRoot: string; relativePath: string },
  sourceFile: string
): Promise<string> {
  const cacheFile = playbackCachePath(row.storageRoot, row.id);
  const sourceInfo = await stat(sourceFile);
  // Cache diperiksa sebelum membaca header sumber: setiap HTTP Range (seek) tidak
  // perlu lagi membaca 4 MB file recording.
  const cachedInfo = await stat(cacheFile).catch(() => null);
  if (cachedInfo?.isFile() && cachedInfo.size > 0 && cachedInfo.mtimeMs >= sourceInfo.mtimeMs) {
    schedulePlaybackCacheCleanup(cacheFile);
    return cacheFile;
  }
  if ((playbackPassthrough.get(sourceFile) ?? 0) > Date.now()) return sourceFile;

  const active = playbackOptimizationJobs.get(sourceFile);
  if (active) return active;
  const job = (async () => {
    if (!await fragmentedMp4File(sourceFile)) {
      rememberPlaybackPassthrough(sourceFile);
      return sourceFile;
    }
    // Remux menyalin satu file penuh; batasi job paralel agar beberapa playback
    // sekaligus tidak menghabiskan disk dan I/O recording.
    await acquireRemuxSlot();
    let reservedBytes = 0;
    try {
      const settings = await getMediaMtxSettings();
      const disk = await statfs(row.storageRoot);
      const totalBytes = Number(disk.blocks) * Number(disk.bsize);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      // Cache harus tetap menyisakan ruang di atas batas recovery storage guard,
      // termasuk remux lain yang sedang berjalan. Bila tidak, cleanup berikutnya
      // menghapus recording asli demi cache sementara.
      const { recoveryBytes } = evaluateStoragePressure(
        totalBytes,
        freeBytes,
        settings.minFreePercent,
        settings.minFreeGb,
        false
      );
      if (freeBytes - reservedRemuxBytes - sourceInfo.size < recoveryBytes) {
        rememberPlaybackPassthrough(sourceFile);
        return sourceFile;
      }
      reservedBytes = sourceInfo.size;
      reservedRemuxBytes += reservedBytes;
      return await remuxRecordingForPlayback(row, sourceFile, cacheFile);
    } finally {
      reservedRemuxBytes -= reservedBytes;
      releaseRemuxSlot();
    }
  })();
  playbackOptimizationJobs.set(sourceFile, job);
  try {
    return await job;
  } finally {
    playbackOptimizationJobs.delete(sourceFile);
  }
}

async function remuxRecordingForPlayback(
  row: { id: string; routeId: string | null; relativePath: string },
  sourceFile: string,
  cacheFile: string
): Promise<string> {
  const cacheDirectory = path.dirname(cacheFile);
  await mkdir(cacheDirectory, { recursive: true });
  const temporaryFile = path.join(
    cacheDirectory,
    `.${row.id}-${process.pid}-${Date.now()}.tmp.mp4`
  );
  try {
    const ffmpegPath = await getFfmpegPath();
    await execFileText(ffmpegPath, [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-v', 'error',
      '-i', sourceFile,
      '-map', '0:v?',
      '-map', '0:a?',
      '-c', 'copy',
      '-movflags', '+faststart',
      temporaryFile
    ], 120_000);
    const inspection = await inspectFmp4File(temporaryFile);
    if (!inspection.ok) throw new Error(inspection.error ?? 'MP4 hasil optimasi tidak valid');
    await rename(temporaryFile, cacheFile);
    schedulePlaybackCacheCleanup(cacheFile);
    if (row.routeId) {
      await appendRouteLog(
        row.routeId,
        'info',
        `Playback MP4 dioptimalkan tanpa transcoding: ${row.relativePath}`,
        'RECORDING'
      ).catch(() => undefined);
    }
    return cacheFile;
  } catch (error) {
    await unlink(temporaryFile).catch(() => undefined);
    rememberPlaybackPassthrough(sourceFile);
    if (row.routeId) {
      await appendRouteLog(
        row.routeId,
        'warn',
        `Optimasi playback dilewati, memakai fMP4 asli: ${(error as Error).message}`,
        'RECORDING'
      ).catch(() => undefined);
    }
    return sourceFile;
  }
}

async function routeForFile(root: string, file: string) {
  const relative = safeRelative(root, file);
  const parts = relative.split(path.sep);
  const cameraKey = parts[0] === 'cameras' ? parts[1] : parts[0];
  if (!cameraKey) throw new AppError('RECORDING_PATH_INVALID', 'Camera ID tidak ditemukan pada path recording', 400);
  const route = await prisma.streamRoute.findUnique({ where: { cameraKey } });
  return { relative, cameraKey, route };
}

export async function indexRecordingSegment(input: {
  segmentPath: string;
  duration?: string;
}): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  const root = resolveProjectPath(settings.recordingPath);
  const file = path.resolve(input.segmentPath);
  const relative = safeRelative(root, file);
  const fileStat = await stat(file);
  if (!fileStat.isFile()) throw new AppError('RECORDING_FILE_INVALID', 'Segment recording bukan file', 400);
  const { cameraKey, route } = await routeForFile(root, file);
  const startTime = parseRecordingStart(file) ?? fileStat.birthtime;
  const parsedDuration = parseRecordingDuration(input.duration ?? '');
  const probedDuration = parsedDuration > 0 ? 0 : await probeRecordingDuration(file);
  const durationMs = resolveObservedDuration(parsedDuration, probedDuration, startTime.getTime(), fileStat.mtimeMs);
  const endTime = new Date(startTime.getTime() + durationMs);
  const row = await prisma.recordingSegment.upsert({
    where: { storageRoot_relativePath: { storageRoot: root, relativePath: relative } },
    update: {
      routeId: route?.id ?? null,
      cameraKey,
      cameraName: route?.name ?? cameraKey,
      startTime,
      endTime,
      durationMs,
      sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size),
      status: 'COMPLETE',
      deletionReason: null,
      errorMessage: null,
      deletedAt: null
    },
    create: {
      routeId: route?.id ?? null,
      cameraKey,
      cameraName: route?.name ?? cameraKey,
      storageRoot: root,
      relativePath: relative,
      startTime,
      endTime,
      durationMs,
      sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size)
    }
  });
  // Log route bersifat pelengkap: disk log yang penuh tidak boleh membuat segment
  // yang sudah tersimpan COMPLETE ditandai ERROR oleh scanner.
  if (route) {
    await appendRouteLog(route.id, 'info', `Recording segment selesai: ${relative}`, 'RECORDING').catch(() => undefined);
  }
  return recordingDto(row);
}

export async function indexRecordingStarted(input: {
  segmentPath: string;
}): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  const root = resolveProjectPath(settings.recordingPath);
  const file = path.resolve(input.segmentPath);
  const relative = safeRelative(root, file);
  const fileStat = await stat(file);
  if (!fileStat.isFile()) throw new AppError('RECORDING_FILE_INVALID', 'Segment recording bukan file', 400);
  const existing = await prisma.recordingSegment.findUnique({
    where: { storageRoot_relativePath: { storageRoot: root, relativePath: relative } }
  });
  if (existing && existing.status !== 'RECORDING') return recordingDto(existing);
  const { cameraKey, route } = await routeForFile(root, file);
  const previousActive = await prisma.recordingSegment.findMany({
    where: {
      cameraKey,
      status: 'RECORDING',
      NOT: { storageRoot: root, relativePath: relative }
    }
  });
  for (const previous of previousActive) {
    const previousFile = path.resolve(previous.storageRoot, previous.relativePath);
    await indexRecordingSegment({ segmentPath: previousFile }).catch(async (error) => {
      await prisma.recordingSegment.update({
        where: { id: previous.id },
        data: {
          status: 'ERROR',
          errorMessage: `Segment sebelumnya tidak selesai: ${(error as Error).message}`
        }
      }).catch(() => undefined);
    });
  }
  const startTime = parseRecordingStart(file) ?? fileStat.birthtime;
  const now = new Date();
  const durationMs = Math.max(1, now.getTime() - startTime.getTime());
  const row = await prisma.recordingSegment.upsert({
    where: { storageRoot_relativePath: { storageRoot: root, relativePath: relative } },
    update: {
      routeId: route?.id ?? null,
      cameraKey,
      cameraName: route?.name ?? cameraKey,
      startTime,
      endTime: now,
      durationMs,
      sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size),
      status: 'RECORDING',
      deletionReason: null,
      errorMessage: null,
      deletedAt: null
    },
    create: {
      routeId: route?.id ?? null,
      cameraKey,
      cameraName: route?.name ?? cameraKey,
      storageRoot: root,
      relativePath: relative,
      startTime,
      endTime: now,
      durationMs,
      sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size),
      status: 'RECORDING'
    }
  });
  return recordingDto(row);
}

/**
 * Memperbarui durasi dan ukuran recording aktif. List, kalender, dan timeline
 * memanggilnya bersamaan setiap polling, jadi pemanggilan berbagi satu refresh
 * dan paling sering sekali per ACTIVE_REFRESH_INTERVAL_MS.
 */
export function refreshActiveRecordings(): Promise<void> {
  if (activeRefresh) return activeRefresh;
  if (Date.now() - activeRefreshedAt < ACTIVE_REFRESH_INTERVAL_MS) return Promise.resolve();
  activeRefresh = updateActiveRecordings().finally(() => {
    activeRefreshedAt = Date.now();
    activeRefresh = undefined;
  });
  return activeRefresh;
}

async function updateActiveRecordings(): Promise<void> {
  const rows = await prisma.recordingSegment.findMany({
    where: { status: 'RECORDING' },
    select: { id: true, storageRoot: true, relativePath: true, startTime: true }
  });
  const now = new Date();
  const changes = await Promise.all(rows.map(async (row): Promise<{
    id: string;
    data: Prisma.RecordingSegmentUpdateManyMutationInput;
  } | null> => {
    const file = path.resolve(row.storageRoot, row.relativePath);
    if (!file.startsWith(`${path.resolve(row.storageRoot)}${path.sep}`)) return null;
    const fileStat = await stat(file).catch(() => null);
    if (!fileStat && now.getTime() - row.startTime.getTime() > 60_000) {
      return {
        id: row.id,
        data: {
          status: 'ERROR',
          errorMessage: 'File recording aktif tidak ditemukan setelah proses berhenti'
        }
      };
    }
    return {
      id: row.id,
      data: {
        endTime: now,
        durationMs: Math.max(1, now.getTime() - row.startTime.getTime()),
        ...(fileStat ? { sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size) } : {})
      }
    };
  }));
  const updates = changes.filter((change) => change !== null);
  if (!updates.length) return;
  // Guard status: hook COMPLETE yang masuk di antara stat dan update tidak boleh
  // ditimpa endTime/ukuran lama. Satu transaksi = satu commit SQLite untuk semua kamera.
  await prisma.$transaction(updates.map((change) => prisma.recordingSegment.updateMany({
    where: { id: change.id, status: 'RECORDING' },
    data: change.data
  }))).catch(() => undefined);
}

async function indexRecordingError(file: string, message: string): Promise<void> {
  const settings = await getMediaMtxSettings();
  const root = resolveProjectPath(settings.recordingPath);
  const relative = safeRelative(root, file);
  const fileStat = await stat(file);
  const { cameraKey, route } = await routeForFile(root, file);
  const startTime = parseRecordingStart(file) ?? fileStat.birthtime;
  const durationMs = resolveObservedDuration(0, 0, startTime.getTime(), fileStat.mtimeMs);
  await prisma.recordingSegment.upsert({
    where: { storageRoot_relativePath: { storageRoot: root, relativePath: relative } },
    update: {
      routeId: route?.id ?? null,
      cameraKey,
      cameraName: route?.name ?? cameraKey,
      startTime,
      endTime: new Date(startTime.getTime() + durationMs),
      durationMs,
      sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size),
      status: 'ERROR',
      errorMessage: message,
      deletionReason: null,
      deletedAt: null
    },
    create: {
      routeId: route?.id ?? null,
      cameraKey,
      cameraName: route?.name ?? cameraKey,
      storageRoot: root,
      relativePath: relative,
      startTime,
      endTime: new Date(startTime.getTime() + durationMs),
      durationMs,
      sizeBytes: Math.min(Number.MAX_SAFE_INTEGER, fileStat.size),
      status: 'ERROR',
      errorMessage: message
    }
  });
  if (route) {
    await appendRouteLog(route.id, 'warn', `Recording tidak dapat direkonsiliasi: ${message}`, 'RECORDING').catch(() => undefined);
  }
}

export async function walkRecordingFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  // Iteratif dengan satu array hasil: menggabungkan hasil rekursi lewat
  // `push(...array)` melempar RangeError di atas ~110 ribu file.
  const directories = [root];
  for (let directory = directories.pop(); directory !== undefined; directory = directories.pop()) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== PLAYBACK_CACHE_DIRECTORY) directories.push(full);
      } else if (entry.isFile() && /\.(?:mp4|m4s|ts)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

export async function reconcileRecordingFiles(): Promise<{ indexed: number; missing: number }> {
  const settings = await getMediaMtxSettings();
  const root = resolveProjectPath(settings.recordingPath);
  await mkdir(root, { recursive: true });
  const files = await walkRecordingFiles(root);
  const present = new Set<string>();
  const pending = new Set<string>();
  let indexed = 0;
  const now = Date.now();
  // Per batch hanya baris milik file yang ada di disk yang dibaca (lewat unique
  // index storageRoot+relativePath), sehingga tombstone DELETED dan seluruh tabel
  // tidak dimuat ke memori setiap 30 detik. Durasi COMPLETE tidak di-ffprobe ulang:
  // nilainya sudah berasal dari hook MediaMTX atau ffprobe saat diindeks.
  for (let offset = 0; offset < files.length; offset += RECONCILE_BATCH_SIZE) {
    const batch = files.slice(offset, offset + RECONCILE_BATCH_SIZE);
    const infos = await Promise.all(batch.map((file) => stat(file).catch(() => null)));
    // File dapat terhapus (retention, hapus manual) di antara walk dan stat.
    const entries = batch.flatMap((file, index) => {
      const info = infos[index];
      return info?.isFile() ? [{ file, info, relative: safeRelative(root, file) }] : [];
    });
    if (!entries.length) continue;
    const existingRows = await prisma.recordingSegment.findMany({
      where: { storageRoot: root, relativePath: { in: entries.map((entry) => entry.relative) } },
      select: { relativePath: true, status: true, sizeBytes: true }
    });
    const existingByPath = new Map(existingRows.map((row) => [row.relativePath, row]));
    for (const { file, info, relative } of entries) {
      present.add(relative);
      const existing = existingByPath.get(relative);
      if (existing?.sizeBytes === info.size && existing.status === 'COMPLETE') continue;
      pending.add(file);
      const known = stableFiles.get(file);
      stableFiles.set(file, { size: info.size, seenAt: now });
      if (!known || known.size !== info.size || now - known.seenAt < 10_000) {
        if (info.mtimeMs >= now - 60_000) {
          await indexRecordingStarted({ segmentPath: file }).catch(() => undefined);
        }
        continue;
      }
      if (existing?.sizeBytes === info.size && existing.status === 'ERROR') {
        continue;
      }
      try {
        const inspection = await inspectFmp4File(file);
        if (!inspection.ok) {
          await indexRecordingError(file, inspection.error ?? 'File fMP4 tidak valid');
          indexFailures.delete(file);
          continue;
        }
        await indexRecordingSegment({ segmentPath: file });
        indexFailures.delete(file);
        indexed += 1;
      } catch (error) {
        // Kegagalan sementara (database sibuk, I/O) dicoba lagi pada scan berikutnya.
        // ERROR hanya diberikan setelah gagal berulang agar segment valid tidak terkunci.
        const attempts = (indexFailures.get(file) ?? 0) + 1;
        if (attempts < MAX_INDEX_ATTEMPTS) {
          indexFailures.set(file, attempts);
          continue;
        }
        indexFailures.delete(file);
        await indexRecordingError(file, (error as Error).message).catch(() => undefined);
      }
    }
  }
  for (const file of stableFiles.keys()) {
    if (!pending.has(file)) stableFiles.delete(file);
  }
  for (const file of indexFailures.keys()) {
    if (!pending.has(file)) indexFailures.delete(file);
  }
  const missing = await markMissingRecordings(root, present);
  return { indexed, missing };
}

async function markMissingRecordings(root: string, present: Set<string>): Promise<number> {
  let missing = 0;
  let afterId: string | undefined;
  for (;;) {
    const rows = await prisma.recordingSegment.findMany({
      where: { storageRoot: root, status: 'COMPLETE', ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      select: { id: true, relativePath: true },
      take: RECONCILE_BATCH_SIZE
    });
    const missingIds: string[] = [];
    for (const row of rows) {
      if (present.has(row.relativePath)) continue;
      // Segment yang selesai lewat hook setelah walk dimulai belum ada di `present`.
      const info = await stat(path.join(root, row.relativePath)).catch(() => null);
      if (!info?.isFile()) missingIds.push(row.id);
    }
    if (missingIds.length) {
      const result = await prisma.recordingSegment.updateMany({
        where: { id: { in: missingIds }, status: 'COMPLETE' },
        data: { status: 'MISSING', errorMessage: 'File recording tidak ditemukan pada storage yang tercatat' }
      });
      missing += result.count;
    }
    if (rows.length < RECONCILE_BATCH_SIZE) return missing;
    afterId = rows[rows.length - 1]!.id;
  }
}

/** Folder yang tidak dapat ditulis (EROFS/EACCES/EPERM) gagal di sini, sebelum ada write SQLite. */
async function assertDirectoryWritable(directory: string): Promise<void> {
  try {
    await access(directory, fsConstants.W_OK);
  } catch (error) {
    // Folder yang hilang berarti file juga hilang; unlink di bawah memperlakukannya sebagai terhapus.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Mengembalikan ukuran file yang dihapus, atau null bila baris dilewati. */
async function deleteSegment(id: string, reason: string, options: { probeWritable?: boolean } = {}): Promise<number | null> {
  const row = await prisma.recordingSegment.findUnique({ where: { id } });
  if (!row || row.status === 'DELETED' || row.protected) return null;
  const full = path.resolve(row.storageRoot, row.relativePath);
  if (!full.startsWith(`${path.resolve(row.storageRoot)}${path.sep}`)) throw new AppError('RECORDING_PATH_INVALID', 'Path recording tidak aman', 500);
  if (options.probeWritable) await assertDirectoryWritable(path.dirname(full));
  await prisma.recordingSegment.update({ where: { id }, data: { status: 'DELETING', deletionReason: reason } });
  try { await unlink(full); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await prisma.recordingSegment.update({ where: { id }, data: { status: row.status } });
      throw error;
    }
  }
  const cacheFile = playbackCachePath(row.storageRoot, row.id);
  const cacheTimer = playbackCacheTimers.get(cacheFile);
  if (cacheTimer) clearTimeout(cacheTimer);
  playbackCacheTimers.delete(cacheFile);
  playbackPassthrough.delete(full);
  await unlink(cacheFile).catch(() => undefined);
  await prisma.recordingSegment.update({
    where: { id },
    data: { status: 'DELETED', deletedAt: new Date(), deletionReason: reason }
  });
  if (row.routeId) {
    await appendRouteLog(row.routeId, 'info', `Recording dihapus (${reason}): ${row.relativePath}`, 'RECORDING').catch(() => undefined);
  }
  return row.sizeBytes;
}

/** Kegagalan hapus dalam satu pass cleanup: beberapa pertama dicatat, sisanya diringkas per kode error. */
interface CleanupDeleteFailures {
  logged: number;
  suppressed: Map<string, number>;
}

/**
 * Menghapus satu recording untuk retention atau storage guard. Kegagalan dicatat
 * dan recording dilewati selama DELETE_RETRY_DELAY_MS (status tetap seperti semula,
 * sehingga tetap ikut retention berikutnya), lalu cleanup berlanjut ke recording lain.
 * Folder yang tidak dapat ditulis diperiksa lebih dulu, sehingga volume read-only tidak
 * menghasilkan dua write SQLite per recording pada setiap pass.
 */
async function deleteSegmentForCleanup(
  id: string,
  reason: string,
  now: number,
  failures: CleanupDeleteFailures
): Promise<number | null> {
  if ((deleteRetryAt.get(id) ?? 0) > now) return null;
  try {
    const size = await deleteSegment(id, reason, { probeWritable: true });
    deleteRetryAt.delete(id);
    return size;
  } catch (error) {
    deleteRetryAt.set(id, now + DELETE_RETRY_DELAY_MS);
    if (failures.logged < DELETE_FAILURE_LOG_LIMIT) {
      failures.logged += 1;
      console.error(`[recording] Gagal menghapus recording ${id} (${reason}): ${(error as Error).message}`);
    } else {
      const code = (error as NodeJS.ErrnoException).code ?? 'ERROR';
      failures.suppressed.set(code, (failures.suppressed.get(code) ?? 0) + 1);
    }
    return null;
  }
}

function reportSuppressedDeleteFailures(failures: CleanupDeleteFailures, root: string): void {
  if (!failures.suppressed.size) return;
  const total = [...failures.suppressed.values()].reduce((sum, value) => sum + value, 0);
  const codes = [...failures.suppressed].map(([code, count]) => `${code}: ${count}`).join(', ');
  console.error(`[recording] ${total} recording lain juga gagal dihapus pada pass cleanup ini (${codes}); periksa permission dan mount storage recording (${root}).`);
}

type CleanupRow = { id: string; startTime: Date; sizeBytes: number; protected: boolean };

/** Recording tertua lebih dulu, per halaman (keyset startTime+id) dengan kolom minimal. */
async function* oldestRecordingPages(where: Prisma.RecordingSegmentWhereInput): AsyncGenerator<CleanupRow[]> {
  let last: CleanupRow | undefined;
  for (;;) {
    const page: CleanupRow[] = await prisma.recordingSegment.findMany({
      where: last
        ? {
          AND: [where, {
            OR: [
              { startTime: { gt: last.startTime } },
              { startTime: last.startTime, id: { gt: last.id } }
            ]
          }]
        }
        : where,
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      select: { id: true, startTime: true, sizeBytes: true, protected: true },
      take: CLEANUP_PAGE_SIZE
    });
    if (page.length) yield page;
    if (page.length < CLEANUP_PAGE_SIZE) return;
    last = page[page.length - 1];
  }
}

/** Menghapus tombstone DELETED lama secara bertahap agar tabel tidak tumbuh tanpa batas. */
async function purgeDeletedRecordingRows(now: number): Promise<number> {
  const cutoff = new Date(now - DELETED_ROW_RETENTION_MS);
  let purged = 0;
  for (;;) {
    const rows = await prisma.recordingSegment.findMany({
      where: { status: 'DELETED', deletedAt: { lt: cutoff } },
      select: { id: true },
      take: 1000
    });
    if (!rows.length) return purged;
    const result = await prisma.recordingSegment.deleteMany({
      where: { id: { in: rows.map((row) => row.id) }, status: 'DELETED' }
    });
    purged += result.count;
    if (rows.length < 1000) return purged;
  }
}

// Pause/resume hanya mem-patch flag record lewat antrean per-route WorkerManager (berurutan dengan Stop),
// tanpa inisiasi ulang path. Pemanggil tidak menunggunya agar cleanup tidak tertahan antrean route.
async function reapplyRecordingRoutes(): Promise<void> {
  const { workerManager } = await import('../workers/worker-manager.js');
  await workerManager.applyRecordingStoragePause();
}

export async function cleanupRecordings(): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  const root = resolveProjectPath(settings.recordingPath);
  await mkdir(root, { recursive: true });
  const defaultRetention: EffectiveRecordingRetention = {
    mode: settings.retentionMode,
    days: settings.retentionDays,
    maxGb: settings.retentionMaxGb
  };
  const routes = await prisma.streamRoute.findMany({
    select: {
      id: true,
      cameraKey: true,
      recordingRetentionMode: true,
      recordingRetentionDays: true,
      recordingRetentionGb: true
    }
  });
  const routeRetention = new Map(routes.map((route) => [
    route.id,
    resolveRecordingRetention(
      route.recordingRetentionMode as 'INHERIT' | 'DAYS' | 'SIZE' | 'DAYS_OR_SIZE',
      route.recordingRetentionDays,
      route.recordingRetentionGb,
      defaultRetention
    )
  ]));
  const cameraRetention = new Map(routes.map((route) => [
    route.cameraKey,
    routeRetention.get(route.id) ?? defaultRetention
  ]));
  const policyFor = (row: { routeId: string | null; cameraKey: string }) => (
    (row.routeId ? routeRetention.get(row.routeId) : undefined)
    ?? cameraRetention.get(row.cameraKey)
    ?? defaultRetention
  );
  let deleted = 0;
  let freed = 0;
  const now = Date.now();
  for (const [id, retryAt] of deleteRetryAt) {
    if (retryAt <= now) deleteRetryAt.delete(id);
  }
  const deleteFailures: CleanupDeleteFailures = { logged: 0, suppressed: new Map() };
  const removeForCleanup = async (id: string, reason: string): Promise<number | null> => {
    const size = await deleteSegmentForCleanup(id, reason, now, deleteFailures);
    if (size !== null) {
      deleted += 1;
      freed += size;
    }
    return size;
  };

  // Retention hari berjalan per cakupan kebijakan (route, recording milik route yang
  // sudah dihapus per Camera ID, lalu default) dengan filter waktu di SQL, sehingga
  // hanya recording kedaluwarsa yang dibaca. Foreign key ON DELETE SET NULL menjamin
  // routeId yang terisi selalu milik route yang ada.
  const retentionScopes: Array<{ where: Prisma.RecordingSegmentWhereInput; policy: EffectiveRecordingRetention }> = [
    ...routes.map((route) => ({
      where: { routeId: route.id },
      policy: policyFor({ routeId: route.id, cameraKey: route.cameraKey })
    })),
    ...routes.map((route) => ({
      where: { routeId: null, cameraKey: route.cameraKey },
      policy: policyFor({ routeId: null, cameraKey: route.cameraKey })
    })),
    {
      where: { routeId: null, cameraKey: { notIn: routes.map((route) => route.cameraKey) } },
      policy: defaultRetention
    }
  ];
  // Setiap fase diisolasi: kegagalan satu fase tidak boleh melewatkan evaluasi
  // storage pressure di bawah.
  try {
    for (const scope of retentionScopes) {
      if (!retentionUsesDays(scope.policy.mode)) continue;
      const cutoff = new Date(now - scope.policy.days * 86_400_000);
      for await (const page of oldestRecordingPages({
        ...scope.where,
        // ERROR ikut retention: file tetap memakai disk walau tidak dapat diputar.
        status: { in: ['COMPLETE', 'ERROR'] },
        protected: false,
        startTime: { lt: cutoff },
        endTime: { lt: cutoff }
      })) {
        for (const row of page) await removeForCleanup(row.id, 'retention_expired');
      }
    }
  } catch (error) {
    console.error(`[recording] Retention hari gagal: ${(error as Error).message}`);
  }

  const quotaExceeded: Array<{ cameraKey: string; usedBytes: number; limitBytes: number }> = [];
  const sizePolicyInUse = retentionUsesSize(defaultRetention.mode)
    || [...routeRetention.values()].some((policy) => retentionUsesSize(policy.mode));
  try {
    // Pemakaian per kamera dijumlahkan di SQL; hanya kamera yang melewati kuota yang
    // dibaca barisnya, tertua lebih dulu.
    const usage = sizePolicyInUse
      ? await prisma.recordingSegment.groupBy({
        by: ['cameraKey'],
        where: { status: 'COMPLETE' },
        _sum: { sizeBytes: true }
      })
      : [];
    for (const camera of usage) {
      const oldest = await prisma.recordingSegment.findFirst({
        where: { cameraKey: camera.cameraKey, status: 'COMPLETE' },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        select: { routeId: true, cameraKey: true }
      });
      if (!oldest) continue;
      const policy = policyFor(oldest);
      if (!retentionUsesSize(policy.mode)) continue;
      const limitBytes = policy.maxGb * 1024 ** 3;
      let usedBytes = camera._sum.sizeBytes ?? 0;
      if (usedBytes > limitBytes) {
        for await (const page of oldestRecordingPages({ cameraKey: camera.cameraKey, status: 'COMPLETE' })) {
          const pageBytes = page.reduce((total, row) => total + row.sizeBytes, 0);
          // Recording yang sedang menunggu retry hapus diperlakukan seperti protected.
          const quotaPlan = planRecordingQuotaCleanup(
            page.map((row) => ({ ...row, protected: row.protected || (deleteRetryAt.get(row.id) ?? 0) > now })),
            limitBytes - (usedBytes - pageBytes)
          );
          for (const id of quotaPlan.deleteIds) {
            const size = await removeForCleanup(id, 'retention_size_limit');
            if (size !== null) usedBytes -= size;
          }
          if (usedBytes <= limitBytes) break;
        }
      }
      if (usedBytes > limitBytes) quotaExceeded.push({ cameraKey: camera.cameraKey, usedBytes, limitBytes });
    }
  } catch (error) {
    console.error(`[recording] Kuota storage kamera gagal diterapkan: ${(error as Error).message}`);
  }

  await purgeDeletedRecordingRows(now).catch((error: Error) => {
    console.error(`[recording] Gagal membersihkan riwayat recording terhapus: ${error.message}`);
  });

  const disk = await statfs(root);
  const total = Number(disk.blocks) * Number(disk.bsize);
  let free = Number(disk.bavail) * Number(disk.bsize);
  let pressure = evaluateStoragePressure(
    total,
    free,
    settings.minFreePercent,
    settings.minFreeGb,
    recordingStoragePaused()
  );
  if (pressure.needsCleanup) {
    // Cache playback hanya salinan: kosongkan lebih dulu sebelum recording asli dihapus.
    if (await clearPlaybackCache(root, true) > 0) {
      const refreshed = await statfs(root);
      free = Number(refreshed.bavail) * Number(refreshed.bsize);
    }
    try {
      for await (const page of oldestRecordingPages({ status: { in: ['COMPLETE', 'ERROR'] }, protected: false })) {
        for (const row of page) {
          if (free >= pressure.recoveryBytes) break;
          const size = await removeForCleanup(row.id, 'storage_pressure');
          if (size !== null) free += size;
        }
        if (free >= pressure.recoveryBytes) break;
      }
    } catch (error) {
      console.error(`[recording] Storage guard gagal menghapus recording: ${(error as Error).message}`);
    }
  }
  pressure = evaluateStoragePressure(
    total,
    free,
    settings.minFreePercent,
    settings.minFreeGb,
    recordingStoragePaused()
  );
  reportSuppressedDeleteFailures(deleteFailures, root);
  const shouldPause = pressure.paused;
  if (shouldPause !== recordingStoragePaused()) {
    setRecordingStoragePaused(shouldPause);
    void reapplyRecordingRoutes().catch((error: Error) => {
      console.error(`[recording] Gagal menerapkan pause storage: ${error.message}`);
    });
  }
  return {
    deleted,
    freedBytes: freed,
    paused: shouldPause,
    totalBytes: total,
    freeBytes: free,
    thresholdBytes: pressure.thresholdBytes,
    recoveryBytes: pressure.recoveryBytes,
    quotaExceeded
  };
}

export function recordingDto(row: {
  id: string;
  routeId: string | null;
  cameraKey: string;
  cameraName: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  sizeBytes: number;
  status: string;
  protected: boolean;
  deletionReason: string | null;
  errorMessage: string | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    routeId: row.routeId,
    cameraKey: row.cameraKey,
    cameraName: row.cameraName,
    startTime: row.startTime,
    endTime: row.endTime,
    durationMs: row.durationMs,
    sizeBytes: row.sizeBytes,
    status: row.status,
    protected: row.protected,
    deletionReason: row.deletionReason,
    errorMessage: row.errorMessage
  };
}

export async function recordingStorageStatus(): Promise<Record<string, unknown>> {
  const settings = await getMediaMtxSettings();
  const root = resolveProjectPath(settings.recordingPath);
  await mkdir(root, { recursive: true });
  const disk = await statfs(root);
  const totalBytes = Number(disk.blocks) * Number(disk.bsize);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const [segments, aggregate] = await Promise.all([
    prisma.recordingSegment.count({ where: { status: 'COMPLETE' } }),
    prisma.recordingSegment.aggregate({ where: { status: 'COMPLETE' }, _sum: { sizeBytes: true } })
  ]);
  return {
    totalBytes,
    freeBytes,
    usedByRecordingsBytes: aggregate._sum.sizeBytes ?? 0,
    segments,
    paused: recordingStoragePaused(),
    retentionMode: settings.retentionMode,
    retentionDays: settings.retentionDays,
    retentionMaxGb: settings.retentionMaxGb,
    minFreePercent: settings.minFreePercent,
    minFreeGb: settings.minFreeGb
  };
}

export async function proxyRecording(
  id: string,
  range: string | undefined,
  download: boolean
): Promise<{ status: number; headers: Record<string, string>; stream: Readable }> {
  const row = await prisma.recordingSegment.findUnique({ where: { id } });
  if (!row || row.status !== 'COMPLETE') throw new AppError('RECORDING_NOT_FOUND', 'Recording tidak ditemukan', 404);
  const full = path.resolve(row.storageRoot, row.relativePath);
  if (!full.startsWith(`${path.resolve(row.storageRoot)}${path.sep}`)) {
    throw new AppError('RECORDING_PATH_INVALID', 'Path recording tidak aman', 500);
  }
  // MediaMTX menyimpan concatenated fMP4 agar crash-safe. Untuk browser,
  // container tersebut di-remux sekali (codec copy) menjadi MP4 faststart.
  // Cache tetap byte-addressable sehingga startup dan seeking sama-sama cepat.
  const playbackFile = await optimizeRecordingForPlayback(row, full);
  return recordingFileResponse(
    playbackFile,
    range,
    download
      ? `${row.cameraKey}-${row.startTime.toISOString().replaceAll(':', '-')}.mp4`
      : undefined
  );
}

async function recordingFileResponse(
  fullPath: string,
  range: string | undefined,
  downloadName?: string
): Promise<{ status: number; headers: Record<string, string>; stream: Readable }> {
  const info = await stat(fullPath);
  const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=86400, immutable',
    etag,
    'last-modified': info.mtime.toUTCString(),
    ...(downloadName ? { 'content-disposition': `attachment; filename="${downloadName}"` } : {})
  };
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) {
      throw new AppError('RANGE_NOT_SATISFIABLE', 'HTTP Range recording tidak valid', 416);
    }
    const suffixLength = match[1] ? null : Number(match[2]);
    const start = suffixLength === null ? Number(match[1]) : Math.max(0, info.size - suffixLength);
    const requestedEnd = match[2] && suffixLength === null ? Number(match[2]) : info.size - 1;
    const end = Math.min(requestedEnd, info.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
      throw new AppError('RANGE_NOT_SATISFIABLE', 'HTTP Range recording berada di luar ukuran file', 416);
    }
    headers['content-length'] = String(end - start + 1);
    headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
    return {
      status: 206,
      headers,
      stream: createReadStream(fullPath, { start, end })
    };
  }
  headers['content-length'] = String(info.size);
  return {
    status: 200,
    headers,
    stream: createReadStream(fullPath)
  };
}

// Satu scan dan satu cleanup dalam satu waktu: setInterval tidak menunggu callback
// async, sehingga putaran yang lebih lama dari intervalnya akan saling tumpang tindih.
function runRecordingScan(): Promise<void> {
  scanInFlight ??= reconcileRecordingFiles()
    .then(() => undefined, (error: Error) => console.error(`[recording] Scanner gagal: ${error.message}`))
    .finally(() => { scanInFlight = undefined; });
  return scanInFlight;
}

function runRecordingCleanup(): Promise<void> {
  cleanupInFlight ??= cleanupRecordings()
    .then(() => undefined, (error: Error) => console.error(`[recording] Cleanup gagal: ${error.message}`))
    .finally(() => { cleanupInFlight = undefined; });
  return cleanupInFlight;
}

async function runInitialRecordingPass(): Promise<void> {
  try {
    const settings = await getMediaMtxSettings();
    await clearPlaybackCache(resolveProjectPath(settings.recordingPath));
  } catch (error) {
    console.error(`[recording] Gagal membersihkan playback cache: ${(error as Error).message}`);
  }
  // Cleanup lebih dulu agar storage guard dievaluasi segera setelah boot.
  await runRecordingCleanup();
  await runRecordingScan();
}

export async function startRecordingManager(): Promise<void> {
  if (managerRunning) return;
  managerRunning = true;
  // Timer dibuat sebelum pass awal: kegagalan scan atau cleanup pertama tidak boleh
  // mematikan retention dan storage guard sampai proses di-restart.
  scanTimer = setInterval(() => { void runRecordingScan(); }, 30_000);
  cleanupTimer = setInterval(() => { void runRecordingCleanup(); }, 60_000);
  scanTimer.unref();
  cleanupTimer.unref();
  // Pass awal berjalan di background agar boot recovery route tidak menunggu scan storage.
  initialRecordingPass = runInitialRecordingPass();
}

/** Menunggu pass awal serta scan/cleanup yang sedang berjalan selesai. */
export async function recordingManagerIdle(): Promise<void> {
  await initialRecordingPass;
  await scanInFlight;
  await cleanupInFlight;
}

export function recordingScannerStateForTests(): { stableFiles: number; indexFailures: number; deleteRetries: number } {
  return { stableFiles: stableFiles.size, indexFailures: indexFailures.size, deleteRetries: deleteRetryAt.size };
}

export function stopRecordingManager(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  scanTimer = undefined;
  cleanupTimer = undefined;
  for (const timer of playbackCacheTimers.values()) clearTimeout(timer);
  playbackCacheTimers.clear();
  stableFiles.clear();
  indexFailures.clear();
  deleteRetryAt.clear();
  playbackPassthrough.clear();
  managerRunning = false;
}

export async function removeRecording(id: string): Promise<void> {
  const row = await prisma.recordingSegment.findUnique({ where: { id } });
  if (!row) throw new AppError('RECORDING_NOT_FOUND', 'Recording tidak ditemukan', 404);
  if (row.protected) throw new AppError('RECORDING_PROTECTED', 'Lepaskan proteksi sebelum menghapus recording', 409);
  if (row.status === 'RECORDING') throw new AppError('RECORDING_ACTIVE', 'Recording yang masih berjalan tidak dapat dihapus', 409);
  await deleteSegment(id, 'manual_delete');
}

export async function recordingArchiveEntries(ids: string[]): Promise<Array<{
  id: string;
  fullPath: string;
  archiveName: string;
}>> {
  const rows = await prisma.recordingSegment.findMany({
    where: { id: { in: ids }, status: 'COMPLETE' }
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const entries: Array<{ id: string; fullPath: string; archiveName: string }> = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const root = path.resolve(row.storageRoot);
    const fullPath = path.resolve(root, row.relativePath);
    if (!fullPath.startsWith(`${root}${path.sep}`)) continue;
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) continue;
    const timestamp = row.startTime.toISOString().replaceAll(':', '-');
    entries.push({
      id,
      fullPath,
      archiveName: `${row.cameraKey}-${timestamp}-${row.id.slice(0, 8)}.mp4`
    });
  }
  return entries;
}
