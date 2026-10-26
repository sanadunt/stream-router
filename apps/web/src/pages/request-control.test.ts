import { describe, expect, it } from 'vitest';
import { createRequestSequence, singleFlight } from './request-control';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('singleFlight', () => {
  it('menggabungkan burst pemanggilan menjadi satu request aktif plus satu muat ulang', async () => {
    const pending: Array<() => void> = [];
    let calls = 0;
    const load = singleFlight(async () => {
      calls += 1;
      const gate = deferred();
      pending.push(gate.resolve);
      await gate.promise;
    });

    const first = load();
    const burst = Array.from({ length: 20 }, () => load());
    expect(calls).toBe(1);

    pending.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);

    pending.shift()!();
    await Promise.all([first, ...burst]);
    expect(calls).toBe(2);
  });

  it('memulai request baru setelah request sebelumnya selesai', async () => {
    let calls = 0;
    const load = singleFlight(async () => { calls += 1; });
    await load();
    await load();
    expect(calls).toBe(2);
  });

  it('melepas kunci walau task gagal sehingga pemanggilan berikutnya tetap berjalan', async () => {
    let calls = 0;
    const load = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error('gagal');
    });
    await expect(load()).rejects.toThrow('gagal');
    await load();
    expect(calls).toBe(2);
  });
});

describe('createRequestSequence', () => {
  it('hanya menganggap request terakhir sebagai respons yang boleh diterapkan', () => {
    const sequence = createRequestSequence();
    const older = sequence.next();
    const newer = sequence.next();
    expect(sequence.isLatest(older)).toBe(false);
    expect(sequence.isLatest(newer)).toBe(true);
  });
});
