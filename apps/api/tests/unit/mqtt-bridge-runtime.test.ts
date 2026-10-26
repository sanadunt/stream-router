import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient {
  clientId: string;
  connected: boolean;
  ended: boolean;
  destroyed: boolean;
  subscriptions: Set<string>;
  published: Array<{ topic: string; payload: string; at: number }>;
  emit(event: string, ...args: unknown[]): boolean;
}

interface RouteRow {
  id: string;
  name: string;
  description: string;
  mqttBridgeEnabled: boolean;
  ptzProvider: string;
  ptzEnabled: boolean;
  mqttBridgeSubscriptions: Array<{ brokerId: string; commandTopic: string; broker: { rootTopic: string } }>;
}

const fake = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  routes: new Map<string, RouteRow>(),
  subscribe: undefined as undefined | ((topics: string[]) => Promise<unknown>),
  unsubscribe: undefined as undefined | (() => Promise<unknown>),
  end: undefined as undefined | (() => Promise<void>)
}));

vi.mock('mqtt', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeMqttClient extends EventEmitter implements FakeClient {
    connected = true;
    ended = false;
    destroyed = false;
    subscriptions = new Set<string>();
    published: Array<{ topic: string; payload: string; at: number }> = [];
    stream = {
      destroy: () => {
        this.destroyed = true;
        this.connected = false;
      }
    };
    constructor(readonly clientId: string) {
      super();
    }
    subscribeAsync(topics: string | string[]): Promise<unknown> {
      const list = Array.isArray(topics) ? topics : [topics];
      if (fake.subscribe) return fake.subscribe(list);
      for (const topic of list) this.subscriptions.add(topic);
      return Promise.resolve(list.map((topic) => ({ topic, qos: 0 })));
    }
    unsubscribeAsync(topic: string): Promise<unknown> {
      if (fake.unsubscribe) return fake.unsubscribe();
      this.subscriptions.delete(topic);
      return Promise.resolve();
    }
    async publishAsync(topic: string, payload: string): Promise<void> {
      this.published.push({ topic, payload, at: Date.now() });
    }
    endAsync(): Promise<void> {
      if (fake.end) return fake.end();
      this.ended = true;
      this.connected = false;
      return Promise.resolve();
    }
  }
  return {
    connectAsync: vi.fn(async (_url: string, options: { clientId?: string }) => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      const client = new FakeMqttClient(options.clientId ?? '');
      fake.clients.push(client);
      return client;
    })
  };
});

vi.mock('../../src/db/client.js', () => ({
  prisma: {
    streamRoute: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => fake.routes.get(where.id) ?? null)
    }
  }
}));

vi.mock('../../src/modules/ptz/ptz-controller.js', () => ({
  executePtzCommand: vi.fn(async () => true),
  testPtzConnection: vi.fn(async () => ({ state: 'CONNECTED', checkedAt: null, message: 'ok' }))
}));

vi.mock('../../src/modules/ptz/ptz-service.js', () => ({
  getStoredPtzConfig: vi.fn(async () => ({
    provider: 'ONVIF',
    enabled: true,
    zoomEnabled: true,
    host: '127.0.0.1',
    port: 80,
    username: 'admin',
    password: 'rahasia',
    useTls: false,
    path: '/onvif/device_service',
    profileToken: ''
  }))
}));

vi.mock('../../src/modules/mqtt-bridge/mqtt-broker-service.js', () => ({
  getMqttBrokerRuntimeConfig: vi.fn(async (id: string) => ({
    id,
    name: `Broker ${id}`,
    protocol: 'mqtt',
    host: '127.0.0.1',
    port: 1883,
    path: '/mqtt',
    rootTopic: 'Root',
    username: 'bridge',
    password: 'rahasia'
  }))
}));

vi.mock('../../src/modules/logs/log-store.js', () => ({
  appendRouteLog: vi.fn(async () => undefined)
}));

vi.mock('../../src/modules/mqtt-bridge/camera-status-publisher.js', () => ({
  buildCameraPresencePayload: (input: Record<string, unknown>) => JSON.stringify(input),
  publishCameraCatalog: vi.fn(async () => undefined)
}));

const { connectAsync } = await import('mqtt');
const { testPtzConnection } = await import('../../src/modules/ptz/ptz-controller.js');
const { appendRouteLog } = await import('../../src/modules/logs/log-store.js');
const { publishCameraCatalog } = await import('../../src/modules/mqtt-bridge/camera-status-publisher.js');
const runtime = await import('../../src/modules/mqtt-bridge/mqtt-bridge-runtime.js');

function addRoute(id: string, brokerIds = ['broker-1']): void {
  fake.routes.set(id, {
    id,
    name: `Kamera ${id}`,
    description: '',
    mqttBridgeEnabled: true,
    ptzProvider: 'ONVIF',
    ptzEnabled: true,
    mqttBridgeSubscriptions: brokerIds.map((brokerId) => ({
      brokerId,
      commandTopic: `Root/${id}`,
      broker: { rootTopic: 'Root' }
    }))
  });
}

