import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// statfs dikendalikan test agar storage pressure dan cek ruang remux deterministik.
const disk = vi.hoisted(() => ({ totalBytes: 1e12, freeBytes: 9e11 }));
const routeLog = vi.hoisted(() => ({ fail: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const statfs = async (target: string) => {
    const real = await actual.statfs(target);
    const bsize = 4096;
    return {
      ...real,
      bsize,
      blocks: Math.floor(disk.totalBytes / bsize),
      bfree: Math.floor(disk.freeBytes / bsize),
      bavail: Math.floor(disk.freeBytes / bsize)
    };
  };
  return { ...actual, statfs, default: { ...actual, statfs } };
});

vi.mock('../../src/modules/logs/log-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/logs/log-store.js')>();
  return {
    ...actual,
    appendRouteLog: async () => {
      if (routeLog.fail) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../../../..');
const migrateScript = path.join(rootDir, 'scripts/apply-sqlite-migrations.mjs');
const hookScript = path.join(rootDir, 'scripts/recording-segment-hook.mjs');
const SIZE_MIGRATION = '20261024120000_recording_size_bytes_real';
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'stream-router-recordings-'));
const recordingRoot = path.join(tmpRoot, 'recordings');
const binDir = path.join(tmpRoot, 'bin');
const ffmpegState = path.join(tmpRoot, 'ffmpeg-state');
const authSecret = 'recording-integration-secret-0123456789abc';
const runningAsRoot = process.getuid?.() === 0;

process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3998';
process.env.DATABASE_URL = `file:${path.join(tmpRoot, 'test.db')}`;
process.env.FFMPEG_PATH = path.join(binDir, 'ffmpeg');
process.env.AUTH_SECRET = authSecret;
process.env.APP_ENCRYPTION_KEY = 'recording-integration-encryption-key-0123';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'recording-integration-password';
process.env.OPERATOR_PASSWORD = 'recording-integration-operator';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.MEDIAMTX_ENABLED = 'false';
process.env.RECORDING_PATH = recordingRoot;
process.env.TRUST_PROXY = 'true';
process.env.FAKE_FFMPEG_STATE = ffmpegState;

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: rootDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function migrate(databaseUrl: string): Promise<RunResult> {
  return run([migrateScript], { ...process.env, DATABASE_URL: databaseUrl });
}

// FFmpeg palsu: mencatat jumlah remux yang berjalan bersamaan, lalu menyalin input.
await mkdir(binDir, { recursive: true });
await writeFile(path.join(binDir, 'ffmpeg'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = process.env.FAKE_FFMPEG_STATE;
const args = process.argv.slice(2);
const input = args[args.indexOf('-i') + 1];
const output = args[args.length - 1];
const running = path.join(state, 'running');
fs.mkdirSync(running, { recursive: true });
const marker = path.join(running, String(process.pid));
fs.writeFileSync(marker, '');
fs.appendFileSync(path.join(state, 'calls.log'), fs.readdirSync(running).length + '\\n');
setTimeout(() => {
  fs.rmSync(marker, { force: true });
  if (fs.existsSync(path.join(state, 'fail'))) process.exit(1);
  fs.copyFileSync(input, output);
  process.exit(0);
}, 250);
`);
await writeFile(path.join(binDir, 'ffprobe'), `#!/usr/bin/env node
process.stdout.write('12.5\\n');
`);
await chmod(path.join(binDir, 'ffmpeg'), 0o755);
await chmod(path.join(binDir, 'ffprobe'), 0o755);
await mkdir(ffmpegState, { recursive: true });

const migration = await migrate(process.env.DATABASE_URL);
if (migration.code !== 0) throw new Error(`Migration test gagal: ${migration.stderr}`);

const { prisma } = await import('../../src/db/client.js');
const { buildApp } = await import('../../src/app.js');
const { ensureRoleCredentials } = await import('../../src/modules/auth/auth-service.js');
const service = await import('../../src/modules/recordings/recording-service.js');
const { mediamtxHookToken } = await import('../../src/modules/recordings/recording-routes.js');
const app = await buildApp();
let cookie = '';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function box(type: string, payloadBytes = 8): Buffer {
  const value = Buffer.alloc(8 + payloadBytes);
  value.writeUInt32BE(8 + payloadBytes, 0);
  value.write(type, 4, 'ascii');
  return value;
}

const fragmentedMp4 = Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat', 64)]);

function segmentName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-000000.mp4`;
}

async function writeSegment(cameraKey: string, start: Date, content = fragmentedMp4, ageMs = HOUR_MS): Promise<string> {
  const file = path.join(recordingRoot, 'cameras', cameraKey, segmentName(start));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  const modified = new Date(Date.now() - ageMs);
  await utimes(file, modified, modified);
  return file;
}

function segmentData(input: {
  cameraKey: string;
  start: Date;
  durationMs?: number;
  sizeBytes?: number;
  routeId?: string | null;
  status?: string;
  protected?: boolean;
  relativePath?: string;
  deletedAt?: Date | null;
}) {
  const durationMs = input.durationMs ?? HOUR_MS;
  return {
    id: randomUUID(),
    routeId: input.routeId ?? null,
    cameraKey: input.cameraKey,
    cameraName: input.cameraKey,
    storageRoot: recordingRoot,
    relativePath: input.relativePath ?? path.join('cameras', input.cameraKey, `${input.start.getTime()}-${Math.random().toString(36).slice(2)}.mp4`),
    startTime: input.start,
    endTime: new Date(input.start.getTime() + durationMs),
    durationMs,
    sizeBytes: input.sizeBytes ?? 1000,
    status: input.status ?? 'COMPLETE',
    protected: input.protected ?? false,
    deletedAt: input.deletedAt ?? null
  };
}

async function createSegments(rows: Array<ReturnType<typeof segmentData>>): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 2000) {
    await prisma.recordingSegment.createMany({ data: rows.slice(offset, offset + 2000) });
  }
}

