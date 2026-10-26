# Camera Integration

Camera Integration adalah control plane kamera single-server dengan topologi **Kamera → MediaMTX → WebRTC/recording lokal → FFmpeg relay online → VPS**. MediaMTX menarik setiap kamera satu kali; FFmpeg hanya menangani tujuan online.

## Fitur

- Dashboard React responsive dengan status real-time SSE dan fallback polling.
- CRUD route, start, stop, restart, enabled, dan auto-start.
- Input RTSP/RTMP dan multi-output RTMP/RTMPS.
- Mode video online `COPY` atau H.264 dan audio online independen `COPY`, `AAC`, atau `OPUS`.
- Retry exponential backoff + jitter. Source MediaMTX yang belum READY dicoba terus sampai pulih, sedangkan crash relay FFmpeg tetap memakai circuit breaker.
- Deteksi capability timeout FFmpeg lintas build dengan fallback `rw_timeout` → RTSP `timeout` → tanpa timeout CLI.
- Authentication tiga role, session cookie HTTP-only, rate limit, dan origin check.
- Akses berbasis role: admin (penuh), operator (monitor dan kontrol worker/PTZ), dan viewer tanpa password (monitor WebRTC read-only tanpa PTZ).
- Halaman **Stream Router** untuk konfigurasi relay dan **Stream View** untuk IFRAME, WHEP, YouTube, HLS, MJPEG, serta MP4.
- Stream View berdiri sendiri dan tidak memerlukan Stream Route atau worker FFmpeg.
- Viewer grid 1/2/4/8 layar, tombol buka stream di tab baru, serta mode fullscreen yang dapat ditutup dengan `Esc`.
- Kontrol PTZ floating dengan gerakan tahan-tekan, pengulangan 500 ms, stop otomatis saat dilepas, dan dead-man stop di backend.
- PTZ per Stream Router maupun Stream View melalui ONVIF atau MQTT/MQTTS/WebSocket; dukungan zoom dapat diaktifkan per kamera.
- Status PTZ membedakan konfigurasi dari koneksi nyata: belum diuji, menghubungkan, terkoneksi, terputus, atau gagal. Tombol **Simpan & Tes Koneksi** melakukan handshake credential ke perangkat/broker.
- Sidebar dapat disembunyikan untuk memperluas area monitoring.
- Terminal log live per Stream Route serta indikator System Health hijau/oranye/merah.
- URL stream terenkripsi AES-256-GCM dalam SQLite.
- Credential selalu di-mask pada API/UI dan di-redact sebelum log ditulis.
- Log FFmpeg per route, pagination, pembatasan ukuran, dan retensi.
- SQLite + Prisma migration, audit log, health/readiness endpoint.
- MediaMTX `v1.19.2` terpin, bootstrap checksum-verified untuk macOS/Linux `arm64` dan `amd64`.
- WebRTC lokal, local-first/online fallback per tile, deteksi codec browser, serta pilihan audio COPY atau Opus per route.
- Continuous recording crash-safe fMP4, kalender timezone-aware, player inline dengan timestamp/screenshot/fullscreen, MP4 playback/download, proteksi, retensi, scanner recovery, dan storage guard dengan hysteresis.
- PM2 untuk control plane dan systemd non-root untuk MediaMTX; FFmpeg tidak dijalankan sebagai aplikasi PM2 terpisah.
- Unit test, integration test dengan fake FFmpeg, dan smoke test FFmpeg lokal.

## Arsitektur

```text
React/Vite Dashboard
        │ REST + SSE
        ▼
Fastify API
 ├─ Auth / Session
 ├─ Route Service + Prisma
 ├─ MediaMTX Runtime + Recording Manager
 ├─ Worker Manager (relay online)
 ├─ Log Store
 ├─ Settings / Health
 └─ Event Bus
        ├──────────────► MediaMTX shared service
        │                 ├─ satu ingest per kamera
        │                 ├─ WebRTC lokal
        │                 └─ fMP4 recording/playback
        │
        └─ child_process.spawn(shell:false)
                 ▼
          FFmpeg online per route
                 ├─ input RTSP MediaMTX localhost
                 └─ RTMP/RTMPS output(s)
```

## Persyaratan

