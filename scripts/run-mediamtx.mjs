#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: path.join(rootDir, '.env') });

const version = process.env.MEDIAMTX_VERSION || 'v1.19.2';
const archName = process.arch === 'x64' ? 'amd64' : process.arch;
const executable = path.join(rootDir, '.runtime', 'mediamtx', version, `${process.platform}-${archName}`, 'mediamtx');
const configPath = path.resolve(rootDir, process.env.MEDIAMTX_CONFIG_PATH || 'data/mediamtx/mediamtx.yml');
const recordingPath = path.resolve(rootDir, process.env.RECORDING_PATH || 'data/recordings');
const logPath = path.join(rootDir, 'data', 'logs', 'mediamtx.log');

// Dipakai installer systemd agar unit membaca YAML yang sama dengan API (MEDIAMTX_CONFIG_PATH).
if (process.argv.includes('--print-config-path')) {
  process.stdout.write(`${configPath}\n`);
  process.exit(0);
}

await mkdir(path.dirname(configPath), { recursive: true });
await mkdir(recordingPath, { recursive: true });
await mkdir(path.dirname(logPath), { recursive: true });
try {
  if ((await stat(logPath)).size > 10 * 1024 * 1024) {
    const lines = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).slice(-5000);
    await writeFile(logPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  }
} catch {
  // File log akan dibuat saat MediaMTX mulai menulis.
}

// Config awal dipakai sampai Settings MediaMTX disimpan. Di container, interface yang terlihat hanya
// jaringan Docker, sehingga host LAN dari MEDIAMTX_PUBLIC_HOST wajib diiklankan sebagai kandidat ICE.
const initialPublicHost = (process.env.MEDIAMTX_PUBLIC_HOST || '').trim().replace(/^\[(.*)\]$/, '$1');
const initialAdditionalHosts = /^[A-Za-z0-9.:-]+$/.test(initialPublicHost)
  && !['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(initialPublicHost.toLowerCase())
  ? [initialPublicHost]
  : [];

const initialConfig = [
  'logLevel: info',
  'logDestinations: [stdout]',
  'readTimeout: 10s',
  'writeTimeout: 10s',
  'authMethod: internal',
  'authInternalUsers:',
  '  - user: any',
  '    pass:',
  '    ips: ["127.0.0.1", "::1"]',
  '    permissions:',
  '      - action: read',
  '        path:',
  '      - action: playback',
  '        path:',
  '      - action: api',
  '      - action: metrics',
  '      - action: pprof',
  'api: yes',
  'apiAddress: 127.0.0.1:19997',
  'metrics: yes',
  'metricsAddress: 127.0.0.1:19998',
  'playback: yes',
  'playbackAddress: 127.0.0.1:19996',
  'rtsp: yes',
  'rtspAddress: :18554',
  'rtspTransports: [tcp]',
  'rtmp: yes',
  'rtmpAddress: :11935',
  'hls: yes',
  'hlsAddress: :18888',
  'webrtc: yes',
  'webrtcAddress: :18889',
  'webrtcLocalUDPAddress: :18189',
  'webrtcLocalTCPAddress: ""',
  'webrtcIPsFromInterfaces: true',
  `webrtcAdditionalHosts: ${JSON.stringify(initialAdditionalHosts)}`,
  'srt: yes',
  'srtAddress: :18890',
  'moq: no',
  'pathDefaults:',
  '  record: no',
  `  recordPath: ${JSON.stringify(path.join(recordingPath, '%path', '%Y', '%m', '%d', '%Y-%m-%d_%H-%M-%S-%f'))}`,
  '  recordFormat: fmp4',
  '  recordPartDuration: 1s',
  '  recordMaxPartSize: 50M',
  '  recordSegmentDuration: 5m',
  '  recordDeleteAfter: 0s',
  'paths: {}',
  ''
].join('\n');

try {
  await readFile(configPath);
} catch {
  await writeFile(configPath, initialConfig, { encoding: 'utf8', mode: 0o600 });
}

if (process.argv.includes('--write-config-only')) {
  console.log(`[mediamtx] Konfigurasi siap di ${path.relative(rootDir, configPath)}`);
  process.exit(0);
}

const child = spawn(executable, [configPath], { cwd: rootDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
const redact = (value) => value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@');
// Stdout/stderr ikut diredaksi karena di Docker keduanya tersimpan di `docker logs`.
const tee = (chunk, level, destination) => {
  const text = redact(chunk.toString('utf8'));
  destination.write(text);
  for (const message of text.split(/\r?\n/).filter(Boolean)) {
    logStream.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: 'MEDIAMTX',
      message
    })}\n`);
  }
};
child.stdout.on('data', (chunk) => tee(chunk, 'info', process.stdout));
child.stderr.on('data', (chunk) => tee(chunk, 'error', process.stderr));
// Wrapper ini hanya boleh berhenti bersama MediaMTX: sinyal stop diteruskan ke binary, lalu exit
// code binary dipakai sebagai exit code wrapper (dibaca supervisor container dan concurrently).
let forwardedSignal = null;
const forward = (signal) => {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  forwardedSignal = signal;
  child.kill(signal);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  logStream.end(() => process.exit(process.exitCode ?? 0));
};
child.once('error', (error) => {
  console.error(`[mediamtx] Gagal dijalankan: ${error.message}`);
  process.exitCode = 1;
  finish();
});
child.once('exit', (code, signal) => {
  if (signal) console.log(`[mediamtx] Berhenti karena ${signal}`);
  // Berhenti karena sinyal yang diteruskan = shutdown normal; sinyal lain (mis. SIGKILL OOM) = crash.
  process.exitCode = code ?? (signal === forwardedSignal ? 0 : 128 + (os.constants.signals[signal] ?? 0));
  // Proses hook recording dapat masih memegang pipe stdout; jangan tunggu 'close' terlalu lama.
  setTimeout(finish, 2000).unref();
});
child.once('close', finish);
