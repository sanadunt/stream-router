import { describe, expect, it } from 'vitest';
import { createRouteSchema, updateRouteSchema } from '@stream-router/contracts';
import { AppError } from '../../src/shared/errors.js';
import { assertSsrfPolicy, detectInputProtocol, parseOutputUrl, parseWebrtcUrl } from '../../src/shared/url-policy.js';
import { runtimeRouteChanges, type RuntimeRoute } from '../../src/modules/routes/route-service.js';

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Fungsi tidak melempar error');
}

const baseRoute: RuntimeRoute = {
  id: 'route-1',
  cameraKey: 'lobby',
  name: 'Lobby',
  description: '',
  inputUrl: 'rtsp://admin:secret@192.168.1.10/live',
  inputProtocol: 'RTSP',
  outputs: ['rtmp://a.rtmp.youtube.com/live2/key'],
  enabled: true,
  autoStart: false,
  localViewEnabled: true,
  localAudioMode: 'COPY',
  onlineRelayEnabled: true,
  onlineAudioMode: 'COPY',
  recordingEnabled: false,
  recordingRetentionMode: 'INHERIT',
  recordingRetentionDays: null,
  recordingRetentionGb: null,
  ffmpegMode: 'COPY',
  ffmpegOptions: { videoBitrateKbps: 2500, audioBitrateKbps: 128, preset: 'veryfast', gop: 50 },
  retryPolicy: { initialDelayMs: 2000, maxDelayMs: 60000, maxRetries: 10, jitterRatio: 0.2, stableResetMs: 60000 },
  webrtc: { enabled: false, url: undefined, mode: 'IFRAME' }
};

describe('validasi URL stream', () => {
  it('menolak password kamera yang tidak di-encode dengan 400 tanpa membawa URL mentah', () => {
    const raw = 'rtsp://admin:Pa#ss-RAHASIA@192.168.1.10:554/stream1';
    for (const action of [() => assertSsrfPolicy(raw), () => detectInputProtocol(raw), () => parseOutputUrl(raw)]) {
      const error = captureError(action);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'INVALID_STREAM_URL', statusCode: 400 });
      expect((error as AppError).message).toContain('%23');
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('RAHASIA');
      expect(Object.values(error as object).join(' ')).not.toContain('RAHASIA');
    }
  });

  it('mengubah protokol, host terblokir, dan WebRTC URL salah menjadi error 400', () => {
    expect(captureError(() => detectInputProtocol('http://192.168.1.10/live')))
      .toMatchObject({ code: 'UNSUPPORTED_STREAM_PROTOCOL', statusCode: 400 });
    expect(captureError(() => parseOutputUrl('srt://example.test:9000')))
      .toMatchObject({ code: 'UNSUPPORTED_STREAM_PROTOCOL', statusCode: 400 });
    expect(captureError(() => assertSsrfPolicy('rtsp://blocked.local/live', ['blocked.local'])))
      .toMatchObject({ code: 'STREAM_HOST_BLOCKED', statusCode: 400 });
    const policy = { allowedOrigins: ['https://media.example.com'], allowInsecure: false };
    for (const value of ['bukan-url', 'ftp://media.example.com/x', 'http://media.example.com/x', 'https://evil.example.net/x']) {
      expect(captureError(() => parseWebrtcUrl(value, policy))).toMatchObject({ code: 'INVALID_WEBRTC_URL', statusCode: 400 });
    }
  });
});

describe('kontrak route', () => {
  const route = { name: 'Lobby', inputUrl: 'rtsp://192.168.1.10/live' };

  it('menolak output online duplikat', () => {
    const outputs = ['rtmp://a.rtmp.youtube.com/live2/key', ' rtmp://a.rtmp.youtube.com/live2/key'];
    expect(createRouteSchema.safeParse({ ...route, outputs }).success).toBe(false);
    expect(updateRouteSchema.safeParse({ outputs }).success).toBe(false);
    expect(updateRouteSchema.safeParse({ outputs: [outputs[0], 'rtmp://b.rtmp.youtube.com/live2/key'] }).success).toBe(true);
  });

  it('menerima null untuk menghapus link WebRTC dan membatasi panjangnya', () => {
    expect(updateRouteSchema.parse({ webrtc: { enabled: false, url: null } }).webrtc?.url).toBeNull();
    expect(updateRouteSchema.parse({ webrtc: { url: '  https://media.example.com/cam  ' } }).webrtc?.url)
      .toBe('https://media.example.com/cam');
    expect(updateRouteSchema.safeParse({ webrtc: { url: `https://media.example.com/${'a'.repeat(2048)}` } }).success).toBe(false);
    expect(updateRouteSchema.safeParse({ webrtc: { url: '' } }).success).toBe(false);
  });
});

describe('perubahan runtime route', () => {
  it('mengabaikan metadata, retention, retry policy, dan WebRTC', () => {
    expect(runtimeRouteChanges(baseRoute, {
      ...baseRoute,
      name: 'Lobby Baru',
      description: 'hanya teks',
      autoStart: true,
      recordingEnabled: true,
      recordingRetentionMode: 'DAYS',
      recordingRetentionDays: 7,
      retryPolicy: { ...baseRoute.retryPolicy, maxRetries: 3 },
      webrtc: { enabled: true, url: 'https://media.example.com/cam', mode: 'WHEP' },
      outputs: [...baseRoute.outputs],
      ffmpegOptions: { gop: 50, preset: 'veryfast', audioBitrateKbps: 128, videoBitrateKbps: 2500 }
    })).toEqual([]);
  });

  it('mendeteksi perubahan yang menyentuh MediaMTX atau FFmpeg', () => {
    expect(runtimeRouteChanges(baseRoute, {
      ...baseRoute,
      cameraKey: 'lobby-2',
      inputUrl: 'rtsp://admin:secret@192.168.1.11/live',
      outputs: ['rtmp://b.rtmp.youtube.com/live2/key'],
      localAudioMode: 'OPUS',
      ffmpegOptions: { ...baseRoute.ffmpegOptions, fps: 15 }
    })).toEqual(['cameraKey', 'inputUrl', 'outputs', 'localAudioMode', 'ffmpegOptions']);
    expect(runtimeRouteChanges(baseRoute, { ...baseRoute, onlineRelayEnabled: false })).toEqual(['onlineRelayEnabled']);
  });
});
