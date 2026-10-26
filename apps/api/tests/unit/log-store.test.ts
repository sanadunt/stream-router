import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const fsCalls = vi.hoisted(() => {
  process.env.AUTH_SECRET = 'unit-auth-secret-0123456789012345678901';
  process.env.APP_ENCRYPTION_KEY = 'unit-encryption-key-01234567890123456';
  process.env.ADMIN_PASSWORD = 'unit-admin-password';
  process.env.OPERATOR_PASSWORD = 'unit-operator-password';
  process.env.MAX_LOG_LINES_PER_ROUTE = '100';
  return { appendFile: 0 };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: (...args: Parameters<typeof actual.appendFile>) => {
      fsCalls.appendFile += 1;
      return actual.appendFile(...args);
    }
  };
});

const { appendRouteLog, readLastLines, readRouteLogs } = await import('../../src/modules/logs/log-store.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.resolve(here, '../../../../data/logs');
const createdIds: string[] = [];
let tempDir = '';

function routeId(): string {
  const id = randomUUID();
  createdIds.push(id);
  return id;
}

function logLine(component: string, message: string): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', component, message });
}

async function readMessages(id: string): Promise<string[]> {
  const content = await readFile(path.join(logDir, `${id}.log`), 'utf8');
  return content.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { message: string }).message);
}

beforeAll(async () => {
  await mkdir(logDir, { recursive: true });
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'stream-router-log-store-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const id of createdIds) {
    await rm(path.join(logDir, `${id}.log`), { recursive: true, force: true });
    await rm(path.join(logDir, `${id}.log.rotate.tmp`), { force: true });
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe('log route', () => {
  it('kegagalan menulis log tidak menjadi rejection yang mematikan proses', async () => {
    const id = routeId();
    // Path log berupa folder membuat appendFile gagal (EISDIR), setara disk read-only/penuh.
    await mkdir(path.join(logDir, `${id}.log`), { recursive: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(appendRouteLog(id, 'ffmpeg', 'frame=1 fps=1', 'FFMPEG_ONLINE')).resolves.toBeUndefined();
      void appendRouteLog(id, 'ffmpeg', 'frame=2 fps=1', 'FFMPEG_ONLINE');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
      await expect(appendRouteLog('../bukan-route', 'info', 'x')).resolves.toBeUndefined();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('menggabungkan append bersamaan menjadi beberapa write dan menjaga urutan', async () => {
    const id = routeId();
    const before = fsCalls.appendFile;
    await Promise.all(Array.from({ length: 50 }, (_, index) => appendRouteLog(id, 'info', `baris-${index}`)));
    expect(fsCalls.appendFile - before).toBeLessThanOrEqual(2);
    expect(await readMessages(id)).toEqual(Array.from({ length: 50 }, (_, index) => `baris-${index}`));
  });

  it('baris yang masuk selama rotasi tidak hilang', async () => {
    const id = routeId();
    const filler = logLine('FFMPEG_ONLINE', `frame=1 fps=25 ${'x'.repeat(1000)}`);
    const count = Math.ceil((10 * 1024 * 1024) / filler.length) + 10;
    await writeFile(path.join(logDir, `${id}.log`), `${Array.from({ length: count }, () => filler).join('\n')}\n`);
    const first = appendRouteLog(id, 'info', 'pemicu-rotasi');
    // Ditambahkan saat append pertama dan rotasinya masih berjalan.
    const during = Array.from({ length: 20 }, (_, index) => appendRouteLog(id, 'info', `selama-rotasi-${index}`));
    await Promise.all([first, ...during]);
    const messages = await readMessages(id);
    expect(messages.length).toBeLessThanOrEqual(100 + 20);
    expect(messages.slice(-21)).toEqual(['pemicu-rotasi', ...Array.from({ length: 20 }, (_, index) => `selama-rotasi-${index}`)]);
  });

  it('filter komponen diterapkan sebelum batas jumlah baris', async () => {
    const id = routeId();
    const lines = [
      logLine('SYSTEM', 'Auto-start belum berhasil'),
      ...Array.from({ length: 150 }, (_, index) => logLine('FFMPEG_ONLINE', `frame=${index}`))
    ];
    await writeFile(path.join(logDir, `${id}.log`), `${lines.join('\n')}\n`);
    const system = await readRouteLogs(id, 0, 500, true, 'SYSTEM');
    expect(system.items).toEqual([expect.objectContaining({ component: 'SYSTEM', message: 'Auto-start belum berhasil' })]);
    const all = await readRouteLogs(id, 0, 500, true);
    expect(all.total).toBe(100);
    expect((all.items.at(-1) as { message: string }).message).toBe('frame=149');
  });
});

describe('pembacaan ujung file log', () => {
  it('hanya membaca baris terakhir dan membuang potongan baris di batas byte', async () => {
    const file = path.join(tempDir, 'mediamtx.log');
    const lines = Array.from({ length: 5000 }, (_, index) => `2026/10/24 10:00:00 INF [path cameras/cam${index}] source error ${'y'.repeat(index % 50)}`);
    await writeFile(file, `${lines.join('\n')}\n`);
    expect(await readLastLines(file, 3)).toEqual(lines.slice(-3));
    const capped = await readLastLines(file, 10_000, undefined, 4096);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(lines.length);
    expect(lines.slice(-capped.length)).toEqual(capped);
    expect(await readLastLines(file, 10_000)).toEqual(lines);
  });

  it('membaca file tanpa newline di akhir dan baris CRLF', async () => {
    const file = path.join(tempDir, 'crlf.log');
    await writeFile(file, 'satu\r\ndua\r\n\r\ntiga');
    expect(await readLastLines(file, 10)).toEqual(['satu', 'dua', 'tiga']);
  });
});
