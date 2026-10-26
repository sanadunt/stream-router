import { beforeEach, describe, expect, it, vi } from 'vitest';

const camState = vi.hoisted(() => ({
  deviceInformation: null as Record<string, unknown> | null,
  hostnameInformation: null as Record<string, unknown> | null,
  calls: [] as string[]
}));

vi.mock('onvif/promises/index.js', () => {
  class Cam {
    profiles = [{
      $: { token: 'main' },
      name: 'Main',
      videoEncoderConfiguration: { encoding: 'H264', resolution: { width: 1920, height: 1080 } }
    }];

    async connect(): Promise<void> {
      camState.calls.push('connect');
    }

    async getDeviceInformation(): Promise<Record<string, unknown>> {
      camState.calls.push('getDeviceInformation');
      if (!camState.deviceInformation) throw new Error('ONVIF SOAP Fault: Action not supported');
      return camState.deviceInformation;
    }

    async getHostname(): Promise<Record<string, unknown>> {
      camState.calls.push('getHostname');
      if (!camState.hostnameInformation) throw new Error('Network timeout');
      return camState.hostnameInformation;
    }

    async getStreamUri(): Promise<{ uri: string }> {
      return { uri: 'rtsp://firmware-host:554/Streaming/Channels/101' };
    }
  }
  return { default: { Cam, Discovery: {} } };
});

const { defaultInspect, normalizeOnvifStreamUri } = await import('../../src/modules/onvif-discovery/onvif-discovery-service.js');

const target = { host: '192.168.1.20', port: 80, path: '/onvif/device_service', useTls: false };
const credentials = { username: 'admin', password: 'secret' };

describe('ONVIF discovery: URI RTSP hasil import', () => {
  it.each([
    ['Ab%41c'],
    ['p%zz9'],
    ['Adm1n%2024'],
    ['p@ss:word/1#x?y'],
    ['spasi dan+plus']
  ])('meng-encode password %s agar consumer yang men-decode userinfo mendapat nilai asli', (password) => {
    const normalized = normalizeOnvifStreamUri(
      'rtsp://firmware-host:554/Streaming/Channels/101',
      '192.168.1.20',
      { username: 'op%er@tor', password }
    );
    const parsed = new URL(normalized);
    expect(parsed.hostname).toBe('192.168.1.20');
    expect(parsed.pathname).toBe('/Streaming/Channels/101');
    // MediaMTX (Go net/url) men-decode userinfo persis seperti decodeURIComponent.
    expect(decodeURIComponent(parsed.username)).toBe('op%er@tor');
    expect(decodeURIComponent(parsed.password)).toBe(password);
  });

  it('mengganti host dengan alamat IPv6 hasil pemeriksaan', () => {
    for (const host of ['fe80::1', '[fe80::1]']) {
      const parsed = new URL(normalizeOnvifStreamUri('rtsp://10.0.0.5:554/live', host, credentials));
      expect(parsed.hostname).toBe('[fe80::1]');
      expect(parsed.port).toBe('554');
    }
  });

  it('menolak host yang tidak dapat dipakai pada URI RTSP', () => {
    expect(() => normalizeOnvifStreamUri('rtsp://10.0.0.5:554/live', 'fe80::1%eth0', credentials))
      .toThrow(/Host kamera/);
  });
});

describe('ONVIF discovery: informasi perangkat saat pemeriksaan', () => {
  beforeEach(() => {
    camState.calls = [];
    camState.deviceInformation = null;
    camState.hostnameInformation = null;
  });

  it('mengambil device information dan hostname setelah connect', async () => {
    // Library ONVIF mengubah teks numerik menjadi number.
    camState.deviceInformation = {
      manufacturer: 'Hikvision',
      model: 2000,
      firmwareVersion: 'V5.5.0 build 180124',
      serialNumber: 12345678,
      hardwareId: 88
    };
    camState.hostnameInformation = { fromDHCP: false, name: 'Lobby-Cam' };

    const result = await defaultInspect(target, credentials);

    expect(camState.calls[0]).toBe('connect');
    expect(camState.calls).toEqual(expect.arrayContaining(['getDeviceInformation', 'getHostname']));
    expect(result.device).toEqual({
      manufacturer: 'Hikvision',
      model: '2000',
      hostname: 'Lobby-Cam',
      firmwareVersion: 'V5.5.0 build 180124',
      serialNumber: '12345678'
    });
    expect(result.profiles).toEqual([expect.objectContaining({
      token: 'main',
      streamUri: 'rtsp://firmware-host:554/Streaming/Channels/101'
    })]);
  });

  it('tetap berhasil dengan fallback bila kamera menolak device information dan hostname', async () => {
    const result = await defaultInspect(target, credentials);

    expect(result.device).toEqual({
      manufacturer: '',
      model: '',
      hostname: '192.168.1.20',
      firmwareVersion: '',
      serialNumber: ''
    });
    expect(result.profiles).toHaveLength(1);
  });
});
