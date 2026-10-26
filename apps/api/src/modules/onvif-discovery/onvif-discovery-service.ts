import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import onvifPromises, { type Cam as OnvifCam } from 'onvif/promises/index.js';
import type { CreateRouteInput } from '@stream-router/contracts';
import { createRouteSchema, ptzConfigSchema } from '@stream-router/contracts';
import { redactUrl } from '@stream-router/ffmpeg';
import { AppError } from '../../shared/errors.js';
import {
  audit,
  availableCameraKey,
  createRoute,
  deleteRoute,
  getRuntimeRoute,
  listRoutes,
  toRouteDto
} from '../routes/route-service.js';
import { getStoredPtzConfig, savePtzConfig } from '../ptz/ptz-service.js';

const { Cam, Discovery } = onvifPromises;

export interface OnvifTarget {
  host: string;
  port: number;
  path: string;
  useTls: boolean;
  urn?: string | undefined;
}

export interface DiscoveryDevice extends OnvifTarget {
  id: string;
  name: string;
  scopes: string[];
  xaddrs: string[];
  existingRoutes: ExistingRoute[];
}

export interface ExistingRoute {
  id: string;
  name: string;
  cameraKey: string;
  profileToken: string;
}

export interface InspectionProfile {
  token: string;
  name: string;
  encoding: string;
  width: number | null;
  height: number | null;
  ptz: boolean;
  zoom: boolean;
  streamAvailable: boolean;
  streamUriMasked: string | null;
  error: string | null;
}

interface InspectionSession {
  id: string;
  expiresAt: number;
  target: OnvifTarget;
  username: string;
  password: string;
  profiles: InspectionProfile[];
  streamUris: Map<string, string>;
}

export interface InspectionResult {
  sessionId: string;
  expiresAt: string;
  target: OnvifTarget;
  device: {
    manufacturer: string;
    model: string;
    hostname: string;
    firmwareVersion: string;
    serialNumber: string;
  };
  profiles: InspectionProfile[];
  suggestedName: string;
  suggestedCameraKey: string;
  existingRoutes: ExistingRoute[];
}

export interface RawDiscoveryDevice {
  urn?: string | undefined;
  host: string;
  port: number;
  path: string;
  useTls: boolean;
  scopes?: string[] | undefined;
  xaddrs?: string[] | undefined;
}

export interface RawInspection {
  device: InspectionResult['device'];
  profiles: Array<Omit<InspectionProfile, 'streamAvailable' | 'streamUriMasked' | 'error'> & {
    streamUri?: string | undefined;
    error?: string | undefined;
  }>;
}

export interface DiscoveryAdapter {
  scan(input: { interfaceName?: string | undefined; timeoutMs: number }): Promise<RawDiscoveryDevice[]>;
  inspect(target: OnvifTarget, credentials: { username: string; password: string }): Promise<RawInspection>;
}

const SESSION_TTL_MS = 10 * 60_000;
const sessions = new Map<string, InspectionSession>();
const importingSessions = new Set<string>();
let scanRunning = false;
let inspectRunning = false;

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function xmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'');
}

