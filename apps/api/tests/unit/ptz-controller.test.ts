import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CamCall {
  type: 'move' | 'stop';
  at: number;
}

interface FakeClientState {
  clientId: string;
  ended: boolean;
}

const fake = vi.hoisted(() => ({
  connectCalls: 0,
  connect: undefined as undefined | (() => Promise<unknown>),
  move: undefined as undefined | (() => Promise<unknown>),
  stop: undefined as undefined | (() => Promise<unknown>),
  calls: [] as CamCall[],
  mqttClients: [] as FakeClientState[]
}));

vi.mock('onvif/promises/index.js', () => ({
  Cam: class {
    profiles = [];
    async connect(): Promise<unknown> {
      fake.connectCalls += 1;
      return fake.connect?.();
    }
    async continuousMove(): Promise<unknown> {
      fake.calls.push({ type: 'move', at: Date.now() });
      return fake.move?.();
    }
    async stop(): Promise<unknown> {
      fake.calls.push({ type: 'stop', at: Date.now() });
      return fake.stop?.();
    }
  }
}));

vi.mock('mqtt', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeMqttClient extends EventEmitter implements FakeClientState {
    connected = true;
    ended = false;
    stream = { destroy: () => { this.ended = true; } };
    constructor(readonly clientId: string) {
      super();
    }
    async publishAsync(): Promise<void> {}
    async endAsync(): Promise<void> {
      this.ended = true;
      this.connected = false;
    }
  }
  return {
    connectAsync: vi.fn(async (_url: string, options: { clientId: string }) => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      const client = new FakeMqttClient(options.clientId);
      fake.mqttClients.push(client);
      return client;
    })
  };
});

vi.mock('../../src/modules/mqtt-bridge/camera-status-publisher.js', () => ({
  publishCameraCatalog: vi.fn(async () => undefined),
  publishPtzCameraPresence: vi.fn(async () => undefined)
}));

const { connectAsync } = await import('mqtt');
const publisher = await import('../../src/modules/mqtt-bridge/camera-status-publisher.js');
const {
  executePtzCommand,
  releasePtzTarget,
  shutdownPtzControllers,
  testPtzConnection
} = await import('../../src/modules/ptz/ptz-controller.js');

const move = { type: 'move', direction: 'right', speed: 0.4, durationMs: 0 } as const;
const stop = { type: 'stop', direction: 'stop', speed: 0.4, durationMs: 0 } as const;

function onvifConfig() {
  return {
    provider: 'ONVIF' as const,
    enabled: true,
    zoomEnabled: true,
    host: '127.0.0.1',
    port: 80,
    username: 'admin',
    password: 'rahasia',
    useTls: false,
    path: '/onvif/device_service',
    profileToken: ''
  };
}

