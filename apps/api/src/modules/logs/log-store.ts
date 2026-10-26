import { appendFile, mkdir, open, readdir, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from '@stream-router/ffmpeg';
import { getEnv } from '../../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Lokasi data tidak bergantung pada cwd npm/PM2, sehingga sama di macOS dan Linux.
const logDir = path.resolve(__dirname, '../../../../../data/logs');

const ROUTE_LOG_MAX_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
// Pembacaan hanya memindai ujung file. mediamtx.log production dapat tumbuh tanpa batas, dan
// memuat seluruh isinya setiap polling Terminal membuat RSS melonjak melewati batas PM2.
const READ_MAX_BYTES = 16 * 1024 * 1024;
const FAILURE_REPORT_INTERVAL_MS = 60_000;

function fileFor(routeId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(routeId)) throw new Error('Route ID invalid');
  return path.join(logDir, `${routeId}.log`);
}

export type LogComponent = 'FFMPEG_ONLINE' | 'MEDIAMTX' | 'RECORDING' | 'SYSTEM';

interface PendingBatch {
  lines: string[];
  written: Promise<void>;
  resolve: () => void;
}

interface RouteLogWriter {
  size: number | null;
  pending: PendingBatch | null;
  draining: boolean;
}

const writers = new Map<string, RouteLogWriter>();
let logDirReady: Promise<void> | null = null;
let lastFailureReport = 0;
let suppressedFailures = 0;

function ensureLogDir(): Promise<void> {
  logDirReady ??= mkdir(logDir, { recursive: true }).then(() => undefined, (error: unknown) => {
    logDirReady = null;
    throw error;
  });
  return logDirReady;
}

function reportLogFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastFailureReport < FAILURE_REPORT_INTERVAL_MS) {
    suppressedFailures += 1;
    return;
  }
  const suppressed = suppressedFailures;
  lastFailureReport = now;
  suppressedFailures = 0;
  const message = redactText(error instanceof Error ? error.message : String(error));
  console.error(`[logs] Gagal menulis log route: ${message}${suppressed ? ` (${suppressed} kegagalan lain tidak ditampilkan)` : ''}`);
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset;
}

/** Baca maksimal `maxLines` baris terakhir yang lolos `accept`, memindai mundur dari akhir file. */
export async function readLastLines(
  file: string,
  maxLines: number,
  accept: (line: string) => boolean = () => true,
  maxBytes = READ_MAX_BYTES
): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const floor = Math.max(0, size - maxBytes);
    const newestFirst: string[] = [];
    const take = (bytes: Buffer): boolean => {
      const line = bytes.toString('utf8').replace(/\r$/, '');
      if (line && accept(line)) newestFirst.push(line);
      return newestFirst.length >= maxLines;
    };
    let position = size;
    let carry = Buffer.alloc(0);
    while (position > floor) {
      const length = Math.min(READ_CHUNK_BYTES, position - floor);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = await readFully(handle, chunk, position);
      const buffer = carry.length ? Buffer.concat([chunk.subarray(0, read), carry]) : chunk.subarray(0, read);
      let end = buffer.length;
      for (let index = end - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) continue;
        if (take(buffer.subarray(index + 1, end))) return newestFirst.reverse();
        end = index;
      }
      carry = buffer.subarray(0, end);
    }
    // Sisa di awal file adalah baris utuh. Bila pemindaian berhenti di batas byte, sisa itu
    // hanya potongan baris dan dibuang.
    if (position === 0 && carry.length) take(carry);
    return newestFirst.reverse();
  } finally {
    await handle.close();
  }
}