function valuesFromProbeXml(xml: string, tagName: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagName}>`,
    'gi'
  );
  return [...xml.matchAll(pattern)]
    .map((match) => xmlEntities(match[1]?.trim() ?? ''))
    .filter(Boolean);
}

export function scopesFromProbeXml(xml = ''): string[] {
  return valuesFromProbeXml(xml, 'Scopes').flatMap((value) => value.split(/\s+/).filter(Boolean));
}

export function xaddrsFromProbeXml(xml = ''): string[] {
  return valuesFromProbeXml(xml, 'XAddrs').flatMap((value) => value.split(/\s+/).filter(Boolean));
}

function urnFromProbeXml(xml = ''): string | undefined {
  const endpoint = xml.match(
    /<(?:[\w-]+:)?EndpointReference(?:\s[^>]*)?>[\s\S]*?<(?:[\w-]+:)?Address(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?Address>[\s\S]*?<\/(?:[\w-]+:)?EndpointReference>/i
  );
  const value = endpoint?.[1] ? xmlEntities(endpoint[1].trim()) : '';
  return value || undefined;
}

function nameFromScopes(scopes: string[]): string {
  const value = scopes.find((scope) => /\/name\//i.test(scope));
  return value ? safeDecode(value.slice(value.toLowerCase().lastIndexOf('/name/') + 6)) : '';
}

function targetFromXaddr(value: string, fallbackHost = ''): OnvifTarget | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return {
      host: url.hostname || fallbackHost,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      path: url.pathname || '/onvif/device_service',
      useTls: url.protocol === 'https:'
    };
  } catch {
    return null;
  }
}

function unusableAdvertisedHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return !normalized
    || normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '127.0.0.1'
    || normalized === '::'
    || normalized === '::1';
}

/**
 * Converts a WS-Discovery response into a usable endpoint. Some cameras omit
 * XAddrs or advertise a wildcard/localhost address; in that case the UDP
 * sender address is the safest endpoint fallback.
 */
export function discoveryDeviceFromProbe(xml = '', remoteAddress = ''): RawDiscoveryDevice | null {
  const xaddrs = xaddrsFromProbeXml(xml);
  let primary: OnvifTarget | null = null;
  for (const xaddr of xaddrs) {
    primary = targetFromXaddr(xaddr, remoteAddress);
    if (primary) break;
  }
  if (primary && remoteAddress && unusableAdvertisedHost(primary.host)) {
    primary = { ...primary, host: remoteAddress };
  }
  if (!primary && remoteAddress) {
    primary = {
      host: remoteAddress,
      port: 80,
      path: '/onvif/device_service',
      useTls: false
    };
  }
  if (!primary) return null;
  return {
    ...primary,
    urn: urnFromProbeXml(xml),
    scopes: scopesFromProbeXml(xml),
    xaddrs
  };
}

export function dedupeDiscoveryDevices(devices: RawDiscoveryDevice[]): RawDiscoveryDevice[] {
  const unique = new Map<string, RawDiscoveryDevice>();
  for (const device of devices) {
    const xaddr = device.xaddrs?.[0] ?? `${device.useTls ? 'https' : 'http'}://${device.host}:${device.port}${device.path}`;
    const key = device.urn?.trim().toLowerCase() || xaddr.trim().toLowerCase();
    const current = unique.get(key);
    if (!current) {
      unique.set(key, device);
      continue;
    }
    unique.set(key, {
      ...current,
      scopes: [...new Set([...(current.scopes ?? []), ...(device.scopes ?? [])])],
      xaddrs: [...new Set([...(current.xaddrs ?? []), ...(device.xaddrs ?? [])])]
    });
  }
  return [...unique.values()];
}

function validHost(host: string): string {
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (!value || value.includes('://') || /[/?#\s]/.test(value)) {
    throw new AppError('ONVIF_DISCOVERY_HOST_INVALID', 'Host kamera harus berupa IP atau hostname tanpa protocol/path', 400);
  }
  return value;
}

export function normalizeOnvifStreamUri(
  source: string,
  host: string,
  credentials: { username: string; password: string }
): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new AppError('ONVIF_STREAM_URI_INVALID', 'Kamera mengembalikan RTSP URI yang tidak valid', 502);
  }
  if (!['rtsp:', 'rtsps:'].includes(url.protocol)) {
    throw new AppError('ONVIF_STREAM_PROTOCOL_INVALID', 'Media profile kamera tidak menyediakan RTSP/RTSPS URI', 502);
  }
  const hostname = validHost(host);
  // Setter hostname mengabaikan IPv6 tanpa kurung secara diam-diam.
  const urlHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  let expectedHost: string;
  try {
    expectedHost = new URL(`rtsp://${urlHost}`).hostname;
  } catch {
    throw new AppError('ONVIF_DISCOVERY_HOST_INVALID', 'Host kamera harus berupa IP atau hostname tanpa protocol/path', 400);
  }
  url.hostname = urlHost;
  if (url.hostname !== expectedHost) {
    throw new AppError('ONVIF_DISCOVERY_HOST_INVALID', 'Host kamera harus berupa IP atau hostname tanpa protocol/path', 400);
  }
  // Setter userinfo tidak meng-encode '%'. MediaMTX (Go net/url) men-decode
  // userinfo, jadi password seperti `Ab%41c` harus disimpan sebagai `Ab%2541c`.
  url.username = encodeURIComponent(credentials.username);
  url.password = encodeURIComponent(credentials.password);
  return url.toString();
}

