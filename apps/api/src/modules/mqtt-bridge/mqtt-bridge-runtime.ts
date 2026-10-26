import { createHash } from 'node:crypto';
import { connectAsync, type MqttClient } from 'mqtt';
import type { PtzCommandInput } from '@stream-router/contracts';
import { prisma } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';
import { calculateBackoff } from '../../shared/retry.js';
import { appendRouteLog } from '../logs/log-store.js';
import { executePtzCommand, testPtzConnection } from '../ptz/ptz-controller.js';
import { getStoredPtzConfig } from '../ptz/ptz-service.js';
import {
  getMqttBrokerRuntimeConfig,
  type MqttBrokerRuntimeConfig
} from './mqtt-broker-service.js';
import { buildCameraPresencePayload, publishCameraCatalog } from './camera-status-publisher.js';
import { closeMqttClient, MQTT_KEEPALIVE_SECONDS, mqttClientId, withMqttTimeout } from './mqtt-io.js';
export { buildCameraPresencePayload } from './camera-status-publisher.js';

type ConnectionState = 'UNTESTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

interface BrokerStatus {
  state: ConnectionState;
  checkedAt: string | null;
  message: string;
}

interface SharedBrokerClient {
  fingerprint: string;
  config: MqttBrokerRuntimeConfig;
  client: MqttClient;
  topics: Map<string, string>;
  catalogTimer?: NodeJS.Timeout;
}

interface RouteAssignment {
  brokerId: string;
  cameraId: string;
  commandTopic: string;
  statusTopic: string;
}

