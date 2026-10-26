import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { PtzConfigFields } from '../components/PtzConfigFields';
import {
  blankBridgeAssignments,
  emptyPtzForm,
  mqttBridgeRequestBody,
  mqttBridgeStatus,
  ptzFormFromDto,
  ptzRequestBody,
  ptzSaveAction,
  type PtzFormState
} from '../components/ptz-form';
import type {
  EditableStreamRoute,
  MqttBridgeConfig,
  MqttBridgeSubscription,
  MqttBrokerProfile,
  PtzConfigDto,
  RecordingRetentionMode,
  StreamRoute
} from '../types';
import { duplicateOutputs, parseOutputLines } from './route-outputs';

interface Props { routeId?: string; onDone: () => void; embedded?: boolean; }

export function RouteEditorPage({ routeId, onDone, embedded = false }: Props) {
  const [cameraKey, setCameraKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [outputs, setOutputs] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [autoStart, setAutoStart] = useState(false);
  const [localViewEnabled, setLocalViewEnabled] = useState(false);
  const [localAudioMode, setLocalAudioMode] = useState<'COPY' | 'OPUS'>('COPY');
  const [onlineRelayEnabled, setOnlineRelayEnabled] = useState(true);
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [recordingRetentionMode, setRecordingRetentionMode] = useState<RecordingRetentionMode>('INHERIT');
  const [recordingRetentionDays, setRecordingRetentionDays] = useState<number | ''>('');
  const [recordingRetentionGb, setRecordingRetentionGb] = useState<number | ''>('');
  const [mode, setMode] = useState<'COPY' | 'TRANSCODE'>('COPY');
  const [onlineAudioMode, setOnlineAudioMode] = useState<'COPY' | 'AAC' | 'OPUS'>('COPY');
  const [videoBitrate, setVideoBitrate] = useState(2500);
  const [audioBitrate, setAudioBitrate] = useState(128);
  const [preset, setPreset] = useState('veryfast');
  const [initialDelayMs, setInitialDelayMs] = useState(2000);
  const [maxDelayMs, setMaxDelayMs] = useState(60000);
  const [maxRetries, setMaxRetries] = useState(10);
  const [webrtcEnabled, setWebrtcEnabled] = useState(false);
  const [webrtcUrl, setWebrtcUrl] = useState('');
  const [webrtcMode, setWebrtcMode] = useState<'IFRAME' | 'WHEP'>('IFRAME');
  const [webrtcUrlCleared, setWebrtcUrlCleared] = useState(false);
  const [error, setError] = useState('');
  const [existing, setExisting] = useState<StreamRoute | null>(null);
  const [createdRouteId, setCreatedRouteId] = useState<string>();
  const [ptz, setPtz] = useState<PtzFormState>(emptyPtzForm);
  const [testingPtz, setTestingPtz] = useState(false);
  const [brokers, setBrokers] = useState<MqttBrokerProfile[]>([]);
  const [bridgeEnabled, setBridgeEnabled] = useState(false);
  const [bridgeSubscriptions, setBridgeSubscriptions] = useState<MqttBridgeSubscription[]>([]);
  const [bridgeRuntime, setBridgeRuntime] = useState<MqttBridgeConfig['runtime']>({ active: false, onvifConnected: false, lastPresenceAt: null });
  const [testingBridge, setTestingBridge] = useState(false);
  // Route lama baru boleh disimpan setelah route, PTZ, dan bridge termuat; form kosong
  // akibat load gagal akan menghapus PTZ dan assignment bridge yang tersimpan.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>(routeId ? 'loading' : 'ready');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [notice, setNotice] = useState('');
  // null = konfigurasi PTZ tersimpan belum diketahui, sehingga tidak pernah dihapus.
  const storedPtzProvider = useRef<PtzFormState['provider'] | null>(routeId ? null : 'NONE');
  const lastSavedRoute = useRef<{ id: string; body: string } | null>(null);

  useEffect(() => {
    void api<{ items: MqttBrokerProfile[] }>('/api/mqtt-brokers')
      .then((result) => setBrokers(result.items))
      .catch((reason) => setError((reason as Error).message));
  }, []);

  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    setLoadState('loading');
    void Promise.all([
      api<EditableStreamRoute>(`/api/routes/${routeId}/edit`),
      api<PtzConfigDto>(`/api/routes/${routeId}/ptz`),
      api<MqttBridgeConfig>(`/api/routes/${routeId}/ptz/mqtt-bridge`)
    ]).then(([route, ptzConfig, bridge]) => {
      if (cancelled) return;
      setExisting(route); setCameraKey(route.cameraKey); setName(route.name); setDescription(route.description); setInputUrl(route.inputUrl); setOutputs(route.outputs.join('\n')); setEnabled(route.enabled); setAutoStart(route.autoStart); setLocalViewEnabled(route.localViewEnabled); setLocalAudioMode(route.localAudioMode); setOnlineRelayEnabled(route.onlineRelayEnabled); setOnlineAudioMode(route.onlineAudioMode); setRecordingEnabled(route.recordingEnabled); setRecordingRetentionMode(route.recordingRetentionMode); setRecordingRetentionDays(route.recordingRetentionDays ?? ''); setRecordingRetentionGb(route.recordingRetentionGb ?? ''); setMode(route.ffmpegMode);
      const options = route.ffmpegOptions as { videoBitrateKbps?: number; audioBitrateKbps?: number; preset?: string };
      setVideoBitrate(options.videoBitrateKbps ?? 2500); setAudioBitrate(options.audioBitrateKbps ?? 128); setPreset(options.preset ?? 'veryfast');
      const retry = route.retryPolicy as { initialDelayMs?: number; maxDelayMs?: number; maxRetries?: number };
      setInitialDelayMs(retry.initialDelayMs ?? 2000); setMaxDelayMs(retry.maxDelayMs ?? 60000); setMaxRetries(retry.maxRetries ?? 10);
      setWebrtcEnabled(route.webrtc.enabled); setWebrtcMode(route.webrtc.mode); setWebrtcUrl(route.webrtc.url ?? '');
      setPtz(ptzFormFromDto(ptzConfig));
      storedPtzProvider.current = ptzConfig.provider;
      setBridgeEnabled(bridge.enabled);
      setBridgeSubscriptions(bridge.subscriptions);
      setBridgeRuntime(bridge.runtime);
      setLoadState('ready');
    }).catch((reason) => {
      if (cancelled) return;
      setLoadState('failed');
      setError(`Konfigurasi route gagal dimuat: ${(reason as Error).message}`);
    });
    return () => {
      cancelled = true;
    };
  }, [routeId, loadAttempt]);

  function toggleBroker(brokerId: string) {
    setBridgeSubscriptions((current) => current.some((item) => item.brokerId === brokerId)
      ? current.filter((item) => item.brokerId !== brokerId)
      : [...current, { brokerId, cameraId: '', commandTopic: '' }]);
  }

  function updateBridgeCameraId(brokerId: string, cameraId: string) {
    setBridgeSubscriptions((current) => current.map((item) => (
      item.brokerId === brokerId ? { ...item, cameraId } : item
    )));
  }

  function bridgeBody() {
    return mqttBridgeRequestBody(ptz.provider, bridgeEnabled, bridgeSubscriptions);
  }

  function bridgeValidationError(): string {
    const blank = blankBridgeAssignments(ptz.provider, bridgeEnabled, bridgeSubscriptions);
    if (!blank.length) return '';
    const names = blank.map((brokerId) => brokers.find((broker) => broker.id === brokerId)?.name ?? brokerId);
    return `ID camera wajib diisi untuk broker ${names.join(', ')}, atau hapus centang broker tersebut.`;
  }

  async function testBridgeConnection() {
    const targetId = routeId ?? createdRouteId;
    if (!targetId) return;
    setError('');
    const invalidBridge = bridgeValidationError();
    if (invalidBridge) { setError(invalidBridge); return; }
    setTestingBridge(true);
    try {
      const saved = await api<MqttBridgeConfig>(`/api/routes/${targetId}/ptz/mqtt-bridge`, {
        method: 'PUT',
        body: JSON.stringify(bridgeBody())
      });
      setBridgeRuntime(saved.runtime);
      await api(`/api/routes/${targetId}/ptz/mqtt-bridge/test`, { method: 'POST' });
      const refreshed = await api<MqttBridgeConfig>(`/api/routes/${targetId}/ptz/mqtt-bridge`);
      setBridgeSubscriptions(refreshed.subscriptions);
      setBridgeRuntime(refreshed.runtime);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setTestingBridge(false);
    }
  }

  async function testPtzConnection() {
    const targetId = routeId ?? createdRouteId;
    const body = ptzRequestBody(ptz);
    if (!targetId || !body) return;
    setTestingPtz(true);
    setError('');
    setNotice('');
    try {
      const savedConfig = await api<PtzConfigDto>(`/api/routes/${targetId}/ptz`, { method: 'PUT', body: JSON.stringify(body) });
      storedPtzProvider.current = savedConfig.provider;
      setPtz(ptzFormFromDto(savedConfig));
      const tested = await api<PtzConfigDto>(`/api/routes/${targetId}/ptz/test`, { method: 'POST' });
      setPtz(ptzFormFromDto(tested));
    } catch (reason) {
      const current = await api<PtzConfigDto>(`/api/routes/${targetId}/ptz`).catch(() => null);
      if (current) setPtz(ptzFormFromDto(current));
      setError((reason as Error).message);
    } finally {
      setTestingPtz(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    if (loadState !== 'ready') { setError('Konfigurasi route belum termuat. Muat ulang sebelum menyimpan.'); return; }
    const outputList = parseOutputLines(outputs);
    if (duplicateOutputs(outputList).length) {
      setError(`Output online tidak boleh duplikat: hapus baris yang sama.${onlineRelayEnabled ? '' : ' Aktifkan Relay Online sementara untuk melihat daftar output.'}`);
      return;
    }
    const invalidBridge = bridgeValidationError();
    if (invalidBridge) { setError(invalidBridge); return; }
    const body: Record<string, unknown> = {
      name, description, enabled, autoStart, localViewEnabled, localAudioMode, onlineRelayEnabled, recordingEnabled,
      recordingRetentionMode,
      recordingRetentionDays: recordingRetentionDays === '' ? null : recordingRetentionDays,
      recordingRetentionGb: recordingRetentionGb === '' ? null : recordingRetentionGb,
      ffmpegMode: mode,
      onlineAudioMode,
      ffmpegOptions: { videoBitrateKbps: videoBitrate, audioBitrateKbps: audioBitrate, preset, gop: 50 },
      retryPolicy: { initialDelayMs, maxDelayMs, maxRetries, jitterRatio: 0.2, stableResetMs: 60000 }
    };
    if (cameraKey.trim()) body.cameraKey = cameraKey.trim();
    if (webrtcEnabled && !webrtcUrl.trim() && (!existing?.webrtc.urlMasked || webrtcUrlCleared)) { setError('Link WebRTC wajib diisi saat viewer diaktifkan.'); return; }
    body.webrtc = { enabled: webrtcEnabled, mode: webrtcMode, ...(webrtcUrl.trim() ? { url: webrtcUrl.trim() } : {}) };
    // Field kosong berarti "pertahankan link lama"; null hanya dikirim setelah Admin menekan Hapus link.
    if (webrtcUrlCleared && !webrtcUrl.trim()) body.webrtc = { enabled: webrtcEnabled, mode: webrtcMode, url: null };
    if (inputUrl.trim()) body.inputUrl = inputUrl.trim();
    body.outputs = outputList;
    const effectiveRouteId = routeId ?? createdRouteId;
    if (onlineRelayEnabled && !outputList.length) { setError('Minimal satu output wajib diisi saat Relay Online aktif.'); return; }
    if (!effectiveRouteId && !body.inputUrl) { setError('Input URL wajib diisi.'); return; }
    const serializedBody = JSON.stringify(body);
    let routeSaved = false;
    try {
      let savedId: string;
      if (effectiveRouteId && lastSavedRoute.current?.id === effectiveRouteId && lastSavedRoute.current.body === serializedBody) {
        // Data route tidak berubah sejak save terakhir yang berhasil (retry setelah
        // PTZ/bridge gagal): PATCH ulang hanya akan me-restart route aktif.
        savedId = effectiveRouteId;
      } else {
        const saved = await api<StreamRoute>(effectiveRouteId ? `/api/routes/${effectiveRouteId}` : '/api/routes', {
          method: effectiveRouteId ? 'PATCH' : 'POST',
          body: serializedBody
        });
        savedId = saved.id;
        lastSavedRoute.current = { id: saved.id, body: serializedBody };
        if (storedPtzProvider.current !== null) storedPtzProvider.current = saved.ptz.provider;
        setExisting(saved);
        if (!effectiveRouteId) setCreatedRouteId(saved.id);
      }
      routeSaved = true;
      const ptzAction = ptzSaveAction(ptz, storedPtzProvider.current);
      if (ptzAction.kind === 'PUT') {
        const savedConfig = await api<PtzConfigDto>(`/api/routes/${savedId}/ptz`, { method: 'PUT', body: JSON.stringify(ptzAction.body) });
        storedPtzProvider.current = savedConfig.provider;
        setPtz(ptzFormFromDto(savedConfig));
      } else if (ptzAction.kind === 'DELETE') {
        await api(`/api/routes/${savedId}/ptz`, { method: 'DELETE' });
        storedPtzProvider.current = 'NONE';
      }
      const savedBridge = await api<MqttBridgeConfig>(`/api/routes/${savedId}/ptz/mqtt-bridge`, {
        method: 'PUT',
        body: JSON.stringify(bridgeBody())
      });
      setBridgeRuntime(savedBridge.runtime);
      // Tes koneksi bukan bagian dari transaksi save: kamera yang sedang offline tidak
      // boleh menggagalkan penyimpanan route, PTZ, dan bridge.
      if (ptzAction.kind === 'PUT' && ptz.enabled) {
        try {
          const tested = await api<PtzConfigDto>(`/api/routes/${savedId}/ptz/test`, { method: 'POST' });
          setPtz(ptzFormFromDto(tested));
        } catch (reason) {
          const current = await api<PtzConfigDto>(`/api/routes/${savedId}/ptz`).catch(() => null);
          if (current) setPtz(ptzFormFromDto(current));
          setNotice(`Route, PTZ, dan bridge tersimpan, tetapi tes koneksi PTZ gagal: ${(reason as Error).message}. Periksa kamera lalu gunakan “Simpan & Tes Koneksi”, atau tutup editor.`);
          return;
        }
      }
      onDone();
    } catch (reason) {
      setError(`${routeSaved ? 'Data route tersimpan, tetapi pengaturan PTZ/bridge gagal disimpan: ' : ''}${(reason as Error).message}`);
    }
  }

  const bridgeStatus = mqttBridgeStatus(bridgeRuntime);
  return <>{!embedded && <header className="page-header"><div><h1>{routeId ? 'Edit Route' : 'Tambah Route'}</h1><p>Credential tidak pernah ditampilkan ulang. Kosongkan field secret saat edit untuk mempertahankan nilai lama.</p></div></header>}
    {loadState === 'loading' && <p className="empty">Memuat konfigurasi route…</p>}
    {error && <div className="alert error">{error}{loadState === 'failed' && <> <button type="button" onClick={() => { setError(''); setLoadAttempt((value) => value + 1); }}>Muat ulang</button></>}</div>}
    {notice && <div className="alert warning">{notice}</div>}
    <form className={`${embedded ? '' : 'panel'} form-grid`} onSubmit={submit}>
      <section className="route-config-section full"><header><h3>Camera Source</h3><p>Satu koneksi kamera ditarik oleh MediaMTX untuk seluruh fungsi route.</p></header><div className="form-grid">
        <label>Nama route<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Camera ID<input value={cameraKey} onChange={(e) => setCameraKey(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9._-]*" placeholder="cctv-tes-1" /><small>Dikunci setelah recording pertama tersimpan.</small></label>
        <label className="full">Deskripsi / keterangan<textarea rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Contoh: Kamera pintu masuk gedung utama" /></label>
        <label className="full">Input URL (RTSP/RTMP)<input value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} placeholder="rtsp://user:pass@192.168.1.10/live" required /></label>
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        <label className="check"><input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} /> Auto-start saat boot</label>
      </div></section>
      <section className="route-config-section full"><header><h3>Local Media</h3><p>WebRTC lokal dibuat otomatis oleh MediaMTX.</p></header><div className="form-grid">
        <label className="check full"><input type="checkbox" checked={localViewEnabled} onChange={(e) => setLocalViewEnabled(e.target.checked)} /> Aktifkan WebRTC lokal</label>
        {localViewEnabled && <label>Audio WebRTC<select value={localAudioMode} onChange={(event) => setLocalAudioMode(event.target.value as 'COPY' | 'OPUS')}>
          <option value="COPY">Copy codec kamera</option>
          <option value="OPUS">Transcode ke Opus</option>
        </select><small>Opus lebih kompatibel dengan browser. Video tetap copy agar penggunaan CPU rendah.</small></label>}
        {existing?.media.localWebrtcUrl && <div className="masked-info full"><small>URL lokal</small><code>{existing.media.localWebrtcUrl}</code></div>}
      </div></section>
      <section className="route-config-section full"><header><h3>Relay Online</h3><p>FFmpeg membaca MediaMTX lokal lalu meneruskan stream ke VPS.</p></header><div className="form-grid">
        <label className="check full"><input type="checkbox" checked={onlineRelayEnabled} onChange={(e) => setOnlineRelayEnabled(e.target.checked)} /> Aktifkan Relay Online</label>
        {onlineRelayEnabled && <><label className="full">Output URL online, satu per baris<textarea rows={5} value={outputs} onChange={(e) => setOutputs(e.target.value)} placeholder="rtmp://server/live/key" required /></label>
        <label>Video online<select value={mode} onChange={(e) => setMode(e.target.value as 'COPY' | 'TRANSCODE')}><option value="COPY">Copy codec kamera</option><option value="TRANSCODE">Transcode H.264</option></select></label>
        <label>Audio online<select value={onlineAudioMode} onChange={(e) => setOnlineAudioMode(e.target.value as 'COPY' | 'AAC' | 'OPUS')}><option value="COPY">Copy codec sumber</option><option value="AAC">Transcode AAC</option><option value="OPUS">Opus dari path bersama</option></select><small>Opus dipakai bersama dengan WebRTC lokal agar tidak di-encode ulang untuk setiap output.</small></label></>}
        <label className="check full"><input type="checkbox" checked={webrtcEnabled} onChange={(e) => setWebrtcEnabled(e.target.checked)} /> Tambahkan WebRTC online sebagai fallback Viewer</label>
        {webrtcEnabled && <><label>Mode viewer<select value={webrtcMode} onChange={(e) => setWebrtcMode(e.target.value as 'IFRAME' | 'WHEP')}><option value="IFRAME">Embed IFRAME</option><option value="WHEP">WHEP eksternal</option></select></label><label className="full">Link WebRTC online<input type="url" value={webrtcUrl} onChange={(e) => setWebrtcUrl(e.target.value)} placeholder="https://media.example.com/embed/camera-1" required /></label></>}
        {existing?.webrtc.urlMasked && !webrtcUrlCleared && <div className="ptz-test-row full"><small>Link WebRTC tersimpan: <code>{existing.webrtc.urlMasked}</code></small><button type="button" onClick={() => { setWebrtcUrl(''); setWebrtcEnabled(false); setWebrtcUrlCleared(true); }}>Hapus link</button></div>}
      </div></section>
      <section className="route-config-section full"><header><h3>Recording</h3><p>Continuous fMP4, maksimum 1 jam per file, tanpa transcoding tambahan.</p></header><div className="form-grid">
        <label className="check"><input type="checkbox" checked={recordingEnabled} onChange={(e) => setRecordingEnabled(e.target.checked)} /> Aktifkan recording</label>
        <label>Kebijakan retention<select value={recordingRetentionMode} onChange={(event) => {
          const next = event.target.value as RecordingRetentionMode;
          setRecordingRetentionMode(next);
          if ((next === 'DAYS' || next === 'DAYS_OR_SIZE') && recordingRetentionDays === '') setRecordingRetentionDays(30);
          if ((next === 'SIZE' || next === 'DAYS_OR_SIZE') && recordingRetentionGb === '') setRecordingRetentionGb(100);
        }}>
          <option value="INHERIT">Ikuti Settings</option>
          <option value="DAYS">Berdasarkan umur (hari)</option>
          <option value="SIZE">Berdasarkan kuota (GB)</option>
          <option value="DAYS_OR_SIZE">Hari atau GB — yang tercapai dulu</option>
        </select><small>Recording terproteksi tidak ikut dihapus otomatis.</small></label>
        {(recordingRetentionMode === 'DAYS' || recordingRetentionMode === 'DAYS_OR_SIZE') && <label>Maksimum umur (hari)<input type="number" min="1" max="3650" value={recordingRetentionDays} onChange={(e) => setRecordingRetentionDays(e.target.value ? Number(e.target.value) : '')} required /><small>Segment lebih tua akan dihapus mulai dari yang paling lama.</small></label>}
        {(recordingRetentionMode === 'SIZE' || recordingRetentionMode === 'DAYS_OR_SIZE') && <label>Maksimum arsip kamera (GB)<input type="number" min="0.1" max="1000000" step="0.1" value={recordingRetentionGb} onChange={(e) => setRecordingRetentionGb(e.target.value ? Number(e.target.value) : '')} required /><small>Kuota dihitung per Camera ID, termasuk recording terproteksi.</small></label>}
        {recordingRetentionMode === 'INHERIT' && <div className="masked-info"><small>Policy mengikuti nilai default di menu Settings.</small></div>}
      </div></section>
      <div className="subpanel full"><label>Retry awal (ms)<input type="number" min="500" max="60000" value={initialDelayMs} onChange={(e) => setInitialDelayMs(Number(e.target.value))} /></label><label>Retry maksimum (ms)<input type="number" min="1000" max="600000" value={maxDelayMs} onChange={(e) => setMaxDelayMs(Number(e.target.value))} /></label><label>Maksimum retry<input type="number" min="0" max="100" value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} /></label></div>
      {(mode === 'TRANSCODE' || onlineAudioMode !== 'COPY') && <div className="subpanel full">
        {mode === 'TRANSCODE' && <><label>Video bitrate (kbps)<input type="number" min="100" max="50000" value={videoBitrate} onChange={(e) => setVideoBitrate(Number(e.target.value))} /></label><label>Preset<select value={preset} onChange={(e) => setPreset(e.target.value)}>{['ultrafast','superfast','veryfast','faster','fast','medium'].map((p) => <option key={p}>{p}</option>)}</select></label></>}
        {onlineAudioMode !== 'COPY' && <label>Audio bitrate (kbps)<input type="number" min="32" max="512" value={audioBitrate} onChange={(e) => setAudioBitrate(Number(e.target.value))} /></label>}
      </div>}
      <PtzConfigFields
        value={ptz}
        onChange={setPtz}
        brokers={brokers}
        onTest={() => void testPtzConnection()}
        testing={testingPtz}
        canTest={Boolean(routeId ?? createdRouteId) && loadState === 'ready'}
      />
      {ptz.provider === 'ONVIF' && <section className="ptz-config mqtt-bridge-config full">
        <div className="ptz-config-heading">
          <div><h3>MQTT → ONVIF Bridge</h3><p>Terima command dari broker lokal/online lalu teruskan ke kamera ONVIF saat ingest MediaMTX READY.</p></div>
          <span className={`ptz-connection ptz-connection-${bridgeStatus.state}`}><span className="ptz-connection-light" /><span><b>{bridgeStatus.label}</b><small>{bridgeRuntime.lastPresenceAt ? `Presence ${new Date(bridgeRuntime.lastPresenceAt).toLocaleString('id-ID')}` : 'Belum ada heartbeat'}</small></span></span>
        </div>
        <div className="form-grid">
          <label className="check full"><input type="checkbox" checked={bridgeEnabled} onChange={(event) => setBridgeEnabled(event.target.checked)} /> Aktifkan bridge ketika ingest MediaMTX READY</label>
          {bridgeEnabled && <div className="full mqtt-assignment-list">
            {brokers.map((broker) => {
              const assignment = bridgeSubscriptions.find((item) => item.brokerId === broker.id);
              return <div className="mqtt-assignment-row" key={broker.id}>
                <label className="check"><input type="checkbox" checked={Boolean(assignment)} onChange={() => toggleBroker(broker.id)} /><span><b>{broker.name}</b><small>{broker.description || `${broker.protocol}://${broker.host}:${broker.port}`}</small></span></label>
                {assignment && <label>ID camera / suffix topic<input value={assignment.cameraId} onChange={(event) => updateBridgeCameraId(broker.id, event.target.value)} required pattern="[a-zA-Z0-9._-]+" placeholder="cctv-tes-1" /><small>PTZ: {broker.rootTopic}/{assignment.cameraId || 'id-camera'}<br />Status: {broker.rootTopic}/{assignment.cameraId || 'id-camera'}/status</small></label>}
                {assignment?.connection && <span className={`ptz-connection ptz-connection-${assignment.connection.state.toLowerCase()}`}><span className="ptz-connection-light" /><span><b>{assignment.connection.state}</b><small>{assignment.connection.message}</small></span></span>}
              </div>;
            })}
            {!brokers.length && <p className="empty">Belum ada profil broker. Tambahkan broker melalui Settings.</p>}
          </div>}
          <div className="ptz-test-row full"><small>Heartbeat kamera dikirim setiap 15 detik ke <code>…/status</code>; daftar kamera broker tersedia pada <code>root-topic/camera-status</code>.</small><button type="button" onClick={() => void testBridgeConnection()} disabled={!bridgeEnabled || !bridgeSubscriptions.length || !(routeId ?? createdRouteId) || testingBridge || loadState !== 'ready'}>{testingBridge ? 'Menguji bridge…' : 'Simpan & Tes Bridge'}</button></div>
        </div>
      </section>}
      <div className="form-actions full"><button type="button" onClick={onDone}>{notice ? 'Tutup' : 'Batal'}</button><button className="primary" disabled={loadState !== 'ready'}>Simpan Route</button></div>
    </form>
  </>;
}