const openClients = () => fake.clients.filter((client) => !client.ended && !client.destroyed);

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('runtime MQTT→ONVIF bridge', () => {
  beforeEach(() => {
    fake.clients = [];
    fake.routes.clear();
    fake.subscribe = undefined;
    fake.unsubscribe = undefined;
    fake.end = undefined;
    unhandled.length = 0;
    vi.mocked(connectAsync).mockClear();
    vi.mocked(appendRouteLog).mockReset().mockResolvedValue(undefined);
    vi.mocked(publishCameraCatalog).mockReset().mockResolvedValue(undefined);
    vi.mocked(testPtzConnection).mockReset().mockResolvedValue({ state: 'CONNECTED', checkedAt: null, message: 'ok' });
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    fake.subscribe = undefined;
    fake.unsubscribe = undefined;
    fake.end = undefined;
    vi.useRealTimers();
    await runtime.shutdownMqttBridgeRuntime();
    await settle();
    process.off('unhandledRejection', onUnhandled);
  });

  it('refresh serentak beberapa route memakai satu koneksi broker tanpa client bocor', async () => {
    for (const id of ['r1', 'r2', 'r3']) addRoute(id);
    await Promise.all(['r1', 'r2', 'r3'].map((id) => runtime.startMqttOnvifBridge(id)));
    expect(connectAsync).toHaveBeenCalledTimes(1);

    await Promise.all(['r1', 'r2', 'r3'].map((id) => runtime.refreshMqttOnvifBridge(id, true)));
    expect(openClients()).toHaveLength(1);
    expect(fake.clients.length).toBeLessThanOrEqual(2);
    expect([...openClients()[0]!.subscriptions].sort()).toEqual(['Root/r1', 'Root/r2', 'Root/r3']);
    expect(new Set(fake.clients.map((client) => client.clientId)).size).toBe(fake.clients.length);

    await Promise.all(['r1', 'r2', 'r3'].map((id) => runtime.stopMqttOnvifBridge(id)));
    expect(openClients()).toEqual([]);
  });

  it('start serentak untuk route yang sama tidak meninggalkan runtime yatim setelah stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    addRoute('r-dup');
    await Promise.all([runtime.startMqttOnvifBridge('r-dup'), runtime.startMqttOnvifBridge('r-dup')]);
    await runtime.stopMqttOnvifBridge('r-dup');
    const stoppedAt = Date.now();
    expect(runtime.getMqttBridgeRuntimeStatus('r-dup')).toMatchObject({ active: false });
    await vi.advanceTimersByTimeAsync(40_000);
    await settle();
    const lateOnline = fake.clients.flatMap((client) => client.published)
      .filter((item) => item.at > stoppedAt && item.topic === 'Root/r-dup/status' && item.payload.includes('"online"'));
    expect(lateOnline).toEqual([]);
    expect(openClients()).toEqual([]);
  });

  it('ONVIF yang gagal saat start dicoba ulang oleh heartbeat sampai bridge aktif', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    addRoute('r-boot');
    vi.mocked(testPtzConnection).mockRejectedValueOnce(new Error('Koneksi ONVIF timeout.'));
    await runtime.startMqttOnvifBridge('r-boot');
    expect(runtime.getMqttBridgeRuntimeStatus('r-boot')).toMatchObject({ active: true, onvifConnected: false });
    expect(connectAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    await settle();
    expect(testPtzConnection).toHaveBeenCalledTimes(2);
    expect(runtime.getMqttBridgeRuntimeStatus('r-boot')).toMatchObject({ active: true, onvifConnected: true });
    expect(openClients()[0]?.subscriptions.has('Root/r-boot')).toBe(true);
    expect(openClients()[0]?.published.some((item) => item.topic === 'Root/r-boot/status' && item.payload.includes('"online"')))
      .toBe(true);
  });

  it('subscribe yang ditolak broker dan log yang gagal tidak menimbulkan unhandledRejection', async () => {
    addRoute('r-acl');
    await runtime.startMqttOnvifBridge('r-acl');
    const client = openClients()[0]!;

    fake.subscribe = () => Promise.reject(new Error('Subscribe error: Unspecified error'));
    client.emit('connect');
    vi.mocked(appendRouteLog).mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    client.emit('message', 'Root/r-acl', Buffer.from('bukan-json'), { retain: false });
    await settle();
    expect(runtime.getMqttBrokerConnectionStatus('broker-1')).toMatchObject({ state: 'ERROR' });
    expect(unhandled).toEqual([]);
  });

  it('subscribe/unsubscribe yang tidak dijawab broker half-open dibatasi timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    addRoute('r-half-open');
    fake.subscribe = () => new Promise(() => undefined);
    let started = false;
    const start = runtime.startMqttOnvifBridge('r-half-open').then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await start;
    expect(started).toBe(true);
    expect(appendRouteLog).toHaveBeenCalledWith('r-half-open', 'error', 'MQTT bridge gagal terhubung ke seluruh broker yang dipilih.');

    fake.subscribe = undefined;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(openClients()[0]?.subscriptions.has('Root/r-half-open')).toBe(true);

    fake.unsubscribe = () => new Promise(() => undefined);
    fake.end = () => new Promise(() => undefined);
    let stopped = false;
    const stop = runtime.stopMqttOnvifBridge('r-half-open').then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await stop;
    expect(stopped).toBe(true);
    expect(fake.clients[0]!.destroyed).toBe(true);
  });

  it('heartbeat route tidak membangun katalog per route; katalog terbit sekali per broker per interval', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    for (const id of ['c1', 'c2', 'c3', 'c4']) addRoute(id);
    for (const id of ['c1', 'c2', 'c3', 'c4']) await runtime.startMqttOnvifBridge(id);
    vi.mocked(publishCameraCatalog).mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(publishCameraCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(publishCameraCatalog).toHaveBeenCalledTimes(2);
  });
});
