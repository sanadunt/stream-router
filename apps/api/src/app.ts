import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { ZodError } from 'zod';
import { getEnv } from './config/env.js';
import { AppError } from './shared/errors.js';
import { allowedRequestHostnames, isAllowedRequestHost, isAllowedRequestOrigin } from './shared/request-origin.js';
import { authRoutes } from './modules/auth/auth-routes.js';
import { eventRoutes } from './modules/events/event-routes.js';
import { healthRoutes } from './modules/health/health-routes.js';
import { mqttBridgeRoutes } from './modules/mqtt-bridge/mqtt-bridge-routes.js';
import { mqttBrokerRoutes } from './modules/mqtt-bridge/mqtt-broker-routes.js';
import { shutdownMqttBridgeRuntime } from './modules/mqtt-bridge/mqtt-bridge-runtime.js';
import { shutdownPtzControllers } from './modules/ptz/ptz-controller.js';
import { ptzRoutes } from './modules/ptz/ptz-routes.js';
import { routeRoutes } from './modules/routes/route-routes.js';
import { settingsRoutes } from './modules/settings/settings-routes.js';
import { webrtcStreamRoutes } from './modules/webrtc-streams/webrtc-stream-routes.js';
import { recordingRoutes } from './modules/recordings/recording-routes.js';
import { stopRecordingManager } from './modules/recordings/recording-service.js';
import { onvifDiscoveryRoutes } from './modules/onvif-discovery/onvif-discovery-routes.js';
import { shutdownOnvifDiscovery } from './modules/onvif-discovery/onvif-discovery-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();
  const app = Fastify({
    logger: { level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'] },
    trustProxy: env.TRUST_PROXY,
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID()
  });

  await app.register(cookie);
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });

  // Perlindungan DNS rebinding: dipasang sebelum seluruh route (termasuk login Viewer tanpa
  // password, file statis, dan GET) sehingga domain penyerang yang di-resolve ke IP server tidak
  // pernah mendapat respons maupun cookie sesi. IP literal dan localhost selalu diterima, jadi
  // akses LAN lewat IP, healthcheck container, dan hook segment MediaMTX tetap berjalan.
  if (env.NODE_ENV === 'production') {
    const allowedHostnames = allowedRequestHostnames({
      corsOrigin: env.CORS_ORIGIN,
      publicHost: env.MEDIAMTX_PUBLIC_HOST,
      allowedHosts: env.ALLOWED_HOSTS
    });
    app.addHook('onRequest', async (request, reply) => {
      const host = request.headers.host;
      if (isAllowedRequestHost(host, allowedHostnames)) return;
      request.log.warn({ host: host?.slice(0, 255) }, 'Request ditolak: Host tidak ada di allowlist');
      return reply.code(421).send({
        error: {
          code: 'HOST_NOT_ALLOWED',
          message: 'Alamat host ini tidak diizinkan. Buka dashboard lewat alamat IP atau localhost, '
            + 'atau tambahkan hostname ini ke ALLOWED_HOSTS.',
          details: null,
          requestId: request.id
        }
      });
    });
  }
  // Dashboard melakukan beberapa read berkala dan browser video dapat membuka
  // banyak HTTP Range. Limit global ini melindungi API umum tanpa membuat
  // seluruh client development yang melewati satu proxy Vite saling memblokir.
  // Endpoint sensitif (login, PTZ, discovery, dan bulk action) tetap memiliki
  // limit route yang lebih ketat.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => new AppError(
      'RATE_LIMITED',
      `Terlalu banyak permintaan. Coba lagi dalam ${Math.max(1, Math.ceil(context.ttl / 1000))} detik.`,
      context.statusCode
    )
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return;
    if (request.url === '/api/auth/login') return;
    const origin = request.headers.origin;
    if (
      origin
      && env.NODE_ENV === 'production'
      && !isAllowedRequestOrigin(origin, env.CORS_ORIGIN, request.protocol, request.headers.host)
    ) {
      return reply.code(403).send({
        error: { code: 'CSRF_ORIGIN_REJECTED', message: 'Origin request ditolak', details: null, requestId: request.id }
      });
    }
  });

  // Handler wajib dipasang sebelum plugin route didaftarkan: Fastify menyalin error handler ke
  // context route saat plugin selesai dimuat, jadi handler yang dipasang belakangan tidak pernah
  // dipakai oleh route di dalam plugin.
  app.setErrorHandler((error, request, reply) => {
    const zodLikeError = error instanceof ZodError || (
      error instanceof Error
      && error.name === 'ZodError'
      && Array.isArray((error as Error & { issues?: unknown[] }).issues)
    );
    if (zodLikeError) {
      const validation = error as ZodError;
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Data request tidak valid',
          details: typeof validation.flatten === 'function' ? validation.flatten() : { issues: validation.issues },
          requestId: request.id
        }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId: request.id }
      });
    }
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (code === 'P2025') {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Data tidak ditemukan', details: null, requestId: request.id }
      });
    }
    // Error 4xx dari Fastify atau plugin (JSON rusak, body terlalu besar, content-type tidak
    // didukung) tetap memakai status aslinya, bukan menjadi 500.
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: typeof code === 'string' ? code : 'REQUEST_ERROR',
          message: error instanceof Error ? error.message : 'Request tidak valid',
          details: null,
          requestId: request.id
        }
      });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: env.NODE_ENV === 'production' ? 'Terjadi kesalahan internal' : (error instanceof Error ? error.message : String(error)),
        details: null,
        requestId: request.id
      }
    });
  });

  await app.register(authRoutes);
  await app.register(healthRoutes);
  await app.register(mqttBrokerRoutes);
  await app.register(mqttBridgeRoutes);
  await app.register(routeRoutes);
  await app.register(ptzRoutes);
  await app.register(settingsRoutes);
  await app.register(webrtcStreamRoutes);
  await app.register(eventRoutes);
  await app.register(recordingRoutes);
  await app.register(onvifDiscoveryRoutes);

  app.addHook('onClose', async () => {
    await shutdownMqttBridgeRuntime();
    await shutdownPtzControllers();
    shutdownOnvifDiscovery();
    stopRecordingManager();
  });

  if (env.NODE_ENV === 'production') {
    const webRoot = path.resolve(__dirname, '../../web/dist');
    await app.register(staticPlugin, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan', details: null, requestId: request.id } });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
