import { describe, expect, it } from 'vitest';
import { parseFfmpegCapabilities } from '../../src/modules/workers/ffmpeg-capabilities.js';

describe('FFmpeg capability detection', () => {
  it('mendeteksi rw_timeout dan timeout RTSP dari help binary', () => {
    expect(parseFfmpegCapabilities(
      '  -rw_timeout        <int64> ED......... Timeout for IO operations',
      '  -timeout           <int64> .D......... set timeout of socket I/O operations',
      ' A..... libopus              libopus Opus'
    )).toEqual({ rwTimeout: true, rtspTimeout: true, libopus: true });
  });

  it('aman untuk build lama yang tidak memiliki kedua opsi', () => {
    expect(parseFfmpegCapabilities('ffmpeg legacy help', 'RTSP demuxer help'))
      .toEqual({ rwTimeout: false, rtspTimeout: false, libopus: false });
  });
});
