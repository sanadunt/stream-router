#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_MEDIAMTX_VERSION = 'v1.19.2';

/**
 * SHA-256 arsip resmi `mediamtx_<versi>_<platform>_<arch>.tar.gz` per versi, disalin dari
 * checksums.sha256 release saat versi tersebut dipin. Pin di repository menolak arsip yang diganti
 * di release upstream walaupun checksums.sha256 ikut diganti. Saat menaikkan versi default
 * MEDIAMTX_VERSION, tambahkan entri versi baru di sini; unit test memeriksa versi di Dockerfile.
 */
export const PINNED_MEDIAMTX_SHA256 = Object.freeze({
  'v1.19.2': Object.freeze({
    'darwin-amd64': 'b8851bf53d1e0d6d078240d54e78517a3a239b40040b22cddddf5a0ef2712c17',
    'darwin-arm64': 'c225e46ab65295f95ee9fcda75703129c07add8852483abda09299a78524391f',
    'linux-amd64': 'f9c601cc303ceca8fad2883917b022882672c5bc56311e92dbceb16e5f20c60c',
    'linux-arm64': '562f419912a8668c18216a9e8c95359ec82fbb754e4a44e2953ef62b98eec688'
  })
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function mediaMtxArchName(arch = process.arch) {
  return arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : '';
}

/**
 * SHA-256 yang wajib dimiliki arsip: pin repository untuk versi dan platform ini, atau
 * MEDIAMTX_SHA256_AMD64 / MEDIAMTX_SHA256_ARM64 dari environment (build-arg Docker) untuk versi
 * yang belum dipin. null bila tidak ada pin sama sekali.
 */
export function pinnedArchiveSha256({ version, platform, archName, env = process.env, pins = PINNED_MEDIAMTX_SHA256 }) {
  const target = `${platform}-${archName}`;
  const key = `MEDIAMTX_SHA256_${archName.toUpperCase()}`;
  const fromEnv = String(env[key] ?? '').trim().toLowerCase();
  if (fromEnv && !SHA256_PATTERN.test(fromEnv)) throw new Error(`${key} tidak valid: gunakan 64 karakter heksadesimal SHA-256.`);
  const fromRepo = Object.hasOwn(pins, version) && Object.hasOwn(pins[version], target) ? pins[version][target] : '';
  if (fromEnv && fromRepo && fromEnv !== fromRepo) {
    throw new Error(`${key} berbeda dengan SHA-256 terpin MediaMTX ${version} (${target}) di scripts/ensure-mediamtx.mjs.`);
  }
  return fromRepo || fromEnv || null;
}

/** Hash yang diharapkan dari baris `<sha256> *<nama arsip>` di checksums.sha256 release. */
export function releaseChecksum(checksums, archiveName) {
  const line = checksums.split(/\r?\n/).find((entry) => entry.trim().endsWith(archiveName));
  return line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
}

const truthy = (value) => /^(?:true|1|yes|on)$/i.test(String(value ?? '').trim());

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download gagal (${response.status}) ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} berhenti dengan code ${code}`)));
  });
}

// Binary dianggap sehat hanya bila `--version` keluar normal dan mencetak versi.
function probe(file) {
  return new Promise((resolve) => {
    const child = spawn(file, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const text = output.trim();
      if (code === 0 && text) resolve({ ok: true, output: text });
      else resolve({ ok: false, reason: signal ? `berhenti karena ${signal}` : `exit ${code}${text ? '' : ' tanpa output versi'}` });
    });
  });
}

async function installRelease({ version, platform, archName, installDir, pinned, requirePin }) {
  const releaseRoot = `https://github.com/bluenviron/mediamtx/releases/download/${version}`;
  const archiveName = `mediamtx_${version}_${platform}_${archName}.tar.gz`;
  if (!pinned && requirePin) {
    throw new Error(`MediaMTX ${version} (${platform}-${archName}) belum memiliki SHA-256 terpin. Tambahkan ke PINNED_MEDIAMTX_SHA256 di scripts/ensure-mediamtx.mjs, atau berikan --build-arg MEDIAMTX_SHA256_${archName.toUpperCase()}=<sha256 ${archiveName}>.`);
  }
  const stagingPrefix = `.staging-${platform}-${archName}-`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'stream-router-mediamtx-'));
  const versionDir = path.dirname(installDir);
  await mkdir(versionDir, { recursive: true });
  // Sisa ekstraksi yang terputus (mis. Ctrl+C) tidak pernah dipakai; bersihkan sebelum mencoba lagi.
  for (const name of await readdir(versionDir)) {
    if (name.startsWith(stagingPrefix)) await rm(path.join(versionDir, name), { recursive: true, force: true });
  }
  const stagingDir = await mkdtemp(path.join(versionDir, stagingPrefix));
  try {
    console.log(`[mediamtx] Mengunduh ${archiveName}...`);
    const archive = await download(`${releaseRoot}/${archiveName}`);
    let expected = pinned;
    if (!expected) {
      // Tanpa pin, checksums.sha256 dari release yang sama hanya mendeteksi unduhan rusak.
      console.warn(`[mediamtx] Peringatan: ${version} belum memiliki SHA-256 terpin; arsip hanya dicocokkan dengan checksums.sha256 dari release yang sama.`);
      expected = releaseChecksum((await download(`${releaseRoot}/checksums.sha256`)).toString('utf8'), archiveName);
      if (!expected) throw new Error(`Checksum ${archiveName} tidak ditemukan pada release ${version}`);
    }
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== expected) {
      throw new Error(`Checksum MediaMTX tidak cocok${pinned ? ' dengan SHA-256 terpin' : ''}: expected ${expected}, received ${actual}`);
    }
    const archivePath = path.join(tempDir, archiveName);
    await writeFile(archivePath, archive);
    // Ekstrak ke folder staging lalu rename atomik, agar path cache tidak pernah berisi binary setengah jadi.
    await run('tar', ['-xzf', archivePath, '-C', stagingDir, 'mediamtx'], rootDir);
    const staged = path.join(stagingDir, 'mediamtx');
    await chmod(staged, 0o755);
    const result = await probe(staged);
    if (!result.ok) throw new Error(`Binary MediaMTX ${version} hasil ekstraksi tidak dapat dijalankan (${result.reason}).`);
    await chmod(stagingDir, 0o755);
    await rm(installDir, { recursive: true, force: true });
    await rename(stagingDir, installDir);
    console.log(`[mediamtx] ${version} siap di ${path.relative(rootDir, path.join(installDir, 'mediamtx'))}`);
    return result;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  // Versi harus sama dengan yang dijalankan run-mediamtx.mjs dan dilaporkan API, yaitu dari .env.
  loadDotenv({ path: path.join(rootDir, '.env') });
  const version = process.env.MEDIAMTX_VERSION || DEFAULT_MEDIAMTX_VERSION;
  const platform = process.platform;
  const arch = process.arch;
  const archName = mediaMtxArchName(arch);

  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`MEDIAMTX_VERSION tidak valid: ${JSON.stringify(version)}. Gunakan format vMAJOR.MINOR.PATCH, misalnya v1.19.2.`);
  }
  if (!['darwin', 'linux'].includes(platform) || !archName) {
    throw new Error(`MediaMTX tidak tersedia otomatis untuk ${platform}/${arch}. Gunakan macOS/Linux amd64 atau arm64.`);
  }

  const pinned = pinnedArchiveSha256({ version, platform, archName });
  // Build image Docker mewajibkan pin; alur development tetap dapat memakai versi tanpa pin.
  const requirePin = truthy(process.env.MEDIAMTX_REQUIRE_SHA256);
  const installDir = path.join(rootDir, '.runtime', 'mediamtx', version, `${platform}-${archName}`);
  const executable = path.join(installDir, 'mediamtx');

  let verified = (await exists(executable)) ? await probe(executable) : undefined;
  if (verified && !verified.ok) {
    console.warn(`[mediamtx] Binary cache ${path.relative(rootDir, executable)} rusak (${verified.reason}); mengunduh ulang ${version}.`);
    await rm(installDir, { recursive: true, force: true });
    verified = undefined;
  }
  if (!verified) verified = await installRelease({ version, platform, archName, installDir, pinned, requirePin });
  if (!verified.output.includes(version)) {
    console.warn(`[mediamtx] Peringatan: binary melaporkan versi ${verified.output}, sedangkan MEDIAMTX_VERSION=${version}.`);
  }

  if (process.argv.includes('--print-path')) {
    process.stdout.write(`${executable}\n`);
  } else {
    console.log(`[mediamtx] Binary terverifikasi: ${verified.output}`);
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

if (invokedDirectly()) await main();
