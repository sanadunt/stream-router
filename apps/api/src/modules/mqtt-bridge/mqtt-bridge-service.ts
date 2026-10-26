import type { MqttBridgeConfigInput } from '@stream-router/contracts';
import { prisma } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';
import { audit, getRouteRow } from '../routes/route-service.js';
import { mqttBrokerDto } from './mqtt-broker-service.js';

export function validateCommandTopic(value: string): string {
  const topic = value.split('/').map((part) => part.trim()).filter(Boolean).join('/');
  if (!topic || /[+#\0]/.test(topic)) {
    throw new AppError('MQTT_BRIDGE_TOPIC_INVALID', 'Topic command wajib berupa full topic tanpa wildcard + atau #', 400);
  }
  if (topic.endsWith('/status')) {
    throw new AppError('MQTT_BRIDGE_TOPIC_INVALID', 'Topic command tidak boleh berakhiran /status', 400);
  }
  return topic;
}

function cameraIdFromTopic(commandTopic: string, rootTopic: string): string {
  const prefix = `${rootTopic}/`;
  return commandTopic.startsWith(prefix) ? commandTopic.slice(prefix.length) : commandTopic.split('/').at(-1) ?? commandTopic;
}

export async function getMqttBridgeConfig(routeId: string): Promise<Record<string, unknown>> {
  const route = await getRouteRow(routeId);
  const subscriptions = await prisma.routeMqttBridgeSubscription.findMany({
    where: { routeId },
    include: { broker: true },
    orderBy: { broker: { name: 'asc' } }
  });
  return {
    enabled: route.mqttBridgeEnabled,
    subscriptions: subscriptions.map((item) => ({
      id: item.id,
      brokerId: item.brokerId,
      cameraId: cameraIdFromTopic(item.commandTopic, item.broker.rootTopic),
      commandTopic: item.commandTopic,
      statusTopic: `${item.commandTopic}/status`,
      broker: mqttBrokerDto(item.broker)
    }))
  };
}

export async function saveMqttBridgeConfig(routeId: string, input: MqttBridgeConfigInput): Promise<Record<string, unknown>> {
  const route = await getRouteRow(routeId);
  if (input.enabled && route.ptzProvider !== 'ONVIF') {
    throw new AppError('MQTT_BRIDGE_ONVIF_REQUIRED', 'MQTT bridge hanya dapat diaktifkan untuk PTZ ONVIF', 409);
  }
  if (input.enabled && input.subscriptions.length === 0) {
    throw new AppError('MQTT_BRIDGE_SUBSCRIPTION_REQUIRED', 'Pilih minimal satu broker dan topic command', 400);
  }
  const brokerIds = input.subscriptions.map((item) => item.brokerId);
  if (new Set(brokerIds).size !== brokerIds.length) {
    throw new AppError('MQTT_BRIDGE_BROKER_DUPLICATE', 'Satu profil broker hanya boleh dipilih sekali per route', 400);
  }
  const brokers = await prisma.mqttBroker.findMany({ where: { id: { in: brokerIds } } });
  if (brokers.length !== brokerIds.length) {
    throw new AppError('MQTT_BROKER_NOT_FOUND', 'Satu atau beberapa profil broker tidak ditemukan', 404);
  }
  const brokersById = new Map(brokers.map((broker) => [broker.id, broker]));
  const normalized = input.subscriptions.map((item) => ({
    brokerId: item.brokerId,
    commandTopic: validateCommandTopic(`${brokersById.get(item.brokerId)!.rootTopic}/${item.cameraId}`)
  }));
  try {
    await prisma.$transaction([
      prisma.routeMqttBridgeSubscription.deleteMany({ where: { routeId } }),
      ...normalized.map((item) => prisma.routeMqttBridgeSubscription.create({
        data: { routeId, brokerId: item.brokerId, commandTopic: item.commandTopic }
      })),
      prisma.streamRoute.update({
        where: { id: routeId },
        data: { mqttBridgeEnabled: input.enabled }
      })
    ]);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new AppError('MQTT_BRIDGE_TOPIC_CONFLICT', 'Topic tersebut sudah dipakai route lain pada broker yang sama', 409);
    }
    throw error;
  }
  await audit('MQTT_BRIDGE_CONFIG_UPDATE', routeId, {
    enabled: input.enabled,
    brokerIds: normalized.map((item) => item.brokerId),
    subscriptionCount: normalized.length
  });
  return getMqttBridgeConfig(routeId);
}
