import path from 'node:path';
import http from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const streamFileFixtureDirectory = path.resolve(here, '../../../../data/integration-stream-files');
const streamFileFixturePath = path.join(streamFileFixtureDirectory, 'camera-sample.mp4');
const streamFileFixture = Buffer.from('integration-mp4-range-fixture');
process.env.NODE_ENV = 'test';
process.env.PORT = '3999';
process.env.HOST = '127.0.0.1';
process.env.DATABASE_URL = 'file:../data/integration.db';
process.env.FFMPEG_PATH = path.resolve(here, '../fixtures/fake-ffmpeg.mjs');
process.env.AUTH_SECRET = 'integration-auth-secret-0123456789012345';
process.env.APP_ENCRYPTION_KEY = 'integration-encryption-key-0123456789';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'integration-password';
process.env.OPERATOR_PASSWORD = 'integration-operator-password';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.STREAM_VIEW_ALLOW_INSECURE_HTTP = 'true';
process.env.MEDIAMTX_ENABLED = 'true';
process.env.MEDIAMTX_API_URL = 'http://127.0.0.1:29997';
process.env.MEDIAMTX_RTSP_URL = 'rtsp://127.0.0.1:28554';
process.env.MEDIAMTX_PLAYBACK_URL = 'http://127.0.0.1:29996';
process.env.MEDIAMTX_READY_TIMEOUT_MS = '100';
process.env.RECORDING_PATH = 'data/integration-recordings';

const testMediaApiPort = 29997;
const testMediaPlaybackPort = 29996;

const fakeMediaPaths = new Set<string>();
const fakeMediaConfigs = new Map<string, Record<string, unknown>>();
let fakeMediaReady = true;
const fakeMediaServer = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const parts = url.pathname.split('/');
  if (url.pathname === '/v3/paths/list') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ itemCount: fakeMediaPaths.size, items: [...fakeMediaPaths].map((name) => ({ name, ready: true })) }));
    return;
  }
  if (url.pathname === '/v3/config/global/patch') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (url.pathname === '/v3/config/paths/list') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      itemCount: fakeMediaPaths.size,
      items: [...fakeMediaPaths].map((name) => ({ name, ...(fakeMediaConfigs.get(name) ?? {}) }))
    }));
    return;
  }
  if (url.pathname.startsWith('/v3/paths/get/')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: fakeMediaReady, tracks: fakeMediaReady ? ['H264'] : [], bytesReceived: fakeMediaReady ? 100 : 0 }));
    return;
  }
  if (url.pathname.startsWith('/v3/config/paths/')) {
    const operation = parts[4];
    const name = decodeURIComponent(parts.slice(5).join('/'));
    if (operation === 'get') {
      if (!fakeMediaPaths.has(name)) { response.statusCode = 404; response.end(); return; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name, ...(fakeMediaConfigs.get(name) ?? {}) }));
      return;
    }
    if (operation === 'delete') {
      fakeMediaPaths.delete(name);
      fakeMediaConfigs.delete(name);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      fakeMediaPaths.add(name);
      fakeMediaConfigs.set(name, { ...(fakeMediaConfigs.get(name) ?? {}), ...body });
    }
    response.statusCode = 204;
    response.end();
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise<void>((resolve, reject) => {
  fakeMediaServer.once('error', reject);
  fakeMediaServer.listen(testMediaApiPort, '127.0.0.1', resolve);
});

const { prisma } = await import('../../src/db/client.js');
const { buildApp } = await import('../../src/app.js');
const { ensureRoleCredentials } = await import('../../src/modules/auth/auth-service.js');
const { signSession } = await import('../../src/shared/crypto.js');
const { workerManager } = await import('../../src/modules/workers/worker-manager.js');
const { mediamtxHookToken } = await import('../../src/modules/recordings/recording-routes.js');
const {
  cleanupExpiredOnvifSessions,
  importOnvifRoute,
  setOnvifDiscoveryAdapterForTests
} = await import('../../src/modules/onvif-discovery/onvif-discovery-service.js');
setOnvifDiscoveryAdapterForTests({
  scan: async () => [
    {
      urn: 'urn:uuid:integration-camera',
      host: '192.168.99.20',
      port: 80,
      path: '/onvif/device_service',
      useTls: false,
      scopes: ['onvif://www.onvif.org/name/Integration%20Camera'],
      xaddrs: ['http://192.168.99.20/onvif/device_service']
    },
    {
      urn: 'URN:UUID:INTEGRATION-CAMERA',
      host: '192.168.99.20',
      port: 80,
      path: '/onvif/device_service',
      useTls: false,
      scopes: ['onvif://www.onvif.org/type/video_encoder'],
      xaddrs: ['http://192.168.99.20/onvif/device_service']
    }
  ],
  inspect: async (target, credentials) => {
    if (credentials.password === 'wrong') throw new Error('401 unauthorized');
    return {
      device: {
        manufacturer: 'Integration Vendor',
        model: 'Dual Channel',
        hostname: 'Lobby Camera',
        firmwareVersion: '1.2.3',
        serialNumber: 'SERIAL-REDACTED'
      },
      profiles: [
        {
          token: '000',
          name: 'Main',
          encoding: 'H264',
          width: 1920,
          height: 1080,
          ptz: false,
          zoom: false,
          streamUri: `rtsp://firmware-host:554/Streaming/Channels/000`
        },
        {
          token: '100',
          name: 'PTZ Channel',
          encoding: 'H264',
          width: 1280,
          height: 720,
          ptz: true,
          zoom: true,
          streamUri: `rtsp://firmware-host:554/Streaming/Channels/100`
        }
      ]
    };
  }
});
const app = await buildApp();
let cookie = '';
let viewerCookie = '';
let operatorCookie = '';
let routeId = '';
let standaloneStreamId = '';

