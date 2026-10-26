import { describe, expect, it } from 'vitest';
import { buildTimelineGroups } from './recording-timeline';
import type { RecordingSegment } from '../types';

function segment(index: number, cameraKey: string): RecordingSegment {
  const start = Date.UTC(2026, 0, 2, 1, 0, 0) + index * 60_000;
  return {
    id: `${cameraKey}-${index}`,
    routeId: cameraKey,
    cameraKey,
    cameraName: cameraKey.toUpperCase(),
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 30_000).toISOString(),
    durationMs: 30_000,
    sizeBytes: 1024,
    status: 'COMPLETE',
    protected: false,
    errorMessage: null
  } as unknown as RecordingSegment;
}

describe('Recording timeline', () => {
  it('mengelompokkan segment per kamera dan menghitung posisi jam pada timeZone', () => {
    const groups = buildTimelineGroups([segment(0, 'cam-a'), segment(1, 'cam-b'), segment(2, 'cam-a')], 'Asia/Jakarta');
    expect(groups.map((group) => [group.cameraKey, group.blocks.length])).toEqual([['cam-a', 2], ['cam-b', 1]]);
    const first = groups[0]!.blocks[0]!;
    // 01:00:00 UTC = 08:00:00 WIB
    expect(first.startSeconds).toBe(8 * 3600);
    expect(first.endSeconds).toBe(8 * 3600 + 30);
    expect(first.startLabel).toContain('08');
    expect(groups[0]!.blocks[1]!.startSeconds).toBe(8 * 3600 + 120);
  });

  it('membatasi akhir blok pada tengah malam', () => {
    const late = { ...segment(0, 'cam-a'), startTime: '2026-01-02T16:59:00.000Z', durationMs: 3_600_000 } as RecordingSegment;
    const [group] = buildTimelineGroups([late], 'Asia/Jakarta');
    expect(group!.blocks[0]!.endSeconds).toBe(86_400);
  });

  it('membuat formatter jam sekali per render timeline, bukan per segment', () => {
    const Original = Intl.DateTimeFormat;
    let constructed = 0;
    class CountingDateTimeFormat extends Original {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        super(...args);
        constructed += 1;
      }
    }
    Intl.DateTimeFormat = CountingDateTimeFormat as typeof Intl.DateTimeFormat;
    try {
      const items = Array.from({ length: 2400 }, (_, index) => segment(index % 1440, `cam-${index % 100}`));
      const groups = buildTimelineGroups(items, 'Asia/Jakarta');
      expect(groups).toHaveLength(100);
      expect(constructed).toBeLessThanOrEqual(2);
    } finally {
      Intl.DateTimeFormat = Original;
    }
  });
});