async function setSettings(values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value, isSecret: false }
    });
  }
}

async function createRoute(cameraKey: string, retention: { mode?: string; days?: number | null; gb?: number | null } = {}) {
  return prisma.streamRoute.create({
    data: {
      cameraKey,
      name: `Kamera ${cameraKey}`,
      inputUrlEncrypted: 'x',
      inputProtocol: 'RTSP',
      outputsEncrypted: 'x',
      recordingRetentionMode: retention.mode ?? 'INHERIT',
      recordingRetentionDays: retention.days ?? null,
      recordingRetentionGb: retention.gb ?? null
    }
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await prisma.recordingSegment.findUnique({ where: { id } }))?.status;
}

async function ffmpegCalls(): Promise<number[]> {
  const content = await readFile(path.join(ffmpegState, 'calls.log'), 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean).map(Number);
}

beforeAll(async () => {
  await ensureRoleCredentials();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { role: 'admin', password: 'recording-integration-password' }
  });
  expect(login.statusCode).toBe(200);
  cookie = login.headers['set-cookie']?.toString().split(';')[0] ?? '';
});

beforeEach(async () => {
  disk.totalBytes = 1e12;
  disk.freeBytes = 9e11;
  routeLog.fail = false;
  await prisma.recordingSegment.deleteMany();
  await prisma.streamRoute.deleteMany();
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'recording.' } } });
  await prisma.appSetting.deleteMany({ where: { key: 'mediamtx.recordingPath' } });
  await setSettings({
    'recording.retentionMode': 'DAYS',
    'recording.retentionDays': '30',
    'recording.minFreePercent': '0',
    'recording.minFreeGb': '0'
  });
  await rm(recordingRoot, { recursive: true, force: true });
  await mkdir(recordingRoot, { recursive: true });
});

