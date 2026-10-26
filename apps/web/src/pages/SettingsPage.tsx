import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { compareSortValues, SortableHeader, type SortDirection } from '../components/SortableHeader';
import { useModalFocus } from '../hooks/useModalFocus';
import { OnvifDiscoveryPanel } from '../components/OnvifDiscoveryPanel';
import {
  generalSettingsBody,
  mergeAppliedMediaMtx,
  mergeSavedGeneralSettings,
  mergeValidatedRecordingPath,
  type EditableSettings
} from './settings-merge';
import {
  brokerPasswordRequired,
  fetchFullHealthReport,
  mediaApplyWarning,
  type HealthReport,
  type MediaApplyResult
} from './settings-status';
import type {
  MediaMtxSettings,
  MqttBrokerProfile,
  StorageDirectoryListing,
  StorageValidation,
  StreamRoute
} from '../types';

type Settings = EditableSettings;

type LightStatus = 'green' | 'orange' | 'red';
type PasswordRole = 'admin' | 'operator';

function HealthLight({ status, title, detail }: { status: LightStatus; title: string; detail: string }) {
  const label = status === 'green' ? 'Normal' : status === 'orange' ? 'Perhatian' : 'Error';
  return <article className={`health-card health-${status}`}>
    <div className="health-card-heading"><span className="health-light" aria-label={label} title={label} /><div><b>{title}</b><small>{label}</small></div></div>
    <p>{detail}</p>
  </article>;
}

