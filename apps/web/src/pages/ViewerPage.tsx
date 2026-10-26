import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../api/client';
import { StreamMediaPlayer } from '../components/StreamMediaPlayer';
import { useStreamEvents } from '../hooks/useStreamEvents';
import type { PtzConnectionStatus, ViewerRoute } from '../types';
import { createPtzHoldLoop } from './ptz-hold';
import { singleFlight } from './request-control';

export type LayoutSize = 1 | 2 | 4 | 8;
type MoveDirection = 'left' | 'up' | 'right' | 'down';
type ZoomDirection = 'in' | 'out';
type Motion = { route: ViewerRoute; type: 'move' | 'zoom'; direction: MoveDirection | ZoomDirection };
type SourceChoice = 'auto' | 'local' | 'online';

const MONITOR_SLOT_COUNT = 8;
const monitorSlotsStorageKey = 'stream-router.viewer.routes';
const sourceNamesStorageKey = 'stream-router.viewer.source-names';

export function normalizeMonitorSlots(ids: readonly string[]): string[] {
  const used = new Set<string>();
  return Array.from({ length: MONITOR_SLOT_COUNT }, (_, index) => {
    const id = ids[index] ?? '';
    if (!id || used.has(id)) return '';
    used.add(id);
    return id;
  });
}

/** Susunan monitor tersimpan; null berarti pengguna belum pernah mengatur monitor. */
export function parseStoredMonitorSlots(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as unknown;
    if (!Array.isArray(stored)) return null;
    const slots = normalizeMonitorSlots(stored.map((id) => typeof id === 'string' ? id : ''));
    return slots.some(Boolean) ? slots : null;
  } catch {
    return null;
  }
}

/**
 * Pilihan monitor pengguna terpisah dari ketersediaan sumber: sumber yang sementara
 * tidak RUNNING (relay restart, MediaMTX reload, boot recovery) tetap menempati
 * slotnya dan tampil lagi saat ready. Tanpa pilihan tersimpan, monitor mengikuti
 * sumber ready sesuai layout.
 */
export function resolveMonitorSlots(
  configured: readonly string[] | null,
  availableIds: readonly string[],
  layout: LayoutSize
): string[] {
  if (configured) return normalizeMonitorSlots(configured);
  return normalizeMonitorSlots(availableIds.slice(0, layout));
}

/**
 * Nama sumber yang pernah terlihat. Daftar Viewer hanya memuat sumber ready, jadi tanpa nama
 * tersimpan monitor yang menunggu sumber offline/terhapus menampilkan UUID setelah reload.
 */
export function parseStoredSourceNames(value: string | null): Map<string, string> {
  if (!value) return new Map();
  try {
    const stored = JSON.parse(value) as unknown;
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return new Map();
    return new Map(Object.entries(stored).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && entry[1].length > 0
    )));
  } catch {
    return new Map();
  }
}

/** Hanya nama sumber yang menempati monitor yang disimpan, agar storage tidak tumbuh tanpa batas. */
export function sourceNamesForSlots(names: ReadonlyMap<string, string>, slotIds: readonly string[]): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const id of slotIds) {
    const name = id ? names.get(id) : undefined;
    if (name) entries.push([id, name]);
  }
  return Object.fromEntries(entries);
}

export function assignMonitorSlot(slots: readonly string[], index: number, id: string): string[] {
  const next = normalizeMonitorSlots(slots).map((selectedId) => id && selectedId === id ? '' : selectedId);
  next[index] = id;
  return next;
}

