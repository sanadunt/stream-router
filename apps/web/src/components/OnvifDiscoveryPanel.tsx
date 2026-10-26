import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { useModalFocus } from '../hooks/useModalFocus';
import type {
  OnvifDiscoveredDevice,
  OnvifDiscoveryTarget,
  OnvifInspection,
  OnvifInspectionProfile,
  OnvifNetworkInterface
} from '../types';

interface Credentials {
  username: string;
  password: string;
}

type RtspCredentialMode = 'same' | 'none' | 'separate';

interface RouteDraft {
  name: string;
  cameraKey: string;
  description: string;
  autoStart: boolean;
  localViewEnabled: boolean;
  localAudioMode: 'COPY' | 'OPUS';
  recordingEnabled: boolean;
  onlineRelayEnabled: boolean;
  outputs: string;
  ffmpegMode: 'COPY' | 'TRANSCODE';
  onlineAudioMode: 'COPY' | 'AAC' | 'OPUS';
  ptzEnabled: boolean;
  zoomEnabled: boolean;
  ptzProfileToken: string;
}

const defaultTarget = (): OnvifDiscoveryTarget => ({
  host: '',
  port: 80,
  path: '/onvif/device_service',
  useTls: false
});

const defaultRouteDraft = (): RouteDraft => ({
  name: '',
  cameraKey: '',
  description: '',
  autoStart: false,
  localViewEnabled: true,
  localAudioMode: 'COPY',
  recordingEnabled: false,
  onlineRelayEnabled: false,
  outputs: '',
  ffmpegMode: 'COPY',
  onlineAudioMode: 'COPY',
  ptzEnabled: true,
  zoomEnabled: false,
  ptzProfileToken: ''
});

function endpointLabel(target: OnvifDiscoveryTarget): string {
  return `${target.useTls ? 'https' : 'http'}://${target.host}:${target.port}${target.path}`;
}

function requestTarget(target: OnvifDiscoveryTarget): OnvifDiscoveryTarget {
  return {
    host: target.host,
    port: target.port,
    path: target.path,
    useTls: target.useTls,
    ...(target.urn ? { urn: target.urn } : {})
  };
}

function profileLabel(profile: OnvifInspectionProfile): string {
  const resolution = profile.width && profile.height ? `${profile.width}×${profile.height}` : 'resolusi tidak dilaporkan';
  return `${profile.encoding} · ${resolution}`;
}

