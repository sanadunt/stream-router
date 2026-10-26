#!/usr/bin/env node
// Memverifikasi hasil `npm run build` dengan benar-benar menjalankan apps/api/dist/server.js.
// lint, typecheck, vitest, dan smoke tidak pernah mengeksekusi dist, sehingga kegagalan resolusi
// modul khusus Node ESM (mis. import direktori `onvif/promises`) lolos dari semua pemeriksaan itu
// dan baru terlihat saat PM2 crash-loop. Script ini tidak membangun apa pun: jalankan setelah build.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { applyMigrations } from './apply-sqlite-migrations.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(rootDir, 'apps/api/dist/server.js');
const distDirectories = ['apps/api/dist', 'packages/contracts/dist', 'packages/ffmpeg/dist'].map((dir) => path.join(rootDir, dir));
const BOOT_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 8_000;

function log(message) {
  console.log(`[verify:dist] ${message}`);
}

async function javascriptFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await javascriptFiles(full));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) result.push(full);
  }
  return result;
}

// Spesifier string literal dari import/export statis dan import() dinamis hasil kompilasi tsc.
function importSpecifiers(source) {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
  return [...source.matchAll(pattern)].map((match) => match[2]);
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function findPackageDirectory(name, fromDirectory) {
  let current = fromDirectory;
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Node ESM tidak menebak ekstensi maupun index.js. Spesifier relatif wajib menunjuk file dengan
 * ekstensi, dan subpath paket tanpa peta "exports" wajib menunjuk file, bukan direktori.
 */
function specifierProblem(specifier, file) {
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!/\.(?:js|mjs|cjs|json)$/.test(specifier)) return 'import relatif tanpa ekstensi .js';
    return isFile(path.resolve(path.dirname(file), specifier)) ? null : 'file tujuan tidak ada';
  }
  if (specifier.startsWith('/') || /^[a-z]+:/i.test(specifier)) return null;
  if (builtinModules.includes(specifier)) return null;
  const name = packageName(specifier);
  const packageDirectory = findPackageDirectory(name, path.dirname(file));
  if (!packageDirectory) return 'paket tidak ditemukan di node_modules';
  const subpath = specifier.slice(name.length);
  if (!subpath) return null;
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  // Paket dengan "exports" divalidasi Node saat boot di bawah.
  if (manifest.exports !== undefined) return null;
  const target = path.join(packageDirectory, subpath);
  if (!isFile(target)) return 'subpath paket tanpa "exports" harus menunjuk file (import direktori tidak didukung ESM)';
  return null;
}

