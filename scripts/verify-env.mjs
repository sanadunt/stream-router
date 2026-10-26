#!/usr/bin/env node
// Memvalidasi .env dengan schema yang sama persis dengan API (apps/api/dist/config/env.js), agar
// nilai yang ditolak API (mis. TRUST_PROXY=2, CORS_ORIGIN=*, MEDIAMTX_ENABLED=enabled) ketahuan
// sebelum `pm2 reload` mengganti proses yang sedang berjalan dengan proses yang crash-loop.
// Jalankan setelah `npm run build`. Hanya nama field dan aturan yang dicetak, tidak pernah nilainya.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envModule = path.join(rootDir, 'apps/api/dist/config/env.js');

// Urutan pemuatan sama dengan apps/api/src/server.ts.
loadDotenv({ path: path.join(rootDir, '.env') });
loadDotenv();

if (!existsSync(envModule)) {
  console.error('[verify:env] apps/api/dist/config/env.js belum ada. Jalankan `npm run build` terlebih dahulu.');
  process.exit(1);
}

const { envSchema } = await import(pathToFileURL(envModule).href);
const result = envSchema.safeParse(process.env);
if (result.success) {
  console.log('[verify:env] PASS: .env diterima oleh validasi environment API.');
} else {
  console.error('[verify:env] .env ditolak validasi environment API; API akan berhenti saat startup:');
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '(root)';
    // Pesan enum Zod menyertakan nilai yang diterima; cetak pilihan yang valid saja.
    const rule = issue.code === 'invalid_enum_value' ? `gunakan salah satu: ${issue.options.join(', ')}` : issue.message;
    console.error(`  - ${field}: ${rule}`);
  }
  process.exitCode = 1;
}
