#!/usr/bin/env node
// Entrypoint image Docker (tini sebagai PID 1 meneruskan sinyal ke sini). Urutan: validasi password
// role dan HOST_LAN_IP, siapkan AUTH_SECRET/APP_ENCRYPTION_KEY, terapkan migration, lalu jalankan
// MediaMTX dan API sebagai dua child independen. Shutdown menghentikan API lebih dulu agar relay
// FFmpeg dan recording ditutup rapi sebelum MediaMTX berhenti.
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from './apply-sqlite-migrations.mjs';
import {
  credentialProblems,
  mediaMtxExecutable,
  normalizePublicHost,
  ProcessSupervisor,
  parseEnvFile,
  resolveSecrets,
  serializeSecretsFile,
  sqliteDatabaseFile
} from './lib/container-supervisor-lib.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(rootDir, 'data');
const secretsFile = path.join(dataDir, 'secrets', 'stream-router.env');
// Total keduanya harus di bawah stop_grace_period docker-compose.yml (30 detik).
const API_STOP_TIMEOUT_MS = 20_000;
const MEDIAMTX_STOP_TIMEOUT_MS = 8_000;
const SHUTDOWN_ORDER = ['api', 'mediamtx'];

const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
const log = (message) => console.log(`[supervisor] ${message}`);
const warn = (message) => console.warn(`[supervisor] Peringatan: ${message}`);
const display = (target) => (target.startsWith(`${rootDir}${path.sep}`) ? path.relative(rootDir, target) : target);

function fail(message) {
  console.error(`[supervisor] ${message}`);
  process.exit(1);
}

let supervisor = null;
let stopSignal = null;

async function shutdown(signal) {
  log(`${signal} diterima; menghentikan API terlebih dahulu, lalu MediaMTX.`);
  const forced = await supervisor.shutdown(SHUTDOWN_ORDER);
  if (forced.length) log(`Shutdown selesai; ${forced.join(' dan ')} dihentikan paksa setelah batas waktu.`);
  else log('Graceful shutdown selesai.');
  process.exit(0);
}

function onSignal(signal) {
  if (stopSignal) {
    log(`${signal} kedua diterima; semua proses dihentikan paksa.`);
    supervisor?.killAll();
    process.exit(1);
  }
  stopSignal = signal;
  if (supervisor) {
    shutdown(signal).catch((error) => fail(`Shutdown gagal: ${error instanceof Error ? error.message : String(error)}`));
  } else {
    log(`${signal} diterima saat persiapan; berhenti sebelum layanan dijalankan.`);
  }
}

process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
// Pengaman bila supervisor sendiri crash: child tidak boleh tertinggal tanpa pengawas.
process.on('exit', () => supervisor?.killAll());

async function ensureWritableDirectory(directory, label) {
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
  } catch (error) {
    fail(`${label} ${directory} tidak dapat ditulis oleh user container (uid ${uid}): ${error.code ?? error.message}. Periksa izin volume atau bind mount.`);
  }
}

