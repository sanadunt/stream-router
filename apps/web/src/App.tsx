import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, onSessionExpired } from './api/client';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { AppLayout } from './layouts/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { RouteDetailPage } from './pages/RouteDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { StreamRouterPage } from './pages/StreamRouterPage';
import { StreamViewPage } from './pages/StreamViewPage';
import { TerminalPage } from './pages/TerminalPage';
import { ViewerPage } from './pages/ViewerPage';
import { RecordingPage } from './pages/RecordingPage';
import { authorizedPage, landingPageForRole, type Page } from './navigation';
import type { CurrentUser } from './types';

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [loginNotice, setLoginNotice] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const signedIn = useRef(false);
  useEffect(() => { signedIn.current = user !== null; }, [user]);
  useEffect(() => onSessionExpired(() => {
    // Respons 401 yang datang setelah logout tidak perlu menimpa layar login.
    if (!signedIn.current) return;
    signedIn.current = false;
    setUser(null);
    setPage('dashboard');
    setLogoutError('');
    setLoginNotice((current) => current || 'Sesi berakhir, silakan masuk kembali.');
  }), []);
  const check = useCallback(async () => {
    try {
      const nextUser = (await api<{ user: CurrentUser }>('/api/auth/me')).user;
      setUser(nextUser);
      setPage((current) => authorizedPage(current, nextUser.role));
    } catch (reason) {
      // Login tetap dapat digunakan saat sesi belum ada, kedaluwarsa, atau API sementara gagal.
      if (!(reason instanceof ApiError) || reason.status !== 401) {
        console.warn('Pemeriksaan sesi awal gagal:', reason);
      }
    }
  }, []);
  useEffect(() => { void check(); }, [check]);
  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (reason) {
      // Cookie sesi hanya dihapus oleh server; jangan tampilkan login seolah sudah keluar.
      setLogoutError(`Logout gagal, sesi masih aktif: ${(reason as Error).message}`);
      return;
    }
    setLogoutError('');
    setUser(null);
    setPage('dashboard');
    setLoginNotice('');
  }
  if (!user) return <LoginPage notice={loginNotice} onLogin={(nextUser) => {
    setUser(nextUser);
    setLoginNotice('');
    setPage(landingPageForRole(nextUser.role));
  }} />;
  const activePage = authorizedPage(page, user.role);
  let content;
  if (activePage === 'viewer') content = <ViewerPage canControlPtz={user.role !== 'viewer'} />;
  else if (activePage === 'dashboard') content = <DashboardPage onOpen={(id) => setPage(`detail:${id}`)} />;
  else if (activePage === 'stream-router' && user.role === 'admin') content = <StreamRouterPage />;
  else if (activePage === 'stream-view' && user.role === 'admin') content = <StreamViewPage />;
  else if (activePage === 'terminal') content = <TerminalPage />;
  else if (activePage === 'recording') content = <RecordingPage canManage={user.role === 'admin'} />;
  else if (activePage === 'settings' && user.role === 'admin') content = <SettingsPage
    onOpenRoute={(id) => setPage(`detail:${id}`)}
    onAdminPasswordChanged={() => {
      setLoginNotice('Password Administrator berhasil diperbarui. Silakan masuk kembali menggunakan password baru.');
      setUser(null);
      setPage('dashboard');
    }}
  />;
  else if (activePage.startsWith('detail:')) content = <RouteDetailPage routeId={activePage.slice(7)} onBack={() => setPage('dashboard')} />;
  else content = <DashboardPage onOpen={(id) => setPage(`detail:${id}`)} />;
  return <AppLayout
    page={activePage}
    setPage={(value) => {
      setLogoutError('');
      setPage(authorizedPage(value as Page, user.role));
    }}
    onLogout={() => void logout()}
    user={user}
  >{logoutError && <div className="alert error" role="alert">{logoutError}</div>}<PageErrorBoundary resetKey={activePage}>{content}</PageErrorBoundary></AppLayout>;
}
