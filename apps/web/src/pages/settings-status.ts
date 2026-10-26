import { api } from '../api/client';

export interface HealthReport {
  ok: boolean;
  timestamp: string;
  database: { ok: boolean; error?: string };
  ffmpeg: { ok: boolean; version?: string; error?: string };
  mediaMtx: { ok: boolean; enabled: boolean; version?: string; paths?: number; activeRoutes?: number; error?: string };
  workers: { ok: boolean; active: number };
  process: { uptimeSeconds: number; memory: Record<string, number> };
}

const FULL_HEALTH_SECTIONS = ['database', 'ffmpeg', 'mediaMtx', 'workers', 'process'] as const;

/** /api/health hanya mengirim laporan lengkap untuk sesi admin/operator; selain itu cuma {ok, timestamp}. */
export function isFullHealthReport(value: unknown): value is HealthReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  return FULL_HEALTH_SECTIONS.every((key) => typeof report[key] === 'object' && report[key] !== null);
}

/**
 * Ringkasan health berarti API tidak mengenali sesi admin/operator (sesi kedaluwarsa, dicabut,
 * atau lookup credential gagal). /api/health tetap 200 untuk monitoring, jadi sesi diperiksa lewat
 * endpoint khusus admin: 401 UNAUTHORIZED di sana membawa App kembali ke halaman login.
 */
export async function fetchFullHealthReport(): Promise<HealthReport> {
  const report = await api<unknown>('/api/health');
  if (isFullHealthReport(report)) return report;
  await api('/api/settings');
  throw new Error('laporan lengkap tidak tersedia untuk sesi ini. Coba periksa lagi beberapa saat.');
}

export interface MediaApplyResult {
  failedRouteIds?: unknown;
}

/** Apply MediaMTX tetap sukses walau sebagian route aktif gagal dipasang ulang; tampilkan sebagai peringatan. */
export function mediaApplyWarning(result: MediaApplyResult | null | undefined, routeNames: ReadonlyMap<string, string>): string {
  const ids: unknown = result?.failedRouteIds;
  const failed = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (!failed.length) return '';
  const names = failed.map((id) => routeNames.get(id) ?? id).join(', ');
  return `Konfigurasi MediaMTX diterapkan, tetapi ${failed.length} route aktif gagal dipasang ulang: ${names}. `
    + 'Monitor media mencoba memulihkannya otomatis; periksa log route atau Terminal bila kamera tetap tidak tampil.';
}

export interface BrokerEndpoint {
  protocol: string;
  host: string;
  port: number;
}

/** API menolak perubahan protocol/host/port broker berpassword tanpa password diketik ulang. */
export function brokerPasswordRequired(
  editing: (BrokerEndpoint & { passwordConfigured: boolean }) | null,
  form: BrokerEndpoint
): boolean {
  if (!editing?.passwordConfigured) return false;
  return form.protocol !== editing.protocol
    || form.host.trim() !== editing.host
    || Number(form.port) !== editing.port;
}
