# Docker

Panduan menjalankan Camera Integration (stream-router) dengan Docker di Linux dan macOS, membangun image lokal, serta membuat release GitHub. Untuk Windows (Docker Desktop + WSL2) ikuti [WINDOWS.md](WINDOWS.md); bagian volume, backup, dan rotasi secret di sana berlaku sama dengan sintaks PowerShell.

## Isi image

- Image: `ghcr.io/sanadunt/stream-router` untuk `linux/amd64` dan `linux/arm64`, tag `<versi>` (mis. `1.2.0`), `<major>.<minor>` (mis. `1.2`), dan `latest`.
- Basis `node:22-bookworm-slim` dengan FFmpeg Debian (`libx264`, `aac`, `libopus`), MediaMTX versi terpin yang diverifikasi SHA-256 saat build, `tini`, dan user non-root. Build gagal bila server production tidak dapat dijalankan (`node scripts/verify-dist.mjs`).
- Satu container, `tini` sebagai PID 1, menjalankan `scripts/container-supervisor.mjs` yang:
  1. membuat `AUTH_SECRET` dan `APP_ENCRYPTION_KEY` bila tidak diberikan, menyimpannya di `/app/data/secrets/stream-router.env` (folder 0700, file 0600), dan memakainya ulang pada start berikutnya;
  2. berhenti dengan pesan jelas bila `ADMIN_PASSWORD`/`OPERATOR_PASSWORD` kosong atau masih nilai contoh;
  3. menjalankan migration SQLite;
  4. mengawasi MediaMTX dan API secara terpisah: proses yang crash di-restart dengan backoff 1 → 30 detik tanpa me-restart proses lain;
  5. saat `docker stop`/`SIGTERM`, menghentikan API terlebih dahulu (maks. 20 detik), lalu MediaMTX, kemudian keluar dengan kode 0.
- FFmpeg relay online dijalankan API di dalam container yang sama. Berbeda dengan instalasi PM2 + systemd, menghentikan container juga menghentikan MediaMTX, sehingga kamera tidak di-ingest maupun direkam selama container berhenti.

## Persyaratan

- Linux: Docker Engine 24 atau lebih baru dengan plugin Compose v2 (`docker compose version`). macOS: Docker Desktop.
- CPU `amd64` atau `arm64`.
- IP LAN host yang tetap (reservasi DHCP atau IP statis) agar WebRTC dari host lain tetap berjalan.

## Quick start dari release

Unduh `stream-router-docker-<versi>.zip` dari halaman Releases GitHub, lalu ekstrak ke folder tetap yang juga menyimpan `.env`; saat update, timpa isi folder yang sama. Project Compose bernama `stream-router` dengan container `stream-router` dan volume bernama tetap, sehingga satu host menjalankan satu instalasi.

```bash
mkdir -p ~/stream-router
unzip stream-router-docker-<versi>.zip -d ~/stream-router
cd ~/stream-router
cp .env.example .env
chmod 600 .env
nano .env    # ADMIN_PASSWORD, OPERATOR_PASSWORD, HOST_LAN_IP, TZ
docker compose pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

Dashboard: `http://<HOST_LAN_IP>:3000`. Login Administrator memakai username `admin` dan `ADMIN_PASSWORD`; Viewer tanpa password.

Dashboard selalu dapat dibuka lewat alamat IP dan `localhost`. Nama host lain (mis. `http://kamera.lan:3000` atau nama komputer) ditolak `421 HOST_NOT_ALLOWED` sebagai perlindungan DNS rebinding sampai nama tersebut ditambahkan ke `ALLOWED_HOSTS` di `.env`. Hostname `CORS_ORIGIN` dan `HOST_LAN_IP` (bila berupa nama) juga diterima.

Mencari IPv4 LAN host:

```bash
# Linux: alamat sumber untuk default route
ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p'
# macOS: ganti en0 dengan interface yang aktif
ipconfig getifaddr en0
```

Nilai `.env` yang memuat `$`, `#`, atau spasi ditulis dalam kutip tunggal, mis. `ADMIN_PASSWORD='Rahasia#2024$'`; tanpa kutip, Compose menginterpolasi `$` dan memotong komentar `#`.

## Konfigurasi

### .env

Template: `.env.example` di bundle release (`docker/.env.example` di repository). Compose membaca `.env` untuk interpolasi dan meneruskannya ke container (`env_file`).

