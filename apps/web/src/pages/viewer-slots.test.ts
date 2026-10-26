import { describe, expect, it } from 'vitest';
import { bufferedMediaPercent, recordingOverlayPreferences } from './RecordingPage';
import {
  assignMonitorSlot,
  normalizeLocalViewerRoute,
  parseStoredMonitorSlots,
  parseStoredSourceNames,
  resolveMonitorSlots,
  sourceNamesForSlots
} from './ViewerPage';
import type { ViewerRoute } from '../types';

function media(duration: number, ranges: Array<[number, number]>) {
  return {
    duration,
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index]![0],
      end: (index: number) => ranges[index]![1]
    }
  } as Pick<HTMLMediaElement, 'buffered' | 'duration'>;
}

describe('Viewer monitor slots', () => {
  it('mempertahankan urutan monitor dan sumber yang sementara offline, serta mencegah duplikasi', () => {
    expect(resolveMonitorSlots(
      ['camera-b', 'offline', 'camera-b', 'camera-a'],
      ['camera-a', 'camera-b', 'camera-c'],
      4
    )).toEqual(['camera-b', 'offline', '', 'camera-a', '', '', '', '']);
  });

  it('tidak menghapus pilihan monitor ketika sumber berkedip tidak RUNNING lalu kembali', () => {
    const configured = ['cam-d', 'cam-a', 'cam-c', 'cam-b'];
    const duringBlip = resolveMonitorSlots(configured, ['cam-b', 'cam-c', 'cam-d'], 4);
    expect(duringBlip.slice(0, 4)).toEqual(['cam-d', 'cam-a', 'cam-c', 'cam-b']);
    expect(resolveMonitorSlots(configured, [], 4).slice(0, 4)).toEqual(['cam-d', 'cam-a', 'cam-c', 'cam-b']);
    expect(resolveMonitorSlots(configured, ['cam-a', 'cam-b', 'cam-c', 'cam-d'], 4).slice(0, 4))
      .toEqual(['cam-d', 'cam-a', 'cam-c', 'cam-b']);
  });

  it('mengisi monitor awal dari sumber ready sesuai layout selama belum ada pilihan tersimpan', () => {
    expect(resolveMonitorSlots(null, ['camera-a', 'camera-b', 'camera-c'], 2))
      .toEqual(['camera-a', 'camera-b', '', '', '', '', '', '']);
    // Sumber yang ready satu per satu setelah restart server tetap mengisi semua monitor.
    expect(resolveMonitorSlots(null, ['camera-a'], 4).slice(0, 4)).toEqual(['camera-a', '', '', '']);
    expect(resolveMonitorSlots(null, ['camera-a', 'camera-b', 'camera-c', 'camera-d'], 4).slice(0, 4))
      .toEqual(['camera-a', 'camera-b', 'camera-c', 'camera-d']);
  });

  it('membaca susunan tersimpan dan memperlakukan data kosong atau rusak sebagai belum diatur', () => {
    expect(parseStoredMonitorSlots('["cam-a","","cam-a",42,"cam-b"]'))
      .toEqual(['cam-a', '', '', '', 'cam-b', '', '', '']);
    expect(parseStoredMonitorSlots(null)).toBeNull();
    expect(parseStoredMonitorSlots('["","",""]')).toBeNull();
    expect(parseStoredMonitorSlots('{"cam":"a"}')).toBeNull();
    expect(parseStoredMonitorSlots('invalid-json')).toBeNull();
  });

  it('memindahkan sumber ke monitor yang dipilih tanpa menghapus sumber offline di slot lain', () => {
    expect(assignMonitorSlot(['cam-a', 'offline', 'cam-c'], 2, 'cam-a'))
      .toEqual(['', 'offline', 'cam-a', '', '', '', '', '']);
    expect(assignMonitorSlot(['cam-a', 'offline'], 1, ''))
      .toEqual(['cam-a', '', '', '', '', '', '', '']);
  });

  it('mengingat nama sumber monitor agar label tidak menjadi UUID setelah reload', () => {
    const names = new Map([['cam-a', 'Kamera Lobi'], ['cam-b', 'Kamera Parkir'], ['cam-c', 'Kamera Lain']]);
    const stored = JSON.stringify(sourceNamesForSlots(names, ['cam-a', '', 'cam-b', 'cam-hilang']));
    expect(JSON.parse(stored)).toEqual({ 'cam-a': 'Kamera Lobi', 'cam-b': 'Kamera Parkir' });
    expect(parseStoredSourceNames(stored).get('cam-b')).toBe('Kamera Parkir');
    expect(parseStoredSourceNames('{"cam-a":42,"cam-b":""}').size).toBe(0);
    expect(parseStoredSourceNames('["cam-a"]').size).toBe(0);
    expect(parseStoredSourceNames('invalid-json').size).toBe(0);
    expect(parseStoredSourceNames(null).size).toBe(0);
  });

  it('mengganti URL loopback sumber lokal dengan hostname server yang dibuka browser', () => {
    const local = { url: 'http://127.0.0.1:18889/cameras/camera-1', mode: 'IFRAME' as const };
    const route: ViewerRoute = {
      id: 'camera-1',
      name: 'Camera 1',
      description: '',
      webrtc: local,
      sources: { local, online: null, preferred: 'local' },
      ptz: {
        enabled: false,
        zoomEnabled: false,
        provider: 'NONE',
        targetType: 'ROUTE',
        targetId: 'camera-1',
        connection: { state: 'DISABLED', message: 'PTZ nonaktif', checkedAt: null }
      }
    };
    expect(normalizeLocalViewerRoute(route, '192.168.1.135').webrtc.url)
      .toBe('http://192.168.1.135:18889/cameras/camera-1');
  });
});

describe('Recording player buffer', () => {
  it('menghitung seluruh rentang buffer terhadap durasi media', () => {
    expect(bufferedMediaPercent(media(100, [[0, 20], [50, 65]]))).toBe(35);
  });

  it('membatasi hasil dan menangani metadata yang belum tersedia', () => {
    expect(bufferedMediaPercent(media(Number.NaN, []))).toBe(0);
    expect(bufferedMediaPercent(media(10, [[0, 15]]))).toBe(100);
  });

  it('memuat preferensi overlay secara independen dengan fallback aman', () => {
    expect(recordingOverlayPreferences(null)).toEqual({ info: true, buffer: true });
    expect(recordingOverlayPreferences('{"info":false,"buffer":true}')).toEqual({ info: false, buffer: true });
    expect(recordingOverlayPreferences('{"info":true,"buffer":false}')).toEqual({ info: true, buffer: false });
    expect(recordingOverlayPreferences('invalid-json')).toEqual({ info: true, buffer: true });
  });
});
