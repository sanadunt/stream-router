import type { MediaMtxSettings } from '../types';

export interface GeneralSettings {
  appName: string;
  maxWorkers: number;
  logRetentionDays: number;
  gracefulShutdownTimeoutMs: number;
  ffmpegPath: string;
}

export interface EditableSettings extends GeneralSettings {
  databasePath: string;
  mediaMtx: MediaMtxSettings;
}

export function generalSettingsBody(settings: GeneralSettings): GeneralSettings {
  const { appName, maxWorkers, logRetentionDays, gracefulShutdownTimeoutMs, ffmpegPath } = settings;
  return { appName, maxWorkers, logRetentionDays, gracefulShutdownTimeoutMs, ffmpegPath };
}

// Setiap panel Settings hanya menimpa field yang benar-benar ia simpan, sehingga
// editan yang belum disimpan di panel lain tidak hilang setelah respons server.
export function mergeSavedGeneralSettings(current: EditableSettings | null, saved: GeneralSettings): EditableSettings | null {
  return current && { ...current, ...generalSettingsBody(saved) };
}

export function mergeAppliedMediaMtx(current: EditableSettings | null, refreshed: EditableSettings): EditableSettings | null {
  return current && { ...current, mediaMtx: refreshed.mediaMtx };
}

export function mergeValidatedRecordingPath(
  current: EditableSettings | null,
  requestedPath: string,
  canonicalPath: string
): EditableSettings | null {
  // Path diubah lagi selama validasi berjalan: hasil lama tidak boleh menimpanya.
  if (!current || current.mediaMtx.recordingPath !== requestedPath) return current;
  return { ...current, mediaMtx: { ...current.mediaMtx, recordingPath: canonicalPath } };
}