function OnvifImportWizard({
  target,
  onClose,
  onImported,
  onOpenRoute
}: {
  target: OnvifDiscoveryTarget;
  onClose: () => void;
  onImported: (result: { id: string; name: string; cameraKey: string }) => void;
  onOpenRoute: (id: string) => void;
}) {
  const [step, setStep] = useState<'credentials' | 'profile' | 'review'>('credentials');
  const [credentials, setCredentials] = useState<Credentials>({ username: '', password: '' });
  const [rtspCredentialMode, setRtspCredentialMode] = useState<RtspCredentialMode>('same');
  const [rtspCredentials, setRtspCredentials] = useState<Credentials>({ username: '', password: '' });
  const [inspection, setInspection] = useState<OnvifInspection | null>(null);
  const [profileToken, setProfileToken] = useState('');
  const [draft, setDraft] = useState<RouteDraft>(defaultRouteDraft);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);

  const selectedProfile = useMemo(
    () => inspection?.profiles.find((profile) => profile.token === profileToken) ?? null,
    [inspection, profileToken]
  );

  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy('inspect');
    setError('');
    try {
      const result = await api<OnvifInspection>('/api/settings/onvif-discovery/inspect', {
        method: 'POST',
        body: JSON.stringify({ target: requestTarget(target), credentials })
      });
      const preferred = result.profiles.find((profile) => profile.streamAvailable && profile.ptz)
        ?? result.profiles.find((profile) => profile.streamAvailable)
        ?? result.profiles[0];
      setInspection(result);
      setProfileToken(preferred?.token ?? '');
      setDraft({
        ...defaultRouteDraft(),
        name: result.suggestedName,
        cameraKey: result.suggestedCameraKey,
        description: [result.device.manufacturer, result.device.model, target.host].filter(Boolean).join(' · '),
        ptzEnabled: Boolean(preferred?.ptz),
        zoomEnabled: Boolean(preferred?.zoom),
        ptzProfileToken: preferred?.token ?? ''
      });
      setStep('profile');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  function continueToReview() {
    if (!selectedProfile?.streamAvailable) {
      setError('Pilih Media Profile yang menyediakan RTSP URI.');
      return;
    }
    setDraft((current) => ({
      ...current,
      ptzEnabled: selectedProfile.ptz,
      zoomEnabled: selectedProfile.zoom,
      ptzProfileToken: selectedProfile.token
    }));
    setError('');
    setStep('review');
  }

  async function importRoute(event: FormEvent) {
    event.preventDefault();
    if (!inspection || !selectedProfile) return;
    const outputs = draft.outputs.split('\n').map((item) => item.trim()).filter(Boolean);
    if (draft.onlineRelayEnabled && !outputs.length) {
      setError('Minimal satu output wajib diisi ketika Relay Online aktif.');
      return;
    }
    setBusy('import');
    setError('');
    try {
      const result = await api<{ route: { id: string; name: string; cameraKey: string } }>('/api/settings/onvif-discovery/import', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: inspection.sessionId,
          profileToken,
          ptzProfileToken: draft.ptzProfileToken,
          ...(rtspCredentialMode === 'none'
            ? { rtspCredentials: { username: '', password: '' } }
            : rtspCredentialMode === 'separate'
              ? { rtspCredentials }
              : {}),
          ptzEnabled: draft.ptzEnabled,
          zoomEnabled: draft.zoomEnabled,
          route: {
            cameraKey: draft.cameraKey,
            name: draft.name,
            description: draft.description,
            outputs,
            enabled: true,
            autoStart: draft.autoStart,
            localViewEnabled: draft.localViewEnabled,
            localAudioMode: draft.localAudioMode,
            onlineRelayEnabled: draft.onlineRelayEnabled,
            onlineAudioMode: draft.onlineAudioMode,
            recordingEnabled: draft.recordingEnabled,
            recordingRetentionMode: 'INHERIT',
            recordingRetentionDays: null,
            recordingRetentionGb: null,
            ffmpegMode: draft.ffmpegMode,
            ffmpegOptions: { videoBitrateKbps: 2500, audioBitrateKbps: 128, preset: 'veryfast', gop: 50 },
            retryPolicy: { initialDelayMs: 2000, maxDelayMs: 60000, maxRetries: 10, jitterRatio: 0.2, stableResetMs: 60000 },
            webrtc: { enabled: false, mode: 'IFRAME' }
          }
        })
      });
      onImported(result.route);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }

  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section ref={dialogRef} className="modal-panel modal-large onvif-wizard" role="dialog" aria-modal="true" aria-labelledby="onvif-wizard-title" tabIndex={-1}>
      <header className="modal-header">
        <div>
          <h2 id="onvif-wizard-title">Tambah Kamera ONVIF</h2>
          <p>{endpointLabel(target)}</p>
        </div>
        <button className="icon-button" type="button" aria-label="Tutup wizard ONVIF" onClick={onClose} disabled={Boolean(busy)}>×</button>
      </header>
      <ol className="onvif-wizard-steps" aria-label="Tahapan wizard">
        <li className={step === 'credentials' ? 'active' : ''}>1. Credential</li>
        <li className={step === 'profile' ? 'active' : ''}>2. Media Profile</li>
        <li className={step === 'review' ? 'active' : ''}>3. Review Route</li>
      </ol>
      {error && <div className="alert error">{error}</div>}

      {step === 'credentials' && <form className="form-grid" onSubmit={inspect}>
        <div className="masked-info full"><b>Endpoint ditemukan</b><code>{endpointLabel(target)}</code><small>Credential hanya dipakai untuk handshake dan session wizard sementara.</small></div>
        <label>Username ONVIF<input autoComplete="off" value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} placeholder="admin" /></label>
        <label>Password ONVIF<input type="password" autoComplete="new-password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} placeholder="Password kamera" /></label>
        <label className="full">Credential RTSP<select value={rtspCredentialMode} onChange={(event) => setRtspCredentialMode(event.target.value as RtspCredentialMode)}>
          <option value="same">Sama dengan credential ONVIF</option>
          <option value="none">Tanpa username/password</option>
          <option value="separate">Gunakan credential terpisah</option>
        </select><small>Pilih “Tanpa username/password” bila URL RTSP kamera dapat dibuka secara anonim.</small></label>
        {rtspCredentialMode === 'separate' && <>
          <label>Username RTSP<input autoComplete="off" value={rtspCredentials.username} onChange={(event) => setRtspCredentials({ ...rtspCredentials, username: event.target.value })} /></label>
          <label>Password RTSP<input type="password" autoComplete="new-password" value={rtspCredentials.password} onChange={(event) => setRtspCredentials({ ...rtspCredentials, password: event.target.value })} /></label>
        </>}
        <div className="form-actions full"><button type="button" onClick={onClose}>Batal</button><button className="primary" disabled={Boolean(busy)}>{busy === 'inspect' ? 'Menguji kamera…' : 'Tes & Baca Profile'}</button></div>
      </form>}

      {step === 'profile' && inspection && <div className="form-grid">
        <section className="onvif-device-summary full">
          <div><small>Perangkat</small><b>{inspection.device.manufacturer || 'ONVIF'} {inspection.device.model}</b></div>
          <div><small>Hostname</small><b>{inspection.device.hostname || target.host}</b></div>
          <div><small>Firmware</small><b>{inspection.device.firmwareVersion || 'Tidak dilaporkan'}</b></div>
          <div><small>Serial</small><b>{inspection.device.serialNumber || 'Tidak dilaporkan'}</b></div>
        </section>
        {inspection.existingRoutes.length > 0 && <div className="alert warning full onvif-duplicate-warning">
          <b>Host ini sudah digunakan.</b>
          <span>Anda tetap dapat menambah channel/profile lain.</span>
          <div>{inspection.existingRoutes.map((route) => <button type="button" key={route.id} onClick={() => {
            onClose();
            onOpenRoute(route.id);
          }}>Buka {route.name}{route.profileToken ? ` · ${route.profileToken}` : ''} ↗</button>)}</div>
        </div>}
        <fieldset className="onvif-profile-list full">
          <legend>Pilih Media Profile</legend>
          {inspection.profiles.map((profile) => <label key={profile.token} className={!profile.streamAvailable ? 'disabled' : ''}>
            <input type="radio" name="onvif-profile" value={profile.token} checked={profileToken === profile.token} onChange={() => setProfileToken(profile.token)} disabled={!profile.streamAvailable} />
            <span><b>{profile.name} · token {profile.token}</b><small>{profileLabel(profile)} · {profile.ptz ? 'PTZ' : 'tanpa PTZ'}{profile.zoom ? ' · zoom' : ''}</small><code>{profile.streamUriMasked ?? profile.error}</code></span>
          </label>)}
        </fieldset>
        <div className="form-actions full"><button type="button" onClick={() => setStep('credentials')}>Kembali</button><button className="primary" onClick={continueToReview} disabled={!selectedProfile?.streamAvailable}>Review Route</button></div>
      </div>}

      {step === 'review' && inspection && selectedProfile && <form className="form-grid" onSubmit={importRoute}>
        <div className="masked-info full"><b>RTSP source</b><code>{selectedProfile.streamUriMasked}</code><small>Credential akan disisipkan dan disimpan terenkripsi saat route dibuat.</small></div>
        <label>Nama route<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={120} /></label>
        <label>Camera ID<input value={draft.cameraKey} onChange={(event) => setDraft({ ...draft, cameraKey: event.target.value.toLowerCase() })} required pattern="[a-z0-9][a-z0-9._-]*" /></label>
        <label className="full">Deskripsi<textarea rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={1000} /></label>
        <label className="check"><input type="checkbox" checked={draft.localViewEnabled} onChange={(event) => setDraft({ ...draft, localViewEnabled: event.target.checked })} /> Aktifkan WebRTC lokal</label>
        <label>Audio lokal<select value={draft.localAudioMode} onChange={(event) => setDraft({ ...draft, localAudioMode: event.target.value as RouteDraft['localAudioMode'] })} disabled={!draft.localViewEnabled}><option value="COPY">Copy codec kamera</option><option value="OPUS">Transcode Opus</option></select></label>
        <label className="check"><input type="checkbox" checked={draft.recordingEnabled} onChange={(event) => setDraft({ ...draft, recordingEnabled: event.target.checked })} /> Aktifkan recording</label>
        <label className="check"><input type="checkbox" checked={draft.autoStart} onChange={(event) => setDraft({ ...draft, autoStart: event.target.checked })} /> Auto-start saat boot</label>
        <label className="check full"><input type="checkbox" checked={draft.onlineRelayEnabled} onChange={(event) => setDraft({ ...draft, onlineRelayEnabled: event.target.checked })} /> Aktifkan Relay Online</label>
        {draft.onlineRelayEnabled && <>
          <label className="full">Output online, satu per baris<textarea rows={3} value={draft.outputs} onChange={(event) => setDraft({ ...draft, outputs: event.target.value })} required /></label>
          <label>Video online<select value={draft.ffmpegMode} onChange={(event) => setDraft({ ...draft, ffmpegMode: event.target.value as RouteDraft['ffmpegMode'] })}><option value="COPY">Copy</option><option value="TRANSCODE">Transcode H.264</option></select></label>
          <label>Audio online<select value={draft.onlineAudioMode} onChange={(event) => setDraft({ ...draft, onlineAudioMode: event.target.value as RouteDraft['onlineAudioMode'] })}><option value="COPY">Copy</option><option value="AAC">AAC</option><option value="OPUS">Opus</option></select></label>
        </>}
        <fieldset className="onvif-review-ptz full">
          <legend>Kontrol ONVIF</legend>
          <label className="check"><input type="checkbox" checked={draft.ptzEnabled} onChange={(event) => setDraft({ ...draft, ptzEnabled: event.target.checked })} /> Aktifkan PTZ</label>
          <label className="check"><input type="checkbox" checked={draft.zoomEnabled} onChange={(event) => setDraft({ ...draft, zoomEnabled: event.target.checked })} disabled={!draft.ptzEnabled} /> Aktifkan zoom</label>
          <label>Media Profile Token PTZ<input value={draft.ptzProfileToken} onChange={(event) => setDraft({ ...draft, ptzProfileToken: event.target.value })} disabled={!draft.ptzEnabled} /></label>
        </fieldset>
        <div className="alert warning full">Route akan tersimpan dalam status STOPPED. Tekan <b>Inisiasi</b> sendiri melalui Stream Router setelah konfigurasi diperiksa.</div>
        <div className="form-actions full"><button type="button" onClick={() => setStep('profile')}>Kembali</button><button className="primary" disabled={Boolean(busy)}>{busy === 'import' ? 'Menambahkan…' : 'Simpan ke Stream Router'}</button></div>
      </form>}
    </section>
  </div>, document.body);
}

