import { describe, expect, it } from 'vitest';
import { redactText, redactUrl } from '../src/index.js';

describe('redaksi credential pada path dan query RTSP', () => {
  // Segmen path yang memuat password disamarkan seluruhnya karena password sendiri boleh memuat `_` atau `&`.
  it.each([
    [
      'rtsp://admin:secret@192.168.1.10:554/user=admin_password=Xy7Qp2Lm_channel=1_stream=0.sdp?real_stream',
      'rtsp://***:***@192.168.1.10:554/***?real_stream'
    ],
    ['rtsp://192.168.1.10:554/user=admin&password=Secret_1&channel=1&stream=0.sdp?', 'rtsp://192.168.1.10:554/***?'],
    ['rtsp://192.168.1.10/live;pwd=rahasia;channel=2', 'rtsp://192.168.1.10/***'],
    ['rtsp://cam:554/live?user=admin&pwd=secret&channel=1', 'rtsp://cam:554/live?user=admin&pwd=***&channel=1'],
    ['rtsp://cam/live?passwd=secret', 'rtsp://cam/live?passwd=***'],
    ['rtsp://u:p@cam:99999/user=admin_password=Xy7Qp2Lm_channel=1', 'rtsp://***:***@cam:99999/***']
  ])('menyamarkan credential gaya XM/OEM pada %s', (value, expected) => {
    expect(redactUrl(value)).toBe(expected);
  });

  it('tidak membocorkan potongan password yang memuat garis bawah', () => {
    const masked = redactUrl('rtsp://cam/user=admin_password=abc_def_channel=1_stream=0.sdp');
    expect(masked).not.toContain('abc');
    expect(masked).not.toContain('def');
  });

  it('tidak mengubah path RTSP biasa', () => {
    expect(redactUrl('rtsp://cam/Streaming/Channels/101?transportmode=unicast&profile=Profile_1'))
      .toBe('rtsp://cam/Streaming/Channels/101?transportmode=unicast&profile=Profile_1');
    expect(redactUrl('rtsp://cam/cam/realmonitor?channel=1&subtype=0'))
      .toBe('rtsp://cam/cam/realmonitor?channel=1&subtype=0');
  });

  it('menyamarkan credential path di log tanpa merusak teks sekitarnya', () => {
    const log = 'Gagal membuka rtsp://cam/user=admin_password=Xy7Qp2Lm_channel=1_stream=0.sdp: 401';
    expect(redactText(log)).toBe('Gagal membuka rtsp://cam/***: 401');
    expect(redactText(log)).not.toContain('Xy7Qp2Lm');
  });
});

describe('redaksi baris log muxer tee', () => {
  it('mempertahankan pemisah slave tee dan menyamarkan setiap stream key', () => {
    const redacted = '[f=flv:onfail=abort]rtmp://a.rtmp.youtube.com/live2/***|[f=flv:onfail=abort]rtmps://live-api-s.facebook.com:443/rtmp/***?***';
    const command = `Menjalankan relay online: /opt/ffmpeg -f tee ${redacted}`;
    expect(redactText(command)).toBe(command);

    const stderr = "Output #0, tee, to '[f=flv:onfail=abort]rtmp://a.rtmp.youtube.com/live2/kunci-satu|[f=flv:onfail=abort]rtmps://live-api-s.facebook.com:443/rtmp/FB-kunci-dua?s_bl=1':";
    expect(redactText(stderr)).toBe(
      "Output #0, tee, to '[f=flv:onfail=abort]rtmp://a.rtmp.youtube.com/live2/***|[f=flv:onfail=abort]rtmps://live-api-s.facebook.com:443/rtmp/***?***':"
    );
    expect(redactText('rtmp://host/live/kunci-a|rtmp://host/live/kunci-b')).toBe('rtmp://host/live/***|rtmp://host/live/***');
  });

  it('stream key yang memuat karakter escape tee tidak bocor setelah pemisah', () => {
    const line = String.raw`[f=flv:onfail=abort]rtmp://host/live/rahasia\|lanjut\[x\]\'y\\z|[f=flv:onfail=abort]rtmp://host/live/kunci-dua`;
    const redacted = redactText(line);
    expect(redacted).toBe('[f=flv:onfail=abort]rtmp://host/live/***|[f=flv:onfail=abort]rtmp://host/live/***');
    expect(redacted).not.toMatch(/rahasia|lanjut|kunci-dua/);
  });

  it('password kamera yang memuat `|` tetap disamarkan seluruhnya', () => {
    const redacted = redactText('Gagal membuka rtsp://admin:pa|ss@192.168.1.10/stream: 401');
    expect(redacted).not.toContain('pa|ss');
    expect(redacted).not.toContain('ss@');
  });
});
