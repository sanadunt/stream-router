import { z } from 'zod';

export const inputProtocolSchema = z.enum(['RTSP', 'RTMP']);
export const outputProtocolSchema = z.enum(['RTMP', 'RTMPS']);
export const ffmpegModeSchema = z.enum(['COPY', 'TRANSCODE']);
export const localAudioModeSchema = z.enum(['COPY', 'OPUS']);
export const onlineAudioModeSchema = z.enum(['COPY', 'AAC', 'OPUS']);
export const webrtcModeSchema = z.enum(['IFRAME', 'WHEP']);
export const streamViewModeSchema = z.enum(['IFRAME', 'WHEP', 'YOUTUBE', 'HLS', 'MJPEG', 'MP4']);
export const streamViewSourceTypeSchema = z.enum(['URL', 'FILE']);
export const ptzProviderSchema = z.enum(['ONVIF', 'MQTT']);
export const routeStatusSchema = z.enum([
  'DISABLED', 'STOPPED', 'STARTING', 'RUNNING', 'RESTARTING', 'FAILED', 'STOPPING'
]);

export const ffmpegOptionsSchema = z.object({
  videoBitrateKbps: z.number().int().min(100).max(50000).default(2500),
  audioBitrateKbps: z.number().int().min(32).max(512).default(128),
  preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']).default('veryfast'),
  fps: z.number().int().min(1).max(120).optional(),
  gop: z.number().int().min(1).max(600).default(50),
  width: z.number().int().min(160).max(7680).optional(),
  height: z.number().int().min(120).max(4320).optional()
}).strict();

export const retryPolicySchema = z.object({
  initialDelayMs: z.number().int().min(500).max(60000).default(2000),
  maxDelayMs: z.number().int().min(1000).max(600000).default(60000),
  maxRetries: z.number().int().min(0).max(100).default(10),
  jitterRatio: z.number().min(0).max(1).default(0.2),
  stableResetMs: z.number().int().min(5000).max(86400000).default(60000)
}).strict();

export const webrtcOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  // null menghapus link tersimpan; undefined mempertahankannya.
  url: z.string().trim().max(2048).url().nullable().optional(),
  mode: webrtcModeSchema.default('IFRAME')
}).strict();

export const cameraKeySchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Camera ID hanya boleh berisi huruf kecil, angka, titik, garis bawah, dan strip');

export const recordingRetentionModeSchema = z.enum(['INHERIT', 'DAYS', 'SIZE', 'DAYS_OR_SIZE']);
export const defaultRecordingRetentionModeSchema = z.enum(['DAYS', 'SIZE', 'DAYS_OR_SIZE']);

export const createWebrtcStreamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  url: z.string().trim().min(1).max(4096),
  mode: streamViewModeSchema.default('IFRAME'),
  sourceType: streamViewSourceTypeSchema.default('URL'),
  enabled: z.boolean().default(true)
}).strict();

export const updateWebrtcStreamSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  url: z.string().trim().min(1).max(4096).optional(),
  mode: streamViewModeSchema.optional(),
  sourceType: streamViewSourceTypeSchema.optional(),
  enabled: z.boolean().optional()
}).strict();

const ptzBaseSchema = {
  enabled: z.boolean().default(true),
  zoomEnabled: z.boolean().default(false)
};

export const onvifPtzConfigSchema = z.object({
  provider: z.literal('ONVIF'),
  ...ptzBaseSchema,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(80),
  username: z.string().trim().max(255).default(''),
  password: z.string().max(512).optional(),
  useTls: z.boolean().default(false),
  path: z.string().trim().min(1).max(255).default('/onvif/device_service'),
  profileToken: z.string()
    .trim()
    .max(255)
    .regex(/^[^\s<>&"']*$/, 'Media Profile Token ONVIF mengandung karakter yang tidak valid')
    .default('')
}).strict();

export const mqttPtzConfigSchema = z.object({
  provider: z.literal('MQTT'),
  ...ptzBaseSchema,
  brokerId: z.string().uuid(),
  cameraId: z.string().trim().regex(/^[a-zA-Z0-9._-]+$/).max(120)
}).strict();

export const ptzConfigSchema = z.discriminatedUnion('provider', [
  onvifPtzConfigSchema,
  mqttPtzConfigSchema
]);

const mqttProtocolSchema = z.enum(['mqtt', 'mqtts', 'ws', 'wss']);
const mqttBrokerBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  protocol: mqttProtocolSchema.default('mqtt'),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(1883),
  rootTopic: z.string().trim().min(1).max(500).default('Turjawali'),
  username: z.string().trim().max(255).default(''),
  password: z.string().max(512).optional()
}).strict();

