import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIAMTX_VERSION,
  PINNED_MEDIAMTX_SHA256,
  pinnedArchiveSha256,
  releaseChecksum
} from '../../../../scripts/ensure-mediamtx.mjs';
import {
  credentialProblems,
  mediaMtxExecutable,
  normalizePublicHost,
  parseEnvFile,
  planRestart,
  ProcessSupervisor,
  resolveSecrets,
  restartDelayMs,
  RESTART_POLICY,
  serializeSecretsFile,
  sqliteDatabaseFile
} from '../../../../scripts/lib/container-supervisor-lib.mjs';
import { envSchema } from '../../src/config/env.js';

const validSecret = 'a'.repeat(43);
const otherSecret = 'b'.repeat(43);

describe('backoff restart supervisor container', () => {
  it('menggandakan jeda dari 1 detik sampai batas 30 detik', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((failures) => restartDelayMs(failures))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
    ]);
  });

  it('menaikkan hitungan untuk crash beruntun dan mereset setelah 60 detik stabil', () => {
    let failures = 0;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const plan = planRestart(failures, 500);
      delays.push(plan.delayMs);
      failures = plan.failures;
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(planRestart(failures, RESTART_POLICY.stableAfterMs - 1).delayMs).toBe(16_000);
    expect(planRestart(failures, RESTART_POLICY.stableAfterMs)).toEqual({ delayMs: 1_000, failures: 1 });
  });
});

