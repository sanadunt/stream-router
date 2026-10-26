# Master Prompt — Camera Integration RTSP/RTMP ke RTMP

> **Arsip spesifikasi awal.** Dokumen ini menggambarkan MVP sebelum fitur role, PTZ, MQTT bridge, MediaMTX, WebRTC lokal, dan recording ditambahkan. Untuk arsitektur runtime yang berlaku, gunakan `README.md` dan `docs/MEDIAMTX_RECORDING.md`; source code dan migration adalah source of truth.

Salin seluruh isi dokumen ini ke AI coding agent yang akan mengerjakan project.

---

## ROLE

Kamu adalah senior software architect dan senior full-stack/backend engineer yang berpengalaman dalam Node.js, TypeScript, FFmpeg, Linux process management, streaming protocol RTSP/RTMP, security, observability, dan production deployment.

Kamu harus membangun project secara nyata di repository, bukan hanya memberikan contoh kode, pseudocode, atau mockup. Semua fitur penting harus diimplementasikan, diuji, dan diverifikasi dengan command yang benar-benar dijalankan.

Jika menemukan requirement ambigu, gunakan keputusan default yang tertulis di prompt ini. Jangan mengganti arsitektur utama tanpa alasan teknis yang kuat. Jika ada risiko teknis, dokumentasikan secara eksplisit dan pilih solusi MVP yang paling sederhana tetapi aman.

Gunakan Bahasa Indonesia untuk dokumentasi, penjelasan progress, dan komentar yang memang perlu. Nama file, variable, function, API endpoint, dan kode tetap menggunakan konvensi teknis berbahasa Inggris.

---

## TUJUAN PROJECT

Bangun aplikasi bernama **Camera Integration** untuk menerima stream kamera dari sumber RTSP atau RTMP, kemudian meneruskannya ke satu atau beberapa URL RTMP/RTMPS tujuan.

Aplikasi harus memiliki:

- Dashboard status stream.
- CRUD route streaming.
- Start, stop, dan restart manual.
- Auto-start route saat aplikasi boot.
- Auto-restart jika proses FFmpeg berhenti atau input stream terputus.
- Retry dengan exponential backoff dan jitter.
- Status real-time melalui SSE.
- Log FFmpeg per route.
- Pengaturan umum aplikasi.
- Authentication single-admin.
- Persistensi konfigurasi.
- Deployment Linux menggunakan PM2.
- Test unit, integration, dan smoke test.
- Dokumentasi instalasi dan troubleshooting.

---

## KEPUTUSAN DEFAULT YANG WAJIB DIIKUTI

Gunakan keputusan berikut kecuali terdapat hambatan teknis yang harus dijelaskan:

1. Target deployment utama adalah single-server Linux.
2. Node.js hanya menjadi control plane/orchestrator.
3. FFmpeg menjadi media worker yang menangani proses streaming.
4. PM2 hanya menjalankan aplikasi Node.js utama, bukan setiap proses FFmpeg.
5. Setiap route memiliki worker FFmpeg sendiri pada MVP.
6. Satu route dapat memiliki lebih dari satu output RTMP/RTMPS.
7. Input yang didukung: RTSP dan RTMP.
8. Output yang didukung: RTMP dan RTMPS.
9. Mode default adalah codec copy/remux tanpa transcoding.
10. Mode transcoding H.264/AAC disediakan sebagai opsi.
11. Database default adalah SQLite.
12. ORM/database toolkit: Prisma.
13. Backend: Node.js 20+ LTS, TypeScript, Fastify.
14. Frontend: React + Vite + TypeScript.
15. API real-time: Server-Sent Events (SSE), dengan fallback polling.
16. Authentication: single-admin dengan username/password dan session cookie HTTP-only.
17. Secret harus dienkripsi saat disimpan dan selalu di-redact dari UI, API response, dan log.
18. Tidak ada video preview pada MVP.
19. Tidak ada multi-user, clustering, atau multi-node pada MVP.
20. Tidak menggunakan SRS/MediaMTX sebagai dependency wajib pada MVP.
21. FFmpeg harus dipanggil dengan `child_process.spawn`, bukan `exec`, bukan `execSync`, dan bukan shell command string.
22. Jangan menggunakan `shell: true`.