async function isNonEmptyFile(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function readStoredSecrets() {
  try {
    const content = await readFile(secretsFile, 'utf8');
    await chmod(secretsFile, 0o600).catch(() => undefined);
    await chmod(path.dirname(secretsFile), 0o700).catch(() => undefined);
    return parseEnvFile(content);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    return fail(`File secret ${display(secretsFile)} tidak dapat dibaca: ${error.code ?? error.message}.`);
  }
}

// Ditulis atomik dan di-fsync: kehilangan APP_ENCRYPTION_KEY berarti credential kamera hilang.
async function writeSecretsFile(entries) {
  const directory = path.dirname(secretsFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${secretsFile}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(serializeSecretsFile(entries), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, secretsFile);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function prepareSecrets(env, databaseFile) {
  const stored = await readStoredSecrets();
  const databaseExists = databaseFile ? await isNonEmptyFile(databaseFile) : false;
  const result = resolveSecrets({ env, stored, databaseExists });
  if (result.problems.length) fail(`Secret tidak valid: ${result.problems.join('; ')}.`);
  for (const message of result.warnings) warn(message);
  if (result.persist) {
    try {
      await writeSecretsFile(result.persist);
    } catch (error) {
      fail(`File secret ${display(secretsFile)} tidak dapat ditulis (uid ${uid}): ${error.code ?? error.message}.`);
    }
    const generated = Object.keys(result.sources).filter((key) => result.sources[key] === 'generated');
    log(`${generated.join(' dan ')} dibuat otomatis dan disimpan di ${display(secretsFile)}. Ikutkan volume data dalam setiap backup.`);
  }
  for (const [key, source] of Object.entries(result.sources)) {
    if (source === 'env') log(`${key} dipakai dari environment.`);
    if (source === 'file') log(`${key} dipakai dari ${display(secretsFile)}.`);
  }
  return result.values;
}

async function main() {
  const env = process.env;
  log(`Camera Integration dimulai (Node ${process.version}, uid ${uid}).`);

  const credentialIssues = credentialProblems(env);
  if (credentialIssues.length) {
    fail(`Konfigurasi belum lengkap: ${credentialIssues.join('; ')}. Isi ADMIN_PASSWORD dan OPERATOR_PASSWORD (minimal 8 karakter, bukan nilai contoh) di file .env di samping docker-compose.yml, lalu jalankan ulang container.`);
  }
  if (!env.DATABASE_URL) fail('DATABASE_URL belum diatur.');
  // API menolak nilai ini saat start; tanpa pemeriksaan di sini API restart terus dengan pesan
  // yang tidak menyebut HOST_LAN_IP.
  const publicHost = normalizePublicHost(env.MEDIAMTX_PUBLIC_HOST);
  if (publicHost === null) {
    fail(`HOST_LAN_IP (MEDIAMTX_PUBLIC_HOST) tidak valid: ${JSON.stringify(String(env.MEDIAMTX_PUBLIC_HOST).trim())}. Isi HOST_LAN_IP di file .env di samping docker-compose.yml dengan IP LAN komputer host saja, tanpa http:// dan tanpa port (mis. HOST_LAN_IP=192.168.1.10), lalu terapkan dengan docker compose up -d. Di Windows, jalankan ulang windows\\setup.ps1.`);
  }

  await ensureWritableDirectory(dataDir, 'Folder data');
  const databaseFile = sqliteDatabaseFile(env.DATABASE_URL, path.join(rootDir, 'prisma'));
  if (databaseFile) await ensureWritableDirectory(path.dirname(databaseFile), 'Folder database');
  const secrets = await prepareSecrets(env, databaseFile);

  const version = env.MEDIAMTX_VERSION || 'v1.19.2';
  const executable = mediaMtxExecutable(rootDir, { version });
  try {
    await access(executable, constants.X_OK);
  } catch {
    fail(`Binary MediaMTX ${version} tidak ditemukan di ${display(executable)}. Hapus MEDIAMTX_VERSION dari .env agar memakai versi bawaan image (di luar Docker: npm run media:ensure).`);
  }

  const recordingPath = path.resolve(rootDir, env.RECORDING_PATH || 'data/recordings');
  try {
    await mkdir(recordingPath, { recursive: true });
    await access(recordingPath, constants.W_OK);
  } catch (error) {
    warn(`RECORDING_PATH ${recordingPath} tidak dapat ditulis oleh uid ${uid} (${error.code ?? error.message}); recording gagal sampai izin folder diperbaiki.`);
  }

  if (!publicHost || ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(publicHost.toLowerCase())) {
    warn('MEDIAMTX_PUBLIC_HOST (HOST_LAN_IP) kosong atau loopback. Di Docker, WebRTC dari host lain di LAN membutuhkan IP LAN komputer host; isi HOST_LAN_IP di .env atau atur Public host di Settings.');
  }

  try {
    await applyMigrations({ databaseUrl: env.DATABASE_URL });
  } catch (error) {
    fail(`Migration database gagal: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (stopSignal) {
    log('Dihentikan sebelum layanan dijalankan.');
    process.exit(0);
  }

  const childEnv = { ...env, ...secrets };
  supervisor = new ProcessSupervisor({
    log,
    services: [
      {
        name: 'mediamtx',
        label: 'MediaMTX',
        command: process.execPath,
        args: [path.join(rootDir, 'scripts', 'run-mediamtx.mjs')],
        cwd: rootDir,
        env: childEnv,
        stopTimeoutMs: MEDIAMTX_STOP_TIMEOUT_MS
      },
      {
        name: 'api',
        label: 'API',
        command: process.execPath,
        args: [path.join(rootDir, 'apps', 'api', 'dist', 'server.js')],
        cwd: rootDir,
        env: childEnv,
        stopTimeoutMs: API_STOP_TIMEOUT_MS
      }
    ]
  });
  supervisor.start();
  const port = env.PORT || '3000';
  const host = publicHost.includes(':') ? `[${publicHost}]` : publicHost || 'localhost';
  log(`Dashboard: http://${host}:${port} (port host mengikuti mapping docker-compose.yml).`);
}

main().catch((error) => fail(`Gagal memulai: ${error instanceof Error ? error.message : String(error)}`));
