import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  compareMigrationChecksum,
  migrationChecksum,
  normalizeMigrationSql
} from '../../../../scripts/apply-sqlite-migrations.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const initMigration = path.join(rootDir, 'prisma', 'migrations', '202607250001_init', 'migration.sql');
// Checksum yang tersimpan di _stream_router_migrations pada setiap database yang sudah dimigrasi dari
// checkout LF (image CI dan instalasi Linux/macOS). Tidak boleh berubah.
const INIT_LF_CHECKSUM = 'e90fd81459a619095bbb8af8210012e55dd6338c20c313a7ae0facc7dc37be07';
const INIT_CRLF_CHECKSUM = '2e18d058ffc88861537f20f8d32d62fef05bffe6e83559eba1d24fa199a6df64';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const toCrlf = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

const lfSql = '-- Tabel contoh\nCREATE TABLE "A" ("id" TEXT NOT NULL PRIMARY KEY);\nCREATE TABLE "B" ("id" TEXT NOT NULL PRIMARY KEY);\n';
const crlfSql = toCrlf(lfSql);

interface FakeCall { query: string; values: unknown[] }

/** Client Prisma tiruan: mencatat query dan mengembalikan baris `_stream_router_migrations` yang diberikan. */
function fakeClient(appliedRows: Array<{ name: string; checksum: string }>) {
  const calls: FakeCall[] = [];
  const execute = async (query: string, ...values: unknown[]) => {
    calls.push({ query, values });
    return 0;
  };
  const queryRaw = async (query: string) => {
    calls.push({ query, values: [] });
    if (query.startsWith('SELECT "name", "checksum"')) return appliedRows;
    return [];
  };
  const client = {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $executeRawUnsafe: execute,
    $queryRawUnsafe: queryRaw,
    $transaction: async (action: (transaction: unknown) => Promise<unknown>) => action({
      $executeRawUnsafe: execute,
      $queryRawUnsafe: queryRaw
    })
  };
  return { calls, createClient: () => client };
}

let tmpRoot = '';

async function migrationsDir(name: string, sql: string): Promise<string> {
  const directory = path.join(tmpRoot, name);
  await mkdir(path.join(directory, '0001_contoh'), { recursive: true });
  await writeFile(path.join(directory, '0001_contoh', 'migration.sql'), sql);
  return directory;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'stream-router-checksum-'));
});

afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

describe('checksum migration lintas line ending', () => {
  it('menormalisasi CRLF ke LF tanpa mengubah isi LF', () => {
    expect(normalizeMigrationSql(crlfSql)).toBe(lfSql);
    expect(normalizeMigrationSql(lfSql)).toBe(lfSql);
  });

  it('menghasilkan checksum yang sama untuk varian LF dan CRLF, sama dengan hash LF mentah', () => {
    expect(migrationChecksum(lfSql)).toBe(sha256(lfSql));
    expect(migrationChecksum(crlfSql)).toBe(sha256(lfSql));
  });

  it('checksum migration init tetap sama dengan yang tersimpan di database LF yang sudah ada', async () => {
    const source = await readFile(initMigration, 'utf8');
    expect(migrationChecksum(source)).toBe(INIT_LF_CHECKSUM);
    expect(migrationChecksum(toCrlf(source))).toBe(INIT_LF_CHECKSUM);
    expect(sha256(toCrlf(source))).toBe(INIT_CRLF_CHECKSUM);
  });

  it('menerima checksum CRLF lama sebagai legacy dan menolak isi yang benar-benar berubah', () => {
    expect(compareMigrationChecksum(sha256(lfSql), crlfSql)).toEqual({ status: 'match', checksum: sha256(lfSql) });
    expect(compareMigrationChecksum(sha256(crlfSql), lfSql)).toEqual({ status: 'legacy', checksum: sha256(lfSql) });
    expect(compareMigrationChecksum(sha256(crlfSql), crlfSql).status).toBe('legacy');
    const mixed = '-- Tabel contoh\r\nCREATE TABLE "A" ("id" TEXT NOT NULL PRIMARY KEY);\nCREATE TABLE "B" ("id" TEXT NOT NULL PRIMARY KEY);\r\n';
    expect(compareMigrationChecksum(sha256(mixed), mixed).status).toBe('legacy');
    expect(compareMigrationChecksum(sha256(lfSql), lfSql.replace('"B"', '"C"')).status).toBe('changed');
    expect(compareMigrationChecksum(sha256(crlfSql), toCrlf(lfSql.replace('"B"', '"C"'))).status).toBe('changed');
  });
});

describe('runner migration dengan checksum ternormalisasi', () => {
  it('menyimpan checksum LF dan menjalankan statement tanpa CR untuk migration ber-CRLF', async () => {
    const fake = fakeClient([]);
    await applyMigrations({ databaseUrl: 'file:./tidak-dipakai.db', migrationsDir: await migrationsDir('baru-crlf', crlfSql), log: () => undefined, createClient: fake.createClient });
    const insert = fake.calls.find((call) => call.query.startsWith('INSERT INTO "_stream_router_migrations"'));
    expect(insert?.values).toEqual(['0001_contoh', sha256(lfSql)]);
    const statements = fake.calls.filter((call) => call.query.startsWith('CREATE TABLE "') || call.query.startsWith('-- Tabel'));
    expect(statements).toHaveLength(2);
    for (const statement of statements) expect(statement.query).not.toContain('\r');
  });

  it('melewati migration LF yang tersimpan dengan checksum LF dari checkout CRLF tanpa menulis ulang', async () => {
    const fake = fakeClient([{ name: '0001_contoh', checksum: sha256(lfSql) }]);
    await applyMigrations({ databaseUrl: 'file:./tidak-dipakai.db', migrationsDir: await migrationsDir('lama-lf', crlfSql), log: () => undefined, createClient: fake.createClient });
    expect(fake.calls.some((call) => /^(?:UPDATE|INSERT)/.test(call.query))).toBe(false);
    expect(fake.calls.some((call) => call.query === 'PRAGMA foreign_keys=OFF')).toBe(false);
  });

  it('menerima checksum CRLF lama pada image LF lalu menggantinya dengan checksum LF', async () => {
    const fake = fakeClient([{ name: '0001_contoh', checksum: sha256(crlfSql) }]);
    const logs: string[] = [];
    await applyMigrations({ databaseUrl: 'file:./tidak-dipakai.db', migrationsDir: await migrationsDir('lama-crlf', lfSql), log: (message: string) => logs.push(message), createClient: fake.createClient });
    const update = fake.calls.find((call) => call.query.startsWith('UPDATE "_stream_router_migrations"'));
    expect(update?.values).toEqual([sha256(lfSql), '0001_contoh']);
    expect(fake.calls.some((call) => call.query.startsWith('INSERT'))).toBe(false);
    expect(logs.join('\n')).toContain('0001_contoh');
  });

  it('tetap menolak migration yang isinya berubah setelah diterapkan', async () => {
    const fake = fakeClient([{ name: '0001_contoh', checksum: sha256(crlfSql) }]);
    await expect(applyMigrations({
      databaseUrl: 'file:./tidak-dipakai.db',
      migrationsDir: await migrationsDir('berubah', lfSql.replace('"B"', '"C"')),
      log: () => undefined,
      createClient: fake.createClient
    })).rejects.toThrow('Checksum migration berubah setelah diterapkan: 0001_contoh');
    expect(fake.calls.some((call) => call.query.startsWith('UPDATE'))).toBe(false);
  });
});
