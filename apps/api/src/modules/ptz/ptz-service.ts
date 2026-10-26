import type { PtzConfigInput } from '@stream-router/contracts';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { decryptString, encryptString } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { getMqttBrokerRuntimeConfig, mqttBrokerDto, getMqttBroker } from '../mqtt-bridge/mqtt-broker-service.js';
import { getPtzConnectionStatus, resetPtzConnectionStatus } from './ptz-status.js';

export type PtzTargetType = 'ROUTE' | 'WEBRTC_STREAM';

type StoredOnvifPtzConfig = Omit<Extract<PtzConfigInput, { provider: 'ONVIF' }>, 'password'> & { password: string };
type StoredMqttPtzConfig = Extract<PtzConfigInput, { provider: 'MQTT' }> & {
      id: string;
      name: string;
      protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
      host: string;
      port: number;
      username: string;
      password: string;
      path: string;
      rootTopic: string;
      fullTopic: string;
    };
export type StoredPtzConfig = StoredOnvifPtzConfig | StoredMqttPtzConfig;
type PersistedPtzConfig = StoredOnvifPtzConfig | Extract<PtzConfigInput, { provider: 'MQTT' }>;

interface PtzColumns {
  ptzEnabled: boolean;
  ptzProvider: string;
  ptzZoomEnabled: boolean;
  ptzConfigEncrypted: string | null;
}

function validateHost(host: string): void {
  if (host.includes('://') || /[/?#\s]/.test(host)) {
    throw new AppError('PTZ_HOST_INVALID', 'Host PTZ harus berupa hostname atau IP tanpa protocol/path', 400);
  }
}

async function targetRow(targetType: PtzTargetType, targetId: string): Promise<PtzColumns> {
  const row = targetType === 'ROUTE'
    ? await prisma.streamRoute.findUnique({ where: { id: targetId } })
    : await prisma.webrtcStream.findUnique({ where: { id: targetId } });
  if (!row) throw new AppError('PTZ_TARGET_NOT_FOUND', 'Target PTZ tidak ditemukan', 404);
  return row;
}

function decryptConfig(row: PtzColumns): PersistedPtzConfig | null {
  if (!row.ptzConfigEncrypted || row.ptzProvider === 'NONE') return null;
  try {
    return JSON.parse(decryptString(row.ptzConfigEncrypted, getEnv().APP_ENCRYPTION_KEY)) as PersistedPtzConfig;
  } catch {
    throw new AppError('PTZ_CONFIG_INVALID', 'Konfigurasi PTZ tersimpan tidak dapat dibaca', 500);
  }
}

/**
 * Membaca hanya ID kamera MQTT untuk ringkasan operasional. Credential broker
 * tetap berada di service PTZ dan tidak pernah ikut ke DTO Dashboard.
 */
export function mqttPtzCameraId(row: PtzColumns): string | null {
  if (row.ptzProvider !== 'MQTT') return null;
  try {
    const config = decryptConfig(row);
    return config?.provider === 'MQTT' ? config.cameraId : null;
  } catch {
    return null;
  }
}

export async function getStoredPtzConfig(targetType: PtzTargetType, targetId: string): Promise<StoredPtzConfig | null> {
  const persisted = decryptConfig(await targetRow(targetType, targetId));
  if (!persisted || persisted.provider === 'ONVIF') return persisted;
  const broker = await getMqttBrokerRuntimeConfig(persisted.brokerId);
  return {
    ...persisted,
    id: broker.id,
    name: broker.name,
    protocol: broker.protocol,
    host: broker.host,
    port: broker.port,
    username: broker.username,
    password: broker.password,
    path: broker.path,
    rootTopic: broker.rootTopic,
    fullTopic: `${broker.rootTopic}/${persisted.cameraId}`
  };
}

export function ptzSummary(
  row: PtzColumns,
  targetType: PtzTargetType,
  targetId: string,
  includeTarget = false
): Record<string, unknown> {
  return {
    enabled: row.ptzEnabled,
    provider: row.ptzProvider,
    zoomEnabled: row.ptzZoomEnabled,
    connection: getPtzConnectionStatus(targetType, targetId, row.ptzEnabled),
    ...(includeTarget ? { targetType, targetId } : {})
  };
}

export async function getPtzAdminDto(targetType: PtzTargetType, targetId: string): Promise<Record<string, unknown>> {
  const row = await targetRow(targetType, targetId);
  const config = await getStoredPtzConfig(targetType, targetId);
  const connection = getPtzConnectionStatus(targetType, targetId, row.ptzEnabled);
  if (!config) return { provider: 'NONE', enabled: false, zoomEnabled: false, connection };
  if (config.provider === 'MQTT') {
    const broker = await getMqttBroker(config.brokerId);
    return {
      provider: 'MQTT',
      enabled: config.enabled,
      zoomEnabled: config.zoomEnabled,
      brokerId: config.brokerId,
      cameraId: config.cameraId,
      topicRoot: config.rootTopic,
      fullTopic: config.fullTopic,
      broker: mqttBrokerDto(broker),
      connection
    };
  }
  const safe = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'password'));
  return { ...safe, passwordConfigured: Boolean(config.password), connection };
}

export async function savePtzConfig(targetType: PtzTargetType, targetId: string, input: PtzConfigInput): Promise<Record<string, unknown>> {
  if (input.provider === 'ONVIF') validateHost(input.host);
  const current = await getStoredPtzConfig(targetType, targetId);
  const existingPassword = current?.provider === 'ONVIF' && input.provider === 'ONVIF' ? current.password : '';
  const stored: PersistedPtzConfig = input.provider === 'ONVIF'
    ? {
        provider: 'ONVIF',
        enabled: input.enabled,
        zoomEnabled: input.zoomEnabled,
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password !== undefined ? input.password : existingPassword,
        useTls: input.useTls,
        path: input.path.startsWith('/') ? input.path : `/${input.path}`,
        profileToken: input.profileToken
      }
    : {
        provider: 'MQTT',
        enabled: input.enabled,
        zoomEnabled: input.zoomEnabled,
        brokerId: (await getMqttBroker(input.brokerId)).id,
        cameraId: input.cameraId
      };

  const data = {
    ptzEnabled: stored.enabled,
    ptzProvider: stored.provider,
    ptzZoomEnabled: stored.zoomEnabled,
    ptzConfigEncrypted: encryptString(JSON.stringify(stored), getEnv().APP_ENCRYPTION_KEY),
    ptzMqttBrokerId: stored.provider === 'MQTT' ? stored.brokerId : null
  };
  if (targetType === 'ROUTE') await prisma.streamRoute.update({ where: { id: targetId }, data });
  else await prisma.webrtcStream.update({ where: { id: targetId }, data });
  resetPtzConnectionStatus(targetType, targetId);
  return getPtzAdminDto(targetType, targetId);
}

export async function disablePtz(targetType: PtzTargetType, targetId: string): Promise<void> {
  await targetRow(targetType, targetId);
  const data = { ptzEnabled: false, ptzProvider: 'NONE', ptzZoomEnabled: false, ptzConfigEncrypted: null, ptzMqttBrokerId: null };
  if (targetType === 'ROUTE') await prisma.streamRoute.update({ where: { id: targetId }, data });
  else await prisma.webrtcStream.update({ where: { id: targetId }, data });
  resetPtzConnectionStatus(targetType, targetId);
}
