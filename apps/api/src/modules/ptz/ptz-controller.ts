import { createHash } from 'node:crypto';
import { Cam } from 'onvif/promises/index.js';
import { connectAsync, type MqttClient } from 'mqtt';
import type { PtzCommandInput } from '@stream-router/contracts';
import { AppError } from '../../shared/errors.js';
import { publishCameraCatalog, publishPtzCameraPresence } from '../mqtt-bridge/camera-status-publisher.js';
import { closeMqttClient, MQTT_KEEPALIVE_SECONDS, mqttClientId, withMqttTimeout } from '../mqtt-bridge/mqtt-io.js';
import type { PtzTargetType, StoredPtzConfig } from './ptz-service.js';
import {
  clearPtzConnectionStatuses,
  setPtzConnectionStatus,
  type PtzConnectionStatus
} from './ptz-status.js';

type MqttPtzConfig = Extract<StoredPtzConfig, { provider: 'MQTT' }>;
type OnvifPtzConfig = Extract<StoredPtzConfig, { provider: 'ONVIF' }>;

interface CachedMqtt {
  fingerprint: string;
  client: MqttClient;
  config: MqttPtzConfig;
  targets: Map<string, {
    targetType: PtzTargetType;
    targetId: string;
    config: MqttPtzConfig;
  }>;
  catalogTimer: NodeJS.Timeout;
}

interface CachedOnvif {
  fingerprint: string;
  cam: Cam;
  profileToken: string;
}

interface PendingCommand {
  cancel: () => void;
}

const DEAD_MAN_MS = 1200;
const mqttClients = new Map<string, CachedMqtt>();
const mqttConnecting = new Map<string, { fingerprint: string; promise: Promise<CachedMqtt> }>();
const onvifCameras = new Map<string, CachedOnvif>();
const deadManTimers = new Map<string, NodeJS.Timeout>();
const commandQueues = new Map<string, Promise<void>>();
const pendingCommands = new Map<string, PendingCommand>();
const noop = (): void => undefined;

function key(targetType: PtzTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}

function fingerprint(config: StoredPtzConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function mqttFingerprint(config: MqttPtzConfig): string {
  return createHash('sha256').update(JSON.stringify({
    brokerId: config.brokerId,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    path: config.path
  })).digest('hex');
}

function connectionError(error: unknown, provider: StoredPtzConfig['provider']): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/media profile token.*tidak ditemukan/.test(message)) {
    return 'Media Profile Token ONVIF tidak ditemukan pada kamera. Periksa token channel, misalnya 000 atau 100.';
  }
  if (/auth|unauthor|forbidden|401|not authorized|bad user/.test(message)) {
    return `Autentikasi ${provider} ditolak. Periksa username dan password.`;
  }
  if (/timeout|timed out|etimedout/.test(message)) {
    return `Koneksi ${provider} timeout. Periksa host, port, firewall, dan jaringan kamera.`;
  }
  if (/refused|econnrefused/.test(message)) {
    return `Koneksi ${provider} ditolak oleh host. Periksa alamat, port, dan service yang berjalan.`;
  }
  if (/enotfound|getaddrinfo|name or service not known/.test(message)) {
    return `Host ${provider} tidak ditemukan. Periksa hostname atau alamat IP.`;
  }
  if (/certificate|self.signed|tls|ssl/.test(message)) {
    return `Negosiasi TLS ${provider} gagal. Periksa protocol, sertifikat, dan pengaturan TLS.`;
  }
  return `Handshake ${provider} gagal. Periksa credential, endpoint, dan dukungan PTZ perangkat.`;
}

function enqueue(targetKey: string, operation: () => Promise<void>): Promise<void> {
  const previous = commandQueues.get(targetKey) ?? Promise.resolve();
  const current = previous.catch(noop).then(operation);
  commandQueues.set(targetKey, current);
  // Jangan memakai `current.finally()`: promise turunannya ikut reject tanpa handler, sehingga
  // setiap perintah gagal menjadi unhandledRejection yang mematikan proses API.
  const cleanup = () => {
    if (commandQueues.get(targetKey) === current) commandQueues.delete(targetKey);
  };
  current.then(cleanup, cleanup);
  return current;
}

