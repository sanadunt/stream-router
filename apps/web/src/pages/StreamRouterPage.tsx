import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { PtzConnectionIndicator } from '../components/PtzConfigFields';
import { compareSortValues, SortableHeader, type SortDirection } from '../components/SortableHeader';
import { StatusBadge } from '../components/StatusBadge';
import { useModalFocus } from '../hooks/useModalFocus';
import { useStreamEvents } from '../hooks/useStreamEvents';
import type { StreamRoute } from '../types';
import { RouteEditorPage } from './RouteEditorPage';
import { routeLifecycle } from './route-lifecycle';

type RouteSortKey = 'name' | 'status' | 'input' | 'local' | 'recording' | 'online' | 'ptz' | 'process';

function routeSortValue(route: StreamRoute, key: RouteSortKey): string | number | boolean {
  switch (key) {
    case 'name': return `${route.name} ${route.description}`;
    case 'status': return route.enabled ? route.runtime.status : 'DISABLED';
    case 'input': return `${route.inputProtocol} ${route.inputUrlMasked}`;
    case 'local': return `${route.localViewEnabled} ${route.media.state}`;
    case 'recording': return route.recordingEnabled;
    case 'online': return `${route.onlineRelayEnabled} ${route.outputCount} ${route.runtime.status}`;
    case 'ptz': return `${route.ptz.enabled} ${route.ptz.provider} ${route.ptz.connection.state}`;
    case 'process': return route.runtime.status;
  }
}

function retentionLabel(route: StreamRoute): string {
  switch (route.recordingRetentionMode) {
    case 'DAYS': return `${route.recordingRetentionDays} hari`;
    case 'SIZE': return `${route.recordingRetentionGb} GB`;
    case 'DAYS_OR_SIZE': return `${route.recordingRetentionDays} hari / ${route.recordingRetentionGb} GB`;
    default: return 'policy Settings';
  }
}

