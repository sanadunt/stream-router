import { describe, expect, it } from 'vitest';
import { authorizedPage, landingPageForRole } from './navigation';

describe('role navigation guard', () => {
  it('mengarahkan session Viewer yang dipulihkan langsung ke Viewer', () => {
    expect(landingPageForRole('viewer')).toBe('viewer');
    expect(authorizedPage('dashboard', 'viewer')).toBe('viewer');
    expect(authorizedPage('detail:camera-1', 'viewer')).toBe('viewer');
  });

  it('mencegah Operator membuka halaman konfigurasi Admin', () => {
    expect(authorizedPage('stream-router', 'operator')).toBe('dashboard');
    expect(authorizedPage('stream-view', 'operator')).toBe('dashboard');
    expect(authorizedPage('settings', 'operator')).toBe('dashboard');
    expect(authorizedPage('recording', 'operator')).toBe('recording');
  });

  it('mempertahankan seluruh halaman untuk Admin', () => {
    expect(authorizedPage('settings', 'admin')).toBe('settings');
    expect(authorizedPage('stream-view', 'admin')).toBe('stream-view');
  });
});
