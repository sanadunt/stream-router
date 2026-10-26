import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const spawnCalls = vi.hoisted(() => {
  process.env.AUTH_SECRET = 'unit-auth-secret-0123456789012345678901';
  process.env.APP_ENCRYPTION_KEY = 'unit-encryption-key-01234567890123456';
  process.env.ADMIN_PASSWORD = 'unit-admin-password';
  process.env.OPERATOR_PASSWORD = 'unit-operator-password';
  return [] as Array<import('node:child_process').ChildProcess>;
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawnCalls.push(child);
      return child;
    }
  };
});
vi.mock('../../src/db/client.js', () => ({ prisma: {} }));
vi.mock('../../src/modules/settings/settings-service.js', () => ({ getFfmpegPath: async () => 'ffmpeg' }));
vi.mock('../../src/modules/workers/worker-manager.js', () => ({ workerManager: { allSnapshots: () => [] } }));
vi.mock('../../src/modules/mediamtx/mediamtx-runtime.js', () => ({ mediaMtxRuntimeHealth: async () => ({ enabled: false }) }));

const { checkFfmpeg } = await import('../../src/modules/health/health-service.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeFfmpeg = path.resolve(here, '../fixtures/fake-ffmpeg.mjs');
let tempDir = '';
let hangingBinary = '';

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'stream-router-health-'));
  hangingBinary = path.join(tempDir, 'ffmpeg-hang');
  await writeFile(hangingBinary, '#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n');
  await chmod(hangingBinary, 0o755);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('pemeriksaan FFmpeg pada health', () => {
  it('meng-cache hasil per path binary sehingga polling tidak spawn proses baru', async () => {
    const before = spawnCalls.length;
    const [first, second] = await Promise.all([checkFfmpeg(fakeFfmpeg), checkFfmpeg(fakeFfmpeg)]);
    expect(first).toEqual({ ok: true, version: 'ffmpeg version fake-integration' });
    expect(second).toBe(first);
    expect(await checkFfmpeg(fakeFfmpeg)).toBe(first);
    expect(spawnCalls.length - before).toBe(1);
  });

  it('menghentikan binary yang tidak merespons setelah batas waktu', async () => {
    const result = await checkFfmpeg(hangingBinary, 300);
    expect(result).toEqual({ ok: false, error: 'FFmpeg tidak merespons dalam 1 detik' });
    const child = spawnCalls.at(-1);
    await vi.waitFor(() => expect(child?.signalCode).toBe('SIGKILL'));
  });

  it('melaporkan binary yang tidak ditemukan tanpa melempar error', async () => {
    const result = await checkFfmpeg(path.join(tempDir, 'tidak-ada'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });
});
