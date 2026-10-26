import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptString, encryptString, SESSION_TTL_SECONDS, signSession, verifySession } from '../../src/shared/crypto.js';
import { calculateBackoff } from '../../src/shared/retry.js';
import { parseInputUrl, parseOutputUrl, assertSsrfPolicy, parseStreamViewUrl, parseWebrtcUrl } from '../../src/shared/url-policy.js';
import { canTransition } from '../../src/modules/workers/state-machine.js';
import { envSchema } from '../../src/config/env.js';
import { mqttPayload, onvifProfileOptions } from '../../src/modules/ptz/ptz-controller.js';
import { buildCameraPresencePayload, parseMqttBridgeCommand } from '../../src/modules/mqtt-bridge/mqtt-bridge-runtime.js';
import { getPtzConnectionStatus, resetPtzConnectionStatus, setPtzConnectionStatus } from '../../src/modules/ptz/ptz-status.js';
import { cameraKeySchema, mediaMtxSettingsSchema, onvifPtzConfigSchema } from '@stream-router/contracts';
import { renderMediaMtxConfig } from '../../src/modules/mediamtx/mediamtx-config.js';
import { audioTranscodeCommand, recordingPathOptions } from '../../src/modules/mediamtx/mediamtx-runtime.js';
import { allowInsecureStreamView } from '../../src/modules/webrtc-streams/webrtc-stream-service.js';
import { publicHostToStore, resolveMediaPublicHost } from '../../src/modules/settings/settings-service.js';
import {
  evaluateStoragePressure,
  inspectFmp4Buffer,
  isFragmentedMp4Buffer,
  parseRecordingDuration,
  parseRecordingStart,
  planRecordingQuotaCleanup,
  resolveObservedDuration,
  resolveRecordingRetention
} from '../../src/modules/recordings/recording-service.js';
import { isValidTimeZone, recordingDateKey } from '../../src/modules/recordings/recording-routes.js';
import {
  dedupeDiscoveryDevices,
  discoveryDeviceFromProbe,
  normalizeOnvifStreamUri,
  scopesFromProbeXml,
  xaddrsFromProbeXml
} from '../../src/modules/onvif-discovery/onvif-discovery-service.js';

