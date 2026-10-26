import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import type { WebrtcStream } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type {
  CreateWebrtcStreamInput,
  StreamViewMode,
  StreamViewSourceType,
  UpdateWebrtcStreamInput
} from '@stream-router/contracts';
import { redactUrl } from '@stream-router/ffmpeg';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { decryptString, encryptString } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { parseStreamViewUrl } from '../../shared/url-policy.js';
import { ptzSummary } from '../ptz/ptz-service.js';
import { audit } from '../routes/route-service.js';

export function allowInsecureStreamView(nodeEnv: string, configured: boolean): boolean {
  return nodeEnv !== 'production' || configured;
}

function streamViewPolicy() {
  const env = getEnv();
  const configuredOrigins = env.STREAM_VIEW_ALLOWED_ORIGINS || env.WEBRTC_ALLOWED_ORIGINS;
  return {
    allowedOrigins: configuredOrigins.split(',').map((origin) => origin.trim()).filter(Boolean),
    allowInsecure: allowInsecureStreamView(env.NODE_ENV, env.STREAM_VIEW_ALLOW_INSECURE_HTTP)
  };
}

function validateUrl(url: string, mode: StreamViewMode): ReturnType<typeof parseStreamViewUrl> {
  try {
    return parseStreamViewUrl(url, mode, streamViewPolicy());
  } catch (error) {
    throw new AppError('STREAM_VIEW_URL_INVALID', (error as Error).message, 400);
  }
}

function decryptedUrl(row: WebrtcStream): string {
  return decryptString(row.urlEncrypted, getEnv().APP_ENCRYPTION_KEY);
}

function isLocalFileSource(value: string): boolean {
  return value.startsWith('file:');
}

function sourceType(row: WebrtcStream): StreamViewSourceType {
  return isLocalFileSource(decryptedUrl(row)) ? 'FILE' : 'URL';
}

async function canonicalMp4File(value: string): Promise<string> {
  let requested: string;
  try {
    requested = value.startsWith('file:') ? fileURLToPath(value) : value;
  } catch {
    throw new AppError('STREAM_FILE_PATH_INVALID', 'Path file MP4 tidak valid', 400);
  }
  if (!path.isAbsolute(requested)) {
    throw new AppError('STREAM_FILE_PATH_ABSOLUTE', 'Path file MP4 harus absolute pada server', 400);
  }
  let canonical: string;
  try {
    canonical = await realpath(requested);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error('not-file');
    await access(canonical, constants.R_OK);
  } catch {
    throw new AppError('STREAM_FILE_NOT_READABLE', 'File MP4 tidak ditemukan atau tidak dapat dibaca oleh proses Node', 400);
  }
  if (path.extname(canonical).toLowerCase() !== '.mp4') {
    throw new AppError('STREAM_FILE_NOT_MP4', 'File server harus memiliki ekstensi .mp4', 400);
  }
  return canonical;
}

async function normalizeSource(
  value: string,
  mode: StreamViewMode,
  type: StreamViewSourceType
): Promise<string> {
  if (type === 'FILE') {
    if (mode !== 'MP4') {
      throw new AppError('STREAM_FILE_MODE_INVALID', 'Sumber File Server hanya tersedia untuk tipe MP4', 400);
    }
    return pathToFileURL(await canonicalMp4File(value)).toString();
  }
  return validateUrl(value, mode).sourceUrl;
}

export function toWebrtcStreamDto(row: WebrtcStream): Record<string, unknown> {
  const storedSource = decryptedUrl(row);
  const localFile = isLocalFileSource(storedSource);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    urlMasked: localFile ? `File server · ${path.basename(fileURLToPath(storedSource))}` : redactUrl(storedSource),
    mode: row.mode,
    sourceType: localFile ? 'FILE' : 'URL',
    enabled: row.enabled,
    ptz: ptzSummary(row, 'WEBRTC_STREAM', row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function toWebrtcStreamEditDto(row: WebrtcStream): Record<string, unknown> {
  const storedSource = decryptedUrl(row);
  return {
    ...toWebrtcStreamDto(row),
    url: isLocalFileSource(storedSource) ? fileURLToPath(storedSource) : storedSource
  };
}

export function toStandaloneViewerDto(row: WebrtcStream): Record<string, unknown> {
  const sourceUrl = decryptedUrl(row);
  const mode = row.mode as StreamViewMode;
  const localFile = isLocalFileSource(sourceUrl);
  const parsed = localFile ? null : validateUrl(sourceUrl, mode);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    webrtc: localFile
      ? { url: `/api/viewer/stream-files/${row.id}`, openUrl: `/api/viewer/stream-files/${row.id}`, mode }
      : { url: parsed!.viewerUrl, openUrl: parsed!.sourceUrl, mode },
    ptz: ptzSummary(row, 'WEBRTC_STREAM', row.id, true)
  };
}

/**
 * Viewer list for standalone Stream Views. Each stored URL is re-validated
 * against the current policy, so a row saved under a looser policy (dev mode,
 * before an origin allowlist) is skipped instead of failing the whole Viewer.
 */
export async function listStandaloneViewerItems(
  log: Pick<FastifyBaseLogger, 'warn'>
): Promise<Array<Record<string, unknown>>> {
  return (await listEnabledWebrtcStreams()).flatMap((row) => {
    try {
      return [toStandaloneViewerDto(row)];
    } catch (error) {
      // Jangan log URL: bisa memuat token.
      log.warn({
        streamId: row.id,
        code: error instanceof AppError ? error.code : 'STREAM_VIEW_UNAVAILABLE',
        reason: error instanceof AppError ? error.message : undefined
      }, 'Stream View dilewati dari Viewer karena sumber tersimpan tidak lolos validasi saat ini');
      return [];
    }
  });
}

export async function listWebrtcStreams(): Promise<WebrtcStream[]> {
  return prisma.webrtcStream.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function listEnabledWebrtcStreams(): Promise<WebrtcStream[]> {
  return prisma.webrtcStream.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } });
}

