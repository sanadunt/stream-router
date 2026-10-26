import { describe, expect, it } from 'vitest';
import { parseStreamViewUrl } from '../../src/shared/url-policy.js';

const policy = { allowedOrigins: [], allowInsecure: false };
const channelId = 'UCSJ4gkVC6NrvII8umztf0Ow';
const playlistId = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';

function viewerUrl(value: string): string {
  return parseStreamViewUrl(value, 'YOUTUBE', policy).viewerUrl;
}

describe('Stream View YouTube: embed live channel dan playlist', () => {
  it('mempertahankan parameter channel untuk embed live_stream', () => {
    expect(viewerUrl(`https://www.youtube.com/embed/live_stream?channel=${channelId}`))
      .toBe(`https://www.youtube-nocookie.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1`);
  });

  it('memetakan URL live channel ke embed live_stream', () => {
    expect(viewerUrl(`https://www.youtube.com/channel/${channelId}/live`))
      .toBe(`https://www.youtube-nocookie.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1`);
  });

  it('mempertahankan parameter list untuk embed videoseries', () => {
    expect(viewerUrl(`https://www.youtube.com/embed/videoseries?list=${playlistId}`))
      .toBe(`https://www.youtube-nocookie.com/embed/videoseries?list=${playlistId}&autoplay=1&mute=1`);
  });

  it.each([
    ['https://www.youtube.com/embed/live_stream', /channel/],
    ['https://www.youtube.com/embed/live_stream?channel=bukan-channel', /channel/],
    ['https://www.youtube.com/channel/UCpendek/live', /channel/],
    ['https://www.youtube.com/embed/videoseries', /list/],
    ['https://www.youtube.com/embed/videoseries?list=<script>', /list/]
  ])('menolak %s tanpa parameter yang valid', (value, message) => {
    expect(() => viewerUrl(value)).toThrow(message);
  });

  it('tetap menormalisasi video biasa tanpa parameter tambahan', () => {
    expect(viewerUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1');
    expect(viewerUrl('https://youtu.be/dQw4w9WgXcQ'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1');
  });
});
