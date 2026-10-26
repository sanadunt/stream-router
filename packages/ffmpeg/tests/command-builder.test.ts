import { describe, expect, it } from 'vitest';
import { buildFfmpegCommand, redactText, redactUrl } from '../src/index.js';

const base = {
  ffmpegPath: 'ffmpeg',
  inputUrl: 'rtsp://admin:secret@192.168.1.10/live',
  inputProtocol: 'RTSP' as const,
  outputs: ['rtmp://user:key@example.test/live/a'],
  options: {
    videoBitrateKbps: 2500, audioBitrateKbps: 128, preset: 'veryfast' as const, gop: 50
  }
};

describe('command builder', () => {
  it('membangun mode copy tanpa shell string', () => {
    const result = buildFfmpegCommand({ ...base, mode: 'COPY', audioMode: 'COPY', inputTimeoutOption: 'rw_timeout' });
    expect(result.executable).toBe('ffmpeg');
    expect(result.args).toContain('copy');
    expect(result.args).toContain('-rw_timeout');
    expect(result.redactedArgs.join(' ')).not.toContain('secret');
    expect(result.args).toContain('rtmp://user:key@example.test/live/a');
    expect(result.redactedArgs).toContain('rtmp://***:***@example.test/live/***');
  });

  it('fallback ke timeout RTSP atau menonaktifkannya sesuai kemampuan binary', () => {
    const fallback = buildFfmpegCommand({ ...base, mode: 'COPY', audioMode: 'COPY', inputTimeoutOption: 'timeout' });
    expect(fallback.args).toContain('-timeout');
    expect(fallback.args).not.toContain('-rw_timeout');
    const portable = buildFfmpegCommand({ ...base, mode: 'COPY', audioMode: 'COPY', inputTimeoutOption: 'none' });
    expect(portable.args).not.toContain('-timeout');
    expect(portable.args).not.toContain('-rw_timeout');
    expect(portable.args).toContain('-rtsp_transport');
  });

  it('transcode multi-output meng-encode sekali lalu fan-out lewat tee', () => {
    const result = buildFfmpegCommand({
      ...base,
      mode: 'TRANSCODE',
      audioMode: 'AAC',
      outputs: [...base.outputs, 'rtmps://host/live/b']
    });
    expect(result.args.filter((item) => item === 'libx264')).toHaveLength(1);
    expect(result.args.filter((item) => item === 'aac')).toHaveLength(1);
    expect(result.args.filter((item) => item === '-map')).toHaveLength(2);
    expect(result.args.slice(-5)).toEqual([
      '-flags', '+global_header', '-f', 'tee',
      '[f=flv:onfail=abort]rtmp://user:key@example.test/live/a|[f=flv:onfail=abort]rtmps://host/live/b'
    ]);
    expect(result.redactedArgs.at(-1))
      .toBe('[f=flv:onfail=abort]rtmp://***:***@example.test/live/***|[f=flv:onfail=abort]rtmps://host/live/***');
    expect(result.redactedArgs.join(' ')).not.toMatch(/live\/[ab]\b|user:key/);
  });

  it('tetap memakai output flv terpisah bila tidak ada encode atau hanya satu output', () => {
    const copy = buildFfmpegCommand({ ...base, mode: 'COPY', audioMode: 'COPY', outputs: [...base.outputs, 'rtmp://host/live/b'] });
    expect(copy.args.filter((item) => item === 'flv')).toHaveLength(2);
    expect(copy.args).not.toContain('tee');
    const single = buildFfmpegCommand({ ...base, mode: 'TRANSCODE', audioMode: 'AAC' });
    expect(single.args).not.toContain('tee');
    expect(single.args.slice(-3)).toEqual(['-f', 'flv', 'rtmp://user:key@example.test/live/a']);
  });

  it('meng-escape karakter khusus tee pada URL output', () => {
    const result = buildFfmpegCommand({
      ...base,
      mode: 'COPY',
      audioMode: 'AAC',
      outputs: [String.raw`rtmp://host/live/a|b[c]'d\e`, 'rtmp://host/live/f']
    });
    expect(result.args.at(-1))
      .toBe(String.raw`[f=flv:onfail=abort]rtmp://host/live/a\|b\[c\]\'d\\e|[f=flv:onfail=abort]rtmp://host/live/f`);
    expect(result.redactedArgs.at(-1))
      .toBe('[f=flv:onfail=abort]rtmp://host/live/***|[f=flv:onfail=abort]rtmp://host/live/***');
  });

  it.each([
    ['COPY', 'COPY', 'copy'],
    ['COPY', 'AAC', 'aac'],
    ['COPY', 'OPUS', 'libopus'],
    ['TRANSCODE', 'COPY', 'copy'],
    ['TRANSCODE', 'AAC', 'aac'],
    ['TRANSCODE', 'OPUS', 'libopus']
  ] as const)('memisahkan video %s dan audio %s', (mode, audioMode, expectedAudioCodec) => {
    const result = buildFfmpegCommand({ ...base, mode, audioMode });
    expect(result.args).toContain(mode === 'TRANSCODE' ? 'libx264' : 'copy');
    expect(result.args).toContain(expectedAudioCodec);
  });

  it('meredaksi credential URL dan log', () => {
    expect(redactUrl(base.inputUrl)).not.toContain('secret');
    expect(redactText(`open ${base.inputUrl}`)).not.toContain('secret');
  });

  it.each([
    ['rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl', 'rtmp://a.rtmp.youtube.com/live2/***'],
    ['rtmp://user:key@example.test/live/a', 'rtmp://***:***@example.test/live/***'],
    ['rtmps://live-api-s.facebook.com:443/rtmp/FB-1-0-Abc?s_bl=1&a=Secret', 'rtmps://live-api-s.facebook.com:443/rtmp/***?***'],
    ['rtmp://b.rtmp.youtube.com/live2?backup=1/abcd-efgh', 'rtmp://b.rtmp.youtube.com/live2?***'],
    ['rtmp://host/app/_definst_/stream-key', 'rtmp://host/app/_definst_/***'],
    ['rtmp://host/live/key/', 'rtmp://host/live/***/'],
    ['rtmp://host/live/key#frag', 'rtmp://host/live/***#***'],
    ['rtmp://host:99999/live/key?x=1', 'rtmp://host:99999/live/***?***'],
    ['rtmp://example.test/live', 'rtmp://example.test/live']
  ])('meredaksi stream key RTMP %s', (value, expected) => {
    expect(redactUrl(value)).toBe(expected);
  });

  it('tidak menyamarkan path RTSP atau HTTP', () => {
    expect(redactUrl(base.inputUrl)).toBe('rtsp://***:***@192.168.1.10/live');
    expect(redactUrl('https://example.test/whep/cam?token=abc')).toBe('https://example.test/whep/cam?token=***');
  });

  it.each([
    [
      'rtsp://192.168.1.10:554/user=admin&password=RAHASIA1&channel=1&stream=0.sdp?real_stream',
      'rtsp://192.168.1.10:554/***?real_stream'
    ],
    ['rtsp://192.168.1.10/user=admin_password=RAHA_SIA2_channel=1_stream=0.sdp', 'rtsp://192.168.1.10/***'],
    ['rtsp://192.168.1.10/cam/realmonitor;pwd=RAHASIA3/sub', 'rtsp://192.168.1.10/cam/***/sub'],
    ['rtsp://192.168.1.11/live?user=admin&pwd=RAHASIA4', 'rtsp://192.168.1.11/live?user=admin&pwd=***'],
    ['rtsp://192.168.1.11/live?PassWd=RAHASIA5&channel=2', 'rtsp://192.168.1.11/live?PassWd=***&channel=2'],
    [
      'https://example.test/whep?access_token=RAHASIA6&api_key=RAHASIA7&jwt=RAHASIA8',
      'https://example.test/whep?access_token=***&api_key=***&jwt=***'
    ]
  ])('meredaksi kredensial kamera di path atau query %s', (value, expected) => {
    expect(redactUrl(value)).toBe(expected);
  });

  it('meredaksi kredensial path pada URL yang tidak dapat di-parse dan di log FFmpeg', () => {
    expect(redactUrl('rtsp://admin:Pa#ss@192.168.1.10/user=admin&password=RAHASIA9?token=RAHASIA10'))
      .not.toMatch(/RAHASIA|Pa#ss/);
    expect(redactText("Input #0, rtsp, from 'rtsp://192.168.1.10/user=admin_password=RAHASIA11_channel=1':"))
      .toBe("Input #0, rtsp, from 'rtsp://192.168.1.10/***':");
  });

  it('meredaksi stream key RTMP di log FFmpeg tanpa merusak teks sekitarnya', () => {
    expect(redactText("Output #0, flv, to 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh':"))
      .toBe("Output #0, flv, to 'rtmp://a.rtmp.youtube.com/live2/***':");
    expect(redactText('Error opening output rtmp://host/live/abc: Input/output error'))
      .toBe('Error opening output rtmp://host/live/***: Input/output error');
    expect(redactText('["rtmp://a/live/k1","rtmp://u:p@b/live/k2"]'))
      .toBe('["rtmp://a/live/***","rtmp://***:***@b/live/***"]');
  });
});
