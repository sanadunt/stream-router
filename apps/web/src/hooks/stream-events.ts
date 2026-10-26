export const STREAM_EVENT_TYPES = ['worker.status', 'worker.stopped', 'worker.restarting', 'worker.failed'] as const;

const EVENT_SOURCE_CLOSED = 2;

export interface RefreshScheduler {
  schedule(): void;
  dispose(): void;
}

/**
 * Menggabungkan permintaan refresh: paling banyak satu `run` per jendela `delayMs`
 * dan tidak pernah dua `run` berjalan bersamaan. Burst event saat boot recovery
 * atau restart MediaMTX (ratusan event per detik) cukup menghasilkan satu load.
 */
export function createRefreshScheduler(run: () => unknown, delayMs: number): RefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pending = false;
  let disposed = false;

  const execute = async () => {
    timer = undefined;
    if (disposed) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await run();
    } catch {
      // Halaman menampilkan error load sendiri; scheduler tetap hidup.
    } finally {
      inFlight = false;
    }
    if (pending) {
      pending = false;
      schedule();
    }
  };

  function schedule() {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => void execute(), delayMs);
  }

  return {
    schedule,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface StreamEventConnection {
  /** Membuka koneksi bila belum ada (mis. saat tab kembali terlihat). */
  resume(): void;
  /** Menutup koneksi tanpa menjadwalkan reconnect (mis. saat tab disembunyikan). */
  pause(): void;
  close(): void;
}

export interface StreamEventConnectionOptions {
  createSource: () => EventSourceLike;
  onChange: () => void;
  routeId?: string;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

/**
 * EventSource berhenti permanen bila reconnect mendapat respons non-200
 * (nginx 502 atau proxy Vite 500 saat API restart). Koneksi ini membuat ulang
 * EventSource dengan backoff dan meminta resync setiap kali tersambung kembali.
 */
export function connectStreamEvents(options: StreamEventConnectionOptions): StreamEventConnection {
  const initialRetryMs = options.initialRetryMs ?? 1000;
  const maxRetryMs = options.maxRetryMs ?? 30000;
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = initialRetryMs;
  let connectedBefore = false;
  let closed = false;

  const relevant = (event: Event) => {
    if (!options.routeId) return true;
    const routeId = eventRouteId(event);
    return routeId === undefined || routeId === options.routeId;
  };

  const open = () => {
    retryTimer = undefined;
    if (closed || source) return;
    const current = options.createSource();
    source = current;
    for (const type of STREAM_EVENT_TYPES) {
      current.addEventListener(type, (event) => {
        if (source === current && relevant(event)) options.onChange();
      });
    }
    current.addEventListener('connected', () => {
      if (source !== current) return;
      retryMs = initialRetryMs;
      // Event yang terjadi selama koneksi putus tidak dikirim ulang oleh server.
      if (connectedBefore) options.onChange();
      connectedBefore = true;
    });
    current.addEventListener('error', () => {
      if (source !== current || current.readyState !== EVENT_SOURCE_CLOSED) return;
      current.close();
      source = null;
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    });
  };

  const pause = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    source?.close();
    source = null;
  };

  return {
    resume() {
      if (!source && retryTimer === undefined) open();
    },
    pause,
    close() {
      closed = true;
      pause();
    }
  };
}

function eventRouteId(event: Event): string | undefined {
  const data = (event as MessageEvent).data;
  if (typeof data !== 'string') return undefined;
  try {
    const payload = JSON.parse(data) as { routeId?: unknown };
    return typeof payload.routeId === 'string' ? payload.routeId : undefined;
  } catch {
    return undefined;
  }
}
