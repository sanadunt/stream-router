import type { RouteStatus } from '../types';

export interface RouteLifecycleView {
  /** Route masih terinisiasi di server: switch ON dan dapat dimatikan (deinitialize). */
  active: boolean;
  stopping: boolean;
  /** Teks tombol inisiasi; null bila tombol tidak ditampilkan. */
  startLabel: 'Inisiasi' | 'Coba lagi' | 'Menghentikan…' | null;
  switchLabel: string;
}

/**
 * Snapshot worker hanya melaporkan FAILED untuk route yang masih aktif (ingest MediaMTX,
 * WebRTC lokal, dan recording dapat tetap berjalan), sehingga FAILED harus tetap bisa
 * dimatikan dari Stream Router. "Coba lagi" memakai /initialize yang mempertahankan media
 * yang sudah READY, berbeda dengan /restart yang melepas path lebih dulu.
 */
export function routeLifecycle(name: string, status: RouteStatus): RouteLifecycleView {
  switch (status) {
    case 'STARTING':
    case 'RUNNING':
    case 'RESTARTING':
      return { active: true, stopping: false, startLabel: null, switchLabel: `Matikan lifecycle route ${name}` };
    case 'FAILED':
      return {
        active: true,
        stopping: false,
        startLabel: 'Coba lagi',
        switchLabel: `Matikan lifecycle route ${name} (gagal, ingest dan recording dapat masih berjalan)`
      };
    case 'STOPPING':
      return { active: false, stopping: true, startLabel: 'Menghentikan…', switchLabel: `Route ${name} sedang dihentikan` };
    default:
      return { active: false, stopping: false, startLabel: 'Inisiasi', switchLabel: `Route ${name} belum diinisiasi` };
  }
}