export function listDiscoveryInterfaces(): Array<{ name: string; address: string; netmask: string; cidr: string | null }> {
  const result: Array<{ name: string; address: string; netmask: string; cidr: string | null }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      result.push({ name, address: address.address, netmask: address.netmask, cidr: address.cidr ?? null });
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address));
}

function maskedRtsp(value: string): string {
  if (!URL.canParse(value)) return 'RTSP tersedia';
  return redactUrl(value);
}

function discoveryError(error: unknown): AppError {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/auth|unauthor|401|forbidden/.test(message)) {
    return new AppError('ONVIF_DISCOVERY_AUTH_FAILED', 'Autentikasi ONVIF ditolak. Periksa username dan password.', 401);
  }
  if (/timeout|timed out|etimedout/.test(message)) {
    return new AppError('ONVIF_DISCOVERY_TIMEOUT', 'Koneksi ONVIF timeout. Periksa jaringan, port, dan firewall kamera.', 504);
  }
  if (/refused|econnrefused/.test(message)) {
    return new AppError('ONVIF_DISCOVERY_REFUSED', 'Service ONVIF menolak koneksi pada host/port tersebut.', 502);
  }
  return new AppError('ONVIF_DISCOVERY_FAILED', 'Handshake ONVIF gagal. Periksa endpoint, credential, dan dukungan perangkat.', 502);
}

async function defaultScan(input: { interfaceName?: string | undefined; timeoutMs: number }): Promise<RawDiscoveryDevice[]> {
  const found = new Map<string, RawDiscoveryDevice>();
  const probeErrors: Error[] = [];
  const listener = (_raw: unknown, remote: { address?: string }, xml?: string) => {
    const device = discoveryDeviceFromProbe(xml, remote.address ?? '');
    if (!device) return;
    const key = device.urn ?? device.xaddrs?.[0] ?? `${device.host}:${device.port}${device.path}`;
    found.set(key.trim().toLowerCase(), device);
  };
  // `error` is a special EventEmitter event. Without a listener, one malformed
  // response from an unrelated WS-Discovery device can crash the API process.
  const errorListener = (error: unknown) => {
    if (error instanceof Error) probeErrors.push(error);
  };
  const activeNames = [...new Set(listDiscoveryInterfaces().map((item) => item.name))];
  const interfaceNames: Array<string | undefined> = input.interfaceName
    ? [input.interfaceName]
    : (activeNames.length ? activeNames : [undefined]);
  const discoveryEvents = Discovery as unknown as EventEmitter;
  discoveryEvents.on('device', listener);
  discoveryEvents.on('error', errorListener);
  try {
    await Promise.all(interfaceNames.map((interfaceName) => new Promise<void>((resolve) => {
      let settled = false;
      Discovery.probe({
        timeout: input.timeoutMs,
        // Parsing the raw XML here is more tolerant than the library's Cam
        // resolver, which assumes XAddrs is always present and well formed.
        resolve: false,
        ...(interfaceName ? { device: interfaceName } : {})
      }, (error) => {
        if (settled) return;
        settled = true;
        if (error instanceof Error) probeErrors.push(error);
        resolve();
      });
    })));
  } finally {
    discoveryEvents.off('device', listener);
    discoveryEvents.off('error', errorListener);
  }
  if (!found.size && probeErrors.length >= interfaceNames.length) throw probeErrors[0];
  return [...found.values()];
}

