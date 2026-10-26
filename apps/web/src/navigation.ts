import type { UserRole } from './types';

export type Page = 'dashboard' | 'stream-router' | 'stream-view' | 'terminal' | 'recording' | 'settings' | 'viewer' | `detail:${string}`;

export function landingPageForRole(role: UserRole): Page {
  return role === 'viewer' ? 'viewer' : 'dashboard';
}

export function authorizedPage(page: Page, role: UserRole): Page {
  if (role === 'viewer') return 'viewer';
  if (role === 'operator' && ['stream-router', 'stream-view', 'settings'].includes(page)) return 'dashboard';
  return page;
}