function mqttConfig(cameraId: string) {
  return {
    provider: 'MQTT' as const,
    enabled: true,
    zoomEnabled: true,
    brokerId: '11111111-2222-4333-8444-555555555555',
    cameraId,
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Broker',
    protocol: 'mqtt' as const,
    host: '127.0.0.1',
    port: 1883,
    username: 'ptz',
    password: 'rahasia',
    path: '/mqtt',
    rootTopic: 'Root',
    fullTopic: `Root/${cameraId}`
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('PTZ controller', () => {
  beforeEach(() => {
    fake.connectCalls = 0;
    fake.connect = undefined;
    fake.move = undefined;
    fake.stop = undefined;
    fake.calls = [];
    fake.mqttClients = [];
    unhandled.length = 0;
    vi.mocked(connectAsync).mockClear();
    vi.mocked(publisher.publishCameraCatalog).mockResolvedValue(undefined);
    vi.mocked(publisher.publishPtzCameraPresence).mockResolvedValue(undefined);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await shutdownPtzControllers();
    await settle();
    process.off('unhandledRejection', onUnhandled);
  });

  it('perintah dan release yang gagal tidak menimbulkan unhandledRejection', async () => {
    fake.connect = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    };
    await expect(executePtzCommand('WEBRTC_STREAM', 'cam-offline', onvifConfig(), move))
      .rejects.toMatchObject({ code: 'PTZ_COMMAND_FAILED', statusCode: 502 });

    fake.connect = undefined;
    await testPtzConnection('WEBRTC_STREAM', 'cam-release', onvifConfig());
    fake.stop = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9');
    };
    await releasePtzTarget('WEBRTC_STREAM', 'cam-release');
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('menggabungkan keepalive Viewer sehingga stop tidak tertahan di belakang move yang menumpuk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fake.move = () => new Promise((resolve) => setTimeout(resolve, 800));
    const config = onvifConfig();
    const results: Array<Promise<boolean>> = [];
    for (let tick = 0; tick < 10; tick += 1) {
      results.push(executePtzCommand('WEBRTC_STREAM', 'cam-slow', config, move));
      await vi.advanceTimersByTimeAsync(500);
    }
    const releasedAt = Date.now();
    results.push(executePtzCommand('WEBRTC_STREAM', 'cam-slow', config, stop));
    await vi.advanceTimersByTimeAsync(3000);
    const outcomes = await Promise.all(results);

    const stops = fake.calls.filter((call) => call.type === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.at - releasedAt).toBeLessThanOrEqual(800);
    expect(fake.calls.filter((call) => call.type === 'move' && call.at > releasedAt)).toEqual([]);
    expect(outcomes.at(-1)).toBe(true);
    expect(outcomes.filter((executed) => !executed).length).toBeGreaterThan(0);
  });

  it('dead-man tetap aktif ketika keepalive gagal setelah kamera mulai bergerak', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const config = onvifConfig();
    await executePtzCommand('WEBRTC_STREAM', 'cam-deadman', config, move);
    fake.move = async () => {
      throw new Error('ONVIF device busy');
    };
    await vi.advanceTimersByTimeAsync(500);
    await expect(executePtzCommand('WEBRTC_STREAM', 'cam-deadman', config, move))
      .rejects.toMatchObject({ code: 'PTZ_COMMAND_FAILED' });
    await vi.advanceTimersByTimeAsync(1300);
    expect(fake.calls.filter((call) => call.type === 'stop')).toHaveLength(1);
  });

  it('timer dead-man lama dibatalkan sehingga tidak ada stop yatim setelah release', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const config = onvifConfig();
    fake.move = () => new Promise((resolve) => setTimeout(resolve, 100));
    const moves = Promise.all([
      executePtzCommand('WEBRTC_STREAM', 'cam-orphan', config, move),
      executePtzCommand('WEBRTC_STREAM', 'cam-orphan', config, move)
    ]);
    await vi.advanceTimersByTimeAsync(300);
    await moves;
    await executePtzCommand('WEBRTC_STREAM', 'cam-orphan', config, stop);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.calls.filter((call) => call.type === 'stop')).toHaveLength(1);
  });

  it('membuang Cam ONVIF dari cache setelah gagal dan tes fresh selalu handshake ulang', async () => {
    const config = onvifConfig();
    fake.move = async () => {
      throw new Error('NotAuthorized');
    };
    await expect(executePtzCommand('WEBRTC_STREAM', 'cam-evict', config, move)).rejects.toMatchObject({
      code: 'PTZ_COMMAND_FAILED',
      message: 'Autentikasi ONVIF ditolak. Periksa username dan password.'
    });
    await expect(executePtzCommand('WEBRTC_STREAM', 'cam-evict', config, move)).rejects.toBeTruthy();
    expect(fake.connectCalls).toBe(2);

    fake.move = undefined;
    await executePtzCommand('WEBRTC_STREAM', 'cam-evict', config, move);
    await executePtzCommand('WEBRTC_STREAM', 'cam-evict', config, move);
    await testPtzConnection('WEBRTC_STREAM', 'cam-evict', config);
    expect(fake.connectCalls).toBe(3);

    fake.connect = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:80');
    };
    await expect(testPtzConnection('WEBRTC_STREAM', 'cam-evict', config, { fresh: true }))
      .rejects.toMatchObject({ code: 'PTZ_CONNECTION_FAILED' });
    expect(fake.connectCalls).toBe(4);
  });

  it('tes PTZ MQTT serentak memakai satu client broker dan heartbeat gagal tidak mematikan proses', async () => {
    vi.mocked(publisher.publishCameraCatalog).mockRejectedValue(new Error('client disconnecting'));
    vi.mocked(publisher.publishPtzCameraPresence).mockRejectedValue(new Error('client disconnecting'));
    await Promise.all([
      testPtzConnection('WEBRTC_STREAM', 'mqtt-a', mqttConfig('cam-a')),
      testPtzConnection('WEBRTC_STREAM', 'mqtt-b', mqttConfig('cam-b')),
      testPtzConnection('ROUTE', 'mqtt-c', mqttConfig('cam-c'))
    ]);
    expect(connectAsync).toHaveBeenCalledTimes(1);

    await releasePtzTarget('WEBRTC_STREAM', 'mqtt-a');
    await releasePtzTarget('WEBRTC_STREAM', 'mqtt-b');
    expect(fake.mqttClients[0]!.ended).toBe(false);
    await releasePtzTarget('ROUTE', 'mqtt-c');
    expect(fake.mqttClients.every((client) => client.ended)).toBe(true);
    await settle();
    expect(unhandled).toEqual([]);
  });
});
