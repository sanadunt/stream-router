import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { PtzConfigFields, PtzConnectionIndicator } from '../components/PtzConfigFields';
import { emptyPtzForm, ptzFormFromDto, ptzRequestBody, ptzSaveAction, type PtzFormState } from '../components/ptz-form';
import { compareSortValues, SortableHeader, type SortDirection } from '../components/SortableHeader';
import { streamViewModeInfo, suggestStreamViewMode } from '../components/stream-view';
import { useModalFocus } from '../hooks/useModalFocus';
import type {
  EditableWebrtcStream,
  Mp4FileListing,
  MqttBrokerProfile,
  PtzConfigDto,
  StreamViewMode,
  WebrtcStream
} from '../types';

type StreamSortKey = 'name' | 'url' | 'mode' | 'ptz' | 'enabled' | 'updatedAt';
type Mp4SourceType = 'URL' | 'FILE';

function streamSortValue(stream: WebrtcStream, key: StreamSortKey): string | number | boolean {
  switch (key) {
    case 'name': return `${stream.name} ${stream.description}`;
    case 'url': return stream.urlMasked;
    case 'mode': return stream.mode;
    case 'ptz': return `${stream.ptz.enabled} ${stream.ptz.provider} ${stream.ptz.connection.state}`;
    case 'enabled': return stream.enabled;
    case 'updatedAt': return new Date(stream.updatedAt).getTime();
  }
}

function formatFileSize(value?: number): string {
  if (value === undefined) return '';
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function Mp4FileBrowser({
  initialPath,
  onClose,
  onSelect
}: {
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<Mp4FileListing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);

  const browse = useCallback(async (target?: string) => {
    setBusy(true);
    setError('');
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : '';
      setListing(await api<Mp4FileListing>(`/api/webrtc-streams/files${query}`));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void browse(initialPath || undefined);
  }, [browse, initialPath]);

  return <div className="modal-backdrop modal-backdrop-nested" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialogRef} className="modal-panel storage-browser-modal" role="dialog" aria-modal="true" aria-labelledby="mp4-file-browser-title" tabIndex={-1}>
      <header className="modal-header">
        <div><h2 id="mp4-file-browser-title">Pilih File MP4</h2><p>Hanya folder dan file `.mp4` pada filesystem server yang ditampilkan.</p></div>
        <button className="icon-button" aria-label="Tutup browser file" onClick={onClose}>×</button>
      </header>
      {error && <div className="alert error">{error}</div>}
      <div className="storage-browser-path">
        <button type="button" onClick={() => listing?.parent && void browse(listing.parent)} disabled={!listing?.parent || busy}>← Parent</button>
        <code>{listing?.current ?? (initialPath || 'Filesystem server')}</code>
      </div>
      <div className="storage-directory-list">
        {busy && <p className="empty">Membaca folder…</p>}
        {!busy && listing?.entries.map((entry) => <button
          type="button"
          key={entry.path}
          className={entry.type === 'FILE' ? 'mp4-file-entry' : ''}
          onClick={() => entry.type === 'DIRECTORY' ? void browse(entry.path) : onSelect(entry.path)}
        >
          <span>{entry.type === 'DIRECTORY' ? '▸' : '▶'} {entry.name}</span>
          <small>{entry.type === 'DIRECTORY' ? 'Folder' : formatFileSize(entry.sizeBytes)}</small>
        </button>)}
        {!busy && listing && !listing.entries.length && <p className="empty">Tidak ada folder atau file MP4.</p>}
      </div>
      <div className="form-actions"><button type="button" onClick={onClose}>Batal</button></div>
    </section>
  </div>;
}