function supersedePendingCommand(targetKey: string): void {
  const pending = pendingCommands.get(targetKey);
  pendingCommands.delete(targetKey);
  pending?.cancel();
}

/**
 * Hanya satu perintah per target yang menunggu giliran; perintah terbaru menggantikan yang
 * belum terkirim. Keepalive Viewer tidak menumpuk di belakang kamera lambat, dan stop langsung
 * berjalan setelah perintah yang sedang dikirim. Resolve `false` bila perintah digantikan.
 */
function scheduleCommand(targetKey: string, operation: () => Promise<void>): Promise<boolean> {
  supersedePendingCommand(targetKey);
  return new Promise<boolean>((resolve, reject) => {
    let superseded = false;
    const entry: PendingCommand = {
      cancel: () => {
        superseded = true;
        resolve(false);
      }
    };
    pendingCommands.set(targetKey, entry);
    enqueue(targetKey, async () => {
      if (pendingCommands.get(targetKey) === entry) pendingCommands.delete(targetKey);
      if (superseded) return;
      await operation();
    }).then(() => resolve(!superseded), reject);
  });
}

function clearDeadMan(targetKey: string): void {
  const timer = deadManTimers.get(targetKey);
  if (timer) clearTimeout(timer);
  deadManTimers.delete(targetKey);
}

function armDeadMan(
  targetType: PtzTargetType,
  targetId: string,
  config: StoredPtzConfig,
  delayMs = DEAD_MAN_MS
): void {
  const targetKey = key(targetType, targetId);
  clearDeadMan(targetKey);
  const timer = setTimeout(() => {
    if (deadManTimers.get(targetKey) === timer) deadManTimers.delete(targetKey);
    scheduleCommand(targetKey, () => sendStop(targetType, targetId, config)).catch((error: unknown) => {
      setPtzConnectionStatus(targetType, targetId, 'ERROR', connectionError(error, config.provider), true);
    });
  }, delayMs);
  deadManTimers.set(targetKey, timer);
}

function mqttUrl(config: MqttPtzConfig): string {
  const bracketedHost = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  const path = config.protocol === 'ws' || config.protocol === 'wss' ? config.path : '';
  return `${config.protocol}://${bracketedHost}:${config.port}${path}`;
}

async function connectMqtt(config: MqttPtzConfig, hash: string): Promise<CachedMqtt> {
  const previous = mqttClients.get(config.brokerId);
  if (previous) {
    mqttClients.delete(config.brokerId);
    clearInterval(previous.catalogTimer);
    await closeMqttClient(previous.client);
  }
  const client = await connectAsync(mqttUrl(config), {
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    clientId: mqttClientId('stream-router-ptz', config.brokerId),
    clean: true,
    keepalive: MQTT_KEEPALIVE_SECONDS,
    connectTimeout: 5000,
    reconnectPeriod: 1000
  });
  const targets: CachedMqtt['targets'] = previous?.fingerprint === hash ? previous.targets : new Map();
  const publishHeartbeat = async () => {
    try {
      await Promise.allSettled([...targets.values()].map((target) => withMqttTimeout(
        publishPtzCameraPresence(client, target.config, target.targetType, target.targetId, 'online'),
        'Publish presence PTZ MQTT'
      )));
      await withMqttTimeout(publishCameraCatalog(client, config), 'Publish katalog kamera MQTT');
    } catch {
      // Heartbeat best-effort: client bisa ditutup release di tengah publish; tick berikutnya mencoba lagi.
    }
  };
  const catalogTimer = setInterval(() => void publishHeartbeat(), 15_000);
  catalogTimer.unref();
  const cached: CachedMqtt = { fingerprint: hash, client, config, targets, catalogTimer };
  mqttClients.set(config.brokerId, cached);
  const isCurrent = () => mqttClients.get(config.brokerId)?.client === client;
  const updateTargets = (state: Parameters<typeof setPtzConnectionStatus>[2], message: string, checked = false) => {
    if (!isCurrent()) return;
    for (const target of cached.targets.values()) {
      setPtzConnectionStatus(target.targetType, target.targetId, state, message, checked);
    }
  };
  client.on('connect', () => {
    updateTargets('CONNECTED', 'Terhubung ke broker MQTT bersama', true);
    void publishHeartbeat();
  });
  client.on('reconnect', () => {
    updateTargets('CONNECTING', 'Mencoba menghubungkan ulang broker MQTT');
  });
  client.on('offline', () => {
    updateTargets('DISCONNECTED', 'Koneksi broker MQTT terputus');
  });
  client.on('close', () => {
    updateTargets('DISCONNECTED', 'Koneksi broker MQTT tertutup');
  });
  client.on('error', (error) => {
    updateTargets('ERROR', connectionError(error, 'MQTT'), true);
  });
  void publishHeartbeat();
  return cached;
}