function profileDetails(profile: NonNullable<OnvifCam['profiles']>[number]) {
  const width = profile.videoEncoderConfiguration?.resolution?.width;
  const height = profile.videoEncoderConfiguration?.resolution?.height;
  const ptz = Boolean(profile.PTZConfiguration);
  return {
    token: profile.$?.token ?? '',
    name: profile.name ?? profile.$?.token ?? 'Media profile',
    encoding: profile.videoEncoderConfiguration?.encoding ?? 'UNKNOWN',
    width: Number.isFinite(width) ? Number(width) : null,
    height: Number.isFinite(height) ? Number(height) : null,
    ptz,
    zoom: ptz && Boolean(
      profile.PTZConfiguration?.defaultContinuousZoomVelocitySpace
      || profile.PTZConfiguration?.defaultPTZSpeed?.zoom
    )
  };
}

// Library ONVIF mengubah teks numerik menjadi number (mis. serial "123456"),
// sedangkan elemen kosong bisa menjadi object.
function onvifText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export async function defaultInspect(
  target: OnvifTarget,
  credentials: { username: string; password: string }
): Promise<RawInspection> {
  const cam = new Cam({
    hostname: target.host,
    port: target.port,
    username: credentials.username,
    password: credentials.password,
    useSecure: target.useTls,
    path: target.path,
    timeout: 7000,
    preserveAddress: true
  });
  await cam.connect();
  // connect() tidak mengambil device information maupun hostname. Keduanya
  // opsional: kamera yang menolaknya tetap dapat diperiksa dengan fallback.
  const [info, hostnameInfo] = await Promise.all([
    cam.getDeviceInformation().catch(() => null),
    cam.getHostname().catch(() => null)
  ]);
  const profiles: RawInspection['profiles'] = [];
  for (const rawProfile of cam.profiles ?? []) {
    const profile = profileDetails(rawProfile);
    if (!profile.token) continue;
    try {
      const stream = await cam.getStreamUri({ protocol: 'RTSP', stream: 'RTP-Unicast', profileToken: profile.token });
      profiles.push({ ...profile, streamUri: stream?.uri });
    } catch {
      profiles.push({ ...profile, error: 'RTSP URI tidak tersedia untuk profile ini' });
    }
  }
  return {
    device: {
      manufacturer: onvifText(info?.manufacturer),
      model: onvifText(info?.model),
      hostname: onvifText(hostnameInfo?.name) || target.host,
      firmwareVersion: onvifText(info?.firmwareVersion),
      serialNumber: onvifText(info?.serialNumber)
    },
    profiles
  };
}

let adapter: DiscoveryAdapter = { scan: defaultScan, inspect: defaultInspect };

export function setOnvifDiscoveryAdapterForTests(next?: DiscoveryAdapter): void {
  adapter = next ?? { scan: defaultScan, inspect: defaultInspect };
}

async function existingRouteIndex(): Promise<Map<string, ExistingRoute[]>> {
  const rows = await listRoutes();
  const index = new Map<string, ExistingRoute[]>();
  await Promise.all(rows.map(async (row) => {
    const runtime = await getRuntimeRoute(row.id);
    let inputHost = '';
    try { inputHost = new URL(runtime.inputUrl).hostname; } catch { /* invalid legacy URL */ }
    const ptz = await getStoredPtzConfig('ROUTE', row.id);
    const onvifHost = ptz?.provider === 'ONVIF' ? ptz.host : '';
    const storedToken = ptz?.provider === 'ONVIF' ? ptz.profileToken ?? '' : '';
    const summary = { id: row.id, name: row.name, cameraKey: row.cameraKey ?? '', profileToken: storedToken };
    for (const host of new Set([inputHost, onvifHost].map((value) => value.trim().toLowerCase()).filter(Boolean))) {
      const routes = index.get(host) ?? [];
      routes.push(summary);
      index.set(host, routes);
    }
  }));
  return index;
}

