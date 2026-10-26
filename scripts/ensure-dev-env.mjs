#!/usr/bin/env node
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(rootDir, '.env');

if (process.env.NODE_ENV === 'production') {
  try { await stat(envPath); } catch { throw new Error('File .env wajib dibuat manual untuk production; gunakan .env.example sebagai template.'); }
  process.exit(0);
}

const generatedPasswords = [];
const createPassword = (role) => {
  const password = randomBytes(18).toString('base64url');
  generatedPasswords.push({ role, password });
  return password;
};

try {
  await stat(envPath);
  const existing = await readFile(envPath, 'utf8');
  const missingLines = [];
  for (const role of ['OPERATOR']) {
    if (!new RegExp(`^${role}_PASSWORD=`, 'm').test(existing)) {
      missingLines.push(`${role}_PASSWORD=${createPassword(role.toLowerCase())}`);
    }
  }
  const mediaDefaults = [
    'MEDIAMTX_ENABLED=true',
    'MEDIAMTX_VERSION=v1.19.2',
    'MEDIAMTX_CONFIG_PATH=data/mediamtx/mediamtx.yml',
    'MEDIAMTX_READY_TIMEOUT_MS=15000',
    'RECORDING_PATH=data/recordings',
    'STREAM_VIEW_ALLOWED_ORIGINS=',
    'STREAM_VIEW_ALLOW_INSECURE_HTTP=false'
  ];
  for (const line of mediaDefaults) {
    const key = line.slice(0, line.indexOf('='));
    if (!new RegExp(`^${key}=`, 'm').test(existing)) missingLines.push(line);
  }
  if (missingLines.length) {
    await writeFile(envPath, `${existing.trimEnd()}\n${missingLines.join('\n')}\n`, 'utf8');
    await chmod(envPath, 0o600).catch(() => undefined);
    console.log('[dev] Konfigurasi development yang belum ada ditambahkan ke .env.');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  const authSecret = randomBytes(32).toString('base64url');
  const encryptionKey = randomBytes(32).toString('base64url');
  const adminPassword = createPassword('admin');
  const operatorPassword = createPassword('operator');
  const content = [
    'NODE_ENV=development',
    'PORT=3000',
    'WEB_PORT=5173',
    'HOST=127.0.0.1',
    'DATABASE_URL=file:../data/stream-router.db',
    'FFMPEG_PATH=ffmpeg',
    'MEDIAMTX_ENABLED=true',
    'MEDIAMTX_VERSION=v1.19.2',
    'MEDIAMTX_CONFIG_PATH=data/mediamtx/mediamtx.yml',
    'MEDIAMTX_READY_TIMEOUT_MS=15000',
    'RECORDING_PATH=data/recordings',
    `AUTH_SECRET=${authSecret}`,
    `APP_ENCRYPTION_KEY=${encryptionKey}`,
    'ADMIN_USERNAME=admin',
    `ADMIN_PASSWORD=${adminPassword}`,
    `OPERATOR_PASSWORD=${operatorPassword}`,
    'LOG_LEVEL=info',
    'MAX_WORKERS=10',
    'DEFAULT_RETRY_INITIAL_DELAY_MS=2000',
    'DEFAULT_RETRY_MAX_DELAY_MS=60000',
    'DEFAULT_MAX_RETRIES=10',
    'FFMPEG_STOP_TIMEOUT_MS=10000',
    'LOG_RETENTION_DAYS=7',
    'MAX_LOG_LINES_PER_ROUTE=5000',
    'CORS_ORIGIN=http://localhost:5173',
    'PUBLIC_APP_NAME=Camera Integration',
    'TRUST_PROXY=false',
    'WEBRTC_ALLOWED_ORIGINS=',
    'STREAM_VIEW_ALLOWED_ORIGINS=',
    'STREAM_VIEW_ALLOW_INSECURE_HTTP=false',
    ''
  ].join('\n');
  await writeFile(envPath, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => undefined);
  console.log('[dev] File .env development dibuat dengan secret acak.');
}

for (const { role, password } of generatedPasswords) {
  console.log(`[dev] Password awal ${role}: ${password}`);
}
if (generatedPasswords.length) console.log('[dev] Simpan password ini dengan aman; .env tidak pernah ditimpa otomatis.');