/**
 * Satu client MQTT per broker. Koneksi yang sedang dibuat dipakai bersama oleh pemanggil lain,
 * sehingga perintah/tes serentak tidak membuat client ganda yang saling takeover dan bocor.
 */
async function sharedMqtt(config: MqttPtzConfig): Promise<CachedMqtt> {
  const hash = mqttFingerprint(config);
  for (;;) {
    const existing = mqttClients.get(config.brokerId);
    if (existing?.fingerprint === hash && existing.client.connected) return existing;
    const connecting = mqttConnecting.get(config.brokerId);
    if (!connecting) break;
    if (connecting.fingerprint === hash) return connecting.promise;
    await connecting.promise.catch(noop);
  }
  const entry = { fingerprint: hash, promise: connectMqtt(config, hash) };
  mqttConnecting.set(config.brokerId, entry);
  const cleanup = () => {
    if (mqttConnecting.get(config.brokerId) === entry) mqttConnecting.delete(config.brokerId);
  };
  entry.promise.then(cleanup, cleanup);
  return entry.promise;
}

async function mqttClient(
  targetType: PtzTargetType,
  targetId: string,
  config: MqttPtzConfig
): Promise<MqttClient> {
  const cached = await sharedMqtt(config);
  cached.targets.set(key(targetType, targetId), { targetType, targetId, config });
  void withMqttTimeout(
    publishPtzCameraPresence(cached.client, config, targetType, targetId, 'online'),
    'Publish presence PTZ MQTT'
  ).catch(noop);
  return cached.client;
}

export function onvifProfileOptions(profileToken?: string): { profileToken?: string } {
  return profileToken ? { profileToken } : {};
}

function forgetOnvifCamera(targetKey: string, cam: Cam): void {
  if (onvifCameras.get(targetKey)?.cam === cam) onvifCameras.delete(targetKey);
}

async function onvifCamera(
  targetType: PtzTargetType,
  targetId: string,
  config: OnvifPtzConfig,
  fresh = false
): Promise<Cam> {
  const targetKey = key(targetType, targetId);
  const hash = fingerprint(config);
  const existing = onvifCameras.get(targetKey);
  if (!fresh && existing?.fingerprint === hash) return existing.cam;
  const cam = new Cam({
    hostname: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    useSecure: config.useTls,
    path: config.path,
    timeout: 5000,
    preserveAddress: true
  });
  try {
    await cam.connect();
    if (config.profileToken) {
      const available = cam.profiles?.some((profile) => profile.$?.token === config.profileToken) ?? false;
      if (!available) {
        throw new Error(`Media Profile Token ONVIF "${config.profileToken}" tidak ditemukan`);
      }
    }
  } catch (error) {
    if (existing) forgetOnvifCamera(targetKey, existing.cam);
    throw error;
  }
  onvifCameras.set(targetKey, { fingerprint: hash, cam, profileToken: config.profileToken ?? '' });
  return cam;
}

/**
 * Cam yang gagal dibuang dari cache supaya perintah berikutnya handshake ulang dan menghitung
 * ulang timeShift/capability, bukan mengulang kegagalan yang sama sampai service restart.
 */
