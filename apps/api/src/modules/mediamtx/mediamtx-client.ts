import { AppError } from '../../shared/errors.js';
import type { MediaMtxSettings } from '../settings/settings-service.js';

export interface MediaMtxPathConfig {
  source?: string;
  sourceOnDemand?: boolean;
  rtspTransport?: 'tcp' | 'udp' | 'automatic';
  record?: boolean;
  recordPath?: string;
  recordFormat?: 'fmp4';
  recordPartDuration?: string;
  recordMaxPartSize?: string;
  recordSegmentDuration?: string;
  recordDeleteAfter?: string;
  runOnRecordSegmentCreate?: string;
  runOnRecordSegmentComplete?: string;
  runOnReady?: string;
  runOnReadyRestart?: boolean;
}

async function request(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
  allowNotFound = false
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
    });
  } catch (error) {
    throw new AppError('MEDIAMTX_UNAVAILABLE', `MediaMTX Control API tidak tersedia: ${(error as Error).message}`, 503);
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new AppError('MEDIAMTX_API_ERROR', `MediaMTX API ${response.status}: ${detail || response.statusText}`, 502);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

function pathEndpoint(operation: string, pathName: string): string {
  return `/v3/config/paths/${operation}/${encodeURIComponent(pathName)}`;
}

// Cek satu path lewat /get (404 = belum ada) agar upsert/delete tidak mengunduh seluruh daftar path.
async function pathConfigurationExists(settings: MediaMtxSettings, pathName: string): Promise<boolean> {
  return await getMediaMtxPathConfig(settings, pathName) !== null;
}

export async function listMediaMtxPathConfigNames(settings: MediaMtxSettings): Promise<string[]> {
  const result = await request(settings.apiUrl, '/v3/config/paths/list?itemsPerPage=10000') as {
    items?: Array<{ name?: string }>;
  } | null;
  return (result?.items ?? []).flatMap((item) => item.name ? [item.name] : []);
}

export async function mediaMtxHealth(settings: MediaMtxSettings): Promise<{ ok: boolean; error?: string; paths?: number }> {
  try {
    const result = await request(settings.apiUrl, '/v3/paths/list') as { itemCount?: number; items?: unknown[] };
    return { ok: true, paths: result.itemCount ?? result.items?.length ?? 0 };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function upsertMediaMtxPath(
  settings: MediaMtxSettings,
  pathName: string,
  config: MediaMtxPathConfig
): Promise<void> {
  const existing = await pathConfigurationExists(settings, pathName);
  const operation = existing ? 'patch' : 'add';
  await request(settings.apiUrl, pathEndpoint(operation, pathName), {
    method: operation === 'add' ? 'POST' : 'PATCH',
    body: JSON.stringify(config)
  });
}

export async function patchMediaMtxPath(
  settings: MediaMtxSettings,
  pathName: string,
  config: MediaMtxPathConfig
): Promise<void> {
  await request(settings.apiUrl, pathEndpoint('patch', pathName), {
    method: 'PATCH',
    body: JSON.stringify(config)
  });
}

export async function deleteMediaMtxPath(settings: MediaMtxSettings, pathName: string): Promise<void> {
  const existing = await pathConfigurationExists(settings, pathName);
  if (!existing) return;
  await request(settings.apiUrl, pathEndpoint('delete', pathName), { method: 'DELETE' });
}

export async function getMediaMtxPathConfig(
  settings: MediaMtxSettings,
  pathName: string
): Promise<MediaMtxPathConfig | null> {
  return request(settings.apiUrl, pathEndpoint('get', pathName), {}, true) as Promise<MediaMtxPathConfig | null>;
}

export async function getMediaMtxPathState(
  settings: MediaMtxSettings,
  pathName: string
): Promise<{ ready: boolean; tracks: string[]; bytesReceived: number }> {
  const encoded = encodeURIComponent(pathName);
  const result = await request(settings.apiUrl, `/v3/paths/get/${encoded}`, {}, true) as {
    ready?: boolean;
    tracks?: string[];
    bytesReceived?: number;
  } | null;
  return {
    ready: Boolean(result?.ready),
    tracks: result?.tracks ?? [],
    bytesReceived: result?.bytesReceived ?? 0
  };
}

export async function patchMediaMtxGlobal(
  settings: MediaMtxSettings,
  config: Record<string, unknown>
): Promise<void> {
  await request(settings.apiUrl, '/v3/config/global/patch', {
    method: 'PATCH',
    body: JSON.stringify(config)
  });
}
