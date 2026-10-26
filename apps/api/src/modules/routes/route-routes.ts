import type { StreamRoute } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { createRouteSchema, routeFeaturesSchema, updateRouteSchema } from '@stream-router/contracts';
import { redactText } from '@stream-router/ffmpeg';
import { requireAuth, requireRoles } from '../../plugins/auth.js';
import { prisma } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';
import { appendRouteLog, readMediaMtxLogs, readRouteLogs, type LogComponent } from '../logs/log-store.js';
import { mediaRouteSnapshot } from '../mediamtx/mediamtx-runtime.js';
import { releasePtzTarget } from '../ptz/ptz-controller.js';
import { mqttPtzCameraId } from '../ptz/ptz-service.js';
import { workerManager } from '../workers/worker-manager.js';
import { listStandaloneViewerItems } from '../webrtc-streams/webrtc-stream-service.js';
import {
  createRoute,
  decryptRoute,
  deleteRoute,
  getRouteRow,
  listRoutes,
  listViewerRoutes,
  restoreRouteChanges,
  runtimeRouteChanges,
  toRouteDto,
  toRouteEditDto,
  toViewerDto,
  updateRoute
} from './route-service.js';

interface DashboardMqttTopic {
  brokerName: string;
  commandTopic: string;
  statusTopic: string | null;
  usage: Array<'BRIDGE' | 'PTZ'>;
}

function withRuntime(
  row: Parameters<typeof toRouteDto>[0],
  mqttTopics?: DashboardMqttTopic[]
): Record<string, unknown> {
  const dto = toRouteDto(row);
  const runtime = workerManager.snapshot(row.id);
  const components = dto.components as Record<string, unknown>;
  return {
    ...dto,
    ...(mqttTopics ? { mqttTopics } : {}),
    components: {
      ...components,
      online: {
        ...(components.online as Record<string, unknown>),
        status: row.onlineRelayEnabled ? runtime.status : 'DISABLED',
        pid: row.onlineRelayEnabled ? runtime.pid : null
      }
    },
    runtime
  };
}

async function dashboardMqttTopics(rows: Parameters<typeof toRouteDto>[0][]): Promise<Map<string, DashboardMqttTopic[]>> {
  const routeIds = rows.map((row) => row.id);
  if (!routeIds.length) return new Map();
  const brokerIds = rows.flatMap((row) => row.ptzMqttBrokerId ? [row.ptzMqttBrokerId] : []);
  const [subscriptions, directBrokers] = await Promise.all([
    prisma.routeMqttBridgeSubscription.findMany({
      where: { routeId: { in: routeIds } },
      include: { broker: { select: { id: true, name: true } } }
    }),
    prisma.mqttBroker.findMany({
      where: { id: { in: brokerIds } },
      select: { id: true, name: true, rootTopic: true }
    })
  ]);
  const brokersById = new Map(directBrokers.map((broker) => [broker.id, broker]));
  const topicsByRoute = new Map<string, Map<string, DashboardMqttTopic>>();
  const add = (routeId: string, brokerId: string, topic: DashboardMqttTopic, usage: 'BRIDGE' | 'PTZ') => {
    const topics = topicsByRoute.get(routeId) ?? new Map<string, DashboardMqttTopic>();
    const key = `${brokerId}\0${topic.commandTopic}`;
    const existing = topics.get(key);
    if (existing) {
      if (!existing.usage.includes(usage)) existing.usage.push(usage);
      if (topic.statusTopic) existing.statusTopic = topic.statusTopic;
    } else {
      topics.set(key, topic);
    }
    topicsByRoute.set(routeId, topics);
  };

  for (const subscription of subscriptions) {
    add(subscription.routeId, subscription.brokerId, {
      brokerName: subscription.broker.name,
      commandTopic: subscription.commandTopic,
      statusTopic: `${subscription.commandTopic}/status`,
      usage: ['BRIDGE']
    }, 'BRIDGE');
  }
  for (const row of rows) {
    if (!row.ptzMqttBrokerId) continue;
    const broker = brokersById.get(row.ptzMqttBrokerId);
    const cameraId = mqttPtzCameraId(row);
    if (!broker || !cameraId) continue;
    add(row.id, broker.id, {
      brokerName: broker.name,
      commandTopic: `${broker.rootTopic}/${cameraId}`,
      statusTopic: null,
      usage: ['PTZ']
    }, 'PTZ');
  }

  return new Map([...topicsByRoute].map(([routeId, topics]) => [
    routeId,
    [...topics.values()].sort((left, right) => (
      left.brokerName.localeCompare(right.brokerName) || left.commandTopic.localeCompare(right.commandTopic)
    ))
  ]));
}

