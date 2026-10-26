import { describe, expect, it } from 'vitest';
import { streamViewModeInfo, suggestStreamViewMode } from './stream-view';

describe('Stream View URL suggestions', () => {
  it.each([
    ['https://youtu.be/dQw4w9WgXcQ', 'YOUTUBE'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YOUTUBE'],
    ['https://media.example.com/live/camera.m3u8', 'HLS'],
    ['https://camera.example.com/live.mjpeg', 'MJPEG'],
    ['https://media.example.com/archive/camera.mp4', 'MP4']
  ] as const)('menyarankan %s sebagai %s', (url, expected) => {
    expect(suggestStreamViewMode(url)).toBe(expected);
  });

  it('tidak mengubah tipe saat URL tidak memberi sinyal yang jelas', () => {
    expect(suggestStreamViewMode('https://media.example.com/player/camera')).toBeNull();
    expect(suggestStreamViewMode('bukan-url')).toBeNull();
  });

  it('menyediakan label dan bantuan untuk seluruh renderer', () => {
    expect(Object.keys(streamViewModeInfo)).toEqual(['IFRAME', 'WHEP', 'YOUTUBE', 'HLS', 'MJPEG', 'MP4']);
  });
});
