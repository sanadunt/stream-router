export type RouteStatus = 'DISABLED' | 'STOPPED' | 'STARTING' | 'RUNNING' | 'RESTARTING' | 'FAILED' | 'STOPPING';
export type UserRole = 'admin' | 'operator' | 'viewer';
export type RecordingRetentionMode = 'INHERIT' | 'DAYS' | 'SIZE' | 'DAYS_OR_SIZE';
export type StreamViewMode = 'IFRAME' | 'WHEP' | 'YOUTUBE' | 'HLS' | 'MJPEG' | 'MP4';

export interface CurrentUser {
  username: string;
  role: UserRole;
}

export interface RuntimeStatus {
  routeId: string;
  status: RouteStatus;
  pid: number | null;
  uptimeMs: number;
  restartCount: number;
  lastError: string | null;
}

export interface StreamRoute {
  id: string;
  cameraKey: string;
  name: string;
  description: string;
  inputProtocol: 'RTSP' | 'RTMP';
  inputHost: string;
  inputUrlMasked: string;
  outputsMasked: string[];
  outputCount: number;
  enabled: boolean;
  autoStart: boolean;
  localViewEnabled: boolean;
  localAudioMode: 'COPY' | 'OPUS';
  onlineRelayEnabled: boolean;
  onlineAudioMode: 'COPY' | 'AAC' | 'OPUS';
  recordingEnabled: boolean;
  recordingRetentionMode: RecordingRetentionMode;
  recordingRetentionDays: number | null;
  recordingRetentionGb: number | null;
  ffmpegMode: 'COPY' | 'TRANSCODE';
  ffmpegOptions: Record<string, unknown>;
  retryPolicy: Record<string, unknown>;
  webrtc: { enabled: boolean; mode: 'IFRAME' | 'WHEP'; urlMasked?: string };
  ptz: PtzSummary;
  mqttBridgeEnabled: boolean;
  mqttTopics?: Array<{
    brokerName: string;
    commandTopic: string;
    statusTopic: string | null;
    usage: Array<'BRIDGE' | 'PTZ'>;
  }>;
  media: {
    state: 'DISABLED' | 'CONFIGURING' | 'READY' | 'ERROR';
    ready: boolean;
    path: string;
    opusPath: string | null;
    opusReady: boolean;
    localWebrtcUrl: string | null;
    tracks: string[];
    codecCompatible: boolean | null;
    codecMessage: string | null;
    lastError: string | null;
    checkedAt: string | null;
  };
  components: {
    ingest: { enabled: boolean; state: StreamRoute['media']['state']; ready: boolean; lastError: string | null };
    local: { enabled: boolean; ready: boolean; url: string | null; codecCompatible: boolean | null; codecMessage: string | null };
    recording: { enabled: boolean; active: boolean; storagePaused: boolean };
    online: {
      enabled: boolean;
      configured: boolean;
      videoMode: 'COPY' | 'TRANSCODE';
      audioMode: 'COPY' | 'AAC' | 'OPUS';
      opusReady: boolean;
      status: RouteStatus;
      pid: number | null;
    };
    ptz: { enabled: boolean; ingestReady: boolean };
  };
  runtime: RuntimeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EditableStreamRoute extends StreamRoute {
  inputUrl: string;
  outputs: string[];
  webrtc: StreamRoute['webrtc'] & { url?: string };
}

export interface ViewerRoute {
  id: string;
  name: string;
  description: string;
  webrtc: { url: string; openUrl?: string; mode: StreamViewMode; compatible?: boolean; codecMessage?: string | null };
  sources?: {
    local: ViewerRoute['webrtc'] | null;
    online: ViewerRoute['webrtc'] | null;
    preferred: 'local' | 'online';
  };
  ptz: ViewerPtzCapability;
  runtime?: RuntimeStatus;
}

export interface WebrtcStream {
  id: string;
  name: string;
  description: string;
  urlMasked: string;
  mode: StreamViewMode;
  sourceType: 'URL' | 'FILE';
  enabled: boolean;
  ptz: PtzSummary;
  createdAt: string;
  updatedAt: string;
}

export interface EditableWebrtcStream extends WebrtcStream {
  url: string;
}

export interface PtzSummary {
  enabled: boolean;
  provider: 'NONE' | 'ONVIF' | 'MQTT';
  zoomEnabled: boolean;
  connection: PtzConnectionStatus;
}

export interface PtzConnectionStatus {
  state: 'DISABLED' | 'UNTESTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  checkedAt: string | null;
  message: string;
}

export interface MqttBrokerProfile {
  id: string;
  name: string;
  description: string;
  protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
  host: string;
  port: number;
  rootTopic: string;
  username: string;
  passwordConfigured: boolean;
  connection: {
    state: 'UNTESTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
    checkedAt: string | null;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MqttBridgeSubscription {
  id?: string;
  brokerId: string;
  cameraId: string;
  commandTopic: string;
  statusTopic?: string;
  broker?: MqttBrokerProfile;
  connection?: MqttBrokerProfile['connection'];
}

export interface MqttBridgeConfig {
  enabled: boolean;
  subscriptions: MqttBridgeSubscription[];
  runtime: {
    active: boolean;
    onvifConnected: boolean;
    lastPresenceAt: number | null;
  };
}

export interface ViewerPtzCapability extends PtzSummary {
  targetType: 'ROUTE' | 'WEBRTC_STREAM';
  targetId: string;
}

export interface OnvifPtzConfigDto {
  provider: 'ONVIF';
  enabled: boolean;
  zoomEnabled: boolean;
  host: string;
  port: number;
  username: string;
  passwordConfigured: boolean;
  useTls: boolean;
  path: string;
  profileToken: string;
  connection: PtzConnectionStatus;
}

export interface MqttPtzConfigDto {
  provider: 'MQTT';
  enabled: boolean;
  zoomEnabled: boolean;
  brokerId: string;
  cameraId: string;
  topicRoot: string;
  fullTopic: string;
  broker: MqttBrokerProfile;
  connection: PtzConnectionStatus;
}

export type PtzConfigDto =
  | { provider: 'NONE'; enabled: false; zoomEnabled: false; connection: PtzConnectionStatus }
  | OnvifPtzConfigDto
  | MqttPtzConfigDto;

export interface MediaMtxSettings {
  enabled: boolean;
  version: string;
  /** Host efektif untuk URL WHEP dan kandidat ICE. */
  publicHost: string;
  /** Nilai tersimpan di Settings; '' = mengikuti MEDIAMTX_PUBLIC_HOST / deteksi otomatis. */
  publicHostConfigured: string;
  /** Host yang dipakai bila publicHostConfigured kosong. */
  publicHostDefault: string;
  /** MEDIAMTX_WEBRTC_PUBLIC_URL (hanya dari env); '' = http://<publicHost>:<webrtcPort>. */
  webrtcPublicUrl?: string;
  recordingPath: string;
  rtspPort: number;
  rtmpPort: number;
  hlsPort: number;
  webrtcPort: number;
  webrtcUdpPort: number;
  srtPort: number;
  playbackPort: number;
  apiPort: number;
  metricsPort: number;
  retentionMode: Exclude<RecordingRetentionMode, 'INHERIT'>;
  retentionDays: number;
  retentionMaxGb: number;
  minFreePercent: number;
  minFreeGb: number;
  segmentDurationSeconds: number;
  apiUrl: string;
  rtspUrl: string;
  playbackUrl: string;
}

export interface RecordingSegment {
  id: string;
  routeId: string | null;
  cameraKey: string;
  cameraName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  sizeBytes: number;
  status: 'RECORDING' | 'COMPLETE' | 'MISSING' | 'ERROR' | 'DELETING' | 'DELETED';
  protected: boolean;
  deletionReason: string | null;
  errorMessage: string | null;
}

export interface RecordingStorage {
  totalBytes: number;
  freeBytes: number;
  usedByRecordingsBytes: number;
  segments: number;
  paused: boolean;
  retentionMode: Exclude<RecordingRetentionMode, 'INHERIT'>;
  retentionDays: number;
  retentionMaxGb: number;
  minFreePercent: number;
  minFreeGb: number;
}

export interface StorageDirectoryEntry {
  name: string;
  path: string;
  writable: boolean;
}

export interface StorageDirectoryListing {
  current: string;
  parent: string | null;
  writable: boolean;
  totalBytes: number;
  freeBytes: number;
  entries: StorageDirectoryEntry[];
}

export interface StorageValidation {
  ok: boolean;
  path: string;
  writable: boolean;
  totalBytes: number;
  freeBytes: number;
  thresholdBytes: number;
  meetsStorageFloor: boolean;
  error: string | null;
}

export interface OnvifNetworkInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: string | null;
}

export interface OnvifDiscoveryTarget {
  host: string;
  port: number;
  path: string;
  useTls: boolean;
  urn?: string;
}

export interface OnvifExistingRoute {
  id: string;
  name: string;
  cameraKey: string;
  profileToken: string;
}

export interface OnvifDiscoveredDevice extends OnvifDiscoveryTarget {
  id: string;
  name: string;
  scopes: string[];
  xaddrs: string[];
  existingRoutes: OnvifExistingRoute[];
}

export interface OnvifInspectionProfile {
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

export interface OnvifInspection {
  sessionId: string;
  expiresAt: string;
  target: OnvifDiscoveryTarget;
  device: {
    manufacturer: string;
    model: string;
    hostname: string;
    firmwareVersion: string;
    serialNumber: string;
  };
  profiles: OnvifInspectionProfile[];
  suggestedName: string;
  suggestedCameraKey: string;
  existingRoutes: OnvifExistingRoute[];
}

export interface Mp4FileEntry {
  name: string;
  path: string;
  type: 'DIRECTORY' | 'FILE';
  sizeBytes?: number;
}

export interface Mp4FileListing {
  current: string;
  parent: string | null;
  entries: Mp4FileEntry[];
}