beforeAll(async () => {
  await mkdir(streamFileFixtureDirectory, { recursive: true });
  await writeFile(streamFileFixturePath, streamFileFixture);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS StreamRoute (id TEXT PRIMARY KEY, cameraKey TEXT UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', inputUrlEncrypted TEXT NOT NULL, inputProtocol TEXT NOT NULL, outputsEncrypted TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, autoStart BOOLEAN NOT NULL DEFAULT false, localViewEnabled BOOLEAN NOT NULL DEFAULT false, localAudioMode TEXT NOT NULL DEFAULT 'COPY', onlineRelayEnabled BOOLEAN NOT NULL DEFAULT true, onlineAudioMode TEXT NOT NULL DEFAULT 'COPY', recordingEnabled BOOLEAN NOT NULL DEFAULT false, recordingRetentionMode TEXT NOT NULL DEFAULT 'INHERIT', recordingRetentionDays INTEGER, recordingRetentionGb REAL, ffmpegMode TEXT NOT NULL DEFAULT 'COPY', ffmpegOptions TEXT NOT NULL DEFAULT '{}', retryPolicy TEXT NOT NULL DEFAULT '{}', webrtcEnabled BOOLEAN NOT NULL DEFAULT false, webrtcUrlEncrypted TEXT, webrtcMode TEXT NOT NULL DEFAULT 'IFRAME', ptzEnabled BOOLEAN NOT NULL DEFAULT false, ptzProvider TEXT NOT NULL DEFAULT 'NONE', ptzZoomEnabled BOOLEAN NOT NULL DEFAULT false, ptzConfigEncrypted TEXT, ptzMqttBrokerId TEXT, mqttBridgeEnabled BOOLEAN NOT NULL DEFAULT false, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
  const routeColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("StreamRoute")`);
  const routeAdditions = [
    ['description', `TEXT NOT NULL DEFAULT ''`],
    ['ptzEnabled', `BOOLEAN NOT NULL DEFAULT false`],
    ['ptzProvider', `TEXT NOT NULL DEFAULT 'NONE'`],
    ['ptzZoomEnabled', `BOOLEAN NOT NULL DEFAULT false`],
    ['ptzConfigEncrypted', 'TEXT'],
    ['ptzMqttBrokerId', 'TEXT'],
    ['mqttBridgeEnabled', 'BOOLEAN NOT NULL DEFAULT false'],
    ['cameraKey', 'TEXT'],
    ['localViewEnabled', 'BOOLEAN NOT NULL DEFAULT false'],
    ['localAudioMode', `TEXT NOT NULL DEFAULT 'COPY'`],
    ['onlineRelayEnabled', 'BOOLEAN NOT NULL DEFAULT true'],
    ['onlineAudioMode', `TEXT NOT NULL DEFAULT 'COPY'`],
    ['recordingEnabled', 'BOOLEAN NOT NULL DEFAULT false'],
    ['recordingRetentionMode', `TEXT NOT NULL DEFAULT 'INHERIT'`],
    ['recordingRetentionDays', 'INTEGER'],
    ['recordingRetentionGb', 'REAL']
  ] as const;
  for (const [name, definition] of routeAdditions) {
    if (!routeColumns.some((column) => column.name === name)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "StreamRoute" ADD COLUMN "${name}" ${definition}`);
    }
  }
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS RouteRun (id TEXT PRIMARY KEY, routeId TEXT NOT NULL, pid INTEGER, status TEXT NOT NULL, startedAt DATETIME, stoppedAt DATETIME, exitCode INTEGER, signal TEXT, restartCount INTEGER NOT NULL DEFAULT 0, lastError TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, FOREIGN KEY(routeId) REFERENCES StreamRoute(id) ON DELETE CASCADE)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS AppSetting (key TEXT PRIMARY KEY, value TEXT NOT NULL, isSecret BOOLEAN NOT NULL DEFAULT false, updatedAt DATETIME NOT NULL)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS AuditLog (id TEXT PRIMARY KEY, action TEXT NOT NULL, routeId TEXT, metadataJson TEXT NOT NULL DEFAULT '{}', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MonitoringLayout (id TEXT PRIMARY KEY, name TEXT NOT NULL, layout TEXT NOT NULL DEFAULT '1', slots TEXT NOT NULL DEFAULT '[]', isDefault BOOLEAN NOT NULL DEFAULT false, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS WebrtcStream (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', urlEncrypted TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'IFRAME', enabled BOOLEAN NOT NULL DEFAULT true, ptzEnabled BOOLEAN NOT NULL DEFAULT false, ptzProvider TEXT NOT NULL DEFAULT 'NONE', ptzZoomEnabled BOOLEAN NOT NULL DEFAULT false, ptzConfigEncrypted TEXT, ptzMqttBrokerId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MqttBroker (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mqtt', host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 1883, path TEXT NOT NULL DEFAULT '/mqtt', rootTopic TEXT NOT NULL DEFAULT 'Turjawali', username TEXT NOT NULL DEFAULT '', passwordEncrypted TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS RouteMqttBridgeSubscription (id TEXT PRIMARY KEY, routeId TEXT NOT NULL, brokerId TEXT NOT NULL, commandTopic TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, FOREIGN KEY(routeId) REFERENCES StreamRoute(id) ON DELETE CASCADE, FOREIGN KEY(brokerId) REFERENCES MqttBroker(id) ON DELETE CASCADE)`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS StreamRoute_cameraKey_key ON StreamRoute(cameraKey)`);
  // sizeBytes REAL (migration 20261024120000): tabel dari database integrasi lama dibuat ulang.
  const legacyRecordingColumns = await prisma.$queryRawUnsafe<Array<{ name: string; type: string }>>(`PRAGMA table_info("RecordingSegment")`);
  if (legacyRecordingColumns.some((column) => column.name === 'sizeBytes' && column.type !== 'REAL')) {
    await prisma.$executeRawUnsafe(`DROP TABLE "RecordingSegment"`);
  }
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS RecordingSegment (id TEXT PRIMARY KEY, routeId TEXT, cameraKey TEXT NOT NULL, cameraName TEXT NOT NULL, storageRoot TEXT NOT NULL, relativePath TEXT NOT NULL, startTime DATETIME NOT NULL, endTime DATETIME NOT NULL, durationMs INTEGER NOT NULL, sizeBytes REAL NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETE', protected BOOLEAN NOT NULL DEFAULT false, deletionReason TEXT, errorMessage TEXT, deletedAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, FOREIGN KEY(routeId) REFERENCES StreamRoute(id) ON DELETE SET NULL)`);
  const recordingColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("RecordingSegment")`);
  if (!recordingColumns.some((column) => column.name === 'errorMessage')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "RecordingSegment" ADD COLUMN "errorMessage" TEXT`);
  }
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS RecordingSegment_storageRoot_relativePath_key ON RecordingSegment(storageRoot, relativePath)`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS RouteMqttBridgeSubscription_routeId_brokerId_key ON RouteMqttBridgeSubscription(routeId, brokerId)`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS RouteMqttBridgeSubscription_brokerId_commandTopic_key ON RouteMqttBridgeSubscription(brokerId, commandTopic)`);
  const streamColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("WebrtcStream")`);
  const streamAdditions = [
    ['ptzEnabled', `BOOLEAN NOT NULL DEFAULT false`],
    ['ptzProvider', `TEXT NOT NULL DEFAULT 'NONE'`],
    ['ptzZoomEnabled', `BOOLEAN NOT NULL DEFAULT false`],
    ['ptzConfigEncrypted', 'TEXT'],
    ['ptzMqttBrokerId', 'TEXT']
  ] as const;
  for (const [name, definition] of streamAdditions) {
    if (!streamColumns.some((column) => column.name === name)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "WebrtcStream" ADD COLUMN "${name}" ${definition}`);
    }
  }
  const brokerColumns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("MqttBroker")`);
  if (!brokerColumns.some((column) => column.name === 'rootTopic')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "MqttBroker" ADD COLUMN "rootTopic" TEXT NOT NULL DEFAULT 'Turjawali'`);
  }
  await prisma.recordingSegment.deleteMany();
  await prisma.streamRoute.deleteMany();
  await prisma.webrtcStream.deleteMany();
  await prisma.routeMqttBridgeSubscription.deleteMany();
  await prisma.mqttBroker.deleteMany();
  await prisma.appSetting.deleteMany();
  await prisma.appSetting.createMany({
    data: [
      { key: 'mediamtx.apiPort', value: String(testMediaApiPort), isSecret: false },
      { key: 'mediamtx.playbackPort', value: String(testMediaPlaybackPort), isSecret: false },
      { key: 'mediamtx.rtspPort', value: '28554', isSecret: false }
    ]
  });
  await ensureRoleCredentials();
});

afterAll(async () => {
  setOnvifDiscoveryAdapterForTests();
  await workerManager.shutdown();
  await app.close();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => fakeMediaServer.close(() => resolve()));
  await rm(path.resolve(here, '../../../../data/integration-recordings'), { recursive: true, force: true });
  await rm(streamFileFixtureDirectory, { recursive: true, force: true });
});

describe('API integration', () => {
  it('menolak endpoint administratif tanpa auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/routes' })).statusCode).toBe(401);
  });

  it('menolak cookie palsu credentialVersion 0 setelah bootstrap; login dan logout tetap normal', async () => {
    const secret = process.env.AUTH_SECRET ?? '';
    for (const role of ['admin', 'operator'] as const) {
      const stored = await prisma.appSetting.findUnique({ where: { key: `auth.${role}.credentialVersion` } });
      expect(stored?.value).toMatch(/^[0-9a-f-]{36}$/);
      const forged = `stream_router_session=${signSession({ username: role, role, credentialVersion: '0' }, secret)}`;
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: forged } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/routes', headers: { cookie: forged } })).statusCode).toBe(401);
      const farFuture = `stream_router_session=${signSession({ username: role, role, credentialVersion: stored?.value }, secret, 10 * 365 * 86400)}`;
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: farFuture } })).statusCode).toBe(401);
    }

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.40',
      payload: { role: 'admin', password: 'integration-password' }
    });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toContain('Max-Age=86400');
    // Login Administrator juga memasang cookie perangkat login yang hanya dikirim ke endpoint login.
    expect(String(login.headers['set-cookie'])).toMatch(/stream_router_login_device=[^;]+; Max-Age=2592000; Path=\/api\/auth\/login; HttpOnly; SameSite=Strict/);
    const sessionCookie = sessionCookieFrom(login);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie } });
    expect(me.json()).toEqual({ user: { username: 'admin', role: 'admin' } });
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: sessionCookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('stream_router_session=;');
  });

  it('menolak sesi bila versi credential hilang dan login berikutnya membuat versi baru', async () => {
    const login = () => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.41',
      payload: { role: 'operator', password: 'integration-operator-password' }
    });
    const versionKey = 'auth.operator.credentialVersion';
    const previous = await prisma.appSetting.findUniqueOrThrow({ where: { key: versionKey } });
    const oldSession = sessionCookieFrom((await login()));
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldSession } })).statusCode).toBe(200);

    await prisma.appSetting.delete({ where: { key: versionKey } });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldSession } })).statusCode).toBe(401);

    const relogin = await login();
    expect(relogin.statusCode).toBe(200);
    const restored = await prisma.appSetting.findUniqueOrThrow({ where: { key: versionKey } });
    expect(restored.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(restored.value).not.toBe(previous.value);
    const newSession = sessionCookieFrom(relogin);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: newSession } })).statusCode).toBe(200);

    await ensureRoleCredentials();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: newSession } })).statusCode).toBe(200);
  });

  it('login, CRUD, start idempotent, dan stop manual', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { role: 'admin', password: 'integration-password' } });
    expect(login.statusCode).toBe(200);
    cookie = sessionCookieFrom(login);

    const created = await app.inject({
      method: 'POST', url: '/api/routes', headers: { cookie },
      payload: { name: 'Integration Route', inputUrl: 'rtsp://admin:secret@127.0.0.1/live', outputs: ['rtmp://user:key@127.0.0.1/live/out'], enabled: true, autoStart: false, ffmpegMode: 'COPY', ffmpegOptions: {}, retryPolicy: {} }
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    routeId = body.id;
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.outputsMasked).toEqual(['rtmp://***:***@127.0.0.1/live/***']);
    expect((await app.inject({ method: 'GET', url: `/api/routes/${routeId}/edit`, headers: { cookie } })).json().outputs)
      .toEqual(['rtmp://user:key@127.0.0.1/live/out']);

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/routes/${routeId}/start`, headers: { cookie } }),
      app.inject({ method: 'POST', url: `/api/routes/${routeId}/start`, headers: { cookie } })
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(workerManager.allSnapshots()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logs = (await app.inject({ method: 'GET', url: `/api/routes/${routeId}/logs?component=FFMPEG_ONLINE`, headers: { cookie } })).json();
    const messages = (logs.items as Array<{ message: string }>).map((item) => item.message);
    expect(messages.find((message) => message.startsWith('Menjalankan relay online'))).toContain('rtmp://***:***@127.0.0.1/live/***');
    expect(messages.join('\n')).toContain("Output #0, flv, to 'rtmp://***:***@127.0.0.1/live/***':");
    expect(JSON.stringify(logs)).not.toContain('live/out');

    const stopped = await app.inject({ method: 'POST', url: `/api/routes/${routeId}/stop`, headers: { cookie } });
    expect(stopped.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workerManager.allSnapshots()).toHaveLength(0);
  });

  it('inisiasi mengaktifkan route disabled dan switch-off menghentikan proses', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/routes',
      headers: { cookie },
      payload: {
        name: 'Initialization Route',
        inputUrl: 'rtsp://127.0.0.1/initialize',
        outputs: ['rtmp://127.0.0.1/live/initialize'],
        enabled: false,
        autoStart: false,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: {}
      }
    });
    const initializationId = created.json().id as string;
    const initialized = await app.inject({ method: 'POST', url: `/api/routes/${initializationId}/initialize`, headers: { cookie } });
    expect(initialized.statusCode).toBe(200);
    expect(['STARTING', 'RUNNING']).toContain(initialized.json().status);
    expect((await app.inject({ method: 'GET', url: `/api/routes/${initializationId}`, headers: { cookie } })).json().enabled).toBe(true);
    await app.inject({ method: 'POST', url: `/api/routes/${initializationId}/deinitialize`, headers: { cookie } });
    expect(workerManager.snapshot(initializationId).status).toBe('STOPPED');
    expect((await app.inject({ method: 'GET', url: `/api/routes/${initializationId}`, headers: { cookie } })).json().enabled).toBe(false);
  });

  it('membatasi API berdasarkan role dan mengizinkan viewer membuka monitor', async () => {
    const operatorLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { role: 'operator', password: 'integration-operator-password' } });
    const viewerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { role: 'viewer' } });
    operatorCookie = sessionCookieFrom(operatorLogin);
    viewerCookie = sessionCookieFrom(viewerLogin);
    expect(operatorLogin.json()).toMatchObject({ user: { role: 'operator' } });
    expect(viewerLogin.json()).toMatchObject({ user: { role: 'viewer' } });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { role: 'admin' } })).statusCode).toBe(400);
    const operatorRoutes = await app.inject({ method: 'GET', url: '/api/routes', headers: { cookie: operatorCookie } });
    expect(operatorRoutes.statusCode).toBe(200);
    expect(operatorRoutes.body).toContain('rtmp://127.0.0.1/live/***');
    expect(operatorRoutes.body).not.toMatch(/live\/(?:out|initialize)\b/);
    expect((await app.inject({ method: 'POST', url: '/api/routes', headers: { cookie: operatorCookie }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/routes', headers: { cookie: viewerCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: '/api/viewer/ptz/command',
      headers: { cookie: viewerCookie },
      payload: {
        targetType: 'ROUTE',
        targetId: '11111111-1111-4111-8111-111111111111',
        command: { type: 'move', direction: 'left', speed: 0.4, durationMs: 0 }
      }
    })).statusCode).toBe(403);
  });

  it('menemukan, memeriksa, dan mengimpor satu profile ONVIF sebagai route STOPPED', async () => {
    expect((await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/scan',
      headers: { cookie: operatorCookie },
      payload: {}
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie: viewerCookie },
      payload: {}
    })).statusCode).toBe(403);

    const interfaces = await app.inject({
      method: 'GET',
      url: '/api/settings/onvif-discovery/interfaces',
      headers: { cookie }
    });
    expect(interfaces.statusCode).toBe(200);
    expect(Array.isArray(interfaces.json().items)).toBe(true);

    const scanned = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/scan',
      headers: { cookie },
      payload: { timeoutMs: 1000 }
    });
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().items).toHaveLength(1);
    expect(scanned.json().items[0]).toMatchObject({
      name: 'Integration Camera',
      host: '192.168.99.20',
      existingRoutes: []
    });

    const authFailed = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie },
      payload: {
        target: scanned.json().items[0],
        credentials: { username: 'admin', password: 'wrong' }
      }
    });
    expect(authFailed.statusCode).toBe(401);
    expect(JSON.stringify(authFailed.json())).not.toContain('wrong');

    const inspected = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie },
      payload: {
        target: scanned.json().items[0],
        credentials: { username: 'admin@example', password: 'camera:secret/1' }
      }
    });
    expect(inspected.statusCode).toBe(200);
    const inspection = inspected.json();
    expect(inspection.profiles).toMatchObject([
      { token: '000', ptz: false, streamAvailable: true },
      { token: '100', ptz: true, zoom: true, streamAvailable: true }
    ]);
    expect(JSON.stringify(inspection)).not.toContain('camera:secret/1');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/import',
      headers: { cookie },
      payload: {
        sessionId: inspection.sessionId,
        profileToken: '100',
        ptzProfileToken: '100',
        ptzEnabled: true,
        zoomEnabled: true,
        route: {
          name: 'Discovered Dual Channel',
          cameraKey: 'discovered-dual-channel',
          description: 'Imported by integration discovery'
        }
      }
    });
    expect(imported.statusCode).toBe(200);
    const importedRouteId = imported.json().route.id as string;
    expect(workerManager.snapshot(importedRouteId).status).toBe('STOPPED');

    const edit = await app.inject({
      method: 'GET',
      url: `/api/routes/${importedRouteId}/edit`,
      headers: { cookie }
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({
      enabled: true,
      autoStart: false,
      localViewEnabled: true,
      localAudioMode: 'COPY',
      onlineRelayEnabled: false,
      recordingEnabled: false
    });
    const importedInput = new URL(edit.json().inputUrl);
    expect(importedInput.hostname).toBe('192.168.99.20');
    expect(importedInput.pathname).toBe('/Streaming/Channels/100');
    expect(importedInput.username).toBe('admin%40example');

    const ptz = await app.inject({
      method: 'GET',
      url: `/api/routes/${importedRouteId}/ptz`,
      headers: { cookie }
    });
    expect(ptz.statusCode).toBe(200);
    expect(ptz.json()).toMatchObject({
      provider: 'ONVIF',
      enabled: true,
      zoomEnabled: true,
      profileToken: '100',
      passwordConfigured: true
    });
    expect(JSON.stringify(ptz.json())).not.toContain('camera:secret/1');
    await app.inject({ method: 'DELETE', url: `/api/routes/${importedRouteId}`, headers: { cookie } });
  });

  it('menghapus session inspeksi ONVIF yang kedaluwarsa', async () => {
    const inspected = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie },
      payload: {
        target: {
          host: '192.168.99.21',
          port: 80,
          path: '/onvif/device_service',
          useTls: false
        },
        credentials: { username: 'admin', password: 'valid' }
      }
    });
    expect(inspected.statusCode).toBe(200);
    cleanupExpiredOnvifSessions(Number.MAX_SAFE_INTEGER);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/import',
      headers: { cookie },
      payload: {
        sessionId: inspected.json().sessionId,
        profileToken: '000',
        ptzEnabled: false,
        zoomEnabled: false,
        route: { name: 'Expired Session Route' }
      }
    });
    expect(imported.statusCode).toBe(410);
  });

  it('rollback import ONVIF tidak meninggalkan route parsial ketika konfigurasi PTZ gagal', async () => {
    const inspected = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie },
      payload: {
        target: {
          host: '192.168.99.22',
          port: 80,
          path: '/onvif/device_service',
          useTls: false
        },
        credentials: { username: 'admin', password: 'valid' }
      }
    });
    const before = await prisma.streamRoute.count();
    await expect(importOnvifRoute({
      sessionId: inspected.json().sessionId,
      profileToken: '100',
      ptzProfileToken: '<invalid>',
      ptzEnabled: true,
      zoomEnabled: true,
      route: {
        cameraKey: 'rollback-onvif',
        name: 'Rollback ONVIF',
        description: '',
        outputs: [],
        enabled: true,
        autoStart: false,
        localViewEnabled: true,
        localAudioMode: 'COPY',
        onlineRelayEnabled: false,
        recordingEnabled: false,
        recordingRetentionMode: 'INHERIT',
        ffmpegMode: 'COPY',
        onlineAudioMode: 'COPY',
        ffmpegOptions: {
          videoBitrateKbps: 2500,
          audioBitrateKbps: 128,
          preset: 'veryfast',
          gop: 50
        },
        retryPolicy: {
          initialDelayMs: 2000,
          maxDelayMs: 60000,
          maxRetries: 10,
          jitterRatio: 0.2,
          stableResetMs: 60000
        },
        webrtc: { enabled: false, mode: 'IFRAME' }
      }
    })).rejects.toThrow(/Media Profile Token/);
    expect(await prisma.streamRoute.count()).toBe(before);
  });

  it('menghapus cookie sesi saat logout', async () => {
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('stream_router_session=;');
    expect(logout.headers['set-cookie']).toContain('HttpOnly');
    expect(logout.headers['set-cookie']).toContain('SameSite=Strict');
  });

  it('hanya mengekspos route WebRTC yang sedang RUNNING ke viewer', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/routes', headers: { cookie },
      payload: {
        name: 'Viewer Route', description: 'Kamera untuk pengujian viewer', inputUrl: 'rtsp://127.0.0.1/viewer', outputs: ['rtmp://127.0.0.1/live/viewer'],
        enabled: true, autoStart: false, ffmpegMode: 'COPY', ffmpegOptions: {}, retryPolicy: {},
        webrtc: { enabled: true, url: 'http://127.0.0.1:8889/embed/viewer', mode: 'IFRAME' }
      }
    });
    const viewerRouteId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/routes/${viewerRouteId}/start`, headers: { cookie } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: viewerRouteId,
      description: 'Kamera untuk pengujian viewer',
      webrtc: { url: 'http://127.0.0.1:8889/embed/viewer', mode: 'IFRAME' }
    })]));
    await workerManager.stop(viewerRouteId, true);
  });

  it('membuat Stream View standalone tanpa Stream Route dan menyensor token pada API admin', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/webrtc-streams',
      headers: { cookie },
      payload: {
        name: 'Standalone Lobby',
        description: 'Link independen tanpa worker FFmpeg',
        url: 'http://127.0.0.1:8889/embed/lobby?token=viewer-secret-token',
        mode: 'IFRAME',
        enabled: true
      }
    });
    expect(created.statusCode).toBe(201);
    standaloneStreamId = created.json().id as string;
    expect(created.json().urlMasked).toContain('token=***');
    expect(created.json().urlMasked).not.toContain('viewer-secret-token');

    const response = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: created.json().id,
      name: 'Standalone Lobby',
      webrtc: expect.objectContaining({
        url: 'http://127.0.0.1:8889/embed/lobby?token=viewer-secret-token',
        mode: 'IFRAME'
      })
    })]));
  });

  it('melewati Stream Route local-only yang belum READY tanpa menggagalkan Viewer', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/routes',
      headers: { cookie },
      payload: {
        cameraKey: 'viewer-not-ready',
        name: 'Viewer Not Ready',
        inputUrl: 'rtsp://127.0.0.1/viewer-not-ready',
        outputs: [],
        enabled: true,
        autoStart: false,
        localViewEnabled: true,
        onlineRelayEnabled: false,
        recordingEnabled: false,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: {}
      }
    });
    expect(created.statusCode).toBe(201);
    const notReadyId = created.json().id as string;

    const viewer = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: notReadyId })
    ]));

    expect((await app.inject({
      method: 'DELETE',
      url: `/api/routes/${notReadyId}`,
      headers: { cookie }
    })).statusCode).toBe(204);
  });

  it('menyimpan tipe Stream View eksplisit dan menormalisasi YouTube hanya untuk Viewer', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/webrtc-streams',
      headers: { cookie },
      payload: {
        name: 'Multi Type',
        description: 'HLS lalu YouTube',
        url: 'https://media.example.com/live/camera.m3u8',
        mode: 'HLS',
        enabled: true
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ mode: 'HLS' });
    const streamId = created.json().id as string;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/webrtc-streams/${streamId}`,
      headers: { cookie },
      payload: {
        url: 'https://youtu.be/dQw4w9WgXcQ',
        mode: 'YOUTUBE'
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ mode: 'YOUTUBE' });

    const viewer = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } });
    expect(viewer.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: streamId,
      webrtc: expect.objectContaining({
        mode: 'YOUTUBE',
        url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1',
        openUrl: 'https://youtu.be/dQw4w9WgXcQ'
      })
    })]));

    expect((await app.inject({
      method: 'DELETE',
      url: `/api/webrtc-streams/${streamId}`,
      headers: { cookie }
    })).statusCode).toBe(204);
  });

  it('memilih MP4 server tanpa membocorkan path dan melayani HTTP Range ke Viewer', async () => {
    const direct = await app.inject({
      method: 'POST',
      url: '/api/webrtc-streams',
      headers: { cookie },
      payload: {
        name: 'MP4 HTTP',
        description: 'URL MP4 tetap didukung',
        url: 'https://media.example.com/camera.mp4',
        mode: 'MP4',
        enabled: true
      }
    });
    expect(direct.statusCode).toBe(201);
    expect(direct.json()).toMatchObject({ mode: 'MP4', sourceType: 'URL' });
    expect((await app.inject({
      method: 'DELETE',
      url: `/api/webrtc-streams/${direct.json().id as string}`,
      headers: { cookie }
    })).statusCode).toBe(204);

    const browse = await app.inject({
      method: 'GET',
      url: `/api/webrtc-streams/files?path=${encodeURIComponent(streamFileFixtureDirectory)}`,
      headers: { cookie }
    });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({
      name: 'camera-sample.mp4',
      path: streamFileFixturePath,
      type: 'FILE',
      sizeBytes: streamFileFixture.length
    })]));
    expect((await app.inject({
      method: 'GET',
      url: `/api/webrtc-streams/files?path=${encodeURIComponent(streamFileFixtureDirectory)}`,
      headers: { cookie: viewerCookie }
    })).statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/webrtc-streams',
      headers: { cookie },
      payload: {
        name: 'MP4 File Server',
        description: 'Fixture playback lokal',
        url: streamFileFixturePath,
        mode: 'MP4',
        sourceType: 'FILE',
        enabled: true
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      sourceType: 'FILE',
      urlMasked: 'File server · camera-sample.mp4'
    });
    expect(JSON.stringify(created.json())).not.toContain(streamFileFixtureDirectory);
    const streamId = created.json().id as string;

    const viewer = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } });
    const viewerItem = viewer.json().items.find((item: { id: string }) => item.id === streamId);
    expect(viewerItem).toMatchObject({
      webrtc: {
        mode: 'MP4',
        url: `/api/viewer/stream-files/${streamId}`,
        openUrl: `/api/viewer/stream-files/${streamId}`
      }
    });
    expect(JSON.stringify(viewerItem)).not.toContain(streamFileFixtureDirectory);

    const ranged = await app.inject({
      method: 'GET',
      url: `/api/viewer/stream-files/${streamId}`,
      headers: { cookie: viewerCookie, range: 'bytes=1-3' }
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect(ranged.headers['content-range']).toBe(`bytes 1-3/${streamFileFixture.length}`);
    expect(ranged.rawPayload).toEqual(streamFileFixture.subarray(1, 4));

    expect((await app.inject({
      method: 'DELETE',
      url: `/api/webrtc-streams/${streamId}`,
      headers: { cookie }
    })).statusCode).toBe(204);
  });

  it('menggunakan profil broker bersama untuk PTZ MQTT tanpa membocorkan password', async () => {
    const password = 'mqtt-integration-secret';
    const broker = await app.inject({
      method: 'POST',
      url: '/api/mqtt-brokers',
      headers: { cookie },
      payload: {
        name: 'PTZ Shared Broker',
        description: 'Broker PTZ integration',
        protocol: 'ws',
        host: '127.0.0.1',
        port: 1,
        rootTopic: 'Turjawali',
        username: 'camera-control',
        password
      }
    });
    expect(broker.statusCode).toBe(201);
    const brokerId = broker.json().id as string;
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/webrtc-streams/${standaloneStreamId}/ptz`,
      headers: { cookie },
      payload: {
        provider: 'MQTT',
        enabled: true,
        zoomEnabled: true,
        brokerId,
        cameraId: 'cctv-tes-1'
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      provider: 'MQTT',
      brokerId,
      topicRoot: 'Turjawali',
      fullTopic: 'Turjawali/cctv-tes-1',
      connection: { state: 'UNTESTED' }
    });
    expect(JSON.stringify(updated.json())).not.toContain(password);

    const stored = await prisma.webrtcStream.findUniqueOrThrow({ where: { id: standaloneStreamId } });
    expect(stored.ptzConfigEncrypted).not.toContain(password);

    const read = await app.inject({ method: 'GET', url: `/api/webrtc-streams/${standaloneStreamId}/ptz`, headers: { cookie } });
    expect(read.statusCode).toBe(200);
    expect(JSON.stringify(read.json())).not.toContain(password);

    const tested = await app.inject({
      method: 'POST',
      url: `/api/webrtc-streams/${standaloneStreamId}/ptz/test`,
      headers: { cookie }
    });
    expect(tested.statusCode).toBe(502);
    const failedStatus = await app.inject({ method: 'GET', url: `/api/webrtc-streams/${standaloneStreamId}/ptz`, headers: { cookie } });
    expect(failedStatus.json().connection).toMatchObject({ state: 'ERROR' });
    expect(JSON.stringify(failedStatus.json())).not.toContain(password);

    const viewer = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerCookie } });
    expect(viewer.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: standaloneStreamId,
      ptz: expect.objectContaining({
        enabled: true,
        provider: 'MQTT',
        zoomEnabled: true,
        targetType: 'WEBRTC_STREAM',
        targetId: standaloneStreamId
      })
    })]));
  });

  it('mengelola profil broker terenkripsi dan assignment MQTT→ONVIF dengan cascade delete', async () => {
    const onvif = await app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId}/ptz`,
      headers: { cookie },
      payload: {
        provider: 'ONVIF',
        enabled: true,
        zoomEnabled: true,
        host: '127.0.0.1',
        port: 80,
        username: 'camera-admin',
        password: 'onvif-integration-secret',
        useTls: false,
        path: '/onvif/device_service',
        profileToken: '100'
      }
    });
    expect(onvif.statusCode).toBe(200);
    expect(onvif.json()).toMatchObject({ provider: 'ONVIF', profileToken: '100' });

    const brokerPassword = 'broker-integration-secret';
    const broker = await app.inject({
      method: 'POST',
      url: '/api/mqtt-brokers',
      headers: { cookie },
      payload: {
        name: 'Integration Online',
        description: 'Broker integration test',
        protocol: 'mqtt',
        host: '127.0.0.1',
        port: 1883,
        rootTopic: 'Turjawali',
        username: 'bridge',
        password: brokerPassword
      }
    });
    expect(broker.statusCode).toBe(201);
    expect(broker.json()).toMatchObject({ name: 'Integration Online', passwordConfigured: true });
    expect(JSON.stringify(broker.json())).not.toContain(brokerPassword);
    const brokerId = broker.json().id as string;
    const storedBroker = await prisma.mqttBroker.findUniqueOrThrow({ where: { id: brokerId } });
    expect(storedBroker.passwordEncrypted).not.toContain(brokerPassword);

    const bridge = await app.inject({
      method: 'PUT',
      url: `/api/routes/${routeId}/ptz/mqtt-bridge`,
      headers: { cookie },
      payload: {
        enabled: true,
        subscriptions: [{ brokerId, cameraId: 'cctv-tes-1' }]
      }
    });
    expect(bridge.statusCode).toBe(200);
    expect(bridge.json()).toMatchObject({
      enabled: true,
      subscriptions: [{
        brokerId,
        cameraId: 'cctv-tes-1',
        commandTopic: 'Turjawali/cctv-tes-1',
        statusTopic: 'Turjawali/cctv-tes-1/status'
      }],
      runtime: { active: false, lastPresenceAt: null }
    });

    const adminDashboard = await app.inject({ method: 'GET', url: '/api/routes', headers: { cookie } });
    const dashboardRoute = (adminDashboard.json().items as Array<Record<string, unknown>>)
      .find((item) => item.id === routeId);
    expect(dashboardRoute).toMatchObject({
      inputHost: '127.0.0.1',
      mqttTopics: [{
        brokerName: 'Integration Online',
        commandTopic: 'Turjawali/cctv-tes-1',
        statusTopic: 'Turjawali/cctv-tes-1/status',
        usage: ['BRIDGE']
      }]
    });
    expect(JSON.stringify(dashboardRoute)).not.toContain(brokerPassword);
    expect(JSON.stringify(dashboardRoute)).not.toContain('onvif-integration-secret');

    const operatorDashboard = await app.inject({ method: 'GET', url: '/api/routes', headers: { cookie: operatorCookie } });
    expect(operatorDashboard.statusCode).toBe(200);
    expect((operatorDashboard.json().items as Array<Record<string, unknown>>)
      .find((item) => item.id === routeId)).toMatchObject({
      inputHost: '127.0.0.1',
      mqttTopics: [{ commandTopic: 'Turjawali/cctv-tes-1' }]
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/mqtt-brokers/${brokerId}`,
      headers: { cookie }
    });
    expect(removed.statusCode).toBe(204);
    expect(await prisma.routeMqttBridgeSubscription.count({ where: { routeId } })).toBe(0);
    expect((await prisma.streamRoute.findUniqueOrThrow({ where: { id: routeId } })).mqttBridgeEnabled).toBe(false);
  });

  it('menyimpan settings writable tanpa mencoba mengubah FFMPEG_PATH', async () => {
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie },
      payload: { appName: 'Integration Router', maxWorkers: 3, logRetentionDays: 14, gracefulShutdownTimeoutMs: 5000 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      appName: 'Integration Router', maxWorkers: 3, logRetentionDays: 14, gracefulShutdownTimeoutMs: 5000,
      ffmpegPath: process.env.FFMPEG_PATH
    });
    expect(updated.json().databasePath).toMatch(/integration\.db$/);
  });

  it('membatasi browser storage ke Admin dan memvalidasi canonical directory', async () => {
    const root = path.resolve(here, '../../../../data/integration-recordings');
    await mkdir(path.join(root, 'camera-folder'), { recursive: true });
    const operatorLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { role: 'operator', password: 'integration-operator-password' }
    });
    const operatorCookie = sessionCookieFrom(operatorLogin);
    expect((await app.inject({
      method: 'GET',
      url: `/api/settings/storage/directories?path=${encodeURIComponent(root)}`,
      headers: { cookie: operatorCookie }
    })).statusCode).toBe(403);

    const directories = await app.inject({
      method: 'GET',
      url: `/api/settings/storage/directories?path=${encodeURIComponent(root)}`,
      headers: { cookie }
    });
    expect(directories.statusCode).toBe(200);
    expect(directories.json()).toMatchObject({
      current: root,
      writable: true,
      entries: expect.arrayContaining([expect.objectContaining({ name: 'camera-folder' })])
    });

    const validation = await app.inject({
      method: 'POST',
      url: '/api/settings/storage/validate',
      headers: { cookie },
      payload: { path: root, minFreePercent: 0, minFreeGb: 0 }
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toMatchObject({ ok: true, path: root, writable: true });
  });

  it('menyimpan retention recording per kamera berdasarkan hari, GB, atau keduanya', async () => {
    const sizePolicy = await app.inject({
      method: 'PATCH',
      url: `/api/routes/${routeId}`,
      headers: { cookie },
      payload: {
        recordingRetentionMode: 'SIZE',
        recordingRetentionDays: null,
        recordingRetentionGb: 2.5
      }
    });
    expect(sizePolicy.statusCode).toBe(200);
    expect(sizePolicy.json()).toMatchObject({
      recordingRetentionMode: 'SIZE',
      recordingRetentionDays: null,
      recordingRetentionGb: 2.5
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/routes/${routeId}`,
      headers: { cookie },
      payload: { recordingRetentionMode: 'DAYS', recordingRetentionDays: null }
    });
    expect(invalid.statusCode).toBe(400);

    const combined = await app.inject({
      method: 'PATCH',
      url: `/api/routes/${routeId}`,
      headers: { cookie },
      payload: {
        recordingRetentionMode: 'DAYS_OR_SIZE',
        recordingRetentionDays: 14,
        recordingRetentionGb: 5
      }
    });
    expect(combined.statusCode).toBe(200);
    expect(combined.json()).toMatchObject({
      recordingRetentionMode: 'DAYS_OR_SIZE',
      recordingRetentionDays: 14,
      recordingRetentionGb: 5
    });

    const opus = await app.inject({
      method: 'PATCH',
      url: `/api/routes/${routeId}`,
      headers: { cookie },
      payload: { localAudioMode: 'OPUS' }
    });
    expect(opus.statusCode).toBe(200);
    expect(opus.json()).toMatchObject({ localAudioMode: 'OPUS' });
  });

  it('membagikan satu path Opus untuk WebRTC lokal dan relay online', async () => {
    const configured = await app.inject({
      method: 'PATCH',
      url: `/api/routes/${routeId}`,
      headers: { cookie },
      payload: {
        localViewEnabled: true,
        localAudioMode: 'OPUS',
        onlineRelayEnabled: true,
        onlineAudioMode: 'OPUS'
      }
    });
    expect(configured.statusCode).toBe(200);
    const cameraKey = configured.json().cameraKey as string;

    const started = await app.inject({
      method: 'POST',
      url: `/api/routes/${routeId}/start`,
      headers: { cookie }
    });
    expect(started.statusCode).toBe(200);
    expect(fakeMediaPaths.has(`cameras/${cameraKey}`)).toBe(true);
    expect(fakeMediaPaths.has(`cameras/${cameraKey}/webrtc`)).toBe(true);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/routes/${routeId}`,
      headers: { cookie }
    });
    expect(detail.json()).toMatchObject({
      localViewEnabled: true,
      localAudioMode: 'OPUS',
      onlineAudioMode: 'OPUS',
      media: {
        ready: true,
        opusReady: true,
        localWebrtcUrl: expect.stringContaining(`/cameras/${cameraKey}/webrtc`)
      },
      components: {
        online: {
          audioMode: 'OPUS',
          opusReady: true
        }
      }
    });

    expect((await app.inject({
      method: 'POST',
      url: `/api/routes/${routeId}/stop`,
      headers: { cookie }
    })).statusCode).toBe(200);
  });

  it('hot-toggle Recording menerapkan config tanpa deinitialize route', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/routes',
      headers: { cookie },
      payload: {
        cameraKey: 'hot-recording-camera',
        name: 'Hot Recording Camera',
        inputUrl: 'rtsp://127.0.0.1/hot-recording',
        outputs: [],
        enabled: true,
        autoStart: false,
        localViewEnabled: true,
        onlineRelayEnabled: false,
        recordingEnabled: true,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: {}
      }
    });
    expect(created.statusCode).toBe(201);
    const hotRouteId = created.json().id as string;
    const pathName = 'cameras/hot-recording-camera';
    expect((await app.inject({
      method: 'POST',
      url: `/api/routes/${hotRouteId}/start`,
      headers: { cookie }
    })).statusCode).toBe(200);
    expect(fakeMediaConfigs.get(pathName)?.record).toBe(true);

    const disabled = await app.inject({
      method: 'PUT',
      url: `/api/routes/${hotRouteId}/features`,
      headers: { cookie },
      payload: { recordingEnabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      recordingEnabled: false,
      runtime: { status: 'RUNNING', pid: null }
    });
    expect(fakeMediaConfigs.get(pathName)?.record).toBe(false);

    const enabled = await app.inject({
      method: 'PUT',
      url: `/api/routes/${hotRouteId}/features`,
      headers: { cookie },
      payload: { recordingEnabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      recordingEnabled: true,
      runtime: { status: 'RUNNING', pid: null }
    });
    expect(fakeMediaConfigs.get(pathName)).toMatchObject({
      record: true,
      recordFormat: 'fmp4',
      recordPartDuration: '1s'
    });
    expect((await prisma.auditLog.count({
      where: { action: 'ROUTE_RECORDING_HOT_APPLY', routeId: hotRouteId }
    }))).toBe(2);

    await app.inject({ method: 'POST', url: `/api/routes/${hotRouteId}/stop`, headers: { cookie } });
    await app.inject({ method: 'DELETE', url: `/api/routes/${hotRouteId}`, headers: { cookie } });
  });

  it('mengindeks, memproteksi, memutar, dan menghapus recording dengan permission Admin', async () => {
    const route = await prisma.streamRoute.findUniqueOrThrow({ where: { id: routeId } });
    const root = path.resolve(here, '../../../../data/integration-recordings');
    // MediaMTX menamai segment dengan waktu mulai lokal lalu memanggil hook CREATE sesaat kemudian.
    // Tanggal tetap membuat durasi RECORDING (now - start) terus membesar hingga melewati kolom INT.
    const segmentStart = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
    const pad = (value: number) => String(value).padStart(2, '0');
    const year = String(segmentStart.getFullYear());
    const month = pad(segmentStart.getMonth() + 1);
    const day = pad(segmentStart.getDate());
    const clock = [segmentStart.getHours(), segmentStart.getMinutes(), segmentStart.getSeconds()].map(pad).join('-');
    const relative = path.join(route.cameraKey!, year, month, day, `${year}-${month}-${day}_${clock}-000000.mp4`);
    // Asia/Jakarta selalu UTC+7 tanpa DST.
    const jakartaDate = new Date(segmentStart.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from('integration-recording'));
    const indexed = await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/segments',
      headers: { 'x-mediamtx-hook-token': mediamtxHookToken() },
      payload: { path: `cameras/${route.cameraKey}`, segmentPath: file, event: 'CREATE' }
    });
    expect(indexed.statusCode).toBe(200);
    const recordingId = indexed.json().id as string;
    expect(indexed.json()).toMatchObject({ status: 'RECORDING' });

    const completed = await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/segments',
      headers: { 'x-mediamtx-hook-token': mediamtxHookToken() },
      payload: { path: `cameras/${route.cameraKey}`, segmentPath: file, event: 'COMPLETE', duration: '5s' }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: 'COMPLETE', durationMs: 5000 });

    const listed = await app.inject({ method: 'GET', url: `/api/recordings?routeId=${routeId}&offset=0&limit=5`, headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().total).toBe(1);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: recordingId,
      cameraKey: route.cameraKey,
      durationMs: 5000,
      protected: false
    })]));
    const bulkDownload = await app.inject({
      method: 'GET',
      url: `/api/recordings/bulk-download?ids=${recordingId}`,
      headers: { cookie }
    });
    expect(bulkDownload.statusCode).toBe(200);
    expect(bulkDownload.headers['content-type']).toContain('application/zip');
    expect(bulkDownload.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const calendar = await app.inject({
      method: 'GET',
      url: `/api/recordings/calendar?month=${jakartaDate.slice(0, 7)}&timeZone=Asia%2FJakarta&routeId=${routeId}`,
      headers: { cookie }
    });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toMatchObject({
      timeZone: 'Asia/Jakarta',
      days: expect.arrayContaining([expect.objectContaining({ date: jakartaDate, count: 1 })])
    });
    const timeline = await app.inject({
      method: 'GET',
      url: `/api/recordings/timeline?date=${jakartaDate}&timeZone=Asia%2FJakarta&routeId=${routeId}`,
      headers: { cookie }
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      date: jakartaDate,
      items: [expect.objectContaining({ id: recordingId, cameraKey: route.cameraKey })]
    });
    const playback = await app.inject({
      method: 'GET',
      url: `/api/recordings/playback?id=${recordingId}`,
      headers: { cookie, range: 'bytes=0-10' }
    });
    expect(playback.statusCode).toBe(206);
    expect(playback.headers['content-range']).toBe('bytes 0-10/21');
    expect(playback.headers['accept-ranges']).toBe('bytes');
    expect(playback.headers['cache-control']).toContain('immutable');
    expect(playback.headers.etag).toBeTruthy();
    expect(playback.headers['x-ratelimit-limit']).toBeUndefined();
    expect(playback.body).toBe('integration');
    const playbackSeek = await app.inject({
      method: 'GET',
      url: `/api/recordings/playback?id=${recordingId}`,
      headers: { cookie, range: 'bytes=12-20' }
    });
    expect(playbackSeek.statusCode).toBe(206);
    expect(playbackSeek.headers['content-range']).toBe('bytes 12-20/21');
    expect(playbackSeek.headers.etag).toBe(playback.headers.etag);
    expect(playbackSeek.body).toBe('recording');
    const download = await app.inject({
      method: 'GET',
      url: `/api/recordings/download?id=${recordingId}`,
      headers: { cookie }
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain(route.cameraKey);
    expect(download.headers['x-ratelimit-limit']).toBeUndefined();
    expect((await app.inject({
      method: 'GET',
      url: `/api/recordings/playback?id=${recordingId}`,
      headers: { cookie: viewerCookie }
    })).statusCode).toBe(403);

    expect((await app.inject({
      method: 'PATCH',
      url: `/api/recordings/${recordingId}/protection`,
      headers: { cookie },
      payload: { protected: true }
    })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/recordings/${recordingId}`, headers: { cookie } })).statusCode).toBe(409);
    await app.inject({
      method: 'PATCH',
      url: `/api/recordings/${recordingId}/protection`,
      headers: { cookie },
      payload: { protected: false }
    });
    const removed = await app.inject({
      method: 'POST',
      url: '/api/recordings/bulk-delete',
      headers: { cookie },
      payload: { ids: [recordingId] }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ deletedIds: [recordingId], skipped: [] });
  });

  it('auto-restart berhenti pada circuit breaker dan menghasilkan FAILED', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/routes', headers: { cookie },
      payload: {
        name: 'Crash Route',
        inputUrl: 'rtsp://127.0.0.1/crash',
        outputs: ['rtmp://127.0.0.1/live/out'],
        enabled: true,
        autoStart: false,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: { initialDelayMs: 500, maxDelayMs: 1000, maxRetries: 1, jitterRatio: 0, stableResetMs: 5000 }
      }
    });
    expect(created.statusCode).toBe(201);
    const crashId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/routes/${crashId}/start`, headers: { cookie } });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(workerManager.snapshot(crashId).status).toBe('FAILED');
  });

  it('boot recovery terus mencoba route autoStart sampai source MediaMTX READY', async () => {
    const bootRemoteAddress = '127.0.0.30';
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: bootRemoteAddress,
      payload: { role: 'admin', password: 'integration-password' }
    });
    const bootCookie = sessionCookieFrom(login);
    const created = await app.inject({
      method: 'POST', url: '/api/routes', headers: { cookie: bootCookie }, remoteAddress: bootRemoteAddress,
      payload: {
        name: 'Auto Route',
        inputUrl: 'rtsp://127.0.0.1/live',
        outputs: ['rtmp://127.0.0.1/live/auto'],
        enabled: true,
        autoStart: true,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: { initialDelayMs: 500, maxDelayMs: 1000, maxRetries: 1, jitterRatio: 0, stableResetMs: 5000 }
      }
    });
    const autoId = created.json().id as string;
    fakeMediaReady = false;
    try {
      await workerManager.bootRecovery();
      expect(workerManager.snapshot(autoId)).toMatchObject({ status: 'RESTARTING', restartCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(workerManager.snapshot(autoId)).toMatchObject({ status: 'RESTARTING', restartCount: 2 });
      fakeMediaReady = true;
      await new Promise((resolve) => setTimeout(resolve, 1250));
      expect(workerManager.snapshot(autoId).status).toBe('RUNNING');
      await workerManager.stop(autoId, true);
    } finally {
      fakeMediaReady = true;
    }
  });

  it('event bus mengirim perubahan status untuk SSE transport', async () => {
    const { eventBus } = await import('../../src/modules/events/event-bus.js');
    const event = await new Promise<{ type: string }>((resolve) => {
      eventBus.once('event', resolve);
      eventBus.publish({ type: 'worker.status', routeId: 'test', data: { status: 'RUNNING' } });
    });
    expect(event.type).toBe('worker.status');
  });

  it('Administrator mengganti password role tanpa restart dan sesi lama dicabut', async () => {
    const invalidCurrent = await app.inject({
      method: 'PATCH',
      url: '/api/auth/passwords/operator',
      headers: { cookie },
      payload: {
        currentAdminPassword: 'password-admin-yang-salah',
        newPassword: 'operator-password-baru'
      }
    });
    expect(invalidCurrent.statusCode).toBe(401);

    const operatorChanged = await app.inject({
      method: 'PATCH',
      url: '/api/auth/passwords/operator',
      headers: { cookie },
      payload: {
        currentAdminPassword: 'integration-password',
        newPassword: 'operator-password-baru'
      }
    });
    expect(operatorChanged.statusCode).toBe(200);
    expect(operatorChanged.json()).toEqual({ ok: true, role: 'operator', sessionsRevoked: true });
    expect((await app.inject({
      method: 'GET',
      url: '/api/routes',
      headers: { cookie: operatorCookie }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.21',
      payload: { role: 'operator', password: 'integration-operator-password' }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.22',
      payload: { role: 'operator', password: 'operator-password-baru' }
    })).statusCode).toBe(200);

    const adminChanged = await app.inject({
      method: 'PATCH',
      url: '/api/auth/passwords/admin',
      headers: { cookie },
      payload: {
        currentAdminPassword: 'integration-password',
        newPassword: 'administrator-password-baru'
      }
    });
    expect(adminChanged.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.23',
      payload: { role: 'admin', password: 'integration-password' }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.24',
      payload: { role: 'admin', password: 'administrator-password-baru' }
    })).statusCode).toBe(200);
    const auditLog = await prisma.auditLog.findFirst({
      where: { action: 'AUTH_PASSWORD_UPDATE' },
      orderBy: { createdAt: 'desc' }
    });
    expect(auditLog?.metadataJson).toBe(JSON.stringify({ role: 'admin', sessionsRevoked: true }));
    expect(auditLog?.metadataJson).not.toContain('administrator-password-baru');
  }, 10_000);

});

/** Cookie sesi dari respons login; login Administrator/Operator juga memasang cookie perangkat login. */
function sessionCookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : header === undefined ? [] : [String(header)];
  return values.find((value) => value.startsWith('stream_router_session='))?.split(';')[0] ?? '';
}

async function coreSignedCookie(role: 'admin' | 'operator' | 'viewer'): Promise<string> {
  const credentialVersion = role === 'viewer'
    ? '0'
    : (await prisma.appSetting.findUniqueOrThrow({ where: { key: `auth.${role}.credentialVersion` } })).value;
  // nonce membuat token unik per pemanggilan, sehingga setiap cookie dihitung sebagai sesi terpisah.
  const token = signSession({ username: role, role, credentialVersion, nonce: Math.random() }, process.env.AUTH_SECRET ?? '');
  return `stream_router_session=${token}`;
}

describe('Envelope error API', () => {
  it('validasi Zod menjadi 400 VALIDATION_ERROR dengan envelope error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.60',
      payload: { role: 'bogus' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Data request tidak valid' });
    expect(typeof response.json().error.requestId).toBe('string');
  });

  it('AppError mempertahankan kode dan pesan Indonesia', async () => {
    const adminCookie = await coreSignedCookie('admin');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/routes/11111111-1111-4111-8111-111111111111',
      headers: { cookie: adminCookie }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code: 'ROUTE_NOT_FOUND', message: 'Route tidak ditemukan' });

    const noPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.61',
      payload: { role: 'admin' }
    });
    expect(noPassword.statusCode).toBe(400);
    expect(noPassword.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Password wajib diisi' });
  });

  it('JSON rusak tetap 400 dan rate limit login tetap 429 dengan envelope', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.62',
      headers: { 'content-type': 'application/json' },
      payload: '{"role":'
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');

    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      limited = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '127.0.0.63',
        payload: { role: 'admin', password: 'password-salah' }
      });
      statuses.push(limited.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(limited?.json().error.code).toBe('RATE_LIMITED');
    expect(limited?.json().error.message).toMatch(/^Terlalu banyak permintaan/);
    expect(limited?.headers['retry-after']).toBeDefined();

    // Login Viewer (tanpa password) memakai bucket sendiri, sehingga tetap dapat masuk dari IP yang sama.
    const viewer = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.63', payload: { role: 'viewer' } });
    expect(viewer.statusCode).toBe(200);
  }, 20_000);

  it('data yang tidak ada dan parameter kalender tidak valid bukan error 500', async () => {
    const adminCookie = await coreSignedCookie('admin');
    const protection = await app.inject({
      method: 'PATCH',
      url: '/api/recordings/22222222-2222-4222-8222-222222222222/protection',
      headers: { cookie: adminCookie },
      payload: { protected: true }
    });
    expect(protection.statusCode).toBe(404);
    expect(typeof protection.json().error.code).toBe('string');

    const calendar = await app.inject({
      method: 'GET',
      url: '/api/recordings/calendar?month=2026-13',
      headers: { cookie: adminCookie }
    });
    expect(calendar.statusCode).toBe(400);
    expect(calendar.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('kegagalan autentikasi ONVIF tetap membawa kode error ke UI', async () => {
    const adminCookie = await coreSignedCookie('admin');
    const scanned = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/scan',
      headers: { cookie: adminCookie },
      remoteAddress: '127.0.0.64',
      payload: { timeoutMs: 1000 }
    });
    expect(scanned.statusCode).toBe(200);
    const authFailed = await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie: adminCookie },
      remoteAddress: '127.0.0.64',
      payload: { target: scanned.json().items[0], credentials: { username: 'admin', password: 'wrong' } }
    });
    expect(authFailed.statusCode).toBe(401);
    expect(authFailed.json().error.code).toBe('ONVIF_DISCOVERY_AUTH_FAILED');
  });
});

describe('Settings umum dan health', () => {
  it('PATCH /api/settings menolak perubahan MediaMTX yang melewati endpoint apply', async () => {
    const adminCookie = await coreSignedCookie('admin');
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: adminCookie },
      payload: { mediaMtx: { apiPort: 19998, recordingPath: '/folder/yang/tidak/ada' } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    const apiPort = await prisma.appSetting.findUnique({ where: { key: 'mediamtx.apiPort' } });
    expect(apiPort?.value).toBe(String(testMediaApiPort));
    expect(await prisma.appSetting.findUnique({ where: { key: 'mediamtx.recordingPath' } })).toBeNull();
  });

  it('health tanpa sesi admin/operator hanya mengirim status ringkas', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/health' });
    expect(anonymous.statusCode).toBe(200);
    expect(Object.keys(anonymous.json()).sort()).toEqual(['ok', 'timestamp']);

    const viewer = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: await coreSignedCookie('viewer') } });
    expect(Object.keys(viewer.json()).sort()).toEqual(['ok', 'timestamp']);

    const admin = await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: await coreSignedCookie('admin') } });
    expect(admin.json()).toMatchObject({
      database: { ok: true },
      ffmpeg: { ok: true, version: 'ffmpeg version fake-integration' }
    });
    expect(admin.json().process.memory.rss).toBeGreaterThan(0);

    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    // Tanpa sesi hanya nama pemeriksaan yang gagal (bila ada) yang dikirim, tanpa detail.
    expect(Object.keys(ready.json()).filter((key) => key !== 'failing')).toEqual(['ready']);
    for (const name of ready.json().failing ?? []) expect(name).toMatch(/^[a-zA-Z.]+$/);
  });
});

describe('Stream event SSE', () => {
  interface OpenStream {
    statusCode: number;
    body: () => string;
    ended: Promise<void>;
    close: () => void;
  }

  let baseUrl = '';
  const openStreams: OpenStream[] = [];

  async function openStream(cookieHeader: string): Promise<OpenStream> {
    return new Promise((resolve, reject) => {
      const request = http.get(`${baseUrl}/api/events`, { headers: { cookie: cookieHeader }, agent: false }, (response) => {
        let body = '';
        let markEnded: () => void = () => undefined;
        const ended = new Promise<void>((done) => { markEnded = done; });
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => markEnded());
        response.on('close', () => markEnded());
        const stream: OpenStream = {
          statusCode: response.statusCode ?? 0,
          body: () => body,
          ended,
          close: () => request.destroy()
        };
        openStreams.push(stream);
        if (stream.statusCode !== 200) {
          response.resume();
          resolve(stream);
          return;
        }
        const waitConnected = () => {
          if (body.includes('event: connected')) resolve(stream);
          else response.once('data', waitConnected);
        };
        waitConnected();
      });
      request.on('error', reject);
    });
  }

  beforeAll(async () => {
    if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Server integration tidak memiliki port TCP');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  function closeStreams(): void {
    for (const stream of openStreams.splice(0)) stream.close();
  }

  async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await assertion();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  it('viewer hanya menerima event route monitor tanpa detail error', async () => {
    const { eventBus } = await import('../../src/modules/events/event-bus.js');
    const adminCookie = await coreSignedCookie('admin');
    const created = await app.inject({
      method: 'POST',
      url: '/api/routes',
      headers: { cookie: adminCookie },
      payload: {
        name: 'SSE Viewer Route',
        inputUrl: 'rtsp://127.0.0.1/sse-viewer',
        outputs: ['rtmp://127.0.0.1/live/sse-viewer'],
        enabled: true,
        autoStart: false,
        localViewEnabled: true,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: {}
      }
    });
    expect(created.statusCode).toBe(201);
    const visibleRouteId = created.json().id as string;
    const hiddenRouteId = '33333333-3333-4333-8333-333333333333';
    try {
      const admin = await openStream(adminCookie);
      const viewer = await openStream(await coreSignedCookie('viewer'));
      expect([admin.statusCode, viewer.statusCode]).toEqual([200, 200]);

      eventBus.publish({ type: 'worker.failed', routeId: hiddenRouteId, data: { restartCount: 3, lastError: 'detail-route-tersembunyi' } });
      eventBus.publish({ type: 'worker.status', routeId: visibleRouteId, data: { status: 'RUNNING', pid: 4321, lastError: 'detail-internal' } });

      await waitUntil(() => expect(viewer.body()).toContain(visibleRouteId));
      await waitUntil(() => expect(admin.body()).toContain(visibleRouteId));
      expect(admin.body()).toContain('detail-route-tersembunyi');
      expect(admin.body()).toContain('detail-internal');
      expect(viewer.body()).not.toContain(hiddenRouteId);
      expect(viewer.body()).not.toContain('detail-internal');
      const viewerFrame = viewer.body().split('\n').find((line) => line.startsWith('data: ') && line.includes(visibleRouteId));
      expect(JSON.parse(viewerFrame?.slice(6) ?? '{}')).toMatchObject({ type: 'worker.status', routeId: visibleRouteId, data: { status: 'RUNNING' } });
      expect(JSON.parse(viewerFrame?.slice(6) ?? '{}').data).toEqual({ status: 'RUNNING' });
    } finally {
      closeStreams();
      await app.inject({ method: 'DELETE', url: `/api/routes/${visibleRouteId}`, headers: { cookie: adminCookie } });
    }
  });

  it('membatasi jumlah stream terbuka per sesi', async () => {
    const viewerCookieForLimit = await coreSignedCookie('viewer');
    try {
      const streams: OpenStream[] = [];
      for (let index = 0; index < 8; index += 1) streams.push(await openStream(viewerCookieForLimit));
      expect(streams.map((stream) => stream.statusCode)).toEqual(Array.from({ length: 8 }, () => 200));

      const rejected = await openStream(viewerCookieForLimit);
      expect(rejected.statusCode).toBe(429);
      await rejected.ended;
      expect(JSON.parse(rejected.body()).error.code).toBe('EVENT_STREAM_LIMIT');

      // Sesi lain tidak ikut terblokir, dan slot kembali setelah tab ditutup.
      expect((await openStream(await coreSignedCookie('viewer'))).statusCode).toBe(200);
      streams[0]?.close();
      await waitUntil(async () => {
        const reopened = await openStream(viewerCookieForLimit);
        expect(reopened.statusCode).toBe(200);
      });
    } finally {
      closeStreams();
    }
  });

  it('stream dari sesi yang dicabut diputus saat heartbeat', async () => {
    const { revalidateEventStreams } = await import('../../src/modules/events/event-routes.js');
    const versionKey = 'auth.operator.credentialVersion';
    const original = await prisma.appSetting.findUniqueOrThrow({ where: { key: versionKey } });
    try {
      const operatorStream = await openStream(await coreSignedCookie('operator'));
      const adminStream = await openStream(await coreSignedCookie('admin'));
      expect([operatorStream.statusCode, adminStream.statusCode]).toEqual([200, 200]);
      await prisma.appSetting.update({ where: { key: versionKey }, data: { value: '44444444-4444-4444-8444-444444444444' } });
      await revalidateEventStreams();
      await operatorStream.ended;
      await waitUntil(() => expect(adminStream.body()).toContain(': heartbeat'));
    } finally {
      closeStreams();
      await prisma.appSetting.update({ where: { key: versionKey }, data: { value: original.value } });
    }
  });
});

describe('Lifecycle worker lewat HTTP (regresi audit workers)', () => {
  const remoteAddress = '127.0.0.50';
  let workerCookie = '';

  async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Kondisi tidak tercapai dalam batas waktu');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) {
    return app.inject({ method, url, remoteAddress, headers: { cookie: workerCookie }, ...(payload ? { payload } : {}) });
  }

  beforeAll(async () => {
    const version = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'auth.admin.credentialVersion' } });
    workerCookie = `stream_router_session=${signSession({ username: 'admin', role: 'admin', credentialVersion: version.value }, process.env.AUTH_SECRET ?? '')}`;
  });

  it('deinisiasi route media-only mengembalikan status STOPPED dan route bisa diinisiasi lagi', async () => {
    const created = await call('POST', '/api/routes', {
      cameraKey: 'media-only-lifecycle',
      name: 'Media Only Lifecycle',
      inputUrl: 'rtsp://127.0.0.1/media-only-lifecycle',
      outputs: [],
      enabled: true,
      autoStart: false,
      localViewEnabled: true,
      onlineRelayEnabled: false,
      recordingEnabled: false,
      ffmpegMode: 'COPY',
      ffmpegOptions: {},
      retryPolicy: {}
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await call('POST', `/api/routes/${id}/initialize`)).json().status).toBe('RUNNING');

    const deinitialized = await call('POST', `/api/routes/${id}/deinitialize`);
    expect(deinitialized.json().status).toBe('STOPPED');
    expect((await call('GET', `/api/routes/${id}`)).json()).toMatchObject({ enabled: false, runtime: { status: 'STOPPED' } });
    expect(fakeMediaPaths.has('cameras/media-only-lifecycle')).toBe(false);

    expect((await call('POST', `/api/routes/${id}/initialize`)).json().status).toBe('RUNNING');
    expect(fakeMediaPaths.has('cameras/media-only-lifecycle')).toBe(true);
    expect((await call('DELETE', `/api/routes/${id}`)).statusCode).toBe(204);
  });

  it('Start pada relay FAILED dan RESTARTING menjalankan FFmpeg baru, bukan RUNNING tanpa proses', async () => {
    const create = async (cameraKey: string, retryPolicy: Record<string, number>) => (await call('POST', '/api/routes', {
      cameraKey,
      name: cameraKey,
      inputUrl: `rtsp://127.0.0.1/${cameraKey}`,
      outputs: [`rtmp://127.0.0.1/live/${cameraKey}`],
      enabled: true,
      autoStart: false,
      ffmpegMode: 'COPY',
      ffmpegOptions: {},
      retryPolicy
    })).json().id as string;

    const failedId = await create('crash-start-failed', { initialDelayMs: 500, maxDelayMs: 1000, maxRetries: 0, jitterRatio: 0, stableResetMs: 5000 });
    await call('POST', `/api/routes/${failedId}/start`);
    await waitUntil(() => workerManager.snapshot(failedId).status === 'FAILED');
    const failedRestart = await call('POST', `/api/routes/${failedId}/start`);
    expect(failedRestart.json().pid).not.toBeNull();
    expect(await prisma.routeRun.count({ where: { routeId: failedId } })).toBe(2);

    const backoffId = await create('crash-start-backoff', { initialDelayMs: 10_000, maxDelayMs: 10_000, maxRetries: 3, jitterRatio: 0, stableResetMs: 5000 });
    await call('POST', `/api/routes/${backoffId}/start`);
    await waitUntil(() => {
      const snapshot = workerManager.snapshot(backoffId);
      return snapshot.status === 'RESTARTING' && snapshot.pid === null;
    });
    const backoffRestart = await call('POST', `/api/routes/${backoffId}/start`);
    expect(backoffRestart.json().pid).not.toBeNull();
    expect(await prisma.routeRun.count({ where: { routeId: backoffId } })).toBe(2);

    for (const id of [failedId, backoffId]) expect((await call('DELETE', `/api/routes/${id}`)).statusCode).toBe(204);
  });
});

