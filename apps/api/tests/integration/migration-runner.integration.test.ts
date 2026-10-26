import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  MIGRATION_TRANSACTION_OPTIONS,
  singleConnectionUrl
} from '../../../../scripts/apply-sqlite-migrations.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '../../../..');
const sourceMigrationsDir = path.join(rootDir, 'prisma', 'migrations');
const prismaCli = path.join(rootDir, 'node_modules', 'prisma', 'build', 'index.js');
const cameraKeyMigration = '20261024090000_require_route_camera_key';
const silent = (): void => undefined;

let tmpRoot = '';
let allMigrations: string[] = [];

interface Fixture { databaseUrl: string; migrationsDir: string }

async function createFixture(name: string): Promise<Fixture> {
  const directory = path.join(tmpRoot, name);
  const migrationsDir = path.join(directory, 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  return { databaseUrl: `file:${path.join(directory, 'test.db')}`, migrationsDir };
}

async function addMigrations(fixture: Fixture, names: string[]): Promise<void> {
  for (const name of names) {
    await cp(path.join(sourceMigrationsDir, name), path.join(fixture.migrationsDir, name), { recursive: true });
  }
}

async function migrate(fixture: Fixture): Promise<void> {
  await applyMigrations({ databaseUrl: fixture.databaseUrl, migrationsDir: fixture.migrationsDir, log: silent });
}

async function withClient<T>(fixture: Fixture, action: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: fixture.databaseUrl });
  try {
    return await action(client);
  } finally {
    await client.$disconnect();
  }
}

