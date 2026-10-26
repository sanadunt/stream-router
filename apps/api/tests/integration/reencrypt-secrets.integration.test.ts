import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptString, encryptString } from '../../src/shared/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../../../..');
const cliPath = path.join(rootDir, 'scripts/reencrypt-secrets.mjs');
const migrateScript = path.join(rootDir, 'scripts/apply-sqlite-migrations.mjs');
const oldKey = 'old-integration-key-0123456789abcdefghij';
const newKey = 'new-integration-key-0123456789abcdefghij';
const wrongKey = 'wrong-integration-key-0123456789abcdefgh';
// Variabel yang dapat bocor dari shell developer atau npm dan mengubah perilaku CLI.
const isolatedEnv = ['APP_ENCRYPTION_KEY', 'OLD_APP_ENCRYPTION_KEY', 'DATABASE_URL', 'HOST', 'PORT', 'STREAM_ROUTER_ENV_FILE', 'npm_config_dry_run'];

const plaintexts = {
  input: 'rtsp://camera-user:camera-pass@192.168.1.20:554/stream1',
  outputs: JSON.stringify(['rtmp://vps.example.test/live/cam-1']),
  webrtc: 'http://192.168.1.20:18889/cameras/cam-1',
  ptz: JSON.stringify({ provider: 'ONVIF', host: '192.168.1.20', username: 'onvif', password: 'onvif-pass' }),
  streamUrl: 'https://media.example.test/whep/cam-2?token=stream-token',
  brokerPassword: 'broker-password-value',
  secondInput: 'rtsp://second-user:second-pass@192.168.1.21:554/stream1',
  secondOutputs: JSON.stringify(['rtmp://vps.example.test/live/cam-2'])
};

interface Fixture { dbFile: string; databaseUrl: string; envFile: string }
interface CliResult { code: number | null; stdout: string; stderr: string }

let tmpRoot = '';
let apiPort = 0;

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of isolatedEnv) delete env[name];
  return { ...env, ...extra };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(fixture: Fixture, args: string[] = [], extra: Record<string, string> = {}): Promise<CliResult> {
  return run(process.execPath, [cliPath, ...args], childEnv({
    STREAM_ROUTER_ENV_FILE: fixture.envFile,
    OLD_APP_ENCRYPTION_KEY: oldKey,
    ...extra
  }));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function withClient<T>(fixture: Fixture, action: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: fixture.databaseUrl });
  try {
    return await action(client);
  } finally {
    await client.$disconnect();
  }
}

async function createFixture(name: string): Promise<Fixture> {
  const directory = path.join(tmpRoot, name);
  await mkdir(directory);
  const dbFile = path.join(directory, 'test.db');
  const fixture = { dbFile, databaseUrl: `file:${dbFile}`, envFile: path.join(directory, '.env') };
  await writeFile(fixture.envFile, [
    `DATABASE_URL="${fixture.databaseUrl}"`,
    'HOST=127.0.0.1',
    `PORT=${apiPort}`,
    `APP_ENCRYPTION_KEY=${newKey}`,
    ''
  ].join('\n'));
  const migration = await run(process.execPath, [migrateScript], childEnv({ DATABASE_URL: fixture.databaseUrl }));
  expect(migration.code, migration.stderr).toBe(0);
  await withClient(fixture, async (client) => {
    await client.streamRoute.create({
      data: {
        cameraKey: 'cam-1',
        name: 'Kamera 1',
        inputProtocol: 'RTSP',
        inputUrlEncrypted: encryptString(plaintexts.input, oldKey),
        outputsEncrypted: encryptString(plaintexts.outputs, oldKey),
        webrtcUrlEncrypted: encryptString(plaintexts.webrtc, oldKey),
        ptzProvider: 'ONVIF',
        ptzConfigEncrypted: encryptString(plaintexts.ptz, oldKey)
      }
    });
    // Route kedua berada setelah cam-1 di halaman SQLite, sehingga edit cam-1 meninggalkan freeblock berisi ciphertext lama.
    await client.streamRoute.create({
      data: {
        cameraKey: 'cam-2',
        name: 'Kamera 2',
        inputProtocol: 'RTSP',
        inputUrlEncrypted: encryptString(plaintexts.secondInput, oldKey),
        outputsEncrypted: encryptString(plaintexts.secondOutputs, oldKey)
      }
    });
    await client.webrtcStream.create({ data: { name: 'stream-a', urlEncrypted: encryptString(plaintexts.streamUrl, oldKey) } });
    await client.mqttBroker.create({ data: { name: 'broker-a', host: '127.0.0.1', passwordEncrypted: encryptString(plaintexts.brokerPassword, oldKey) } });
    await client.mqttBroker.create({ data: { name: 'broker-b', host: '127.0.0.1' } });
  });
  return fixture;
}