describe('Integrasi PTZ dan broker MQTT', () => {
  let adminCookie = '';

  beforeAll(async () => {
    const { getCredentialVersion } = await import('../../src/modules/auth/auth-service.js');
    const credentialVersion = await getCredentialVersion('admin');
    adminCookie = `stream_router_session=${signSession(
      { username: 'admin', role: 'admin', credentialVersion },
      process.env.AUTH_SECRET ?? ''
    )}`;
  });

  async function createBroker(name: string, rootTopic: string, password?: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mqtt-brokers',
      headers: { cookie: adminCookie },
      payload: {
        name,
        description: '',
        protocol: 'mqtt',
        host: '127.0.0.1',
        port: 1,
        rootTopic,
        username: 'bridge',
        ...(password ? { password } : {})
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function createRoute(name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/routes',
      headers: { cookie: adminCookie },
      payload: {
        name,
        inputUrl: `rtsp://127.0.0.1/${name.toLowerCase().replaceAll(' ', '-')}`,
        outputs: [],
        enabled: true,
        autoStart: false,
        onlineRelayEnabled: false,
        ffmpegMode: 'COPY',
        ffmpegOptions: {},
        retryPolicy: {}
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  it('menghapus broker tidak menghapus PTZ ONVIF route yang hanya mem-bridge ke broker tersebut', async () => {
    const gateId = await createRoute('Gerbang Bridge Audit');
    expect((await app.inject({
      method: 'PUT',
      url: `/api/routes/${gateId}/ptz`,
      headers: { cookie: adminCookie },
      payload: {
        provider: 'ONVIF',
        enabled: true,
        zoomEnabled: true,
        host: '10.0.0.20',
        port: 80,
        username: 'onvif-admin',
        password: 'onvif-gerbang-secret',
        useTls: false,
        path: '/onvif/device_service',
        profileToken: '100'
      }
    })).statusCode).toBe(200);
    const oldBroker = await createBroker('Broker Lama Audit', 'AuditLama', 'broker-lama-secret');
    const mainBroker = await createBroker('Broker Utama Audit', 'AuditUtama', 'broker-utama-secret');
    expect((await app.inject({
      method: 'PUT',
      url: `/api/routes/${gateId}/ptz/mqtt-bridge`,
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        subscriptions: [{ brokerId: oldBroker, cameraId: 'gerbang' }, { brokerId: mainBroker, cameraId: 'gerbang' }]
      }
    })).statusCode).toBe(200);

    const mqttRouteId = await createRoute('PTZ MQTT Audit');
    expect((await app.inject({
      method: 'PUT',
      url: `/api/routes/${mqttRouteId}/ptz`,
      headers: { cookie: adminCookie },
      payload: { provider: 'MQTT', enabled: true, zoomEnabled: false, brokerId: oldBroker, cameraId: 'ptz-mqtt-audit' }
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: 'DELETE',
      url: `/api/mqtt-brokers/${oldBroker}`,
      headers: { cookie: adminCookie }
    })).statusCode).toBe(204);

    const gatePtz = await app.inject({ method: 'GET', url: `/api/routes/${gateId}/ptz`, headers: { cookie: adminCookie } });
    expect(gatePtz.json()).toMatchObject({
      provider: 'ONVIF',
      enabled: true,
      host: '10.0.0.20',
      username: 'onvif-admin',
      profileToken: '100',
      passwordConfigured: true
    });
    const bridge = await app.inject({ method: 'GET', url: `/api/routes/${gateId}/ptz/mqtt-bridge`, headers: { cookie: adminCookie } });
    expect(bridge.json()).toMatchObject({
      enabled: true,
      subscriptions: [expect.objectContaining({ brokerId: mainBroker, commandTopic: 'AuditUtama/gerbang' })]
    });
    expect(bridge.json().subscriptions).toHaveLength(1);
    const mqttPtz = await app.inject({ method: 'GET', url: `/api/routes/${mqttRouteId}/ptz`, headers: { cookie: adminCookie } });
    expect(mqttPtz.json()).toMatchObject({ provider: 'NONE', enabled: false });

    expect((await app.inject({
      method: 'DELETE',
      url: `/api/mqtt-brokers/${mainBroker}`,
      headers: { cookie: adminCookie }
    })).statusCode).toBe(204);
    expect(await prisma.streamRoute.findUniqueOrThrow({ where: { id: gateId } })).toMatchObject({
      mqttBridgeEnabled: false,
      ptzEnabled: true,
      ptzProvider: 'ONVIF'
    });
  });

  it('mewajibkan password broker diketik ulang ketika protocol, host, atau port berubah', async () => {
    const brokerId = await createBroker('Broker Endpoint Audit', 'AuditEndpoint', 'broker-endpoint-secret');
    for (const payload of [{ host: 'attacker.example' }, { port: 1884 }, { protocol: 'ws' }]) {
      const moved = await app.inject({
        method: 'PATCH',
        url: `/api/mqtt-brokers/${brokerId}`,
        headers: { cookie: adminCookie },
        payload
      });
      expect(moved.statusCode).toBe(400);
      expect(moved.body).toContain('MQTT_BROKER_PASSWORD_REQUIRED');
    }
    expect(await prisma.mqttBroker.findUniqueOrThrow({ where: { id: brokerId } })).toMatchObject({
      host: '127.0.0.1',
      port: 1,
      protocol: 'mqtt'
    });

    expect((await app.inject({
      method: 'PATCH',
      url: `/api/mqtt-brokers/${brokerId}`,
      headers: { cookie: adminCookie },
      payload: { name: 'Broker Endpoint Audit Baru', host: '127.0.0.1', port: 1 }
    })).statusCode).toBe(200);
    const retyped = await app.inject({
      method: 'PATCH',
      url: `/api/mqtt-brokers/${brokerId}`,
      headers: { cookie: adminCookie },
      payload: { host: 'broker-baru.example', password: 'broker-endpoint-secret-baru' }
    });
    expect(retyped.statusCode).toBe(200);
    expect(retyped.json()).toMatchObject({ host: 'broker-baru.example', passwordConfigured: true });

    const openBroker = await createBroker('Broker Tanpa Password Audit', 'AuditTanpaPassword');
    expect((await app.inject({
      method: 'PATCH',
      url: `/api/mqtt-brokers/${openBroker}`,
      headers: { cookie: adminCookie },
      payload: { host: 'broker-lain.example' }
    })).statusCode).toBe(200);
  });

  it('katalog kamera MQTT memakai URL Viewer dan tidak membocorkan path file server', async () => {
    const brokerId = await createBroker('Broker Katalog Audit', 'AuditKatalog');
    const fileStream = await app.inject({
      method: 'POST',
      url: '/api/webrtc-streams',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Rekaman Katalog Audit',
        description: '',
        url: streamFileFixturePath,
        mode: 'MP4',
        sourceType: 'FILE',
        enabled: true
      }
    });
    expect(fileStream.statusCode).toBe(201);
    const youtube = await app.inject({
      method: 'POST',
      url: '/api/webrtc-streams',
      headers: { cookie: adminCookie },
      payload: { name: 'YouTube Katalog Audit', description: '', url: 'https://youtu.be/dQw4w9WgXcQ', mode: 'YOUTUBE', enabled: true }
    });
    expect(youtube.statusCode).toBe(201);
    const fileStreamId = fileStream.json().id as string;
    const youtubeId = youtube.json().id as string;
    for (const [streamId, cameraId] of [[fileStreamId, 'rekaman-audit'], [youtubeId, 'youtube-audit']] as const) {
      expect((await app.inject({
        method: 'PUT',
        url: `/api/webrtc-streams/${streamId}/ptz`,
        headers: { cookie: adminCookie },
        payload: { provider: 'MQTT', enabled: true, zoomEnabled: false, brokerId, cameraId }
      })).statusCode).toBe(200);
    }

    const { publishCameraCatalog } = await import('../../src/modules/mqtt-bridge/camera-status-publisher.js');
    const { getMqttBrokerRuntimeConfig } = await import('../../src/modules/mqtt-bridge/mqtt-broker-service.js');
    const published: Array<{ topic: string; payload: string }> = [];
    const client = {
      connected: true,
      publishAsync: async (topic: string, payload: string) => {
        published.push({ topic, payload });
      }
    } as unknown as Parameters<typeof publishCameraCatalog>[0];
    await publishCameraCatalog(client, await getMqttBrokerRuntimeConfig(brokerId));

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('AuditKatalog/camera-status');
    const catalog = JSON.parse(published[0]!.payload) as { cameras: Array<{ id: string; webrtcUrl: string | null }> };
    expect(catalog.cameras.find((camera) => camera.id === fileStreamId)?.webrtcUrl)
      .toBe(`/api/viewer/stream-files/${fileStreamId}`);
    expect(catalog.cameras.find((camera) => camera.id === youtubeId)?.webrtcUrl).toContain('/embed/dQw4w9WgXcQ');
    expect(published[0]!.payload).not.toContain('file:');
    expect(published[0]!.payload).not.toContain(streamFileFixtureDirectory);
  });
});

describe('Stream Route: reconcile edit, validasi URL, dan Camera ID', () => {
  let adminCookie = '';
  const createdRouteIds: string[] = [];
  const fastRetry = { initialDelayMs: 500, maxDelayMs: 1000, maxRetries: 3, jitterRatio: 0, stableResetMs: 5000 };
  const mediaOnly = { outputs: [], onlineRelayEnabled: false, enabled: true, autoStart: false, retryPolicy: fastRetry };

  const request = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) => (
    app.inject({ method, url, headers: { cookie: adminCookie }, ...(payload ? { payload } : {}) })
  );

  async function createTestRoute(payload: Record<string, unknown>): Promise<{ id: string; cameraKey: string }> {
    const response = await request('POST', '/api/routes', payload);
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; cameraKey: string };
    createdRouteIds.push(body.id);
    return body;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Kondisi tidak tercapai sebelum timeout');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const auditCount = (routeId: string, action: string) => prisma.auditLog.count({ where: { routeId, action } });

  // Envelope aplikasi `{ error: { code } }`, dengan fallback ke format default Fastify `{ code }`.
  function errorBody(response: { json: () => unknown }): { code?: string; message?: string } {
    const body = response.json() as { error?: unknown; code?: string; message?: string };
    return typeof body.error === 'object' && body.error !== null ? body.error as { code?: string; message?: string } : body;
  }

  beforeAll(async () => {
    // Test sebelumnya mengganti password admin; sesi ditandatangani langsung dengan credentialVersion aktif.
    const version = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'auth.admin.credentialVersion' } });
    adminCookie = `stream_router_session=${signSession({ username: 'admin', role: 'admin', credentialVersion: version.value }, process.env.AUTH_SECRET ?? '')}`;
  });

  afterAll(async () => {
    fakeMediaReady = true;
    for (const id of createdRouteIds) {
      await workerManager.stop(id, true).catch(() => undefined);
      await prisma.streamRoute.deleteMany({ where: { id } });
    }
  });

  it('edit metadata route aktif tidak me-restart pipeline dan recording di-hot-apply', async () => {
    const route = await createTestRoute({
      ...mediaOnly,
      name: 'Reconcile Metadata',
      inputUrl: 'rtsp://127.0.0.1/reconcile-meta',
      localViewEnabled: true
    });
    expect((await request('POST', `/api/routes/${route.id}/start`)).statusCode).toBe(200);
    expect(workerManager.snapshot(route.id).status).toBe('RUNNING');

    // Editor selalu mengirim seluruh field, termasuk yang tidak berubah.
    const edited = await request('PATCH', `/api/routes/${route.id}`, {
      name: 'Reconcile Metadata Baru',
      description: 'hanya teks',
      enabled: true,
      autoStart: true,
      localViewEnabled: true,
      localAudioMode: 'COPY',
      onlineRelayEnabled: false,
      recordingEnabled: false,
      recordingRetentionMode: 'DAYS',
      recordingRetentionDays: 3,
      recordingRetentionGb: null,
      ffmpegMode: 'COPY',
      onlineAudioMode: 'COPY',
      ffmpegOptions: { videoBitrateKbps: 2500, audioBitrateKbps: 128, preset: 'veryfast', gop: 50 },
      retryPolicy: { ...fastRetry, maxRetries: 5 },
      webrtc: { enabled: true, mode: 'IFRAME', url: 'https://media.example.test/embed/reconcile' },
      inputUrl: 'rtsp://127.0.0.1/reconcile-meta',
      outputs: []
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: 'Reconcile Metadata Baru', autoStart: true, runtime: { status: 'RUNNING' } });
    expect(await auditCount(route.id, 'ROUTE_RESTART')).toBe(0);

    const recording = await request('PATCH', `/api/routes/${route.id}`, { recordingEnabled: true });
    expect(recording.statusCode).toBe(200);
    expect(fakeMediaConfigs.get(`cameras/${route.cameraKey}`)?.record).toBe(true);
    expect(await auditCount(route.id, 'ROUTE_RECORDING_HOT_APPLY')).toBe(1);
    expect(await auditCount(route.id, 'ROUTE_RESTART')).toBe(0);

    const opus = await request('PATCH', `/api/routes/${route.id}`, { localAudioMode: 'OPUS' });
    expect(opus.statusCode).toBe(200);
    expect(await auditCount(route.id, 'ROUTE_RESTART')).toBe(1);
    expect(fakeMediaPaths.has(`cameras/${route.cameraKey}/webrtc`)).toBe(true);
    await workerManager.stop(route.id, true);
  });

  it('edit route aktif yang source-nya belum READY disimpan tanpa rollback dan dipakai retry', async () => {
    const route = await createTestRoute({
      ...mediaOnly,
      name: 'Reconcile Offline',
      cameraKey: 'reconcile-offline',
      inputUrl: 'rtsp://127.0.0.1/offline-lama'
    });
    fakeMediaReady = false;
    try {
      await workerManager.start(route.id).catch(() => undefined);
      expect(workerManager.isActive(route.id)).toBe(true);
      expect(workerManager.snapshot(route.id).status).toBe('RESTARTING');

      const renamed = await request('PATCH', `/api/routes/${route.id}`, { name: 'Reconcile Offline Baru', autoStart: true });
      expect(renamed.statusCode).toBe(200);
      expect((await prisma.streamRoute.findUniqueOrThrow({ where: { id: route.id } })).name).toBe('Reconcile Offline Baru');
      expect(await auditCount(route.id, 'ROUTE_RESTART')).toBe(0);

      const moved = await request('PATCH', `/api/routes/${route.id}`, { inputUrl: 'rtsp://127.0.0.1/offline-baru' });
      expect(moved.statusCode).toBe(200);
      expect((await request('GET', `/api/routes/${route.id}/edit`)).json().inputUrl).toBe('rtsp://127.0.0.1/offline-baru');
      await waitFor(() => fakeMediaConfigs.get('cameras/reconcile-offline')?.source === 'rtsp://127.0.0.1/offline-baru');

      fakeMediaReady = true;
      await waitFor(() => workerManager.snapshot(route.id).status === 'RUNNING');
    } finally {
      fakeMediaReady = true;
    }
    await workerManager.stop(route.id, true);
  });

  it('rollback edit yang gagal diterapkan memulihkan seluruh kolom persis', async () => {
    const blocker = await createTestRoute({
      name: 'Reconcile Worker Lain',
      inputUrl: 'rtsp://127.0.0.1/reconcile-blocker',
      outputs: ['rtmp://127.0.0.1/live/reconcile-blocker'],
      onlineRelayEnabled: true,
      retryPolicy: fastRetry
    });
    const target = await createTestRoute({ ...mediaOnly, name: 'Reconcile Rollback', inputUrl: 'rtsp://127.0.0.1/reconcile-rollback' });
    const previousLimit = await prisma.appSetting.findUnique({ where: { key: 'app.maxWorkers' } });
    try {
      expect((await request('POST', `/api/routes/${blocker.id}/start`)).statusCode).toBe(200);
      expect((await request('POST', `/api/routes/${target.id}/start`)).statusCode).toBe(200);
      // Batas worker = jumlah FFmpeg yang sedang hidup, sehingga relay baru untuk target pasti ditolak MAX_WORKERS.
      const liveWorkers = String(workerManager.allSnapshots().filter((snapshot) => snapshot.pid !== null).length);
      await prisma.appSetting.upsert({
        where: { key: 'app.maxWorkers' },
        create: { key: 'app.maxWorkers', value: liveWorkers, isSecret: false },
        update: { value: liveWorkers }
      });
      const before = await prisma.streamRoute.findUniqueOrThrow({ where: { id: target.id } });

      const failed = await request('PATCH', `/api/routes/${target.id}`, {
        name: 'Tidak Tersimpan',
        onlineRelayEnabled: true,
        outputs: ['rtmp://127.0.0.1/live/reconcile-rollback'],
        ffmpegOptions: { fps: 15 },
        webrtc: { enabled: true, url: 'https://media.example.test/whep/rollback?token=abc' }
      });
      expect(failed.statusCode).toBe(409);
      expect(errorBody(failed).code).toBe('ROUTE_RECONCILE_FAILED');
      expect(errorBody(failed).message).toContain('Batas worker aktif tercapai');

      const after = await prisma.streamRoute.findUniqueOrThrow({ where: { id: target.id } });
      expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
      expect(after.webrtcUrlEncrypted).toBeNull();
      expect(JSON.parse(after.ffmpegOptions)).not.toHaveProperty('fps');
      expect(workerManager.snapshot(target.id).status).toBe('RUNNING');
    } finally {
      if (previousLimit) {
        await prisma.appSetting.update({ where: { key: 'app.maxWorkers' }, data: { value: previousLimit.value } });
      } else {
        await prisma.appSetting.deleteMany({ where: { key: 'app.maxWorkers' } });
      }
      await workerManager.stop(target.id, true);
      await workerManager.stop(blocker.id, true);
    }
  });

  it('menolak URL stream tidak valid dengan 400 tanpa membocorkan password kamera', async () => {
    const unencoded = await request('POST', '/api/routes', {
      ...mediaOnly,
      name: 'URL Tidak Valid',
      inputUrl: 'rtsp://admin:Pa#ss-RAHASIA@192.168.1.10:554/stream1'
    });
    expect(unencoded.statusCode).toBe(400);
    expect(errorBody(unencoded).code).toBe('INVALID_STREAM_URL');
    expect(unencoded.body).not.toContain('RAHASIA');

    const httpInput = await request('POST', '/api/routes', { ...mediaOnly, name: 'Input HTTP', inputUrl: 'http://192.168.1.10/live' });
    expect(httpInput.statusCode).toBe(400);
    expect(errorBody(httpInput).code).toBe('UNSUPPORTED_STREAM_PROTOCOL');

    const srtOutput = await request('POST', '/api/routes', {
      name: 'Output SRT',
      inputUrl: 'rtsp://192.168.1.10/live',
      outputs: ['srt://example.test:9000?streamid=abc']
    });
    expect(srtOutput.statusCode).toBe(400);
    expect(errorBody(srtOutput).code).toBe('UNSUPPORTED_STREAM_PROTOCOL');
  });

  it('Camera ID otomatis tidak memakai ulang key milik arsip recording route yang sudah dihapus', async () => {
    const orphan = await prisma.recordingSegment.create({
      data: {
        routeId: null,
        cameraKey: 'arsip-lama',
        cameraName: 'Arsip Lama',
        storageRoot: 'integration-orphan-root',
        relativePath: 'cameras/arsip-lama/2026/01/01/2026-01-01_00-00-00-000000.mp4',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-01T00:01:00Z'),
        durationMs: 60_000,
        sizeBytes: 1024
      }
    });
    try {
      const generated = await createTestRoute({ ...mediaOnly, name: 'Arsip Lama', inputUrl: 'rtsp://127.0.0.1/arsip' });
      expect(generated.cameraKey).toBe('arsip-lama-2');
      const explicit = await createTestRoute({ ...mediaOnly, name: 'Arsip Lama Sama', cameraKey: 'arsip-lama', inputUrl: 'rtsp://127.0.0.1/arsip' });
      expect(explicit.cameraKey).toBe('arsip-lama');
    } finally {
      await prisma.recordingSegment.delete({ where: { id: orphan.id } });
    }
  });

  it('create paralel dengan nama atau Camera ID sama tidak menghasilkan 500', async () => {
    const generated = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/api/routes', {
      ...mediaOnly,
      name: 'Kamera Kembar',
      inputUrl: 'rtsp://127.0.0.1/kembar'
    })));
    for (const response of generated) {
      if (response.statusCode === 201) createdRouteIds.push(response.json().id as string);
    }
    expect(generated.map((response) => response.statusCode)).toEqual([201, 201, 201, 201]);
    expect(new Set(generated.map((response) => response.json().cameraKey)).size).toBe(4);

    const explicit = await Promise.all(Array.from({ length: 2 }, () => request('POST', '/api/routes', {
      ...mediaOnly,
      name: 'Kembar Eksplisit',
      cameraKey: 'kembar-eksplisit',
      inputUrl: 'rtsp://127.0.0.1/kembar'
    })));
    for (const response of explicit) {
      if (response.statusCode === 201) createdRouteIds.push(response.json().id as string);
    }
    expect(explicit.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const conflict = explicit.find((response) => response.statusCode === 409);
    expect(conflict && errorBody(conflict).code).toBe('CAMERA_KEY_CONFLICT');
  });

  it('link WebRTC route dapat dihapus dan audit hapus route menyimpan identitasnya', async () => {
    const route = await createTestRoute({
      ...mediaOnly,
      name: 'WebRTC Hapus',
      inputUrl: 'rtsp://127.0.0.1/webrtc-hapus',
      webrtc: { enabled: true, url: 'https://media.example.test/embed/hapus' }
    });
    const kept = await request('PATCH', `/api/routes/${route.id}`, { webrtc: { enabled: false } });
    expect(kept.statusCode).toBe(200);
    expect((await request('GET', `/api/routes/${route.id}/edit`)).json().webrtc.url).toBe('https://media.example.test/embed/hapus');

    const cleared = await request('PATCH', `/api/routes/${route.id}`, { webrtc: { enabled: false, url: null } });
    expect(cleared.statusCode).toBe(200);
    expect((await request('GET', `/api/routes/${route.id}/edit`)).json().webrtc.url).toBeUndefined();
    expect((await prisma.streamRoute.findUniqueOrThrow({ where: { id: route.id } })).webrtcUrlEncrypted).toBeNull();

    expect((await request('DELETE', `/api/routes/${route.id}`)).statusCode).toBe(204);
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'ROUTE_DELETE', metadataJson: { contains: route.id } },
      orderBy: { createdAt: 'desc' }
    });
    expect(JSON.parse(entry?.metadataJson ?? '{}')).toEqual({ routeId: route.id, name: 'WebRTC Hapus', cameraKey: route.cameraKey });
  });
});

