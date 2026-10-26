import type { CreateMqttBrokerInput, UpdateMqttBrokerInput } from '@stream-router/contracts';
import type { MqttBroker } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { decryptString, encryptString } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';

export interface MqttBrokerRuntimeConfig {
  id: string;
  name: string;
  protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
  host: string;
  port: number;
  path: string;
  rootTopic: string;
  username: string;
  password: string;
}

function validateHost(host: string): void {
  if (host.includes('://') || /[/?#\s]/.test(host)) {
    throw new AppError('MQTT_BROKER_HOST_INVALID', 'Host broker harus berupa hostname atau IP tanpa protocol/path', 400);
  }
}

function normalizePath(path: string): string {
  if (!path) return '/mqtt';
  return path.startsWith('/') ? path : `/${path}`;
}

export function normalizeRootTopic(value: string): string {
  const topic = value.split('/').map((part) => part.trim()).filter(Boolean).join('/');
  if (!topic || /[+#\0]/.test(topic)) {
    throw new AppError('MQTT_ROOT_TOPIC_INVALID', 'Root topic wajib diisi tanpa wildcard + atau #', 400);
  }
  if (topic.endsWith('/status') || topic.endsWith('/camera-status')) {
    throw new AppError('MQTT_ROOT_TOPIC_INVALID', 'Root topic tidak boleh berakhiran status atau camera-status', 400);
  }
  return topic;
}

function decryptPassword(row: MqttBroker): string {
  return row.passwordEncrypted
    ? decryptString(row.passwordEncrypted, getEnv().APP_ENCRYPTION_KEY)
    : '';
}

export function mqttBrokerDto(row: MqttBroker): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    rootTopic: row.rootTopic,
    username: row.username,
    passwordConfigured: Boolean(row.passwordEncrypted),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listMqttBrokers(): Promise<MqttBroker[]> {
  return prisma.mqttBroker.findMany({ orderBy: { name: 'asc' } });
}

export async function getMqttBroker(id: string): Promise<MqttBroker> {
  const row = await prisma.mqttBroker.findUnique({ where: { id } });
  if (!row) throw new AppError('MQTT_BROKER_NOT_FOUND', 'Profil broker MQTT tidak ditemukan', 404);
  return row;
}

export async function getMqttBrokerRuntimeConfig(id: string): Promise<MqttBrokerRuntimeConfig> {
  const row = await getMqttBroker(id);
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol as MqttBrokerRuntimeConfig['protocol'],
    host: row.host,
    port: row.port,
    path: row.path,
    rootTopic: row.rootTopic,
    username: row.username,
    password: decryptPassword(row)
  };
}

export async function createMqttBroker(input: CreateMqttBrokerInput): Promise<MqttBroker> {
  validateHost(input.host);
  try {
    return await prisma.mqttBroker.create({
      data: {
        name: input.name,
        description: input.description,
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        path: normalizePath('/mqtt'),
        rootTopic: normalizeRootTopic(input.rootTopic),
        username: input.username,
        passwordEncrypted: input.password
          ? encryptString(input.password, getEnv().APP_ENCRYPTION_KEY)
          : null
      }
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new AppError('MQTT_BROKER_NAME_EXISTS', 'Nama profil broker sudah digunakan', 409);
    }
    throw error;
  }
}

export async function updateMqttBroker(id: string, input: UpdateMqttBrokerInput): Promise<MqttBroker> {
  const current = await getMqttBroker(id);
  if (input.host) validateHost(input.host);
  const endpointChanged = (input.protocol !== undefined && input.protocol !== current.protocol)
    || (input.host !== undefined && input.host !== current.host)
    || (input.port !== undefined && input.port !== current.port);
  // Password tersimpan tidak boleh ikut terkirim ke endpoint baru tanpa diketik ulang Administrator.
  if (endpointChanged && current.passwordEncrypted && !input.password) {
    throw new AppError(
      'MQTT_BROKER_PASSWORD_REQUIRED',
      'Masukkan ulang password broker ketika protocol, host, atau port berubah',
      400
    );
  }
  const nextRootTopic = input.rootTopic !== undefined ? normalizeRootTopic(input.rootTopic) : current.rootTopic;
  const subscriptions = nextRootTopic !== current.rootTopic
    ? await prisma.routeMqttBridgeSubscription.findMany({ where: { brokerId: id } })
    : [];
  try {
    const [updated] = await prisma.$transaction([
      prisma.mqttBroker.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.rootTopic !== undefined ? { rootTopic: nextRootTopic } : {}),
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.password !== undefined
            ? {
                passwordEncrypted: input.password
                  ? encryptString(input.password, getEnv().APP_ENCRYPTION_KEY)
                  : current.passwordEncrypted
              }
            : {})
        }
      }),
      ...subscriptions.map((subscription) => {
        const prefix = `${current.rootTopic}/`;
        const cameraId = subscription.commandTopic.startsWith(prefix)
          ? subscription.commandTopic.slice(prefix.length)
          : subscription.commandTopic.split('/').at(-1) ?? subscription.commandTopic;
        return prisma.routeMqttBridgeSubscription.update({
          where: { id: subscription.id },
          data: { commandTopic: `${nextRootTopic}/${cameraId}` }
        });
      })
    ]);
    return updated;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new AppError('MQTT_BROKER_CONFLICT', 'Nama broker atau kombinasi root topic dan ID camera sudah digunakan', 409);
    }
    throw error;
  }
}

export async function deleteMqttBroker(id: string): Promise<string[]> {
  await getMqttBroker(id);
  const assignments = await prisma.routeMqttBridgeSubscription.findMany({
    where: { brokerId: id },
    select: { routeId: true }
  });
  const ptzRoutes = await prisma.streamRoute.findMany({ where: { ptzMqttBrokerId: id }, select: { id: true } });
  const bridgeRouteIds = [...new Set(assignments.map((item) => item.routeId))];
  const routeIds = [...new Set([...bridgeRouteIds, ...ptzRoutes.map((item) => item.id)])];
  await prisma.$transaction([
    // Route yang hanya mem-bridge ke broker ini tetap memakai PTZ ONVIF miliknya; bridge hanya
    // dimatikan bila tidak ada subscription ke broker lain. Subscription ikut terhapus via cascade.
    prisma.streamRoute.updateMany({
      where: { id: { in: bridgeRouteIds }, mqttBridgeSubscriptions: { none: { brokerId: { not: id } } } },
      data: { mqttBridgeEnabled: false }
    }),
    // Hanya target PTZ MQTT yang menunjuk broker ini yang kehilangan konfigurasi PTZ.
    prisma.streamRoute.updateMany({
      where: { ptzMqttBrokerId: id },
      data: { mqttBridgeEnabled: false, ptzEnabled: false, ptzProvider: 'NONE', ptzConfigEncrypted: null, ptzMqttBrokerId: null }
    }),
    prisma.webrtcStream.updateMany({
      where: { ptzMqttBrokerId: id },
      data: { ptzEnabled: false, ptzProvider: 'NONE', ptzConfigEncrypted: null, ptzMqttBrokerId: null }
    }),
    prisma.mqttBroker.delete({ where: { id } })
  ]);
  return routeIds;
}