export function StreamViewPage() {
  const [streams, setStreams] = useState<WebrtcStream[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<WebrtcStream | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<StreamViewMode>('IFRAME');
  const [mp4SourceType, setMp4SourceType] = useState<Mp4SourceType>('URL');
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');
  const [ptz, setPtz] = useState<PtzFormState>(emptyPtzForm);
  const [testingPtz, setTestingPtz] = useState(false);
  const [brokers, setBrokers] = useState<MqttBrokerProfile[]>([]);
  const [sort, setSort] = useState<{ key: StreamSortKey; direction: SortDirection }>({ key: 'name', direction: 'asc' });
  // Stream lama baru dapat disimpan setelah URL dan PTZ termuat; form kosong akibat
  // load gagal tidak boleh menimpa URL atau menghapus konfigurasi PTZ tersimpan.
  const [editorState, setEditorState] = useState<'loading' | 'ready' | 'failed'>('ready');
  // Setiap buka/tutup editor menaikkan nomor ini sehingga respons load yang
  // terlambat (stream lain atau editor yang sudah ditutup) diabaikan.
  const editorRequest = useRef(0);
  const storedPtzProvider = useRef<PtzFormState['provider'] | null>(null);

  const load = useCallback(async () => {
    try {
      setStreams((await api<{ items: WebrtcStream[] }>('/api/webrtc-streams')).items);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    void api<{ items: MqttBrokerProfile[] }>('/api/mqtt-brokers')
      .then((result) => setBrokers(result.items))
      .catch((reason) => setError((reason as Error).message));
  }, [load]);

  const closeEditor = useCallback(() => {
    editorRequest.current += 1;
    setEditorOpen(false);
  }, []);

  function loadEditorDetails(stream: WebrtcStream) {
    const request = ++editorRequest.current;
    setEditorState('loading');
    setFormError('');
    void Promise.all([
      api<EditableWebrtcStream>(`/api/webrtc-streams/${stream.id}/edit`),
      api<PtzConfigDto>(`/api/webrtc-streams/${stream.id}/ptz`)
    ])
      .then(([editable, config]) => {
        if (request !== editorRequest.current) return;
        setUrl(editable.url);
        setMp4SourceType(editable.sourceType);
        setPtz(ptzFormFromDto(config));
        storedPtzProvider.current = config.provider;
        setEditorState('ready');
      })
      .catch((reason) => {
        if (request !== editorRequest.current) return;
        setEditorState('failed');
        setFormError(`URL dan konfigurasi PTZ gagal dimuat: ${(reason as Error).message}`);
      });
  }

  function openEditor(stream?: WebrtcStream) {
    const current = stream ?? null;
    setEditing(current);
    setName(current?.name ?? '');
    setDescription(current?.description ?? '');
    setEnabled(current?.enabled ?? true);
    setMode(current?.mode ?? 'IFRAME');
    setMp4SourceType(current?.sourceType ?? 'URL');
    setFileBrowserOpen(false);
    setUrl('');
    setFormError('');
    setNotice('');
    setPtz(emptyPtzForm());
    setEditorOpen(true);
    if (current) {
      storedPtzProvider.current = null;
      loadEditorDetails(current);
    } else {
      editorRequest.current += 1;
      storedPtzProvider.current = 'NONE';
      setEditorState('ready');
    }
  }

  async function testPtzConnection() {
    const body = ptzRequestBody(ptz);
    if (!editing || !body) return;
    setTestingPtz(true);
    setFormError('');
    try {
      const savedConfig = await api<PtzConfigDto>(`/api/webrtc-streams/${editing.id}/ptz`, { method: 'PUT', body: JSON.stringify(body) });
      storedPtzProvider.current = savedConfig.provider;
      setPtz(ptzFormFromDto(savedConfig));
      const tested = await api<PtzConfigDto>(`/api/webrtc-streams/${editing.id}/ptz/test`, { method: 'POST' });
      setPtz(ptzFormFromDto(tested));
    } catch (reason) {
      const current = await api<PtzConfigDto>(`/api/webrtc-streams/${editing.id}/ptz`).catch(() => null);
      if (current) setPtz(ptzFormFromDto(current));
      setFormError((reason as Error).message);
    } finally {
      setTestingPtz(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (editorState !== 'ready') {
      setFormError('URL dan konfigurasi PTZ belum termuat. Muat ulang sebelum menyimpan.');
      return;
    }
    if (!editing && !url.trim()) {
      setFormError('URL stream wajib diisi.');
      return;
    }
    setFormError('');
    let streamSaved = false;
    try {
      const saved = await api<WebrtcStream>(editing ? `/api/webrtc-streams/${editing.id}` : '/api/webrtc-streams', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name,
          description,
          enabled,
          mode,
          sourceType: mode === 'MP4' ? mp4SourceType : 'URL',
          ...(url.trim() ? { url: url.trim() } : {})
        })
      });
      streamSaved = true;
      setEditing(saved);
      if (storedPtzProvider.current !== null) storedPtzProvider.current = saved.ptz.provider;
      const ptzAction = ptzSaveAction(ptz, storedPtzProvider.current);
      if (ptzAction.kind === 'PUT') {
        const savedConfig = await api<PtzConfigDto>(`/api/webrtc-streams/${saved.id}/ptz`, { method: 'PUT', body: JSON.stringify(ptzAction.body) });
        storedPtzProvider.current = savedConfig.provider;
        setPtz(ptzFormFromDto(savedConfig));
      } else if (ptzAction.kind === 'DELETE') {
        await api(`/api/webrtc-streams/${saved.id}/ptz`, { method: 'DELETE' });
        storedPtzProvider.current = 'NONE';
      }
      // Tes koneksi PTZ dijalankan setelah semua data tersimpan dan hanya menjadi
      // peringatan: kamera offline tidak boleh membuat dialog tertahan dengan error.
      let warning = '';
      if (ptzAction.kind === 'PUT' && ptz.enabled) {
        try {
          await api<PtzConfigDto>(`/api/webrtc-streams/${saved.id}/ptz/test`, { method: 'POST' });
        } catch (reason) {
          warning = `Stream View "${saved.name}" tersimpan, tetapi tes koneksi PTZ gagal: ${(reason as Error).message}`;
        }
      }
      closeEditor();
      setNotice(warning);
      await load();
    } catch (reason) {
      setFormError(`${streamSaved ? 'Stream View tersimpan, tetapi konfigurasi PTZ gagal disimpan: ' : ''}${(reason as Error).message}`);
    }
  }

  async function toggleEnabled(stream: WebrtcStream) {
    try {
      await api(`/api/webrtc-streams/${stream.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !stream.enabled })
      });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function remove(stream: WebrtcStream) {
    if (!confirm(`Hapus Stream View "${stream.name}"?`)) return;
    try {
      await api(`/api/webrtc-streams/${stream.id}`, { method: 'DELETE' });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  const dialogRef = useModalFocus<HTMLElement>(editorOpen && !fileBrowserOpen, closeEditor);
  const sortedStreams = useMemo(() => [...streams].sort((left, right) => {
    const result = compareSortValues(streamSortValue(left, sort.key), streamSortValue(right, sort.key));
    return sort.direction === 'asc' ? result : -result;
  }), [streams, sort]);
  function changeSort(key: StreamSortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  }
  const sortableHeader = (key: StreamSortKey, label: string) => <SortableHeader
    label={label}
    active={sort.key === key}
    direction={sort.direction}
    onSort={() => changeSort(key)}
  />;
  const suggestedMode = mp4SourceType === 'URL' ? suggestStreamViewMode(url) : null;
  const modeInfo = streamViewModeInfo[mode];

  return <>
    <header className="page-header">
      <div><h1>Stream View</h1><p>Kelola stream mandiri dari WebRTC, YouTube, HLS, MJPEG, MP4, atau halaman embed.</p></div>
      <div className="actions"><button onClick={() => void load()}>Refresh</button><button className="primary" onClick={() => openEditor()}>+ Tambah Stream</button></div>
    </header>
    {error && <div className="alert error">{error}</div>}
    {notice && <div className="alert warning">{notice}</div>}
    <section className="panel">
      <div className="table-wrap">
        <table>
          <thead><tr>
            {sortableHeader('name', 'Stream & keterangan')}
            {sortableHeader('url', 'URL stream')}
            {sortableHeader('mode', 'Tipe')}
            {sortableHeader('ptz', 'PTZ')}
            {sortableHeader('enabled', 'Tampil di Viewer')}
            {sortableHeader('updatedAt', 'Terakhir diubah')}
            <th>Aksi</th>
          </tr></thead>
          <tbody>
            {sortedStreams.map((stream) => <tr key={stream.id}>
              <td><b>{stream.name}</b><small className="table-description">{stream.description || 'Belum ada keterangan.'}</small></td>
              <td><span className="truncate">{stream.urlMasked}</span></td>
              <td>{stream.mode}</td>
              <td>{stream.ptz.enabled
                ? <><PtzConnectionIndicator connection={stream.ptz.connection} provider={stream.ptz.provider} /><small>{stream.ptz.zoomEnabled ? 'Pan, tilt & zoom' : 'Pan & tilt'}</small></>
                : <PtzConnectionIndicator connection={stream.ptz.connection} />}</td>
              <td><button className={`switch ${stream.enabled ? 'switch-on' : ''}`} aria-label={`${stream.enabled ? 'Sembunyikan' : 'Tampilkan'} ${stream.name} di Viewer`} aria-pressed={stream.enabled} onClick={() => void toggleEnabled(stream)}><span /></button></td>
              <td>{new Date(stream.updatedAt).toLocaleString('id-ID')}</td>
              <td><div className="actions"><button onClick={() => openEditor(stream)}>Edit</button><button className="danger" onClick={() => void remove(stream)}>Hapus</button></div></td>
            </tr>)}
            {!streams.length && <tr><td colSpan={7} className="empty">Belum ada Stream View. Stream dapat ditambahkan langsung tanpa membuat Stream Route.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
    {editorOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
      <section ref={dialogRef} className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="stream-view-editor-title" tabIndex={-1}>
        <header className="modal-header"><div><h2 id="stream-view-editor-title">{editing ? 'Edit Stream View' : 'Tambah Stream View'}</h2><p>Link ini berdiri sendiri dan langsung tersedia untuk layar Viewer.</p></div><button className="icon-button" aria-label="Tutup pengaturan" onClick={closeEditor}>×</button></header>
        {formError && <div className="alert error">{formError}{editorState === 'failed' && editing && <> <button type="button" onClick={() => loadEditorDetails(editing)}>Muat ulang</button></>}</div>}
        <form className="form-grid" onSubmit={submit}>
          <label>Nama stream<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Kamera Lobby" /></label>
          <label>Tipe stream<select value={mode} onChange={(event) => {
            const nextMode = event.target.value as StreamViewMode;
            setMode(nextMode);
            if (nextMode !== 'MP4' && mp4SourceType === 'FILE') {
              setMp4SourceType('URL');
              setUrl('');
            }
          }}>
            {(Object.entries(streamViewModeInfo) as [StreamViewMode, (typeof streamViewModeInfo)[StreamViewMode]][]).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
          </select><small>Pilihan ini menjadi sumber kebenaran; deteksi URL hanya saran.</small></label>
          <label className="full">Deskripsi / keterangan<textarea rows={3} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Contoh: Kamera area lobby lantai satu" /></label>
          {mode === 'MP4' && <fieldset className="full stream-source-choice">
            <legend>Sumber MP4</legend>
            <label className="check"><input type="radio" name="mp4-source" checked={mp4SourceType === 'URL'} onChange={() => { setMp4SourceType('URL'); setUrl(''); }} /> URL HTTP/HTTPS</label>
            <label className="check"><input type="radio" name="mp4-source" checked={mp4SourceType === 'FILE'} onChange={() => { setMp4SourceType('FILE'); setUrl(''); }} /> File Server</label>
          </fieldset>}
          {mode === 'MP4' && mp4SourceType === 'FILE'
            ? <label className="full">Path file MP4 di server
              <div className="input-actions">
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="/mnt/recordings/contoh.mp4" required disabled={editorState !== 'ready'} />
                <button type="button" onClick={() => setFileBrowserOpen(true)} disabled={editorState !== 'ready'}>Browse…</button>
              </div>
              <small>Path absolute juga dapat diketik langsung. File disajikan lewat aplikasi agar seeking dan akses Viewer tetap aman.</small>
            </label>
            : <label className="full">URL {modeInfo.label}<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={editorState === 'loading' ? 'Memuat URL tersimpan…' : modeInfo.placeholder} required disabled={editorState !== 'ready'} /><small>{modeInfo.help}</small></label>}
          {suggestedMode && suggestedMode !== mode && <div className="stream-type-suggestion full"><span>URL tampak seperti <b>{streamViewModeInfo[suggestedMode].label}</b>.</span><button type="button" onClick={() => setMode(suggestedMode)}>Gunakan saran</button></div>}
          <label className="check full"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Tampilkan di Viewer</label>
          {editorState === 'ready'
            ? <PtzConfigFields
              value={ptz}
              onChange={setPtz}
              brokers={brokers}
              onTest={() => void testPtzConnection()}
              testing={testingPtz}
              canTest={Boolean(editing)}
            />
            : <p className="empty full">{editorState === 'loading' ? 'Memuat konfigurasi PTZ…' : 'Konfigurasi PTZ belum termuat.'}</p>}
          <div className="form-actions full"><button type="button" onClick={closeEditor}>Batal</button><button className="primary" disabled={editorState !== 'ready'}>Simpan Stream View</button></div>
        </form>
      </section>
    </div>}
    {fileBrowserOpen && <Mp4FileBrowser
      initialPath={url}
      onClose={() => setFileBrowserOpen(false)}
      onSelect={(selectedPath) => {
        setUrl(selectedPath);
        setFileBrowserOpen(false);
      }}
    />}
  </>;
}
