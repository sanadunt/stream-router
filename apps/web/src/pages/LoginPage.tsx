import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { CurrentUser, UserRole } from '../types';

const roleLabels: Record<UserRole, string> = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };

export function LoginPage({ onLogin, notice = '' }: { onLogin: (user: CurrentUser) => void; notice?: string }) {
  const [role, setRole] = useState<UserRole>('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const body = role === 'viewer' ? { role } : { role, password };
      const result = await api<{ user: CurrentUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
      onLogin(result.user);
    } catch (reason) { setError((reason as Error).message); } finally { setLoading(false); }
  }
  return <div className="login-page"><form className="login-card" onSubmit={submit}>
    <div className="login-logo">CI</div><h1>Camera Integration</h1><p>Pilih akses Anda sebelum masuk.</p>
    <div className="role-picker">{(Object.keys(roleLabels) as UserRole[]).map((item) => <button type="button" key={item} className={role === item ? 'active' : ''} onClick={() => {
      setRole(item);
      setError('');
      if (item === 'viewer') setPassword('');
    }}>{roleLabels[item]}</button>)}</div>
    {role === 'viewer'
      ? <p className="viewer-open-access">Akses Viewer terbuka tanpa password.</p>
      : <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>}
    {notice && <div className="alert success">{notice}</div>}
    {error && <div className="alert error">{error}</div>}
    <button className="primary" disabled={loading}>{loading ? 'Memproses…' : `Masuk sebagai ${roleLabels[role]}`}</button>
  </form></div>;
}