export function StreamRouterPage() {
  const [routes, setRoutes] = useState<StreamRoute[]>([]);
  const [editorRouteId, setEditorRouteId] = useState<string | null | undefined>(undefined);
  const [sort, setSort] = useState<{ key: RouteSortKey; direction: SortDirection }>({ key: 'name', direction: 'asc' });
  const [error, setError] = useState('');
  const [featureBusy, setFeatureBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const items = (await api<{ items: StreamRoute[] }>('/api/routes')).items;
      setRoutes(items);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useStreamEvents(load);

  async function initialize(route: StreamRoute) {
    try {
      await api(`/api/routes/${route.id}/initialize`, { method: 'POST' });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function stop(route: StreamRoute) {
    try {
      await api(`/api/routes/${route.id}/deinitialize`, { method: 'POST' });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function remove(route: StreamRoute) {
    if (!confirm(`Hapus route "${route.name}"?`)) return;
    try {
      await api(`/api/routes/${route.id}`, { method: 'DELETE' });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function toggleFeature(route: StreamRoute, key: 'localViewEnabled' | 'onlineRelayEnabled' | 'recordingEnabled') {
    const operation = `${route.id}:${key}`;
    if (featureBusy) return;
    setFeatureBusy(operation);
    setError('');
    try {
      await api(`/api/routes/${route.id}/features`, {
        method: 'PUT',
        body: JSON.stringify({ [key]: !route[key] })
      });
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setFeatureBusy('');
    }
  }

  const closeEditor = useCallback(() => {
    setEditorRouteId(undefined);
  }, []);

  async function finishEditor() {
    closeEditor();
    await load();
  }

  const dialogRef = useModalFocus<HTMLElement>(editorRouteId !== undefined, closeEditor);
  const sortedRoutes = useMemo(() => [...routes].sort((left, right) => {
    const result = compareSortValues(routeSortValue(left, sort.key), routeSortValue(right, sort.key));
    return sort.direction === 'asc' ? result : -result;
  }), [routes, sort]);
  function changeSort(key: RouteSortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  }
  const sortableHeader = (key: RouteSortKey, label: string) => <SortableHeader
    label={label}
    active={sort.key === key}
    direction={sort.direction}
    onSort={() => changeSort(key)}
  />;

  return <>
    <header className="page-header">
      <div>
        <h1>Stream Router</h1>
        <p>Kelola ingest MediaMTX, WebRTC lokal, recording, relay online, dan PTZ setiap kamera.</p>
      </div>
      <div className="actions">
        <button onClick={() => void load()}>Refresh</button>
        <button className="primary" onClick={() => setEditorRouteId(null)}>+ Tambah Route</button>
      </div>
    </header>
    {error && <div className="alert error">{error}</div>}
    <section className="panel">
      <div className="table-wrap">
        <table>
          <thead><tr>
            {sortableHeader('name', 'Route & keterangan')}
            {sortableHeader('status', 'Status')}
            {sortableHeader('input', 'Input')}
            {sortableHeader('local', 'Local Media')}
            {sortableHeader('recording', 'Recording')}
            {sortableHeader('online', 'Relay Online')}
            {sortableHeader('ptz', 'PTZ')}
            {sortableHeader('process', 'Lifecycle')}
            <th>Aksi</th>
          </tr></thead>
          <tbody>
            {sortedRoutes.map((route) => {
              const lifecycle = routeLifecycle(route.name, route.runtime.status);
              const recordingBusy = featureBusy === `${route.id}:recordingEnabled`;
              return <tr key={route.id}>
              <td><b>{route.name}</b><small>{route.cameraKey}</small><small className="table-description">{route.description || 'Belum ada keterangan.'}</small></td>
              <td><StatusBadge status={route.enabled ? route.runtime.status : 'DISABLED'} /></td>
              <td>{route.inputProtocol}<small className="truncate">{route.inputUrlMasked}</small></td>
              <td><div className="feature-status"><button className={`switch ${route.localViewEnabled ? 'switch-on' : ''}`} aria-label={`Ubah Local Media ${route.name}`} aria-pressed={route.localViewEnabled} disabled={Boolean(featureBusy)} onClick={() => void toggleFeature(route, 'localViewEnabled')}><span /></button><small title={route.media.codecMessage ?? undefined}>{!route.localViewEnabled ? 'Tidak aktif' : route.media.ready ? route.media.codecCompatible === false ? `${route.localAudioMode} · CODEC ⚠` : `${route.localAudioMode} · READY` : `${route.localAudioMode} · ${route.media.state}`}</small></div></td>
              <td><div className="feature-status"><button className={`switch ${route.recordingEnabled ? 'switch-on' : ''}`} aria-label={`Ubah Recording ${route.name}`} aria-pressed={route.recordingEnabled} disabled={Boolean(featureBusy)} onClick={() => void toggleFeature(route, 'recordingEnabled')}><span /></button><small>{recordingBusy ? 'Menerapkan…' : !route.recordingEnabled ? 'Tidak aktif' : route.components.recording.storagePaused ? 'PAUSED · storage' : route.components.recording.active ? `AKTIF · ${retentionLabel(route)}` : `Menunggu ingest · ${retentionLabel(route)}`}</small></div></td>
              <td><div className="feature-status"><button className={`switch ${route.onlineRelayEnabled ? 'switch-on' : ''}`} aria-label={`Ubah Relay Online ${route.name}`} aria-pressed={route.onlineRelayEnabled} disabled={Boolean(featureBusy)} onClick={() => void toggleFeature(route, 'onlineRelayEnabled')}><span /></button><small>{route.outputCount} tujuan · {route.onlineRelayEnabled ? route.components.online.status : 'OFF'}</small></div></td>
              <td>{route.ptz.enabled
                ? <><PtzConnectionIndicator connection={route.ptz.connection} provider={route.ptz.provider} /><small>{route.ptz.zoomEnabled ? 'Pan, tilt & zoom' : 'Pan & tilt'}</small></>
                : <PtzConnectionIndicator connection={route.ptz.connection} />}</td>
              <td><div className="process-control">
                <button className={`switch ${lifecycle.active ? 'switch-on' : ''}`} aria-label={lifecycle.switchLabel} title={lifecycle.switchLabel} aria-pressed={lifecycle.active} disabled={!lifecycle.active} onClick={() => void stop(route)}><span /></button>
                {lifecycle.startLabel && <button className="initialize-button" disabled={lifecycle.stopping} title={route.runtime.status === 'FAILED' ? route.runtime.lastError ?? undefined : undefined} onClick={() => void initialize(route)}>{lifecycle.startLabel}</button>}
              </div></td>
              <td><div className="actions"><button onClick={() => setEditorRouteId(route.id)}>Edit</button><button className="danger" onClick={() => void remove(route)}>Hapus</button></div></td>
            </tr>;
            })}
            {!routes.length && <tr><td colSpan={9} className="empty">Belum ada route streaming. Klik “Tambah Route” untuk membuat yang pertama.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
    {editorRouteId !== undefined && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
      <section ref={dialogRef} className="modal-panel modal-large" role="dialog" aria-modal="true" aria-labelledby="route-editor-title" tabIndex={-1}>
        <header className="modal-header"><div><h2 id="route-editor-title">{editorRouteId ? 'Edit Route' : 'Tambah Route'}</h2><p>Credential tersimpan tetap disensor dan tidak pernah ditampilkan ulang.</p></div><button className="icon-button" aria-label="Tutup form" onClick={closeEditor}>×</button></header>
        <RouteEditorPage routeId={editorRouteId ?? undefined} embedded onDone={() => void finishEditor()} />
      </section>
    </div>}
  </>;
}
