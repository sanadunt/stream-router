#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv, parse as parseDotenv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  assertUsableKeys,
  collectCells,
  decryptValue,
  ENCRYPTED_COLUMNS,
  findShadowedEnv,
  planReencryption,
  selectEncryptedSql,
  summarizePlan,
  updateEncryptedSql
} from './lib/encryption-rotation.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// STREAM_ROUTER_ENV_FILE hanya untuk test atau layout non-standar; default sama dengan server.ts.
const envFile = process.env.STREAM_ROUTER_ENV_FILE || path.join(rootDir, '.env');
const shadowCheckedEnv = ['APP_ENCRYPTION_KEY', 'DATABASE_URL', 'HOST', 'PORT'];
const knownFlags = new Set(['--dry-run', '--force', '--help', '-h']);

function usage() {
  console.log('Penggunaan: npm run secrets:reencrypt -- [--dry-run] [--force]');
  console.log('Key baru dibaca dari APP_ENCRYPTION_KEY di .env. Key lama diminta lewat prompt tersembunyi');
  console.log('atau dibaca dari environment OLD_APP_ENCRYPTION_KEY. Key tidak boleh diberikan sebagai argumen.');
  console.log('  --dry-run  Periksa bahwa semua data dapat didekripsi tanpa menulis apa pun.');
  console.log('  --force    Lanjutkan walaupun port API terlihat masih aktif.');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function apiAddress() {
  const host = process.env.HOST && !['0.0.0.0', '::'].includes(process.env.HOST) ? process.env.HOST : '127.0.0.1';
  return { host, port: Number(process.env.PORT || 3000) };
}

function isListening({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

function readHiddenLine(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('Key lama tidak tersedia. Jalankan dari terminal interaktif atau set OLD_APP_ENCRYPTION_KEY.'));
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') return finish();
        if (character === '\u0003') return finish(new Error('Dibatalkan.'));
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on('data', onData);
  });
}

/** Membaca .env seperti aplikasi, tetapi menolak variabel shell yang diam-diam menimpa nilainya. */
function loadEnvironment() {
  if (!existsSync(envFile)) return { newKeySource: 'environment' };
  const fileValues = parseDotenv(readFileSync(envFile));
  const shadowed = findShadowedEnv(fileValues, process.env, shadowCheckedEnv);
  if (shadowed.length > 0) {
    throw new Error(
      `Variabel shell ${shadowed.join(', ')} berbeda dengan nilai di ${envFile}. `
      + `Jalankan \`unset ${shadowed.join(' ')}\` lalu ulangi agar script memakai nilai yang sama dengan aplikasi.`
    );
  }
  loadDotenv({ path: envFile });
  return { newKeySource: fileValues.APP_ENCRYPTION_KEY !== undefined ? envFile : 'environment' };
}

function databaseFilePath() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl.startsWith('file:')) return null;
  const file = databaseUrl.slice('file:'.length).split('?')[0] ?? '';
  if (!file) return null;
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(rootDir, 'prisma', file);
}

async function loadRows(client) {
  const entries = await Promise.all(Object.keys(ENCRYPTED_COLUMNS).map(async (table) => (
    [table, await client.$queryRawUnsafe(selectEncryptedSql(table))]
  )));
  return Object.fromEntries(entries);
}

async function backupDatabase(prisma) {
  const databaseFile = databaseFilePath();
  if (!databaseFile) throw new Error('DATABASE_URL bukan file SQLite; backup otomatis tidak dapat dibuat.');
  const backupDir = path.join(path.dirname(databaseFile), 'backups');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `${path.parse(databaseFile).name}-before-reencrypt-${stamp}.db`);
  // VACUUM INTO menghasilkan salinan konsisten; umask memastikan file tidak pernah terbaca user lain.
  const previousUmask = process.umask(0o077);
  try {
    await prisma.$executeRawUnsafe('VACUUM INTO ?', backupFile);
  } finally {
    process.umask(previousUmask);
  }
  await chmod(backupFile, 0o600);
  return backupFile;
}

async function rotate(prisma, plan, newKey) {
  try {
    await prisma.$transaction(async (tx) => {
      for (const update of plan.updates) {
        const count = await tx.$executeRawUnsafe(
          updateEncryptedSql(update.table, update.column),
          update.next,
          update.id,
          update.previous
        );
        if (count !== 1) throw new Error(`Data berubah selama proses (${update.table}.${update.column} id=${update.id}).`);
      }
      // Verifikasi sebelum commit: kegagalan apa pun membatalkan seluruh transaksi.
      for (const cell of collectCells(await loadRows(tx))) {
        try {
          decryptValue(cell.value, newKey);
        } catch {
          throw new Error(`Verifikasi key baru gagal pada ${cell.table}.${cell.column} id=${cell.id}.`);
        }
      }
    }, { maxWait: 10_000, timeout: 120_000 });
  } catch (error) {
    throw new Error(`${messageOf(error)} Transaksi dibatalkan; tidak ada data yang diubah dan backup tidak perlu dipulihkan.`);
  }
}