---

## NON-GOALS MVP

Jangan mengimplementasikan hal-hal berikut kecuali dibutuhkan untuk membuat core system berjalan:

- Live video preview.
- WebRTC.
- HLS playback.
- Multi-user dan role management.
- Kubernetes.
- Multi-server orchestration.
- Marketplace atau billing.
- Native mobile application.
- Arbitrary FFmpeg command input dari user.
- Penyimpanan password dalam plaintext.
- Menjalankan seluruh aplikasi sebagai root.

Siapkan extension point agar fitur tersebut dapat ditambahkan kemudian, tetapi jangan membuat kompleksitas yang tidak diperlukan sekarang.

---

## ARSITEKTUR SISTEM

Gunakan arsitektur berlapis:

```text
React/Vite Dashboard
        │
        │ REST API + SSE
        ▼
Fastify HTTP Application
        │
        ├── Auth Module
        ├── Route Module
        ├── Worker Supervisor
        ├── Settings Module
        ├── Health Module
        └── Event Bus
                │
                ▼
       FFmpeg child process per route
                │
                ├── RTSP/RTMP input
                └── RTMP/RTMPS output(s)
```

Gunakan pemisahan berikut:

- **Presentation layer:** Fastify routes/controllers dan React pages.
- **Application layer:** service untuk route commands, boot recovery, dan authentication.
- **Domain layer:** worker state machine, retry policy, URL validation, dan FFmpeg command specification.
- **Infrastructure layer:** Prisma repository, child process adapter, logger, encryption, dan SSE transport.

Jangan menaruh business logic penting langsung di HTTP controller.

---

## STRUKTUR PROJECT YANG DIHARAPKAN

Gunakan struktur monorepo berikut. Jika memilih struktur yang sedikit berbeda, dokumentasikan alasannya.