function encryptedValues(fixture: Fixture): Promise<Record<string, string | null>> {
  return withClient(fixture, async (client) => {
    const [routes, streams, brokers] = await Promise.all([
      client.streamRoute.findMany({ orderBy: { cameraKey: 'asc' } }),
      client.webrtcStream.findMany({ orderBy: { name: 'asc' } }),
      client.mqttBroker.findMany({ orderBy: { name: 'asc' } })
    ]);
    const values: Record<string, string | null> = {};
    for (const row of routes) {
      values[`route.${row.cameraKey}.input`] = row.inputUrlEncrypted;
      values[`route.${row.cameraKey}.outputs`] = row.outputsEncrypted;
      values[`route.${row.cameraKey}.webrtc`] = row.webrtcUrlEncrypted;
      values[`route.${row.cameraKey}.ptz`] = row.ptzConfigEncrypted;
    }
    for (const row of streams) {
      values[`stream.${row.name}.url`] = row.urlEncrypted;
      values[`stream.${row.name}.ptz`] = row.ptzConfigEncrypted;
    }
    for (const row of brokers) values[`broker.${row.name}.password`] = row.passwordEncrypted;
    return values;
  });
}

function updatedAtValues(fixture: Fixture): Promise<string[]> {
  return withClient(fixture, async (client) => [
    ...(await client.streamRoute.findMany({ orderBy: { cameraKey: 'asc' } })),
    ...(await client.webrtcStream.findMany({ orderBy: { name: 'asc' } })),
    ...(await client.mqttBroker.findMany({ orderBy: { name: 'asc' } }))
  ].map((row) => row.updatedAt.toISOString()));
}

/** Menghitung ciphertext di seluruh byte file SQLite (termasuk halaman bebas) yang masih terbuka dengan key tertentu. */
async function ciphertextsInFile(file: string, key: string): Promise<number> {
  const bytes = (await readFile(file)).toString('latin1');
  let count = 0;
  // Record SQLite menyambung nilai kolom tanpa pemisah, jadi ujung ciphertext dicari dengan mencoba panjang
  // yang makin pendek sampai tag GCM valid. Lookahead mengizinkan token yang saling bersambung.
  for (const match of bytes.matchAll(/(?=(v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.)([A-Za-z0-9_-]+))/g)) {
    const [, prefix, body] = match as unknown as [string, string, string];
    for (let length = body.length; length > 0; length -= 1) {
      try {
        decryptString(prefix + body.slice(0, length), key);
        count += 1;
        break;
      } catch {
        // Belum panjang yang tepat, potongan rusak, atau key lain.
      }
    }
  }
  return count;
}

async function backupFiles(fixture: Fixture): Promise<string[]> {
  return readdir(path.join(path.dirname(fixture.dbFile), 'backups')).catch(() => []);
}

function expectNoSecretsIn(result: CliResult): void {
  for (const secret of [oldKey, newKey, wrongKey, ...Object.values(plaintexts)]) expect(result.stdout + result.stderr).not.toContain(secret);
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'stream-router-reencrypt-'));
  apiPort = await freePort();
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

