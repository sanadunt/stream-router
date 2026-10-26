import { spawn, type ChildProcess } from 'node:child_process';
import { redactText } from '@stream-router/ffmpeg';
import { prisma } from '../../db/client.js';
import { getFfmpegPath } from '../settings/settings-service.js';
import { workerManager } from '../workers/worker-manager.js';
import { mediaMtxRuntimeHealth } from '../mediamtx/mediamtx-runtime.js';

interface FfmpegCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

// Settings memanggil /api/health tiap 10 detik dan endpoint ini juga dipakai monitoring, jadi hasil
// `ffmpeg -version` di-cache per path binary agar tidak ada spawn baru di setiap request.
const FFMPEG_CHECK_OK_TTL_MS = 60_000;
const FFMPEG_CHECK_FAILED_TTL_MS = 10_000;
const FFMPEG_CHECK_TIMEOUT_MS = 5_000;
let ffmpegCheckCache: { path: string; expiresAt: number; result: Promise<FfmpegCheck> } | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runFfmpegCheck(ffmpegPath: string, timeoutMs: number): Promise<FfmpegCheck> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(ffmpegPath, ['-version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ ok: false, error: errorMessage(error) });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `FFmpeg tidak merespons dalam ${Math.ceil(timeoutMs / 1000)} detik` });
    }, timeoutMs);
    const finish = (result: FfmpegCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < 4096) stdout += data.toString('utf8');
    });
    child.once('error', (error) => finish({ ok: false, error: error.message }));
    child.once('close', (code) => finish(code === 0
      ? { ok: true, version: stdout.split('\n')[0] ?? 'ffmpeg' }
      : { ok: false, error: `exit ${String(code)}` }));
  });
}

export function checkFfmpeg(ffmpegPath: string, timeoutMs = FFMPEG_CHECK_TIMEOUT_MS): Promise<FfmpegCheck> {
  if (ffmpegCheckCache && ffmpegCheckCache.path === ffmpegPath && ffmpegCheckCache.expiresAt > Date.now()) {
    return ffmpegCheckCache.result;
  }
  // expiresAt tak hingga selama pemeriksaan berjalan, sehingga request paralel memakai proses yang sama.
  const entry = { path: ffmpegPath, expiresAt: Number.POSITIVE_INFINITY, result: runFfmpegCheck(ffmpegPath, timeoutMs) };
  ffmpegCheckCache = entry;
  void entry.result.then((result) => {
    entry.expiresAt = Date.now() + (result.ok ? FFMPEG_CHECK_OK_TTL_MS : FFMPEG_CHECK_FAILED_TTL_MS);
  });
  return entry.result;
}

export async function healthReport(): Promise<Record<string, unknown> & { ok: boolean; timestamp: string }> {
  let database = { ok: true, error: undefined as string | undefined };
  try { await prisma.$queryRaw`SELECT 1`; } catch (error) { database = { ok: false, error: errorMessage(error) }; }
  // Setiap pemeriksaan berdiri sendiri: database yang mati harus menghasilkan laporan 503,
  // bukan error 500 dari pemeriksaan berikutnya.
  const ffmpeg = await getFfmpegPath()
    .then((ffmpegPath) => checkFfmpeg(ffmpegPath))
    .catch((error: unknown): FfmpegCheck => ({ ok: false, error: errorMessage(error) }));
  const mediaMtx = await mediaMtxRuntimeHealth()
    .catch((error: unknown): Record<string, unknown> => ({ enabled: true, ok: false, error: errorMessage(error) }));
  return {
    ok: database.ok && ffmpeg.ok && (mediaMtx.enabled === false || mediaMtx.ok === true),
    timestamp: new Date().toISOString(),
    database,
    ffmpeg,
    mediaMtx,
    workers: { ok: true, active: workerManager.allSnapshots().length },
    process: { uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage() }
  };
}

type HealthReport = Awaited<ReturnType<typeof healthReport>>;

function failed(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

/**
 * Nama pemeriksaan yang membuat laporan tidak siap, tanpa versi, path, atau teks error. Aman
 * dikirim ke pemanggil anonim (installer, curl di host) agar penyebab 503 tetap terbaca.
 */
export function failingChecks(report: HealthReport): string[] {
  const names: string[] = [];
  if (failed(report.database)) names.push('database');
  if (failed(report.ffmpeg)) names.push('ffmpeg');
  const mediaMtx = report.mediaMtx as Record<string, unknown> | undefined;
  if (mediaMtx && mediaMtx.enabled !== false && mediaMtx.ok !== true) {
    const storage = mediaMtx.recordingStorage as { ok?: unknown; paused?: unknown } | undefined;
    const before = names.length;
    if (failed(mediaMtx.controlApi)) names.push('mediaMtx.controlApi');
    if (storage && (storage.ok === false || storage.paused === true)) names.push('mediaMtx.recordingStorage');
    if (names.length === before) names.push('mediaMtx');
  }
  return names;
}

function errorText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : undefined;
}

/** Ringkasan untuk log server: nama pemeriksaan beserta teks error yang sudah diredaksi. */
export function readinessFailureSummary(report: HealthReport): Record<string, string> {
  const mediaMtx = report.mediaMtx as Record<string, unknown> | undefined;
  const sources: Record<string, unknown> = {
    database: report.database,
    ffmpeg: report.ffmpeg,
    mediaMtx,
    'mediaMtx.controlApi': mediaMtx?.controlApi,
    'mediaMtx.recordingStorage': mediaMtx?.recordingStorage
  };
  const summary: Record<string, string> = {};
  for (const name of failingChecks(report)) {
    const storage = name === 'mediaMtx.recordingStorage' ? mediaMtx?.recordingStorage as { paused?: unknown } | undefined : undefined;
    const fallback = storage?.paused === true ? 'Recording dipause karena ruang kosong berada di bawah batas aman' : 'tidak sehat';
    summary[name] = redactText(errorText(sources[name]) ?? fallback);
  }
  return summary;
}