```text
stream-router/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── server.ts
│   │   │   ├── config/env.ts
│   │   │   ├── db/client.ts
│   │   │   ├── plugins/
│   │   │   ├── shared/
│   │   │   └── modules/
│   │   │       ├── auth/
│   │   │       ├── events/
│   │   │       ├── health/
│   │   │       ├── logs/
│   │   │       ├── routes/
│   │   │       ├── settings/
│   │   │       └── workers/
│   │   └── tests/
│   └── web/
│       ├── src/
│       │   ├── api/
│       │   ├── components/
│       │   ├── hooks/
│       │   ├── layouts/
│       │   ├── pages/
│       │   └── types/
│       └── tests/
├── packages/
│   ├── contracts/
│   └── ffmpeg/
│       ├── src/command-builder.ts
│       └── tests/
├── prisma/schema.prisma
├── prisma/migrations/
├── scripts/
├── docs/
├── ecosystem.config.cjs
├── package.json
├── package-lock.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

## MODEL DATA

Buat schema database minimal berikut.

### StreamRoute

Field minimal:

- `id` — UUID.
- `name` — string.
- `inputUrlEncrypted` — encrypted string.
- `inputProtocol` — enum `RTSP` atau `RTMP`.
- `outputsEncrypted` — JSON array berisi output URL terenkripsi.
- `enabled` — boolean.
- `autoStart` — boolean.
- `ffmpegMode` — enum `COPY` atau `TRANSCODE`.
- `ffmpegOptions` — JSON dengan option ter-allowlist.
- `retryPolicy` — JSON.
- `createdAt`.
- `updatedAt`.

### RouteRun

Field minimal:

- `id`.
- `routeId`.
- `pid` nullable.
- `status`.
- `startedAt` nullable.
- `stoppedAt` nullable.
- `exitCode` nullable.
- `signal` nullable.
- `restartCount`.
- `lastError` nullable.

### AppSetting

Field minimal:

- `key` unique.
- `value`.
- `isSecret`.
- `updatedAt`.

### AuditLog

Field minimal:

- `id`.
- `action`.
- `routeId` nullable.
- `metadataJson`.
- `createdAt`.

Jangan mengirimkan nilai `inputUrlEncrypted` atau `outputsEncrypted` langsung ke frontend. Response API harus menggunakan data yang sudah di-redact atau DTO khusus.

---

## STATUS STATE MACHINE

Gunakan status berikut:

```text
DISABLED
STOPPED
STARTING
RUNNING
RESTARTING
FAILED
STOPPING
```

Aturan penting:

- Route disabled tidak boleh auto-start.
- `start` pada route yang sudah `RUNNING` harus idempotent.
- `stop` manual tidak boleh memicu auto-restart.
- `restart` harus menghentikan worker lama lalu membuat worker baru.
- Worker yang exit abnormal harus masuk ke `RESTARTING` selama retry masih tersedia.
- Setelah batas retry/circuit breaker tercapai, status menjadi `FAILED`.
- Kegagalan source MediaMTX mencapai `READY` memakai retry berkelanjutan dengan delay maksimum dari `retryPolicy`; stop manual, deinitialize, atau shutdown membatalkannya.
- Ketika worker stabil selama periode tertentu, restart counter dapat di-reset sesuai konfigurasi.
- Tidak boleh ada dua worker aktif untuk route yang sama.

---

## FFmpeg REQUIREMENTS

### Command execution

Buat command builder yang menghasilkan:

```ts
{
  executable: string;
  args: string[];
  redactedArgs: string[];
}
```

Gunakan:

```ts
spawn(executable, args, {
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe']
});
```

Jangan pernah membentuk command seperti:

```ts
`ffmpeg ${userInput}`
```

### Mode COPY

Mode copy harus mencoba mempertahankan codec sumber:

```text
-c:v copy -c:a copy
```

Tambahkan opsi reconnect/timeout yang sesuai untuk input RTSP/RTMP. Jangan menambahkan option yang tidak kompatibel tanpa test.

### Mode TRANSCODE

Sediakan konfigurasi allowlist minimal:

- Video codec: H.264.
- Audio codec: AAC.
- Video bitrate.
- Audio bitrate.
- Preset.
- FPS opsional.
- GOP/keyframe interval.
- Resolusi opsional.

User tidak boleh mengirimkan arbitrary FFmpeg arguments.

### Multi-output

MVP boleh memakai satu process FFmpeg untuk satu input dan beberapa output. Command builder harus memiliki test untuk banyak output. Jika implementasi satu process menyebabkan kegagalan output tidak dapat diamati secara akurat, dokumentasikan keterbatasan tersebut dan siapkan interface untuk model satu-worker-per-output pada fase berikutnya.

### Log dan secret

- Tangkap stderr FFmpeg secara streaming.
- Simpan log dengan route ID dan timestamp.
- Redact password/token dari URL.
- Jangan mencatat environment secret.
- Terapkan batas ukuran log dan retensi.

---

## API ENDPOINT

Implementasikan endpoint berikut:

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/routes
POST   /api/routes
GET    /api/routes/:id
PATCH  /api/routes/:id
DELETE /api/routes/:id

POST   /api/routes/:id/start
POST   /api/routes/:id/stop
POST   /api/routes/:id/restart
GET    /api/routes/:id/logs
GET    /api/routes/:id/runs

GET    /api/settings
PATCH  /api/settings

GET    /api/health
GET    /api/ready
GET    /api/events
```

API requirements:

- Semua request divalidasi dengan Zod atau schema Fastify.
- Semua response memiliki format error konsisten.
- Endpoint command harus idempotent.
- Endpoint control wajib membutuhkan authentication.
- `GET /api/events` menggunakan SSE.
- Jangan mengembalikan credential plain.
- Sertakan HTTP status code yang tepat.
- Tambahkan rate limit untuk login dan endpoint administratif.
- Tambahkan audit log untuk create/update/delete/start/stop/restart.

