import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRoles } from '../../plugins/auth.js';
import {
  importOnvifRoute,
  inspectOnvifDevice,
  listDiscoveryInterfaces,
  scanOnvifDevices
} from './onvif-discovery-service.js';

const hostSchema = z.string().trim().min(1).max(255);
const pathSchema = z.string().trim().min(1).max(255).default('/onvif/device_service');
const profileTokenSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s<>&"']+$/, 'Media Profile Token ONVIF mengandung karakter yang tidak valid');
const targetSchema = z.object({
  host: hostSchema,
  port: z.number().int().min(1).max(65535).default(80),
  path: pathSchema,
  useTls: z.boolean().default(false),
  urn: z.string().trim().max(512).optional()
}).strip();
const credentialsSchema = z.object({
  username: z.string().trim().max(255).default(''),
  password: z.string().max(512).default('')
}).strict();
const importRouteSchema = z.object({
  cameraKey: z.string().trim().max(120).default(''),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  outputs: z.array(z.string().min(8).max(2048)).max(10).default([]),
  enabled: z.literal(true).default(true),
  autoStart: z.boolean().default(false),
  localViewEnabled: z.boolean().default(true),
  localAudioMode: z.enum(['COPY', 'OPUS']).default('COPY'),
  onlineRelayEnabled: z.boolean().default(false),
  onlineAudioMode: z.enum(['COPY', 'AAC', 'OPUS']).default('COPY'),
  recordingEnabled: z.boolean().default(false),
  recordingRetentionMode: z.enum(['INHERIT', 'DAYS', 'SIZE', 'DAYS_OR_SIZE']).default('INHERIT'),
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable().default(null),
  recordingRetentionGb: z.number().min(0.1).max(1_000_000).nullable().default(null),
  ffmpegMode: z.enum(['COPY', 'TRANSCODE']).default('COPY'),
  ffmpegOptions: z.object({
    videoBitrateKbps: z.number().int().min(100).max(50000).default(2500),
    audioBitrateKbps: z.number().int().min(32).max(512).default(128),
    preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']).default('veryfast'),
    gop: z.number().int().min(1).max(600).default(50)
  }).default({}),
  retryPolicy: z.object({
    initialDelayMs: z.number().int().min(500).max(60000).default(2000),
    maxDelayMs: z.number().int().min(1000).max(600000).default(60000),
    maxRetries: z.number().int().min(0).max(100).default(10),
    jitterRatio: z.number().min(0).max(1).default(0.2),
    stableResetMs: z.number().int().min(5000).max(86400000).default(60000)
  }).default({}),
  webrtc: z.object({
    enabled: z.literal(false).default(false),
    mode: z.enum(['IFRAME', 'WHEP']).default('IFRAME')
  }).default({})
}).strict();

export async function onvifDiscoveryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings/onvif-discovery/interfaces', { preHandler: requireRoles('admin') }, async () => ({
    items: listDiscoveryInterfaces()
  }));

  app.post('/api/settings/onvif-discovery/scan', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } }
  }, async (request) => {
    const input = z.object({
      interfaceName: z.string().trim().max(128).optional(),
      timeoutMs: z.number().int().min(1000).max(10000).default(5000)
    }).strict().parse(request.body ?? {});
    return scanOnvifDevices(input);
  });

  app.post('/api/settings/onvif-discovery/inspect', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => {
    const input = z.object({
      target: targetSchema,
      credentials: credentialsSchema
    }).strict().parse(request.body);
    return inspectOnvifDevice({
      target: input.target,
      username: input.credentials.username,
      password: input.credentials.password
    });
  });

  app.post('/api/settings/onvif-discovery/import', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => {
    const input = z.object({
      sessionId: z.string().uuid(),
      profileToken: profileTokenSchema,
      ptzProfileToken: profileTokenSchema.optional(),
      rtspCredentials: credentialsSchema.optional(),
      ptzEnabled: z.boolean().default(true),
      zoomEnabled: z.boolean().default(false),
      route: importRouteSchema
    }).strict().parse(request.body);
    return importOnvifRoute(input);
  });
}
