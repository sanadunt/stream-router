import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { compareSortValues, SortableHeader, type SortDirection } from '../components/SortableHeader';
import { useModalFocus } from '../hooks/useModalFocus';
import { MAX_RECORDING_BULK_SELECTION, toggleRecordingPageSelection } from './recording-selection';
import { buildTimelineGroups } from './recording-timeline';
import { createRequestSequence } from './request-control';
import type { RecordingSegment, RecordingStorage, StreamRoute } from '../types';

type SortKey = 'camera' | 'start' | 'duration' | 'size' | 'status';
const pageLimits = [5, 10, 20, 50, 100] as const;
const recordingOverlayStorageKey = 'camera-integration.recording.overlays';

export function recordingOverlayPreferences(value: string | null): { info: boolean; buffer: boolean } {
  if (!value) return { info: true, buffer: true };
  try {
    const parsed = JSON.parse(value) as { info?: unknown; buffer?: unknown };
    return {
      info: typeof parsed.info === 'boolean' ? parsed.info : true,
      buffer: typeof parsed.buffer === 'boolean' ? parsed.buffer : true
    };
  } catch {
    return { info: true, buffer: true };
  }
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function duration(value: number): string {
  const total = Math.round(value / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function monthValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(value: string): string {
  const [year, month] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' })
    .format(new Date(year!, month! - 1, 1));
}

const monthNames = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat('id-ID', { month: 'short' }).format(new Date(2024, index, 1))
);

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function bufferedMediaPercent(media: Pick<HTMLMediaElement, 'buffered' | 'duration'>): number {
  if (!Number.isFinite(media.duration) || media.duration <= 0) return 0;
  let bufferedSeconds = 0;
  for (let index = 0; index < media.buffered.length; index += 1) {
    const start = Math.max(0, media.buffered.start(index));
    const end = Math.min(media.duration, media.buffered.end(index));
    bufferedSeconds += Math.max(0, end - start);
  }
  return Math.max(0, Math.min(100, Math.round(bufferedSeconds / media.duration * 100)));
}

function RecordingPlayerModal({
  recording,
  timeZone,
  onClose
}: {
  recording: RecordingSegment;
  timeZone: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [showInfoOverlay, setShowInfoOverlay] = useState(() => (
    recordingOverlayPreferences(localStorage.getItem(recordingOverlayStorageKey)).info
  ));
  const [showBufferOverlay, setShowBufferOverlay] = useState(() => (
    recordingOverlayPreferences(localStorage.getItem(recordingOverlayStorageKey)).buffer
  ));
  const panelRef = useModalFocus<HTMLElement>(true, onClose);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    localStorage.setItem(recordingOverlayStorageKey, JSON.stringify({
      info: showInfoOverlay,
      buffer: showBufferOverlay
    }));
  }, [showBufferOverlay, showInfoOverlay]);

  const timestamp = new Intl.DateTimeFormat('id-ID', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false
  }).format(new Date(new Date(recording.startTime).getTime() + currentTime * 1000));

  function updateBufferedProgress(video: HTMLVideoElement) {
    setBufferedPercent(bufferedMediaPercent(video));
  }

  function screenshot() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setError('Frame video belum siap untuk screenshot.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (showInfoOverlay) {
      const fontSize = Math.max(18, Math.round(canvas.width / 45));
      const padding = Math.round(fontSize * 0.7);
      context.font = `600 ${fontSize}px system-ui, sans-serif`;
      context.textBaseline = 'middle';
      context.fillStyle = 'rgba(7, 12, 15, 0.72)';
      context.fillRect(0, canvas.height - fontSize * 2.5, canvas.width, fontSize * 2.5);
      context.fillStyle = '#fff';
      context.fillText(`${recording.cameraName} · ${timestamp}`, padding, canvas.height - fontSize * 1.25);
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${recording.cameraKey}-${new Date(new Date(recording.startTime).getTime() + currentTime * 1000).toISOString().replaceAll(':', '-')}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }, 'image/png');
  }

  async function fullscreen() {
    try {
      await panelRef.current?.requestFullscreen();
    } catch (reason) {
      setError(`Fullscreen gagal: ${(reason as Error).message}`);
    }
  }

  return <div className="modal-backdrop recording-player-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={panelRef} className="modal-panel modal-large recording-player-modal" role="dialog" aria-modal="true" aria-labelledby="recording-player-title" tabIndex={-1}>
      <header className="modal-header">
        <div><h2 id="recording-player-title">{recording.cameraName}</h2><p>{recording.cameraKey} · {new Date(recording.startTime).toLocaleString('id-ID', { timeZone })}</p></div>
        <div className="actions">
          <button
            type="button"
            className={`recording-overlay-toggle ${showInfoOverlay ? 'active' : ''}`}
            aria-pressed={showInfoOverlay}
            title={showInfoOverlay ? 'Sembunyikan Camera ID dan timestamp' : 'Tampilkan Camera ID dan timestamp'}
            onClick={() => setShowInfoOverlay((value) => !value)}
          >Info: {showInfoOverlay ? 'Show' : 'Hide'}</button>
          <button
            type="button"
            className={`recording-overlay-toggle ${showBufferOverlay ? 'active' : ''}`}
            aria-pressed={showBufferOverlay}
            title={showBufferOverlay ? 'Sembunyikan status buffering' : 'Tampilkan status buffering'}
            onClick={() => setShowBufferOverlay((value) => !value)}
          >Buffer: {showBufferOverlay ? 'Show' : 'Hide'}</button>
          <button onClick={screenshot} disabled={loading || Boolean(error)}>Screenshot</button>
          <button onClick={() => void fullscreen()}>Fullscreen</button>
          <button className="icon-button" aria-label="Tutup player" onClick={onClose}>×</button>
        </div>
      </header>
      {error && <div className="alert error">{error} <button onClick={() => {
        setAttempt((value) => value + 1);
        setError('');
        setLoading(true);
      }}>Coba lagi</button></div>}
      <div className="recording-video-shell">
        {loading && <div className="recording-video-loading">Menyiapkan MP4 playback…</div>}
        <video
          key={`${recording.id}:${attempt}`}
          ref={videoRef}
          src={`/api/recordings/playback?id=${recording.id}`}
          controls
          autoPlay
          playsInline
          preload="auto"
          onLoadStart={() => {
            setLoading(true);
            setBufferedPercent(0);
            setIsPlaying(false);
          }}
          onLoadedMetadata={(event) => {
            setLoading(false);
            setError('');
            updateBufferedProgress(event.currentTarget);
          }}
          onLoadedData={(event) => {
            setLoading(false);
            updateBufferedProgress(event.currentTarget);
          }}
          onCanPlay={(event) => {
            setLoading(false);
            updateBufferedProgress(event.currentTarget);
          }}
          onPlaying={(event) => {
            setLoading(false);
            setIsPlaying(true);
            updateBufferedProgress(event.currentTarget);
          }}
          onPause={() => setIsPlaying(false)}
          onWaiting={() => setLoading(true)}
          onSeeking={() => setLoading(true)}
          onSeeked={(event) => {
            setLoading(false);
            updateBufferedProgress(event.currentTarget);
          }}
          onProgress={(event) => updateBufferedProgress(event.currentTarget)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onEnded={(event) => {
            setLoading(false);
            setIsPlaying(false);
            updateBufferedProgress(event.currentTarget);
          }}
          onError={() => {
            setLoading(false);
            setIsPlaying(false);
            setError('Video tidak dapat diputar. Periksa koneksi, mount storage, HTTP Range, dan kompatibilitas codec kamera.');
          }}
        />
        {showInfoOverlay && <div className="recording-time-overlay"><b>{recording.cameraName}</b><span>{timestamp}</span></div>}
        {showBufferOverlay && <div className="recording-buffer-status" aria-live="polite">
          <div><span>{isPlaying ? 'Streaming progresif' : loading ? 'Buffering' : 'Siap diputar'}</span><b>{bufferedPercent}% tersedia</b></div>
          <div className="recording-buffer-meter"><span style={{ width: `${bufferedPercent}%` }} /></div>
        </div>}
      </div>
    </section>
  </div>;
}