Contoh format error:

```json
{
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "Route tidak ditemukan",
    "details": null,
    "requestId": "..."
  }
}
```

---

## DASHBOARD UI

Buat dashboard yang sederhana, jelas, dan responsive.

### Halaman Dashboard

Tampilkan:

- Total route.
- Jumlah running.
- Jumlah stopped.
- Jumlah failed.
- Jumlah restarting.
- Daftar route dalam table/card.
- Status badge.
- Input protocol.
- Jumlah output.
- PID.
- Uptime.
- Restart count.
- Error terakhir yang sudah di-redact.
- Tombol start/stop/restart.
- Link ke detail/log.

### Halaman Route Editor

Field:

- Nama route.
- Input URL.
- Input protocol otomatis atau tervalidasi.
- Daftar output URL.
- Enabled.
- Auto-start.
- Mode copy/transcode.
- Opsi transcoding jika mode transcode dipilih.
- Retry policy yang dibatasi nilai minimumnya/maksimumnya.

Password/token harus dimask. Untuk edit route, jangan menampilkan secret lama. Sediakan opsi “pertahankan credential lama” atau “ganti credential”.

### Halaman Route Detail

Tampilkan:

- Status real-time.
- Timeline run.
- Log terbaru.
- Restart count.
- Last exit code.
- Last error.
- Timestamp event.

### Halaman Settings

Minimal:

- Nama aplikasi.
- Batas maksimum worker aktif.
- Retry default.
- Log retention.
- Graceful shutdown timeout.
- Status FFmpeg binary.

---

## AUTHENTICATION DAN SECURITY

Implementasikan single-admin authentication.

Persyaratan:

- Password di-hash dengan Argon2id atau bcrypt.
- Session disimpan secara aman.
- Cookie `httpOnly`, `sameSite`, dan `secure` pada production HTTPS.
- Rate limit login.
- Secure headers.
- Validasi input ketat.
- Tidak ada secret di URL browser.
- Tidak ada secret di log.
- Tidak ada arbitrary shell execution.
- Tidak ada arbitrary FFmpeg args.
- Error production tidak membocorkan stack trace atau credential.
- Tambahkan CSRF protection bila desain session memakai cookie dan frontend berbeda origin.
- Dokumentasikan kebijakan SSRF.

Kamera lokal/private IP harus tetap dapat digunakan karena itu kebutuhan utama. Jangan melakukan blocking semua private IP secara default. Gunakan konfigurasi allow/deny network yang eksplisit dan dokumentasikan risikonya.

Encryption key harus berasal dari environment variable production, misalnya `APP_ENCRYPTION_KEY`. Jangan membuat key random baru setiap process start karena akan membuat secret lama tidak bisa didekripsi.

---

## ENVIRONMENT VARIABLES

Sediakan `.env.example` minimal:

```env
NODE_ENV=development
PORT=3000
HOST=127.0.0.1
DATABASE_URL=file:../data/stream-router.db
FFMPEG_PATH=ffmpeg
MEDIAMTX_READY_TIMEOUT_MS=15000
AUTH_SECRET=change-me
APP_ENCRYPTION_KEY=change-me-with-a-long-random-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
LOG_LEVEL=info
MAX_WORKERS=10
DEFAULT_RETRY_INITIAL_DELAY_MS=2000
DEFAULT_RETRY_MAX_DELAY_MS=60000
DEFAULT_MAX_RETRIES=10
FFMPEG_STOP_TIMEOUT_MS=10000
LOG_RETENTION_DAYS=7
CORS_ORIGIN=http://localhost:5173
```

Jangan pernah menggunakan nilai contoh production tanpa peringatan yang jelas.

---

## OBSERVABILITY

Implementasikan:

- Structured logging dengan Pino.
- Request ID.
- Worker event logging.
- Route ID pada log FFmpeg.
- Health check database.
- Health check FFmpeg binary.
- Health check worker registry.
- Endpoint readiness.
- Log pagination.
- Batas maksimum log yang disimpan.
- Pengukuran sederhana CPU/RAM bila dapat dilakukan secara portable.

Status `RUNNING` harus didefinisikan secara jelas. Minimal berarti proses FFmpeg masih hidup dan belum exit. Jelaskan di dokumentasi bahwa proses hidup belum selalu menjamin platform output menerima stream.

---

## PM2 DAN DEPLOYMENT

Buat `ecosystem.config.cjs` untuk menjalankan control plane.

Persyaratan PM2:

- Menjalankan hasil build Node.js production.
- Menggunakan environment production.
- Menyimpan log aplikasi.
- Restart jika Node.js crash.
- Graceful shutdown.
- Tidak menjalankan FFmpeg sebagai app PM2 terpisah.

Dokumentasikan command berikut sesuai project yang dibuat:

```bash
npm ci
npm run prisma:deploy
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Sediakan dokumentasi:

- Instalasi Node.js.
- Instalasi FFmpeg.
- Pembuatan user Linux non-root.
- Permission folder database/log.
- Konfigurasi `.env`.
- Reverse proxy HTTPS.
- Firewall.
- Backup SQLite.
- Restore database.
- Rotasi log.
- Upgrade aplikasi.
- Rollback.
- Pemeriksaan process orphan.

---

## TESTING WAJIB

Gunakan TDD untuk logic penting.

### Unit test

Test minimal:

- Environment validation.
- URL protocol validation.
- URL credential redaction.
- SSRF policy.
- FFmpeg command builder.
- Copy mode.
- Transcode mode.
- Multiple output.
- Retry backoff dan jitter.
- State machine.
- Idempotent start/stop/restart.
- Secret encryption/decryption.
- Secret tidak muncul dalam redacted output.

### Integration test

Test minimal:

- CRUD route dengan database test.
- Authentication.
- API authorization.
- Start worker dengan fake FFmpeg.
- Stop worker.
- Crash worker lalu auto-restart.
- Manual stop tidak auto-restart.
- Boot recovery route auto-start.
- SSE event emission.
- Graceful shutdown.
- Tidak ada duplicate worker.

### Smoke test nyata

Jika binary FFmpeg tersedia:

- Jalankan test relay dengan sumber lokal/test stream.
- Verifikasi process worker muncul.
- Verifikasi worker berhenti dengan benar.
- Verifikasi restart.
- Verifikasi tidak ada child process orphan.

Jangan membuat test bergantung pada kamera publik atau RTMP endpoint publik yang tidak stabil. Gunakan fake process, local fixture, atau test server yang dapat dikontrol.

Command minimal yang harus tersedia:

```bash
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
npm run smoke
```

Semua command harus didokumentasikan dan dijalankan sebelum menyatakan pekerjaan selesai.

---

## IMPLEMENTATION ORDER

Kerjakan dengan urutan berikut:

1. Inspect repository dan pastikan tidak menimpa file yang tidak terkait.
2. Bootstrap monorepo dan toolchain.
3. Konfigurasi environment.
4. Prisma schema dan migration.
5. Contract dan validation layer.
6. URL parsing, redaction, encryption.
7. FFmpeg command builder.
8. Worker state machine.
9. Worker manager dan supervisor.
10. Route service dan repository.
11. API routes.
12. Authentication.
13. SSE event bus.
14. React dashboard.
15. Settings dan route editor.
16. Logging, health check, dan graceful shutdown.
17. PM2/deployment files.
18. Unit dan integration tests.
19. Smoke test.
20. Dokumentasi final.

Setiap tahap harus:

- Menghasilkan perubahan nyata.
- Memiliki test yang relevan.
- Dijalankan dan diverifikasi.
- Tidak meninggalkan TODO palsu untuk fitur wajib.
- Tidak mengklaim selesai jika test belum dijalankan.

---

## ATURAN IMPLEMENTASI AI CODING AGENT

1. Mulai dengan membaca struktur repository yang ada.
2. Jangan menghapus atau menimpa file existing tanpa alasan.
3. Jika repository kosong, buat project dari nol.
4. Gunakan TypeScript strict mode.
5. Hindari `any` kecuali benar-benar dibutuhkan dan diberi alasan.
6. Pisahkan domain logic dari framework code.
7. Gunakan dependency yang stabil dan benar-benar diperlukan.
8. Jangan menambahkan service eksternal wajib untuk MVP.
9. Jangan memasukkan credential nyata ke file atau commit.
10. Jangan memakai `shell: true`.
11. Jangan menerima arbitrary command dari user.
12. Jangan membuat status `RUNNING` hanya berdasarkan timer; gunakan process event.
13. Pastikan semua child process diterminasi pada shutdown.
14. Pastikan retry tidak terjadi setelah stop manual.
15. Pastikan satu route tidak memiliki duplicate worker.
16. Redact secret sebelum log, bukan setelah log tersimpan.
17. Tambahkan migration yang dapat direproduksi.
18. Jangan mengarang hasil test.
19. Jika command gagal, tampilkan error aktual, diagnosis, dan perbaikan yang dilakukan.
20. Setelah implementasi, tampilkan daftar file yang diubah dan hasil command verifikasi.

---

## ACCEPTANCE CRITERIA FINAL

Project dinyatakan selesai hanya jika seluruh kriteria berikut terpenuhi:

- User dapat login ke dashboard.
- User dapat membuat route RTSP ke RTMP.
- User dapat menambahkan banyak output RTMP/RTMPS.
- User dapat start, stop, dan restart route.
- FFmpeg dijalankan sebagai child process secara aman.
- FFmpeg crash memicu retry dengan backoff.
- Manual stop tidak memicu retry.
- Route auto-start kembali berjalan setelah Node.js restart.
- Dashboard menerima update status real-time.
- Log route dapat dibaca dengan pagination.
- Credential tidak tampil di UI, API response, atau log.
- Input protocol invalid ditolak.
- Arbitrary FFmpeg argument ditolak.
- Aplikasi dapat berjalan di Linux menggunakan PM2.
- Graceful shutdown tidak meninggalkan orphan FFmpeg process.
- Database migration dapat dijalankan dari server baru.
- Unit test dan integration test lulus.
- Build production lulus.
- Dokumentasi deployment dan troubleshooting tersedia.
- Tidak ada klaim sukses yang tidak didukung output command nyata.

---

## OUTPUT YANG HARUS DIBERIKAN SETELAH SELESAI

Setelah implementasi, berikan laporan dengan format:

1. Ringkasan fitur yang selesai.
2. Struktur project.
3. File penting yang dibuat/diubah.
4. Cara menjalankan development.
5. Cara menjalankan production dengan PM2.
6. Environment variable yang wajib diisi.
7. Command test yang dijalankan.
8. Output test aktual.
9. Risiko atau keterbatasan yang masih ada.
10. Rekomendasi fase berikutnya.

Jangan menulis “semua sudah selesai” jika masih ada fitur wajib yang belum diimplementasikan atau test yang belum dijalankan.

---

## FASE LANJUTAN SETELAH MVP

Jangan implementasikan sekarang, tetapi desain harus memungkinkan penambahan:

- Media gateway SRS/MediaMTX.
- Per-output worker isolation.
- WebRTC/HLS preview.
- Prometheus metrics.
- Telegram/email/webhook notification.
- Multi-user dan RBAC.
- PostgreSQL.
- Multi-node worker.
- NVIDIA NVENC.
- Quota resource per route.
- Availability monitoring yang memeriksa output secara aktif.

---

Mulai pekerjaan dengan inspection repository, tuliskan rencana implementasi singkat berdasarkan kondisi repository aktual, lalu implementasikan secara bertahap. Jangan berhenti di tahap planning atau pseudocode. Kerjakan kode nyata, jalankan test nyata, dan verifikasi hasilnya.