async function count(client: PrismaClient, table: string): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ total: bigint | number }>>(`SELECT COUNT(*) AS total FROM "${table}"`);
  return Number(rows[0]?.total ?? 0);
}

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'stream-router-migrate-'));
  allMigrations = (await readdir(sourceMigrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

describe('runner migration SQLite', () => {
  it('memakai satu koneksi agar PRAGMA foreign_keys berlaku untuk transaksi migration', () => {
    expect(singleConnectionUrl('file:../data/stream-router.db')).toBe('file:../data/stream-router.db?connection_limit=1');
    expect(singleConnectionUrl('file:./x.db?socket_timeout=10')).toBe('file:./x.db?socket_timeout=10&connection_limit=1');
    expect(singleConnectionUrl('file:./x.db?connection_limit=8&socket_timeout=10')).toBe('file:./x.db?connection_limit=1&socket_timeout=10');
  });

  it('tidak memakai timeout transaksi default Prisma 5 detik', () => {
    expect(MIGRATION_TRANSACTION_OPTIONS.timeout).toBeGreaterThanOrEqual(10 * 60_000);
    expect(MIGRATION_TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2000);
  });

  it('menjalankan setiap migration dalam transaksi bertimeout panjang pada client satu koneksi', async () => {
    const fixture = await createFixture('transaction-options');
    await addMigrations(fixture, allMigrations.slice(0, 3));
    const datasourceUrls: string[] = [];
    const transactionOptions: unknown[] = [];
    await applyMigrations({
      databaseUrl: fixture.databaseUrl,
      migrationsDir: fixture.migrationsDir,
      log: silent,
      createClient: (options: { datasourceUrl: string }) => {
        datasourceUrls.push(options.datasourceUrl);
        const client = new PrismaClient(options);
        return {
          $connect: () => client.$connect(),
          $disconnect: () => client.$disconnect(),
          $executeRawUnsafe: (query: string, ...values: unknown[]) => client.$executeRawUnsafe(query, ...values),
          $queryRawUnsafe: (query: string, ...values: unknown[]) => client.$queryRawUnsafe(query, ...values),
          $transaction: (action: Parameters<PrismaClient['$transaction']>[0], options: unknown) => {
            transactionOptions.push(options);
            return client.$transaction(action as never, options as never);
          }
        };
      }
    });
    expect(datasourceUrls).toEqual([singleConnectionUrl(fixture.databaseUrl)]);
    expect(transactionOptions).toHaveLength(3);
    for (const options of transactionOptions) expect(options).toBe(MIGRATION_TRANSACTION_OPTIONS);
  });

  it('tidak menghapus RouteRun maupun AuditLog saat StreamRoute didefinisikan ulang', async () => {
    const fixture = await createFixture('redefine-init');
    await addMigrations(fixture, ['202607250001_init']);
    await migrate(fixture);
    await withClient(fixture, async (client) => {
      await client.$executeRawUnsafe(`INSERT INTO "StreamRoute" ("id", "name", "inputUrlEncrypted", "inputProtocol", "outputsEncrypted", "updatedAt") VALUES ('r1', 'Kamera 1', 'enc', 'RTSP', 'enc', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "RouteRun" ("id", "routeId", "status", "updatedAt") VALUES ('run-1', 'r1', 'STOPPED', CURRENT_TIMESTAMP), ('run-2', 'r1', 'FAILED', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "AuditLog" ("id", "action", "routeId") VALUES ('audit-1', 'route.create', 'r1')`);
    });

    await addMigrations(fixture, ['20260725103336_add_webrtc_monitoring']);
    await migrate(fixture);

    await withClient(fixture, async (client) => {
      expect(await count(client, 'RouteRun')).toBe(2);
      const audit = await client.$queryRawUnsafe<Array<{ routeId: string | null }>>(`SELECT "routeId" FROM "AuditLog" WHERE "id" = 'audit-1'`);
      expect(audit[0]?.routeId).toBe('r1');
    });
  });

  it('mempertahankan data anak dan mengisi cameraKey kosong saat kolom dijadikan NOT NULL', async () => {
    const fixture = await createFixture('camera-key');
    const cameraKeyIndex = allMigrations.indexOf(cameraKeyMigration);
    expect(cameraKeyIndex).toBeGreaterThan(0);
    await addMigrations(fixture, allMigrations.slice(0, cameraKeyIndex));
    await migrate(fixture);
    await withClient(fixture, async (client) => {
      await client.$executeRawUnsafe(`INSERT INTO "MqttBroker" ("id", "name", "host", "updatedAt") VALUES ('broker-1', 'Broker', '192.168.1.5', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "StreamRoute" ("id", "cameraKey", "name", "inputUrlEncrypted", "inputProtocol", "outputsEncrypted", "ptzMqttBrokerId", "updatedAt") VALUES ('r1', 'cam-1', 'Kamera 1', 'enc', 'RTSP', 'enc', 'broker-1', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "StreamRoute" ("id", "cameraKey", "name", "inputUrlEncrypted", "inputProtocol", "outputsEncrypted", "updatedAt") VALUES ('abcd-ef01-2345-6789', NULL, 'Kamera tanpa ID', 'enc', 'RTSP', 'enc', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "RouteRun" ("id", "routeId", "status", "updatedAt") VALUES ('run-1', 'r1', 'STOPPED', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "AuditLog" ("id", "action", "routeId") VALUES ('audit-1', 'route.create', 'r1')`);
      await client.$executeRawUnsafe(`INSERT INTO "RouteMqttBridgeSubscription" ("id", "routeId", "brokerId", "commandTopic", "updatedAt") VALUES ('sub-1', 'r1', 'broker-1', 'Turjawali/cam-1/command', CURRENT_TIMESTAMP)`);
      await client.$executeRawUnsafe(`INSERT INTO "RecordingSegment" ("id", "routeId", "cameraKey", "cameraName", "storageRoot", "relativePath", "startTime", "endTime", "durationMs", "sizeBytes", "updatedAt") VALUES ('seg-1', 'r1', 'cam-1', 'Kamera 1', '/rec', 'cameras/cam-1/a.mp4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1000, 2048, CURRENT_TIMESTAMP)`);
    });

    await addMigrations(fixture, allMigrations.slice(cameraKeyIndex));
    await migrate(fixture);

    await withClient(fixture, async (client) => {
      expect(await count(client, 'RouteRun')).toBe(1);
      expect(await count(client, 'RouteMqttBridgeSubscription')).toBe(1);
      const segment = await client.$queryRawUnsafe<Array<{ routeId: string | null }>>(`SELECT "routeId" FROM "RecordingSegment" WHERE "id" = 'seg-1'`);
      expect(segment[0]?.routeId).toBe('r1');
      const audit = await client.$queryRawUnsafe<Array<{ routeId: string | null }>>(`SELECT "routeId" FROM "AuditLog" WHERE "id" = 'audit-1'`);
      expect(audit[0]?.routeId).toBe('r1');
      const routes = await client.$queryRawUnsafe<Array<{ id: string; cameraKey: string; ptzMqttBrokerId: string | null }>>(`SELECT "id", "cameraKey", "ptzMqttBrokerId" FROM "StreamRoute" ORDER BY "id"`);
      expect(routes).toEqual([
        { id: 'abcd-ef01-2345-6789', cameraKey: 'route-abcdef012345', ptzMqttBrokerId: null },
        { id: 'r1', cameraKey: 'cam-1', ptzMqttBrokerId: 'broker-1' }
      ]);
      const columns = await client.$queryRawUnsafe<Array<{ name: string; notnull: bigint | number }>>(`PRAGMA table_info("StreamRoute")`);
      expect(Number(columns.find((column) => column.name === 'cameraKey')?.notnull)).toBe(1);
      expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
    });
  });

  it('membatalkan migration yang meninggalkan pelanggaran foreign key', async () => {
    const fixture = await createFixture('fk-violation');
    await addMigrations(fixture, allMigrations);
    const badName = '29991231235959_orphan_run';
    await mkdir(path.join(fixture.migrationsDir, badName));
    await writeFile(
      path.join(fixture.migrationsDir, badName, 'migration.sql'),
      `INSERT INTO "RouteRun" ("id", "routeId", "status", "updatedAt") VALUES ('orphan', 'route-tidak-ada', 'STOPPED', CURRENT_TIMESTAMP);\n`
    );

    await expect(migrate(fixture)).rejects.toThrow(/pelanggaran foreign key/);

    await withClient(fixture, async (client) => {
      expect(await count(client, 'RouteRun')).toBe(0);
      const applied = await client.$queryRawUnsafe<Array<{ name: string }>>(`SELECT "name" FROM "_stream_router_migrations"`);
      expect(applied.map((row) => row.name)).not.toContain(badName);
      expect(applied).toHaveLength(allMigrations.length);
    });
  });

  it('memakai checksum yang sama untuk checkout CRLF dan LF pada database yang sama', async () => {
    const fixture = await createFixture('crlf-checkout');
    const names = allMigrations.slice(0, 3);
    const lfSources = new Map<string, string>();
    for (const name of names) lfSources.set(name, (await readFile(path.join(sourceMigrationsDir, name, 'migration.sql'), 'utf8')).replace(/\r\n/g, '\n'));
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');
    const writeVariant = async (transform: (text: string) => string) => {
      for (const [name, sql] of lfSources) {
        await mkdir(path.join(fixture.migrationsDir, name), { recursive: true });
        await writeFile(path.join(fixture.migrationsDir, name, 'migration.sql'), transform(sql));
      }
    };
    const storedChecksums = () => withClient(fixture, (client) => client.$queryRawUnsafe<Array<{ name: string; checksum: string }>>(
      `SELECT "name", "checksum" FROM "_stream_router_migrations" ORDER BY "name"`
    ));
    const lfChecksums = names.map((name) => ({ name, checksum: sha256(lfSources.get(name)!) }));

    // Image hasil `setup.ps1 -Build` dari checkout Git for Windows (core.autocrlf=true).
    await writeVariant(crlf);
    await migrate(fixture);
    expect(await storedChecksums()).toEqual(lfChecksums);

    // Lalu image CI (LF) dengan volume data yang sama, dan sebaliknya.
    await writeVariant((text) => text);
    await migrate(fixture);
    await writeVariant(crlf);
    await migrate(fixture);

    // Database yang sudah menyimpan checksum CRLF dari runner lama tetap dapat dibuka image LF.
    await withClient(fixture, async (client) => {
      for (const [name, sql] of lfSources) {
        await client.$executeRawUnsafe('UPDATE "_stream_router_migrations" SET "checksum" = ? WHERE "name" = ?', sha256(crlf(sql)), name);
      }
    });
    await writeVariant((text) => text);
    await migrate(fixture);
    expect(await storedChecksums()).toEqual(lfChecksums);
  });

  it('menghasilkan schema yang identik dengan prisma/schema.prisma', async () => {
    const fixture = await createFixture('schema-drift');
    await addMigrations(fixture, allMigrations);
    await migrate(fixture);

    const diff = await run(process.execPath, [
      prismaCli, 'migrate', 'diff',
      '--from-url', fixture.databaseUrl,
      '--to-schema-datamodel', path.join(rootDir, 'prisma', 'schema.prisma'),
      '--script'
    ]);
    expect(diff.code, diff.stderr).toBe(0);
    // Tabel checksum milik runner memang tidak ada di schema.prisma; selain itu diff harus kosong.
    const remaining = diff.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('--'))
      .filter((line) => !/^PRAGMA foreign_keys=(?:on|off);$/i.test(line))
      .filter((line) => line !== 'DROP TABLE "_stream_router_migrations";');
    expect(remaining).toEqual([]);
  }, 60_000);
});

describe('runner migration SQLite dengan baris yatim lama', () => {
  async function withoutForeignKeys(fixture: Fixture, statements: string[]): Promise<void> {
    const client = new PrismaClient({ datasourceUrl: singleConnectionUrl(fixture.databaseUrl) });
    try {
      await client.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
      for (const statement of statements) await client.$executeRawUnsafe(statement);
    } finally {
      await client.$disconnect();
    }
  }

  it('tetap menerapkan upgrade berurutan dan menolkan routeId segment yang hilang', async () => {
    const fixture = await createFixture('preexisting-orphans');
    const cameraKeyIndex = allMigrations.indexOf(cameraKeyMigration);
    await addMigrations(fixture, allMigrations.slice(0, cameraKeyIndex));
    await migrate(fixture);
    // Baris yatim hasil edit manual dengan sqlite3 (foreign key nonaktif secara default).
    await withoutForeignKeys(fixture, [
      `INSERT INTO "RecordingSegment" ("id", "routeId", "cameraKey", "cameraName", "storageRoot", "relativePath", "startTime", "endTime", "durationMs", "sizeBytes", "updatedAt") VALUES ('seg-yatim', 'route-hilang', 'cam-x', 'Kamera X', '/rec', 'cameras/cam-x/a.mp4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1000, 2048, CURRENT_TIMESTAMP)`,
      `INSERT INTO "RouteRun" ("id", "routeId", "status", "updatedAt") VALUES ('run-yatim', 'route-hilang', 'STOPPED', CURRENT_TIMESTAMP)`
    ]);

    const warnings: string[] = [];
    await addMigrations(fixture, allMigrations.slice(cameraKeyIndex));
    await applyMigrations({
      databaseUrl: fixture.databaseUrl,
      migrationsDir: fixture.migrationsDir,
      log: silent,
      warn: (message: string) => warnings.push(message)
    });

    await withClient(fixture, async (client) => {
      const applied = await client.$queryRawUnsafe<Array<{ name: string }>>(`SELECT "name" FROM "_stream_router_migrations"`);
      expect(applied).toHaveLength(allMigrations.length);
      const segment = await client.$queryRawUnsafe<Array<{ routeId: string | null }>>(`SELECT "routeId" FROM "RecordingSegment" WHERE "id" = 'seg-yatim'`);
      expect(segment[0]?.routeId).toBeNull();
    });
    expect(warnings[0]).toContain(cameraKeyMigration);
    expect(warnings[0]).toContain('RouteRun -> StreamRoute: 1');
    expect(warnings[0]).toContain('RecordingSegment -> StreamRoute: 1');
  });

  it('tetap menolak pelanggaran baru pada tabel yang sudah memiliki baris yatim', async () => {
    const fixture = await createFixture('preexisting-plus-new');
    await addMigrations(fixture, allMigrations);
    await migrate(fixture);
    await withoutForeignKeys(fixture, [
      `INSERT INTO "RouteRun" ("id", "routeId", "status", "updatedAt") VALUES ('run-lama', 'route-hilang', 'STOPPED', CURRENT_TIMESTAMP)`
    ]);
    const badName = '29991231235959_orphan_run';
    await mkdir(path.join(fixture.migrationsDir, badName));
    await writeFile(
      path.join(fixture.migrationsDir, badName, 'migration.sql'),
      `INSERT INTO "RouteRun" ("id", "routeId", "status", "updatedAt") VALUES ('run-baru', 'route-tidak-ada', 'STOPPED', CURRENT_TIMESTAMP);\n`
    );

    await expect(applyMigrations({
      databaseUrl: fixture.databaseUrl,
      migrationsDir: fixture.migrationsDir,
      log: silent,
      warn: silent
    })).rejects.toThrow(/1 pelanggaran foreign key baru \(RouteRun -> StreamRoute: 1\)/);
    await withClient(fixture, async (client) => {
      expect(await count(client, 'RouteRun')).toBe(1);
    });
  });
});
