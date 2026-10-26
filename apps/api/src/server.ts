import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { FastifyInstance } from 'fastify';

// Muat .env dari root repo maupun cwd, agar dev (cwd=apps/api) dan production sama-sama bekerja.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, '../../../.env') });
loadDotenv();

import { redactText } from '@stream-router/ffmpeg';
import { buildApp } from './app.js';
import { EnvValidationError, getEnv } from './config/env.js';
import { prisma } from './db/client.js';
import { ensureRoleCredentials } from './modules/auth/auth-service.js';
import { cleanupOldLogs } from './modules/logs/log-store.js';
import { workerManager } from './modules/workers/worker-manager.js';
import { getSettings } from './modules/settings/settings-service.js';
import { startRecordingManager } from './modules/recordings/recording-service.js';

let app: FastifyInstance | undefined;
let closing = false;

function logBackgroundError(message: string, error: unknown): void {
  const detail = redactText(error instanceof Error ? error.stack ?? error.message : String(error));
  if (app) app.log.error({ detail }, message);
  else console.error(`[server] ${message}: ${detail}`);
}

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app?.log.info({ signal }, 'Graceful shutdown dimulai');
  await workerManager.shutdown();
  await app?.close();
  await prisma.$disconnect();
}

// Dipasang sebelum startup: bootRecovery dapat berjalan beberapa menit (15 detik per kamera
// offline), dan sinyal yang tiba saat itu tetap harus menghentikan worker secara graceful.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
      .catch((error: unknown) => logBackgroundError('Graceful shutdown gagal', error))
      .finally(() => process.exit());
  });
}

// Pengaman terakhir: satu promise fire-and-forget tanpa .catch tidak boleh mematikan seluruh
// relay, SSE, recording, dan PTZ. Penyebabnya tetap dicatat agar dapat diperbaiki.
process.on('unhandledRejection', (reason) => {
  logBackgroundError('Promise rejection tidak tertangani', reason);
});

try {
  const env = getEnv();
  app = await buildApp();
  await prisma.$connect();
  await ensureRoleCredentials();
  // Run tanpa stoppedAt berasal dari proses sebelumnya yang berhenti tanpa graceful shutdown;
  // tanpa ini run tersebut tampil aktif selamanya di Run Timeline.
  await prisma.routeRun.updateMany({
    where: { stoppedAt: null },
    data: { status: 'STOPPED', stoppedAt: new Date(), lastError: 'Run terputus karena proses API berhenti sebelum relay selesai' }
  });
  const settings = await getSettings();
  await cleanupOldLogs(Number(settings.logRetentionDays));
  setInterval(() => {
    void getSettings()
      .then((current) => cleanupOldLogs(Number(current.logRetentionDays)))
      .catch((error: unknown) => logBackgroundError('Cleanup log harian gagal', error));
  }, 24 * 60 * 60 * 1000).unref();
  await app.listen({ host: env.HOST, port: env.PORT });
  await startRecordingManager().catch((error: Error) => {
    app?.log.error({ err: error }, 'Recording manager gagal dimulai; control plane tetap berjalan');
  });
  await workerManager.bootRecovery();
  if (!closing) app.log.info({ host: env.HOST, port: env.PORT }, 'Camera Integration berjalan');
} catch (error) {
  if (closing) {
    // Startup dihentikan oleh sinyal shutdown; error dari koneksi yang ditutup bukan kegagalan startup.
  } else if (error instanceof EnvValidationError) {
    console.error(`[config] ${error.message}`);
    console.error('[config] Jalankan `npm run dev` dari root project untuk membuat konfigurasi development otomatis.');
  } else if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2021') {
    app?.log.fatal({ code: 'P2021' }, 'Schema database belum siap. Jalankan `npm run prisma:deploy` dari root project.');
  } else if (app) {
    app.log.fatal({ err: error }, 'Gagal menjalankan aplikasi');
  } else {
    console.error('[startup] Gagal menjalankan aplikasi:', error instanceof Error ? error.message : error);
  }
  if (!closing) process.exitCode = 1;
}