- macOS atau Linux `arm64`/`amd64`. Production disarankan Ubuntu 22.04/24.04 atau Debian 12/13.
- Node.js 20 LTS atau lebih baru.
- npm 10 (disertakan bersama Node.js 20+).
- FFmpeg dengan encoder `libx264`, `aac`, dan `libopus` bila mode terkait digunakan.
- PM2 untuk production.
- Ruang recording lokal atau NAS yang sudah di-mount sebagai filesystem.

## Instalasi cepat development

```bash
npm install
npm run dev
```

Pada first run development, `npm run dev` membuat `.env` dengan secret acak, mengunduh MediaMTX resmi sesuai OS/arsitektur, memverifikasi SHA-256, menjalankan migration, lalu memulai MediaMTX, API, dan Vite tanpa `sudo`. Viewer dapat masuk tanpa password. File `.env` yang sudah ada hanya dilengkapi key development yang belum tersedia; secret tidak ditimpa.

Perintah development juga menjalankan seluruh SQL migration yang tersedia sebelum API dimulai. Untuk host baru/production, salin `.env.example`, isi seluruh secret, lalu jalankan `npm run prisma:deploy` sebelum memulai aplikasi. Perintah tersebut memakai runner Node lintas platform dan mencatat migration yang sudah diterapkan di database.

Buka `http://localhost:5173`. Port aktual mengikuti `WEB_PORT`; proxy Vite otomatis mengikuti `HOST` dan `PORT` API dari `.env`.

