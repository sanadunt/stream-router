import { describe, expect, it } from 'vitest';
import { localWebrtcUrl } from '../../src/modules/mediamtx/mediamtx-runtime.js';

describe('URL player WebRTC lokal', () => {
  it('tanpa MEDIAMTX_WEBRTC_PUBLIC_URL memakai http://<publicHost>:<webrtcPort>', () => {
    expect(localWebrtcUrl({ publicHost: '192.168.1.10', webrtcPort: 18889 }, 'cameras/gerbang'))
      .toBe('http://192.168.1.10:18889/cameras/gerbang');
    expect(localWebrtcUrl({ publicHost: 'fd00::10', webrtcPort: 18889, webrtcPublicUrl: '' }, 'cameras/gerbang/webrtc'))
      .toBe('http://[fd00::10]:18889/cameras/gerbang/webrtc');
  });

  it('dengan base URL publik memakai HTTPS dan garis miring akhir agar MediaMTX tidak redirect ke path tanpa prefix', () => {
    const settings = { publicHost: '203.0.113.7', webrtcPort: 18889 };
    expect(localWebrtcUrl({ ...settings, webrtcPublicUrl: 'https://webrtc.example.com' }, 'cameras/gerbang'))
      .toBe('https://webrtc.example.com/cameras/gerbang/');
    expect(localWebrtcUrl({ ...settings, webrtcPublicUrl: 'https://kamera.example.com/webrtc' }, 'cameras/gerbang/webrtc'))
      .toBe('https://kamera.example.com/webrtc/cameras/gerbang/webrtc/');
  });
});