async function checkImports() {
  const problems = [];
  let checked = 0;
  for (const dir of distDirectories) {
    if (!existsSync(dir)) throw new Error(`${path.relative(rootDir, dir)} belum ada. Jalankan \`npm run build\` terlebih dahulu.`);
    for (const file of await javascriptFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        checked += 1;
        const problem = specifierProblem(specifier, file);
        if (problem) problems.push(`${path.relative(rootDir, file)}: '${specifier}' (${problem})`);
      }
    }
  }
  if (problems.length) throw new Error(`Import di dist tidak dapat dimuat Node ESM:\n  - ${problems.join('\n  - ')}`);
  log(`${checked} spesifier import di dist dapat di-resolve Node ESM.`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Port lokal yang menutup setiap koneksi, sehingga request ke sana pasti gagal. */
function blackholeServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Port MediaMTX berasal dari tabel AppSetting dengan default port production (Control API 19997).
 * Boot recovery menghapus path `cameras/*` yang tidak dimiliki route auto-start, dan database uji
 * ini kosong: tanpa pengalihan, verifikasi di server production akan menghapus path kamera milik
 * MediaMTX yang sedang berjalan. Semua port MediaMTX diarahkan ke port blackhole.
 */
async function isolateMediaMtx(databaseUrl, port) {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const settings = {
      'mediamtx.enabled': 'false',
      'mediamtx.apiPort': String(port),
      'mediamtx.playbackPort': String(port),
      'mediamtx.rtspPort': String(port),
      'mediamtx.metricsPort': String(port)
    };
    for (const [key, value] of Object.entries(settings)) {
      await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
  } finally {
    await prisma.$disconnect();
  }
}

function secret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Seluruh key envSchema diisi eksplisit (nilai uji atau default schema), sehingga .env di root
 * project yang tetap dimuat server.js tidak dapat mengubah konfigurasi boot uji ini.
 */
async function bootEnvironment(tempDir, port) {
  const { envSchema } = await import(pathToFileURL(path.join(rootDir, 'apps/api/dist/config/env.js')).href);
  const overrides = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: `file:${path.join(tempDir, 'verify-dist.db')}`,
    AUTH_SECRET: secret(),
    APP_ENCRYPTION_KEY: secret(),
    ADMIN_PASSWORD: secret(),
    OPERATOR_PASSWORD: secret(),
    CORS_ORIGIN: 'https://verify-dist.invalid',
    TRUST_PROXY: 'false',
    MEDIAMTX_ENABLED: 'false',
    MEDIAMTX_CONFIG_PATH: path.join(tempDir, 'mediamtx.yml'),
    RECORDING_PATH: path.join(tempDir, 'recordings'),
    // Cleanup log saat startup menyentuh data/logs project; retensi maksimum agar tidak ada yang terhapus.
    LOG_RETENTION_DAYS: '365',
    LOG_LEVEL: 'warn'
  };
  const parsed = envSchema.parse(overrides);
  const env = { ...overrides };
  for (const key of Object.keys(envSchema.shape)) {
    if (key in env) continue;
    const value = parsed[key];
    env[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SystemRoot']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = 'belum ada respons';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server.js berhenti sebelum menjawab (exit ${child.exitCode ?? child.signalCode}).\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json().catch(() => null);
      if (response.status === 200 && body && typeof body.ok === 'boolean') return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`/api/health tidak menjawab dalam ${BOOT_TIMEOUT_MS / 1000} detik (${lastError}).\n${output()}`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, forced: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'SIGKILL', forced: true });
    }, SHUTDOWN_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, forced: false });
    });
    child.kill('SIGTERM');
  });
}

async function bootServer() {
  if (!existsSync(serverEntry)) throw new Error('apps/api/dist/server.js belum ada. Jalankan `npm run build` terlebih dahulu.');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stream-router-verify-dist-'));
  let child;
  let blackhole;
  try {
    const port = await freePort();
    const env = await bootEnvironment(tempDir, port);
    await applyMigrations({ databaseUrl: env.DATABASE_URL, log: () => undefined });
    blackhole = await blackholeServer();
    await isolateMediaMtx(env.DATABASE_URL, blackhole.address().port);
    log(`Menjalankan dist/server.js (NODE_ENV=production, MediaMTX nonaktif, database sementara) di port ${port} ...`);
    let captured = '';
    const capture = (chunk) => {
      captured = (captured + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    };
    // cwd sementara: dotenv tanpa path di server.js tidak memuat .env lain.
    child = spawn(process.execPath, [serverEntry], { cwd: tempDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const output = () => (captured.trim() ? `Output server:\n${captured.trim()}` : 'Server tidak menulis output.');
    await waitForHealth(`http://127.0.0.1:${port}`, child, output);
    log('/api/health menjawab 200.');
    const stopped = await stopServer(child);
    if (stopped.forced) throw new Error(`server.js tidak berhenti dalam ${SHUTDOWN_TIMEOUT_MS / 1000} detik setelah SIGTERM.\n${output()}`);
    if (stopped.code !== 0) throw new Error(`Graceful shutdown berakhir dengan exit ${stopped.code ?? stopped.signal}.\n${output()}`);
    log('Graceful shutdown selesai (exit 0).');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    blackhole?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

try {
  await checkImports();
  await bootServer();
  log('PASS: build production dapat dimuat dan dijalankan Node.');
} catch (error) {
  console.error(`[verify:dist] GAGAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