export async function getWebrtcStream(id: string): Promise<WebrtcStream> {
  const row = await prisma.webrtcStream.findUnique({ where: { id } });
  if (!row) throw new AppError('WEBRTC_STREAM_NOT_FOUND', 'Stream View tidak ditemukan', 404);
  return row;
}

export async function createWebrtcStream(input: CreateWebrtcStreamInput): Promise<WebrtcStream> {
  const normalizedSource = await normalizeSource(input.url, input.mode, input.sourceType);
  const row = await prisma.webrtcStream.create({
    data: {
      name: input.name,
      description: input.description,
      urlEncrypted: encryptString(normalizedSource, getEnv().APP_ENCRYPTION_KEY),
      mode: input.mode,
      enabled: input.enabled
    }
  });
  await audit('WEBRTC_STREAM_CREATE', null, { streamId: row.id, name: row.name });
  return row;
}

export async function updateWebrtcStream(id: string, input: UpdateWebrtcStreamInput): Promise<WebrtcStream> {
  const current = await getWebrtcStream(id);
  const sourceChanged = input.url !== undefined || input.mode !== undefined || input.sourceType !== undefined;
  const normalizedSource = sourceChanged
    ? await normalizeSource(
      input.url ?? decryptedUrl(current),
      input.mode ?? current.mode as StreamViewMode,
      input.sourceType ?? sourceType(current)
    )
    : undefined;
  const row = await prisma.webrtcStream.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(normalizedSource !== undefined
        ? { urlEncrypted: encryptString(normalizedSource, getEnv().APP_ENCRYPTION_KEY) }
        : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {})
    }
  });
  await audit('WEBRTC_STREAM_UPDATE', null, { streamId: row.id, changed: Object.keys(input) });
  return row;
}

export async function deleteWebrtcStream(id: string): Promise<void> {
  const row = await getWebrtcStream(id);
  await prisma.webrtcStream.delete({ where: { id } });
  await audit('WEBRTC_STREAM_DELETE', null, { streamId: row.id, name: row.name });
}

export async function listMp4Files(input?: string): Promise<Record<string, unknown>> {
  let requested = input?.trim() || path.parse(process.cwd()).root;
  if (requested.startsWith('file:')) requested = fileURLToPath(requested);
  let current: string;
  try {
    const canonical = await realpath(requested);
    const info = await stat(canonical);
    current = info.isDirectory() ? canonical : path.dirname(canonical);
  } catch {
    throw new AppError('STREAM_FILE_DIRECTORY_NOT_FOUND', 'Folder file MP4 tidak ditemukan pada server', 400);
  }
  const entries = await readdir(current, { withFileTypes: true });
  const items = await Promise.all(entries
    .filter((entry) => entry.isDirectory() || (entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4'))
    .map(async (entry) => {
      const target = path.join(current, entry.name);
      return {
        name: entry.name,
        path: target,
        type: entry.isDirectory() ? 'DIRECTORY' : 'FILE',
        ...(entry.isFile() ? { sizeBytes: (await stat(target)).size } : {})
      };
    }));
  items.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'DIRECTORY' ? -1 : 1;
    return left.name.localeCompare(right.name, 'id-ID', { sensitivity: 'base' });
  });
  const root = path.parse(current).root;
  return { current, parent: current === root ? null : path.dirname(current), entries: items };
}

interface LocalMp4Plan {
  status: number;
  headers: Record<string, string>;
  fullPath: string;
  byteRange?: { start: number; end: number };
}

async function planLocalMp4(id: string, range: string | undefined): Promise<LocalMp4Plan> {
  const row = await getWebrtcStream(id);
  if (!row.enabled || row.mode !== 'MP4') {
    throw new AppError('STREAM_FILE_NOT_AVAILABLE', 'File MP4 tidak tersedia di Viewer', 404);
  }
  const storedSource = decryptedUrl(row);
  if (!isLocalFileSource(storedSource)) {
    throw new AppError('STREAM_FILE_NOT_LOCAL', 'Stream MP4 ini menggunakan URL langsung', 409);
  }
  const fullPath = await canonicalMp4File(storedSource);
  const info = await stat(fullPath);
  const headers: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    etag: `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
    'last-modified': info.mtime.toUTCString()
  };
  if (!range) {
    headers['content-length'] = String(info.size);
    return { status: 200, headers, fullPath };
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'HTTP Range MP4 tidak valid', 416);
  }
  const suffixLength = match[1] ? null : Number(match[2]);
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, info.size - suffixLength);
  const requestedEnd = match[2] && suffixLength === null ? Number(match[2]) : info.size - 1;
  const end = Math.min(requestedEnd, info.size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
    throw new AppError('RANGE_NOT_SATISFIABLE', 'HTTP Range MP4 berada di luar ukuran file', 416);
  }
  headers['content-length'] = String(end - start + 1);
  headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  return { status: 206, headers, fullPath, byteRange: { start, end } };
}

export async function localMp4Response(
  id: string,
  range: string | undefined
): Promise<{ status: number; headers: Record<string, string>; stream: Readable }> {
  const plan = await planLocalMp4(id, range);
  return { status: plan.status, headers: plan.headers, stream: createReadStream(plan.fullPath, plan.byteRange) };
}

/** Same status and headers as GET, without opening the file. */
export async function localMp4Head(
  id: string,
  range: string | undefined
): Promise<{ status: number; headers: Record<string, string> }> {
  const { status, headers } = await planLocalMp4(id, range);
  return { status, headers };
}