describe('npm run secrets:reencrypt', () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await createFixture('main'); }, 120_000);

  it('menolak berjalan tanpa key lama ketika stdin bukan terminal', async () => {
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture, [], { OLD_APP_ENCRYPTION_KEY: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OLD_APP_ENCRYPTION_KEY');
    expect(await encryptedValues(fixture)).toEqual(before);
  }, 60_000);

  it('menolak key yang diberikan sebagai argumen command', async () => {
    const result = await runCli(fixture, [oldKey]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Argumen tidak dikenal');
    expectNoSecretsIn(result);
  }, 60_000);

  it('menolak APP_ENCRYPTION_KEY dari shell yang berbeda dengan .env', async () => {
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture, [], { APP_ENCRYPTION_KEY: wrongKey });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unset APP_ENCRYPTION_KEY');
    expectNoSecretsIn(result);
    expect(await encryptedValues(fixture)).toEqual(before);
  }, 60_000);

  it('menolak --dry-run yang ditelan npm karena tidak memakai `--`', async () => {
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture, [], { npm_config_dry_run: 'true' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('-- --dry-run');
    expect(await encryptedValues(fixture)).toEqual(before);
    expect(await backupFiles(fixture)).toEqual([]);
  }, 60_000);

  it('menolak menulis ketika port API masih aktif', async () => {
    const before = await encryptedValues(fixture);
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(apiPort, '127.0.0.1', resolve));
    try {
      const result = await runCli(fixture);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('API tampaknya masih berjalan');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await encryptedValues(fixture)).toEqual(before);
  }, 60_000);

  it('dry-run hanya memeriksa tanpa menulis atau membuat backup', async () => {
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture, ['--dry-run']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Dry-run selesai');
    expectNoSecretsIn(result);
    expect(await encryptedValues(fixture)).toEqual(before);
    expect(await backupFiles(fixture)).toEqual([]);
  }, 60_000);

  it('membatalkan seluruh proses ketika key lama salah', async () => {
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture, [], { OLD_APP_ENCRYPTION_KEY: wrongKey });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Tidak ada data yang diubah');
    expectNoSecretsIn(result);
    expect(await encryptedValues(fixture)).toEqual(before);
  }, 60_000);

  it('mengenkripsi ulang semua kolom, mempertahankan updatedAt, membuat backup privat, dan membersihkan sisa key lama', async () => {
    // Edit yang memperbesar baris memindahkan cell SQLite; salinan lama beserta ciphertext-nya tertinggal di halaman bebas.
    await withClient(fixture, (client) => client.streamRoute.update({ where: { cameraKey: 'cam-1' }, data: { description: 'x'.repeat(600) } }));
    const liveValues = Object.values(await encryptedValues(fixture)).filter(Boolean).length;
    expect(await ciphertextsInFile(fixture.dbFile, oldKey)).toBeGreaterThan(liveValues);
    const updatedAtBefore = await updatedAtValues(fixture);

    const result = await runCli(fixture);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Selesai: 8 nilai dienkripsi ulang');
    expect(result.stdout).toContain('VACUUM');
    expectNoSecretsIn(result);

    const after = await encryptedValues(fixture);
    expect(decryptString(after['route.cam-1.input']!, newKey)).toBe(plaintexts.input);
    expect(decryptString(after['route.cam-1.outputs']!, newKey)).toBe(plaintexts.outputs);
    expect(decryptString(after['route.cam-1.webrtc']!, newKey)).toBe(plaintexts.webrtc);
    expect(decryptString(after['route.cam-1.ptz']!, newKey)).toBe(plaintexts.ptz);
    expect(decryptString(after['route.cam-2.input']!, newKey)).toBe(plaintexts.secondInput);
    expect(decryptString(after['route.cam-2.outputs']!, newKey)).toBe(plaintexts.secondOutputs);
    expect(after['route.cam-2.webrtc']).toBeNull();
    expect(decryptString(after['stream.stream-a.url']!, newKey)).toBe(plaintexts.streamUrl);
    expect(decryptString(after['broker.broker-a.password']!, newKey)).toBe(plaintexts.brokerPassword);
    expect(after['stream.stream-a.ptz']).toBeNull();
    expect(after['broker.broker-b.password']).toBeNull();
    expect(await updatedAtValues(fixture)).toEqual(updatedAtBefore);
    expect(await ciphertextsInFile(fixture.dbFile, oldKey)).toBe(0);
    expect(await ciphertextsInFile(fixture.dbFile, newKey)).toBe(liveValues);

    const backups = await backupFiles(fixture);
    expect(backups).toHaveLength(1);
    const backupFile = path.join(path.dirname(fixture.dbFile), 'backups', backups[0]!);
    expect((await stat(backupFile)).mode & 0o777).toBe(0o600);
    const backupRoute = await withClient({ ...fixture, databaseUrl: `file:${backupFile}` }, (client) => client.streamRoute.findFirstOrThrow());
    expect(decryptString(backupRoute.inputUrlEncrypted, oldKey)).toBe(plaintexts.input);
  }, 60_000);

  it('aman dijalankan ulang setelah rotasi selesai', async () => {
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Tidak ada nilai yang perlu dienkripsi ulang');
    expect(await encryptedValues(fixture)).toEqual(before);
    expect(await backupFiles(fixture)).toHaveLength(1);
  }, 60_000);
});

describe('npm run secrets:reencrypt membatalkan transaksi', () => {
  async function expectRollback(name: string, triggerSql: string, message: string): Promise<void> {
    const fixture = await createFixture(name);
    await withClient(fixture, (client) => client.$executeRawUnsafe(triggerSql));
    const before = await encryptedValues(fixture);
    const result = await runCli(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('Transaksi dibatalkan');
    expectNoSecretsIn(result);
    // StreamRoute diperbarui lebih dahulu daripada MqttBroker, sehingga nilai ini membuktikan rollback.
    expect(await encryptedValues(fixture)).toEqual(before);
  }

  it('ketika penulisan salah satu kolom gagal', async () => {
    await expectRollback(
      'abort-trigger',
      `CREATE TRIGGER block_broker BEFORE UPDATE OF passwordEncrypted ON MqttBroker BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
      'blocked'
    );
  }, 120_000);

  it('ketika verifikasi key baru sebelum commit gagal', async () => {
    await expectRollback(
      'corrupt-trigger',
      `CREATE TRIGGER corrupt_broker AFTER UPDATE OF passwordEncrypted ON MqttBroker
       WHEN NEW.passwordEncrypted <> 'v1.a.b.c'
       BEGIN UPDATE MqttBroker SET passwordEncrypted = 'v1.a.b.c' WHERE id = NEW.id; END`,
      'Verifikasi key baru gagal pada MqttBroker.passwordEncrypted'
    );
  }, 120_000);
});