interface ActiveRouteState {
  row: StreamRoute;
  ready: boolean;
  /** Epoch kontrol saat edit dimulai; Stop/Restart/Deinitialize/Delete sesudahnya menggantikan reconcile edit ini. */
  epoch: number;
}

async function activeRouteState(routeId: string): Promise<ActiveRouteState | null> {
  const epoch = workerManager.controlEpoch(routeId);
  if (!workerManager.isActive(routeId)) return null;
  return { row: await getRouteRow(routeId), ready: mediaRouteSnapshot(routeId).ready, epoch };
}

function reconcileFailure(error: unknown): AppError {
  const reason = redactText(error instanceof Error ? error.message : String(error));
  return new AppError(
    'ROUTE_RECONCILE_FAILED',
    `Perubahan route gagal diterapkan; konfigurasi dan runtime dikembalikan ke kondisi sebelumnya. Penyebab: ${reason}`,
    error instanceof AppError ? error.statusCode : 502,
    { cause: error instanceof AppError ? error.code : null }
  );
}

function errorCode(error: unknown): string | null {
  return error instanceof AppError ? error.code : null;
}

/**
 * Operasi edit dibatalkan atau digantikan perintah yang datang belakangan (Stop, Restart, Deinitialize, Delete,
 * shutdown). Edit tetap tersimpan dan perintah itulah yang menentukan runtime: tidak ada rollback maupun start.
 */
function supersededEdit(routeId: string, epoch: number, error: unknown): boolean {
  const code = errorCode(error);
  return workerManager.isSuperseded(routeId, epoch) || code === 'MEDIAMTX_START_CANCELLED' || code === 'ROUTE_NOT_INITIALIZED';
}

/** Recording diubah saat source belum READY: config path ditulis sekarang agar retry/monitor tidak memakai flag lama. */
async function applyPendingRecording(routeId: string): Promise<void> {
  await workerManager.refreshMediaConfig(routeId).catch((error: Error) => appendRouteLog(
    routeId,
    'warn',
    `Recording tersimpan; config path MediaMTX belum dapat ditulis ulang dan diterapkan pada retry berikutnya: ${redactText(error.message)}`,
    'RECORDING'
  ));
}

/**
 * Restart latar belakang untuk route yang source-nya belum READY. Bila route tetap aktif, retry MediaMTX sudah
 * memakai konfigurasi baru. Bila gagal sebelum route aktif kembali (mis. batas worker atau error database),
 * kolom yang diubah dikembalikan dan konfigurasi lama dijalankan ulang agar route tidak diam STOPPED.
 */
async function settlePendingRestart(
  routeId: string,
  before: ActiveRouteState,
  nextRow: StreamRoute,
  changed: string[],
  epoch: number,
  error: unknown
): Promise<void> {
  if (supersededEdit(routeId, epoch, error)) return;
  const reason = redactText(error instanceof Error ? error.message : String(error));
  const fields = changed.join(', ');
  if (workerManager.isActive(routeId)) {
    const retrying = workerManager.snapshot(routeId).status === 'RESTARTING';
    await appendRouteLog(
      routeId,
      retrying ? 'info' : 'warn',
      retrying
        ? `Konfigurasi baru (${fields}) disimpan; source belum READY sehingga retry MediaMTX memakai konfigurasi baru.`
        : `Konfigurasi baru (${fields}) disimpan, tetapi route belum berjalan: ${reason}`,
      'SYSTEM'
    );
    return;
  }
  await appendRouteLog(
    routeId,
    'error',
    `Konfigurasi baru (${fields}) gagal diterapkan sehingga dikembalikan ke konfigurasi sebelumnya: ${reason}`,
    'SYSTEM'
  );
  await restoreRouteChanges(before.row, nextRow);
  await workerManager.rollbackRestart(routeId, epoch).catch(() => undefined);
}