describe('core security and domain logic', () => {
  it('memvalidasi environment wajib', () => {
    expect(() => envSchema.parse({ AUTH_SECRET: 'short', APP_ENCRYPTION_KEY: 'short', ADMIN_PASSWORD: 'short' })).toThrow();
    expect(() => envSchema.parse({
      AUTH_SECRET: 'GANTI_DENGAN_SECRET_ACAK_MINIMAL_32_KARAKTER',
      APP_ENCRYPTION_KEY: 'GANTI_DENGAN_KEY_ACAK_MINIMAL_32_KARAKTER',
      ADMIN_PASSWORD: 'GANTI_DENGAN_PASSWORD_ADMIN_KUAT'
    })).toThrow(/nilai contoh/);
    expect(envSchema.parse({
      AUTH_SECRET: 'a'.repeat(32), APP_ENCRYPTION_KEY: 'b'.repeat(32), ADMIN_PASSWORD: 'password123',
      OPERATOR_PASSWORD: 'operator-password123'
    }).PORT).toBe(3000);
  });
  it('encrypt/decrypt dan autentikasi GCM', () => {
    const secret = '01234567890123456789012345678901';
    const encrypted = encryptString('rtsp://admin:secret@camera/live', secret);
    expect(encrypted).not.toContain('secret');
    expect(decryptString(encrypted, secret)).toContain('admin:secret');
    expect(() => decryptString(`${encrypted}x`, secret)).toThrow();
  });

  it('session ditandatangani dan ditolak bila berubah', () => {
    const secret = '01234567890123456789012345678901';
    const token = signSession({ username: 'admin' }, secret);
    expect(verifySession<{ username: string }>(token, secret)?.username).toBe('admin');
    expect(verifySession(`${token}x`, secret)).toBeNull();

    const malformedBody = Buffer.from('bukan-json').toString('base64url');
    const malformedSignature = createHmac('sha256', secret).update(malformedBody).digest('base64url');
    expect(verifySession(`${malformedBody}.${malformedSignature}`, secret)).toBeNull();
  });

  it('session dengan exp melebihi batas umur server ditolak walau signature valid', () => {
    const secret = '01234567890123456789012345678901';
    const sign = (exp: number) => {
      const body = Buffer.from(JSON.stringify({ username: 'admin', exp })).toString('base64url');
      return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
    };
    const now = Math.floor(Date.now() / 1000);
    expect(verifySession(sign(now + SESSION_TTL_SECONDS), secret)).not.toBeNull();
    expect(verifySession(sign(now + SESSION_TTL_SECONDS + 60), secret)).toBeNull();
    expect(verifySession(sign(now + 10 * 365 * 86400), secret)).toBeNull();
    expect(verifySession(sign(now + 120), secret, 60)).toBeNull();
  });

  it('validasi protokol dan private IP tetap diizinkan', () => {
    expect(parseInputUrl('rtsp://192.168.1.2/live').protocol).toBe('RTSP');
    expect(parseOutputUrl('rtmps://example.test/live/a').protocol).toBe('RTMPS');
    expect(() => parseInputUrl('http://example.test/a')).toThrow();
    expect(() => assertSsrfPolicy('rtsp://10.0.0.4/live')).not.toThrow();
    expect(() => assertSsrfPolicy('rtsp://blocked.local/live', ['blocked.local'])).toThrow();
  });

  it('backoff eksponensial memiliki batas dan jitter deterministik', () => {
    expect(calculateBackoff(1, 2000, 60000, 0.2, () => 0.5)).toBe(2000);
    expect(calculateBackoff(10, 2000, 60000, 0, () => 0)).toBe(60000);
  });

  it('state machine menolak transisi yang tidak sah', () => {
    expect(canTransition('STOPPED', 'STARTING')).toBe(true);
    expect(canTransition('STOPPED', 'RUNNING')).toBe(false);
    expect(canTransition('RUNNING', 'RESTARTING')).toBe(true);
  });

  it('webrtc url policy: protokol, origin allowlist, https-only production', () => {
    const dev = { allowedOrigins: [], allowInsecure: true };
    const prod = { allowedOrigins: [], allowInsecure: false };
    const restricted = { allowedOrigins: ['https://media.example.com'], allowInsecure: false };

    expect(parseWebrtcUrl('https://media.example.com/player?stream=cam1', dev).hostname).toBe('media.example.com');
    expect(parseWebrtcUrl('http://192.168.1.10:8889/cam1', dev).hostname).toBe('192.168.1.10');
    expect(() => parseWebrtcUrl('http://192.168.1.10:8889/cam1', prod)).toThrow(/development/);
    expect(() => parseWebrtcUrl('rtmp://media.example.com/live', dev)).toThrow(/http/);
    expect(() => parseWebrtcUrl('javascript:alert(1)', dev)).toThrow();
    expect(() => parseWebrtcUrl('bukan-url', dev)).toThrow(/tidak valid/);
    expect(parseWebrtcUrl('https://media.example.com/whep/cam1', restricted).origin).toBe('https://media.example.com');
    expect(() => parseWebrtcUrl('https://evil.example.net/player', restricted)).toThrow(/diizinkan/);
  });

  it('memvalidasi dan menormalisasi URL multi-type Stream View', () => {
    const secure = { allowedOrigins: [], allowInsecure: false };
    const lan = { allowedOrigins: [], allowInsecure: true };
    expect(parseStreamViewUrl('https://youtu.be/dQw4w9WgXcQ', 'YOUTUBE', secure).viewerUrl)
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1');
    expect(parseStreamViewUrl('https://www.youtube.com/live/dQw4w9WgXcQ', 'YOUTUBE', secure).viewerUrl)
      .toContain('/embed/dQw4w9WgXcQ');
    expect(parseStreamViewUrl('https://media.example.com/live/cam.m3u8', 'HLS', secure).viewerUrl)
      .toContain('.m3u8');
    expect(parseStreamViewUrl('http://192.168.1.10/mjpeg', 'MJPEG', lan).sourceUrl)
      .toBe('http://192.168.1.10/mjpeg');
    expect(() => parseStreamViewUrl('http://192.168.1.10/cam.mp4', 'MP4', secure)).toThrow(/HTTP/);
    expect(() => parseStreamViewUrl('https://admin:secret@media.example.com/cam.mp4', 'MP4', secure)).toThrow(/username/);
    expect(() => parseStreamViewUrl('https://evil.example.net/cam.mp4', 'MP4', {
      allowedOrigins: ['https://media.example.com'],
      allowInsecure: false
    })).toThrow(/diizinkan/);
  });

  it('mengizinkan Stream View HTTP saat development tetapi tetap eksplisit di production', () => {
    expect(allowInsecureStreamView('development', false)).toBe(true);
    expect(allowInsecureStreamView('test', false)).toBe(true);
    expect(allowInsecureStreamView('production', false)).toBe(false);
    expect(allowInsecureStreamView('production', true)).toBe(true);
  });

  it('membentuk payload MQTT PTZ sesuai kontrak perangkat', () => {
    expect(mqttPayload({ type: 'move', direction: 'left', speed: 0.4, durationMs: 0 }))
      .toBe('{"type":"move","direction":"left","speed":0.4,"durationMs":0}');
    expect(mqttPayload({ type: 'stop', direction: 'stop', speed: 0.4, durationMs: 0 }))
      .toBe('{"type":"stop","direction":"stop","speed":0.4,"durationMs":0}');
    expect(mqttPayload({ type: 'zoom', direction: 'in', speed: 0.4, durationMs: 0 }))
      .toBe('{"type":"zoom","direction":"null","speed":0.4,"durationMs":0}');
    expect(mqttPayload({ type: 'zoom', direction: 'out', speed: 0.4, durationMs: 0 }))
      .toBe('{"type":"zoom","direction":"null","speed":-0.4,"durationMs":0}');
  });

  it('membentuk hot config recording fMP4 ON/OFF tanpa mengubah source ingest', () => {
    const enabled = recordingPathOptions({
      recordingPath: 'data/recordings',
      segmentDurationSeconds: 3600
    }, true);
    expect(enabled).toMatchObject({
      record: true,
      recordFormat: 'fmp4',
      recordPartDuration: '1s',
      recordMaxPartSize: '50M',
      recordSegmentDuration: '3600s',
      recordDeleteAfter: '0s'
    });
    expect(enabled).not.toHaveProperty('source');
    expect(recordingPathOptions({
      recordingPath: 'data/recordings',
      segmentDurationSeconds: 3600
    }, false).record).toBe(false);
  });

  it('memvalidasi dan menerapkan Media Profile Token ONVIF per kamera', () => {
    const shared = {
      provider: 'ONVIF' as const,
      host: '192.168.1.13',
      port: 80,
      username: 'admin',
      useTls: false,
      path: '/onvif/device_service'
    };
    expect(onvifPtzConfigSchema.parse({ ...shared }).profileToken).toBe('');
    expect(onvifPtzConfigSchema.parse({ ...shared, profileToken: '100' }).profileToken).toBe('100');
    expect(() => onvifPtzConfigSchema.parse({ ...shared, profileToken: '<ProfileToken>evil' })).toThrow();
    expect(onvifProfileOptions('100')).toEqual({ profileToken: '100' });
    expect(onvifProfileOptions('')).toEqual({});
  });

  it('mem-parsing dan mendeduplikasi hasil WS-Discovery berdasarkan URN atau XAddr', () => {
    expect(scopesFromProbeXml(
      '<d:ProbeMatch><d:Scopes>onvif://www.onvif.org/name/Lobby%20Camera onvif://www.onvif.org/type/video_encoder</d:Scopes></d:ProbeMatch>'
    )).toEqual([
      'onvif://www.onvif.org/name/Lobby%20Camera',
      'onvif://www.onvif.org/type/video_encoder'
    ]);
    const deduped = dedupeDiscoveryDevices([
      {
        urn: 'urn:uuid:camera-1',
        host: '192.168.1.20',
        port: 80,
        path: '/onvif/device_service',
        useTls: false,
        scopes: ['scope-a'],
        xaddrs: ['http://192.168.1.20/onvif/device_service']
      },
      {
        urn: 'URN:UUID:CAMERA-1',
        host: '192.168.1.20',
        port: 80,
        path: '/onvif/device_service',
        useTls: false,
        scopes: ['scope-b'],
        xaddrs: ['http://192.168.1.20/onvif/device_service']
      },
      {
        host: '192.168.1.21',
        port: 8080,
        path: '/onvif/device_service',
        useTls: false,
        xaddrs: ['http://192.168.1.21:8080/onvif/device_service']
      },
      {
        host: '192.168.1.21',
        port: 8080,
        path: '/onvif/device_service',
        useTls: false,
        xaddrs: ['http://192.168.1.21:8080/onvif/device_service']
      }
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.scopes).toEqual(['scope-a', 'scope-b']);
  });

  it('mem-parsing endpoint WS-Discovery yang normal dan fallback untuk respons kamera non-standar', () => {
    const normalXml = `
      <s:Envelope><s:Body><d:ProbeMatches><d:ProbeMatch>
        <a:EndpointReference><a:Address>urn:uuid:camera-14</a:Address></a:EndpointReference>
        <d:Scopes>onvif://www.onvif.org/name/IP-Camera onvif://www.onvif.org/Profile/T</d:Scopes>
        <d:XAddrs>http://192.168.1.14:8899/onvif/device_service http://0.0.0.0/onvif/device_service</d:XAddrs>
      </d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;
    expect(xaddrsFromProbeXml(normalXml)).toEqual([
      'http://192.168.1.14:8899/onvif/device_service',
      'http://0.0.0.0/onvif/device_service'
    ]);
    expect(discoveryDeviceFromProbe(normalXml, '192.168.1.14')).toMatchObject({
      urn: 'urn:uuid:camera-14',
      host: '192.168.1.14',
      port: 8899,
      path: '/onvif/device_service'
    });

    expect(discoveryDeviceFromProbe(
      '<ProbeMatch><Scopes>onvif://www.onvif.org/type/video_encoder</Scopes></ProbeMatch>',
      '192.168.1.20'
    )).toMatchObject({
      host: '192.168.1.20',
      port: 80,
      path: '/onvif/device_service',
      xaddrs: []
    });
    expect(discoveryDeviceFromProbe(
      '<ProbeMatch><XAddrs>http://0.0.0.0:8080/onvif/device_service</XAddrs></ProbeMatch>',
      '192.168.1.21'
    )).toMatchObject({ host: '192.168.1.21', port: 8080 });
  });

  it('menormalisasi host RTSP hasil ONVIF dan meng-encode credential dengan aman', () => {
    const normalized = normalizeOnvifStreamUri(
      'rtsp://firmware-host:554/Streaming/Channels/100',
      '192.168.1.20',
      { username: 'operator@example', password: 'p@ss:word/1' }
    );
    const parsed = new URL(normalized);
    expect(parsed.hostname).toBe('192.168.1.20');
    expect(parsed.pathname).toBe('/Streaming/Channels/100');
    expect(parsed.username).toBe('operator%40example');
    expect(parsed.password).toBe('p%40ss%3Aword%2F1');
    expect(() => normalizeOnvifStreamUri('http://camera/video', '192.168.1.20', {
      username: '',
      password: ''
    })).toThrow(/RTSP/);
  });

  it('memvalidasi payload MQTT bridge dan mengonversi zoom signed ke ONVIF', () => {
    expect(parseMqttBridgeCommand('{"type":"move","direction":"left","speed":0.4,"durationMs":0}'))
      .toEqual({ type: 'move', direction: 'left', speed: 0.4, durationMs: 0 });
    expect(parseMqttBridgeCommand('{"type":"stop","direction":"stop","speed":0.4,"durationMs":0}'))
      .toEqual({ type: 'stop', direction: 'stop', speed: 0.4, durationMs: 0 });
    expect(parseMqttBridgeCommand('{"type":"zoom","direction":"null","speed":0.4,"durationMs":0}'))
      .toEqual({ type: 'zoom', direction: 'in', speed: 0.4, durationMs: 0 });
    expect(parseMqttBridgeCommand('{"type":"zoom","direction":"null","speed":-0.4,"durationMs":0}'))
      .toEqual({ type: 'zoom', direction: 'out', speed: 0.4, durationMs: 0 });
    expect(parseMqttBridgeCommand('{"type":"move","direction":"diagonal","speed":0.4,"durationMs":0}')).toBeNull();
    expect(parseMqttBridgeCommand('{"type":"zoom","direction":"null","speed":0,"durationMs":0}')).toBeNull();
    expect(parseMqttBridgeCommand('bukan-json')).toBeNull();
  });

  it('membentuk presence MQTT dengan timestamp angka dan identitas kamera', () => {
    expect(JSON.parse(buildCameraPresencePayload({
      status: 'online',
      timestamp: 1_785_212_800_000,
      cameraId: 'camera-1',
      cameraName: 'Kamera Lobby',
      description: 'Pintu masuk'
    }))).toEqual({
      status: 'online',
      timestamp: 1_785_212_800_000,
      cameraId: 'camera-1',
      cameraName: 'Kamera Lobby',
      description: 'Pintu masuk'
    });
  });

  it('membedakan konfigurasi PTZ dari koneksi yang sudah diverifikasi', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    resetPtzConnectionStatus('ROUTE', id);
    expect(getPtzConnectionStatus('ROUTE', id, true).state).toBe('UNTESTED');
    setPtzConnectionStatus('ROUTE', id, 'CONNECTED', 'Endpoint merespons', true);
    expect(getPtzConnectionStatus('ROUTE', id, true)).toMatchObject({
      state: 'CONNECTED',
      message: 'Endpoint merespons'
    });
    expect(getPtzConnectionStatus('ROUTE', id, false).state).toBe('DISABLED');
  });

  it('memvalidasi camera key dan port MediaMTX yang unik', () => {
    expect(cameraKeySchema.parse('camera-lobby_01')).toBe('camera-lobby_01');
    expect(() => cameraKeySchema.parse('../camera')).toThrow();
    const settings = {
      enabled: true,
      publicHost: '192.168.1.2',
      recordingPath: 'data/recordings',
      rtspPort: 18554,
      rtmpPort: 11935,
      hlsPort: 18888,
      webrtcPort: 18889,
      webrtcUdpPort: 18189,
      srtPort: 18890,
      playbackPort: 19996,
      apiPort: 19997,
      metricsPort: 19998,
      retentionMode: 'DAYS' as const,
      retentionDays: 30,
      retentionMaxGb: 100,
      minFreePercent: 15,
      minFreeGb: 20,
      segmentDurationSeconds: 3600
    };
    expect(mediaMtxSettingsSchema.parse(settings).apiPort).toBe(19997);
    // Public host kosong berarti mengikuti MEDIAMTX_PUBLIC_HOST / deteksi otomatis, bukan error validasi.
    expect(mediaMtxSettingsSchema.parse({ ...settings, publicHost: '  ' }).publicHost).toBe('');
    expect(() => mediaMtxSettingsSchema.parse({ ...settings, metricsPort: 19997 })).toThrow(/unik/);
    expect(() => mediaMtxSettingsSchema.parse({ ...settings, segmentDurationSeconds: 3601 })).toThrow();
  });

  it('memilih IP LAN untuk public host MediaMTX ketika konfigurasi masih loopback', () => {
    const candidates = [
      { name: 'docker0', address: '172.17.0.1', family: 'IPv4', internal: false },
      { name: 'enp3s0', address: '192.168.1.135', family: 'IPv4', internal: false },
      { name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true }
    ];
    expect(resolveMediaPublicHost('127.0.0.1', { candidates })).toBe('192.168.1.135');
    expect(resolveMediaPublicHost('localhost', { candidates })).toBe('192.168.1.135');
    expect(resolveMediaPublicHost('media.internal.example', { candidates })).toBe('media.internal.example');
  });

  it('memakai MEDIAMTX_PUBLIC_HOST sebelum deteksi otomatis, tetapi host Settings tetap menang', () => {
    // Di container Docker Desktop, interface yang terlihat hanya jaringan bridge Docker.
    const candidates = [{ name: 'eth0', address: '172.18.0.2', family: 'IPv4', internal: false }];
    expect(resolveMediaPublicHost('127.0.0.1', { candidates, defaultHost: '192.168.1.50' })).toBe('192.168.1.50');
    expect(resolveMediaPublicHost('', { candidates, defaultHost: ' kamera.lan ' })).toBe('kamera.lan');
    expect(resolveMediaPublicHost('192.168.1.77', { candidates, defaultHost: '192.168.1.50' })).toBe('192.168.1.77');
    // Default kosong atau wildcard tetap memakai deteksi otomatis seperti sebelumnya.
    expect(resolveMediaPublicHost('127.0.0.1', { candidates, defaultHost: '' })).toBe('172.18.0.2');
    expect(resolveMediaPublicHost('127.0.0.1', { candidates, defaultHost: '0.0.0.0' })).toBe('172.18.0.2');
    expect(resolveMediaPublicHost('127.0.0.1', { candidates: [], defaultHost: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('MEDIAMTX_PUBLIC_HOST loopback dipakai apa adanya untuk mode BIND_ADDRESS=127.0.0.1', () => {
    // Port Docker hanya dipublikasikan di 127.0.0.1 Windows: IP container 172.x tidak dapat dijangkau
    // browser, sedangkan URL WHEP loopback diganti browser dengan host halaman.
    const candidates = [{ name: 'eth0', address: '172.18.0.2', family: 'IPv4', internal: false }];
    expect(resolveMediaPublicHost('', { candidates, defaultHost: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveMediaPublicHost('127.0.0.1', { candidates, defaultHost: 'localhost' })).toBe('localhost');
    expect(resolveMediaPublicHost('', { candidates, defaultHost: '::1' })).toBe('::1');
    // Nilai loopback tersimpan di Settings tetap dianggap default lama (belum diatur).
    expect(resolveMediaPublicHost('localhost', { candidates, defaultHost: '' })).toBe('172.18.0.2');
  });

  it('publicHost dari form hanya disimpan bila berbeda dari nilai otomatis', () => {
    const unset = { publicHostConfigured: '', publicHostDefault: '192.168.1.10' };
    // Form lama mengirim balik host hasil fallback HOST_LAN_IP: tidak boleh dibekukan ke database.
    expect(publicHostToStore('192.168.1.10', unset, '192.168.1.10')).toBeNull();
    expect(publicHostToStore('192.168.1.10', unset, '')).toBeNull();
    for (const empty of ['', '  ', 'auto', 'AUTO', '127.0.0.1', 'localhost', '0.0.0.0', '[::1]']) {
      expect(publicHostToStore(empty, unset, '192.168.1.10'), empty).toBeNull();
    }
    expect(publicHostToStore(' 192.168.1.99 ', unset, '192.168.1.10')).toBe('192.168.1.99');
    expect(publicHostToStore('Kamera.LAN', unset, '192.168.1.10')).toBe('Kamera.LAN');

    // Nilai lama yang sudah terlanjur sama dengan HOST_LAN_IP dilepas agar perubahan IP berikutnya berlaku.
    const pinned = { publicHostConfigured: '192.168.1.10', publicHostDefault: '192.168.1.10' };
    expect(publicHostToStore('192.168.1.10', pinned, '192.168.1.10')).toBeNull();
    // Tanpa MEDIAMTX_PUBLIC_HOST, nilai tersimpan yang kebetulan sama dengan deteksi otomatis dipertahankan.
    expect(publicHostToStore('192.168.1.10', pinned, '')).toBe('192.168.1.10');
    // HOST_LAN_IP berubah ke .23: nilai .10 yang diisi Admin tetap disimpan apa adanya.
    expect(publicHostToStore('192.168.1.10', { publicHostConfigured: '192.168.1.10', publicHostDefault: '192.168.1.23' }, '192.168.1.23'))
      .toBe('192.168.1.10');
  });

  it('merender listener MediaMTX internal dan LAN tanpa menulis credential kamera', () => {
    const config = renderMediaMtxConfig({
      enabled: true,
      version: 'v1.19.2',
      publicHost: '192.168.1.2',
      recordingPath: 'data/recordings',
      rtspPort: 18554,
      rtmpPort: 11935,
      hlsPort: 18888,
      webrtcPort: 18889,
      webrtcUdpPort: 18189,
      srtPort: 18890,
      playbackPort: 19996,
      apiPort: 19997,
      metricsPort: 19998,
      retentionMode: 'DAYS',
      retentionDays: 30,
      retentionMaxGb: 100,
      minFreePercent: 15,
      minFreeGb: 20,
      segmentDurationSeconds: 3600,
      apiUrl: 'http://127.0.0.1:19997',
      rtspUrl: 'rtsp://127.0.0.1:18554',
      playbackUrl: 'http://127.0.0.1:19996'
    });
    expect(config).toContain('apiAddress: 127.0.0.1:19997');
    expect(config).toContain('playbackAddress: 127.0.0.1:19996');
    expect(config).toContain('webrtcAddress: :18889');
    expect(config).toContain('webrtcLocalUDPAddress: :18189');
    expect(config).toContain('webrtcAdditionalHosts: ["192.168.1.2"]');
    expect(config).toContain('rtspTransports: [tcp]');
    expect(config).toContain('authInternalUsers:');
    expect(config).toContain('moq: no');
    expect(config).toContain('recordSegmentDuration: 3600s');
    expect(config).not.toContain('rtsp://admin');
  });

  it('membentuk jalur audio Opus dengan video copy untuk WebRTC lokal', () => {
    const command = audioTranscodeCommand(
      { rtspPort: 18554 },
      '/usr/local/bin/ffmpeg',
      'cameras/camera-1',
      'cameras/camera-1/webrtc',
      96
    );
    expect(command).toContain("'/usr/local/bin/ffmpeg'");
    expect(command).toContain('-c:v copy');
    expect(command).toContain('-c:a libopus');
    expect(command).toContain('-b:a 96k');
    expect(command).toContain("'rtsp://127.0.0.1:18554/cameras/camera-1/webrtc'");
  });

  it('mem-parsing metadata segment dan menerapkan hysteresis storage', () => {
    expect(parseRecordingDuration('5m0s')).toBe(300_000);
    expect(parseRecordingDuration('1s250ms')).toBe(1_250);
    expect(resolveObservedDuration(5_000, 0, 10_000, 11_000)).toBe(5_000);
    expect(resolveObservedDuration(0, 4_750, 10_000, 11_000)).toBe(4_750);
    expect(resolveObservedDuration(0, 0, 10_000, 15_200)).toBe(5_200);
    const start = parseRecordingStart('/recordings/camera/2026-07-28_10-11-12-123456.mp4');
    expect(start?.getFullYear()).toBe(2026);
    expect(start?.getMilliseconds()).toBe(123);

    const gb = 1024 ** 3;
    expect(evaluateStoragePressure(100 * gb, 14 * gb, 15, 10, false).paused).toBe(true);
    expect(evaluateStoragePressure(100 * gb, 16 * gb, 15, 10, true).paused).toBe(true);
    expect(evaluateStoragePressure(100 * gb, 21 * gb, 15, 10, true).paused).toBe(false);
  });

  it('mendeteksi struktur dasar fMP4 dan menolak segment rusak', () => {
    const box = (type: string, payload = Buffer.alloc(0)) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(8 + payload.length);
      header.write(type, 4, 4, 'ascii');
      return Buffer.concat([header, payload]);
    };
    expect(inspectFmp4Buffer(Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat')]))).toEqual({
      ok: true,
      error: null
    });
    expect(inspectFmp4Buffer(Buffer.from('bukan-video'))).toMatchObject({ ok: false });
    expect(inspectFmp4Buffer(Buffer.concat([box('ftyp'), box('moov')]))).toMatchObject({
      ok: false,
      error: expect.stringContaining('fragment')
    });
    expect(isFragmentedMp4Buffer(Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat')]))).toBe(true);
    expect(isFragmentedMp4Buffer(Buffer.concat([box('ftyp'), box('moov'), box('mdat')]))).toBe(false);
  });

  it('mengelompokkan kalender recording sesuai zona waktu browser', () => {
    const timestamp = new Date('2026-07-28T17:30:00.000Z');
    expect(recordingDateKey(timestamp, 'Asia/Jakarta')).toBe('2026-07-29');
    expect(recordingDateKey(timestamp, 'UTC')).toBe('2026-07-28');
    expect(isValidTimeZone('Asia/Jakarta')).toBe(true);
    expect(isValidTimeZone('zona/tidak-ada')).toBe(false);
  });

  it('menyelesaikan policy retention hari, kuota GB, dan inheritance', () => {
    const defaults = { mode: 'DAYS_OR_SIZE' as const, days: 30, maxGb: 100 };
    expect(resolveRecordingRetention('INHERIT', null, null, defaults)).toEqual(defaults);
    expect(resolveRecordingRetention('DAYS', 7, null, defaults)).toEqual({
      mode: 'DAYS',
      days: 7,
      maxGb: 100
    });
    expect(resolveRecordingRetention('SIZE', null, 12.5, defaults)).toEqual({
      mode: 'SIZE',
      days: 30,
      maxGb: 12.5
    });
    expect(planRecordingQuotaCleanup([
      { id: 'protected-oldest', sizeBytes: 60, protected: true },
      { id: 'oldest-removable', sizeBytes: 60, protected: false },
      { id: 'newest', sizeBytes: 60, protected: false }
    ], 120)).toEqual({
      deleteIds: ['oldest-removable'],
      usedBytes: 180,
      projectedBytes: 120
    });
  });
});
