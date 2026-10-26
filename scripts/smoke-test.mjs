#!/usr/bin/env node
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Uji binary yang sama dengan API: FFMPEG_PATH dari .env, bukan sekadar `ffmpeg` pada PATH.
// Override ffmpegPath dari Settings (database) tidak ikut dibaca; uji path tersebut secara manual.
loadDotenv({ path: path.join(rootDir, '.env') });
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

function run(command, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Timeout: ${command}`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr }); else reject(new Error(`${command} exit ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function encoderNames(output) {
  const names = new Set();
  for (const line of output.split('\n')) {
    const match = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function outputProtocols(output) {
  const section = output.split(/^Output:\s*$/m)[1] ?? '';
  return new Set(section.split('\n').map((line) => line.trim()).filter(Boolean));
}

console.log(`[smoke] Memeriksa FFmpeg binary: ${ffmpeg}`);
const version = await run(ffmpeg, ['-hide_banner', '-version']);
console.log(`[smoke] ${version.stdout.split('\n')[0] || 'FFmpeg merespons.'}`);

const encoders = encoderNames((await run(ffmpeg, ['-hide_banner', '-encoders'])).stdout);
const protocols = outputProtocols((await run(ffmpeg, ['-hide_banner', '-protocols'])).stdout);
// libx264/aac dipakai mode TRANSCODE/AAC dan relay selalu menulis FLV ke rtmp://.
const missing = [
  ...['libx264', 'aac'].filter((name) => !encoders.has(name)).map((name) => `encoder ${name}`),
  ...['rtmp'].filter((name) => !protocols.has(name)).map((name) => `protokol output ${name}`)
];
if (missing.length) throw new Error(`FFmpeg ${ffmpeg} tidak mendukung: ${missing.join(', ')}`);
// Opus (audio WebRTC/online) dan rtmps:// opsional per route; aplikasi menolak mode tersebut bila tidak tersedia.
const optional = [
  ...(encoders.has('libopus') ? [] : ['encoder libopus (audio Opus lokal/online)']),
  ...(protocols.has('rtmps') ? [] : ['protokol rtmps (output RTMPS/TLS)'])
];
for (const item of optional) console.warn(`[smoke] PERINGATAN: FFmpeg tidak memiliki ${item}; route yang memakainya akan gagal.`);

console.log('[smoke] Membuat video test lokal 1 detik dan memuxnya ke FLV tanpa endpoint publik...');
await run(ffmpeg, [
  '-hide_banner', '-nostdin', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
  '-t', '1', '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-ar', '48000',
  '-f', 'flv', '-y', os.devNull
]);
if (encoders.has('libopus')) {
  await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-t', '1', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '2',
    '-f', 'null', '-'
  ]);
}

const tested = ['H.264/AAC ke FLV', encoders.has('libopus') ? 'encode Opus' : null].filter(Boolean).join(', ');
console.log(`[smoke] PASS: ${ffmpeg} berhasil ${tested}; protokol rtmp${protocols.has('rtmps') ? ' dan rtmps' : ''} tersedia.`);