/**
 * Hanya perubahan yang menyentuh path MediaMTX/argumen FFmpeg yang me-restart pipeline; metadata cukup disimpan.
 * Aturan rollback: edit yang gagal diterapkan hanya mengembalikan kolom yang diubahnya (selama masih memuat nilai
 * tulisannya), runtime dijalankan ulang lewat stop+start sehingga path MediaMTX percobaan yang gagal ikut dilepas,
 * dan rollback tidak pernah menghidupkan route yang sudah digantikan Stop/Restart/Deinitialize/Delete.
 */
async function reconcileActiveRoute(routeId: string, before: ActiveRouteState, nextRow: StreamRoute): Promise<void> {
  const previous = decryptRoute(before.row);
  const next = decryptRoute(nextRow);
  const changed = runtimeRouteChanges(previous, next);
  const recordingChanged = previous.recordingEnabled !== next.recordingEnabled;
  if (!changed.length && !recordingChanged) return;
  // Stop/Deinitialize yang masuk selama edit disimpan sudah menentukan runtime; edit cukup tersimpan.
  if (workerManager.isSuperseded(routeId, before.epoch)) return;
  if (!before.ready) {
    // Source belum READY: rollback ke source yang sama-sama belum READY tidak berguna. Perubahan runtime
    // diterapkan lewat restart latar belakang tanpa menunggu READY; Recording saja cukup menulis ulang config path.
    if (!changed.length) {
      await applyPendingRecording(routeId);
      return;
    }
    if (next.onlineRelayEnabled) {
      try {
        await workerManager.assertRelayAdmission(routeId);
      } catch (error) {
        await restoreRouteChanges(before.row, nextRow);
        throw error;
      }
    }
    const restarting = workerManager.restart(routeId);
    const epoch = workerManager.controlEpoch(routeId);
    void restarting.then(
      () => undefined,
      (error: unknown) => settlePendingRestart(routeId, before, nextRow, changed, epoch, error)
    ).catch((error: Error) => {
      console.error(`[routes] Penanganan restart latar belakang route ${routeId} gagal: ${error.message}`);
    });
    return;
  }
  if (!changed.length) {
    try {
      await workerManager.reconfigureRecording(routeId);
    } catch (error) {
      if (supersededEdit(routeId, before.epoch, error)) return;
      // Source hilang tepat saat hot apply: sama dengan edit saat belum READY, flag diterapkan pada retry.
      if (errorCode(error) === 'MEDIAMTX_INGEST_NOT_READY' && workerManager.isActive(routeId)) {
        await applyPendingRecording(routeId);
        return;
      }
      await restoreRouteChanges(before.row, nextRow);
      if (!workerManager.isSuperseded(routeId, before.epoch)) {
        await workerManager.reconfigureRecording(routeId).catch(() => undefined);
      }
      throw error;
    }
    return;
  }
  const restarting = workerManager.restart(routeId);
  const epoch = workerManager.controlEpoch(routeId);
  try {
    await restarting;
  } catch (error) {
    if (supersededEdit(routeId, epoch, error)) return;
    await restoreRouteChanges(before.row, nextRow);
    await workerManager.rollbackRestart(routeId, epoch).catch(() => undefined);
    throw reconcileFailure(error);
  }
}