function AccountSecuritySettings({ onAdminPasswordChanged }: { onAdminPasswordChanged: () => void }) {
  const [role, setRole] = useState<PasswordRole>('admin');
  const [currentAdminPassword, setCurrentAdminPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (newPassword !== confirmation) {
      setError('Konfirmasi password baru tidak sama.');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/auth/passwords/${role}`, {
        method: 'PATCH',
        body: JSON.stringify({ currentAdminPassword, newPassword })
      });
      setCurrentAdminPassword('');
      setNewPassword('');
      setConfirmation('');
      if (role === 'admin') {
        onAdminPasswordChanged();
        return;
      }
      setMessage('Password Operator diperbarui. Seluruh sesi Operator lama sudah dicabut.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel account-security-settings">
    <header className="health-header">
      <div><h2>Keamanan Akun</h2><p>Administrator dapat mengganti password Administrator sendiri maupun Operator tanpa restart service.</p></div>
    </header>
    {message && <div className="alert success">{message}</div>}
    {error && <div className="alert error">{error}</div>}
    <form className="form-grid" onSubmit={submit}>
      <label>Akun yang diubah<select value={role} onChange={(event) => {
        setRole(event.target.value as PasswordRole);
        setMessage('');
        setError('');
      }}>
        <option value="admin">Administrator</option>
        <option value="operator">Operator</option>
      </select></label>
      <label>Password Administrator saat ini<input
        type="password"
        autoComplete="current-password"
        value={currentAdminPassword}
        onChange={(event) => setCurrentAdminPassword(event.target.value)}
        required
      /></label>
      <label>Password baru<input
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
        required
      /><small>Minimal 8 karakter. Gunakan password unik yang tidak dipakai pada layanan lain.</small></label>
      <label>Ulangi password baru<input
        type="password"
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        required
      /></label>
      <div className="masked-info full">
        <b>Perubahan langsung aktif</b>
        <small>Password disimpan sebagai hash bcrypt di database. `.env` tetap menjadi credential bootstrap awal dan proses Camera Integration tidak direstart.</small>
      </div>
      <div className="form-actions full"><button className="primary" disabled={busy}>{busy ? 'Menerapkan…' : `Ganti Password ${role === 'admin' ? 'Administrator' : 'Operator'}`}</button></div>
    </form>
  </section>;
}

interface BrokerForm {
  name: string;
  description: string;
  protocol: MqttBrokerProfile['protocol'];
  host: string;
  port: number;
  rootTopic: string;
  username: string;
  password: string;
}

const emptyBrokerForm = (): BrokerForm => ({
  name: '',
  description: '',
  protocol: 'mqtt',
  host: '',
  port: 1883,
  rootTopic: 'Turjawali',
  username: '',
  password: ''
});

type BrokerSortKey = 'name' | 'endpoint' | 'credential' | 'status';

function brokerSortValue(broker: MqttBrokerProfile, key: BrokerSortKey): string {
  switch (key) {
    case 'name': return `${broker.name} ${broker.description}`;
    case 'endpoint': return `${broker.protocol} ${broker.host} ${broker.port} ${broker.rootTopic}`;
    case 'credential': return `${broker.username} ${broker.passwordConfigured}`;
    case 'status': return broker.connection.state;
  }
}

function MqttBrokerSettings() {
  const [brokers, setBrokers] = useState<MqttBrokerProfile[]>([]);
  const [editing, setEditing] = useState<MqttBrokerProfile | null>(null);
  const [form, setForm] = useState<BrokerForm>(emptyBrokerForm);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sort, setSort] = useState<{ key: BrokerSortKey; direction: SortDirection }>({ key: 'name', direction: 'asc' });

  const load = useCallback(async () => {
    try {
      setBrokers((await api<{ items: MqttBrokerProfile[] }>('/api/mqtt-brokers')).items);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const closeEditor = useCallback(() => setOpen(false), []);

  function showEditor(broker?: MqttBrokerProfile) {
    setEditing(broker ?? null);
    setForm(broker ? {
      name: broker.name,
      description: broker.description,
      protocol: broker.protocol,
      host: broker.host,
      port: broker.port,
      rootTopic: broker.rootTopic,
      username: broker.username,
      password: ''
    } : emptyBrokerForm());
    setMessage('');
    setError('');
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError('');
    try {
      await api(editing ? `/api/mqtt-brokers/${editing.id}` : '/api/mqtt-brokers', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...form,
          ...(form.password ? { password: form.password } : editing ? {} : { password: '' })
        })
      });
      closeEditor();
      setMessage('Profil broker tersimpan.');
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function test(broker: MqttBrokerProfile) {
    setBusy(`test:${broker.id}`);
    setError('');
    try {
      await api(`/api/mqtt-brokers/${broker.id}/test`, { method: 'POST' });
      setMessage(`Broker ${broker.name} berhasil terhubung.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
      await load();
    }
  }

  async function remove(broker: MqttBrokerProfile) {
    if (!confirm(`Hapus profil broker "${broker.name}" dan seluruh assignment route terkait?`)) return;
    setBusy(`delete:${broker.id}`);
    try {
      await api(`/api/mqtt-brokers/${broker.id}`, { method: 'DELETE' });
      setMessage('Profil broker dan assignment terkait dihapus.');
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  const dialogRef = useModalFocus<HTMLElement>(open, closeEditor);
  const passwordRequired = brokerPasswordRequired(editing, form);
  const sortedBrokers = useMemo(() => [...brokers].sort((left, right) => {
    const result = compareSortValues(brokerSortValue(left, sort.key), brokerSortValue(right, sort.key));
    return sort.direction === 'asc' ? result : -result;
  }), [brokers, sort]);
  function changeSort(key: BrokerSortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  }
  const sortableHeader = (key: BrokerSortKey, label: string) => <SortableHeader
    label={label}
    active={sort.key === key}
    direction={sort.direction}
    onSort={() => changeSort(key)}
  />;

  return <section className="panel mqtt-broker-settings">
    <header className="health-header">
      <div><h2>MQTT Broker</h2><p>Profil broker digunakan bersama oleh MQTT→ONVIF Bridge agar satu broker tidak membuka koneksi per kamera.</p></div>
      <div className="actions"><button onClick={() => void load()}>Refresh</button><button className="primary" onClick={() => showEditor()}>+ Tambah Broker</button></div>
    </header>
    {message && <div className="alert success">{message}</div>}
    {error && <div className="alert error">{error}</div>}
    <div className="table-wrap"><table>
      <thead><tr>
        {sortableHeader('name', 'Profil')}
        {sortableHeader('endpoint', 'Endpoint')}
        {sortableHeader('credential', 'Credential')}
        {sortableHeader('status', 'Status')}
        <th>Aksi</th>
      </tr></thead>
      <tbody>
        {sortedBrokers.map((broker) => <tr key={broker.id}>
          <td><b>{broker.name}</b><small>{broker.description || 'Tanpa deskripsi'}</small></td>
          <td><code>{broker.protocol}://{broker.host}:{broker.port}</code><small>Root: {broker.rootTopic}</small></td>
          <td>{broker.username || 'Tanpa username'}<small>{broker.passwordConfigured ? 'Password tersimpan' : 'Tanpa password'}</small></td>
          <td><span className={`ptz-connection ptz-connection-${broker.connection.state.toLowerCase()}`}><span className="ptz-connection-light" /><span><b>{broker.connection.state}</b><small>{broker.connection.message}</small></span></span></td>
          <td><div className="actions">
            <button onClick={() => void test(broker)} disabled={Boolean(busy)}>{busy === `test:${broker.id}` ? 'Menguji…' : 'Tes'}</button>
            <button onClick={() => showEditor(broker)}>Edit</button>
            <button className="danger" onClick={() => void remove(broker)} disabled={Boolean(busy)}>Hapus</button>
          </div></td>
        </tr>)}
        {!brokers.length && <tr><td colSpan={5} className="empty">Belum ada profil broker MQTT.</td></tr>}
      </tbody>
    </table></div>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
      <section ref={dialogRef} className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="mqtt-broker-title" tabIndex={-1}>
        <header className="modal-header"><div><h2 id="mqtt-broker-title">{editing ? 'Edit Broker MQTT' : 'Tambah Broker MQTT'}</h2><p>Gunakan profil bernama seperti Lokal, Online, atau Backup.</p></div><button className="icon-button" aria-label="Tutup" onClick={closeEditor}>×</button></header>
        <form className="form-grid" onSubmit={save}>
          <label>Nama profil<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required placeholder="MQTT Online" /></label>
          <label>Protocol<select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as BrokerForm['protocol'] })}><option value="mqtt">MQTT</option><option value="mqtts">MQTT + TLS</option><option value="ws">WebSocket</option><option value="wss">WebSocket + TLS</option></select></label>
          <label className="full">Deskripsi<textarea rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Broker cloud untuk kontrol kamera dari luar jaringan" /></label>
          <label>Host / IP<input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} required placeholder="mqtt.example.com" /></label>
          <label>Port<input type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} required /></label>
          <label>Root topic<input value={form.rootTopic} onChange={(event) => setForm({ ...form, rootTopic: event.target.value })} required placeholder="Turjawali" /><small>Camera: {form.rootTopic || 'root'}/id-camera · List: {form.rootTopic || 'root'}/camera-status</small></label>
          <label>Username<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="off" /></label>
          <label className="full">Password<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete="new-password" required={passwordRequired} placeholder={passwordRequired ? 'Wajib diisi ulang karena endpoint berubah' : editing?.passwordConfigured ? 'Tersimpan — kosongkan untuk mempertahankan' : 'Opsional'} />{passwordRequired && <small>Password tersimpan tidak dikirim ke protocol, host, atau port baru tanpa diketik ulang.</small>}</label>
          <div className="form-actions full"><button type="button" onClick={closeEditor}>Batal</button><button className="primary" disabled={busy === 'save'}>{busy === 'save' ? 'Menyimpan…' : 'Simpan Broker'}</button></div>
        </form>
      </section>
    </div>}
  </section>;
}

