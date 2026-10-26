import { describe, expect, it } from 'vitest';
import { routeLifecycle } from './route-lifecycle';

describe('Lifecycle route di Stream Router', () => {
  it('route FAILED yang masih terinisiasi dapat dimatikan dan tetap menawarkan coba lagi', () => {
    const view = routeLifecycle('Kamera Lobi', 'FAILED');
    expect(view.active).toBe(true);
    expect(view.stopping).toBe(false);
    expect(view.startLabel).toBe('Coba lagi');
    expect(view.switchLabel).toContain('Matikan lifecycle route Kamera Lobi');
    expect(view.switchLabel).not.toContain('belum diinisiasi');
  });

  it('route berjalan hanya menampilkan switch aktif', () => {
    for (const status of ['STARTING', 'RUNNING', 'RESTARTING'] as const) {
      expect(routeLifecycle('Kamera', status)).toMatchObject({ active: true, startLabel: null });
    }
  });

  it('route berhenti menawarkan inisiasi dan route yang sedang dihentikan tidak bisa diklik', () => {
    expect(routeLifecycle('Kamera', 'STOPPED')).toMatchObject({ active: false, startLabel: 'Inisiasi', switchLabel: 'Route Kamera belum diinisiasi' });
    expect(routeLifecycle('Kamera', 'STOPPING')).toMatchObject({ active: false, stopping: true, startLabel: 'Menghentikan…' });
  });
});
