import type { MqttClient } from 'mqtt';
import type { WebrtcStream } from '@prisma/client';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { decryptString } from '../../shared/crypto.js';
import { getStoredPtzConfig, type PtzTargetType, type StoredPtzConfig } from '../ptz/ptz-service.js';
import type { MqttBrokerRuntimeConfig } from './mqtt-broker-service.js';
import { mediaRouteSnapshot } from '../mediamtx/mediamtx-runtime.js';
import { toStandaloneViewerDto } from '../webrtc-streams/webrtc-stream-service.js';

function decryptOptionalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptString(value, getEnv().APP_ENCRYPTION_KEY);
  } catch {
    return null;
  }
}

/**
 * URL yang sama dengan yang dipakai Viewer: file server lewat endpoint stream-files dan YouTube
 * lewat URL embed. Source mentah (`file:///path/server.mp4`) tidak pernah dipublikasikan.
 */
function streamViewerUrl(stream: WebrtcStream): string | null {
  try {
    const webrtc = toStandaloneViewerDto(stream).webrtc as { url?: unknown } | undefined;
    return typeof webrtc?.url === 'string' ? webrtc.url : null;
  } catch {
    return null;
  }
}

export function buildCameraPresencePayload(input: {
  status: 'online' | 'offline';
  cameraId: string;
  cameraName: string;
  description: string;
  reason?: string;
  timestamp?: number;
}): string {
  return JSON.stringify({
    status: input.status,
    timestamp: input.timestamp ?? Date.now(),
    cameraId: input.cameraId,
    cameraName: input.cameraName,
    description: input.description,
    ...(input.reason ? { reason: input.reason } : {})
  });
}

export async function publishPtzCameraPresence(
  client: MqttClient,
  config: Extract<StoredPtzConfig, { provider: 'MQTT' }>,
  targetType: PtzTargetType,
  targetId: string,
  requestedStatus: 'online' | 'offline',
  reason?: string
): Promise<void> {
  if (!client.connected) return;
  const target = targetType === 'ROUTE'
    ? await prisma.streamRoute.findUnique({ where: { id: targetId } })
    : await prisma.webrtcStream.findUnique({ where: { id: targetId } });
  if (!target) return;
  const available = targetType === 'ROUTE'
    ? target.enabled && mediaRouteSnapshot(target.id, 'cameraKey' in target ? target.cameraKey ?? '' : '').ready
    : target.enabled;
  const status = requestedStatus === 'online' && available ? 'online' : 'offline';
  await client.publishAsync(`${config.fullTopic}/status`, buildCameraPresencePayload({
    status,
    cameraId: config.cameraId,
    cameraName: target.name,
    description: target.description,
    ...((reason || !available) ? { reason: reason ?? 'camera_not_running' } : {})
  }), { qos: 0, retain: false });
}

export async function publishCameraCatalog(client: MqttClient, broker: MqttBrokerRuntimeConfig): Promise<void> {
  if (!client.connected) return;
  const [routes, streams] = await Promise.all([
    prisma.streamRoute.findMany({
      where: {
        OR: [
          { ptzMqttBrokerId: broker.id },
          { mqttBridgeSubscriptions: { some: { brokerId: broker.id } } }
        ]
      },
      include: { mqttBridgeSubscriptions: { where: { brokerId: broker.id } } },
      orderBy: { name: 'asc' }
    }),
    prisma.webrtcStream.findMany({
      where: { ptzMqttBrokerId: broker.id },
      orderBy: { name: 'asc' }
    })
  ]);
  const routeCameras = await Promise.all(routes.map(async (route) => {
    const assignment = route.mqttBridgeSubscriptions[0];
    const ptz = route.ptzMqttBrokerId === broker.id ? await getStoredPtzConfig('ROUTE', route.id).catch(() => null) : null;
    const mqttPtzTopic = assignment?.commandTopic ?? (ptz?.provider === 'MQTT' ? ptz.fullTopic : null);
    return {
      id: route.id,
      cameraId: assignment?.commandTopic.split('/').at(-1) ?? (ptz?.provider === 'MQTT' ? ptz.cameraId : route.id),
      cameraName: route.name,
      description: route.description,
      source: 'STREAM_ROUTE',
      running: mediaRouteSnapshot(route.id, route.cameraKey ?? '').ready,
      enabled: route.enabled,
      webrtcUrl: route.localViewEnabled
        ? mediaRouteSnapshot(route.id, route.cameraKey ?? '').localWebrtcUrl
        : route.webrtcEnabled ? decryptOptionalUrl(route.webrtcUrlEncrypted) : null,
      mqttPtzTopic,
      statusTopic: mqttPtzTopic ? `${mqttPtzTopic}/status` : null
    };
  }));
  const streamCameras = await Promise.all(streams.map(async (stream) => {
    const ptz = await getStoredPtzConfig('WEBRTC_STREAM', stream.id).catch(() => null);
    const mqttPtzTopic = ptz?.provider === 'MQTT' ? ptz.fullTopic : null;
    return {
      id: stream.id,
      cameraId: ptz?.provider === 'MQTT' ? ptz.cameraId : stream.id,
      cameraName: stream.name,
      description: stream.description,
      source: 'WEBRTC_STREAM',
      running: stream.enabled,
      enabled: stream.enabled,
      webrtcUrl: streamViewerUrl(stream),
      mqttPtzTopic,
      statusTopic: mqttPtzTopic ? `${mqttPtzTopic}/status` : null
    };
  }));
  await client.publishAsync(`${broker.rootTopic}/camera-status`, JSON.stringify({
    timestamp: Date.now(),
    brokerId: broker.id,
    brokerName: broker.name,
    rootTopic: broker.rootTopic,
    cameras: [...routeCameras, ...streamCameras]
  }), { qos: 0, retain: false });
}