| Variable | Fungsi |
|---|---|
| `ADMIN_PASSWORD`, `OPERATOR_PASSWORD` | Password bootstrap, minimal 8 karakter; di-hash bcrypt saat database pertama kali dibuat. |
| `HOST_LAN_IP` | IPv4 LAN host. Diteruskan sebagai `MEDIAMTX_PUBLIC_HOST` untuk URL WebRTC dan kandidat ICE selama **Public host/IP** di Settings kosong. |
| `TZ` | Zona waktu container, default `Asia/Jakarta`. |
| `BIND_ADDRESS` | Alamat host untuk semua port yang dipublikasikan, default `0.0.0.0`. `127.0.0.1` membatasi akses ke host ini. |
| `ALLOWED_HOSTS` | Opsional. Nama host lain untuk membuka dashboard, dipisah koma tanpa skema dan port, mis. `ALLOWED_HOSTS=kamera.lan,PC-KAMERA`. IP dan `localhost` selalu diterima. Nilai yang tidak valid membuat API gagal start. |
| `STREAM_ROUTER_IMAGE` | Opsional; menimpa image, mis. `ghcr.io/sanadunt/stream-router:1.2.0` atau image build lokal. |
| `AUTH_SECRET`, `APP_ENCRYPTION_KEY` | Opsional. Kosongkan agar dibuat otomatis dan disimpan di volume data. Jangan diisi atau diubah setelah instalasi berjalan kecuali sebagai bagian dari [rotasi](#rotasi-secret-dan-password). |
| `PUBLIC_APP_NAME` | Nama aplikasi di dashboard. |
| `COOKIE_SECURE`, `TRUST_PROXY`, `CORS_ORIGIN` | Lanjutan; lihat tabel berikut dan [reverse proxy](#reverse-proxy-https). |

Variable API lain dari [README](../README.md#environment-wajib) (mis. `LOG_LEVEL`, `MAX_WORKERS`, `ADMIN_USERNAME`, `STREAM_VIEW_ALLOW_INSECURE_HTTP`) dapat ditambahkan ke `.env`. Terapkan perubahan dengan `docker compose up -d`.

### Default container

Ditetapkan di bagian `environment` `docker-compose.yml`, sehingga menimpa nilai yang sama di `.env` kecuali yang ditandai dapat diubah:

| Variable | Nilai | Catatan |
|---|---|---|
| `NODE_ENV` | `production` | Tetap. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Tetap; port dashboard yang dipublikasikan. |
| `DATABASE_URL` | `file:/app/data/stream-router.db` | Tetap; di volume data. |
| `MEDIAMTX_ENABLED` | `true` | Tetap. |
| `MEDIAMTX_CONFIG_PATH` | `data/mediamtx/mediamtx.yml` | Tetap; relatif ke `/app`, di volume data. |
| `RECORDING_PATH` | `/recordings` | Tetap; di volume recording. |
| `FFMPEG_PATH` | `ffmpeg` | Tetap; FFmpeg Debian di dalam image. |
| `MEDIAMTX_PUBLIC_HOST` | `HOST_LAN_IP` | Dari `.env`. Dipakai selama **Public host/IP** di Settings kosong; nilai yang diisi di Settings menang. Mengosongkan field lalu **Terapkan & Reload** kembali mengikuti `HOST_LAN_IP`. |
| `COOKIE_SECURE` | `auto` | Dapat diubah dari `.env`. Secure hanya bila request datang lewat HTTPS (menghormati `TRUST_PROXY`). |
| `TRUST_PROXY` | `false` | Dapat diubah dari `.env`; lihat [reverse proxy](#reverse-proxy-https). |
| `CORS_ORIGIN` | `http://localhost:3000` | Dapat diubah dari `.env`. Request same-origin (`http://<host>:3000`) tetap diterima. |
| `PUBLIC_APP_NAME`, `TZ` | `Camera Integration`, `Asia/Jakarta` | Dapat diubah dari `.env`. |

Jangan mengubah port MediaMTX di Settings → MediaMTX & Recording: port yang dipublikasikan di `docker-compose.yml` tetap. Jangan pula mengedit `docker-compose.yml`, karena file itu ditimpa setiap kali zip release baru diekstrak. Penyesuaian lain (mis. bind mount recording) ditulis di `docker-compose.override.yml` di samping `docker-compose.yml`; Compose membacanya otomatis dan file itu tidak ada di zip sehingga tetap ada setelah update.

## Port

| Port host | Fungsi |
|---|---|
| 3000/TCP | Dashboard + API |
| 18889/TCP | WebRTC (WHEP) |
| 18189/UDP | WebRTC ICE; wajib untuk WebRTC karena ICE lewat TCP nonaktif |
| 18554/TCP | RTSP MediaMTX |
| 18888/TCP | HLS MediaMTX |
| 11935/TCP | RTMP MediaMTX |
| 18890/UDP | SRT MediaMTX |

Semua port dipublikasikan di `${BIND_ADDRESS:-0.0.0.0}`. Control API (19997), playback (19996), dan metrics (19998) MediaMTX hanya bind ke `127.0.0.1` di dalam container dan tidak dipublikasikan.

**Firewall Linux**: port yang dipublikasikan Docker melewati aturan iptables Docker sendiri, sehingga rule `ufw`/`firewalld` biasa tidak membatasinya. Batasi lewat `BIND_ADDRESS`, rule di chain `DOCKER-USER`, atau firewall jaringan. Tutup port RTSP/HLS/RTMP/SRT dari LAN bila tidak dipakai.

## Volume dan path

| Volume | Path container | Isi |
|---|---|---|
| `stream-router-data` | `/app/data` | Database SQLite, `secrets/stream-router.env` (secret otomatis), `logs/` (log route dan `mediamtx.log`), `mediamtx/mediamtx.yml`, `backups/` (salinan sebelum rotasi key) |
| `stream-router-recordings` | `/recordings` | Segment recording fMP4 |

Kedua volume bernama tetap (tanpa prefix project), sehingga tidak bergantung pada nama folder instalasi. Lihat dengan `docker volume ls`.

Menyimpan recording di folder host (bind mount) dengan `docker-compose.override.yml`, bukan dengan mengedit `docker-compose.yml` (perubahan di sana hilang saat update):

```yaml
services:
  stream-router:
    volumes:
      - type: bind
        source: /srv/stream-router/recordings
        target: /recordings
```

Di Linux folder tersebut harus dapat ditulis user container (`node`, umumnya UID/GID 1000). Pastikan UID/GID-nya lalu sesuaikan pemilik folder:

```bash
docker compose run --rm --no-deps -T stream-router id
sudo mkdir -p /srv/stream-router/recordings
sudo chown <uid>:<gid> /srv/stream-router/recordings
sudo chmod 750 /srv/stream-router/recordings
docker compose up -d
```

Tentukan lokasi recording sebelum mulai merekam; mengganti mount tidak memindahkan file lama. Storage guard mengukur ruang kosong filesystem tempat `/recordings` berada. Di Docker Desktop (macOS/Windows) volume berada di disk virtual sehingga nilainya tidak mencerminkan sisa ruang disk fisik; gunakan retention kuota GB per kamera.

## Operasi harian

```bash
docker compose ps                         # status dan health
docker compose logs -f stream-router      # log supervisor, MediaMTX, dan API
docker compose restart stream-router
docker compose stop stream-router         # graceful: API lalu MediaMTX (stop_grace_period 30 detik)
docker compose exec stream-router sh      # shell sebagai user aplikasi
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q stream-router)"
```

Log route dan MediaMTX juga tersedia di halaman Terminal dashboard (file di `/app/data/logs`).

## Batasan

- **ONVIF Discovery**: WS-Discovery multicast dari network bridge container tidak menjangkau LAN, sehingga **Scan Jaringan** tidak menemukan kamera. Gunakan input IP/host dan port manual pada wizard. Host networking sengaja tidak dipakai.
- **IP klien di Docker Desktop** (macOS/Windows): koneksi umumnya terlihat berasal dari satu alamat gateway, sehingga rate limit login per IP berlaku bersama untuk semua klien. Login Viewer memakai batas terpisah dan browser yang pernah berhasil login sebagai Administrator/Operator memakai batas sendiri (cookie perangkat login), tetapi percobaan password dari browser lain tetap berbagi batas 5 per menit: perangkat mana pun di LAN dapat membuatnya dijawab `429 RATE_LIMITED`, sedangkan sesi yang sudah berjalan tidak terpengaruh (lihat [SECURITY.md](SECURITY.md)). Docker Engine Linux mempertahankan IP klien untuk koneksi dari LAN.
- Transcoding FFmpeg memakai CPU; akselerasi GPU tidak disediakan image.

## Update dan rollback

```bash
cd ~/stream-router
docker compose pull        # image baru diunduh selagi container lama tetap berjalan
# backup (bagian berikut), lalu:
docker compose up -d
docker compose ps
```

Untuk versi dari zip release baru, ekstrak menimpa folder yang sama (`.env` dan `docker-compose.override.yml` tidak tertimpa; perubahan pada `docker-compose.yml` hilang) lalu jalankan perintah di atas. Unduh atau muat image baru sebelum container dihentikan untuk backup, sehingga waktu henti tidak termasuk unduhan. Migration database berjalan otomatis saat container mulai. Untuk memakai tag tertentu tanpa zip baru, isi `STREAM_ROUTER_IMAGE` di `.env`.

Rollback: isi `STREAM_ROUTER_IMAGE` dengan tag versi sebelumnya lalu `docker compose up -d`. Migration tidak dapat dibatalkan, jadi pulihkan juga backup data dari sebelum update bila versi baru sudah berjalan. Image lama dapat dihapus dengan `docker image prune` setelah aplikasi terverifikasi.

Instalasi tanpa akses registry: halaman Release menyediakan image `amd64` hasil `docker save`, `stream-router-image-<versi>-linux-amd64.tar.gz`. Muat dengan `docker load -i stream-router-image-<versi>-linux-amd64.tar.gz` (tag hasil load sama dengan image di `docker-compose.yml` zip versi tersebut) sebagai pengganti `docker compose pull`, lalu backup dan `docker compose up -d`.

## Backup dan restore

Backup volume data berisi database dan secret otomatis (`APP_ENCRYPTION_KEY`); simpan terenkripsi dan terpisah dari host. Backup `.env` juga, dan volume recording bila file video perlu disimpan.

Perintah di bawah memakai image yang sedang dipakai container (`docker inspect`), bukan image di `docker-compose.yml`. Setelah zip versi baru diekstrak, `docker compose run` akan mencoba mengunduh image baru selama container berhenti, dan gagal tanpa akses registry. Arsip dialirkan lewat stdout tanpa TTY agar data biner tidak rusak, sehingga file backup dimiliki user host dan tidak bergantung pada UID container:

```bash
mkdir -p backups && chmod 700 backups
image="$(docker inspect --format '{{.Image}}' stream-router)"
docker compose stop stream-router
(umask 077 && docker run --rm --volumes-from stream-router "$image" tar -czf - -C /app/data . \
  > "backups/stream-router-data-$(date +%Y%m%d-%H%M%S).tgz")
docker compose start stream-router
```

Selama container berhenti, kamera tidak di-ingest maupun direkam.

Restore (menimpa seluruh isi volume data; container `stream-router` harus sudah dibuat, mis. dengan `docker compose up -d`):

```bash
image="$(docker inspect --format '{{.Image}}' stream-router)"
docker compose stop stream-router
docker run --rm -i --volumes-from stream-router "$image" \
  sh -c 'find /app/data -mindepth 1 -delete && tar -xzf - -C /app/data' \
  < backups/stream-router-data-YYYYMMDD-HHMMSS.tgz
docker compose start stream-router
```

Di Windows PowerShell 5.1 pengalihan `>` merusak data biner; gunakan perintah bind mount di [WINDOWS.md](WINDOWS.md#backup-dan-restore) atau `update.ps1 -BackupOnly`.

## Rotasi secret dan password

Latar belakang ada di [SECURITY.md](SECURITY.md#rotasi-key). Nilai `AUTH_SECRET`/`APP_ENCRYPTION_KEY` di `.env` selalu didahulukan dibanding secret otomatis di volume data; bila `APP_ENCRYPTION_KEY` keduanya berbeda, supervisor mencatat peringatan. `APP_ENCRYPTION_KEY` tidak pernah dibuat ulang otomatis bila database sudah ada.

- **Password Administrator/Operator**: ganti dari Settings → Keamanan Akun. Recovery: isi password baru di `.env`, `docker compose up -d`, lalu `docker compose exec stream-router node scripts/reset-auth-password.mjs --role all`.
- **AUTH_SECRET**: bila dibuat otomatis, hapus barisnya dari file secret lalu restart agar nilai baru dibuat:

  ```bash
  docker compose run --rm --no-deps -T stream-router sed -i '/^AUTH_SECRET=/d' /app/data/secrets/stream-router.env
  docker compose restart stream-router
  ```

  Bila diisi di `.env`, ganti dengan nilai dari `docker compose run --rm --no-deps -T stream-router node scripts/generate-secrets.mjs` lalu `docker compose up -d`. Semua pengguna login ulang.
- **APP_ENCRYPTION_KEY**:

  ```bash
  # 1. backup data, lalu hentikan container
  docker compose stop stream-router
  # 2. isi APP_ENCRYPTION_KEY=<key baru> di .env (nilai dari generate-secrets.mjs)
  # 3a. key lama berasal dari .env: script meminta key lama lewat prompt tersembunyi
  docker compose run --rm --no-deps stream-router node scripts/reencrypt-secrets.mjs --dry-run
  docker compose run --rm --no-deps stream-router node scripts/reencrypt-secrets.mjs
  # 3b. key lama dibuat otomatis: dibaca dari file secret di volume tanpa ditampilkan
  docker compose run --rm --no-deps -T stream-router sh -c \
    'OLD_APP_ENCRYPTION_KEY=$(sed -n s/^APP_ENCRYPTION_KEY=//p /app/data/secrets/stream-router.env) node scripts/reencrypt-secrets.mjs --dry-run'
  docker compose run --rm --no-deps -T stream-router sh -c \
    'OLD_APP_ENCRYPTION_KEY=$(sed -n s/^APP_ENCRYPTION_KEY=//p /app/data/secrets/stream-router.env) node scripts/reencrypt-secrets.mjs'
  #    lalu samakan file secret dengan key baru (backup volume tetap memuat key yang benar)
  docker compose run --rm --no-deps -T stream-router sh -c \
    'set -f; sed -i s/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY/ /app/data/secrets/stream-router.env'
  # 4. jalankan lagi dan periksa route, MQTT broker, PTZ, Stream View
  docker compose up -d
  ```

  Pertahankan key baru di `.env`. Salinan database sebelum rotasi tersimpan di `/app/data/backups/` dan masih dapat dibuka dengan key lama; hapus setelah aplikasi terverifikasi.

## Reverse proxy HTTPS

Untuk akses di luar LAN tepercaya, pasang reverse proxy HTTPS (contoh Nginx, termasuk SSE dan blokir `/internal/`, di [DEPLOYMENT.md](DEPLOYMENT.md#4-nginx-https)) di depan port 3000:

- Proxy di host yang sama terhubung ke container dari IP gateway network Docker, bukan loopback. Isi `TRUST_PROXY` di `.env` dengan IP gateway tersebut (`docker network inspect stream-router_default --format '{{(index .IPAM.Config 0).Gateway}}'`).
- Isi `CORS_ORIGIN` di `.env` dengan origin HTTPS dashboard. `COOKIE_SECURE=auto` otomatis memberi atribut Secure karena proxy mengirim `X-Forwarded-Proto: https`. Terapkan dengan `docker compose up -d`.
- Di Docker Desktop semua klien terlihat dari gateway yang sama, sehingga mempercayai gateway membuat `X-Forwarded-For` dapat dipalsukan klien yang mengakses port 3000 secara langsung. Pastikan port 3000 hanya dapat dijangkau proxy.

## Build image lokal

Dari root repository:

```bash
docker build -t stream-router:local .
# arsitektur lain, mis. arm64 (memerlukan buildx + QEMU/binfmt)
docker buildx build --platform linux/arm64 -t stream-router:local-arm64 --load .
```

Jalankan image lokal dari folder instalasi dengan `STREAM_ROUTER_IMAGE=stream-router:local` di `.env`, lalu `docker compose up -d`.

`docker-compose.yml` di repository juga memiliki `build: .`, sehingga `docker compose up -d --build` membangun dan menjalankan langsung dari checkout (Windows: `docker\windows\setup.ps1 -Build`). Perhatian: Compose membaca `.env` di root repository, yaitu file yang sama dengan `.env` development dari `npm run dev`. Path, port, dan `FFMPEG_PATH` sudah dipin di `docker-compose.yml`, tetapi nilai development lain (mis. password bootstrap atau `MEDIAMTX_VERSION`) tetap terbawa ke container. Gunakan clone terpisah khusus Docker dengan `.env` dari `docker/.env.example`, atau build image lalu jalankan dari folder instalasi.

**Akhir baris di clone Windows**: Git for Windows secara default (`core.autocrlf=true`) mengubah file teks menjadi CRLF saat checkout. `.gitattributes` di repository memaksa LF sehingga clone baru menghasilkan image dengan isi yang sama seperti image GHCR. Clone lama yang dibuat sebelum `.gitattributes` ada tetap berisi CRLF sampai di-checkout ulang; periksa dengan `git ls-files --eol -- Dockerfile scripts prisma docker` (kolom `w/crlf`), lalu buat clone baru atau jalankan `git rm -r --cached -q .` diikuti `git reset --hard` setelah perubahan lokal di-commit. Checksum migration dihitung dari isi yang dinormalisasi ke LF, sehingga volume data tetap dapat dipakai bergantian oleh image build lokal dan image GHCR. Detail Windows ada di [WINDOWS.md](WINDOWS.md#build-dari-clone-git-di-windows).

## Membuat release GitHub

Workflow GitHub Actions ada di `.github/workflows/`:

- `ci.yml` (push dan pull request): lint, typecheck, unit/integration test, `verify:source`, build, `verify:dist`, lalu build image `linux/amd64` dan uji container (health, Control API MediaMTX, encoder `libx264`/`libopus`, graceful stop).
- `release.yml` (tag `v*.*.*`): pemeriksaan yang sama, push image multi-arch ke GHCR dengan tag `<versi>`, `<major>.<minor>`, dan `latest`, lalu membuat GitHub Release berisi `stream-router-docker-<versi>.zip`, image `amd64` (`docker save | gzip`), dan `SHA256SUMS.txt`.

Repository utama adalah `github.com/sanadunt/stream-router`; perubahan masuk lewat pull request agar `ci.yml` berjalan sebelum merge:

```bash
git switch -c fitur/nama-perubahan origin/main
# ... commit perubahan ...
git push -u origin fitur/nama-perubahan
gh pr create --fill          # atau buka PR dari halaman GitHub
```

Setelah PR di-merge dan CI di `main` hijau, buat rilis dari `main` dengan tag versi semver. Tag memicu `release.yml`:

```bash
git switch main && git pull --ff-only
git tag -a v1.1.0 -m "Rilis 1.1.0"
git push origin v1.1.0
```

Build `linux/arm64` berjalan lewat emulasi QEMU sehingga satu rilis memakan waktu cukup lama. Rilis yang gagal di tengah jalan dapat diulang dari tab Actions (*Re-run jobs*); tag yang sama tidak perlu dibuat ulang.

Repository public menghasilkan package GHCR public, sehingga pengguna Windows dapat `docker compose pull` tanpa login. Bila repository dijadikan private, package ikut privat: pengguna memerlukan `docker login ghcr.io` (token `read:packages`) atau file image offline dari halaman Release.

Membuat bundle zip secara lokal (tanpa image), mis. untuk memeriksa isinya:

```bash
npm run release:package -- 1.0.0
# hasil: release/stream-router-docker-1.0.0.zip
```

Owner image di bundle diambil dari `GITHUB_REPOSITORY_OWNER` (default `sanadunt`).

## Troubleshooting

- Container `unhealthy`/restart: `docker compose logs --tail 200 stream-router`. Penyebab umum: password kosong/contoh, `APP_ENCRYPTION_KEY` di `.env` tidak cocok dengan database, atau volume tidak dapat ditulis user container.
- Login kembali ke halaman login: `COOKIE_SECURE` dipaksa `true` saat diakses lewat HTTP; gunakan `auto`.
- WebRTC gagal dari host lain: `HOST_LAN_IP` salah/berubah, **Public host/IP** di Settings berisi host lama (kosongkan agar mengikuti `HOST_LAN_IP`), atau `18189/UDP` diblokir.
- `421 HOST_NOT_ALLOWED`: dashboard dibuka lewat nama host yang tidak ada di allowlist. Buka lewat IP/`localhost`, atau tambahkan nama itu ke `ALLOWED_HOSTS` di `.env` lalu `docker compose up -d`.
- Lihat juga [WINDOWS.md](WINDOWS.md#troubleshooting) dan [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