/** Menulis ulang file database agar ciphertext key lama di halaman bebas SQLite ikut hilang. */
async function compactDatabase(prisma) {
  try {
    await prisma.$executeRawUnsafe('VACUUM');
    console.log('[reencrypt] File database dipadatkan (VACUUM); sisa ciphertext key lama sudah dihapus dari file aktif.');
  } catch (error) {
    console.warn(`[reencrypt] Peringatan: VACUUM gagal (${messageOf(error)}).`);
    console.warn('[reencrypt] Data sudah memakai key baru, tetapi file database masih dapat menyimpan sisa ciphertext key lama.');
    console.warn('[reencrypt] Hentikan API lalu jalankan ulang `npm run secrets:reencrypt` untuk mengulang VACUUM.');
  }
}

function printSummary(plan) {
  console.log('[reencrypt] Ringkasan per kolom (dienkripsi ulang / sudah memakai key baru / gagal):');
  for (const row of summarizePlan(plan)) {
    console.log(`  ${`${row.table}.${row.column}`.padEnd(34)} ${row.rotated} / ${row.alreadyRotated} / ${row.failed}`);
  }
}

function failureMessage(plan) {
  if (plan.updates.length === 0 && plan.alreadyRotated.length === 0) {
    return 'Tidak ada nilai yang dapat dibuka dengan key lama. Periksa key lama. Tidak ada data yang diubah.';
  }
  return `${plan.updates.length + plan.alreadyRotated.length} nilai dapat dibuka, tetapi ${plan.failures.length} nilai di atas `
    + 'tidak dapat dibuka dengan key mana pun sehingga aplikasi juga tidak dapat membacanya. '
    + 'Isi ulang atau hapus nilai tersebut melalui dashboard, lalu ulangi. Tidak ada data yang diubah.';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const unknown = args.filter((arg) => !knownFlags.has(arg));
  if (unknown.length > 0) {
    usage();
    throw new Error('Argumen tidak dikenal. Key tidak boleh diberikan sebagai argumen command.');
  }
  const dryRun = args.includes('--dry-run');
  // Tanpa `--`, npm menelan --dry-run sebagai flag miliknya sendiri dan script akan menulis perubahan.
  if (process.env.npm_config_dry_run === 'true' && !dryRun) {
    throw new Error('Flag --dry-run diterima npm, bukan script. Gunakan `npm run secrets:reencrypt -- --dry-run`.');
  }

  const { newKeySource } = loadEnvironment();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diatur. Buat .env dari .env.example terlebih dahulu.');

  if (!dryRun && !args.includes('--force')) {
    const address = apiAddress();
    if (await isListening(address)) {
      throw new Error(
        `API tampaknya masih berjalan di ${address.host}:${address.port}. Hentikan API terlebih dahulu `
        + '(pm2 stop stream-router atau Ctrl+C pada npm run dev). Gunakan --force hanya bila port tersebut dipakai aplikasi lain.'
      );
    }
  }

  const newKey = process.env.APP_ENCRYPTION_KEY ?? '';
  const oldKey = process.env.OLD_APP_ENCRYPTION_KEY || await readHiddenLine('APP_ENCRYPTION_KEY lama: ');
  assertUsableKeys(oldKey, newKey);
  console.log(`[reencrypt] Key baru: APP_ENCRYPTION_KEY dari ${newKeySource}.`);

  const prisma = new PrismaClient();
  try {
    const plan = planReencryption(collectCells(await loadRows(prisma)), oldKey, newKey);
    printSummary(plan);

    if (plan.failures.length > 0) {
      console.error('[reencrypt] Nilai berikut tidak dapat didekripsi dengan key lama maupun key baru:');
      for (const failure of plan.failures) console.error(`  ${failure.table}.${failure.column} id=${failure.id}`);
      throw new Error(failureMessage(plan));
    }
    if (dryRun) {
      console.log('[reencrypt] Dry-run selesai: seluruh data dapat dienkripsi ulang. Tidak ada perubahan yang ditulis.');
      return;
    }
    if (plan.updates.length === 0) {
      console.log('[reencrypt] Tidak ada nilai yang perlu dienkripsi ulang.');
      await compactDatabase(prisma);
      return;
    }

    const backupFile = await backupDatabase(prisma);
    console.log(`[reencrypt] Backup dibuat: ${backupFile}`);
    await rotate(prisma, plan, newKey);
    console.log(`[reencrypt] Selesai: ${plan.updates.length} nilai dienkripsi ulang dengan APP_ENCRYPTION_KEY baru.`);
    await compactDatabase(prisma);
    console.log('[reencrypt] Jalankan aplikasi lalu periksa route, MQTT broker, PTZ, dan Stream View.');
    console.log('[reencrypt] Backup di atas masih dapat dibuka dengan key lama. Hapus setelah aplikasi terverifikasi;');
    console.log('[reencrypt] untuk rollback, lihat bagian "Rotasi key" di docs/SECURITY.md.');
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  console.error(`[reencrypt] ${messageOf(error)}`);
  process.exitCode = 1;
}