export const createMqttBrokerSchema = mqttBrokerBaseSchema;
export const updateMqttBrokerSchema = mqttBrokerBaseSchema.partial();

export const mqttBridgeConfigSchema = z.object({
  enabled: z.boolean(),
  subscriptions: z.array(z.object({
    brokerId: z.string().uuid(),
    cameraId: z.string().trim().regex(/^[a-zA-Z0-9._-]+$/).max(120)
  }).strict()).max(20)
}).strict();

export const ptzCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('move'),
    direction: z.enum(['left', 'up', 'right', 'down']),
    speed: z.number().min(0.1).max(1).default(0.4),
    durationMs: z.number().int().min(0).max(5000).default(0)
  }).strict(),
  z.object({
    type: z.literal('zoom'),
    direction: z.enum(['in', 'out']),
    speed: z.number().min(0.1).max(1).default(0.4),
    durationMs: z.number().int().min(0).max(5000).default(0)
  }).strict(),
  z.object({
    type: z.literal('stop'),
    direction: z.literal('stop'),
    speed: z.number().min(0.1).max(1).default(0.4),
    durationMs: z.literal(0).default(0)
  }).strict()
]);

export const viewerPtzCommandSchema = z.object({
  targetType: z.enum(['ROUTE', 'WEBRTC_STREAM']),
  targetId: z.string().uuid(),
  command: ptzCommandSchema
}).strict();

const urlString = z.string().min(8).max(2048);
// Destinasi duplikat ditolak RTMP server sebagai publish kedua dan menjatuhkan seluruh relay.
const outputUrlList = z.array(urlString).max(10).refine(
  (items) => new Set(items.map((item) => item.trim())).size === items.length,
  'Output online tidak boleh duplikat'
);

export const createRouteSchema = z.object({
  cameraKey: cameraKeySchema.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  inputUrl: urlString,
  outputs: outputUrlList.default([]),
  enabled: z.boolean().default(true),
  autoStart: z.boolean().default(false),
  localViewEnabled: z.boolean().default(false),
  localAudioMode: localAudioModeSchema.default('COPY'),
  onlineRelayEnabled: z.boolean().default(true),
  recordingEnabled: z.boolean().default(false),
  recordingRetentionMode: recordingRetentionModeSchema.default('INHERIT'),
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  recordingRetentionGb: z.number().min(0.1).max(1_000_000).nullable().optional(),
  ffmpegMode: ffmpegModeSchema.default('COPY'),
  onlineAudioMode: onlineAudioModeSchema.default('COPY'),
  ffmpegOptions: ffmpegOptionsSchema.default({}),
  retryPolicy: retryPolicySchema.default({}),
  webrtc: webrtcOptionsSchema.default({})
}).strict().superRefine((value, context) => {
  if (value.onlineRelayEnabled && value.outputs.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs'], message: 'Minimal satu output online wajib diisi saat Relay Online aktif' });
  }
  if (['DAYS', 'DAYS_OR_SIZE'].includes(value.recordingRetentionMode) && value.recordingRetentionDays == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordingRetentionDays'], message: 'Jumlah hari wajib diisi untuk kebijakan retention ini' });
  }
  if (['SIZE', 'DAYS_OR_SIZE'].includes(value.recordingRetentionMode) && value.recordingRetentionGb == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recordingRetentionGb'], message: 'Batas GB wajib diisi untuk kebijakan retention ini' });
  }
});

export const updateRouteSchema = z.object({
  cameraKey: cameraKeySchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  inputUrl: urlString.optional(),
  outputs: outputUrlList.optional(),
  enabled: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  localViewEnabled: z.boolean().optional(),
  localAudioMode: localAudioModeSchema.optional(),
  onlineRelayEnabled: z.boolean().optional(),
  recordingEnabled: z.boolean().optional(),
  recordingRetentionMode: recordingRetentionModeSchema.optional(),
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  recordingRetentionGb: z.number().min(0.1).max(1_000_000).nullable().optional(),
  ffmpegMode: ffmpegModeSchema.optional(),
  onlineAudioMode: onlineAudioModeSchema.optional(),
  ffmpegOptions: ffmpegOptionsSchema.partial().optional(),
  retryPolicy: retryPolicySchema.partial().optional(),
  webrtc: webrtcOptionsSchema.partial().optional()
}).strict();

