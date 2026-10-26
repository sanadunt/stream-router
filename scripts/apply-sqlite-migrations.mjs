#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Default interactive transaction Prisma hanya 5 detik; redefinisi tabel besar
// pada disk VPS/SD card bisa jauh lebih lama dan akan dibatalkan di tengah jalan.
export const MIGRATION_TRANSACTION_OPTIONS = Object.freeze({ timeout: 30 * 60_000, maxWait: 60_000 });

export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    current += character;

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === '-' && next === '-') {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Checkout Git for Windows (core.autocrlf=true) dapat berisi migration ber-CRLF. Isi dinormalisasi
 * ke LF sebelum di-hash maupun dijalankan, sehingga image hasil `setup.ps1 -Build` dan image CI
 * menghasilkan checksum yang sama pada volume data yang dipakai bergantian.
 */
export function normalizeMigrationSql(sql) {
  return sql.replace(/\r\n/g, '\n');
}

/** Checksum kanonik. Isi LF tidak berubah oleh normalisasi, jadi checksum yang sudah tersimpan tetap cocok. */
export function migrationChecksum(sql) {
  return sha256(normalizeMigrationSql(sql));
}

/**
 * Membandingkan checksum tersimpan dengan isi migration: `match` bila sama dengan checksum kanonik,
 * `legacy` bila sama dengan hash mentah atau varian CRLF yang disimpan runner lama dari checkout
 * CRLF (isi sama, hanya line ending berbeda), dan `changed` bila isinya memang berubah.
 */
export function compareMigrationChecksum(storedChecksum, sql) {
  const checksum = migrationChecksum(sql);
  if (storedChecksum === checksum) return { status: 'match', checksum };
  const crlf = normalizeMigrationSql(sql).replace(/\n/g, '\r\n');
  const legacy = storedChecksum === sha256(sql) || storedChecksum === sha256(crlf);
  return { status: legacy ? 'legacy' : 'changed', checksum };
}

export async function migrationFiles(migrationsDir = path.join(rootDir, 'prisma', 'migrations')) {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => ({
      name: entry.name,
      sql: await readFile(path.join(migrationsDir, entry.name, 'migration.sql'), 'utf8')
    })));
}

// PRAGMA foreign_keys bersifat per koneksi dan diabaikan di dalam transaksi, sehingga
// harus diset sebelum BEGIN pada koneksi yang sama. Pool satu koneksi menjamin itu.
export function singleConnectionUrl(databaseUrl) {
  if (/[?&]connection_limit=/.test(databaseUrl)) return databaseUrl.replace(/([?&]connection_limit=)[^&]*/, '$11');
  return `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=1`;
}

/** Jumlah pelanggaran `PRAGMA foreign_key_check` per pasangan `tabel -> parent`. */
export function foreignKeyViolationCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = `${row.table} -> ${row.parent}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function describeCounts(counts) {
  return [...counts].map(([key, total]) => `${key}: ${total}`).join(', ');
}

/**
 * Pelanggaran baru akibat migration. Dibandingkan per `tabel -> parent`, bukan per rowid,
 * karena redefinisi tabel menomori ulang rowid. Baris yatim yang sudah ada sebelumnya
 * (mis. hasil edit manual dengan sqlite3 tanpa foreign key) tidak menghalangi migration.
 */
export function newForeignKeyViolations(before, after) {
  const increased = new Map();
  for (const [key, total] of after) {
    const previous = before.get(key) ?? 0;
    if (total > previous) increased.set(key, total - previous);
  }
  return increased;
}

export async function applyMigrations({
  databaseUrl,
  migrationsDir,
  log = console.log,
  warn = console.warn,
  createClient = (options) => new PrismaClient(options)
}) {
  if (!databaseUrl) throw new Error('DATABASE_URL belum diatur. Buat .env dari .env.example terlebih dahulu.');
  const prisma = createClient({ datasourceUrl: singleConnectionUrl(databaseUrl) });
  let reportedPreexisting = '';
  try {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_stream_router_migrations" (
      "name" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    const applied = await prisma.$queryRawUnsafe('SELECT "name", "checksum" FROM "_stream_router_migrations"');
    const appliedByName = new Map(applied.map((row) => [row.name, row.checksum]));

    for (const migration of await migrationFiles(migrationsDir)) {
      const sql = normalizeMigrationSql(migration.sql);
      const previousChecksum = appliedByName.get(migration.name);
      if (previousChecksum) {
        const { status, checksum } = compareMigrationChecksum(previousChecksum, migration.sql);
        if (status === 'changed') throw new Error(`Checksum migration berubah setelah diterapkan: ${migration.name}`);
        if (status === 'legacy') {
          await prisma.$executeRawUnsafe(
            'UPDATE "_stream_router_migrations" SET "checksum" = ? WHERE "name" = ?',
            checksum,
            migration.name
          );
          log(`[migrate] Checksum ${migration.name} dari checkout CRLF diperbarui ke checksum LF.`);
        }
        continue;
      }
      const checksum = migrationChecksum(sql);

      log(`[migrate] Menerapkan ${migration.name}`);
      // Tanpa ini DROP TABLE pada redefinisi tabel menjalankan ON DELETE CASCADE/SET NULL
      // dan menghapus diam-diam baris anak (RouteRun, subscription MQTT, dan lainnya).
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
      try {
        const before = foreignKeyViolationCounts(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check'));
        const preexisting = describeCounts(before);
        if (preexisting && preexisting !== reportedPreexisting) {
          reportedPreexisting = preexisting;
          warn(`[migrate] Peringatan: database sudah memiliki pelanggaran foreign key sebelum ${migration.name} (${preexisting}). Migration tetap dilanjutkan; periksa dengan \`sqlite3 <db> "PRAGMA foreign_key_check"\` lalu bersihkan baris yatim tersebut.`);
        }
        await prisma.$transaction(async (transaction) => {
          for (const statement of splitStatements(sql)) {
            await transaction.$executeRawUnsafe(statement);
          }
          const after = foreignKeyViolationCounts(await transaction.$queryRawUnsafe('PRAGMA foreign_key_check'));
          const added = newForeignKeyViolations(before, after);
          if (added.size > 0) {
            const total = [...added.values()].reduce((sum, value) => sum + value, 0);
            throw new Error(`Migration ${migration.name} meninggalkan ${total} pelanggaran foreign key baru (${describeCounts(added)}); perubahan dibatalkan.`);
          }
          await transaction.$executeRawUnsafe(
            'INSERT INTO "_stream_router_migrations" ("name", "checksum") VALUES (?, ?)',
            migration.name,
            checksum
          );
        }, MIGRATION_TRANSACTION_OPTIONS);
      } finally {
        await prisma.$executeRawUnsafe('PRAGMA foreign_keys=ON');
      }
    }
    log('[migrate] Database siap.');
  } finally {
    await prisma.$disconnect();
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  loadDotenv({ path: path.join(rootDir, '.env') });
  await applyMigrations({ databaseUrl: process.env.DATABASE_URL });
}