function routesForHost(index: Map<string, ExistingRoute[]>, host: string, profileToken = ''): ExistingRoute[] {
  return (index.get(host.trim().toLowerCase()) ?? []).filter((route) => (
    !profileToken || !route.profileToken || route.profileToken === profileToken
  ));
}

async function existingRoutesForHost(host: string, profileToken = ''): Promise<ExistingRoute[]> {
  return routesForHost(await existingRouteIndex(), host, profileToken);
}

export function cleanupExpiredOnvifSessions(now = Date.now()): number {
  let removed = 0;
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
      importingSessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

const cleanupTimer = setInterval(cleanupExpiredOnvifSessions, 60_000);
cleanupTimer.unref();

export async function scanOnvifDevices(input: {
  interfaceName?: string | undefined;
  timeoutMs: number;
}): Promise<{
  scannedAt: string;
  scannedInterfaces: Array<{ name: string; address: string; netmask: string; cidr: string | null }>;
  items: DiscoveryDevice[];
}> {
  if (scanRunning) throw new AppError('ONVIF_SCAN_IN_PROGRESS', 'Scan ONVIF lain masih berjalan', 409);
  const availableInterfaces = listDiscoveryInterfaces();
  if (input.interfaceName && !availableInterfaces.some((item) => item.name === input.interfaceName)) {
    throw new AppError('ONVIF_INTERFACE_NOT_FOUND', 'Interface jaringan tidak tersedia', 400);
  }
  scanRunning = true;
  try {
    const discovered = dedupeDiscoveryDevices(await adapter.scan(input));
    // Build the route lookup once. The previous implementation re-read every
    // route and PTZ configuration once per discovered camera.
    const routeIndex = discovered.length ? await existingRouteIndex() : new Map<string, ExistingRoute[]>();
    const items = discovered.map((device) => {
      const scopes = device.scopes ?? [];
      const xaddrs = device.xaddrs ?? [];
      return {
        ...device,
        id: device.urn ?? xaddrs[0] ?? `${device.host}:${device.port}${device.path}`,
        name: nameFromScopes(scopes) || device.host,
        scopes,
        xaddrs,
        existingRoutes: routesForHost(routeIndex, device.host)
      };
    });
    return {
      scannedAt: new Date().toISOString(),
      scannedInterfaces: input.interfaceName
        ? availableInterfaces.filter((item) => item.name === input.interfaceName)
        : availableInterfaces,
      items
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw discoveryError(error);
  } finally {
    scanRunning = false;
  }
}

export async function inspectOnvifDevice(input: {
  target: OnvifTarget;
  username: string;
  password: string;
}): Promise<InspectionResult> {
  if (inspectRunning) throw new AppError('ONVIF_INSPECTION_IN_PROGRESS', 'Kamera lain sedang diperiksa. Tunggu hingga selesai.', 409);
  const target = {
    ...input.target,
    host: validHost(input.target.host),
    path: input.target.path.startsWith('/') ? input.target.path : `/${input.target.path}`
  };
  inspectRunning = true;
  try {
    const result = await adapter.inspect(target, { username: input.username, password: input.password });
    const streamUris = new Map<string, string>();
    const profiles = result.profiles.map((profile) => {
      if (profile.streamUri) streamUris.set(profile.token, profile.streamUri);
      return {
        token: profile.token,
        name: profile.name,
        encoding: profile.encoding,
        width: profile.width,
        height: profile.height,
        ptz: profile.ptz,
        zoom: profile.zoom,
        streamAvailable: Boolean(profile.streamUri),
        streamUriMasked: profile.streamUri ? maskedRtsp(profile.streamUri) : null,
        error: profile.streamUri ? null : profile.error ?? 'RTSP URI tidak tersedia'
      };
    });
    if (!profiles.length) {
      throw new AppError('ONVIF_PROFILES_EMPTY', 'Kamera tidak mengembalikan Media Profile yang dapat digunakan', 422);
    }
    const sessionId = randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(sessionId, {
      id: sessionId,
      expiresAt,
      target,
      username: input.username,
      password: input.password,
      profiles,
      streamUris
    });
    const suggestedName = result.device.hostname || result.device.model || target.host;
    return {
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
      target,
      device: result.device,
      profiles,
      suggestedName,
      suggestedCameraKey: await availableCameraKey(suggestedName),
      existingRoutes: await existingRoutesForHost(target.host)
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw discoveryError(error);
  } finally {
    inspectRunning = false;
  }
}

export interface ImportOnvifRouteInput {
  sessionId: string;
  profileToken: string;
  ptzProfileToken?: string | undefined;
  rtspCredentials?: { username: string; password: string } | undefined;
  ptzEnabled: boolean;
  zoomEnabled: boolean;
  route: Omit<CreateRouteInput, 'inputUrl'>;
}

export async function importOnvifRoute(input: ImportOnvifRouteInput): Promise<Record<string, unknown>> {
  cleanupExpiredOnvifSessions();
  const session = sessions.get(input.sessionId);
  if (!session) throw new AppError('ONVIF_INSPECTION_EXPIRED', 'Session pemeriksaan kamera sudah kedaluwarsa. Uji kamera kembali.', 410);
  if (importingSessions.has(input.sessionId)) {
    throw new AppError('ONVIF_IMPORT_IN_PROGRESS', 'Kamera ini sedang diimpor. Tunggu hingga proses selesai.', 409);
  }
  const profile = session.profiles.find((item) => item.token === input.profileToken);
  const rawStreamUri = session.streamUris.get(input.profileToken);
  if (!profile || !rawStreamUri) {
    throw new AppError('ONVIF_PROFILE_NOT_AVAILABLE', 'Media Profile yang dipilih tidak menyediakan RTSP URI', 400);
  }
  const rtspCredentials = input.rtspCredentials ?? {
    username: session.username,
    password: session.password
  };
  importingSessions.add(session.id);
  try {
    const inputUrl = normalizeOnvifStreamUri(rawStreamUri, session.target.host, rtspCredentials);
    // Camera ID yang diketik Admin dipakai apa adanya (bentrok route aktif → 409 CAMERA_KEY_CONFLICT), sehingga
    // kamera yang diimpor ulang tetap memakai arsip recording-nya. Hanya key otomatis yang menghindari arsip lama.
    const routeInput = createRouteSchema.parse({
      ...input.route,
      cameraKey: input.route.cameraKey || await availableCameraKey(input.route.name),
      inputUrl
    });
    let row: Awaited<ReturnType<typeof createRoute>> | null = null;
    try {
      row = await createRoute(routeInput);
      if (input.ptzEnabled) {
        const ptzInput = ptzConfigSchema.parse({
          provider: 'ONVIF',
          enabled: true,
          zoomEnabled: input.zoomEnabled,
          host: session.target.host,
          port: session.target.port,
          username: session.username,
          password: session.password,
          useTls: session.target.useTls,
          path: session.target.path,
          profileToken: input.ptzProfileToken?.trim() || input.profileToken
        });
        await savePtzConfig('ROUTE', row.id, ptzInput);
      }
    } catch (error) {
      if (row) await deleteRoute(row.id).catch(() => undefined);
      throw error;
    }
    sessions.delete(session.id);
    await audit('ONVIF_DISCOVERY_IMPORT', row.id, {
      host: session.target.host,
      profileToken: input.profileToken,
      ptzEnabled: input.ptzEnabled
    });
    return {
      route: toRouteDto(row),
      existingRoutes: await existingRoutesForHost(session.target.host, input.profileToken)
    };
  } finally {
    importingSessions.delete(session.id);
  }
}

export function shutdownOnvifDiscovery(): void {
  clearInterval(cleanupTimer);
  sessions.clear();
  importingSessions.clear();
  scanRunning = false;
  inspectRunning = false;
}
