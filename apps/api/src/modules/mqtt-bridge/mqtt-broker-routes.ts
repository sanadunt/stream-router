import type { FastifyInstance } from 'fastify';
import { createMqttBrokerSchema, updateMqttBrokerSchema } from '@stream-router/contracts';
import { requireRoles } from '../../plugins/auth.js';
import { prisma } from '../../db/client.js';
import { audit } from '../routes/route-service.js';
import { releasePtzTarget } from '../ptz/ptz-controller.js';
import { workerManager } from '../workers/worker-manager.js';
import {
  getMqttBrokerConnectionStatus,
  refreshMqttOnvifBridge,
  testMqttBrokerConnection
} from './mqtt-bridge-runtime.js';
import {
  createMqttBroker,
  deleteMqttBroker,
  getMqttBroker,
  listMqttBrokers,
  mqttBrokerDto,
  updateMqttBroker
} from './mqtt-broker-service.js';

function withStatus(row: Parameters<typeof mqttBrokerDto>[0]): Record<string, unknown> {
  return { ...mqttBrokerDto(row), connection: getMqttBrokerConnectionStatus(row.id) };
}

async function refreshBrokerRoutes(brokerId: string): Promise<void> {
  const assignments = await prisma.routeMqttBridgeSubscription.findMany({
    where: { brokerId },
    select: { routeId: true }
  });
  await Promise.allSettled([...new Set(assignments.map((item) => item.routeId))].map((routeId) => (
    refreshMqttOnvifBridge(routeId, workerManager.snapshot(routeId).status === 'RUNNING')
  )));
}

async function releaseBrokerPtzTargets(brokerId: string): Promise<void> {
  const [routes, streams] = await Promise.all([
    prisma.streamRoute.findMany({ where: { ptzMqttBrokerId: brokerId }, select: { id: true } }),
    prisma.webrtcStream.findMany({ where: { ptzMqttBrokerId: brokerId }, select: { id: true } })
  ]);
  await Promise.allSettled([
    ...routes.map((route) => releasePtzTarget('ROUTE', route.id)),
    ...streams.map((stream) => releasePtzTarget('WEBRTC_STREAM', stream.id))
  ]);
}

export async function mqttBrokerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mqtt-brokers', { preHandler: requireRoles('admin') }, async () => ({
    items: (await listMqttBrokers()).map(withStatus)
  }));

  app.post('/api/mqtt-brokers', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const input = createMqttBrokerSchema.parse(request.body);
    const row = await createMqttBroker(input);
    await audit('MQTT_BROKER_CREATE', null, { brokerId: row.id, name: row.name, protocol: row.protocol });
    return reply.code(201).send(withStatus(row));
  });

  app.get<{ Params: { id: string } }>('/api/mqtt-brokers/:id', { preHandler: requireRoles('admin') }, async (request) => (
    withStatus(await getMqttBroker(request.params.id))
  ));

  app.patch<{ Params: { id: string } }>('/api/mqtt-brokers/:id', { preHandler: requireRoles('admin') }, async (request) => {
    const input = updateMqttBrokerSchema.parse(request.body);
    const row = await updateMqttBroker(request.params.id, input);
    await releaseBrokerPtzTargets(row.id);
    await refreshBrokerRoutes(row.id);
    await audit('MQTT_BROKER_UPDATE', null, { brokerId: row.id, changed: Object.keys(input) });
    return withStatus(row);
  });

  app.delete<{ Params: { id: string } }>('/api/mqtt-brokers/:id', { preHandler: requireRoles('admin') }, async (request, reply) => {
    await releaseBrokerPtzTargets(request.params.id);
    const routeIds = await deleteMqttBroker(request.params.id);
    await Promise.allSettled(routeIds.map((routeId) => (
      refreshMqttOnvifBridge(routeId, workerManager.snapshot(routeId).status === 'RUNNING')
    )));
    await audit('MQTT_BROKER_DELETE', null, { brokerId: request.params.id, affectedRouteCount: routeIds.length });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/mqtt-brokers/:id/test', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => ({
    connection: await testMqttBrokerConnection(request.params.id)
  }));
}
