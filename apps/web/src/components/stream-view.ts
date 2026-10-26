import type { StreamViewMode } from '../types';

export const streamViewModeInfo: Record<StreamViewMode, {
  label: string;
  placeholder: string;
  help: string;
}> = {
  IFRAME: {
    label: 'Embed IFRAME',
    placeholder: 'https://media.example.com/embed/camera-1',
    help: 'Halaman embed dari penyedia stream.'
  },
  WHEP: {
    label: 'WHEP eksternal',
    placeholder: 'https://media.example.com/camera-1/whep',
    help: 'Endpoint WHEP tetap dibuka memakai player provider.'
  },
  YOUTUBE: {
    label: 'YouTube',
    placeholder: 'https://www.youtube.com/watch?v=VIDEO_ID',
    help: 'Mendukung watch, youtu.be, live, shorts, dan embed.'
  },
  HLS: {
    label: 'HLS',
    placeholder: 'https://media.example.com/live/camera-1/index.m3u8',
    help: 'Server HLS harus mengizinkan CORS untuk origin aplikasi ini.'
  },
  MJPEG: {
    label: 'MJPEG',
    placeholder: 'http://camera.lan/mjpeg',
    help: 'Gambar multipart MJPEG dimainkan langsung oleh browser.'
  },
  MP4: {
    label: 'MP4',
    placeholder: 'https://media.example.com/archive/camera-1.mp4',
    help: 'URL file MP4 langsung; upload file tidak termasuk.'
  }
};

export function suggestStreamViewMode(value: string): StreamViewMode | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host === 'youtu.be' || host.includes('youtube.com')) return 'YOUTUBE';
    if (path.endsWith('.m3u8')) return 'HLS';
    if (path.endsWith('.mp4')) return 'MP4';
    if (path.endsWith('.mjpg') || path.endsWith('.mjpeg') || /(?:mjpeg|mjpg)/.test(path)) return 'MJPEG';
  } catch {
    return null;
  }
  return null;
}
