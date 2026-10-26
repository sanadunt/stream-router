import { describe, expect, it } from 'vitest';
import {
  generalSettingsBody,
  mergeAppliedMediaMtx,
  mergeSavedGeneralSettings,
  mergeValidatedRecordingPath,
  type EditableSettings
} from './settings-merge';
import type { MediaMtxSettings } from '../types';

function settings(overrides: Partial<EditableSettings> = {}, mediaMtx: Partial<MediaMtxSettings> = {}): EditableSettings {
  return {
    appName: 'Camera Integration',
    maxWorkers: 10,
    logRetentionDays: 14,
    gracefulShutdownTimeoutMs: 10000,
    ffmpegPath: 'ffmpeg',
    databasePath: '/data/app.db',
    mediaMtx: { recordingPath: '/mnt/rec', rtspPort: 18554, ...mediaMtx } as MediaMtxSettings,
    ...overrides
  };
}

describe('Settings merge', () => {
  it('menyimpan form umum tanpa membatalkan editan MediaMTX yang belum diterapkan', () => {
    const current = settings({ appName: 'Draft' }, { recordingPath: '/mnt/baru', rtspPort: 28554 });
    const saved = settings({ appName: 'Draft' });
    expect(mergeSavedGeneralSettings(current, saved)?.mediaMtx).toEqual(current.mediaMtx);
    expect(mergeSavedGeneralSettings(current, saved)?.appName).toBe('Draft');
    expect(mergeSavedGeneralSettings(null, saved)).toBeNull();
  });

  it('menerapkan MediaMTX tanpa membatalkan editan form umum yang belum disimpan', () => {
    const current = settings({ appName: 'Belum disimpan', maxWorkers: 42 });
    const refreshed = settings({}, { rtspPort: 28554 });
    const merged = mergeAppliedMediaMtx(current, refreshed);
    expect(merged?.appName).toBe('Belum disimpan');
    expect(merged?.maxWorkers).toBe(42);
    expect(merged?.mediaMtx.rtspPort).toBe(28554);
  });

  it('memakai path kanonik hasil validasi hanya bila path belum diubah selama validasi', () => {
    const current = settings({}, { recordingPath: './rec' });
    expect(mergeValidatedRecordingPath(current, './rec', '/srv/app/rec')?.mediaMtx.recordingPath).toBe('/srv/app/rec');
    const changed = settings({}, { recordingPath: '/mnt/lain' });
    expect(mergeValidatedRecordingPath(changed, './rec', '/srv/app/rec')).toBe(changed);
  });

  it('hanya mengirim field form umum ke PATCH settings', () => {
    expect(Object.keys(generalSettingsBody(settings())).sort())
      .toEqual(['appName', 'ffmpegPath', 'gracefulShutdownTimeoutMs', 'logRetentionDays', 'maxWorkers']);
  });
});