afterAll(async () => {
  service.stopRecordingManager();
  await app.close();
  await prisma.$disconnect();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('Recording: kolom sizeBytes di atas 2 GiB', () => {
  it('migration REAL mempertahankan data lama, menolkan route yang hilang, dan membaca segment 2,7 GB', async () => {
    const legacyUrl = `file:${path.join(tmpRoot, 'legacy.db')}?connection_limit=1`;
    const legacy = new PrismaClient({ datasourceUrl: legacyUrl });
    try {
      await legacy.$executeRawUnsafe(`CREATE TABLE "_stream_router_migrations" (
        "name" TEXT PRIMARY KEY NOT NULL,
        "checksum" TEXT NOT NULL,
        "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      const migrationsDir = path.join(rootDir, 'prisma/migrations');
      const names = (await readdir(migrationsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(names).toContain(SIZE_MIGRATION);
      for (const name of names.slice(0, names.indexOf(SIZE_MIGRATION))) {
        const sql = await readFile(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
        // Komentar dibuang lebih dulu karena boleh memuat `;` (mis. migration require_route_camera_key).
        const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
          .split(';')
          .map((statement) => statement.trim())
          .filter(Boolean);
        for (const statement of statements) await legacy.$executeRawUnsafe(statement);
        await legacy.$executeRawUnsafe(
          'INSERT INTO "_stream_router_migrations" ("name", "checksum") VALUES (?, ?)',
          name,
          createHash('sha256').update(sql).digest('hex')
        );
      }
      await legacy.$executeRawUnsafe(`INSERT INTO "StreamRoute" ("id", "cameraKey", "name", "inputUrlEncrypted", "inputProtocol", "outputsEncrypted", "updatedAt")
        VALUES ('route-legacy', 'cam-legacy', 'Kamera Lama', 'x', 'RTSP', 'x', 0)`);
      // Baris lama dengan routeId yang tidak lagi ada (foreign key pernah nonaktif).
      await legacy.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
      await legacy.$executeRawUnsafe(`INSERT INTO "RecordingSegment" ("id", "routeId", "cameraKey", "cameraName", "storageRoot", "relativePath", "startTime", "endTime", "durationMs", "sizeBytes", "status", "protected", "deletionReason", "errorMessage", "updatedAt")
        VALUES
          ('seg-big', 'route-legacy', 'cam-legacy', 'Kamera Lama', '/rec', 'cameras/cam-legacy/a.mp4', 1792800000000, 1792803600000, 3600000, 2700000000, 'COMPLETE', 1, 'manual', NULL, 0),
          ('seg-orphan', 'route-hilang', 'cam-hilang', 'Kamera Hilang', '/rec', 'cameras/cam-hilang/b.mp4', 1792800000000, 1792800001000, 1000, 1234, 'ERROR', 0, NULL, 'rusak', 0)`);
      await legacy.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    } finally {
      await legacy.$disconnect();
    }

    const applied = await migrate(legacyUrl);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toContain(SIZE_MIGRATION);

    const migrated = new PrismaClient({ datasourceUrl: legacyUrl });
    try {
      const columns = await migrated.$queryRawUnsafe<Array<{ name: string; type: string }>>('PRAGMA table_info("RecordingSegment")');
      expect(columns.find((column) => column.name === 'sizeBytes')?.type).toBe('REAL');
      const indexes = await migrated.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA index_list("RecordingSegment")');
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        'RecordingSegment_storageRoot_relativePath_key',
        'RecordingSegment_routeId_startTime_idx',
        'RecordingSegment_cameraKey_startTime_idx',
        'RecordingSegment_status_protected_startTime_idx'
      ]));
      expect(await migrated.recordingSegment.findUnique({ where: { id: 'seg-big' } })).toMatchObject({
        routeId: 'route-legacy',
        sizeBytes: 2_700_000_000,
        protected: true,
        deletionReason: 'manual'
      });
      expect(await migrated.recordingSegment.findUnique({ where: { id: 'seg-orphan' } })).toMatchObject({
        routeId: null,
        status: 'ERROR',
        errorMessage: 'rusak'
      });
      await migrated.recordingSegment.create({
        data: segmentData({ cameraKey: 'cam-legacy', start: new Date(), sizeBytes: 5_000_000_123, relativePath: 'cameras/cam-legacy/c.mp4' })
      });
      expect((await migrated.recordingSegment.aggregate({ _sum: { sizeBytes: true } }))._sum.sizeBytes).toBe(2_700_000_000 + 1234 + 5_000_000_123);
    } finally {
      await migrated.$disconnect();
    }
  });

  it('list, storage, refresh aktif, dan cleanup tetap berjalan dengan segment 3 GB', async () => {
    const route = await createRoute('cam-besar');
    const file = await writeSegment('cam-besar', new Date(Date.now() - 2 * HOUR_MS));
    await createSegments([
      segmentData({ cameraKey: 'cam-besar', routeId: route.id, start: new Date(Date.now() - 3 * HOUR_MS), sizeBytes: 3_000_000_000 }),
      segmentData({
        cameraKey: 'cam-besar',
        routeId: route.id,
        start: new Date(Date.now() - 2 * HOUR_MS),
        sizeBytes: fragmentedMp4.length,
        relativePath: path.relative(recordingRoot, file)
      })
    ]);
    const listed = await app.inject({ method: 'GET', url: `/api/recordings?routeId=${route.id}`, headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ sizeBytes: 3_000_000_000 })]));
    const storage = await app.inject({ method: 'GET', url: '/api/recordings/storage', headers: { cookie } });
    expect(storage.json().usedByRecordingsBytes).toBe(3_000_000_000 + fragmentedMp4.length);
    await expect(service.cleanupRecordings()).resolves.toMatchObject({ deleted: 0, quotaExceeded: [] });
    await expect(service.reconcileRecordingFiles()).resolves.toMatchObject({ missing: 1 });
  });
});

describe('Recording manager', () => {
  it('membuat timer sebelum pass awal, tidak menahan startup, dan tetap membersihkan setelah pass awal gagal', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const blocker = path.join(tmpRoot, 'bukan-folder');
      await writeFile(blocker, 'file biasa');
      await setSettings({ 'mediamtx.recordingPath': path.join(blocker, 'recordings') });

      await service.startRecordingManager();
      let settled = false;
      const idle = service.recordingManagerIdle().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await idle;
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('[recording] Cleanup gagal'));
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('[recording] Scanner gagal'));

      await setSettings({ 'mediamtx.recordingPath': recordingRoot });
      // File tetap ada agar scanner tidak menandainya MISSING sebelum cleanup berjalan.
      const expiredStart = new Date(Date.now() - 40 * DAY_MS);
      const expiredFile = await writeSegment('cam-timer', expiredStart);
      const expired = segmentData({
        cameraKey: 'cam-timer',
        start: expiredStart,
        sizeBytes: fragmentedMp4.length,
        relativePath: path.relative(recordingRoot, expiredFile)
      });
      await createSegments([expired]);
      vi.advanceTimersByTime(60_000);
      await service.recordingManagerIdle();
      expect(await statusOf(expired.id)).toBe('DELETED');
      await expect(stat(expiredFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      service.stopRecordingManager();
      vi.useRealTimers();
      errors.mockRestore();
    }
  });
});

describe('Recording scanner', () => {
  it('menandai MISSING per halaman dan tidak meng-ffprobe ulang segment COMPLETE', async () => {
    const start = new Date(Date.now() - 3 * DAY_MS);
    await createSegments(Array.from({ length: 1200 }, (_, index) => segmentData({
      cameraKey: 'cam-hilang',
      start: new Date(start.getTime() + index * 1000)
    })));
    const keptFile = await writeSegment('cam-ada', start);
    const kept = await prisma.recordingSegment.create({
      data: segmentData({
        cameraKey: 'cam-ada',
        start,
        durationMs: 5000,
        sizeBytes: fragmentedMp4.length,
        relativePath: path.relative(recordingRoot, keptFile)
      })
    });

    const result = await service.reconcileRecordingFiles();
    expect(result.missing).toBe(1200);
    expect(await prisma.recordingSegment.count({ where: { status: 'MISSING' } })).toBe(1200);
    // ffprobe palsu selalu melaporkan 12,5 detik; durasi dari hook tidak boleh ditimpa.
    expect(await prisma.recordingSegment.findUnique({ where: { id: kept.id } })).toMatchObject({ status: 'COMPLETE', durationMs: 5000 });
  });

  it('hanya mengingat file yang belum COMPLETE di antara scan', async () => {
    const file = await writeSegment('cam-live', new Date(Date.now() - 1000), fragmentedMp4, 0);
    await service.reconcileRecordingFiles();
    expect(service.recordingScannerStateForTests().stableFiles).toBe(1);
    expect(await prisma.recordingSegment.findFirst({ where: { cameraKey: 'cam-live' } })).toMatchObject({ status: 'RECORDING' });

    await service.indexRecordingSegment({ segmentPath: file, duration: '5s' });
    await service.reconcileRecordingFiles();
    expect(service.recordingScannerStateForTests().stableFiles).toBe(0);
  });

  it('log route yang gagal ditulis tidak membuat segment valid menjadi ERROR', async () => {
    await createRoute('cam-log');
    await writeSegment('cam-log', new Date(Date.now() - 2 * HOUR_MS));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await service.reconcileRecordingFiles();
      vi.setSystemTime(Date.now() + 11_000);
      routeLog.fail = true;
      const result = await service.reconcileRecordingFiles();
      expect(result.indexed).toBe(1);
      expect(await prisma.recordingSegment.findFirst({ where: { cameraKey: 'cam-log' } })).toMatchObject({
        status: 'COMPLETE',
        durationMs: 12_500
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(runningAsRoot)('kegagalan baca sementara dicoba ulang dan baru ERROR setelah gagal berulang', async () => {
    const recovered = await writeSegment('cam-pulih', new Date(Date.now() - 2 * HOUR_MS));
    const broken = await writeSegment('cam-rusak', new Date(Date.now() - 2 * HOUR_MS));
    await chmod(recovered, 0o000);
    await chmod(broken, 0o000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const scan = async () => {
        vi.setSystemTime(Date.now() + 11_000);
        await service.reconcileRecordingFiles();
      };
      await scan();
      await scan();
      await scan();
      expect(await prisma.recordingSegment.count({ where: { status: 'ERROR' } })).toBe(0);
      expect(service.recordingScannerStateForTests().indexFailures).toBe(2);

      await chmod(recovered, 0o644);
      await scan();
      expect(await prisma.recordingSegment.findFirst({ where: { cameraKey: 'cam-pulih' } })).toMatchObject({ status: 'COMPLETE' });
      expect(await prisma.recordingSegment.findFirst({ where: { cameraKey: 'cam-rusak' } })).toMatchObject({ status: 'ERROR' });
    } finally {
      vi.useRealTimers();
      await chmod(recovered, 0o644).catch(() => undefined);
      await chmod(broken, 0o644).catch(() => undefined);
    }
  });
});

describe('Recording cleanup', () => {
  it('menerapkan retention hari per route, Camera ID yatim, dan default termasuk segment ERROR', async () => {
    const shortRoute = await createRoute('cam-pendek', { mode: 'DAYS', days: 1 });
    const inheritRoute = await createRoute('cam-warisan');
    const old = new Date(Date.now() - 3 * DAY_MS);
    const veryOld = new Date(Date.now() - 40 * DAY_MS);
    const rows = {
      shortOld: segmentData({ cameraKey: 'cam-pendek', routeId: shortRoute.id, start: old }),
      shortNew: segmentData({ cameraKey: 'cam-pendek', routeId: shortRoute.id, start: new Date(Date.now() - 2 * HOUR_MS) }),
      shortOrphan: segmentData({ cameraKey: 'cam-pendek', start: old }),
      shortProtected: segmentData({ cameraKey: 'cam-pendek', routeId: shortRoute.id, start: old, protected: true }),
      shortError: segmentData({ cameraKey: 'cam-pendek', routeId: shortRoute.id, start: old, status: 'ERROR' }),
      inheritOld: segmentData({ cameraKey: 'cam-warisan', routeId: inheritRoute.id, start: old }),
      inheritExpired: segmentData({ cameraKey: 'cam-warisan', routeId: inheritRoute.id, start: veryOld }),
      unknownOld: segmentData({ cameraKey: 'cam-asing', start: old }),
      unknownExpired: segmentData({ cameraKey: 'cam-asing', start: veryOld }),
      missingExpired: segmentData({ cameraKey: 'cam-asing', start: veryOld, status: 'MISSING' })
    };
    await createSegments(Object.values(rows));
    const ids = Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.id]));

    const result = await service.cleanupRecordings();
    expect(result.deleted).toBe(5);
    for (const key of ['shortOld', 'shortOrphan', 'shortError', 'inheritExpired', 'unknownExpired']) {
      expect(await statusOf(ids[key]!), key).toBe('DELETED');
    }
    expect(await statusOf(ids.shortNew!)).toBe('COMPLETE');
    expect(await statusOf(ids.shortProtected!)).toBe('COMPLETE');
    expect(await statusOf(ids.inheritOld!)).toBe('COMPLETE');
    expect(await statusOf(ids.unknownOld!)).toBe('COMPLETE');
    expect(await statusOf(ids.missingExpired!)).toBe('MISSING');
  });

  it('menerapkan kuota GB per kamera lintas halaman, tertua lebih dulu, melewati protected', async () => {
    await setSettings({ 'recording.retentionMode': 'SIZE', 'recording.retentionMaxGb': '0.001' });
    const start = new Date(Date.now() - 2 * DAY_MS);
    const quotaRows = Array.from({ length: 1200 }, (_, index) => segmentData({
      cameraKey: 'cam-kuota',
      start: new Date(start.getTime() + index * 1000),
      protected: index < 600
    }));
    await createSegments([
      ...quotaRows,
      ...Array.from({ length: 10 }, (_, index) => segmentData({ cameraKey: 'cam-kecil', start: new Date(start.getTime() + index * 1000) })),
      ...Array.from({ length: 1200 }, (_, index) => segmentData({
        cameraKey: 'cam-terkunci',
        start: new Date(start.getTime() + index * 1000),
        protected: true
      }))
    ]);

    const result = await service.cleanupRecordings();
    // 1.200.000 byte terhadap batas 1.073.741 byte: 127 segment unprotected tertua dihapus.
    expect(result.deleted).toBe(127);
    const deleted = await prisma.recordingSegment.findMany({
      where: { status: 'DELETED' },
      orderBy: { startTime: 'asc' },
      select: { cameraKey: true, startTime: true }
    });
    expect(deleted).toHaveLength(127);
    expect(deleted.every((row) => row.cameraKey === 'cam-kuota')).toBe(true);
    expect(deleted[0]!.startTime.getTime()).toBe(start.getTime() + 600 * 1000);
    expect(deleted.at(-1)!.startTime.getTime()).toBe(start.getTime() + 726 * 1000);
    expect(result.quotaExceeded).toEqual([{ cameraKey: 'cam-terkunci', usedBytes: 1_200_000, limitBytes: 0.001 * 1024 ** 3 }]);
  });

  it.skipIf(runningAsRoot)('file yang tidak dapat dihapus tidak menghentikan retention kamera lain dan storage guard', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lockedFile = await writeSegment('cam-terkunci', new Date(Date.now() - 41 * DAY_MS));
    const freeFile = await writeSegment('cam-bebas', new Date(Date.now() - 40 * DAY_MS));
    const locked = segmentData({ cameraKey: 'cam-terkunci', start: new Date(Date.now() - 41 * DAY_MS), relativePath: path.relative(recordingRoot, lockedFile) });
    const free = segmentData({ cameraKey: 'cam-bebas', start: new Date(Date.now() - 40 * DAY_MS), relativePath: path.relative(recordingRoot, freeFile) });
    await createSegments([locked, free]);
    await chmod(path.dirname(lockedFile), 0o555);
    try {
      const result = await service.cleanupRecordings();
      expect(result).toMatchObject({ deleted: 1, paused: false, totalBytes: 1e12 });
      expect(await statusOf(locked.id)).toBe('COMPLETE');
      expect(await statusOf(free.id)).toBe('DELETED');
      await expect(stat(freeFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(lockedFile)).resolves.toBeTruthy();
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('Gagal menghapus recording'));

      // Selama masa tunggu retry, file yang sama tidak dicoba (dan tidak dicatat) ulang.
      const loggedBefore = errors.mock.calls.length;
      await service.cleanupRecordings();
      expect(errors.mock.calls.length).toBe(loggedBefore);
      expect(service.recordingScannerStateForTests().deleteRetries).toBe(1);
    } finally {
      await chmod(path.dirname(lockedFile), 0o755);
      errors.mockRestore();
    }
  });

  it('menghapus tombstone DELETED lama secara bertahap', async () => {
    const start = new Date(Date.now() - 20 * DAY_MS);
    await createSegments([
      ...Array.from({ length: 1500 }, (_, index) => segmentData({
        cameraKey: 'cam-tombstone',
        start: new Date(start.getTime() + index * 1000),
        status: 'DELETED',
        deletedAt: new Date(Date.now() - 8 * DAY_MS)
      })),
      ...Array.from({ length: 2 }, (_, index) => segmentData({
        cameraKey: 'cam-tombstone',
        start: new Date(start.getTime() - (index + 1) * 1000),
        status: 'DELETED',
        deletedAt: new Date(Date.now() - DAY_MS)
      }))
    ]);
    await service.cleanupRecordings();
    expect(await prisma.recordingSegment.count({ where: { status: 'DELETED' } })).toBe(2);
  });

  it('storage pressure mengosongkan playback cache sebelum menghapus recording tertua', async () => {
    await setSettings({ 'recording.minFreePercent': '10' });
    disk.freeBytes = 5e10;
    const cacheDirectory = path.join(recordingRoot, '.playback-cache');
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(path.join(cacheDirectory, 'cache-lama.mp4'), 'cache');
    await writeFile(path.join(cacheDirectory, '.remux-berjalan.tmp.mp4'), 'sementara');
    const start = new Date(Date.now() - 5 * DAY_MS);
    const created = [
      segmentData({ cameraKey: 'cam-penuh', start, sizeBytes: 6e10, protected: true }),
      segmentData({ cameraKey: 'cam-penuh', start: new Date(start.getTime() + 1000), sizeBytes: 6e10, status: 'ERROR' }),
      segmentData({ cameraKey: 'cam-penuh', start: new Date(start.getTime() + 2000), sizeBytes: 6e10 }),
      segmentData({ cameraKey: 'cam-penuh', start: new Date(start.getTime() + 3000), sizeBytes: 6e10 })
    ];
    await createSegments(created);

    // Batas 10% = 100 GB, recovery = 150 GB; free 50 GB naik 60 GB per segment yang dihapus.
    const result = await service.cleanupRecordings();
    expect(result).toMatchObject({ deleted: 2, paused: false });
    expect((await readdir(cacheDirectory)).sort()).toEqual(['.remux-berjalan.tmp.mp4']);
    expect(await Promise.all(created.map((row) => statusOf(row.id)))).toEqual(['COMPLETE', 'DELETED', 'DELETED', 'COMPLETE']);
  });
});

describe('Recording API kalender dan timeline', () => {
  it('timeline memuat seluruh segment hari lokal untuk 100 kamera', async () => {
    const route = await createRoute('cam-000');
    // Asia/Jakarta UTC+7: 19 Okt lokal = 18 Okt 17:00Z sampai 19 Okt 17:00Z.
    const first = Date.UTC(2026, 9, 16, 17);
    const rows = [];
    for (let hour = 0; hour < 5 * 24; hour += 1) {
      for (let camera = 0; camera < 100; camera += 1) {
        const cameraKey = `cam-${String(camera).padStart(3, '0')}`;
        rows.push(segmentData({
          cameraKey,
          routeId: camera === 0 ? route.id : null,
          start: new Date(first + hour * HOUR_MS + camera * 1000)
        }));
      }
    }
    await createSegments(rows);

    const response = await app.inject({
      method: 'GET',
      url: '/api/recordings/timeline?date=2026-10-19&timeZone=Asia%2FJakarta',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ startTime: string }>; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(2400);
    expect(body.items[0]!.startTime).toBe('2026-10-18T17:00:00.000Z');
    expect(body.items.at(-1)!.startTime).toBe('2026-10-19T16:01:39.000Z');

    const single = await app.inject({
      method: 'GET',
      url: `/api/recordings/timeline?date=2026-10-19&timeZone=Asia%2FJakarta&routeId=${route.id}`,
      headers: { cookie }
    });
    expect(single.json().items).toHaveLength(24);
  });

  it('timeline memberi tanda truncated bila satu hari melebihi batas', async () => {
    const first = Date.UTC(2026, 9, 25, 0);
    await createSegments(Array.from({ length: 5001 }, (_, index) => segmentData({
      cameraKey: 'cam-padat',
      start: new Date(first + index * 15_000),
      durationMs: 15_000
    })));
    const response = await app.inject({
      method: 'GET',
      url: '/api/recordings/timeline?date=2026-10-25&timeZone=UTC',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().truncated).toBe(true);
    expect(response.json().items).toHaveLength(5000);
  });

  it('kalender mengagregasi per hari lokal dengan benar melewati DST dan ukuran besar', async () => {
    const timeZone = 'America/New_York';
    const first = Date.UTC(2026, 1, 27, 0);
    const rows = Array.from({ length: 34 * 24 }, (_, index) => segmentData({
      cameraKey: 'cam-dst',
      start: new Date(first + index * HOUR_MS),
      sizeBytes: 3_000_000_000
    }));
    await createSegments(rows);
    const oracle = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const expected = new Map<string, { count: number; sizeBytes: number; durationMs: number }>();
    for (const row of rows) {
      const date = oracle.format(row.startTime);
      if (!date.startsWith('2026-03-')) continue;
      const current = expected.get(date) ?? { count: 0, sizeBytes: 0, durationMs: 0 };
      current.count += 1;
      current.sizeBytes += row.sizeBytes;
      current.durationMs += row.durationMs;
      expected.set(date, current);
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/recordings/calendar?month=2026-03&timeZone=${encodeURIComponent(timeZone)}`,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().days).toEqual([...expected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => ({ date, ...value })));
    expect(response.json().days.find((day: { date: string }) => day.date === '2026-03-08')).toMatchObject({ count: 23 });
    // Bulan tidak valid ditolak validasi (ZodError), bukan dihitung sebagai tanggal sembarang.
    const invalidMonth = await app.inject({
      method: 'GET',
      url: '/api/recordings/calendar?month=2026-13&timeZone=UTC',
      headers: { cookie }
    });
    expect(invalidMonth.statusCode).toBeGreaterThanOrEqual(400);
    expect(invalidMonth.body).not.toContain('"days"');
  });

  it('refresh recording aktif digabung untuk polling bersamaan dan menandai file aktif yang hilang', async () => {
    const liveFile = await writeSegment('cam-aktif', new Date(Date.now() - 30_000), fragmentedMp4, 0);
    const created = [
      segmentData({ cameraKey: 'cam-aktif', start: new Date(Date.now() - 30_000), durationMs: 1, sizeBytes: 0, status: 'RECORDING', relativePath: path.relative(recordingRoot, liveFile) }),
      segmentData({ cameraKey: 'cam-mati', start: new Date(Date.now() - 2 * 60_000), durationMs: 1, sizeBytes: 0, status: 'RECORDING' }),
      segmentData({ cameraKey: 'cam-selesai', start: new Date(Date.now() - 2 * 60_000), durationMs: 5000, status: 'COMPLETE' })
    ];
    await createSegments(created);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10_000);
      const first = service.refreshActiveRecordings();
      expect(service.refreshActiveRecordings()).toBe(first);
      await first;
    } finally {
      vi.useRealTimers();
    }
    const [live, dead, complete] = await Promise.all(created.map((row) => prisma.recordingSegment.findUnique({ where: { id: row.id } })));
    expect(live).toMatchObject({ status: 'RECORDING', sizeBytes: fragmentedMp4.length });
    expect(live!.durationMs).toBeGreaterThan(30_000);
    expect(dead).toMatchObject({ status: 'ERROR' });
    expect(complete).toMatchObject({ status: 'COMPLETE', durationMs: 5000 });
  });
});

describe('Recording hook MediaMTX', () => {
  it('hanya menerima socket loopback dan token turunan, tanpa rate limit', async () => {
    const file = await writeSegment('cam-hook', new Date(Date.now() - HOUR_MS));
    const payload = { path: 'cameras/cam-hook', segmentPath: file, event: 'COMPLETE', duration: '5s' };
    const token = mediamtxHookToken();
    expect((await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/segments',
      headers: { 'x-mediamtx-hook-token': authSecret },
      payload
    })).statusCode).toBe(401);
    // TRUST_PROXY aktif: X-Forwarded-For palsu tidak boleh membuat request luar tampak lokal.
    expect((await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/segments',
      remoteAddress: '203.0.113.9',
      headers: { 'x-mediamtx-hook-token': token, 'x-forwarded-for': '127.0.0.1' },
      payload
    })).statusCode).toBe(403);
    const accepted = await app.inject({
      method: 'POST',
      url: '/internal/mediamtx/segments',
      remoteAddress: '::ffff:127.0.0.1',
      headers: { 'x-mediamtx-hook-token': token },
      payload
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'COMPLETE', durationMs: 5000 });
    expect(accepted.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('script hook mengirim token yang sama dengan API', async () => {
    const received: string[] = [];
    const server = http.createServer((request, response) => {
      received.push(String(request.headers['x-mediamtx-hook-token']));
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await run([hookScript, 'create'], {
        ...process.env,
        PORT: String(port),
        AUTH_SECRET: authSecret,
        MTX_SEGMENT_PATH: path.join(recordingRoot, 'cameras', 'cam-hook', 'x.mp4')
      });
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(received).toEqual([mediamtxHookToken(authSecret)]);
  });
});

describe('Recording playback cache', () => {
  async function playableRecording(name: string) {
    const start = new Date(Date.now() - 3 * HOUR_MS - Math.floor(Math.random() * HOUR_MS));
    const file = await writeSegment(`cam-${name}`, start);
    return prisma.recordingSegment.create({
      data: segmentData({
        cameraKey: `cam-${name}`,
        start,
        sizeBytes: fragmentedMp4.length,
        relativePath: path.relative(recordingRoot, file)
      })
    });
  }

  function play(id: string) {
    return app.inject({ method: 'GET', url: `/api/recordings/playback?id=${id}`, headers: { cookie } });
  }

  beforeEach(async () => {
    await rm(ffmpegState, { recursive: true, force: true });
    await mkdir(ffmpegState, { recursive: true });
  });

  it('membatasi remux paralel dan memakai ulang cache tanpa remux ulang', async () => {
    const rows = await Promise.all(['satu', 'dua', 'tiga', 'empat'].map(playableRecording));
    const responses = await Promise.all(rows.map((row) => play(row.id)));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    const calls = await ffmpegCalls();
    expect(calls).toHaveLength(4);
    expect(Math.max(...calls)).toBeLessThanOrEqual(2);
    const cached = await readdir(path.join(recordingRoot, '.playback-cache'));
    expect(cached.sort()).toEqual(rows.map((row) => `${row.id}.mp4`).sort());

    const again = await play(rows[0]!.id);
    expect(again.statusCode).toBe(200);
    expect(again.rawPayload.equals(fragmentedMp4)).toBe(true);
    expect(await ffmpegCalls()).toHaveLength(4);
  });

  it('remux yang gagal tidak diulang pada request berikutnya', async () => {
    await writeFile(path.join(ffmpegState, 'fail'), '');
    const row = await playableRecording('gagal');
    expect((await play(row.id)).statusCode).toBe(200);
    expect((await play(row.id)).statusCode).toBe(200);
    expect(await ffmpegCalls()).toHaveLength(1);
  });

  it('tidak me-remux bila ruang kosong di bawah batas recovery storage guard', async () => {
    // Recovery = max(5% x 1 TB, 5 GB) = 50 GB.
    disk.freeBytes = 4e10;
    const row = await playableRecording('sempit');
    const first = await play(row.id);
    expect(first.statusCode).toBe(200);
    expect(first.rawPayload.equals(fragmentedMp4)).toBe(true);
    disk.freeBytes = 9e11;
    expect((await play(row.id)).statusCode).toBe(200);
    expect(await ffmpegCalls()).toHaveLength(0);
    expect(await readdir(path.join(recordingRoot, '.playback-cache')).catch(() => [])).toEqual([]);
  });
});

describe('Recording cleanup pada storage yang tidak dapat ditulis', () => {
  it.skipIf(runningAsRoot)('tidak menulis SQLite untuk recording yang tidak dapat dihapus dan meringkas log kegagalan', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lockedStart = Date.now() - 60 * DAY_MS;
    const lockedRows = [];
    for (let index = 0; index < 30; index += 1) {
      const start = new Date(lockedStart + index * 1000);
      const file = await writeSegment('cam-readonly', start);
      lockedRows.push(segmentData({ cameraKey: 'cam-readonly', start, relativePath: path.relative(recordingRoot, file) }));
    }
    const freeFile = await writeSegment('cam-normal', new Date(Date.now() - 40 * DAY_MS));
    const free = segmentData({ cameraKey: 'cam-normal', start: new Date(Date.now() - 40 * DAY_MS), relativePath: path.relative(recordingRoot, freeFile) });
    await createSegments([...lockedRows, free]);
    const before = new Map((await prisma.recordingSegment.findMany({ where: { cameraKey: 'cam-readonly' } }))
      .map((row) => [row.id, row.updatedAt.getTime()]));
    const lockedDirectory = path.join(recordingRoot, 'cameras', 'cam-readonly');
    await chmod(lockedDirectory, 0o555);
    try {
      const result = await service.cleanupRecordings();
      // Recording lain tetap dihapus pada pass yang sama.
      expect(result.deleted).toBe(1);
      expect(await statusOf(free.id)).toBe('DELETED');

      const after = await prisma.recordingSegment.findMany({ where: { cameraKey: 'cam-readonly' } });
      expect(after.every((row) => row.status === 'COMPLETE')).toBe(true);
      for (const row of after) expect(row.updatedAt.getTime()).toBe(before.get(row.id));

      const messages = errors.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((message) => message.includes('Gagal menghapus recording'))).toHaveLength(5);
      const summary = messages.filter((message) => message.includes('recording lain juga gagal dihapus'));
      expect(summary).toHaveLength(1);
      expect(summary[0]).toContain('25 recording lain');
      expect(summary[0]).toContain('EACCES: 25');
    } finally {
      await chmod(lockedDirectory, 0o755);
      errors.mockRestore();
    }
  });
});
