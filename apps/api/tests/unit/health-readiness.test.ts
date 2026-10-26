import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env.AUTH_SECRET = 'unit-auth-secret-0123456789012345678901';
  process.env.APP_ENCRYPTION_KEY = 'unit-encryption-key-01234567890123456';
  process.env.ADMIN_PASSWORD = 'unit-admin-password';
  process.env.OPERATOR_PASSWORD = 'unit-operator-password';
  return { report: {} as Record<string, unknown> };
});

vi.mock('../../src/plugins/auth.js', () => ({ currentSession: async () => null }));
vi.mock('../../src/modules/health/health-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/health/health-service.js')>();
  return { ...actual, healthReport: async () => state.report };
});
vi.mock('../../src/db/client.js', () => ({ prisma: {} }));
vi.mock('../../src/modules/settings/settings-service.js', () => ({ getFfmpegPath: async () => 'ffmpeg' }));
vi.mock('../../src/modules/workers/worker-manager.js', () => ({ workerManager: { allSnapshots: () => [] } }));
vi.mock('../../src/modules/mediamtx/mediamtx-runtime.js', () => ({ mediaMtxRuntimeHealth: async () => ({ enabled: false }) }));

const { failingChecks, readinessFailureSummary } = await import('../../src/modules/health/health-service.js');
const { healthRoutes } = await import('../../src/modules/health/health-routes.js');

const storagePausedReport = {
  ok: false,
  timestamp: '2026-10-26T00:00:00.000Z',
  database: { ok: true },
  ffmpeg: { ok: true, version: 'ffmpeg version 7' },
  mediaMtx: {
    ok: false,
    enabled: true,
    error: 'Recording dipause karena ruang kosong berada di bawah batas aman',
    controlApi: { ok: true, paths: 2 },
    recordingStorage: { ok: true, totalBytes: 32, freeBytes: 18, paused: true }
  }
};

const logLines: Array<{ level: number; msg: string; checks?: Record<string, string> }> = [];
let app: FastifyInstance;

beforeAll(async () => {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(JSON.parse(chunk.toString('utf8')) as (typeof logLines)[number]);
      callback();
    }
  });
  app = Fastify({ logger: { level: 'info', stream } });
  await app.register(healthRoutes);
});

afterAll(async () => {
  await app.close();
});

describe('pemeriksaan kesiapan', () => {
  it('/api/ready tanpa sesi menyebut pemeriksaan yang gagal tanpa detail', async () => {
    state.report = storagePausedReport;
    const response = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false, failing: ['mediaMtx.recordingStorage'] });
  });

  it('menulis penyebab kegagalan ke log server satu kali per perubahan status', async () => {
    state.report = storagePausedReport;
    logLines.length = 0;
    await app.inject({ method: 'GET', url: '/api/ready' });
    await app.inject({ method: 'GET', url: '/api/health' });
    // Status yang sama sudah dicatat oleh test sebelumnya; polling berikutnya tidak menulis ulang.
    const warnings = logLines.filter((line) => line.msg === 'Pemeriksaan kesiapan gagal');
    expect(warnings).toHaveLength(0);

    state.report = { ...storagePausedReport, ffmpeg: { ok: false, error: 'spawn /opt/ffmpeg ENOENT' } };
    await app.inject({ method: 'GET', url: '/api/ready' });
    await app.inject({ method: 'GET', url: '/api/ready' });
    const changed = logLines.filter((line) => line.msg === 'Pemeriksaan kesiapan gagal');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.checks).toEqual({
      ffmpeg: 'spawn /opt/ffmpeg ENOENT',
      'mediaMtx.recordingStorage': 'Recording dipause karena ruang kosong berada di bawah batas aman'
    });

    state.report = { ok: true, timestamp: storagePausedReport.timestamp };
    const healthy = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(healthy.json()).toEqual({ ready: true });
    expect(logLines.some((line) => line.msg === 'Pemeriksaan kesiapan kembali sehat')).toBe(true);
  });

  it('memetakan setiap pemeriksaan yang gagal dan meredaksi teks error di ringkasan log', () => {
    const report = {
      ok: false,
      timestamp: storagePausedReport.timestamp,
      database: { ok: false, error: 'SQLITE_BUSY' },
      ffmpeg: { ok: true },
      mediaMtx: {
        ok: false,
        enabled: true,
        error: 'connect ECONNREFUSED',
        controlApi: { ok: false, error: 'connect ECONNREFUSED rtsp://admin:rahasia@10.0.0.9/stream' },
        recordingStorage: { ok: true, paused: false }
      }
    };
    expect(failingChecks(report)).toEqual(['database', 'mediaMtx.controlApi']);
    const summary = readinessFailureSummary(report);
    expect(summary.database).toBe('SQLITE_BUSY');
    expect(summary['mediaMtx.controlApi']).not.toContain('rahasia');

    expect(failingChecks({ ok: false, timestamp: '', mediaMtx: { enabled: true, ok: false, error: 'x' } })).toEqual(['mediaMtx']);
    expect(failingChecks({ ok: true, timestamp: '', mediaMtx: { enabled: false, ok: false } })).toEqual([]);
  });
});
