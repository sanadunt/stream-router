import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { useStreamEvents } from '../hooks/useStreamEvents';
import type { StreamRoute } from '../types';
import { routeLogsPath } from './route-logs';

interface LogLine { timestamp?: string; level?: string; message?: string; }
interface Run { id: string; status: string; pid: number | null; startedAt: string | null; stoppedAt: string | null; exitCode: number | null; restartCount: number; }

export function RouteDetailPage({ routeId, onBack }: { routeId: string; onBack: () => void }) {
  const [route, setRoute] = useState<StreamRoute | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [routeData, logData, runData] = await Promise.all([
        api<StreamRoute>(`/api/routes/${routeId}`),
        api<{ items: LogLine[] }>(routeLogsPath(routeId, 300)),
        api<{ items: Run[] }>(`/api/routes/${routeId}/runs?limit=30`)
      ]);
      setRoute(routeData); setLogs(logData.items); setRuns(runData.items); setError('');
    } catch (reason) { setError((reason as Error).message); }
  }, [routeId]);
  useEffect(() => { void load(); }, [load]);
  useStreamEvents(load, { routeId });
  return <><header className="page-header"><div><button className="link" onClick={onBack}>← Dashboard</button><h1>{route?.name ?? 'Route Detail'}</h1><p>Status, riwayat run, dan log FFmpeg terbaru.</p></div><button onClick={() => void load()}>Refresh</button></header>
    {error && <div className="alert error">{error}</div>}
    {route && <section className="detail-grid"><div className="panel"><h2>Status</h2><dl><dt>Status</dt><dd><StatusBadge status={route.enabled ? route.runtime.status : 'DISABLED'} /></dd><dt>PID</dt><dd>{route.runtime.pid ?? '-'}</dd><dt>Restart count</dt><dd>{route.runtime.restartCount}</dd><dt>Mode</dt><dd>{route.ffmpegMode}</dd><dt>Input</dt><dd className="break">{route.inputUrlMasked}</dd><dt>Output</dt><dd>{route.outputCount}</dd><dt>Last error</dt><dd className="break">{route.runtime.lastError ?? '-'}</dd></dl></div>
      <div className="panel"><h2>Run Timeline</h2><div className="timeline">{runs.map((run) => <div key={run.id}><b>{run.status}</b><span>PID {run.pid ?? '-'} · exit {run.exitCode ?? '-'} · restart {run.restartCount}</span><small>{run.startedAt ?? 'belum mulai'} → {run.stoppedAt ?? 'aktif'}</small></div>)}</div></div></section>}
    <section className="panel"><h2>Log Terbaru</h2><div className="log-view">{logs.map((line, index) => <div key={`${line.timestamp}-${index}`}><span>{line.timestamp}</span><b>{line.level}</b><code>{line.message}</code></div>)}{!logs.length && <p>Belum ada log.</p>}</div></section>
  </>;
}