export async function routeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/viewer/routes', { preHandler: requireAuth }, async (request) => {
    const legacyItems = (await listViewerRoutes()).flatMap((row) => {
      if (!workerManager.isActive(row.id)) return [];
      const viewer = toViewerDto(row);
      if (!viewer) return [];
      // Sumber lokal sudah disyaratkan ingest MediaMTX READY, sehingga tetap tampil walau relay online
      // sedang retry/FAILED (VPS atau internet putus). Sumber online saja tetap butuh relay RUNNING.
      const runtime = workerManager.snapshot(row.id);
      if (!viewer.sources.local && runtime.status !== 'RUNNING') return [];
      return [{ ...viewer, runtime }];
    });
    const standaloneItems = await listStandaloneViewerItems(request.log);
    return { items: [...standaloneItems, ...legacyItems] };
  });

  app.get('/api/routes', { preHandler: requireRoles('admin', 'operator') }, async () => {
    const rows = await listRoutes();
    const topicsByRoute = await dashboardMqttTopics(rows);
    return { items: rows.map((row) => withRuntime(row, topicsByRoute.get(row.id) ?? [])) };
  });

  app.post('/api/routes', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const row = await createRoute(createRouteSchema.parse(request.body));
    return reply.code(201).send(withRuntime(row));
  });

  app.get<{ Params: { id: string } }>('/api/routes/:id', { preHandler: requireRoles('admin', 'operator') }, async (request) => {
    return withRuntime(await getRouteRow(request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/routes/:id/edit', { preHandler: requireRoles('admin') }, async (request) => {
    return toRouteEditDto(await getRouteRow(request.params.id));
  });

  app.patch<{ Params: { id: string } }>('/api/routes/:id', { preHandler: requireRoles('admin') }, async (request) => {
    const input = updateRouteSchema.parse(request.body);
    const before = await activeRouteState(request.params.id);
    const row = await updateRoute(request.params.id, input);
    if (input.enabled === false) {
      await workerManager.stop(request.params.id, true);
      await releasePtzTarget('ROUTE', request.params.id);
    } else if (before) {
      await reconcileActiveRoute(request.params.id, before, row);
    }
    return withRuntime(row);
  });

  app.put<{ Params: { id: string } }>('/api/routes/:id/features', { preHandler: requireRoles('admin') }, async (request) => {
    const input = routeFeaturesSchema.parse(request.body);
    const before = await activeRouteState(request.params.id);
    const row = await updateRoute(request.params.id, input);
    if (before) await reconcileActiveRoute(request.params.id, before, row);
    return withRuntime(await getRouteRow(request.params.id));
  });

  app.delete<{ Params: { id: string } }>('/api/routes/:id', { preHandler: requireRoles('admin') }, async (request, reply) => {
    await workerManager.stop(request.params.id, true);
    await releasePtzTarget('ROUTE', request.params.id);
    await deleteRoute(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/routes/:id/start', { preHandler: requireRoles('admin', 'operator') }, async (request) => workerManager.start(request.params.id));
  app.post<{ Params: { id: string } }>('/api/routes/:id/initialize', { preHandler: requireRoles('admin') }, async (request) => {
    const row = await getRouteRow(request.params.id);
    if (!row.enabled) await updateRoute(request.params.id, { enabled: true });
    return workerManager.start(request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/routes/:id/deinitialize', { preHandler: requireRoles('admin') }, async (request) => {
    await workerManager.stop(request.params.id, true);
    await releasePtzTarget('ROUTE', request.params.id);
    const row = await getRouteRow(request.params.id);
    if (row.enabled) await updateRoute(request.params.id, { enabled: false });
    return workerManager.snapshot(request.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/routes/:id/stop', { preHandler: requireRoles('admin', 'operator') }, async (request) => workerManager.stop(request.params.id, true));
  app.post<{ Params: { id: string } }>('/api/routes/:id/restart', { preHandler: requireRoles('admin', 'operator') }, async (request) => workerManager.restart(request.params.id));

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string; tail?: string; component?: string } }>('/api/routes/:id/logs', { preHandler: requireRoles('admin', 'operator') }, async (request) => {
    await getRouteRow(request.params.id);
    const allowed = new Set<LogComponent>(['FFMPEG_ONLINE', 'MEDIAMTX', 'RECORDING', 'SYSTEM']);
    const component = allowed.has(request.query.component as LogComponent) ? request.query.component as LogComponent : undefined;
    return readRouteLogs(request.params.id, Number(request.query.offset ?? 0), Number(request.query.limit ?? 200), request.query.tail === 'true', component);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/logs/mediamtx', { preHandler: requireRoles('admin', 'operator') }, async (request) => (
    readMediaMtxLogs(Number(request.query.limit ?? 500))
  ));

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>('/api/routes/:id/runs', { preHandler: requireRoles('admin', 'operator') }, async (request) => {
    await getRouteRow(request.params.id);
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));
    const [items, total] = await Promise.all([
      prisma.routeRun.findMany({ where: { routeId: request.params.id }, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
      prisma.routeRun.count({ where: { routeId: request.params.id } })
    ]);
    return { items, total };
  });
}