async function withOnvifCamera(
  targetType: PtzTargetType,
  targetId: string,
  config: OnvifPtzConfig,
  action: (cam: Cam) => Promise<unknown>
): Promise<void> {
  const cam = await onvifCamera(targetType, targetId, config);
  try {
    await action(cam);
  } catch (error) {
    forgetOnvifCamera(key(targetType, targetId), cam);
    throw error;
  }
}

async function sendStop(targetType: PtzTargetType, targetId: string, config: StoredPtzConfig): Promise<void> {
  const payload: PtzCommandInput = { type: 'stop', direction: 'stop', speed: 0.4, durationMs: 0 };
  if (config.provider === 'MQTT') {
    const client = await mqttClient(targetType, targetId, config);
    await client.publishAsync(config.fullTopic, mqttPayload(payload), { qos: 0, retain: false });
    return;
  }
  await withOnvifCamera(targetType, targetId, config, (cam) => (
    cam.stop({ ...onvifProfileOptions(config.profileToken), panTilt: true, zoom: true })
  ));
}

async function sendCommand(
  targetType: PtzTargetType,
  targetId: string,
  config: StoredPtzConfig,
  command: PtzCommandInput
): Promise<void> {
  if (config.provider === 'MQTT') {
    const client = await mqttClient(targetType, targetId, config);
    await client.publishAsync(config.fullTopic, mqttPayload(command), { qos: 0, retain: false });
    return;
  }
  await withOnvifCamera(targetType, targetId, config, async (cam) => {
    if (command.type === 'stop') {
      await cam.stop({ ...onvifProfileOptions(config.profileToken), panTilt: true, zoom: true });
      return;
    }
    if (command.type === 'zoom') {
      await cam.continuousMove({
        ...onvifProfileOptions(config.profileToken),
        zoom: command.direction === 'in' ? command.speed : -command.speed,
        onlySendZoom: true,
        ...(command.durationMs > 0 ? { timeout: command.durationMs } : {})
      });
      return;
    }
    const vector = {
      left: { x: -command.speed, y: 0 },
      right: { x: command.speed, y: 0 },
      up: { x: 0, y: command.speed },
      down: { x: 0, y: -command.speed }
    }[command.direction];
    await cam.continuousMove({
      ...onvifProfileOptions(config.profileToken),
      ...vector,
      onlySendPanTilt: true,
      ...(command.durationMs > 0 ? { timeout: command.durationMs } : {})
    });
  });
}

export function mqttPayload(command: PtzCommandInput): string {
  if (command.type === 'zoom') {
    return JSON.stringify({
      type: 'zoom',
      direction: 'null',
      speed: command.direction === 'in' ? command.speed : -command.speed,
      durationMs: command.durationMs
    });
  }
  return JSON.stringify(command);
}

/**
 * `fresh` memaksa handshake ONVIF baru tanpa memakai Cam di cache, sehingga hasil tes
 * mencerminkan kondisi kamera saat ini, bukan koneksi yang pernah berhasil.
 */
export async function testPtzConnection(
  targetType: PtzTargetType,
  targetId: string,
  config: StoredPtzConfig,
  options: { fresh?: boolean } = {}
): Promise<PtzConnectionStatus> {
  if (!config.enabled) throw new AppError('PTZ_DISABLED', 'Aktifkan PTZ sebelum menguji koneksi', 409);
  setPtzConnectionStatus(targetType, targetId, 'CONNECTING', `Menguji handshake ${config.provider}`);
  try {
    if (config.provider === 'MQTT') await mqttClient(targetType, targetId, config);
    else await onvifCamera(targetType, targetId, config, options.fresh ?? false);
    return setPtzConnectionStatus(
      targetType,
      targetId,
      'CONNECTED',
      config.provider === 'MQTT' ? 'Credential diterima dan broker MQTT terhubung' : 'Credential diterima dan endpoint ONVIF merespons',
      true
    );
  } catch (error) {
    const message = connectionError(error, config.provider);
    setPtzConnectionStatus(targetType, targetId, 'ERROR', message, true);
    throw new AppError('PTZ_CONNECTION_FAILED', message, 502);
  }
}

/**
 * Mengembalikan `false` bila perintah digantikan perintah yang lebih baru sebelum terkirim.
 */