function editableMediaMtx(settings: Settings['mediaMtx']) {
  return {
    enabled: settings.enabled,
    // Hanya nilai yang diisi Admin; host efektif (fallback HOST_LAN_IP) tidak dikirim balik.
    publicHost: settings.publicHostConfigured,
    recordingPath: settings.recordingPath,
    rtspPort: settings.rtspPort,
    rtmpPort: settings.rtmpPort,
    hlsPort: settings.hlsPort,
    webrtcPort: settings.webrtcPort,
    webrtcUdpPort: settings.webrtcUdpPort,
    srtPort: settings.srtPort,
    playbackPort: settings.playbackPort,
    apiPort: settings.apiPort,
    metricsPort: settings.metricsPort,
    retentionMode: settings.retentionMode,
    retentionDays: settings.retentionDays,
    retentionMaxGb: settings.retentionMaxGb,
    minFreePercent: settings.minFreePercent,
    minFreeGb: settings.minFreeGb,
    segmentDurationSeconds: settings.segmentDurationSeconds
  };
}

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function StorageDirectoryBrowser({
  initialPath,
  onClose,
  onSelect
}: {
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<StorageDirectoryListing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);

  const browse = useCallback(async (target?: string) => {
    setBusy(true);
    setError('');
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : '';
      setListing(await api<StorageDirectoryListing>(`/api/settings/storage/directories${query}`));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void browse(initialPath).catch(() => undefined);
  }, [browse, initialPath]);

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialogRef} className="modal-panel storage-browser-modal" role="dialog" aria-modal="true" aria-labelledby="storage-browser-title" tabIndex={-1}>
      <header className="modal-header">
        <div><h2 id="storage-browser-title">Pilih Folder Recording</h2><p>Browser ini hanya menampilkan folder pada filesystem server.</p></div>
        <button className="icon-button" aria-label="Tutup" onClick={onClose}>×</button>
      </header>
      {error && <div className="alert error">{error}</div>}
      <div className="storage-browser-path">
        <button onClick={() => listing?.parent && void browse(listing.parent)} disabled={!listing?.parent || busy}>← Parent</button>
        <code>{listing?.current ?? initialPath}</code>
      </div>
      {listing && <div className="storage-browser-capacity">
        <span>{listing.writable ? 'Writable' : 'Read-only'}</span>
        <span>{formatBytes(listing.freeBytes)} free dari {formatBytes(listing.totalBytes)}</span>
      </div>}
      <div className="storage-directory-list">
        {busy && <p className="empty">Membaca folder…</p>}
        {!busy && listing?.entries.map((entry) => <button key={entry.path} onClick={() => void browse(entry.path)}>
          <span>▸ {entry.name}</span><small>{entry.writable ? 'Writable' : 'Read-only'}</small>
        </button>)}
        {!busy && listing && !listing.entries.length && <p className="empty">Tidak ada subfolder.</p>}
      </div>
      <div className="form-actions">
        <button onClick={onClose}>Batal</button>
        <button className="primary" disabled={!listing?.writable} onClick={() => listing && onSelect(listing.current)}>Pilih Folder Ini</button>
      </div>
    </section>
  </div>;
}

