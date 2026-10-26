import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { compareSortValues, SortableHeader, type SortDirection } from '../components/SortableHeader';
import { StatusBadge } from '../components/StatusBadge';
import { useModalFocus } from '../hooks/useModalFocus';
import { useStreamEvents } from '../hooks/useStreamEvents';
import type { StreamRoute } from '../types';

const mqttExamples = [
  { label: 'Gerak kiri', payload: { type: 'move', direction: 'left', speed: 0.4, durationMs: 0 } },
  { label: 'Berhenti', payload: { type: 'stop', direction: 'stop', speed: 0.4, durationMs: 0 } },
  { label: 'Zoom in', payload: { type: 'zoom', direction: 'null', speed: 0.4, durationMs: 0 } },
  { label: 'Zoom out', payload: { type: 'zoom', direction: 'null', speed: -0.4, durationMs: 0 } }
] as const;

function MqttInstructionModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState('');
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);
  async function copy(label: string, payload: object) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload));
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? '' : current), 1600);
    } catch {
      setCopied('Gagal menyalin');
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialogRef} className="modal-panel mqtt-instruction-modal" role="dialog" aria-modal="true" aria-labelledby="mqtt-instruction-title" tabIndex={-1}>
      <header className="modal-header">
        <div><h2 id="mqtt-instruction-title">Instruction MQTT PTZ</h2><p>Publish JSON ke Command Topic kamera yang tercantum pada Dashboard.</p></div>
        <button type="button" className="icon-button" aria-label="Tutup instruction MQTT" onClick={onClose}>×</button>
      </header>
      <div className="mqtt-instruction-note">
        <b>Ketentuan publish</b>
        <span>QoS 0 · Retain false · Direction move: left, up, right, atau down.</span>
        <span>Untuk MQTT→ONVIF bridge, topic berakhiran <code>/status</code> hanya untuk presence kamera dan bukan topic command.</span>
      </div>
      <div className="mqtt-instruction-grid">
        {mqttExamples.map((example) => <article key={example.label}>
          <div><b>{example.label}</b><button type="button" className="secondary" onClick={() => void copy(example.label, example.payload)}>{copied === example.label ? 'Tersalin' : 'Copy'}</button></div>
          <code>{JSON.stringify(example.payload)}</code>
        </article>)}
      </div>
      {copied === 'Gagal menyalin' && <div className="alert error">Clipboard browser tidak tersedia. Payload tetap dapat disalin manual.</div>}
    </section>
  </div>;
}

