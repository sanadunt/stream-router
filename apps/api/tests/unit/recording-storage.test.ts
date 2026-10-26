import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localDayStart, mediamtxHookToken, recordingDateKey } from '../../src/modules/recordings/recording-routes.js';
import { walkRecordingFiles } from '../../src/modules/recordings/recording-service.js';

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function previousInstantKey(date: Date, timeZone: string): string {
  return recordingDateKey(new Date(date.getTime() - 1), timeZone);
}

describe('batas hari lokal recording', () => {
  it('menghitung awal hari lokal untuk zona tanpa DST', () => {
    expect(localDayStart('2026-10-19', 'Asia/Jakarta').toISOString()).toBe('2026-10-18T17:00:00.000Z');
    expect(localDayStart('2026-10-19', 'UTC').toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(localDayStart('2026-01-01', 'Pacific/Kiritimati').toISOString()).toBe('2025-12-31T10:00:00.000Z');
    expect(localDayStart('2026-01-01', 'Etc/GMT+12').toISOString()).toBe('2026-01-01T12:00:00.000Z');
  });

  it('konsisten dengan recordingDateKey pada pergantian DST dan tengah malam yang dilompati', () => {
    const cases: Array<[string, string]> = [
      ['America/New_York', '2026-03-08'],
      ['America/New_York', '2026-03-09'],
      ['America/New_York', '2026-11-01'],
      ['Europe/Berlin', '2026-03-29'],
      ['Europe/Berlin', '2026-10-25'],
      // Chile memajukan jam dari 00:00 ke 01:00: tengah malam tidak pernah terjadi.
      ['America/Santiago', '2026-09-06'],
      ['America/Santiago', '2026-04-05'],
      ['Australia/Lord_Howe', '2026-10-04'],
      ['Asia/Kolkata', '2026-10-24']
    ];
    for (const [timeZone, date] of cases) {
      const start = localDayStart(date, timeZone);
      expect(recordingDateKey(start, timeZone), `${timeZone} ${date}`).toBe(date);
      expect(previousInstantKey(start, timeZone) < date, `${timeZone} ${date}`).toBe(true);
    }
  });
});

describe('scanner file recording', () => {
  it('menelusuri folder secara iteratif, melewati playback cache dan file non-media', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'stream-router-walk-'));
    temporaryDirectories.push(root);
    const expected: string[] = [];
    let nested = path.join(root, 'cameras', 'deep');
    for (let level = 0; level < 200; level += 1) nested = path.join(nested, `l${level}`);
    await mkdir(nested, { recursive: true });
    expected.push(path.join(nested, 'deep.mp4'));
    for (let camera = 0; camera < 5; camera += 1) {
      const directory = path.join(root, 'cameras', `cam-${camera}`, '2026', '10', '24');
      await mkdir(directory, { recursive: true });
      for (let index = 0; index < 50; index += 1) {
        expected.push(path.join(directory, `2026-10-24_10-${String(index).padStart(2, '0')}-00-000000.mp4`));
      }
      expected.push(path.join(directory, 'part.m4s'));
      await writeFile(path.join(directory, 'catatan.txt'), 'bukan video');
    }
    await mkdir(path.join(root, '.playback-cache'), { recursive: true });
    await writeFile(path.join(root, '.playback-cache', 'cache.mp4'), 'cache');
    await Promise.all(expected.map((file) => writeFile(file, '')));

    const files = await walkRecordingFiles(root);
    expect(files.sort()).toEqual([...expected].sort());
    expect(await walkRecordingFiles(path.join(root, 'tidak-ada'))).toEqual([]);
  });
});

describe('token hook MediaMTX', () => {
  it('diturunkan dari AUTH_SECRET tanpa mengirim secret aslinya', () => {
    const secret = 'unit-auth-secret-0123456789abcdefghij';
    const token = mediamtxHookToken(secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(secret);
    expect(mediamtxHookToken(secret)).toBe(token);
    expect(mediamtxHookToken(`${secret}x`)).not.toBe(token);
  });
});