// Rotasi berjalan di antrean tulis file yang sama, jadi baris yang masuk selama rotasi tidak
// tertimpa. File ditulis ke file sementara lalu di-rename agar tidak pernah terpotong di tengah.
async function rotateRouteLog(file: string): Promise<number> {
  const actual = (await stat(file)).size;
  if (actual <= ROUTE_LOG_MAX_BYTES) return actual;
  const kept = await readLastLines(file, getEnv().MAX_LOG_LINES_PER_ROUTE);
  const content = kept.length ? `${kept.join('\n')}\n` : '';
  const temporary = `${file}.rotate.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, file);
  return Buffer.byteLength(content);
}

async function writeBatch(file: string, writer: RouteLogWriter, lines: string[]): Promise<void> {
  const chunk = `${lines.join('\n')}\n`;
  await ensureLogDir();
  try {
    await appendFile(file, chunk, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Folder log dihapus saat aplikasi berjalan.
    logDirReady = null;
    await ensureLogDir();
    await appendFile(file, chunk, 'utf8');
  }
  writer.size = writer.size === null ? (await stat(file)).size : writer.size + Buffer.byteLength(chunk);
  if (writer.size > ROUTE_LOG_MAX_BYTES) writer.size = await rotateRouteLog(file);
}

async function drain(file: string, writer: RouteLogWriter): Promise<void> {
  writer.draining = true;
  try {
    while (writer.pending) {
      const batch = writer.pending;
      writer.pending = null;
      try {
        await writeBatch(file, writer, batch.lines);
      } catch (error) {
        writer.size = null;
        reportLogFailure(error);
      }
      batch.resolve();
    }
  } finally {
    writer.draining = false;
  }
}

/**
 * Tambahkan satu baris ke log route. Penulisan per file diserialkan dan baris yang masuk saat
 * penulisan sebelumnya berjalan digabung ke satu append. Promise tidak pernah reject: disk penuh
 * atau folder read-only hanya dilaporkan, karena banyak pemanggil (handler stdout/stderr FFmpeg)
 * memanggilnya tanpa await dan rejection akan menghentikan seluruh proses API.
 */
export function appendRouteLog(
  routeId: string,
  level: string,
  message: string,
  component: LogComponent = 'SYSTEM'
): Promise<void> {
  let file: string;
  try {
    file = fileFor(routeId);
  } catch (error) {
    reportLogFailure(error);
    return Promise.resolve();
  }
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, component, message: redactText(message) });
  let writer = writers.get(file);
  if (!writer) {
    writer = { size: null, pending: null, draining: false };
    writers.set(file, writer);
  }
  if (!writer.pending) {
    let resolve: () => void = () => undefined;
    const written = new Promise<void>((done) => { resolve = done; });
    writer.pending = { lines: [], written, resolve };
  }
  writer.pending.lines.push(line);
  const { written } = writer.pending;
  if (!writer.draining) void drain(file, writer);
  return written;
}

function lineHasComponent(line: string, component: LogComponent): boolean {
  if (!line.includes(component)) return false;
  try { return (JSON.parse(line) as { component?: string }).component === component; } catch { return false; }
}

export async function readRouteLogs(
  routeId: string,
  offset = 0,
  limit = 200,
  tail = false,
  component?: LogComponent
): Promise<{ items: unknown[]; total: number }> {
  try {
    // Filter komponen diterapkan sebelum batas jumlah baris, sehingga event SYSTEM/RECORDING lama
    // tidak tergeser oleh output FFmpeg.
    const bounded = await readLastLines(
      fileFor(routeId),
      getEnv().MAX_LOG_LINES_PER_ROUTE,
      component ? (line) => lineHasComponent(line, component) : undefined
    );
    const safeLimit = Math.min(1000, Math.max(1, limit));
    const start = tail ? Math.max(0, bounded.length - safeLimit) : Math.max(0, offset);
    const items = bounded.slice(start, start + safeLimit).map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return { message: line }; }
    });
    return { items, total: bounded.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], total: 0 };
    throw error;
  }
}

export async function readMediaMtxLogs(limit = 500): Promise<{ items: unknown[]; total: number }> {
  const safeLimit = Math.min(1000, Math.max(1, limit));
  try {
    const lines = await readLastLines(path.join(logDir, 'mediamtx.log'), getEnv().MAX_LOG_LINES_PER_ROUTE);
    return {
      items: lines.slice(-safeLimit).map((line) => {
        try { return JSON.parse(line) as unknown; } catch {
          return { timestamp: null, level: 'info', component: 'MEDIAMTX', message: redactText(line) };
        }
      }),
      total: lines.length
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], total: 0 };
    throw error;
  }
}

function ignoreMissingFile(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}

export async function cleanupOldLogs(retentionDays: number): Promise<void> {
  await ensureLogDir();
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const name of await readdir(logDir)) {
    if (!name.endsWith('.log')) continue;
    if (name === 'mediamtx.log') continue;
    const full = path.join(logDir, name);
    // File dapat hilang di antara readdir, stat, dan unlink; itu bukan kegagalan cleanup.
    const info = await stat(full).catch(ignoreMissingFile);
    if (!info || info.mtimeMs >= cutoff) continue;
    await unlink(full).catch(ignoreMissingFile);
    const writer = writers.get(full);
    if (writer) writer.size = null;
  }
}
