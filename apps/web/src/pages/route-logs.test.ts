import { describe, expect, it } from 'vitest';
import { keyLogLines, routeLogsPath, type LogLine } from './route-logs';

function line(second: number, message = `frame=${second}`): LogLine {
  return { timestamp: `2026-10-24T10:00:${String(second).padStart(2, '0')}.000Z`, level: 'info', component: 'FFMPEG_ONLINE', message };
}

describe('routeLogsPath', () => {
  it('selalu meminta baris terbaru dengan tail=true', () => {
    expect(routeLogsPath('route-1', 300)).toBe('/api/routes/route-1/logs?tail=true&limit=300');
    expect(routeLogsPath('route-1', 500, 'RECORDING')).toBe('/api/routes/route-1/logs?tail=true&limit=500&component=RECORDING');
  });
});

describe('keyLogLines', () => {
  it('mempertahankan key baris yang tetap terlihat saat jendela tail bergeser', () => {
    const before = keyLogLines([line(1), line(2), line(3), line(4)]);
    const after = keyLogLines([line(3), line(4), line(5), line(6)]);
    expect(after.slice(0, 2).map((item) => item.key)).toEqual(before.slice(2).map((item) => item.key));
  });

  it('memberi key unik untuk baris log yang identik', () => {
    const keys = keyLogLines([line(1, 'retry'), line(1, 'retry'), line(1, 'retry')]).map((item) => item.key);
    expect(new Set(keys).size).toBe(3);
  });
});