export function OnvifDiscoveryPanel({ onOpenRoute }: { onOpenRoute: (id: string) => void }) {
  const [interfaces, setInterfaces] = useState<OnvifNetworkInterface[]>([]);
  const [interfaceName, setInterfaceName] = useState('');
  const [devices, setDevices] = useState<OnvifDiscoveredDevice[]>([]);
  const [manual, setManual] = useState<OnvifDiscoveryTarget>(defaultTarget);
  const [wizardTarget, setWizardTarget] = useState<OnvifDiscoveryTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [scanInterfaceCount, setScanInterfaceCount] = useState(0);

  useEffect(() => {
    void api<{ items: OnvifNetworkInterface[] }>('/api/settings/onvif-discovery/interfaces')
      .then((result) => setInterfaces(result.items))
      .catch((reason) => setError((reason as Error).message));
  }, []);

  const scan = useCallback(async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ items: OnvifDiscoveredDevice[]; scannedInterfaces: OnvifNetworkInterface[] }>('/api/settings/onvif-discovery/scan', {
        method: 'POST',
        body: JSON.stringify({ ...(interfaceName ? { interfaceName } : {}), timeoutMs: 5000 })
      });
      setDevices(result.items);
      setScanInterfaceCount(result.scannedInterfaces.length);
      setMessage(result.items.length
        ? `${result.items.length} perangkat ONVIF ditemukan melalui ${result.scannedInterfaces.length || 1} interface.`
        : 'Tidak ada respons multicast ONVIF. IP yang bisa diakses belum tentu mendukung WS-Discovery; gunakan pemeriksaan IP manual di bawah.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, [interfaceName]);

  function openManual(event: FormEvent) {
    event.preventDefault();
    setError('');
    setWizardTarget(manual);
  }

  function imported(route: { id: string; name: string; cameraKey: string }) {
    setDevices((current) => current.map((device) => device.host === wizardTarget?.host
      ? { ...device, existingRoutes: [...device.existingRoutes, { ...route, profileToken: '' }] }
      : device));
    setWizardTarget(null);
    setMessage(`Route ${route.name} berhasil ditambahkan dalam status STOPPED. Buka Stream Router untuk inisiasi.`);
  }

  return <section className="panel onvif-discovery-settings">
    <header className="health-header">
      <div><h2>ONVIF Camera Discovery</h2><p>Temukan kamera pada LAN atau periksa IP manual, lalu tambahkan satu per satu ke Stream Router.</p></div>
      <button className="primary" type="button" onClick={() => void scan()} disabled={busy}>{busy ? 'Memindai 5 detik…' : 'Scan Jaringan'}</button>
    </header>
    {message && <div className={`alert ${devices.length ? 'success' : 'warning'}`}>{message}</div>}
    {error && <div className="alert error">{error}</div>}
    <div className="onvif-discovery-toolbar">
      <label>Interface jaringan<select value={interfaceName} onChange={(event) => setInterfaceName(event.target.value)}>
        <option value="">Semua interface aktif (disarankan)</option>
        {interfaces.map((item) => <option key={`${item.name}-${item.address}`} value={item.name}>{item.name} · {item.address}{item.cidr ? ` · ${item.cidr}` : ''}</option>)}
      </select><small>Discovery menggunakan multicast WS-Discovery pada {scanInterfaceCount || (interfaceName ? 1 : interfaces.length || 1)} interface, bukan ping atau scan CIDR.</small></label>
    </div>
    <div className="onvif-device-list">
      {devices.map((device) => <article key={device.id}>
        <div><b>{device.name}</b><small>{endpointLabel(device)}</small>{device.urn && <code>{device.urn}</code>}</div>
        <div className="onvif-device-status">{device.existingRoutes.length
          ? <span className="badge warn">Sudah dipakai {device.existingRoutes.length} route</span>
          : <span className="badge">Baru</span>}</div>
        <button type="button" onClick={() => setWizardTarget(device)}>Konfigurasi</button>
      </article>)}
      {!devices.length && <p className="empty">Belum ada hasil scan. Kamera lintas VLAN dapat diperiksa melalui IP manual di bawah.</p>}
    </div>
    <form className="onvif-manual-target form-grid" onSubmit={openManual}>
      <div className="full"><h3>IP / Host Manual</h3><p>Gunakan ini bila multicast diblokir atau kamera berada pada jaringan lain yang tetap dapat dijangkau server.</p></div>
      <label>Host / IP<input value={manual.host} onChange={(event) => setManual({ ...manual, host: event.target.value })} required placeholder="192.168.1.13" /></label>
      <label>Port ONVIF<input type="number" min="1" max="65535" value={manual.port} onChange={(event) => setManual({ ...manual, port: Number(event.target.value) })} required /></label>
      <label className="full">Path service<input value={manual.path} onChange={(event) => setManual({ ...manual, path: event.target.value })} required /></label>
      <label className="check"><input type="checkbox" checked={manual.useTls} onChange={(event) => setManual({ ...manual, useTls: event.target.checked })} /> Gunakan HTTPS/TLS</label>
      <div className="form-actions"><button className="primary">Periksa Kamera</button></div>
    </form>
    {wizardTarget && <OnvifImportWizard
      target={wizardTarget}
      onClose={() => setWizardTarget(null)}
      onImported={imported}
      onOpenRoute={onOpenRoute}
    />}
  </section>;
}