export const routeFeaturesSchema = z.object({
  localViewEnabled: z.boolean().optional(),
  onlineRelayEnabled: z.boolean().optional(),
  recordingEnabled: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'Minimal satu fitur harus dikirim');

const mediaMtxPortSchema = z.number().int().min(1).max(65535);
const mediaMtxSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  // Kosong (atau `auto`) = ikuti MEDIAMTX_PUBLIC_HOST / deteksi otomatis IP LAN.
  publicHost: z.string().trim().max(255),
  recordingPath: z.string().trim().min(1).max(2048),
  rtspPort: mediaMtxPortSchema,
  rtmpPort: mediaMtxPortSchema,
  hlsPort: mediaMtxPortSchema,
  webrtcPort: mediaMtxPortSchema,
  webrtcUdpPort: mediaMtxPortSchema,
  srtPort: mediaMtxPortSchema,
  playbackPort: mediaMtxPortSchema,
  apiPort: mediaMtxPortSchema,
  metricsPort: mediaMtxPortSchema,
  retentionMode: defaultRecordingRetentionModeSchema,
  retentionDays: z.number().int().min(1).max(3650),
  retentionMaxGb: z.number().min(0.1).max(1_000_000),
  minFreePercent: z.number().int().min(1).max(90),
  minFreeGb: z.number().int().min(1).max(100000),
  segmentDurationSeconds: z.number().int().min(60).max(3600)
}).strict();
export const mediaMtxSettingsSchema = mediaMtxSettingsBaseSchema.superRefine((value, context) => {
  const ports = [
    value.rtspPort, value.rtmpPort, value.hlsPort, value.webrtcPort,
    value.webrtcUdpPort, value.srtPort, value.playbackPort, value.apiPort, value.metricsPort
  ];
  if (new Set(ports).size !== ports.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['apiPort'], message: 'Seluruh port MediaMTX harus unik' });
  }
});

export const settingsUpdateSchema = z.object({
  appName: z.string().trim().min(1).max(80).optional(),
  maxWorkers: z.number().int().min(1).max(100).optional(),
  logRetentionDays: z.number().int().min(1).max(365).optional(),
  gracefulShutdownTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  ffmpegPath: z.string().trim().min(1).max(1024).optional(),
  mediaMtx: mediaMtxSettingsBaseSchema.partial().optional()
}).strict();

export const monitoringLayoutSchema = z.object({
  name: z.string().trim().min(1).max(60),
  layout: z.enum(['1', '2', '4', '8']).default('1'),
  slots: z.array(z.object({
    routeId: z.string().uuid(),
    position: z.number().int().min(0).max(7)
  })).max(8).default([]),
  isDefault: z.boolean().default(false)
}).strict();

export const updateMonitoringLayoutSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  layout: z.enum(['1', '2', '4', '8']).optional(),
  slots: z.array(z.object({
    routeId: z.string().uuid(),
    position: z.number().int().min(0).max(7)
  })).max(8).optional(),
  isDefault: z.boolean().optional()
}).strict();

export type InputProtocol = z.infer<typeof inputProtocolSchema>;
export type OutputProtocol = z.infer<typeof outputProtocolSchema>;
export type FfmpegMode = z.infer<typeof ffmpegModeSchema>;
export type OnlineAudioMode = z.infer<typeof onlineAudioModeSchema>;
export type WebrtcMode = z.infer<typeof webrtcModeSchema>;
export type StreamViewMode = z.infer<typeof streamViewModeSchema>;
export type StreamViewSourceType = z.infer<typeof streamViewSourceTypeSchema>;
export type PtzProvider = z.infer<typeof ptzProviderSchema>;
export type RouteStatus = z.infer<typeof routeStatusSchema>;
export type FfmpegOptions = z.infer<typeof ffmpegOptionsSchema>;
export type LocalAudioMode = z.infer<typeof localAudioModeSchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type WebrtcOptions = z.infer<typeof webrtcOptionsSchema>;
export type RecordingRetentionMode = z.infer<typeof recordingRetentionModeSchema>;
export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
export type RouteFeaturesInput = z.infer<typeof routeFeaturesSchema>;
export type MediaMtxSettingsInput = z.infer<typeof mediaMtxSettingsSchema>;
export type CreateWebrtcStreamInput = z.infer<typeof createWebrtcStreamSchema>;
export type UpdateWebrtcStreamInput = z.infer<typeof updateWebrtcStreamSchema>;
export type PtzConfigInput = z.infer<typeof ptzConfigSchema>;
export type CreateMqttBrokerInput = z.infer<typeof createMqttBrokerSchema>;
export type UpdateMqttBrokerInput = z.infer<typeof updateMqttBrokerSchema>;
export type MqttBridgeConfigInput = z.infer<typeof mqttBridgeConfigSchema>;
export type PtzCommandInput = z.infer<typeof ptzCommandSchema>;
export type ViewerPtzCommandInput = z.infer<typeof viewerPtzCommandSchema>;
export type MonitoringLayoutInput = z.infer<typeof monitoringLayoutSchema>;
export type UpdateMonitoringLayoutInput = z.infer<typeof updateMonitoringLayoutSchema>;
