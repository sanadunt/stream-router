#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
// Folder titik (.git, .claude/worktrees, .runtime, .playback-cache) dapat berisi salinan
// checkout lain; token kontrak tidak boleh terpenuhi oleh kode di luar checkout ini.
const skippedDirectories = new Set(['node_modules', 'dist', 'data', 'coverage']);

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || skippedDirectories.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(full)); else if (entry.isFile()) result.push(full);
  }
  return result;
}

const codeFiles = (await files(root)).filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && path.resolve(file) !== self);
const sources = new Map(await Promise.all(codeFiles.map(async (file) => [path.relative(root, file).split(path.sep).join('/'), await readFile(file, 'utf8')])));

// Setiap token wajib berada di modul yang memang menjalankan kontraknya, bukan sekadar di mana saja.
const required = [
  { token: '/api/auth/login', within: ['apps/api/src/modules/auth/'] },
  { token: '/api/routes/:id/start', within: ['apps/api/src/modules/routes/'] },
  { token: '/api/routes/:id/stop', within: ['apps/api/src/modules/routes/'] },
  { token: '/api/routes/:id/restart', within: ['apps/api/src/modules/routes/'] },
  { token: '/api/events', within: ['apps/api/src/modules/events/'] },
  { token: 'spawn(command.executable, command.args', within: ['apps/api/src/modules/workers/'] },
  { token: 'shell: false', within: ['apps/api/src/modules/workers/'] },
  { token: 'APP_ENCRYPTION_KEY', within: ['apps/api/src/config/'] },
  { token: 'autoStart', within: ['apps/api/src/modules/routes/'] },
  { token: 'RESTARTING', within: ['apps/api/src/modules/workers/'] },
  { token: 'redactedArgs', within: ['packages/ffmpeg/src/'] },
  { token: 'redactedArgs', within: ['apps/api/src/modules/workers/'] }
];
for (const { token, within } of required) {
  const found = [...sources].some(([file, source]) => within.some((prefix) => file.startsWith(prefix)) && source.includes(token));
  if (!found) throw new Error(`Verifikasi gagal, token tidak ditemukan: ${token} (di ${within.join(', ')})`);
}
for (const [file, source] of sources) {
  if (/shell\s*:\s*true/.test(source)) throw new Error(`Ditemukan shell: true di ${file}`);
  if (/\bexecSync\s*\(/.test(source)) throw new Error(`Ditemukan execSync di ${file}`);
  // onvif tidak memiliki peta "exports": Node ESM (dist production) menolak import direktori ini.
  if (file.startsWith('apps/api/src/') && /from\s+['"]onvif\/promises['"]/.test(source)) {
    throw new Error(`Import direktori 'onvif/promises' di ${file}; gunakan 'onvif/promises/index.js'`);
  }
}
console.log(`[verify] PASS: ${sources.size} file diperiksa; endpoint, spawn aman, enkripsi, SSE, retry, dan redaksi terdeteksi.`);
