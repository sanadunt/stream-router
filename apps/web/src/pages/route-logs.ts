export interface LogLine {
  timestamp?: string;
  level?: string;
  message?: string;
  component?: 'FFMPEG_ONLINE' | 'MEDIAMTX' | 'RECORDING' | 'SYSTEM';
}

/** URL log route yang selalu mengambil baris terbaru (tail), bukan baris tertua. */
export function routeLogsPath(routeId: string, limit: number, component = ''): string {
  const query = new URLSearchParams({ tail: 'true', limit: String(limit) });
  if (component) query.set('component', component);
  return `/api/routes/${encodeURIComponent(routeId)}/logs?${query.toString()}`;
}

/**
 * Key React yang stabil per baris log. Key berbasis indeks berubah setiap kali
 * jendela tail bergeser sehingga seluruh baris di-remount dan seleksi teks hilang.
 * Baris identik diberi nomor kemunculan agar key tetap unik.
 */
export function keyLogLines<T extends LogLine>(lines: T[]): Array<{ key: string; line: T }> {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.timestamp ?? ''}|${line.component ?? ''}|${line.level ?? ''}|${line.message ?? ''}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: occurrence ? `${base}#${occurrence}` : base, line };
  });
}