describe('bootstrap secret container', () => {
  it('membuat kedua secret sekali lalu memakai ulang nilai tersimpan', () => {
    let counter = 0;
    const generate = () => `generated-${++counter}-${'x'.repeat(40)}`;
    const first = resolveSecrets({ env: {}, generate });
    expect(first.problems).toEqual([]);
    expect(first.sources).toEqual({ AUTH_SECRET: 'generated', APP_ENCRYPTION_KEY: 'generated' });
    expect(first.persist).toEqual(first.values);
    expect(first.values.AUTH_SECRET).not.toBe(first.values.APP_ENCRYPTION_KEY);

    const stored = parseEnvFile(serializeSecretsFile(first.persist!));
    const second = resolveSecrets({ env: {}, stored, databaseExists: true, generate });
    expect(second.values).toEqual(first.values);
    expect(second.sources).toEqual({ AUTH_SECRET: 'file', APP_ENCRYPTION_KEY: 'file' });
    expect(second.persist).toBeNull();
    expect(counter).toBe(2);
  });

  it('memakai secret secara default 32 byte base64url', () => {
    const result = resolveSecrets({ env: {} });
    for (const value of Object.values(result.values)) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('mengutamakan nilai environment tanpa menyimpannya, dan nilai kosong dianggap belum diisi', () => {
    const result = resolveSecrets({
      env: { AUTH_SECRET: `  ${validSecret}  `, APP_ENCRYPTION_KEY: '' },
      stored: { APP_ENCRYPTION_KEY: otherSecret },
      databaseExists: true
    });
    expect(result.problems).toEqual([]);
    expect(result.values).toEqual({ AUTH_SECRET: validSecret, APP_ENCRYPTION_KEY: otherSecret });
    expect(result.sources).toEqual({ AUTH_SECRET: 'env', APP_ENCRYPTION_KEY: 'file' });
    expect(result.persist).toBeNull();
  });

  it('hanya membuat key yang belum ada dan mempertahankan isi file lain', () => {
    const result = resolveSecrets({ env: {}, stored: { APP_ENCRYPTION_KEY: validSecret, LAIN: 'tetap' }, databaseExists: true, generate: () => otherSecret });
    expect(result.sources).toEqual({ AUTH_SECRET: 'generated', APP_ENCRYPTION_KEY: 'file' });
    expect(result.persist).toEqual({ APP_ENCRYPTION_KEY: validSecret, LAIN: 'tetap', AUTH_SECRET: otherSecret });
  });

  it('menolak membuat APP_ENCRYPTION_KEY baru bila database sudah ada', () => {
    const result = resolveSecrets({ env: {}, stored: {}, databaseExists: true, generate: () => validSecret });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('APP_ENCRYPTION_KEY');
    expect(result.values.APP_ENCRYPTION_KEY).toBeUndefined();
  });

  it('menolak placeholder atau secret pendek tanpa menampilkan nilainya', () => {
    const placeholder = 'GANTI_DENGAN_SECRET_ACAK_MINIMAL_32_KARAKTER';
    const result = resolveSecrets({ env: { AUTH_SECRET: placeholder }, stored: { APP_ENCRYPTION_KEY: 'pendek-rahasia' } });
    expect(result.problems).toHaveLength(2);
    expect(result.problems.join(' ')).not.toContain(placeholder);
    expect(result.problems.join(' ')).not.toContain('pendek-rahasia');
    expect(result.persist).toBeNull();
  });

  it('memperingatkan bila APP_ENCRYPTION_KEY environment berbeda dari key tersimpan', () => {
    const result = resolveSecrets({ env: { APP_ENCRYPTION_KEY: validSecret }, stored: { APP_ENCRYPTION_KEY: otherSecret, AUTH_SECRET: otherSecret } });
    expect(result.values.APP_ENCRYPTION_KEY).toBe(validSecret);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toContain(validSecret);
  });

  it('membaca file env dengan komentar, kutip, export, dan CRLF', () => {
    expect(parseEnvFile('# komentar\r\nAUTH_SECRET=abc\r\n\r\nexport APP_ENCRYPTION_KEY="d e f"\nX=\'g\'\nY=h # catatan\nbukan baris\n')).toEqual({
      AUTH_SECRET: 'abc',
      APP_ENCRYPTION_KEY: 'd e f',
      X: 'g',
      Y: 'h'
    });
  });
});

describe('validasi password role container', () => {
  it('melaporkan password kosong, placeholder, dan terlalu pendek tanpa nilainya', () => {
    expect(credentialProblems({})).toEqual(['ADMIN_PASSWORD belum diisi', 'OPERATOR_PASSWORD belum diisi']);
    const problems = credentialProblems({ ADMIN_PASSWORD: 'GANTI_DENGAN_PASSWORD_ADMIN_KUAT', OPERATOR_PASSWORD: 'rahasia' });
    expect(problems).toEqual(['ADMIN_PASSWORD masih memakai nilai contoh', 'OPERATOR_PASSWORD minimal 8 karakter']);
    expect(problems.join(' ')).not.toContain('rahasia');
    expect(credentialProblems({ ADMIN_PASSWORD: 'admin-kuat-1', OPERATOR_PASSWORD: 'operator-kuat-1' })).toEqual([]);
  });
});

describe('validasi HOST_LAN_IP container', () => {
  const samples = [
    '', '   ', '192.168.1.10', ' 192.168.1.10 ', 'kamera.lan', 'PC-KAMERA', 'fd00::10', '[fd00::10]',
    '192.168.1.10:3000', 'http://192.168.1.10', 'https://kamera.lan', '192.168.1.10/', 'kamera.lan:8889',
    '192.168.1', '192.168.1.256', 'kamera_lan', '-kamera', 'kamera..lan', '[kamera.lan]', '192.168.1.10 # LAN'
  ];

  it('menormalisasi host valid dan menolak skema, port, path, atau IPv4 salah ketik', () => {
    expect(normalizePublicHost(undefined)).toBe('');
    expect(normalizePublicHost('  ')).toBe('');
    expect(normalizePublicHost(' 192.168.1.10 ')).toBe('192.168.1.10');
    expect(normalizePublicHost('[fd00::10]')).toBe('fd00::10');
    expect(normalizePublicHost('kamera.lan')).toBe('kamera.lan');
    for (const value of ['192.168.1.10:3000', 'http://192.168.1.10', '192.168.1.10/', '192.168.1']) {
      expect(normalizePublicHost(value), value).toBeNull();
    }
  });

  it('memakai aturan yang sama dengan MEDIAMTX_PUBLIC_HOST di env API', () => {
    const apiRule = envSchema.shape.MEDIAMTX_PUBLIC_HOST;
    for (const value of samples) {
      const parsed = apiRule.safeParse(value);
      expect(normalizePublicHost(value), value).toBe(parsed.success ? parsed.data : null);
    }
  });
});

describe('path runtime container', () => {
  it('menurunkan file SQLite dari DATABASE_URL seperti Prisma', () => {
    expect(sqliteDatabaseFile('file:/app/data/stream-router.db', '/app/prisma')).toBe('/app/data/stream-router.db');
    expect(sqliteDatabaseFile('file:../data/stream-router.db?connection_limit=1', '/app/prisma')).toBe('/app/data/stream-router.db');
    expect(sqliteDatabaseFile('postgresql://db/app', '/app/prisma')).toBeNull();
  });

  it('memakai lokasi binary MediaMTX yang sama dengan run-mediamtx.mjs', () => {
    expect(mediaMtxExecutable('/app', { version: 'v1.19.2', platform: 'linux', arch: 'x64' })).toBe('/app/.runtime/mediamtx/v1.19.2/linux-amd64/mediamtx');
    expect(mediaMtxExecutable('/app', { version: 'v1.19.2', platform: 'linux', arch: 'arm64' })).toBe('/app/.runtime/mediamtx/v1.19.2/linux-arm64/mediamtx');
  });
});

describe('pin SHA-256 MediaMTX', () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const dockerfile = readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');
  const sha = (character: string) => character.repeat(64);

  it('versi MediaMTX di Dockerfile dipin untuk linux amd64 dan arm64, dan build mewajibkan pin', () => {
    const version = /^ARG MEDIAMTX_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(version).toBe(DEFAULT_MEDIAMTX_VERSION);
    for (const target of ['linux-amd64', 'linux-arm64']) {
      expect(PINNED_MEDIAMTX_SHA256[version!]?.[target], target).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(dockerfile).toMatch(/^RUN MEDIAMTX_REQUIRE_SHA256=true node scripts\/ensure-mediamtx\.mjs$/m);
  });

  it('memakai pin repository dan menolak pin environment yang berbeda atau tidak valid', () => {
    const pins = { 'v1.19.2': { 'linux-amd64': sha('a') } };
    const base = { version: 'v1.19.2', platform: 'linux', archName: 'amd64', pins };
    expect(pinnedArchiveSha256({ ...base, env: {} })).toBe(sha('a'));
    expect(pinnedArchiveSha256({ ...base, env: { MEDIAMTX_SHA256_AMD64: sha('A') } })).toBe(sha('a'));
    expect(() => pinnedArchiveSha256({ ...base, env: { MEDIAMTX_SHA256_AMD64: sha('b') } })).toThrow(/berbeda dengan SHA-256 terpin/);
    expect(() => pinnedArchiveSha256({ ...base, env: { MEDIAMTX_SHA256_AMD64: 'bukan-hash' } })).toThrow(/MEDIAMTX_SHA256_AMD64 tidak valid/);
  });

  it('memakai pin build-arg sesuai arsitektur untuk versi yang belum dipin', () => {
    const env = { MEDIAMTX_SHA256_AMD64: sha('c'), MEDIAMTX_SHA256_ARM64: sha('d') };
    expect(pinnedArchiveSha256({ version: 'v9.9.9', platform: 'linux', archName: 'amd64', env })).toBe(sha('c'));
    expect(pinnedArchiveSha256({ version: 'v9.9.9', platform: 'linux', archName: 'arm64', env })).toBe(sha('d'));
    expect(pinnedArchiveSha256({ version: 'v9.9.9', platform: 'linux', archName: 'arm64', env: {} })).toBeNull();
  });

  it('membaca hash arsip dari checksums.sha256 release', () => {
    const checksums = `${sha('e')} *mediamtx_v9.9.9_linux_amd64.tar.gz\r\n${sha('f')} *mediamtx_v9.9.9_linux_arm64.tar.gz\r\n`;
    expect(releaseChecksum(checksums, 'mediamtx_v9.9.9_linux_arm64.tar.gz')).toBe(sha('f'));
    expect(releaseChecksum(checksums, 'mediamtx_v9.9.9_darwin_arm64.tar.gz')).toBeNull();
  });
});

// Proses anak sungguhan: memastikan urutan shutdown dan restart terisolasi tanpa Docker.
describe.skipIf(process.platform === 'win32')('ProcessSupervisor', () => {
  let tempDir = '';
  let fakeService = '';
  let journal = '';
  let supervisor: ProcessSupervisor | null = null;
  const fastPolicy = { initialDelayMs: 50, maxDelayMs: 200, stableAfterMs: 60_000 };

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'stream-router-supervisor-'));
    fakeService = path.join(tempDir, 'fake-service.mjs');
    await writeFile(fakeService, [
      "import { appendFileSync } from 'node:fs';",
      'const [journal, name, mode] = process.argv.slice(2);',
      'const write = (event) => appendFileSync(journal, `${name}:${event}\\n`);',
      "process.on('SIGTERM', () => {",
      "  write('sigterm');",
      "  if (mode === 'abaikan-sigterm') return;",
      "  setTimeout(() => { write('exit'); process.exit(0); }, 150);",
      '});',
      'setInterval(() => undefined, 1000);',
      // Ditulis setelah handler terpasang agar SIGTERM dari test tidak mendahului handler.
      "write('start');",
      ''
    ].join('\n'));
  });

  afterEach(() => {
    supervisor?.killAll();
    supervisor = null;
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function events(): string[] {
    return existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(Boolean) : [];
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timeout menunggu kondisi; journal: ${events().join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function createSupervisor(name: string, apiMode = 'normal'): ProcessSupervisor {
    journal = path.join(tempDir, `${name}.log`);
    const service = (serviceName: string, mode: string, stopTimeoutMs: number) => ({
      name: serviceName,
      label: serviceName,
      command: process.execPath,
      args: [fakeService, journal, serviceName, mode],
      cwd: tempDir,
      env: { ...process.env },
      stopTimeoutMs
    });
    supervisor = new ProcessSupervisor({
      policy: fastPolicy,
      services: [service('mediamtx', 'normal', 5_000), service('api', apiMode, 400)]
    });
    supervisor.start();
    return supervisor;
  }

  it('menghentikan API sampai keluar sebelum MediaMTX menerima SIGTERM', async () => {
    const running = createSupervisor('urutan');
    await waitFor(() => events().includes('api:start') && events().includes('mediamtx:start'));
    expect(await running.shutdown(['api', 'mediamtx'])).toEqual([]);
    const stops = events().filter((event) => !event.endsWith(':start'));
    expect(stops).toEqual(['api:sigterm', 'api:exit', 'mediamtx:sigterm', 'mediamtx:exit']);
    expect(running.pid('api')).toBeNull();
    expect(running.pid('mediamtx')).toBeNull();
  }, 15_000);

  it('menjalankan ulang hanya child yang crash', async () => {
    const running = createSupervisor('restart');
    await waitFor(() => running.pid('api') !== null && running.pid('mediamtx') !== null && events().length === 2);
    const apiPid = running.pid('api')!;
    const mediaPid = running.pid('mediamtx');
    process.kill(apiPid, 'SIGKILL');
    await waitFor(() => running.pid('api') !== null && running.pid('api') !== apiPid && events().filter((event) => event === 'api:start').length === 2);
    expect(running.pid('mediamtx')).toBe(mediaPid);
    expect(events().filter((event) => event === 'mediamtx:start')).toHaveLength(1);
    await running.shutdown(['api', 'mediamtx']);
  }, 15_000);

  it('menghentikan paksa child yang mengabaikan SIGTERM lalu tetap melanjutkan ke MediaMTX', async () => {
    const running = createSupervisor('paksa', 'abaikan-sigterm');
    await waitFor(() => events().includes('api:start') && events().includes('mediamtx:start'));
    expect(await running.shutdown(['api', 'mediamtx'])).toEqual(['api']);
    const stops = events().filter((event) => !event.endsWith(':start'));
    expect(stops).toEqual(['api:sigterm', 'mediamtx:sigterm', 'mediamtx:exit']);
  }, 15_000);

  it('tidak menjalankan ulang child setelah shutdown dimulai', async () => {
    const running = createSupervisor('tanpa-restart');
    await waitFor(() => events().includes('api:start') && events().includes('mediamtx:start'));
    await running.shutdown(['api', 'mediamtx']);
    await new Promise((resolve) => setTimeout(resolve, fastPolicy.maxDelayMs * 2));
    expect(events().filter((event) => event.endsWith(':start'))).toHaveLength(2);
  }, 15_000);
});
