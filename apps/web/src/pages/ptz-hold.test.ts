import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPtzHoldLoop, PTZ_MAX_HOLD_MS, PTZ_REPEAT_INTERVAL_MS } from './ptz-hold';

describe('PTZ hold loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const send = vi.fn<(motion: string) => void>();
    const stop = vi.fn<(motion: string) => void>();
    const loop = createPtzHoldLoop<string>({ send, stop, now: () => Date.now() });
    return { send, stop, loop };
  }

  it('mengulang command selama tombol ditahan dan mengirim stop sekali saat dilepas', () => {
    const { send, stop, loop } = setup();
    loop.start('right');
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PTZ_REPEAT_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(4);

    loop.stop();
    loop.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('right');
    expect(loop.active()).toBeNull();
    vi.advanceTimersByTime(PTZ_REPEAT_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('menghentikan kamera otomatis setelah batas tahan maksimum walau event lepas tombol hilang', () => {
    const { send, stop, loop } = setup();
    loop.start('left');
    vi.advanceTimersByTime(PTZ_MAX_HOLD_MS + PTZ_REPEAT_INTERVAL_MS);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(loop.active()).toBeNull();
    const sentBeforeStop = send.mock.calls.length;
    vi.advanceTimersByTime(PTZ_MAX_HOLD_MS);
    expect(send).toHaveBeenCalledTimes(sentBeforeStop);
  });

  it('menghentikan gerakan lama sebelum memulai arah baru', () => {
    const { send, stop, loop } = setup();
    loop.start('up');
    loop.start('down');
    expect(stop).toHaveBeenCalledWith('up');
    expect(loop.active()).toBe('down');
    vi.advanceTimersByTime(PTZ_REPEAT_INTERVAL_MS);
    expect(send).toHaveBeenLastCalledWith('down');
  });
});
