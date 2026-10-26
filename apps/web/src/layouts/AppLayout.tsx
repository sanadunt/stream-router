import { useState, type ReactNode } from 'react';
import type { CurrentUser } from '../types';

export function AppLayout({ page, setPage, onLogout, user, children }: {
  page: string;
  setPage: (value: string) => void;
  onLogout: () => void;
  user: CurrentUser;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-copy"><b>Camera Integration</b><small>{user.role} access</small></div>
          <span className="system-online"><i />Online</span>
        </div>
        <button className="sidebar-toggle" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Tampilkan menu' : 'Sembunyikan menu'} title={collapsed ? 'Tampilkan menu' : 'Mode layar penuh'}>{collapsed ? '›' : '‹'}<span className="nav-label">Sembunyikan menu</span></button>
        <nav>
          {user.role !== 'viewer' && <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')} title="Dashboard" aria-label="Dashboard"><span className="nav-icon">⌂</span><span className="nav-label">Dashboard</span></button>}
          {user.role === 'admin' && <button className={page === 'stream-router' ? 'active' : ''} onClick={() => setPage('stream-router')} title="Stream Router" aria-label="Stream Router"><span className="nav-icon">⇄</span><span className="nav-label">Stream Router</span></button>}
          {user.role === 'admin' && <button className={page === 'stream-view' ? 'active' : ''} onClick={() => setPage('stream-view')} title="Stream View" aria-label="Stream View"><span className="nav-icon">▣</span><span className="nav-label">Stream View</span></button>}
          {user.role !== 'viewer' && <button className={page === 'terminal' ? 'active' : ''} onClick={() => setPage('terminal')} title="Terminal" aria-label="Terminal"><span className="nav-icon">›_</span><span className="nav-label">Terminal</span></button>}
          {user.role !== 'viewer' && <button className={page === 'recording' ? 'active' : ''} onClick={() => setPage('recording')} title="Recording" aria-label="Recording"><span className="nav-icon">●</span><span className="nav-label">Recording</span></button>}
          <button className={page === 'viewer' ? 'active' : ''} onClick={() => setPage('viewer')} title="Viewer" aria-label="Viewer"><span className="nav-icon">▶</span><span className="nav-label">Viewer</span></button>
          {user.role === 'admin' && <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')} title="Settings" aria-label="Settings"><span className="nav-icon">⚙</span><span className="nav-label">Settings</span></button>}
        </nav>
        <button className="logout" onClick={onLogout} title="Logout" aria-label="Logout"><span className="nav-icon">↪</span><span className="nav-label">Logout</span></button>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