> Jangan memakai nilai secret contoh. `APP_ENCRYPTION_KEY` harus tetap sama setelah route dibuat; mengganti key langsung membuat URL lama tidak dapat didekripsi. Untuk rotasi, gunakan `npm run secrets:reencrypt` sesuai [docs/SECURITY.md](docs/SECURITY.md#rotasi-key).

Daftar lengkap perintah, quick start, pembuatan secret, reset password, migration, MediaMTX, testing, dan alur production tersedia di [Panduan Perintah npm](docs/NPM_COMMANDS.md).

## Instalasi production dengan PM2

```bash
install -m 600 .env.example .env
npm run secrets:generate   # salin AUTH_SECRET dan APP_ENCRYPTION_KEY ke .env
nano .env                  # ADMIN_PASSWORD, OPERATOR_PASSWORD, CORS_ORIGIN=https://<domain dashboard>
mkdir -p data/logs backups
chmod 700 data backups

npm ci
npm run prisma:generate
npm run prisma:deploy
chmod 600 data/*.db
npm run media:ensure
npm run media:config
npm run build
npm run verify:env
npm run smoke
npm run verify:dist

npm run media:install-service
pm2 start ecosystem.config.cjs --env production
pm2 save
sudo env PATH="$PATH:$(dirname "$(command -v node)")" "$(command -v pm2)" startup systemd -u "$(id -un)" --hp "$HOME"
```

`pm2 startup` tanpa `sudo` hanya mencetak perintah; tanpa boot service PM2, setelah reboot tidak ada kamera yang di-ingest, direkam, atau direlay. Dashboard production dibuka melalui reverse proxy HTTPS (cookie login bersifat Secure); lihat [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Untuk deployment berikutnya gunakan lockfile npm yang disertakan:

```bash
npm ci
npm run prisma:deploy
npm run build
npm run verify:env
npm run verify:dist
pm2 reload ecosystem.config.cjs --env production
```

`verify:env` dan `verify:dist` mencegah `pm2 reload` mengganti proses yang berjalan dengan proses yang crash-loop karena `.env` ditolak atau build production tidak dapat dimuat.

Instalasi yang dibuat sebelum rilis ini wajib memperbarui virtual host nginx satu kali sebelum `pm2 reload`: tambahkan `proxy_set_header X-Forwarded-For $remote_addr;` pada kedua `location` yang di-proxy dan satu blok `location /internal/ { return 404; }`, lalu jalankan `sudo nginx -t && sudo systemctl reload nginx`. Tanpa langkah ini rate limit login masih dapat dilewati dengan memalsukan header `X-Forwarded-For`. Bila nginx berada di host lain, isi `TRUST_PROXY` dengan IP/CIDR proxy tersebut. Detail di [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#7-upgrade-dan-rollback).

Atau jalankan installer yang memvalidasi `.env`, menerapkan permission, memasang service MediaMTX dan boot service PM2, lalu menunggu `/api/ready`:

```bash
./scripts/install-production.sh
# user service tanpa sudo: ./scripts/install-production.sh --skip-system
```

## Docker dan Windows

Image `ghcr.io/sanadunt/stream-router` (`linux/amd64`, `linux/arm64`) menjalankan dashboard + API, MediaMTX, dan FFmpeg dalam satu container dengan volume `/app/data` (database, log, secret otomatis) dan `/recordings`. Setiap tag `vX.Y.Z` di GitHub menghasilkan GitHub Release berisi `stream-router-docker-<versi>.zip` (compose, template `.env`, script Windows), image `amd64` untuk instalasi offline, dan `SHA256SUMS.txt`.

Windows 10/11 dengan Docker Desktop (WSL2), dari folder hasil ekstrak zip release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1
```

Script memeriksa Docker Desktop, membatasi izin folder instalasi ke akun Anda, membuat `.env`, mendeteksi IP LAN Windows untuk WebRTC, meminta password tanpa menampilkannya, lalu menjalankan container. Dashboard dibuka dari host lain di `http://<HOST_LAN_IP>:3000`; akses lewat IP dan `localhost` selalu diterima, sedangkan nama host lain (mis. nama komputer) perlu ditambahkan ke `ALLOWED_HOSTS` di `.env`. Bind mount recording ditulis di `docker-compose.override.yml`, bukan di `docker-compose.yml` yang ditimpa setiap update. Panduan lengkap (firewall termasuk rule Block *Docker Desktop Backend*, recording di folder Windows, update, backup, batasan Docker Desktop): [docs/WINDOWS.md](docs/WINDOWS.md).

Linux/macOS dan build image lokal: [docs/DOCKER.md](docs/DOCKER.md).

```bash
cp .env.example .env   # di folder bundle release; isi ADMIN_PASSWORD, OPERATOR_PASSWORD, HOST_LAN_IP
docker compose pull
docker compose up -d
```

## Environment wajib

| Variable | Fungsi |
|---|---|
| `DATABASE_URL` | Lokasi database SQLite. |
| `FFMPEG_PATH` | Path binary FFmpeg. |
| `MEDIAMTX_ENABLED` | Mengaktifkan dependency media lokal. |
| `MEDIAMTX_VERSION` | Versi binary yang dipin; default `v1.19.2`. |
| `MEDIAMTX_CONFIG_PATH` | Lokasi YAML global hasil generate atomik. |
| `MEDIAMTX_READY_TIMEOUT_MS` | Batas tunggu setiap percobaan ingest sebelum masuk retry; default 15 detik. |
| `RECORDING_PATH` | Root recording aktif; path lama tetap dicatat per segment. |
| `AUTH_SECRET` | HMAC session, minimal 32 karakter. |
| `APP_ENCRYPTION_KEY` | Key enkripsi URL, minimal 32 karakter dan harus persisten. |
| `ADMIN_USERNAME` | Username awal. |
| `ADMIN_PASSWORD` | Password awal; di-hash bcrypt saat bootstrap pertama. |
| `OPERATOR_PASSWORD` | Password awal role operator; di-hash bcrypt saat bootstrap pertama. |
| `CORS_ORIGIN` | Origin dashboard yang diperbolehkan. |
| `WEBRTC_ALLOWED_ORIGINS` | Allowlist origin fallback WebRTC lama. |
| `STREAM_VIEW_ALLOWED_ORIGINS` | Allowlist origin Stream View; kosong memakai fallback WebRTC. |
| `STREAM_VIEW_ALLOW_INSECURE_HTTP` | Izinkan URL HTTP untuk LAN tepercaya pada production; development otomatis mengizinkannya. |
| `MAX_WORKERS` | Batas default worker aktif. |

Setelah bootstrap pertama, perubahan password admin/operator di `.env` tidak otomatis mengganti hash yang tersimpan. Administrator dapat mengganti password Administrator atau Operator melalui **Settings → Keamanan Akun**. Perubahan langsung aktif tanpa restart, disimpan sebagai hash bcrypt di database, dan mencabut seluruh sesi lama milik role yang diubah.

Untuk recovery atau sinkronisasi password langsung dari `.env`, gunakan salah satu perintah berikut. Password tidak diteruskan sebagai argumen command agar tidak tersimpan di shell history:

```bash
npm run auth:reset -- --role admin
npm run auth:reset -- --role operator
npm run auth:reset -- --role all
```

Perintah memperbarui hash role yang dipilih dan mencabut sesi lamanya tanpa me-restart API. Pastikan migration database sudah diterapkan dan `DATABASE_URL` mengarah ke database aplikasi yang benar.

## Menambahkan route

1. Login ke dashboard.
2. Pilih **Stream Router**, lalu klik **Tambah Route**.
3. Isi Camera ID stabil, nama, deskripsi, dan source kamera.
4. Atur **Local Media**, **Relay Online**, dan **Recording** secara terpisah. Output online hanya wajib ketika Relay Online aktif.
5. Pada Local Media, gunakan audio **COPY** bila codec kamera sudah kompatibel dengan browser atau **OPUS** untuk membuat path WebRTC turunan yang lebih kompatibel. Video tetap di-copy.
6. Untuk relay online, pilih video **Copy** atau **Transcode H.264**, lalu pilih audio **Copy**, **AAC**, atau **Opus** secara independen.
7. Aktifkan **Auto-start** untuk recovery setelah aplikasi restart.
8. Viewer route memakai WebRTC MediaMTX lokal terlebih dahulu dan dapat fallback ke link online. **Stream View** standalone tetap tersedia untuk URL eksternal dan tidak direkam.
9. Bila kamera mendukung PTZ, pilih **ONVIF** atau **MQTT** pada bagian Kontrol PTZ. Kamera ONVIF multi-channel dapat memakai **Media Profile Token** per kamera (misalnya `000` atau `100`); kosongkan untuk memakai profile default yang dideteksi perangkat. Password disimpan terenkripsi dan tidak ditampilkan kembali.

Pada tabel **Stream Router**, tombol **Inisiasi** mengaktifkan ingest MediaMTX. FFmpeg hanya dibuat bila Relay Online aktif. Switch Local, Recording, Online, dan PTZ memiliki status terpisah. Mematikan lifecycle menghentikan MediaMTX path, recording, bridge PTZ, dan FFmpeg online.

Mode audio COPY dapat gagal bila audio kamera berupa G.711/PCM atau codec lain yang tidak didukung container FLV. Gunakan AAC atau Opus sesuai kemampuan tujuan. Saat Opus dipilih local dan/atau online, MediaMTX memakai satu path `cameras/{cameraKey}/webrtc`; relay online melakukan audio-copy dari path tersebut sehingga transcode tidak digandakan per output. Tujuan RTMP harus mendukung enhanced RTMP/Opus dan tidak ada fallback AAC otomatis.

## ONVIF Camera Discovery

Panel **Settings → ONVIF Camera Discovery** hanya tersedia untuk Admin. **Scan Jaringan** memakai WS-Discovery multicast selama lima detik pada interface yang dipilih. Discovery hanya menjangkau segmen layer-2 yang mengizinkan UDP multicast `239.255.255.250:3702`; kamera lintas VLAN atau perangkat yang tidak merespons multicast dapat diperiksa melalui input IP/host, port, TLS, dan service path manual. Fitur ini tidak melakukan scan CIDR atau port sweep dan tidak memerlukan `sudo`, tetapi firewall macOS/Linux harus mengizinkan UDP discovery pada interface kamera.

Wizard memeriksa satu kamera pada satu waktu, membaca manufacturer/model serta semua Media Profile, lalu meminta Admin memilih satu profile—termasuk token multi-channel seperti `000` atau `100`. Credential ONVIF/RTSP tidak ditulis ke log atau hasil discovery. Route hasil import dibuat `enabled` tetapi tetap `STOPPED`, Local WebRTC aktif dengan audio COPY, sedangkan Recording, Relay Online, MQTT bridge, dan Auto-start tetap mati sampai diaktifkan secara sadar. Setelah review, buka **Stream Router** dan tekan **Inisiasi**.

## Stream View multi-type

Admin memilih tipe stream secara eksplisit; deteksi URL di form hanya memberi saran. HLS menggunakan dukungan native Safari atau `hls.js` di Chrome/Firefox, sedangkan MJPEG dan MP4 dimainkan langsung oleh browser. MP4 dapat memakai URL HTTP/HTTPS atau file pada filesystem server melalui pilihan **File Server**; Admin dapat mengetik path absolute atau memilihnya lewat browser file. File lokal disajikan lewat endpoint same-origin dengan HTTP Range agar seeking tetap berjalan, sedangkan path aslinya tidak dikirim ke Viewer. YouTube dinormalisasi ke embed privacy-enhanced. URL hanya boleh HTTP/HTTPS dan tidak boleh memuat username/password.

Karena media tidak diproxy API, server HLS harus mengizinkan CORS. Development otomatis menerima URL HTTP agar WebRTC/MJPEG/HLS LAN dapat ditambahkan. Pada production, HTTP memerlukan `STREAM_VIEW_ALLOW_INSECURE_HTTP=true`; deployment HTTPS tetap dapat memblokir sumber HTTP akibat mixed-content browser.

## API utama

```text
POST   /api/auth/login
PATCH  /api/auth/passwords/:role
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/routes
POST   /api/routes
GET    /api/routes/:id
PATCH  /api/routes/:id
DELETE /api/routes/:id
POST   /api/routes/:id/start
GET    /api/settings/onvif-discovery/interfaces
POST   /api/settings/onvif-discovery/scan
POST   /api/settings/onvif-discovery/inspect
POST   /api/settings/onvif-discovery/import
POST   /api/routes/:id/initialize
POST   /api/routes/:id/deinitialize
POST   /api/routes/:id/stop
POST   /api/routes/:id/restart
PUT    /api/routes/:id/features
GET    /api/routes/:id/logs
GET    /api/routes/:id/runs
GET    /api/routes/:id/ptz
PUT    /api/routes/:id/ptz
DELETE /api/routes/:id/ptz
POST   /api/routes/:id/ptz/test
GET    /api/viewer/routes
POST   /api/viewer/ptz/command
GET    /api/webrtc-streams
POST   /api/webrtc-streams
GET    /api/webrtc-streams/:id
PATCH  /api/webrtc-streams/:id
DELETE /api/webrtc-streams/:id
GET    /api/webrtc-streams/:id/ptz
PUT    /api/webrtc-streams/:id/ptz
DELETE /api/webrtc-streams/:id/ptz
POST   /api/webrtc-streams/:id/ptz/test
GET    /api/settings
PATCH  /api/settings
POST   /api/settings/mediamtx/test
POST   /api/settings/mediamtx/apply
GET    /api/recordings/calendar
GET    /api/recordings/timeline
GET    /api/recordings
GET    /api/recordings/storage
GET    /api/recordings/playback
GET    /api/recordings/download
GET    /api/recordings/bulk-download
POST   /api/recordings/bulk-delete
PATCH  /api/recordings/:id/protection
DELETE /api/recordings/:id
GET    /api/settings/storage/directories
POST   /api/settings/storage/validate
GET    /api/health
GET    /api/ready
GET    /api/events
```

## Test dan verifikasi

```bash
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
npm run smoke
npm run verify:source
npm run verify:dist
```

`npm run verify:dist` menjalankan build production yang sebenarnya (`apps/api/dist/server.js`, `NODE_ENV=production`, MediaMTX nonaktif, database sementara) sampai `/api/health` menjawab, lalu menghentikannya. Pemeriksaan lain tidak mengeksekusi `dist`, sehingga kegagalan resolusi modul Node ESM hanya tertangkap di sini.

`npm run smoke` menguji binary dari `FFMPEG_PATH` di `.env`: memastikan encoder `libx264`/`aac` dan protokol output `rtmp` tersedia, membuat video/audio lokal satu detik dengan `lavfi` lalu memuxnya ke FLV, serta memperingatkan bila `libopus` atau `rtmps` tidak tersedia. Test tidak memakai endpoint publik.

## Backup dan restore

Hentikan write sementara atau gunakan backup SQLite yang konsisten:

```bash
pm2 stop stream-router
cp data/stream-router.db backups/stream-router-$(date +%F-%H%M).db
pm2 start stream-router
```

Selama API berhenti, MediaMTX tetap meng-ingest dan merekam kamera tanpa retention dan storage guard; segment baru diindeks setelah API berjalan lagi. Bila volume recording juga harus diam, jalankan `sudo systemctl stop mediamtx` sebelum `pm2 stop` dan `sudo systemctl start mediamtx` sebelum `pm2 start` (lihat [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) bagian 8).

Restore:

```bash
pm2 stop stream-router
cp backups/stream-router-YYYY-MM-DD-HHMM.db data/stream-router.db
pm2 start stream-router
```

Simpan `.env`/encryption key secara terpisah dan aman. Backup database tanpa key tidak dapat membuka credential route. Database berisi indeks recording, bukan file media; backup volume recording dilakukan terpisah.

## Reverse proxy Nginx

Lihat [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). SSE memerlukan buffering dimatikan pada `/api/events`.

## Payload PTZ MQTT

Tombol arah mengirim `move` dengan `direction` berupa `left`, `up`, `right`, atau `down`. Tombol zoom memakai `direction: "null"`; zoom masuk memakai speed positif dan zoom keluar memakai speed negatif:

```json
{"type":"move","direction":"left","speed":0.4,"durationMs":0}
{"type":"zoom","direction":"null","speed":0.4,"durationMs":0}
{"type":"zoom","direction":"null","speed":-0.4,"durationMs":0}
{"type":"stop","direction":"stop","speed":0.4,"durationMs":0}
```

## MediaMTX dan recording

Port default proyek adalah RTMP `11935`, RTSP `18554`, HLS `18888`, WebRTC `18889`, ICE/UDP `18189`, SRT `18890`, playback `19996`, Control API `19997`, dan metrics `19998`. Control API, playback, dan metrics bind ke localhost. RTSP server dipaksa TCP agar port RTP default `8000/8001` tidak terbuka; MoQ juga dinonaktifkan.

MediaMTX mensyaratkan token `%path` pada pola recording. Karena path ingest bernama `cameras/{cameraKey}`, file native berada di `recordings/cameras/{cameraKey}/YYYY/MM/DD/...`; API menormalisasikannya ke Camera ID saat indexing. Detail bootstrap, systemd, firewall, mount storage, upgrade, dan recovery ada di [docs/MEDIAMTX_RECORDING.md](docs/MEDIAMTX_RECORDING.md).

Retention dapat ditentukan secara global di Settings lalu dioverride per kamera dengan mode **umur hari**, **kuota GB per Camera ID**, atau **hari/GB yang tercapai lebih dahulu**. Recording yang diproteksi tetap dihitung dalam kuota, tetapi tidak pernah dihapus otomatis.

Recording tetap fMP4 crash-safe dengan part 1 detik dan target rotasi file default 3600 detik. Durasi setiap file berasal dari hook MediaMTX atau verifikasi `ffprobe`, bukan dari target rotasi. Recording aktif tampil sebagai `REC` di kalender, timeline, dan tabel.

Halaman Recording menyediakan tooltip rentang jam pada timeline, pagination 5/10/20/50/100, checklist bulk ZIP/delete, serta player overlay dengan timestamp, screenshot, download, dan fullscreen. Viewer mendukung grid 1, 2, 4, atau maksimal 8 stream.

## Batasan versi ini

- Status ingest `READY` membuktikan MediaMTX menerima track kamera; status FFmpeg online tetap belum membuktikan VPS menayangkan output.
- Satu proses FFmpeg menangani semua output dalam sebuah route. Gangguan satu output dapat memengaruhi keseluruhan proses.
- Recording bersifat kontinu; belum ada jadwal, motion detection, event recording, object storage, atau custom CA.
- Audio kamera yang tidak kompatibel WebRTC dapat dipilih untuk ditranscode ke Opus per route; video tidak otomatis ditranscode. Recording dan relay tetap memakai source asli.
- Ketersediaan fitur ONVIF bergantung pada dukungan profile PTZ kamera. Media Profile Token opsional diterapkan pada command move, zoom, stop, dead-man stop, dan shutdown; tes koneksi menolak token yang tidak terdaftar pada kamera. Mode MQTT hanya mengirim payload kontrol ke topic `<topicRoot>/<cameraId>`; penerjemahan payload ke perangkat menjadi tanggung jawab consumer MQTT.
- Belum ada manajemen akun dinamis, PostgreSQL, multi-node, atau notifikasi.
- Private IP sengaja diizinkan untuk kamera lokal. Operator bertanggung jawab membatasi jaringan tujuan melalui firewall dan kebijakan deny-host.

## Struktur penting

```text
apps/api/                 Fastify, Prisma, auth, worker supervisor
apps/web/                 React/Vite dashboard
packages/contracts/       DTO dan Zod schema
packages/ffmpeg/          command builder dan redaction
prisma/                   schema dan migration
scripts/                  install, smoke test, source verification
docs/                     deployment, security, troubleshooting, spesifikasi sumber
```
