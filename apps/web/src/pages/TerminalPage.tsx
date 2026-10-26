import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { useStreamEvents } from '../hooks/useStreamEvents';
import type { StreamRoute } from '../types';
import { keyLogLines, routeLogsPath, type LogLine } from './route-logs';

const LOG_POLL_MS = 2500;

export function TerminalPage() {
  const [routes, setRoutes] = useState<StreamRoute[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [query, setQuery] = useState('');
  const [component, setComponent] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState('');
  const terminalRef = useRef<HTMLDivElement>(null);
  const logRequest = useRef(0);

  const loadRoutes = useCallback(async () => {
    try {
      const items = (await api<{ items: StreamRoute[] }>('/api/routes')).items;
      setRoutes(items);
      setSelectedId((current) => {
        if (current && items.some((route) => route.id === current)) return current;
        return items.find((route) => route.runtime.status === 'RUNNING')?.id ?? items[0]?.id ?? '';
      });
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    // Respons yang terlambat (route/komponen lama atau request yang sudah disusul) dibuang.
    const request = ++logRequest.current;
    if (component !== 'MEDIAMTX' && !selectedId) {
      setLogs([]);
      return;
    }
    try {
      const result = await api<{ items: LogLine[] }>(component === 'MEDIAMTX'
        ? '/api/logs/mediamtx?limit=500'
        : routeLogsPath(selectedId, 500, component));
      if (request !== logRequest.current) return;
      setLogs(result.items);
      setError('');
    } catch (reason) {
      if (request !== logRequest.current) return;
      setError((reason as Error).message);
    }
  }, [selectedId, component]);

  useEffect(() => { void loadRoutes(); }, [loadRoutes]);
  useEffect(() => {
    let active = true;
    let polling = false;
    let timer: number | undefined;
    // Poll berikutnya dijadwalkan setelah poll sebelumnya selesai dan dijeda saat tab tersembunyi.
    const poll = async () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (!active || polling || document.hidden) return;
      polling = true;
      try {
        await loadLogs();
      } finally {
        polling = false;
      }
      if (active && !document.hidden) timer = window.setTimeout(() => void poll(), LOG_POLL_MS);
    };
    const onVisibilityChange = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadLogs]);
  useStreamEvents(loadRoutes);

  const keyedLogs = useMemo(() => keyLogLines(logs), [logs]);
  const filteredLogs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return keyedLogs;
    return keyedLogs.filter(({ line }) => `${line.timestamp ?? ''} ${line.level ?? ''} ${line.message ?? ''}`.toLowerCase().includes(normalized));
  }, [keyedLogs, query]);

  useEffect(() => {
    if (autoScroll && terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [filteredLogs, autoScroll]);

  const selectedRoute = routes.find((route) => route.id === selectedId);

  return <>
    <header className="page-header">
      <div><h1>Terminal</h1><p>Log FFmpeg per-route, MediaMTX shared service, recording, dan lifecycle sistem.</p></div>
      <button onClick={() => void Promise.all([loadRoutes(), loadLogs()])}>Refresh</button>
    </header>
    {error && <div className="alert error">{error}</div>}
    <section className="panel terminal-toolbar">
      <label>Stream Route<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={!routes.length}>
        {!routes.length && <option value="">Belum ada route</option>}
        {routes.map((route) => <option key={route.id} value={route.id}>{route.name} — {route.runtime.status}</option>)}
      </select></label>
      <label>Komponen<select value={component} onChange={(event) => setComponent(event.target.value)}>
        <option value="">Semua komponen</option>
        <option value="FFMPEG_ONLINE">FFmpeg Online</option>
        <option value="MEDIAMTX">MediaMTX</option>
        <option value="RECORDING">Recording</option>
        <option value="SYSTEM">System</option>
      </select></label>
      <label>Filter log<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari error, warning, codec…" /></label>
      <label className="check terminal-auto-scroll"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Ikuti log terbaru</label>
    </section>
    <section className="terminal-shell">
      <header>
        <div><span className="terminal-dot terminal-dot-red" /><span className="terminal-dot terminal-dot-orange" /><span className="terminal-dot terminal-dot-green" /></div>
        <b>{component === 'MEDIAMTX' ? 'MediaMTX Shared Service' : selectedRoute?.name ?? 'Tidak ada route dipilih'}</b>
        {component !== 'MEDIAMTX' && selectedRoute && <StatusBadge status={selectedRoute.enabled ? selectedRoute.runtime.status : 'DISABLED'} />}
      </header>
      <div className="terminal-output" ref={terminalRef}>
        {filteredLogs.map(({ key, line }) => <div className={`terminal-line terminal-level-${(line.level ?? 'info').toLowerCase()}`} key={key}>
          <time>{line.timestamp ? new Date(line.timestamp).toLocaleTimeString('id-ID') : '--:--:--'}</time>
          <b>{line.component ? line.component.replace('_', ' ') : (line.level ?? 'INFO').toUpperCase()}</b>
          <code>{line.message ?? ''}</code>
        </div>)}
        {!filteredLogs.length && <div className="terminal-empty">{component === 'MEDIAMTX' ? 'Belum ada output MediaMTX.' : selectedRoute ? 'Belum ada output log untuk route ini.' : 'Tambahkan Stream Route untuk mulai melihat log terminal.'}</div>}
      </div>
      <footer>{filteredLogs.length} / {logs.length} baris · diperbarui otomatis setiap 2,5 detik</footer>
    </section>
  </>;
}