function formatUptime(ms: number): string {
  if (!ms) return '-';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}j ${minutes}m ${seconds % 60}d`;
}

function mqttUsageLabel(usage: Array<'BRIDGE' | 'PTZ'>): string {
  if (usage.includes('BRIDGE') && usage.includes('PTZ')) return 'Bridge ONVIF + PTZ publish';
  return usage.includes('BRIDGE') ? 'Bridge ONVIF' : 'PTZ publish';
}

type DashboardSortKey = 'name' | 'status' | 'input' | 'mqtt' | 'output' | 'pid' | 'uptime' | 'restart';

function dashboardSortValue(route: StreamRoute, key: DashboardSortKey): string | number {
  switch (key) {
    case 'name': return route.name;
    case 'status': return route.enabled ? route.runtime.status : 'DISABLED';
    case 'input': return `${route.inputHost} ${route.inputProtocol} ${route.inputUrlMasked}`;
    case 'mqtt': return (route.mqttTopics ?? []).map((topic) => `${topic.brokerName} ${topic.commandTopic}`).join(' ');
    case 'output': return route.outputCount;
    case 'pid': return route.runtime.pid ?? -1;
    case 'uptime': return route.runtime.uptimeMs;
    case 'restart': return route.runtime.restartCount;
  }
}

export function DashboardPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [routes, setRoutes] = useState<StreamRoute[]>([]);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [sort, setSort] = useState<{ key: DashboardSortKey; direction: SortDirection }>({ key: 'name', direction: 'asc' });
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setRoutes((await api<{ items: StreamRoute[] }>('/api/routes')).items); setError(''); }
    catch (reason) { setError((reason as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useStreamEvents(load);
  const counts = useMemo(() => Object.fromEntries(['RUNNING', 'STOPPED', 'FAILED', 'RESTARTING'].map((s) => [s, routes.filter((r) => r.runtime.status === s).length])), [routes]);
  const sortedRoutes = useMemo(() => [...routes].sort((left, right) => {
    const result = compareSortValues(dashboardSortValue(left, sort.key), dashboardSortValue(right, sort.key));
    return sort.direction === 'asc' ? result : -result;
  }), [routes, sort]);
  function changeSort(key: DashboardSortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  }
  const sortableHeader = (key: DashboardSortKey, label: string) => <SortableHeader
    label={label}
    active={sort.key === key}
    direction={sort.direction}
    onSort={() => changeSort(key)}
  />;
  async function command(id: string, action: string) {
    try { await api(`/api/routes/${id}/${action}`, { method: 'POST' }); await load(); }
    catch (reason) { setError((reason as Error).message); }
  }
  const closeInstruction = useCallback(() => setInstructionOpen(false), []);
  return <>
    <header className="page-header"><div><h1>Dashboard</h1><p>Status ingest MediaMTX, endpoint kamera, MQTT, dan relay online FFmpeg.</p></div><div className="actions"><button type="button" className="secondary" onClick={() => setInstructionOpen(true)}>⌘ Instruction MQTT</button><button type="button" className="secondary" onClick={() => void load()}>Refresh</button></div></header>
    {error && <div className="alert error">{error}</div>}
    <section className="stats">
      <div><span>Total Route</span><b>{routes.length}</b></div><div><span>Running</span><b>{counts.RUNNING}</b></div><div><span>Stopped</span><b>{counts.STOPPED}</b></div><div><span>Failed</span><b>{counts.FAILED}</b></div><div><span>Restarting</span><b>{counts.RESTARTING}</b></div>
    </section>
    <section className="panel"><div className="table-wrap"><table><thead><tr>
      {sortableHeader('name', 'Route')}
      {sortableHeader('status', 'Status')}
      {sortableHeader('input', 'IP / Input')}
      {sortableHeader('mqtt', 'MQTT Topic')}
      {sortableHeader('output', 'Output')}
      {sortableHeader('pid', 'PID')}
      {sortableHeader('uptime', 'Uptime')}
      {sortableHeader('restart', 'Restart')}
      <th>Aksi</th>
    </tr></thead><tbody>
      {sortedRoutes.map((route) => <tr key={route.id}><td><button className="link" onClick={() => onOpen(route.id)}>{route.name}</button><small>{route.cameraKey}</small><small>{route.autoStart ? 'Auto-start' : 'Manual'}</small></td><td><StatusBadge status={route.enabled ? route.runtime.status : 'DISABLED'} /></td><td><b className="network-host">{route.inputHost || '-'}</b><small>{route.inputProtocol}</small><small className="truncate">{route.inputUrlMasked}</small></td><td className="mqtt-topic-cell">
        {(route.mqttTopics ?? []).map((topic) => <div className="mqtt-topic-summary" key={`${topic.brokerName}:${topic.commandTopic}`}>
          <small>{topic.brokerName} · {mqttUsageLabel(topic.usage)}</small>
          <code>{topic.commandTopic}</code>
          {topic.statusTopic && <small>Status: {topic.statusTopic}</small>}
        </div>)}
        {!(route.mqttTopics ?? []).length && <span className="empty">-</span>}
      </td><td>{route.outputCount}</td><td>{route.runtime.pid ?? '-'}</td><td>{formatUptime(route.runtime.uptimeMs)}</td><td>{route.runtime.restartCount}</td><td><div className="actions">
        <button onClick={() => void command(route.id, 'start')} disabled={!route.enabled || route.runtime.status === 'RUNNING'}>Start</button>
        <button onClick={() => void command(route.id, 'stop')}>Stop</button><button onClick={() => void command(route.id, 'restart')} disabled={!route.enabled}>Restart</button>
      </div></td></tr>)}
      {!routes.length && <tr><td colSpan={9} className="empty">Belum ada route streaming.</td></tr>}
    </tbody></table></div></section>
    {instructionOpen && <MqttInstructionModal onClose={closeInstruction} />}
  </>;
}