export async function executePtzCommand(
  targetType: PtzTargetType,
  targetId: string,
  config: StoredPtzConfig,
  command: PtzCommandInput
): Promise<boolean> {
  if (!config.enabled) throw new AppError('PTZ_DISABLED', 'PTZ tidak diaktifkan untuk stream ini', 409);
  if (command.type === 'zoom' && !config.zoomEnabled) {
    throw new AppError('PTZ_ZOOM_UNAVAILABLE', 'Zoom PTZ tidak tersedia untuk stream ini', 409);
  }
  const targetKey = key(targetType, targetId);
  // Dead-man diukur dari kedatangan perintah, bukan dari keberhasilan kirim: keepalive yang gagal
  // tidak boleh mematikan perlindungan ketika kamera mungkin sudah bergerak.
  if (command.type === 'stop') clearDeadMan(targetKey);
  else armDeadMan(targetType, targetId, config, command.durationMs > 0 ? command.durationMs + DEAD_MAN_MS : DEAD_MAN_MS);
  let executed: boolean;
  try {
    executed = await scheduleCommand(targetKey, () => sendCommand(targetType, targetId, config, command));
  } catch (error) {
    // Stop yang gagal dicoba sekali lagi oleh dead-man bila belum ada perintah baru.
    if (command.type === 'stop' && !deadManTimers.has(targetKey)) armDeadMan(targetType, targetId, config);
    const message = connectionError(error, config.provider);
    setPtzConnectionStatus(targetType, targetId, 'ERROR', message, true);
    throw new AppError('PTZ_COMMAND_FAILED', message, 502);
  }
  if (executed) {
    setPtzConnectionStatus(targetType, targetId, 'CONNECTED', `Perintah berhasil dikirim melalui ${config.provider}`, true);
  }
  return executed;
}

export async function releasePtzTarget(targetType: PtzTargetType, targetId: string): Promise<void> {
  const targetKey = key(targetType, targetId);
  clearDeadMan(targetKey);
  supersedePendingCommand(targetKey);

  const camera = onvifCameras.get(targetKey);
  if (camera) {
    await enqueue(targetKey, async () => {
      await camera.cam.stop({
        ...onvifProfileOptions(camera.profileToken),
        panTilt: true,
        zoom: true
      });
    }).catch(noop);
    forgetOnvifCamera(targetKey, camera.cam);
  }

  for (const [brokerId, mqtt] of mqttClients) {
    const target = mqtt.targets.get(targetKey);
    if (!target) continue;
    await withMqttTimeout(
      publishPtzCameraPresence(mqtt.client, target.config, targetType, targetId, 'offline', 'ptz_released'),
      'Publish presence PTZ MQTT'
    ).catch(noop);
    mqtt.targets.delete(targetKey);
    if (mqtt.targets.size === 0 && mqttClients.get(brokerId) === mqtt) {
      mqttClients.delete(brokerId);
      clearInterval(mqtt.catalogTimer);
      await closeMqttClient(mqtt.client);
    }
    break;
  }
  setPtzConnectionStatus(targetType, targetId, 'DISCONNECTED', 'Koneksi PTZ ditutup');
}

export async function shutdownPtzControllers(): Promise<void> {
  for (const timer of deadManTimers.values()) clearTimeout(timer);
  deadManTimers.clear();
  for (const targetKey of [...pendingCommands.keys()]) supersedePendingCommand(targetKey);
  await Promise.allSettled([...onvifCameras.entries()].map(([targetKey, camera]) => enqueue(targetKey, async () => {
    await camera.cam.stop({
      ...onvifProfileOptions(camera.profileToken),
      panTilt: true,
      zoom: true
    });
  })));
  await Promise.allSettled([...mqttConnecting.values()].map(({ promise }) => promise));
  for (const mqtt of mqttClients.values()) clearInterval(mqtt.catalogTimer);
  await Promise.allSettled([...mqttClients.values()].map(({ client }) => closeMqttClient(client)));
  onvifCameras.clear();
  mqttClients.clear();
  clearPtzConnectionStatuses();
}
