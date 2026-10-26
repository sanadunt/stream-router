import type { FastifyInstance } from 'fastify';
import { mqttBridgeConfigSchema } from '@stream-router/contracts';
import { requireRoles } from '../../plugins/auth.js';
import { AppError } from '../../shared/errors.js';
import { getStoredPtzConfig } from '../ptz/ptz-service.js';
import { testPtzConnection } from '../ptz/ptz-controller.js';
import { workerManager } from '../workers/worker-manager.js';
import {
  getMqttBrokerConnectionStatus,
  getMqttBridgeRuntimeStatus,
  refreshMqttOnvifBridge,
  testMqttBrokerConnection
} from './mqtt-bridge-runtime.js';
import { getMqttBridgeConfig, saveMqttBridgeConfig } from './mqtt-bridge-service.js';

async function bridgeDto(routeId: string): Promise<Record<string, unknown>> {
  const config = await getMqttBridgeConfig(routeId) as {
    enabled: boolean;
    subscriptions: Array<{ brokerId: string; [key: string]: unknown }>;
  };
  return {
    ...config,
    subscriptions: config.subscriptions.map((item) => ({
      ...item,
      connection: getMqttBrokerConnectionStatus(item.brokerId)
    })),
    runtime: getMqttBridgeRuntimeStatus(routeId)
  };
}

export async function mqttBridgeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/routes/:id/ptz/mqtt-bridge', {
    preHandler: requireRoles('admin')
  }, async (request) => bridgeDto(request.params.id));

  app.put<{ Params: { id: string } }>('/api/routes/:id/ptz/mqtt-bridge', {
    preHandler: requireRoles('admin')
  }, async (request) => {
    const input = mqttBridgeConfigSchema.parse(request.body);
    await saveMqttBridgeConfig(request.params.id, input);
    await refreshMqttOnvifBridge(
      request.params.id,
      workerManager.snapshot(request.params.id).status === 'RUNNING'
    );
    return bridgeDto(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/routes/:id/ptz/mqtt-bridge/test', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => {
    const ptz = await getStoredPtzConfig('ROUTE', request.params.id);
    if (!ptz || ptz.provider !== 'ONVIF') {
      throw new AppError('MQTT_BRIDGE_ONVIF_REQUIRED', 'Konfigurasi ONVIF wajib tersedia sebelum menguji bridge', 409);
    }
    const config = await getMqttBridgeConfig(request.params.id) as {
      subscriptions: Array<{ brokerId: string }>;
    };
    // Handshake baru: Cam di cache tidak membuktikan kamera masih merespons saat ini.
    const onvif = await testPtzConnection('ROUTE', request.params.id, ptz, { fresh: true });
    const brokerResults = await Promise.allSettled(
      config.subscriptions.map((item) => testMqttBrokerConnection(item.brokerId))
    );
    return {
      onvif,
      brokers: config.subscriptions.map((item, index) => ({
        brokerId: item.brokerId,
        connection: brokerResults[index]?.status === 'fulfilled'
          ? brokerResults[index].value
          : getMqttBrokerConnectionStatus(item.brokerId)
      }))
    };
  });
}