describe('Stream View: Viewer tahan terhadap URL lama dan HEAD stream file', () => {
  const encryptionKey = process.env.APP_ENCRYPTION_KEY ?? '';

  async function viewerSession(remoteAddress: string): Promise<string> {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { role: 'viewer' } });
    expect(login.statusCode).toBe(200);
    return sessionCookieFrom(login);
  }

  it('melewati Stream View tersimpan yang tidak lolos kebijakan URL tanpa menggagalkan Viewer', async () => {
    const { encryptString } = await import('../../src/shared/crypto.js');
    const viewer = await viewerSession('127.0.0.61');
    // Disimpan sebelum validasi embed live_stream diperketat; kini wajib membawa `channel`.
    const stale = await prisma.webrtcStream.create({
      data: {
        name: 'Legacy Live Channel',
        urlEncrypted: encryptString('https://www.youtube.com/embed/live_stream', encryptionKey),
        mode: 'YOUTUBE',
        enabled: true
      }
    });
    const valid = await prisma.webrtcStream.create({
      data: {
        name: 'Valid HLS',
        urlEncrypted: encryptString('https://media.example.com/live/valid.m3u8', encryptionKey),
        mode: 'HLS',
        enabled: true
      }
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewer } });
      expect(response.statusCode).toBe(200);
      const ids = (response.json().items as Array<{ id: string }>).map((item) => item.id);
      expect(ids).toContain(valid.id);
      expect(ids).not.toContain(stale.id);
    } finally {
      await prisma.webrtcStream.deleteMany({ where: { id: { in: [stale.id, valid.id] } } });
    }
  });

  it('HEAD stream file MP4 mengembalikan header yang sama dengan GET tanpa body', async () => {
    const { encryptString } = await import('../../src/shared/crypto.js');
    const { pathToFileURL } = await import('node:url');
    const viewer = await viewerSession('127.0.0.62');
    const row = await prisma.webrtcStream.create({
      data: {
        name: 'MP4 HEAD',
        urlEncrypted: encryptString(pathToFileURL(streamFileFixturePath).toString(), encryptionKey),
        mode: 'MP4',
        enabled: true
      }
    });
    try {
      const url = `/api/viewer/stream-files/${row.id}`;
      const full = await app.inject({ method: 'HEAD', url, headers: { cookie: viewer } });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-length']).toBe(String(streamFileFixture.length));
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.rawPayload).toHaveLength(0);

      const ranged = await app.inject({ method: 'HEAD', url, headers: { cookie: viewer, range: 'bytes=1-3' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-length']).toBe('3');
      expect(ranged.headers['content-range']).toBe(`bytes 1-3/${streamFileFixture.length}`);
      expect(ranged.rawPayload).toHaveLength(0);

      expect((await app.inject({ method: 'HEAD', url })).statusCode).toBe(401);
      const body = await app.inject({ method: 'GET', url, headers: { cookie: viewer } });
      expect(body.statusCode).toBe(200);
      expect(body.rawPayload).toEqual(streamFileFixture);
    } finally {
      await prisma.webrtcStream.delete({ where: { id: row.id } });
    }
  });
});