interface RouteBridgeRuntime {
  routeId: string;
  cameraName: string;
  description: string;
  active: boolean;
  onvifConnected: boolean;
  onvifFailures: number;
  nextOnvifAttemptAt: number;
  busy: boolean;
  assignments: RouteAssignment[];
  heartbeatTimer?: NodeJS.Timeout;
  lastPresenceAt: number | null;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const ONVIF_RETRY_MAX_MS = 5 * 60_000;
const sharedClients = new Map<string, SharedBrokerClient>();
const connectingClients = new Map<string, { fingerprint: string; promise: Promise<SharedBrokerClient> }>();
const brokerStatuses = new Map<string, BrokerStatus>();
const routeRuntimes = new Map<string, RouteBridgeRuntime>();
const routeOperations = new Map<string, Promise<void>>();
const routeGenerations = new Map<string, number>();
const pendingCommands = new Map<string, PtzCommandInput>();
const commandPumps = new Set<string>();
const invalidLogAt = new Map<string, number>();
const noop = (): void => undefined;

function brokerFingerprint(config: MqttBrokerRuntimeConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function mqttUrl(config: MqttBrokerRuntimeConfig): string {
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  const path = config.protocol === 'ws' || config.protocol === 'wss' ? config.path : '';
  return `${config.protocol}://${host}:${config.port}${path}`;
}

function setBrokerStatus(brokerId: string, state: ConnectionState, message: string): BrokerStatus {
  const status = { state, message, checkedAt: new Date().toISOString() };
  brokerStatuses.set(brokerId, status);
  return status;
}

export function getMqttBrokerConnectionStatus(brokerId: string): BrokerStatus {
  return brokerStatuses.get(brokerId) ?? {
    state: 'UNTESTED',
    checkedAt: null,
    message: 'Broker belum diuji'
  };
}

export function parseMqttBridgeCommand(payload: Buffer | string): PtzCommandInput | null {
  try {
    const value = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : payload) as Record<string, unknown>;
    const durationMs = value.durationMs === undefined ? 0 : value.durationMs;
    if (!Number.isInteger(durationMs) || Number(durationMs) < 0 || Number(durationMs) > 5000) return null;
    if (value.type === 'stop') {
      if (value.direction !== 'stop') return null;
      return { type: 'stop', direction: 'stop', speed: 0.4, durationMs: 0 };
    }
    if (typeof value.speed !== 'number' || !Number.isFinite(value.speed)) return null;
    if (value.type === 'move') {
      if (!['left', 'up', 'right', 'down'].includes(String(value.direction))) return null;
      if (value.speed < 0.1 || value.speed > 1) return null;
      return {
        type: 'move',
        direction: value.direction as 'left' | 'up' | 'right' | 'down',
        speed: value.speed,
        durationMs: Number(durationMs)
      };
    }
    if (value.type === 'zoom') {
      if (value.direction !== 'null' || Math.abs(value.speed) < 0.1 || Math.abs(value.speed) > 1) return null;
      return {
        type: 'zoom',
        direction: value.speed > 0 ? 'in' : 'out',
        speed: Math.abs(value.speed),
        durationMs: Number(durationMs)
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function publishBrokerCatalog(shared: SharedBrokerClient): Promise<void> {
  if (sharedClients.get(shared.config.id) !== shared) return;
  await withMqttTimeout(publishCameraCatalog(shared.client, shared.config), 'Publish katalog kamera MQTT').catch(noop);
}

/**
 * Katalog broker dipublikasikan saat presence berubah (start/stop route, reconnect) dan oleh
 * timer per broker; heartbeat per route memakai `includeCatalog = false` agar N route tidak
 * membangun katalog N kali setiap 15 detik.
 */
async function publishPresence(
  runtime: RouteBridgeRuntime,
  status: 'online' | 'offline',
  reason?: string,
  includeCatalog = true
): Promise<void> {
  const results = await Promise.allSettled(runtime.assignments.map(async (assignment) => {
    const shared = sharedClients.get(assignment.brokerId);
    if (!shared?.client.connected) return false;
    await withMqttTimeout(shared.client.publishAsync(
      assignment.statusTopic,
      buildCameraPresencePayload({
        status,
        cameraId: assignment.cameraId,
        cameraName: runtime.cameraName,
        description: runtime.description,
        ...(reason ? { reason } : {})
      }),
      { qos: 0, retain: false }
    ), 'Publish presence MQTT');
    return true;
  }));
  if (results.some((result) => result.status === 'fulfilled' && result.value)) {
    runtime.lastPresenceAt = Date.now();
  }
  if (!includeCatalog) return;
  await Promise.allSettled([...new Set(runtime.assignments.map((item) => item.brokerId))].map(async (brokerId) => {
    const shared = sharedClients.get(brokerId);
    if (shared) await publishBrokerCatalog(shared);
  }));
}

async function pumpRouteCommands(routeId: string): Promise<void> {
  if (commandPumps.has(routeId)) return;
  commandPumps.add(routeId);
  try {
    while (pendingCommands.has(routeId)) {
      const command = pendingCommands.get(routeId);
      pendingCommands.delete(routeId);
      if (!command) continue;
      const runtime = routeRuntimes.get(routeId);
      if (!runtime?.active || !runtime.onvifConnected) continue;
      const config = await getStoredPtzConfig('ROUTE', routeId);
      if (!config || config.provider !== 'ONVIF') continue;
      await executePtzCommand('ROUTE', routeId, config, command);
    }
  } catch (error) {
    await appendRouteLog(routeId, 'error', `MQTT→ONVIF command gagal: ${(error as Error).message}`).catch(noop);
  } finally {
    commandPumps.delete(routeId);
    if (pendingCommands.has(routeId)) void pumpRouteCommands(routeId);
  }
}

function queueCommand(routeId: string, command: PtzCommandInput): void {
  const current = pendingCommands.get(routeId);
  if (command.type === 'stop' || current?.type !== 'stop') {
    pendingCommands.set(routeId, command);
  }
  void pumpRouteCommands(routeId);
}

async function handleMessage(topic: string, payload: Buffer, retained: boolean, shared: SharedBrokerClient): Promise<void> {
  if (retained) return;
  const routeId = shared.topics.get(topic);
  if (!routeId) return;
  const command = parseMqttBridgeCommand(payload);
  if (!command) {
    const now = Date.now();
    if (now - (invalidLogAt.get(routeId) ?? 0) >= 10_000) {
      invalidLogAt.set(routeId, now);
      await appendRouteLog(routeId, 'warn', `Payload MQTT PTZ tidak valid pada topic ${topic}; pesan diabaikan.`);
    }
    return;
  }
  queueCommand(routeId, command);
}

async function connectSharedClient(
  brokerId: string,
  config: MqttBrokerRuntimeConfig,
  hash: string
): Promise<SharedBrokerClient> {
  const existing = sharedClients.get(brokerId);
  const preservedTopics = existing ? new Map(existing.topics) : new Map<string, string>();
  if (existing) {
    sharedClients.delete(brokerId);
    clearInterval(existing.catalogTimer);
    await closeMqttClient(existing.client);
  }
  setBrokerStatus(brokerId, 'CONNECTING', 'Menghubungkan ke broker MQTT');
  let client: MqttClient;
  try {
    client = await connectAsync(mqttUrl(config), {
      ...(config.username ? { username: config.username } : {}),
      ...(config.password ? { password: config.password } : {}),
      clientId: mqttClientId('stream-router-bridge', brokerId),
      clean: true,
      keepalive: MQTT_KEEPALIVE_SECONDS,
      connectTimeout: 5000,
      reconnectPeriod: 1000,
      resubscribe: true
    });
  } catch (error) {
    setBrokerStatus(brokerId, 'ERROR', (error as Error).message);
    throw new AppError('MQTT_BROKER_CONNECTION_FAILED', `Koneksi broker gagal: ${(error as Error).message}`, 502);
  }
  const shared: SharedBrokerClient = { fingerprint: hash, config, client, topics: preservedTopics };
  const replaced = sharedClients.get(brokerId);
  if (replaced) {
    clearInterval(replaced.catalogTimer);
    void closeMqttClient(replaced.client);
  }
  sharedClients.set(brokerId, shared);
  setBrokerStatus(brokerId, 'CONNECTED', 'Terhubung ke broker MQTT');
  shared.catalogTimer = setInterval(() => void publishBrokerCatalog(shared), HEARTBEAT_INTERVAL_MS);
  shared.catalogTimer.unref();
  client.on('message', (topic, payload, packet) => {
    void handleMessage(topic, payload, packet.retain, shared).catch(noop);
  });
  client.on('connect', () => {
    if (sharedClients.get(brokerId) !== shared) return;
    setBrokerStatus(brokerId, 'CONNECTED', 'Terhubung ke broker MQTT');
    if (shared.topics.size) {
      // SUBACK ditolak ACL atau koneksi putus sebelum SUBACK tidak boleh menjadi unhandledRejection.
      void withMqttTimeout(client.subscribeAsync([...shared.topics.keys()], { qos: 0 }), 'Subscribe ulang MQTT')
        .catch((error: Error) => setBrokerStatus(brokerId, 'ERROR', error.message));
    }
    for (const routeId of new Set(shared.topics.values())) {
      const runtime = routeRuntimes.get(routeId);
      if (runtime?.active && runtime.onvifConnected) void publishPresence(runtime, 'online', undefined, false);
    }
    void publishBrokerCatalog(shared);
  });
  client.on('reconnect', () => setBrokerStatus(brokerId, 'CONNECTING', 'Mencoba menghubungkan ulang broker MQTT'));
  client.on('offline', () => setBrokerStatus(brokerId, 'DISCONNECTED', 'Broker MQTT offline'));
  client.on('close', () => setBrokerStatus(brokerId, 'DISCONNECTED', 'Koneksi broker MQTT tertutup'));
  client.on('error', (error) => setBrokerStatus(brokerId, 'ERROR', error.message));
  if (shared.topics.size) {
    await withMqttTimeout(client.subscribeAsync([...shared.topics.keys()], { qos: 0 }), 'Subscribe MQTT')
      .catch((error: Error) => setBrokerStatus(brokerId, 'ERROR', error.message));
  }
  return shared;
}

/**
 * Satu client per broker. Koneksi yang sedang dibuat dipakai bersama oleh pemanggil lain
 * (refresh beberapa route serentak) agar tidak lahir client ganda yang saling takeover.
 */
async function ensureSharedClient(brokerId: string): Promise<SharedBrokerClient> {
  const config = await getMqttBrokerRuntimeConfig(brokerId);
  const hash = brokerFingerprint(config);
  for (;;) {
    const existing = sharedClients.get(brokerId);
    if (existing?.fingerprint === hash) return existing;
    const connecting = connectingClients.get(brokerId);
    if (!connecting) break;
    if (connecting.fingerprint === hash) return connecting.promise;
    await connecting.promise.catch(noop);
  }
  const entry = { fingerprint: hash, promise: connectSharedClient(brokerId, config, hash) };
  connectingClients.set(brokerId, entry);
  const cleanup = () => {
    if (connectingClients.get(brokerId) === entry) connectingClients.delete(brokerId);
  };
  entry.promise.then(cleanup, cleanup);
  return entry.promise;
}

async function closeIfIdle(brokerId: string, shared: SharedBrokerClient): Promise<void> {
  if (shared.topics.size > 0 || sharedClients.get(brokerId) !== shared) return;
  sharedClients.delete(brokerId);
  clearInterval(shared.catalogTimer);
  await closeMqttClient(shared.client);
  setBrokerStatus(brokerId, 'DISCONNECTED', 'Tidak ada route aktif yang menggunakan broker');
}

async function addSubscription(assignment: RouteAssignment, runtime: RouteBridgeRuntime): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shared = await ensureSharedClient(assignment.brokerId);
    if (!runtime.active) {
      await closeIfIdle(assignment.brokerId, shared);
      return;
    }
    // Client bisa ditutup route lain selama menunggu koneksi; ambil client terbaru.
    if (sharedClients.get(assignment.brokerId) !== shared) continue;
    shared.topics.set(assignment.commandTopic, runtime.routeId);
    try {
      await withMqttTimeout(shared.client.subscribeAsync(assignment.commandTopic, { qos: 0 }), 'Subscribe MQTT');
    } catch (error) {
      // Topic yang ditolak/timeout dilepas agar heartbeat mencoba ulang, bukan diulang di setiap reconnect.
      if (shared.topics.get(assignment.commandTopic) === runtime.routeId) shared.topics.delete(assignment.commandTopic);
      throw error;
    }
    return;
  }
  throw new AppError('MQTT_BROKER_CONNECTION_FAILED', 'Koneksi broker berganti saat subscribe; dicoba ulang pada heartbeat berikutnya', 502);
}

async function reconcileRouteSubscriptions(runtime: RouteBridgeRuntime): Promise<number> {
  const results = await Promise.allSettled(runtime.assignments.map(async (assignment) => {
    const current = sharedClients.get(assignment.brokerId);
    if (current?.topics.get(assignment.commandTopic) === runtime.routeId) return;
    await addSubscription(assignment, runtime);
  }));
  return results.filter((result) => result.status === 'fulfilled').length;
}

async function removeSubscription(assignment: RouteAssignment, routeId: string): Promise<void> {
  const shared = sharedClients.get(assignment.brokerId);
  if (!shared) return;
  if (shared.topics.get(assignment.commandTopic) === routeId) {
    shared.topics.delete(assignment.commandTopic);
    if (shared.client.connected) {
      await withMqttTimeout(shared.client.unsubscribeAsync(assignment.commandTopic), 'Unsubscribe MQTT').catch(noop);
    }
  }
  await closeIfIdle(assignment.brokerId, shared);
}

/**
 * Handshake ONVIF bridge. Kegagalan (kamera boot lebih lambat dari RTSP, jaringan putus sesaat)
 * tidak mematikan bridge; heartbeat mencoba ulang dengan backoff sampai berhasil.
 */
async function connectBridgeOnvif(runtime: RouteBridgeRuntime): Promise<boolean> {
  try {
    const config = await getStoredPtzConfig('ROUTE', runtime.routeId);
    if (!config || config.provider !== 'ONVIF') {
      throw new AppError('MQTT_BRIDGE_ONVIF_REQUIRED', 'Konfigurasi PTZ ONVIF tidak tersedia', 409);
    }
    await testPtzConnection('ROUTE', runtime.routeId, config);
  } catch (error) {
    if (!runtime.active) return false;
    runtime.onvifFailures += 1;
    runtime.nextOnvifAttemptAt = Date.now()
      + calculateBackoff(runtime.onvifFailures, HEARTBEAT_INTERVAL_MS, ONVIF_RETRY_MAX_MS, 0.2);
    if (runtime.onvifFailures === 1) {
      await appendRouteLog(
        runtime.routeId,
        'error',
        `MQTT bridge menunggu ONVIF (dicoba ulang otomatis): ${(error as Error).message}`
      );
    }
    return false;
  }
  if (!runtime.active) return false;
  runtime.onvifConnected = true;
  runtime.onvifFailures = 0;
  runtime.nextOnvifAttemptAt = 0;
  return true;
}

async function activateBridge(runtime: RouteBridgeRuntime): Promise<void> {
  if (!(await connectBridgeOnvif(runtime))) return;
  const connected = await reconcileRouteSubscriptions(runtime);
  if (!runtime.active) return;
  if (connected === 0 && runtime.assignments.length > 0) {
    await appendRouteLog(runtime.routeId, 'error', 'MQTT bridge gagal terhubung ke seluruh broker yang dipilih.');
  }
  await publishPresence(runtime, 'online');
  if (!runtime.active) return;
  await appendRouteLog(runtime.routeId, 'info', `MQTT→ONVIF bridge aktif pada ${connected}/${runtime.assignments.length} broker.`);
}

async function runHeartbeat(runtime: RouteBridgeRuntime): Promise<void> {
  if (!runtime.active || runtime.busy) return;
  runtime.busy = true;
  try {
    if (!runtime.onvifConnected) {
      if (Date.now() >= runtime.nextOnvifAttemptAt) await activateBridge(runtime);
      return;
    }
    await reconcileRouteSubscriptions(runtime);
    if (runtime.active) await publishPresence(runtime, 'online', undefined, false);
  } catch {
    // Kegagalan log/DB pada heartbeat dicoba lagi pada tick berikutnya.
  } finally {
    runtime.busy = false;
  }
}

async function startBridge(routeId: string, generation: number): Promise<void> {
  await stopBridge(routeId, 'bridge_reconfigured');
  const isLatest = () => routeGenerations.get(routeId) === generation;
  if (!isLatest()) return;
  const route = await prisma.streamRoute.findUnique({
    where: { id: routeId },
    include: { mqttBridgeSubscriptions: { include: { broker: true } } }
  });
  if (!isLatest() || !route?.mqttBridgeEnabled || route.ptzProvider !== 'ONVIF' || !route.ptzEnabled) return;
  const config = await getStoredPtzConfig('ROUTE', routeId);
  if (!isLatest() || !config || config.provider !== 'ONVIF') return;
  const assignments = route.mqttBridgeSubscriptions.map((item) => ({
    brokerId: item.brokerId,
    cameraId: item.commandTopic.startsWith(`${item.broker.rootTopic}/`)
      ? item.commandTopic.slice(item.broker.rootTopic.length + 1)
      : item.commandTopic.split('/').at(-1) ?? item.commandTopic,
    commandTopic: item.commandTopic,
    statusTopic: `${item.commandTopic}/status`
  }));
  const runtime: RouteBridgeRuntime = {
    routeId,
    cameraName: route.name,
    description: route.description,
    active: true,
    onvifConnected: false,
    onvifFailures: 0,
    nextOnvifAttemptAt: 0,
    busy: true,
    assignments,
    lastPresenceAt: null
  };
  routeRuntimes.set(routeId, runtime);
  runtime.heartbeatTimer = setInterval(() => void runHeartbeat(runtime), HEARTBEAT_INTERVAL_MS);
  runtime.heartbeatTimer.unref();
  try {
    await activateBridge(runtime);
  } finally {
    runtime.busy = false;
  }
}

async function stopBridge(routeId: string, reason: string): Promise<void> {
  const runtime = routeRuntimes.get(routeId);
  pendingCommands.delete(routeId);
  if (!runtime) return;
  runtime.active = false;
  if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
  await publishPresence(runtime, 'offline', reason);
  await Promise.allSettled(runtime.assignments.map((assignment) => removeSubscription(assignment, routeId)));
  if (routeRuntimes.get(routeId) === runtime) routeRuntimes.delete(routeId);
}

/**
 * Start/stop/refresh satu route berjalan berurutan; promise yang disimpan tidak pernah reject.
 * Tanpa ini dua start serentak meninggalkan runtime yatim yang terus mengumumkan `online`.
 */
function serializeRoute(routeId: string, operation: () => Promise<void>): Promise<void> {
  const previous = routeOperations.get(routeId) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(noop, noop);
  routeOperations.set(routeId, settled);
  void settled.then(() => {
    if (routeOperations.get(routeId) === settled) routeOperations.delete(routeId);
  });
  return current;
}

/** Permintaan terbaru menang: runtime lama langsung berhenti menerima perintah dan heartbeat. */
function supersedeRoute(routeId: string): number {
  const generation = (routeGenerations.get(routeId) ?? 0) + 1;
  routeGenerations.set(routeId, generation);
  const runtime = routeRuntimes.get(routeId);
  if (runtime) runtime.active = false;
  pendingCommands.delete(routeId);
  return generation;
}

export async function startMqttOnvifBridge(routeId: string): Promise<void> {
  const generation = supersedeRoute(routeId);
  await serializeRoute(routeId, () => startBridge(routeId, generation));
}

export async function stopMqttOnvifBridge(routeId: string, reason = 'route_stopped'): Promise<void> {
  supersedeRoute(routeId);
  await serializeRoute(routeId, () => stopBridge(routeId, reason));
}

export async function refreshMqttOnvifBridge(routeId: string, routeRunning: boolean): Promise<void> {
  if (!routeRunning) {
    await stopMqttOnvifBridge(routeId, 'route_not_running');
    return;
  }
  await startMqttOnvifBridge(routeId);
}

export async function testMqttBrokerConnection(brokerId: string): Promise<BrokerStatus> {
  const config = await getMqttBrokerRuntimeConfig(brokerId);
  setBrokerStatus(brokerId, 'CONNECTING', 'Menguji koneksi broker MQTT');
  let client: MqttClient | undefined;
  try {
    client = await connectAsync(mqttUrl(config), {
      ...(config.username ? { username: config.username } : {}),
      ...(config.password ? { password: config.password } : {}),
      clean: true,
      connectTimeout: 5000,
      reconnectPeriod: 0
    });
    return setBrokerStatus(brokerId, 'CONNECTED', 'Credential diterima dan broker MQTT terhubung');
  } catch (error) {
    setBrokerStatus(brokerId, 'ERROR', (error as Error).message);
    throw new AppError('MQTT_BROKER_CONNECTION_FAILED', `Koneksi broker gagal: ${(error as Error).message}`, 502);
  } finally {
    if (client) await closeMqttClient(client);
  }
}

export function getMqttBridgeRuntimeStatus(routeId: string): Record<string, unknown> {
  const runtime = routeRuntimes.get(routeId);
  return {
    active: Boolean(runtime?.active),
    onvifConnected: Boolean(runtime?.onvifConnected),
    lastPresenceAt: runtime?.lastPresenceAt ?? null
  };
}

export async function shutdownMqttBridgeRuntime(): Promise<void> {
  const routeIds = new Set([...routeRuntimes.keys(), ...routeOperations.keys()]);
  await Promise.allSettled([...routeIds].map((routeId) => stopMqttOnvifBridge(routeId, 'server_shutdown')));
  await Promise.allSettled([...connectingClients.values()].map(({ promise }) => promise));
  for (const shared of sharedClients.values()) clearInterval(shared.catalogTimer);
  await Promise.allSettled([...sharedClients.values()].map(({ client }) => closeMqttClient(client)));
  sharedClients.clear();
  brokerStatuses.clear();
  routeRuntimes.clear();
  pendingCommands.clear();
}
