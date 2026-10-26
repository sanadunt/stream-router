export const PTZ_REPEAT_INTERVAL_MS = 500;
/**
 * Batas satu kali tahan tombol PTZ di browser. Backstop jika event lepas tombol
 * hilang (fokus pindah, elemen di-unmount): setiap command move memperpanjang
 * dead-man stop backend, jadi tanpa batas ini kamera dapat terus bergerak.
 */
export const PTZ_MAX_HOLD_MS = 60_000;

export interface PtzHoldLoop<T> {
  start(motion: T): void;
  stop(): void;
  active(): T | null;
}

export function createPtzHoldLoop<T>({
  send,
  stop,
  intervalMs = PTZ_REPEAT_INTERVAL_MS,
  maxHoldMs = PTZ_MAX_HOLD_MS,
  now = Date.now
}: {
  send: (motion: T) => void;
  stop: (motion: T) => void;
  intervalMs?: number;
  maxHoldMs?: number;
  now?: () => number;
}): PtzHoldLoop<T> {
  let current: T | null = null;
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const halt = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const motion = current;
    if (motion === null) return;
    current = null;
    stop(motion);
  };

  return {
    start(motion) {
      halt();
      current = motion;
      startedAt = now();
      send(motion);
      timer = setInterval(() => {
        if (current === null) return;
        if (now() - startedAt >= maxHoldMs) {
          halt();
          return;
        }
        send(current);
      }, intervalMs);
    },
    stop: halt,
    active: () => current
  };
}