describe('Stream Route: aturan reconcile/rollback edit dan Recording saat source belum READY', () => {
  let adminCookie = '';
  const createdRouteIds: string[] = [];
  const fastRetry = { initialDelayMs: 500, maxDelayMs: 1000, maxRetries: 3, jitterRatio: 0, stableResetMs: 5000 };
  const mediaOnly = { outputs: [], onlineRelayEnabled: false, enabled: true, autoStart: false, retryPolicy: fastRetry };
  // Kesiapan per path (bukan fakeMediaReady global) agar monitor tidak ikut menjatuhkan route lain di test ini.
  const notReadyPaths = new Set<string>();
  const [originalMediaHandler] = fakeMediaServer.listeners('request') as Array<(request: http.IncomingMessage, response: http.ServerResponse) => void>;

  const request = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) => (
    app.inject({ method, url, headers: { cookie: adminCookie }, ...(payload ? { payload } : {}) })
  );
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function createTestRoute(payload: Record<string, unknown>): Promise<{ id: string; cameraKey: string }> {
    const response = await request('POST', '/api/routes', payload);
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; cameraKey: string };
    createdRouteIds.push(body.id);
    return body;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Kondisi tidak tercapai sebelum timeout');
      await sleep(25);
    }
  }

  function errorBody(response: { json: () => unknown }): { code?: string; message?: string; details?: { cause?: string | null } } {
    return (response.json() as { error: { code?: string; message?: string; details?: { cause?: string | null } } }).error;
  }

  const storedInputUrl = async (id: string) => (await request('GET', `/api/routes/${id}/edit`)).json().inputUrl as string;

  beforeAll(async () => {
    const version = await prisma.appSetting.findUniqueOrThrow({ where: { key: 'auth.admin.credentialVersion' } });
    adminCookie = `stream_router_session=${signSession({ username: 'admin', role: 'admin', credentialVersion: version.value }, process.env.AUTH_SECRET ?? '')}`;
    fakeMediaServer.removeListener('request', originalMediaHandler!);
    fakeMediaServer.on('request', (incoming, response) => {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const prefix = '/v3/paths/get/';
      if (url.pathname.startsWith(prefix) && notReadyPaths.has(decodeURIComponent(url.pathname.slice(prefix.length)))) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ready: false, tracks: [], bytesReceived: 0 }));
        return;
      }
      originalMediaHandler!(incoming, response);
    });
  });

  afterAll(async () => {
    notReadyPaths.clear();
    fakeMediaServer.removeAllListeners('request');
    fakeMediaServer.on('request', originalMediaHandler!);
    for (const id of createdRouteIds) {
      await workerManager.stop(id, true).catch(() => undefined);
      await prisma.streamRoute.deleteMany({ where: { id } });
    }
  });

  it('Recording yang diubah saat source belum READY langsung diterapkan ke path MediaMTX (ON dan OFF)', async () => {
    const route = await createTestRoute({ ...mediaOnly, name: 'Rekam Offline', cameraKey: 'rekam-offline', inputUrl: 'rtsp://127.0.0.1/rekam-offline' });
    const pathName = 'cameras/rekam-offline';
    notReadyPaths.add(pathName);
    try {
      await workerManager.start(route.id).catch(() => undefined);
      expect(workerManager.snapshot(route.id).status).toBe('RESTARTING');
      expect(fakeMediaConfigs.get(pathName)?.record).toBe(false);

      const on = await request('PUT', `/api/routes/${route.id}/features`, { recordingEnabled: true });
      expect(on.statusCode).toBe(200);
      expect(fakeMediaConfigs.get(pathName)?.record).toBe(true);

      const off = await request('PUT', `/api/routes/${route.id}/features`, { recordingEnabled: false });
      expect(off.statusCode).toBe(200);
      expect(fakeMediaConfigs.get(pathName)?.record).toBe(false);

      const edited = await request('PATCH', `/api/routes/${route.id}`, { recordingEnabled: true });
      expect(edited.statusCode).toBe(200);
      expect(fakeMediaConfigs.get(pathName)?.record).toBe(true);

      notReadyPaths.delete(pathName);
      await waitFor(() => workerManager.snapshot(route.id).status === 'RUNNING');
      expect(fakeMediaConfigs.get(pathName)?.record).toBe(true);
      expect((await request('GET', `/api/routes/${route.id}`)).json().components.recording).toMatchObject({ enabled: true, active: true });
    } finally {
      notReadyPaths.delete(pathName);
      await workerManager.stop(route.id, true);
    }
  });

  it('Stop saat restart edit tidak di-rollback: route tetap STOPPED dan edit tersimpan', async () => {
    const route = await createTestRoute({ ...mediaOnly, name: 'Edit Lalu Stop', cameraKey: 'edit-lalu-stop', inputUrl: 'rtsp://127.0.0.1/edit-lalu-stop-lama' });
    const pathName = 'cameras/edit-lalu-stop';
    expect((await request('POST', `/api/routes/${route.id}/start`)).json().status).toBe('RUNNING');
    // Source baru valid tetapi lambat READY: Stop datang selama restart menunggu.
    notReadyPaths.add(pathName);
    try {
      const patching = request('PATCH', `/api/routes/${route.id}`, { inputUrl: 'rtsp://127.0.0.1/edit-lalu-stop-baru' });
      await waitFor(() => fakeMediaConfigs.get(pathName)?.source === 'rtsp://127.0.0.1/edit-lalu-stop-baru');
      const stopped = await request('POST', `/api/routes/${route.id}/stop`);
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().status).toBe('STOPPED');
      const patched = await patching;
      expect(patched.statusCode).toBe(200);
      notReadyPaths.delete(pathName);
      await sleep(800);
      expect(workerManager.isActive(route.id)).toBe(false);
      expect(workerManager.snapshot(route.id).status).toBe('STOPPED');
      expect(fakeMediaPaths.has(pathName)).toBe(false);
      expect(await storedInputUrl(route.id)).toBe('rtsp://127.0.0.1/edit-lalu-stop-baru');
      expect(await prisma.auditLog.count({ where: { routeId: route.id, action: 'ROUTE_UPDATE_ROLLBACK' } })).toBe(0);
    } finally {
      notReadyPaths.delete(pathName);
    }
  });

  it('Deinitialize saat restart edit tidak diaktifkan kembali oleh rollback', async () => {
    const route = await createTestRoute({ ...mediaOnly, name: 'Edit Lalu Deinit', cameraKey: 'edit-lalu-deinit', inputUrl: 'rtsp://127.0.0.1/edit-lalu-deinit-lama' });
    const pathName = 'cameras/edit-lalu-deinit';
    expect((await request('POST', `/api/routes/${route.id}/start`)).json().status).toBe('RUNNING');
    notReadyPaths.add(pathName);
    try {
      const patching = request('PATCH', `/api/routes/${route.id}`, { inputUrl: 'rtsp://127.0.0.1/edit-lalu-deinit-baru' });
      await waitFor(() => fakeMediaConfigs.get(pathName)?.source === 'rtsp://127.0.0.1/edit-lalu-deinit-baru');
      const deinitialized = await request('POST', `/api/routes/${route.id}/deinitialize`);
      expect(deinitialized.statusCode).toBe(200);
      expect((await patching).statusCode).toBe(200);
      notReadyPaths.delete(pathName);
      await sleep(800);
      const row = await prisma.streamRoute.findUniqueOrThrow({ where: { id: route.id } });
      expect(row.enabled).toBe(false);
      expect(workerManager.isActive(route.id)).toBe(false);
      expect(workerManager.snapshot(route.id).status).toBe('STOPPED');
      expect(await storedInputUrl(route.id)).toBe('rtsp://127.0.0.1/edit-lalu-deinit-baru');
    } finally {
      notReadyPaths.delete(pathName);
    }
  });

  it('rollback Camera ID yang gagal READY melepas path baru dan menjalankan ulang path lama', async () => {
    const route = await createTestRoute({ ...mediaOnly, name: 'Ganti Camera ID', cameraKey: 'ganti-key-lama', inputUrl: 'rtsp://127.0.0.1/ganti-key-lama' });
    expect((await request('POST', `/api/routes/${route.id}/start`)).json().status).toBe('RUNNING');
    notReadyPaths.add('cameras/ganti-key-baru');
    try {
      const failed = await request('PATCH', `/api/routes/${route.id}`, { cameraKey: 'ganti-key-baru', inputUrl: 'rtsp://127.0.0.1/ganti-key-baru' });
      expect(failed.statusCode).toBe(503);
      expect(errorBody(failed)).toMatchObject({ code: 'ROUTE_RECONCILE_FAILED', details: { cause: 'MEDIAMTX_INGEST_NOT_READY' } });
      expect(fakeMediaPaths.has('cameras/ganti-key-baru')).toBe(false);
      expect(fakeMediaPaths.has('cameras/ganti-key-lama')).toBe(true);
      const row = await prisma.streamRoute.findUniqueOrThrow({ where: { id: route.id } });
      expect(row.cameraKey).toBe('ganti-key-lama');
      expect(await storedInputUrl(route.id)).toBe('rtsp://127.0.0.1/ganti-key-lama');
      expect(workerManager.snapshot(route.id).status).toBe('RUNNING');
    } finally {
      notReadyPaths.delete('cameras/ganti-key-baru');
      await workerManager.stop(route.id, true);
    }
  });

  it('edit relay pada route offline ditolak MAX_WORKERS saat slot penuh tanpa meninggalkan route STOPPED', async () => {
    const blocker = await createTestRoute({
      name: 'Slot Penuh Relay',
      inputUrl: 'rtsp://127.0.0.1/slot-penuh-relay',
      outputs: ['rtmp://127.0.0.1/live/slot-penuh-relay'],
      onlineRelayEnabled: true,
      retryPolicy: fastRetry
    });
    const target = await createTestRoute({ ...mediaOnly, name: 'Slot Penuh Offline', cameraKey: 'slot-penuh-offline', inputUrl: 'rtsp://127.0.0.1/slot-penuh-offline' });
    const previousLimit = await prisma.appSetting.findUnique({ where: { key: 'app.maxWorkers' } });
    notReadyPaths.add('cameras/slot-penuh-offline');
    try {
      expect((await request('POST', `/api/routes/${blocker.id}/start`)).statusCode).toBe(200);
      await workerManager.start(target.id).catch(() => undefined);
      expect(workerManager.snapshot(target.id).status).toBe('RESTARTING');
      const liveWorkers = String(workerManager.allSnapshots().filter((snapshot) => snapshot.pid !== null).length);
      await prisma.appSetting.upsert({
        where: { key: 'app.maxWorkers' },
        create: { key: 'app.maxWorkers', value: liveWorkers, isSecret: false },
        update: { value: liveWorkers }
      });
      const before = await prisma.streamRoute.findUniqueOrThrow({ where: { id: target.id } });

      const rejected = await request('PATCH', `/api/routes/${target.id}`, {
        onlineRelayEnabled: true,
        outputs: ['rtmp://127.0.0.1/live/slot-penuh-offline']
      });
      expect(rejected.statusCode).toBe(409);
      expect(errorBody(rejected).code).toBe('MAX_WORKERS');
      const after = await prisma.streamRoute.findUniqueOrThrow({ where: { id: target.id } });
      expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
      await sleep(300);
      expect(workerManager.isActive(target.id)).toBe(true);
      expect(workerManager.snapshot(target.id).status).toBe('RESTARTING');
      expect(fakeMediaPaths.has('cameras/slot-penuh-offline')).toBe(true);
    } finally {
      notReadyPaths.delete('cameras/slot-penuh-offline');
      if (previousLimit) {
        await prisma.appSetting.update({ where: { key: 'app.maxWorkers' }, data: { value: previousLimit.value } });
      } else {
        await prisma.appSetting.deleteMany({ where: { key: 'app.maxWorkers' } });
      }
      await workerManager.stop(target.id, true);
      await workerManager.stop(blocker.id, true);
    }
  });

  it('Viewer tetap menampilkan kamera lokal saat relay online FAILED; sumber online saja tetap butuh relay RUNNING', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.71', payload: { role: 'viewer' } });
    const viewerSession = sessionCookieFrom(login);
    const noRetry = { initialDelayMs: 500, maxDelayMs: 1000, maxRetries: 0, jitterRatio: 0, stableResetMs: 5000 };
    // Fake FFmpeg keluar sendiri bila argumennya memuat `/crash`, sehingga relay jatuh ke FAILED.
    const local = await createTestRoute({
      name: 'Viewer Relay Putus',
      cameraKey: 'crash-viewer-lokal',
      inputUrl: 'rtsp://127.0.0.1/crash-viewer-lokal',
      outputs: ['rtmp://127.0.0.1/live/crash-viewer-lokal'],
      onlineRelayEnabled: true,
      localViewEnabled: true,
      retryPolicy: noRetry
    });
    const onlineOnly = await createTestRoute({
      name: 'Viewer Online Saja Putus',
      cameraKey: 'crash-viewer-online',
      inputUrl: 'rtsp://127.0.0.1/crash-viewer-online',
      outputs: ['rtmp://127.0.0.1/live/crash-viewer-online'],
      onlineRelayEnabled: true,
      localViewEnabled: false,
      retryPolicy: noRetry,
      webrtc: { enabled: true, url: 'http://127.0.0.1:8889/embed/crash-viewer-online', mode: 'IFRAME' }
    });
    try {
      await request('POST', `/api/routes/${local.id}/start`);
      await request('POST', `/api/routes/${onlineOnly.id}/start`);
      await waitFor(() => workerManager.snapshot(local.id).status === 'FAILED' && workerManager.snapshot(onlineOnly.id).status === 'FAILED');

      const response = await app.inject({ method: 'GET', url: '/api/viewer/routes', headers: { cookie: viewerSession } });
      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<{ id: string; sources?: { local: unknown; preferred: string } }>;
      const shown = items.find((item) => item.id === local.id);
      expect(shown?.sources).toMatchObject({ local: expect.objectContaining({ mode: 'IFRAME' }), preferred: 'local' });
      expect(items.some((item) => item.id === onlineOnly.id)).toBe(false);
    } finally {
      await workerManager.stop(local.id, true);
      await workerManager.stop(onlineOnly.id, true);
    }
  });

  it('impor ONVIF memakai Camera ID eksplisit walau dipakai arsip recording route terhapus', async () => {
    const inspect = async () => (await app.inject({
      method: 'POST',
      url: '/api/settings/onvif-discovery/inspect',
      headers: { cookie: adminCookie },
      payload: {
        target: { host: '192.168.99.23', port: 80, path: '/onvif/device_service', useTls: false },
        credentials: { username: 'admin', password: 'valid' }
      }
    })).json().sessionId as string;
    const routeInput = (cameraKey: string) => ({
      cameraKey,
      name: 'Lobby Impor Ulang',
      description: '',
      outputs: [],
      enabled: true,
      autoStart: false,
      localViewEnabled: true,
      localAudioMode: 'COPY' as const,
      onlineRelayEnabled: false,
      recordingEnabled: false,
      recordingRetentionMode: 'INHERIT' as const,
      ffmpegMode: 'COPY' as const,
      onlineAudioMode: 'COPY' as const,
      ffmpegOptions: { videoBitrateKbps: 2500, audioBitrateKbps: 128, preset: 'veryfast' as const, gop: 50 },
      retryPolicy: { initialDelayMs: 2000, maxDelayMs: 60000, maxRetries: 10, jitterRatio: 0.2, stableResetMs: 60000 },
      webrtc: { enabled: false, mode: 'IFRAME' as const }
    });
    const orphan = await prisma.recordingSegment.create({
      data: {
        routeId: null,
        cameraKey: 'lobby-impor',
        cameraName: 'Lobby Lama',
        storageRoot: 'integration-onvif-orphan-root',
        relativePath: 'cameras/lobby-impor/2026/01/01/2026-01-01_00-00-00-000000.mp4',
        startTime: new Date('2026-01-01T00:00:00Z'),
        endTime: new Date('2026-01-01T00:01:00Z'),
        durationMs: 60_000,
        sizeBytes: 1024
      }
    });
    try {
      const imported = await importOnvifRoute({
        sessionId: await inspect(),
        profileToken: '000',
        ptzEnabled: false,
        zoomEnabled: false,
        route: routeInput('lobby-impor')
      });
      const created = imported.route as { id: string; cameraKey: string };
      createdRouteIds.push(created.id);
      expect(created.cameraKey).toBe('lobby-impor');

      await expect(importOnvifRoute({
        sessionId: await inspect(),
        profileToken: '000',
        ptzEnabled: false,
        zoomEnabled: false,
        route: routeInput('lobby-impor')
      })).rejects.toMatchObject({ code: 'CAMERA_KEY_CONFLICT' });
    } finally {
      await prisma.recordingSegment.delete({ where: { id: orphan.id } });
    }
  });
});
