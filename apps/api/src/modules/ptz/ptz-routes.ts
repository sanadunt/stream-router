import type { FastifyInstance } from 'fastify';
import { ptzConfigSchema, viewerPtzCommandSchema } from '@stream-router/contracts';
import { requireRoles } from '../../plugins/auth.js';
import { AppError } from '../../shared/errors.js';
import { getRouteRow, audit } from '../routes/route-service.js';
import { getWebrtcStream } from '../webrtc-streams/webrtc-stream-service.js';
import { executePtzCommand, releasePtzTarget, testPtzConnection } from './ptz-controller.js';
import {
  disablePtz,
  getPtzAdminDto,
  getStoredPtzConfig,
  savePtzConfig,
  type PtzTargetType
} from './ptz-service.js';
import { getPtzConnectionStatus } from './ptz-status.js';
import { mediaRouteSnapshot } from '../mediamtx/mediamtx-runtime.js';

async function assertViewerTargetAvailable(targetType: PtzTargetType, targetId: string): Promise<void> {
  if (targetType === 'ROUTE') {
    const row = await getRouteRow(targetId);
    const ingestReady = mediaRouteSnapshot(targetId, row.cameraKey ?? '').ready;
    if (!row.enabled || (!row.localViewEnabled && !row.webrtcEnabled) || !ingestReady) {
      throw new AppError('PTZ_TARGET_OFFLINE', 'Route tidak aktif di Viewer', 409);
    }
    if (!row.ptzEnabled) throw new AppError('PTZ_DISABLED', 'PTZ tidak diaktifkan untuk route ini', 409);
    return;
  }

  const row = await getWebrtcStream(targetId);
  if (!row.enabled) throw new AppError('PTZ_TARGET_OFFLINE', 'Stream View tidak aktif', 409);
  if (!row.ptzEnabled) throw new AppError('PTZ_DISABLED', 'PTZ tidak diaktifkan untuk stream ini', 409);
}

async function updateConfig(targetType: PtzTargetType, targetId: string, body: unknown): Promise<Record<string, unknown>> {
  const input = ptzConfigSchema.parse(body);
  await releasePtzTarget(targetType, targetId);
  const result = await savePtzConfig(targetType, targetId, input);
  await audit('PTZ_CONFIG_UPDATE', targetType === 'ROUTE' ? targetId : null, {
    targetType,
    targetId,
    provider: input.provider,
    enabled: input.enabled,
    zoomEnabled: input.zoomEnabled
  });
  return result;
}

async function removeConfig(targetType: PtzTargetType, targetId: string): Promise<void> {
  await releasePtzTarget(targetType, targetId);
  await disablePtz(targetType, targetId);
  await audit('PTZ_CONFIG_DELETE', targetType === 'ROUTE' ? targetId : null, { targetType, targetId });
}

async function testConfig(targetType: PtzTargetType, targetId: string): Promise<Record<string, unknown>> {
  const config = await getStoredPtzConfig(targetType, targetId);
  if (!config) throw new AppError('PTZ_NOT_CONFIGURED', 'Konfigurasi PTZ belum tersedia', 409);
  await releasePtzTarget(targetType, targetId);
  const connection = await testPtzConnection(targetType, targetId, config);
  await audit('PTZ_CONNECTION_TEST', targetType === 'ROUTE' ? targetId : null, {
    targetType,
    targetId,
    provider: config.provider,
    result: connection.state
  });
  return getPtzAdminDto(targetType, targetId);
}

export async function ptzRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/routes/:id/ptz', { preHandler: requireRoles('admin') }, async (request) => (
    getPtzAdminDto('ROUTE', request.params.id)
  ));
  app.put<{ Params: { id: string } }>('/api/routes/:id/ptz', { preHandler: requireRoles('admin') }, async (request) => (
    updateConfig('ROUTE', request.params.id, request.body)
  ));
  app.post<{ Params: { id: string } }>('/api/routes/:id/ptz/test', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => testConfig('ROUTE', request.params.id));
  app.delete<{ Params: { id: string } }>('/api/routes/:id/ptz', { preHandler: requireRoles('admin') }, async (request, reply) => {
    await removeConfig('ROUTE', request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/webrtc-streams/:id/ptz', { preHandler: requireRoles('admin') }, async (request) => (
    getPtzAdminDto('WEBRTC_STREAM', request.params.id)
  ));
  app.put<{ Params: { id: string } }>('/api/webrtc-streams/:id/ptz', { preHandler: requireRoles('admin') }, async (request) => (
    updateConfig('WEBRTC_STREAM', request.params.id, request.body)
  ));
  app.post<{ Params: { id: string } }>('/api/webrtc-streams/:id/ptz/test', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => testConfig('WEBRTC_STREAM', request.params.id));
  app.delete<{ Params: { id: string } }>('/api/webrtc-streams/:id/ptz', { preHandler: requireRoles('admin') }, async (request, reply) => {
    await removeConfig('WEBRTC_STREAM', request.params.id);
    return reply.code(204).send();
  });

  app.post('/api/viewer/ptz/command', {
    preHandler: requireRoles('admin', 'operator'),
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } }
  }, async (request) => {
    const input = viewerPtzCommandSchema.parse(request.body);
    await assertViewerTargetAvailable(input.targetType, input.targetId);
    const config = await getStoredPtzConfig(input.targetType, input.targetId);
    if (!config) throw new AppError('PTZ_NOT_CONFIGURED', 'Konfigurasi PTZ belum tersedia', 409);
    const executed = await executePtzCommand(input.targetType, input.targetId, config, input.command);
    return {
      ok: true,
      ...(executed ? {} : { superseded: true }),
      connection: getPtzConnectionStatus(input.targetType, input.targetId, true)
    };
  });
}
