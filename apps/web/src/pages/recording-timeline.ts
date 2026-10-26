import type { RecordingSegment } from '../types';

export interface TimelineBlock {
  item: RecordingSegment;
  startSeconds: number;
  endSeconds: number;
  startLabel: string;
  endLabel: string;
}

export interface TimelineGroup {
  cameraName: string;
  cameraKey: string;
  blocks: TimelineBlock[];
}

/**
 * Formatter jam dibuat sekali per timeZone. Membuat Intl.DateTimeFormat baru per
 * segment membuat render timeline ratusan milidetik pada puluhan kamera.
 */
export function createTimelineClock(timeZone: string) {
  const labelFormat = new Intl.DateTimeFormat('id-ID', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const partsFormat = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });
  return {
    label(value: string): string {
      return labelFormat.format(new Date(value));
    },
    seconds(value: string): number {
      const map = Object.fromEntries(partsFormat.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
      return Number(map.hour ?? 0) * 3600 + Number(map.minute ?? 0) * 60 + Number(map.second ?? 0);
    }
  };
}

export function buildTimelineGroups(items: RecordingSegment[], timeZone: string): TimelineGroup[] {
  const clock = createTimelineClock(timeZone);
  const groups = new Map<string, TimelineGroup>();
  for (const item of items) {
    const startSeconds = clock.seconds(item.startTime);
    const group = groups.get(item.cameraKey) ?? { cameraName: item.cameraName, cameraKey: item.cameraKey, blocks: [] };
    group.blocks.push({
      item,
      startSeconds,
      endSeconds: Math.min(86_400, startSeconds + item.durationMs / 1000),
      startLabel: clock.label(item.startTime),
      endLabel: clock.label(item.endTime)
    });
    groups.set(item.cameraKey, group);
  }
  return [...groups.values()];
}
