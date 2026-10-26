import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStreamEvents, createRefreshScheduler, type EventSourceLike } from './stream-events';

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data?: unknown): void {
    const event = Object.assign(new Event(type), { data: data === undefined ? undefined : JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  connect(): void {
    this.readyState = 1;
    this.emit('connected', { timestamp: new Date().toISOString() });
  }

  fail(permanently: boolean): void {
    this.readyState = permanently ? 2 : 0;
    this.emit('error');
  }
}

describe('createRefreshScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('menggabungkan burst event menjadi satu load per jendela', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = createRefreshScheduler(run, 500);
    for (let index = 0; index < 300; index += 1) scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('tidak menjalankan load tumpang tindih dan mengulang sekali setelah load selesai', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const scheduler = createRefreshScheduler(run, 500);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('berhenti total setelah dispose', async () => {
    const run = vi.fn();
    const scheduler = createRefreshScheduler(run, 500);
    scheduler.schedule();
    scheduler.dispose();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('connectStreamEvents', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(routeId?: string) {
    const sources: FakeEventSource[] = [];
    const onChange = vi.fn();
    const connection = connectStreamEvents({
      createSource: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      onChange,
      routeId
    });
    return { sources, onChange, connection };
  }

  it('membuat ulang EventSource dengan backoff setelah reconnect gagal permanen dan resync saat tersambung', async () => {
    const { sources, onChange, connection } = setup();
    connection.resume();
    sources[0].connect();
    expect(onChange).not.toHaveBeenCalled();

    sources[0].fail(false);
    expect(sources).toHaveLength(1);

    sources[0].fail(true);
    expect(sources[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);

    sources[1].fail(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(3);

    sources[2].connect();
    expect(onChange).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('membatasi backoff reconnect ke 30 detik', async () => {
    const { sources, connection } = setup();
    connection.resume();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      sources[sources.length - 1].fail(true);
      await vi.advanceTimersByTimeAsync(30000);
    }
    const before = sources.length;
    sources[sources.length - 1].fail(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(sources.length).toBe(before + 1);
    connection.close();
  });

  it('hanya meneruskan event route yang sedang dibuka bila routeId diberikan', () => {
    const { sources, onChange, connection } = setup('route-a');
    connection.resume();
    sources[0].emit('worker.status', { type: 'worker.status', routeId: 'route-b', data: { status: 'RUNNING' } });
    expect(onChange).not.toHaveBeenCalled();
    sources[0].emit('worker.failed', { type: 'worker.failed', routeId: 'route-a', data: {} });
    expect(onChange).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('menutup koneksi saat pause dan membuka koneksi baru dengan resync saat resume', () => {
    const { sources, onChange, connection } = setup();
    connection.resume();
    sources[0].connect();
    connection.pause();
    expect(sources[0].closed).toBe(true);
    sources[0].emit('worker.status', { routeId: 'x' });
    expect(onChange).not.toHaveBeenCalled();

    connection.resume();
    connection.resume();
    expect(sources).toHaveLength(2);
    sources[1].connect();
    expect(onChange).toHaveBeenCalledTimes(1);
    connection.close();
    expect(sources[1].closed).toBe(true);
  });

  it('tidak reconnect setelah close walau ada error tertunda', async () => {
    const { sources, connection } = setup();
    connection.resume();
    sources[0].fail(true);
    connection.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(sources).toHaveLength(1);
  });
});