function browserReachableLocalUrl(value: string, pageHostname: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (['localhost', '127.0.0.1', '0.0.0.0', '::', '::1'].includes(host) && pageHostname) {
      url.hostname = pageHostname;
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function normalizeLocalViewerRoute(route: ViewerRoute, pageHostname: string): ViewerRoute {
  const sources = route.sources;
  const local = sources?.local;
  if (!local) return route;
  const normalizedLocal = {
    ...local,
    url: browserReachableLocalUrl(local.url, pageHostname),
    ...(local.openUrl ? { openUrl: browserReachableLocalUrl(local.openUrl, pageHostname) } : {})
  };
  return {
    ...route,
    webrtc: sources.preferred === 'local' ? normalizedLocal : route.webrtc,
    sources: { local: normalizedLocal, online: sources.online, preferred: sources.preferred }
  };
}

export function ViewerPage({ canControlPtz }: { canControlPtz: boolean }) {
  const [routes, setRoutes] = useState<ViewerRoute[]>([]);
  const [layout, setLayout] = useState<LayoutSize>(() => {
    const stored = Number(localStorage.getItem('stream-router.viewer.layout'));
    return stored === 1 || stored === 2 || stored === 4 || stored === 8 ? stored : 4;
  });
  const [configuredMonitorIds, setConfiguredMonitorIds] = useState<string[] | null>(() => {
    try {
      return parseStoredMonitorSlots(localStorage.getItem(monitorSlotsStorageKey));
    } catch {
      return null;
    }
  });
  const [sourceChoices, setSourceChoices] = useState<Record<string, SourceChoice>>(() => {
    try {
      return JSON.parse(localStorage.getItem('stream-router.viewer.sources') ?? '{}') as Record<string, SourceChoice>;
    } catch {
      return {};
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [activePtz, setActivePtz] = useState<ViewerRoute | null>(null);
  const [ptzError, setPtzError] = useState('');
  const [error, setError] = useState('');
  // Map stabil yang diisi di tempat (seperti ref); nilai awal dari nama tersimpan di browser.
  const [knownSourceNames] = useState(() => {
    try {
      return parseStoredSourceNames(localStorage.getItem(sourceNamesStorageKey));
    } catch {
      return new Map<string, string>();
    }
  });
  const speedRef = useRef(0.4);
  const settingsAnchorRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLElement>(null);

  const fetchRoutes = useCallback(async () => {
    try {
      const items = (await api<{ items: ViewerRoute[] }>('/api/viewer/routes')).items
        .map((route) => normalizeLocalViewerRoute(route, window.location.hostname));
      for (const route of items) knownSourceNames.set(route.id, route.name);
      setRoutes(items);
      setActivePtz((current) => current ? items.find((route) => route.id === current.id && route.ptz.enabled) ?? null : null);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, [knownSourceNames]);
  // Satu request aktif per tab: event SSE yang datang saat request berjalan digabung
  // menjadi satu muat ulang, sehingga respons lama tidak menimpa daftar yang lebih baru.
  const load = useMemo(() => singleFlight(fetchRoutes), [fetchRoutes]);

  const sendCommand = useCallback(async (
    route: ViewerRoute,
    command: { type: 'move'; direction: MoveDirection; speed: number; durationMs: 0 }
      | { type: 'zoom'; direction: ZoomDirection; speed: number; durationMs: 0 }
      | { type: 'stop'; direction: 'stop'; speed: number; durationMs: 0 }
  ) => {
    try {
      const result = await api<{ ok: true; connection: PtzConnectionStatus }>('/api/viewer/ptz/command', {
        method: 'POST',
        body: JSON.stringify({
          targetType: route.ptz.targetType,
          targetId: route.ptz.targetId,
          command
        })
      });
      setRoutes((current) => current.map((item) => item.id === route.id
        ? { ...item, ptz: { ...item.ptz, connection: result.connection } }
        : item));
      setActivePtz((current) => current?.id === route.id
        ? { ...current, ptz: { ...current.ptz, connection: result.connection } }
        : current);
      setPtzError('');
    } catch (reason) {
      setPtzError((reason as Error).message);
    }
  }, []);

  // useState (bukan useMemo) agar loop tidak pernah dibuat ulang selagi interval
  // loop lama masih berjalan; sendCommand stabil sepanjang umur halaman.
  const [holdLoop] = useState(() => createPtzHoldLoop<Motion>({
    send: (current) => {
      if (current.type === 'move') {
        void sendCommand(current.route, { type: 'move', direction: current.direction as MoveDirection, speed: speedRef.current, durationMs: 0 });
      } else {
        void sendCommand(current.route, { type: 'zoom', direction: current.direction as ZoomDirection, speed: speedRef.current, durationMs: 0 });
      }
    },
    stop: (current) => {
      void sendCommand(current.route, { type: 'stop', direction: 'stop', speed: speedRef.current, durationMs: 0 });
    }
  }));
  const stopMotion = useCallback(() => holdLoop.stop(), [holdLoop]);
  const startMotion = useCallback((next: Motion) => holdLoop.start(next), [holdLoop]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { localStorage.setItem('stream-router.viewer.layout', String(layout)); }, [layout]);
  // Hanya pilihan eksplisit pengguna yang disimpan, bukan ketersediaan sumber sesaat.
  useEffect(() => {
    if (configuredMonitorIds) localStorage.setItem(monitorSlotsStorageKey, JSON.stringify(configuredMonitorIds));
  }, [configuredMonitorIds]);
  useEffect(() => {
    if (!configuredMonitorIds) return;
    try {
      localStorage.setItem(sourceNamesStorageKey, JSON.stringify(sourceNamesForSlots(knownSourceNames, configuredMonitorIds)));
    } catch {
      // Nama tersimpan hanya pelengkap label monitor.
    }
  }, [configuredMonitorIds, knownSourceNames, routes]);
  useEffect(() => { localStorage.setItem('stream-router.viewer.sources', JSON.stringify(sourceChoices)); }, [sourceChoices]);
  useStreamEvents(load);

  // Tombol PTZ yang sedang ditahan kehilangan event lepas saat fokus/tab berpindah
  // atau overlay di-unmount; hentikan gerakan agar kamera tidak terus bergerak.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) stopMotion();
    };
    window.addEventListener('blur', stopMotion);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', stopMotion);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [stopMotion]);

  useEffect(() => {
    const current = holdLoop.active();
    if (!current) return;
    const stillControllable = activePtz?.id === current.route.id
      && routes.some((route) => route.id === current.route.id && route.ptz.enabled);
    if (!stillControllable) stopMotion();
  }, [activePtz, holdLoop, routes, stopMotion]);

  useEffect(() => {
    if (!settingsOpen) return;
    const panel = settingsPanelRef.current;
    const button = settingsButtonRef.current;
    const syncPopoverBounds = () => {
      if (!panel || !button) return;
      const buttonBounds = button.getBoundingClientRect();
      panel.style.width = `${Math.max(260, Math.min(390, window.innerWidth - 24, buttonBounds.right - 12))}px`;
      panel.style.maxHeight = `${Math.max(180, Math.min(620, window.innerHeight - buttonBounds.bottom - 12))}px`;
    };
    syncPopoverBounds();
    window.addEventListener('resize', syncPopoverBounds);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel?.querySelector<HTMLElement>('button, input, select')?.focus();
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !settingsAnchorRef.current?.contains(event.target)) {
        setSettingsOpen(false);
      }
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSettingsOpen(false);
      settingsButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', syncPopoverBounds);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [settingsOpen]);

  useEffect(() => {
    const restore = () => {
      document.body.classList.remove('viewer-focus-mode');
      setFocusMode(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      stopMotion();
      restore();
      setSettingsOpen(false);
      if (document.fullscreenElement) void document.exitFullscreen();
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) restore();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      stopMotion();
      restore();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [stopMotion]);

  const monitorIds = resolveMonitorSlots(configuredMonitorIds, routes.map((route) => route.id), layout);
  const monitors = Array.from({ length: layout }, (_, index) => ({
    index,
    assignedId: monitorIds[index] ?? '',
    route: routes.find((route) => route.id === monitorIds[index]) ?? null
  }));
  const sourceLabel = (id: string) => knownSourceNames.get(id) ?? id;

  function streamSource(route: ViewerRoute) {
    const choice = sourceChoices[route.id] ?? 'auto';
    if (choice === 'local' && route.sources?.local) return route.sources.local;
    if (choice === 'online' && route.sources?.online) return route.sources.online;
    if (route.sources?.local?.compatible !== false) return route.sources?.local ?? route.sources?.online ?? route.webrtc;
    return route.sources?.online ?? route.sources?.local ?? route.webrtc;
  }

  function updateMonitor(index: number, id: string) {
    const previousId = monitorIds[index] ?? '';
    setConfiguredMonitorIds(assignMonitorSlot(monitorIds, index, id));
    if (activePtz?.id === previousId && previousId !== id) {
      stopMotion();
      setActivePtz(null);
    }
  }

  async function enterFocusMode() {
    setSettingsOpen(false);
    setActivePtz(null);
    document.body.classList.add('viewer-focus-mode');
    setFocusMode(true);
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch {
      // CSS focus mode remains available when browser fullscreen permission is unavailable.
    }
  }

  async function leaveFocusMode() {
    stopMotion();
    document.body.classList.remove('viewer-focus-mode');
    setFocusMode(false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }

  function ptzPointerDown(event: PointerEvent<HTMLButtonElement>, next: Motion) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startMotion(next);
  }

  function ptzKeyDown(event: KeyboardEvent<HTMLButtonElement>, next: Motion) {
    if (event.repeat || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    startMotion(next);
  }

  function openPtz(route: ViewerRoute) {
    stopMotion();
    setSettingsOpen(false);
    setPtzError('');
    setActivePtz((current) => current?.id === route.id ? null : route);
  }

  const motionButton = (route: ViewerRoute, label: string, symbol: string, type: Motion['type'], direction: Motion['direction'], className = '') => (
    <button
      type="button"
      className={className}
      aria-label={label}
      onPointerDown={(event) => ptzPointerDown(event, { route, type, direction })}
      onPointerUp={stopMotion}
      onPointerCancel={stopMotion}
      onLostPointerCapture={stopMotion}
      onKeyDown={(event) => ptzKeyDown(event, { route, type, direction })}
      onKeyUp={(event) => { if (['Enter', ' '].includes(event.key)) stopMotion(); }}
      onBlur={stopMotion}
      onContextMenu={(event) => event.preventDefault()}
    >{symbol}</button>
  );

  return <>
    <header className="page-header viewer-page-header">
      <div><h1>Viewer</h1><p>Monitor Stream Route dan Stream View dari berbagai tipe sumber.</p></div>
      <div className="viewer-controls">
        <button onClick={() => void load()}>Refresh</button>
        <button onClick={() => void enterFocusMode()}>Mode Fullscreen</button>
        <div className="viewer-settings-anchor" ref={settingsAnchorRef}>
          <button
            ref={settingsButtonRef}
            className={`viewer-settings-button ${settingsOpen ? 'active' : ''}`}
            aria-label="Pengaturan tampilan Viewer"
            aria-expanded={settingsOpen}
            aria-controls="viewer-display-settings"
            title="Pengaturan tampilan"
            onClick={() => setSettingsOpen((value) => !value)}
          >⚙</button>
          {settingsOpen && <aside ref={settingsPanelRef} id="viewer-display-settings" className="viewer-floating-settings" aria-label="Pengaturan Viewer">
            <header><div><b>Pengaturan Tampilan</b><small>Atur grid dan stream yang ditampilkan.</small></div><button className="icon-button" aria-label="Tutup pengaturan" onClick={() => setSettingsOpen(false)}>×</button></header>
            <fieldset><legend>Jumlah tampilan</legend><div className="layout-options">{([1, 2, 4, 8] as LayoutSize[]).map((size) => <button type="button" key={size} className={layout === size ? 'active' : ''} onClick={() => setLayout(size)}>{size}<small>layar</small></button>)}</div></fieldset>
            <fieldset><legend>Sumber tiap monitor</legend><div className="monitor-slot-list">{monitors.map(({ index, assignedId, route: assignedRoute }) => <label key={index}>
              <span><b>Monitor {index + 1}</b><small>{!assignedId ? 'Belum dipilih' : assignedRoute ? 'Sumber siap ditampilkan' : 'Menunggu sumber ready'}</small></span>
              <select value={assignedId} onChange={(event) => updateMonitor(index, event.target.value)} aria-label={`Sumber Monitor ${index + 1}`}>
                <option value="">Kosongkan monitor</option>
                {assignedId && !assignedRoute && <option value={assignedId}>{sourceLabel(assignedId)} · menunggu sumber</option>}
                {routes.map((route) => <option
                  key={route.id}
                  value={route.id}
                  disabled={monitorIds.some((selectedId, selectedIndex) => selectedIndex !== index && selectedId === route.id)}
                >{route.name} · ready</option>)}
              </select>
            </label>)}</div></fieldset>
            {!routes.length && <p className="empty">Belum ada sumber ready. Jalankan Stream Route atau aktifkan Stream View terlebih dahulu.</p>}
            <small>Setiap sumber hanya dipakai satu monitor. Susunan tersimpan di browser ini.</small>
          </aside>}
        </div>
      </div>
    </header>
    {focusMode && <button className="viewer-exit-focus" onClick={() => void leaveFocusMode()}>Keluar fullscreen</button>}
    {error && <div className="alert error viewer-page-error">{error}</div>}
    {ptzError && <div className="alert error viewer-page-error">{ptzError}</div>}
    <section className={`viewer-grid viewer-grid-${layout}`}>
      {monitors.map(({ route, index, assignedId }) => {
        if (!route) {
          return <article className="viewer-card viewer-empty-slot" key={`monitor-${index}`}>
            <header><div><small className="monitor-slot-label">Monitor {index + 1}</small><b>{assignedId ? sourceLabel(assignedId) : 'Belum ada sumber'}</b></div></header>
            <div className="viewer-empty-monitor"><span>{index + 1}</span><p>{assignedId
              ? 'Menunggu sumber ready. Monitor tampil kembali otomatis saat stream berjalan. Bila sumber sudah dihapus atau dinonaktifkan, kosongkan monitor ini.'
              : 'Pilih sumber ready melalui tombol pengaturan.'}</p>
              {assignedId && <button type="button" onClick={() => updateMonitor(index, '')}>Kosongkan monitor</button>}</div>
          </article>;
        }
        const source = streamSource(route);
        return <article className="viewer-card" key={`monitor-${index}-${route.id}`}>
        <header>
          <div><small className="monitor-slot-label">Monitor {index + 1}</small><b>{route.name}</b>{route.description && <small className="viewer-description">{route.description}</small>}</div>
          <div className="viewer-card-actions">
            {route.sources?.local && route.sources.online && <select
              className="viewer-source-select"
              value={sourceChoices[route.id] ?? 'auto'}
              onChange={(event) => setSourceChoices((current) => ({ ...current, [route.id]: event.target.value as SourceChoice }))}
              aria-label={`Sumber video ${route.name}`}
            ><option value="auto">Auto · Local first</option><option value="local">Local</option><option value="online">Online</option></select>}
            {canControlPtz && route.ptz.enabled && <button
              type="button"
              className={`viewer-ptz-button ${activePtz?.id === route.id ? 'active' : ''}`}
              title={route.ptz.connection.message}
              onClick={() => openPtz(route)}
            ><span className={`ptz-mini-light ptz-mini-light-${route.ptz.connection.state.toLowerCase()}`} />PTZ</button>}
            <a href={source.openUrl ?? source.url} target="_blank" rel="noreferrer" title={`Buka ${route.name} di tab baru`}>Buka di tab baru ↗</a>
            <small>{source.mode}</small>
          </div>
        </header>
        <div className="viewer-media">
          {source.compatible === false
            ? <div className="viewer-whep"><p>{source.codecMessage ?? 'Codec kamera tidak kompatibel dengan browser.'}</p><small>Recording dan relay tetap berjalan tanpa transcoding tambahan.</small></div>
            : <StreamMediaPlayer name={route.name} source={source} />}
          {canControlPtz && activePtz?.id === route.id && <div className="viewer-ptz-overlay" aria-label={`Kontrol PTZ ${route.name}`}>
            <div className="ptz-overlay-dpad">
              {motionButton(route, 'Gerakkan kamera ke atas', '▲', 'move', 'up', 'ptz-up')}
              {motionButton(route, 'Gerakkan kamera ke kiri', '◀', 'move', 'left', 'ptz-left')}
              {motionButton(route, 'Gerakkan kamera ke kanan', '▶', 'move', 'right', 'ptz-right')}
              {motionButton(route, 'Gerakkan kamera ke bawah', '▼', 'move', 'down', 'ptz-down')}
            </div>
            {route.ptz.zoomEnabled && <div className="ptz-overlay-zoom">
              {motionButton(route, 'Zoom keluar', '−', 'zoom', 'out')}
              {motionButton(route, 'Zoom masuk', '+', 'zoom', 'in')}
            </div>}
          </div>}
        </div>
      </article>;
      })}
    </section>
  </>;
}