export function RecordingPage({ canManage }: { canManage: boolean }) {
  const [routes, setRoutes] = useState<StreamRoute[]>([]);
  const [items, setItems] = useState<RecordingSegment[]>([]);
  const [total, setTotal] = useState(0);
  const [storage, setStorage] = useState<RecordingStorage | null>(null);
  const [calendarDays, setCalendarDays] = useState<Record<string, { count: number; sizeBytes: number }>>({});
  const [timelineItems, setTimelineItems] = useState<RecordingSegment[]>([]);
  const [timelineTruncated, setTimelineTruncated] = useState(false);
  const [routeId, setRouteId] = useState('');
  const [month, setMonth] = useState(monthValue);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [monthPickerYear, setMonthPickerYear] = useState(() => new Date().getFullYear());
  const [day, setDay] = useState('');
  const [timelineDay, setTimelineDay] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState<(typeof pageLimits)[number]>(10);
  const [playing, setPlaying] = useState<RecordingSegment | null>(null);
  const [focusedId, setFocusedId] = useState('');
  const [selectedItems, setSelectedItems] = useState<RecordingSegment[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'start', direction: 'desc' });
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState('');
  const monthPickerRef = useRef<HTMLDivElement>(null);
  const refreshInFlightRef = useRef(false);
  // Scroll ke baris recording hanya sekali per permintaan buka, bukan setiap polling.
  const pendingScrollIdRef = useRef('');
  const [listSequence] = useState(createRequestSequence);
  const [timelineSequence] = useState(createRequestSequence);
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';
    } catch {
      return 'Asia/Jakarta';
    }
  }, []);

  const load = useCallback(async () => {
    // Load yang dimulai lebih dulu (polling bulan/halaman lama) dapat selesai paling
    // akhir; hanya respons request terbaru yang boleh menulis state.
    const request = listSequence.next();
    try {
      const start = day ? new Date(`${day}T00:00:00`).toISOString() : new Date(`${month}-01T00:00:00`).toISOString();
      const endDate = day
        ? (() => {
            const value = new Date(`${day}T00:00:00`);
            value.setDate(value.getDate() + 1);
            return value;
          })()
        : new Date(new Date(`${month}-01T00:00:00`).getFullYear(), Number(month.slice(5, 7)), 1);
      const routeQuery = routeId ? `&routeId=${routeId}` : '';
      // allSettled: endpoint pendukung (kamera, kalender, storage) yang gagal tidak
      // boleh mengosongkan daftar recording yang justru dibutuhkan saat storage bermasalah.
      const [routeResult, recordingResult, calendarResult, storageResult] = await Promise.allSettled([
        api<{ items: StreamRoute[] }>('/api/routes'),
        api<{ items: RecordingSegment[]; total: number }>(`/api/recordings?from=${encodeURIComponent(start)}&to=${encodeURIComponent(endDate.toISOString())}${routeQuery}&offset=${(page - 1) * limit}&limit=${limit}`),
        api<{ days: Array<{ date: string; count: number; sizeBytes: number }> }>(`/api/recordings/calendar?month=${month}&timeZone=${encodeURIComponent(timeZone)}${routeQuery}`),
        api<RecordingStorage>('/api/recordings/storage')
      ]);
      if (!listSequence.isLatest(request)) return;
      const failures: string[] = [];
      if (routeResult.status === 'fulfilled') {
        setRoutes(routeResult.value.items);
      } else {
        failures.push(`Daftar kamera gagal dimuat: ${reasonMessage(routeResult.reason)}`);
      }
      if (recordingResult.status === 'fulfilled') {
        const recordings = recordingResult.value;
        setItems(recordings.items);
        setSelectedItems((current) => current.map((selected) => (
          recordings.items.find((item) => item.id === selected.id) ?? selected
        )));
        setTotal(recordings.total);
        const maximumPage = Math.max(1, Math.ceil(recordings.total / limit));
        if (page > maximumPage) setPage(maximumPage);
      } else {
        failures.push(`Daftar recording gagal dimuat: ${reasonMessage(recordingResult.reason)}`);
      }
      if (calendarResult.status === 'fulfilled') {
        const dayMap = Object.fromEntries(calendarResult.value.days.map((entry) => [entry.date, entry]));
        const availableDays = calendarResult.value.days.map((entry) => entry.date).sort();
        setCalendarDays(dayMap);
        setTimelineDay((current) => (
          !current.startsWith(`${month}-`) || !dayMap[current]
            ? (availableDays.at(-1) ?? '')
            : current
        ));
      } else {
        failures.push(`Kalender recording gagal dimuat: ${reasonMessage(calendarResult.reason)}`);
      }
      if (storageResult.status === 'fulfilled') {
        setStorage(storageResult.value);
        setStorageError('');
      } else {
        setStorage(null);
        setStorageError(`Status storage recording tidak dapat dibaca: ${reasonMessage(storageResult.reason)}. Daftar dan playback recording yang terindeks tetap dapat digunakan.`);
      }
      setError(failures.join(' · '));
    } catch (reason) {
      if (listSequence.isLatest(request)) setError(reasonMessage(reason));
    }
  }, [day, limit, listSequence, month, page, routeId, timeZone]);

  const loadTimeline = useCallback(async () => {
    const request = timelineSequence.next();
    if (!timelineDay) {
      setTimelineItems([]);
      setTimelineTruncated(false);
      return;
    }
    try {
      const routeQuery = routeId ? `&routeId=${routeId}` : '';
      const result = await api<{ items: RecordingSegment[]; truncated?: boolean }>(`/api/recordings/timeline?date=${timelineDay}&timeZone=${encodeURIComponent(timeZone)}${routeQuery}`);
      if (timelineSequence.isLatest(request)) {
        setTimelineItems(result.items);
        setTimelineTruncated(Boolean(result.truncated));
      }
    } catch (reason) {
      if (timelineSequence.isLatest(request)) setError(reasonMessage(reason));
    }
  }, [routeId, timeZone, timelineDay, timelineSequence]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadTimeline(); }, [loadTimeline]);
  useEffect(() => {
    if (playing) return;
    const refresh = async () => {
      if (document.hidden || refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        await Promise.all([load(), loadTimeline()]);
      } finally {
        refreshInFlightRef.current = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [load, loadTimeline, playing]);
  useEffect(() => {
    setSelectedItems([]);
    setNotice('');
  }, [day, limit, month, routeId]);
  useEffect(() => {
    if (!monthPickerOpen) return;
    function closePicker(event: MouseEvent) {
      if (!monthPickerRef.current?.contains(event.target as Node)) setMonthPickerOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMonthPickerOpen(false);
    }
    document.addEventListener('mousedown', closePicker);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closePicker);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [monthPickerOpen]);
  useEffect(() => {
    const pendingId = pendingScrollIdRef.current;
    if (!pendingId) return;
    // Baris dari timeline baru muncul setelah halaman/hari tujuan selesai dimuat.
    const row = document.querySelector(`[data-recording-id="${pendingId}"]`);
    if (!row) return;
    pendingScrollIdRef.current = '';
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusedId, items]);

  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const firstWeekday = new Date(`${month}-01T00:00:00`).getDay();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const sorted = useMemo(() => [...items].sort((left, right) => {
    const values = (item: RecordingSegment) => {
      switch (sort.key) {
        case 'camera': return `${item.cameraName} ${item.cameraKey}`;
        case 'start': return item.startTime;
        case 'duration': return item.durationMs;
        case 'size': return item.sizeBytes;
        case 'status': return `${item.status} ${item.protected}`;
      }
    };
    const result = compareSortValues(values(left), values(right));
    return sort.direction === 'asc' ? result : -result;
  }), [items, sort]);
  const timelineGroups = useMemo(() => buildTimelineGroups(timelineItems, timeZone), [timeZone, timelineItems]);
  const downloadableItems = selectedItems.filter((item) => item.status === 'COMPLETE');
  const deletableItems = selectedItems.filter((item) => item.status !== 'RECORDING' && !item.protected);
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const allPageSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  function changeSort(key: SortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  }

  function openRecording(item: RecordingSegment) {
    pendingScrollIdRef.current = item.id;
    setFocusedId(item.id);
    if (item.status === 'COMPLETE') setPlaying(item);
  }

  function openFromTimeline(item: RecordingSegment) {
    const descending = [...timelineItems].sort((left, right) => right.startTime.localeCompare(left.startTime));
    const index = descending.findIndex((candidate) => candidate.id === item.id);
    setDay(timelineDay);
    setPage(Math.floor(Math.max(0, index) / limit) + 1);
    openRecording(item);
  }

  function toggleSelection(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (!selectedIds.has(id) && selectedItems.length >= MAX_RECORDING_BULK_SELECTION) {
      setError(`Maksimal ${MAX_RECORDING_BULK_SELECTION} recording dapat dipilih untuk satu bulk action.`);
      return;
    }
    setSelectedItems((current) => current.some((candidate) => candidate.id === id)
      ? current.filter((candidate) => candidate.id !== id)
      : [...current, item]);
  }

  function togglePageSelection() {
    const newlySelected = items.filter((item) => !selectedIds.has(item.id)).length;
    if (!allPageSelected && selectedItems.length + newlySelected > MAX_RECORDING_BULK_SELECTION) {
      setError(`Maksimal ${MAX_RECORDING_BULK_SELECTION} recording dapat dipilih untuk satu bulk action.`);
      return;
    }
    setSelectedItems((current) => toggleRecordingPageSelection(current, items));
  }

  function bulkDownload() {
    if (!downloadableItems.length) return;
    // ZIP di-stream langsung oleh browser agar arsip besar tidak ditampung di memori
    // tab; akibatnya respons gagal (409/429) hanya terlihat di daftar unduhan browser.
    const link = document.createElement('a');
    link.href = `/api/recordings/bulk-download?ids=${encodeURIComponent(downloadableItems.map((item) => item.id).join(','))}`;
    link.download = `camera-recordings-${new Date().toISOString().slice(0, 10)}.zip`;
    link.click();
    setNotice(`Unduhan ZIP ${downloadableItems.length} recording diserahkan ke browser. Jika unduhan gagal (recording sudah terhapus atau batas 10 unduhan ZIP per menit tercapai), statusnya tampil di daftar unduhan browser.`);
  }

  async function bulkDelete() {
    if (!deletableItems.length || !confirm(`Hapus ${deletableItems.length} recording yang dipilih? Recording aktif dan terproteksi tidak akan dihapus.`)) return;
    setNotice('');
    setBulkBusy(true);
    try {
      const result = await api<{ deletedIds: string[]; skipped: Array<{ id: string; reason: string }> }>('/api/recordings/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids: deletableItems.map((item) => item.id) })
      });
      setSelectedItems((current) => current.filter((item) => !result.deletedIds.includes(item.id)));
      if (playing && result.deletedIds.includes(playing.id)) setPlaying(null);
      setError(result.skipped.length ? `${result.skipped.length} recording dilewati: ${result.skipped[0]?.reason ?? 'tidak dapat dihapus'}` : '');
      await Promise.all([load(), loadTimeline()]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function protect(item: RecordingSegment) {
    try {
      await api(`/api/recordings/${item.id}/protection`, {
        method: 'PATCH',
        body: JSON.stringify({ protected: !item.protected })
      });
      await Promise.all([load(), loadTimeline()]);
    } catch (reason) { setError((reason as Error).message); }
  }

  async function remove(item: RecordingSegment) {
    if (!confirm(`Hapus recording ${item.cameraName} pada ${new Date(item.startTime).toLocaleString('id-ID')}?`)) return;
    try {
      await api(`/api/recordings/${item.id}`, { method: 'DELETE' });
      if (playing?.id === item.id) setPlaying(null);
      if (focusedId === item.id) setFocusedId('');
      await Promise.all([load(), loadTimeline()]);
    } catch (reason) { setError((reason as Error).message); }
  }

  const usedPercent = storage ? Math.max(0, Math.min(100, (storage.totalBytes - storage.freeBytes) / storage.totalBytes * 100)) : 0;
  return <>
    <header className="page-header"><div><h1>Recording</h1><p>Kalender, timeline harian, playback, proteksi, dan storage management.</p></div><button onClick={() => void Promise.all([load(), loadTimeline()])}>Refresh</button></header>
    {error && <div className="alert error">{error}</div>}
    {notice && <div className="alert warning">{notice}</div>}
    {storageError && <div className="alert warning">{storageError}</div>}
    {storage && <section className={`panel storage-summary ${storage.paused ? 'storage-paused' : ''}`}>
      <header className="health-header"><div><h2>Recording Storage</h2><p>{storage.paused ? 'Recording dipause karena ruang tidak aman.' : `${storage.segments} segment terindeks.`}</p></div><b>{bytes(storage.freeBytes)} free</b></header>
      <div className="storage-meter"><span style={{ width: `${usedPercent}%` }} /></div>
      <small>{bytes(storage.totalBytes - storage.freeBytes)} / {bytes(storage.totalBytes)} digunakan · guard {storage.minFreePercent}% atau {storage.minFreeGb} GB</small>
    </section>}
    <section className="panel recording-timeline">
      <header className="health-header"><div><h2>Timeline Recording</h2><p>{timelineDay || 'Pilih hari pada kalender'} · {timelineItems.length} segment{timelineTruncated ? ' (dibatasi, pilih kamera untuk melihat semua)' : ''}</p></div></header>
      <div className="timeline-hours">{[0, 4, 8, 12, 16, 20, 24].map((hour) => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}</div>
      <div className="recording-timeline-tracks">
        {timelineGroups.map((group) => <div className="recording-timeline-row" key={group.cameraKey}>
          <div><b>{group.cameraName}</b><small>{group.cameraKey}</small></div>
          <div className="recording-timeline-rail">
            {group.blocks.map(({ item, startSeconds, endSeconds, startLabel, endLabel }) => {
              return <button
                key={item.id}
                className={`${focusedId === item.id ? 'active' : ''} ${item.status === 'RECORDING' ? 'recording-active-block' : ''}`}
                style={{
                  left: `${startSeconds / 864}%`,
                  width: `${Math.max(0.02, (endSeconds - startSeconds) / 864)}%`
                }}
                title={`${group.cameraName}: ${startLabel} – ${endLabel} (${duration(item.durationMs)})`}
                aria-label={`Open ${group.cameraName}, ${startLabel} sampai ${endLabel}`}
                onClick={() => openFromTimeline(item)}
              ><span className={`recording-timeline-tooltip ${startSeconds < 21_600 ? 'align-left' : startSeconds > 64_800 ? 'align-right' : ''}`}><b>{startLabel} – {endLabel}</b><small>{duration(item.durationMs)}{item.status === 'RECORDING' ? ' · sedang merekam' : ''}</small></span></button>;
            })}
          </div>
        </div>)}
        {!timelineGroups.length && <p className="empty">Tidak ada recording pada hari yang dipilih.</p>}
      </div>
    </section>
    <section className="recording-layout">
      <aside className="panel recording-calendar">
        <div className="recording-calendar-field"><span>Bulan</span><div ref={monthPickerRef} className="recording-month-picker">
          <button
            type="button"
            className="recording-month-trigger"
            aria-label="Buka kalender bulan"
            aria-haspopup="dialog"
            aria-expanded={monthPickerOpen}
            onClick={() => {
              setMonthPickerYear(Number(month.slice(0, 4)));
              setMonthPickerOpen((current) => !current);
            }}
          ><b>{monthLabel(month)}</b><span aria-hidden="true">▾</span></button>
          {monthPickerOpen && <div className="recording-month-popover" role="dialog" aria-label="Pilih bulan recording">
            <header>
              <button type="button" aria-label="Tahun sebelumnya" onClick={() => setMonthPickerYear((year) => year - 1)}>‹</button>
              <b>{monthPickerYear}</b>
              <button type="button" aria-label="Tahun berikutnya" onClick={() => setMonthPickerYear((year) => year + 1)}>›</button>
            </header>
            <div className="recording-month-grid">
              {monthNames.map((name, index) => {
                const value = `${monthPickerYear}-${String(index + 1).padStart(2, '0')}`;
                return <button
                  type="button"
                  key={value}
                  className={month === value ? 'active' : ''}
                  aria-pressed={month === value}
                  onClick={() => {
                    setMonth(value);
                    setDay('');
                    setTimelineDay('');
                    setPage(1);
                    setMonthPickerOpen(false);
                  }}
                >{name}</button>;
              })}
            </div>
          </div>}
        </div></div>
        <label>Kamera<select value={routeId} onChange={(event) => {
          setRouteId(event.target.value);
          setDay('');
          setTimelineDay('');
          setPage(1);
        }}><option value="">Semua kamera</option>{routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>
        <div className="calendar-grid calendar-weekdays">{['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map((name) => <b key={name}>{name}</b>)}</div>
        <div className="calendar-grid">
          {Array.from({ length: firstWeekday }, (_, index) => <span key={`empty-${index}`} />)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const date = `${month}-${String(index + 1).padStart(2, '0')}`;
            const info = calendarDays[date];
            return <button key={date} disabled={!info} aria-label={info ? `${date}, ${info.count} segment` : `${date}, tidak ada recording`} className={`${info ? 'has-recording' : ''} ${day === date ? 'active' : ''}`} onClick={() => {
              if (!info) return;
              setTimelineDay(date);
              setDay((current) => current === date ? '' : date);
              setPage(1);
            }}>
              <b>{index + 1}</b>{info && <small>{info.count}</small>}
            </button>;
          })}
        </div>
      </aside>
      <section className="panel recording-list">
        <header className="health-header">
          <div><h2>Daftar Recording</h2><p>{day || month} · {total} segment</p></div>
          <div className="actions">
            {selectedItems.length > 0 && <span className="recording-selection-count">{selectedItems.length} dipilih</span>}
            <button disabled={!downloadableItems.length || bulkBusy} onClick={bulkDownload}>Download ZIP ({downloadableItems.length})</button>
            {canManage && <button className="danger" disabled={!deletableItems.length || bulkBusy} onClick={() => void bulkDelete()}>Delete ({deletableItems.length})</button>}
            <label className="recording-page-limit">Tampilkan<select value={limit} onChange={(event) => {
              setLimit(Number(event.target.value) as (typeof pageLimits)[number]);
              setPage(1);
            }}>{pageLimits.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            {day && <button onClick={() => { setDay(''); setPage(1); }}>Tampilkan sebulan</button>}
          </div>
        </header>
        <div className="table-wrap"><table><thead><tr>
          <th className="recording-select-column"><input type="checkbox" aria-label="Pilih semua recording pada halaman ini" checked={allPageSelected} onChange={togglePageSelection} /></th>
          <SortableHeader label="Kamera" active={sort.key === 'camera'} direction={sort.direction} onSort={() => changeSort('camera')} />
          <SortableHeader label="Waktu" active={sort.key === 'start'} direction={sort.direction} onSort={() => changeSort('start')} />
          <SortableHeader label="Durasi" active={sort.key === 'duration'} direction={sort.direction} onSort={() => changeSort('duration')} />
          <SortableHeader label="Ukuran" active={sort.key === 'size'} direction={sort.direction} onSort={() => changeSort('size')} />
          <SortableHeader label="Status" active={sort.key === 'status'} direction={sort.direction} onSort={() => changeSort('status')} />
          <th>Aksi</th>
        </tr></thead><tbody>
          {sorted.map((item) => <tr key={item.id} data-recording-id={item.id} className={focusedId === item.id ? 'recording-row-selected' : ''}>
            <td className="recording-select-column"><input type="checkbox" aria-label={`Pilih recording ${item.cameraName} ${new Date(item.startTime).toLocaleString('id-ID', { timeZone })}`} checked={selectedIds.has(item.id)} onChange={() => toggleSelection(item.id)} /></td>
            <td><b>{item.cameraName}</b><small>{item.cameraKey}</small></td>
            <td>{new Date(item.startTime).toLocaleString('id-ID', { timeZone })}</td>
            <td>{duration(item.durationMs)}</td>
            <td>{bytes(item.sizeBytes)}</td>
            <td>{item.status === 'RECORDING' ? <span className="recording-live-status">● REC</span> : item.status}<small>{item.errorMessage ?? (item.status === 'RECORDING' ? 'Segment sedang ditulis' : item.protected ? '🔒 Dilindungi' : 'Retention aktif')}</small></td>
            <td><div className="actions">
              <button onClick={() => openRecording(item)} disabled={item.status !== 'COMPLETE'}>Open</button>
              {item.status === 'COMPLETE'
                ? <a className="button-link" href={`/api/recordings/download?id=${item.id}`}>Download</a>
                : <button disabled title={item.errorMessage ?? 'Segment tidak tersedia'}>Download</button>}
              {canManage && <><button onClick={() => void protect(item)}>{item.protected ? 'Unprotect' : 'Protect'}</button><button className="danger" onClick={() => void remove(item)} disabled={item.protected}>Delete</button></>}
            </div></td>
          </tr>)}
          {!sorted.length && <tr><td colSpan={7} className="empty">Belum ada recording pada periode ini.</td></tr>}
        </tbody></table></div>
        <footer className="recording-pagination">
          <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>← Sebelumnya</button>
          <span>Halaman <b>{page}</b> dari <b>{totalPages}</b></span>
          <button disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Berikutnya →</button>
        </footer>
      </section>
    </section>
    {playing && <RecordingPlayerModal recording={playing} timeZone={timeZone} onClose={() => setPlaying(null)} />}
  </>;
}
