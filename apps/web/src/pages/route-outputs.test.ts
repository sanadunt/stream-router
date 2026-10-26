import { describe, expect, it } from 'vitest';
import { duplicateOutputs, parseOutputLines } from './route-outputs';

describe('Output online di editor route', () => {
  it('membaca satu output per baris dan mengabaikan baris kosong', () => {
    expect(parseOutputLines(' rtmp://a/live/1 \n\n rtmp://b/live/2\n')).toEqual(['rtmp://a/live/1', 'rtmp://b/live/2']);
  });

  it('mendeteksi output duplikat setelah spasi dipangkas sebelum request dikirim', () => {
    const outputs = parseOutputLines('rtmp://a/live/1\n rtmp://a/live/1 \nrtmp://b/live/2');
    expect(duplicateOutputs(outputs)).toEqual(['rtmp://a/live/1']);
    expect(duplicateOutputs(['rtmp://a/live/1', 'rtmp://b/live/2'])).toEqual([]);
  });
});
