import type { InputProtocol, StreamViewMode } from '@stream-router/contracts';
import { AppError } from './errors.js';

export interface ParsedStreamUrl {
  protocol: 'RTSP' | 'RTMP' | 'RTMPS';
  hostname: string;
}

// Error asli `new URL` tidak diteruskan: Node menyimpan URL mentah (termasuk password kamera) di properti
// `input`, dan error handler/pino akan menuliskannya ke log.
function parseStreamUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new AppError(
      'INVALID_STREAM_URL',
      `URL ${label} tidak valid. Karakter khusus pada username/password harus di-encode, mis. # menjadi %23, ? menjadi %3F, / menjadi %2F, @ menjadi %40.`,
      400
    );
  }
}

export function parseInputUrl(value: string): ParsedStreamUrl {
  const url = parseStreamUrl(value, 'input');
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'rtsp:' && protocol !== 'rtmp:') {
    throw new AppError('UNSUPPORTED_STREAM_PROTOCOL', 'Input hanya mendukung RTSP atau RTMP', 400);
  }
  if (!url.hostname) throw new AppError('INVALID_STREAM_URL', 'Hostname input tidak valid', 400);
  return { protocol: protocol === 'rtsp:' ? 'RTSP' : 'RTMP', hostname: url.hostname };
}

export function parseOutputUrl(value: string): ParsedStreamUrl {
  const url = parseStreamUrl(value, 'output');
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'rtmp:' && protocol !== 'rtmps:') {
    throw new AppError('UNSUPPORTED_STREAM_PROTOCOL', 'Output hanya mendukung RTMP atau RTMPS', 400);
  }
  if (!url.hostname) throw new AppError('INVALID_STREAM_URL', 'Hostname output tidak valid', 400);
  return { protocol: protocol === 'rtmps:' ? 'RTMPS' : 'RTMP', hostname: url.hostname };
}

export function detectInputProtocol(value: string): InputProtocol {
  return parseInputUrl(value).protocol as InputProtocol;
}

export function assertSsrfPolicy(value: string, deniedHosts: string[] = []): void {
  const { hostname } = parseStreamUrl(value, 'stream');
  if (deniedHosts.some((item) => item.toLowerCase() === hostname.toLowerCase())) {
    throw new AppError('STREAM_HOST_BLOCKED', 'Host diblokir oleh kebijakan SSRF', 400);
  }
  // Private IP sengaja diizinkan karena kamera lokal adalah use-case utama.
}

export interface WebrtcUrlPolicy {
  allowedOrigins: string[];
  allowInsecure: boolean;
}

export function parseWebrtcUrl(value: string, policy: WebrtcUrlPolicy): URL {
  const invalid = (message: string) => new AppError('INVALID_WEBRTC_URL', message, 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('WebRTC URL tidak valid');
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw invalid('WebRTC URL hanya mendukung http(s)');
  }
  if (protocol === 'http:' && !policy.allowInsecure) {
    throw invalid('WebRTC URL http hanya diizinkan pada mode development');
  }
  if (!url.hostname) throw invalid('Hostname WebRTC URL tidak valid');
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.includes(url.origin)) {
    throw invalid('Origin WebRTC URL tidak ada dalam daftar yang diizinkan');
  }
  return url;
}

export interface ParsedStreamViewUrl {
  sourceUrl: string;
  viewerUrl: string;
}

const YOUTUBE_VIDEO_ID = /^[a-zA-Z0-9_-]{6,20}$/;
const YOUTUBE_CHANNEL_ID = /^UC[\w-]{22}$/;
const YOUTUBE_PLAYLIST_ID = /^[\w-]{10,64}$/;

// `live_stream` dan `videoseries` adalah ID embed khusus yang lolos pola video ID,
// tetapi hanya berfungsi bersama parameter `channel`/`list`; tanpa itu player kosong.
function youtubeEmbedUrl(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let candidate = '';
  let channel = url.searchParams.get('channel') ?? '';
  if (host === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0] ?? '';
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube.com')) {
    const [kind, pathId, suffix] = url.pathname.split('/').filter(Boolean);
    if (kind === 'channel' && suffix === 'live') {
      candidate = 'live_stream';
      channel = pathId ?? '';
    } else {
      candidate = kind === 'watch' ? url.searchParams.get('v') ?? '' : ['live', 'embed', 'shorts'].includes(kind ?? '') ? pathId ?? '' : '';
    }
  }
  const params = new URLSearchParams();
  if (candidate === 'live_stream') {
    if (!YOUTUBE_CHANNEL_ID.test(channel)) {
      throw new Error('Embed YouTube live_stream membutuhkan parameter channel (ID channel UC…) yang valid');
    }
    params.set('channel', channel);
  } else if (candidate === 'videoseries') {
    const list = url.searchParams.get('list') ?? '';
    if (!YOUTUBE_PLAYLIST_ID.test(list)) {
      throw new Error('Embed YouTube videoseries membutuhkan parameter list playlist yang valid');
    }
    params.set('list', list);
  } else if (!YOUTUBE_VIDEO_ID.test(candidate)) {
    throw new Error('URL YouTube harus berupa watch, youtu.be, live, shorts, embed, atau channel/live yang valid');
  }
  params.set('autoplay', '1');
  params.set('mute', '1');
  return `https://www.youtube-nocookie.com/embed/${candidate}?${params.toString()}`;
}

export function parseStreamViewUrl(
  value: string,
  mode: StreamViewMode,
  policy: WebrtcUrlPolicy
): ParsedStreamViewUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL stream tidak valid');
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error('Stream View hanya mendukung URL HTTP atau HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('URL Stream View tidak boleh memuat username atau password');
  }
  if (protocol === 'http:' && !policy.allowInsecure) {
    throw new Error('URL HTTP dinonaktifkan. Aktifkan STREAM_VIEW_ALLOW_INSECURE_HTTP hanya untuk LAN tepercaya');
  }
  if (!url.hostname) throw new Error('Hostname Stream View tidak valid');
  if (policy.allowedOrigins.length > 0 && !policy.allowedOrigins.includes(url.origin)) {
    throw new Error('Origin Stream View tidak ada dalam daftar yang diizinkan');
  }
  const sourceUrl = url.toString();
  if (mode !== 'YOUTUBE') return { sourceUrl, viewerUrl: sourceUrl };
  return { sourceUrl, viewerUrl: youtubeEmbedUrl(url) };
}