export function SettingsPage({
  onOpenRoute,
  onAdminPasswordChanged
}: {
  onOpenRoute: (id: string) => void;
  onAdminPasswordChanged: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsLoadError, setSettingsLoadError] = useState('');
  const [health, setHealth] = useState<HealthReport | null>(null);
  // Error health terpisah: polling health 10 detik tidak boleh menghapus error aksi lain.
  const [healthError, setHealthError] = useState('');
  const [message, setMessage] = useState('');
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [mediaBusy, setMediaBusy] = useState('');
  const [originalRecordingPath, setOriginalRecordingPath] = useState('');
  const [storageBrowserOpen, setStorageBrowserOpen] = useState(false);
  const [storageValidation, setStorageValidation] = useState<StorageValidation | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await fetchFullHealthReport());
      setHealthError('');
    } catch (reason) {
      setHealth(null);
      setHealthError(`Health check gagal: ${(reason as Error).message}`);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoadError('');
    try {
      const value = await api<Settings>('/api/settings');
      setSettings(value);
      setOriginalRecordingPath(value.mediaMtx.recordingPath);
    } catch (reason) {
      setSettingsLoadError(`Settings gagal dimuat: ${(reason as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 10000);
    return () => window.clearInterval(timer);
  }, [loadHealth, loadSettings]);

  function startAction() {
    setMessage('');
    setWarning('');
    setError('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    startAction();
    try {
      const updated = await api<Settings>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(generalSettingsBody(settings))
      });
      setSettings((current) => mergeSavedGeneralSettings(current, updated));
      setMessage('Settings tersimpan.');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function mediaAction(action: 'test' | 'apply') {
    if (!settings) return;
    setMediaBusy(action);
    startAction();
    try {
      if (action === 'apply') {
        const pathChanged = settings.mediaMtx.recordingPath !== originalRecordingPath;
        if (pathChanged && !window.confirm(
          'Ganti folder recording?\n\nHanya recording baru yang memakai folder baru. File lama tidak dipindahkan, metadata tetap berada di database pusat, dan playback lama hanya berfungsi selama volume lama masih terpasang.'
        )) return;
        const mediaMtx = editableMediaMtx(settings.mediaMtx);
        const applied = await api<MediaApplyResult>('/api/settings/mediamtx/apply', {
          method: 'POST',
          body: JSON.stringify(mediaMtx)
        });
        const refreshed = await api<Settings>('/api/settings');
        setSettings((current) => mergeAppliedMediaMtx(current, refreshed));
        setOriginalRecordingPath(refreshed.mediaMtx.recordingPath);
        setStorageValidation(null);
        const routeNames = new Map<string, string>();
        if (Array.isArray(applied?.failedRouteIds) && applied.failedRouteIds.length) {
          // Nama route hanya pelengkap pesan; daftar route yang gagal dimuat cukup menampilkan ID.
          const routes = await api<{ items: StreamRoute[] }>('/api/routes').catch(() => ({ items: [] }));
          for (const route of routes.items) routeNames.set(route.id, route.name);
        }
        const applyWarning = mediaApplyWarning(applied, routeNames);
        if (applyWarning) setWarning(applyWarning);
        else setMessage('Konfigurasi MediaMTX diterapkan.');
      } else {
        await api('/api/settings/mediamtx/test', { method: 'POST' });
        setMessage('Koneksi MediaMTX berhasil diuji.');
      }
      await loadHealth();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setMediaBusy('');
    }
  }

  async function validateStorage() {
    if (!settings) return;
    const requestedPath = settings.mediaMtx.recordingPath;
    setMediaBusy('storage');
    startAction();
    try {
      const result = await api<StorageValidation>('/api/settings/storage/validate', {
        method: 'POST',
        body: JSON.stringify({
          path: requestedPath,
          minFreePercent: settings.mediaMtx.minFreePercent,
          minFreeGb: settings.mediaMtx.minFreeGb
        })
      });
      setStorageValidation(result);
      setSettings((current) => mergeValidatedRecordingPath(current, requestedPath, result.path));
      setMessage(result.ok ? 'Folder recording valid dan memenuhi batas storage.' : 'Folder dapat dibaca, tetapi belum memenuhi batas storage.');
    } catch (reason) {
      setStorageValidation(null);
      setError((reason as Error).message);
    } finally {
      setMediaBusy('');
    }
  }

  if (!settings) {
    return settingsLoadError
      ? <div className="alert error">{settingsLoadError} <button onClick={() => void loadSettings()}>Coba lagi</button></div>
      : <p>Memuat…</p>;
  }

  const memoryMb = Math.round((health?.process?.memory?.rss ?? 0) / 1024 / 1024);
  return <>
    <header className="page-header"><div><h1>Settings</h1><p>Pengaturan umum control plane.</p></div></header>
    {message && <div className="alert success">{message}</div>}
    {warning && <div className="alert warning">{warning}</div>}
    {error && <div className="alert error">{error}</div>}
    <form className="panel form-grid" onSubmit={submit}>
      <label>Nama aplikasi<input value={settings.appName} onChange={(event) => setSettings({ ...settings, appName: event.target.value })} /></label>
      <label>Maksimum worker<input type="number" min="1" max="100" value={settings.maxWorkers} onChange={(event) => setSettings({ ...settings, maxWorkers: Number(event.target.value) })} /></label>
      <label>Retensi log (hari)<input type="number" min="1" max="365" value={settings.logRetentionDays} onChange={(event) => setSettings({ ...settings, logRetentionDays: Number(event.target.value) })} /></label>
      <label>Graceful stop timeout (ms)<input type="number" min="1000" max="120000" value={settings.gracefulShutdownTimeoutMs} onChange={(event) => setSettings({ ...settings, gracefulShutdownTimeoutMs: Number(event.target.value) })} /></label>
      <label className="full">FFmpeg binary<input value={settings.ffmpegPath} onChange={(event) => setSettings({ ...settings, ffmpegPath: event.target.value })} required placeholder="/usr/bin/ffmpeg atau ffmpeg" /></label>
      <div className="form-actions full"><button className="primary">Simpan</button></div>
    </form>
    <AccountSecuritySettings onAdminPasswordChanged={onAdminPasswordChanged} />
    <section className="panel mediamtx-settings">
      <header className="health-header"><div><h2>MediaMTX & Recording</h2><p>Konfigurasi listener lokal, WebRTC, playback, dan batas aman storage.</p></div><div className="actions"><button onClick={() => void mediaAction('test')} disabled={Boolean(mediaBusy)}>{mediaBusy === 'test' ? 'Menguji…' : 'Tes Koneksi'}</button><button className="primary" onClick={() => void mediaAction('apply')} disabled={Boolean(mediaBusy)}>{mediaBusy === 'apply' ? 'Menerapkan…' : 'Terapkan & Reload'}</button></div></header>
      <div className="form-grid">
        <label className="check full"><input type="checkbox" checked={settings.mediaMtx.enabled} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, enabled: event.target.checked } })} /> Aktifkan MediaMTX</label>
        <label>Public host/IP<input value={settings.mediaMtx.publicHostConfigured} placeholder={`Otomatis: ${settings.mediaMtx.publicHostDefault}`} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, publicHostConfigured: event.target.value } })} /><small>Alamat IP/DNS server yang dapat dijangkau Viewer untuk WebRTC. Kosongkan agar mengikuti MEDIAMTX_PUBLIC_HOST (HOST_LAN_IP di Docker) atau deteksi otomatis IP LAN; nilai yang sama dengan nilai otomatis tidak disimpan. Dipakai sekarang: {settings.mediaMtx.publicHost}.</small></label>
        <label>Versi<input value={settings.mediaMtx.version} readOnly /></label>
        <label className="full">Folder recording
          <div className="input-actions">
            <input value={settings.mediaMtx.recordingPath} onChange={(event) => {
              setStorageValidation(null);
              setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, recordingPath: event.target.value } });
            }} />
            <button type="button" onClick={() => setStorageBrowserOpen(true)}>Browse</button>
            <button type="button" onClick={() => void validateStorage()} disabled={Boolean(mediaBusy)}>{mediaBusy === 'storage' ? 'Validasi…' : 'Validasi'}</button>
          </div>
          <small>Path akan disimpan sebagai absolute canonical path setelah tervalidasi.</small>
        </label>
        {storageValidation && <div className={`storage-validation full ${storageValidation.ok ? 'valid' : 'invalid'}`}>
          <b>{storageValidation.ok ? 'Folder siap digunakan' : 'Folder belum aman'}</b>
          <span>{formatBytes(storageValidation.freeBytes)} free · minimum {formatBytes(storageValidation.thresholdBytes)} · {storageValidation.writable ? 'writable' : 'read-only'}</span>
          {storageValidation.error && <small>{storageValidation.error}</small>}
        </div>}
        {settings.mediaMtx.recordingPath !== originalRecordingPath && <div className="alert warning full">
          <b>Lokasi recording akan berubah.</b> File lama tidak dipindahkan. Metadata tetap tersimpan di database pusat, tetapi playback arsip lama membutuhkan volume sebelumnya tetap mounted.
        </div>}
        <label className="full">Database SQLite pusat
          <input value={settings.databasePath} readOnly aria-readonly="true" />
          <small>Lokasi database hanya informasi dan tidak dapat dipindahkan melalui GUI.</small>
        </label>
        {([
          ['rtspPort', 'RTSP'], ['rtmpPort', 'RTMP'], ['hlsPort', 'HLS'],
          ['webrtcPort', 'WebRTC HTTP'], ['webrtcUdpPort', 'WebRTC ICE/UDP'],
          ['srtPort', 'SRT'], ['playbackPort', 'Playback'], ['apiPort', 'Control API'], ['metricsPort', 'Metrics']
        ] as const).map(([key, label]) => <label key={key}>{label} port<input type="number" min="1" max="65535" value={settings.mediaMtx[key]} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, [key]: Number(event.target.value) } })} /></label>)}
        <label>Kebijakan retention default<select value={settings.mediaMtx.retentionMode} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, retentionMode: event.target.value as MediaMtxSettings['retentionMode'] } })}>
          <option value="DAYS">Berdasarkan umur (hari)</option>
          <option value="SIZE">Berdasarkan kuota per kamera (GB)</option>
          <option value="DAYS_OR_SIZE">Hari atau GB — yang tercapai dulu</option>
        </select><small>Dipakai oleh route dengan policy “Ikuti Settings”.</small></label>
        {(settings.mediaMtx.retentionMode === 'DAYS' || settings.mediaMtx.retentionMode === 'DAYS_OR_SIZE') && <label>Retensi default (hari)<input type="number" min="1" max="3650" value={settings.mediaMtx.retentionDays} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, retentionDays: Number(event.target.value) } })} /></label>}
        {(settings.mediaMtx.retentionMode === 'SIZE' || settings.mediaMtx.retentionMode === 'DAYS_OR_SIZE') && <label>Kuota default per kamera (GB)<input type="number" min="0.1" max="1000000" step="0.1" value={settings.mediaMtx.retentionMaxGb} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, retentionMaxGb: Number(event.target.value) } })} /></label>}
        <label>Minimum free (%)<input type="number" min="1" max="90" value={settings.mediaMtx.minFreePercent} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, minFreePercent: Number(event.target.value) } })} /></label>
        <label>Minimum free (GB)<input type="number" min="1" value={settings.mediaMtx.minFreeGb} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, minFreeGb: Number(event.target.value) } })} /></label>
        <label>Target durasi file (detik)<input type="number" min="60" max="3600" value={settings.mediaMtx.segmentDurationSeconds} onChange={(event) => setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, segmentDurationSeconds: Number(event.target.value) } })} /><small>60–3600 detik. Default 3600 detik; file dirotasi sekitar 1 jam pada fragment boundary yang aman.</small></label>
      </div>
    </section>
    <OnvifDiscoveryPanel onOpenRoute={onOpenRoute} />
    <section className="panel">
      <header className="health-header"><div><h2>System Health</h2><p>Lampu hijau berarti normal, oranye perlu perhatian, dan merah menunjukkan error.</p></div><button onClick={() => void loadHealth()}>Periksa Sekarang</button></header>
      {healthError && <div className="alert error">{healthError}</div>}
      <div className="health-grid">
        <HealthLight status={health?.ok ? 'green' : 'red'} title="Control Plane" detail={health?.ok ? 'API dan dependency utama merespons normal.' : 'Satu atau beberapa pemeriksaan mengalami kegagalan.'} />
        <HealthLight status={health?.database?.ok ? 'green' : 'red'} title="Database" detail={health?.database?.ok ? 'SQLite terhubung dan query pemeriksaan berhasil.' : health?.database?.error ?? 'Database tidak dapat diperiksa.'} />
        <HealthLight status={health?.ffmpeg?.ok ? 'green' : 'red'} title="FFmpeg" detail={health?.ffmpeg?.ok ? health.ffmpeg.version ?? 'Binary FFmpeg tersedia.' : health?.ffmpeg?.error ?? 'FFmpeg tidak dapat dijalankan.'} />
        <HealthLight status={!health?.mediaMtx ? 'red' : !health.mediaMtx.enabled ? 'orange' : health.mediaMtx.ok ? 'green' : 'red'} title="MediaMTX" detail={!health?.mediaMtx ? 'Status MediaMTX tidak tersedia.' : !health.mediaMtx.enabled ? 'MediaMTX dinonaktifkan.' : health.mediaMtx.ok ? `${health.mediaMtx.version ?? 'MediaMTX'} · ${health.mediaMtx.activeRoutes ?? 0} path aktif.` : health.mediaMtx.error ?? 'MediaMTX tidak tersedia.'} />
        <HealthLight status={!health?.workers ? 'red' : health.workers.active > 0 ? 'green' : 'orange'} title="Stream Worker" detail={health?.workers ? `${health.workers.active} worker aktif dari batas ${settings.maxWorkers}.` : 'Status worker tidak tersedia.'} />
        <HealthLight status={health?.process ? 'green' : 'red'} title="Node Process" detail={health?.process ? `Uptime ${health.process.uptimeSeconds} detik · memori RSS ${memoryMb} MB.` : 'Status proses tidak tersedia.'} />
      </div>
      {health && <small className="health-updated">Pemeriksaan terakhir: {new Date(health.timestamp).toLocaleString('id-ID')}</small>}
    </section>
    <MqttBrokerSettings />
    {storageBrowserOpen && <StorageDirectoryBrowser
      initialPath={settings.mediaMtx.recordingPath}
      onClose={() => setStorageBrowserOpen(false)}
      onSelect={(selectedPath) => {
        setSettings({ ...settings, mediaMtx: { ...settings.mediaMtx, recordingPath: selectedPath } });
        setStorageValidation(null);
        setStorageBrowserOpen(false);
      }}
    />}
  </>;
}
