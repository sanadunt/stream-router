/**
 * Menggabungkan pemanggilan beruntun menjadi satu request aktif. Pemanggilan saat
 * request masih berjalan hanya menandai bahwa data perlu dimuat ulang, sehingga
 * task diulang sekali setelah selesai. Burst event SSE tidak lagi menumpuk request
 * paralel yang dapat tiba tidak berurutan. Task wajib menangani error-nya sendiri.
 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let rerun = false;
  return () => {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await task();
        } while (rerun);
      } finally {
        rerun = false;
        running = null;
      }
    })();
    return running;
  };
}

export interface RequestSequence {
  next(): number;
  isLatest(token: number): boolean;
}

/** Penanda request terbaru: respons dari request lama diabaikan agar tidak menimpa data baru. */
export function createRequestSequence(): RequestSequence {
  let latest = 0;
  return {
    next() {
      latest += 1;
      return latest;
    },
    isLatest(token) {
      return token === latest;
    }
  };
}
