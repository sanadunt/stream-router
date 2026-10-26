import type { FastifyInstance } from 'fastify';
import { mediaMtxSettingsSchema, settingsUpdateSchema } from '@stream-router/contracts';
import { z } from 'zod';
import { requireRoles } from '../../plugins/auth.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../routes/route-service.js';
import { getMediaMtxSettings, getSettings, updateSettings } from './settings-service.js';
import {
  reapplyActiveMediaRoutes,
  testMediaMtxConnection,
  withMediaMtxConfigLock
} from '../mediamtx/mediamtx-runtime.js';
import {
  listStorageDirectories,
  validateStorageDirectory
} from './storage-browser.js';

const generalSettingsUpdateSchema = settingsUpdateSchema.omit({ mediaMtx: true });

// Rollback memulihkan nilai publicHost yang tersimpan (bukan host efektif hasil fallback), sehingga
// apply yang gagal tidak membekukan MEDIAMTX_PUBLIC_HOST/IP otomatis ke database.
function editableMediaSettings(settings: Awaited<ReturnType<typeof getMediaMtxSettings>>) {
  return {
    enabled: settings.enabled,
    publicHost: settings.publicHostConfigured,
    recordingPath: settings.recordingPath,
    rtspPort: settings.rtspPort,
    rtmpPort: settings.rtmpPort,
    hlsPort: settings.hlsPort,
    webrtcPort: settings.webrtcPort,
    webrtcUdpPort: settings.webrtcUdpPort,
    srtPort: settings.srtPort,
    playbackPort: settings.playbackPort,
    apiPort: settings.apiPort,
    metricsPort: settings.metricsPort,
    retentionMode: settings.retentionMode,
    retentionDays: settings.retentionDays,
    retentionMaxGb: settings.retentionMaxGb,
    minFreePercent: settings.minFreePercent,
    minFreeGb: settings.minFreeGb,
    segmentDurationSeconds: settings.segmentDurationSeconds
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', { preHandler: requireRoles('admin') }, async () => getSettings());
  app.get('/api/settings/storage/directories', { preHandler: requireRoles('admin') }, async (request) => {
    const { path } = z.object({ path: z.string().max(4096).optional() }).parse(request.query);
    return listStorageDirectories(path);
  });
  app.post('/api/settings/storage/validate', { preHandler: requireRoles('admin') }, async (request) => {
    const input = z.object({
      path: z.string().trim().min(1).max(4096),
      minFreePercent: z.number().min(0).max(90),
      minFreeGb: z.number().min(0).max(1_000_000)
    }).parse(request.body);
    return validateStorageDirectory(input.path, input.minFreePercent, input.minFreeGb);
  });
  app.patch('/api/settings', { preHandler: requireRoles('admin') }, async (request) => {
    // Perubahan MediaMTX hanya lewat /api/settings/mediamtx/apply, yang memeriksa bentrok port,
    // keamanan folder recording, dan melakukan rollback bila reload gagal.
    const input = generalSettingsUpdateSchema.parse(request.body);
    const result = await updateSettings(input);
    await audit('SETTINGS_UPDATE', null, { changed: Object.keys(input) });
    return result;
  });
  app.post('/api/settings/mediamtx/test', { preHandler: requireRoles('admin') }, async () => {
    return testMediaMtxConnection();
  });
  app.post('/api/settings/mediamtx/apply', { preHandler: requireRoles('admin') }, async (request) => {
    const parsed = mediaMtxSettingsSchema.optional().parse(request.body);
    // Baca settings lama, tulis settings baru, apply file, dan rollback DB berada dalam satu antrean apply,
    // sehingga dua apply bersamaan tidak membuat DB dan YAML MediaMTX saling tidak cocok.
    const result = await withMediaMtxConfigLock(async (apply) => {
      let body = parsed;
      const previous = await getMediaMtxSettings();
      if (body) {
        const currentPath = await validateStorageDirectory(
          previous.recordingPath,
          previous.minFreePercent,
          previous.minFreeGb,
          false
        ).catch(() => null);
        const candidate = await validateStorageDirectory(
          body.recordingPath,
          body.minFreePercent,
          body.minFreeGb
        );
        const pathChanged = candidate.path !== currentPath?.path;
        if (pathChanged && !candidate.ok) {
          throw new AppError('RECORDING_STORAGE_UNSAFE', candidate.error ?? 'Folder recording tidak memenuhi batas aman', 400);
        }
        if (!candidate.writable) {
          throw new AppError('RECORDING_STORAGE_NOT_WRITABLE', candidate.error ?? 'Folder recording tidak dapat ditulis', 400);
        }
        if (pathChanged) body = { ...body, recordingPath: candidate.path };
        await updateSettings({ mediaMtx: body });
      }
      try {
        return await apply(body ? previous : undefined);
      } catch (error) {
        if (body) {
          await updateSettings({ mediaMtx: editableMediaSettings(previous) });
          await reapplyActiveMediaRoutes().catch(() => undefined);
        }
        throw error;
      }
    });
    await audit('MEDIAMTX_CONFIG_APPLY', null, {});
    return result;
  });
}
