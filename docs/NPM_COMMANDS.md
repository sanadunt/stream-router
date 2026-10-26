# Panduan Perintah npm — Camera Integration

Dokumen ini menjelaskan perintah npm yang tersedia, urutan quick start, pengelolaan secret dan password, database, MediaMTX, testing, serta deployment. Jalankan perintah dari root project kecuali dinyatakan lain.

## Persyaratan

- macOS atau Linux `arm64`/`amd64`.
- Node.js 20 atau lebih baru.
- npm 10 atau lebih baru.
- FFmpeg tersedia pada `PATH` atau diatur melalui `FFMPEG_PATH`.
- Jangan menggunakan `pnpm`; project menggunakan npm workspaces dan `package-lock.json`.

Periksa runtime:

```bash
node --version
npm --version
ffmpeg -version
```

## Quick start development

Untuk instalasi baru:

```bash
npm install
npm run dev
```

Untuk instalasi reproducible dari lockfile, terutama pada host baru atau CI:

```bash
npm ci
npm run dev
```

`npm run dev` secara otomatis:

1. Membuat `.env` development jika belum tersedia dan menghasilkan secret/password acak.
2. Melengkapi key development yang belum ada tanpa menimpa secret yang sudah tersimpan.
3. Mengunduh MediaMTX versi yang dipin sesuai OS/arsitektur dan memverifikasi checksum.
4. Menjalankan seluruh migration SQLite yang belum diterapkan.
5. Membangun package shared.
6. Menjalankan MediaMTX, Fastify API, dan Vite secara bersamaan.

Alamat browser mengikuti `WEB_PORT` di `.env`, default `http://localhost:5173`. API mengikuti `PORT`, default `3000`; proxy Vite meneruskan `/api` ke port tersebut.

## Membuat AUTH_SECRET dan APP_ENCRYPTION_KEY

Pada development first-run, `npm run dev` membuat kedua nilai ini otomatis. Jika `.env` dibuat manual dari `.env.example`, jalankan:

```bash
npm run secrets:generate
```

Perintah menghasilkan dua baris berbeda, contohnya:

```env
AUTH_SECRET=<secret-acak>
APP_ENCRYPTION_KEY=<key-acak>
```

Salin hasilnya ke `.env`. Generator menggunakan `crypto.randomBytes(32)` dari Node.js dan encoding Base64URL, sehingga bekerja sama di macOS dan Linux tanpa OpenSSL.

Fungsi masing-masing:

- `AUTH_SECRET` menandatangani session login. Menggantinya mencabut seluruh session aktif.
- `APP_ENCRYPTION_KEY` mengenkripsi credential kamera, MQTT, dan URL sensitif. Key ini harus dibackup dan dipertahankan selama database masih digunakan. Menggantinya langsung membuat data yang sudah terenkripsi tidak dapat dibuka; gunakan alur [Rotasi APP_ENCRYPTION_KEY](#rotasi-app_encryption_key).

Jangan commit `.env`, mencetak secret ke log aplikasi, atau memakai nilai yang sama pada dua host production. Simpan backup `.env` dengan permission terbatas.

## Password Administrator dan Operator

`ADMIN_PASSWORD` dan `OPERATOR_PASSWORD` pada `.env` adalah password bootstrap. Setelah hash tersedia dalam database, mengedit `.env` saja tidak mengganti password login.

Cara utama adalah melalui **Settings → Keamanan Akun**. Perubahan aktif langsung tanpa restart.

Untuk recovery atau sinkronisasi dari `.env`:

```bash
npm run auth:reset -- --role admin
npm run auth:reset -- --role operator
npm run auth:reset -- --role all
```

Perintah membaca password dari `.env`, membuat hash bcrypt baru, dan mencabut session lama role terkait. Password minimal delapan karakter. Pastikan setiap key hanya muncul satu kali di `.env`; bila duplikat, deklarasi terakhir yang digunakan.

Password tidak boleh diberikan sebagai argumen command karena dapat tersimpan dalam shell history.

## Rotasi APP_ENCRYPTION_KEY

Gunakan alur ini bila key perlu diganti. Mengganti key di `.env` tanpa langkah ini membuat route, MQTT broker, PTZ, dan Stream View tidak dapat didekripsi. Bila `.env` bocor, `AUTH_SECRET` serta password Administrator dan Operator juga wajib diganti; lihat [Bila `.env` bocor](SECURITY.md#bila-env-bocor).

```bash
pm2 stop stream-router
npm run secrets:generate
# Simpan APP_ENCRYPTION_KEY lama di tempat aman, lalu ganti baris APP_ENCRYPTION_KEY di .env.
npm run secrets:reencrypt -- --dry-run
npm run secrets:reencrypt
pm2 start stream-router
```

Pada development, hentikan `npm run dev` dengan `Ctrl+C` sebagai pengganti `pm2 stop`, lalu jalankan kembali setelah rotasi. Pada production, `pm2 stop` tidak menghentikan MediaMTX: kamera tetap direkam tanpa retention dan storage guard sampai API berjalan lagi, jadi selesaikan rotasi tanpa jeda panjang. Script meminta key lama melalui prompt tersembunyi. Untuk sesi tanpa terminal interaktif, isi environment `OLD_APP_ENCRYPTION_KEY` dari sumber aman tanpa menuliskannya di command. Contoh pada bash/zsh:

```bash
read -rs OLD_APP_ENCRYPTION_KEY && export OLD_APP_ENCRYPTION_KEY
npm run secrets:reencrypt
unset OLD_APP_ENCRYPTION_KEY
```

Tanda `--` sebelum `--dry-run` wajib; tanpa itu npm menelan flag tersebut dan script menolak berjalan. Script juga menolak bila variabel shell seperti `APP_ENCRYPTION_KEY` berbeda dengan `.env`; jalankan `unset` sesuai pesan lalu ulangi.

Sebelum menulis, script membuat backup SQLite di `data/backups/` dan memverifikasi seluruh nilai di dalam transaksi, lalu menjalankan `VACUUM` agar sisa ciphertext key lama terhapus dari file database. Hapus backup tersebut setelah aplikasi terverifikasi karena masih dapat dibuka dengan key lama. Langkah rollback dan pertimbangan keamanan ada di [Keamanan](SECURITY.md#rotasi-key).

## Referensi seluruh perintah root

### Development dan runtime

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Menjalankan bootstrap development, MediaMTX, API watch mode, dan Vite. Berhenti bersama dengan `Ctrl+C`. |
| `npm run media:dev` | Menjalankan MediaMTX foreground menggunakan konfigurasi project. Biasanya sudah dipanggil oleh `npm run dev`. |
| `npm run media:ensure` | Mengunduh/cache binary MediaMTX versi `MEDIAMTX_VERSION` dari `.env`, memverifikasi checksum, dan mengunduh ulang cache yang rusak. |
| `npm run media:config` | Menghasilkan konfigurasi MediaMTX tanpa menjalankan servicenya. |
| `npm run media:install-service` | Linux saja: memasang/memperbarui MediaMTX sebagai service systemd beserta logrotate, lalu me-restart service. Membutuhkan `sudo`; untuk user tanpa `sudo`, admin menjalankan salinan skrip milik root yang sudah ditinjau dengan `--user streamrouter --project-dir /opt/stream-router` ([Deployment Linux](DEPLOYMENT.md) bagian 1). |

### Build dan pemeriksaan kualitas

| Perintah | Fungsi |
|---|---|
| `npm run build` | Build package shared, frontend production, lalu backend TypeScript. |
| `npm run build:packages` | Build hanya `@stream-router/contracts` dan `@stream-router/ffmpeg`. |
| `npm run lint` | Menjalankan ESLint dengan nol warning yang diizinkan. |
| `npm run typecheck` | Memeriksa tipe seluruh workspace tanpa menghasilkan build aplikasi. |
| `npm test` | Menjalankan unit test API/FFmpeg dan test frontend. |
| `npm run test:integration` | Menjalankan integration test API dengan dependency media palsu/terisolasi. |
| `npm run smoke` | Menguji FFmpeg dari `FFMPEG_PATH` di `.env`: encoder `libx264`/`aac` dan protokol `rtmp` wajib, mux sampel ke FLV, serta melaporkan `libopus`/`rtmps` bila tidak tersedia. |
| `npm run verify:source` | Menjalankan pemeriksaan kontrak keamanan/source project. |
| `npm run verify:dist` | Setelah `npm run build`: memeriksa setiap import di `dist` dapat di-resolve Node ESM, lalu menjalankan `apps/api/dist/server.js` (`NODE_ENV=production`, MediaMTX nonaktif, database SQLite sementara, port bebas) sampai `/api/health` menjawab dan menghentikannya dengan graceful shutdown. Tidak memakai `.env`, database, atau MediaMTX yang sedang berjalan. |
| `npm run verify:env` | Setelah `npm run build`: memvalidasi `.env` dengan schema environment API yang sama (`apps/api/dist/config/env.js`). Hanya nama field dan aturan yang dicetak, bukan nilainya. |

Urutan verifikasi sebelum deploy:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run smoke
npm run verify:source
npm run verify:dist
```

`verify:dist` adalah satu-satunya pemeriksaan yang benar-benar menjalankan build production. lint, typecheck, vitest, dan smoke tidak mengeksekusi `dist`, sehingga kegagalan yang hanya muncul di Node ESM (misalnya import direktori paket) baru terlihat saat PM2 crash-loop.

### Database dan Prisma

| Perintah | Fungsi |
|---|---|
| `npm run db:migrate` | Menjalankan migration SQLite yang belum diterapkan melalui runner lintas platform. |
| `npm run prisma:migrate` | Alias kompatibilitas untuk `db:migrate`. |
| `npm run prisma:deploy` | Alias deployment untuk `db:migrate`; gunakan pada host production/baru. |
| `npm run prisma:generate` | Menghasilkan Prisma Client berdasarkan schema saat ini. |
| `npm run prisma:studio` | Membuka Prisma Studio untuk inspeksi database. Jangan mengekspos port-nya ke jaringan publik. |

Migration normal tidak menghapus database. Tetap backup file SQLite sebelum upgrade production.

### Keamanan

| Perintah | Fungsi |
|---|---|
| `npm run secrets:generate` | Menghasilkan `AUTH_SECRET` dan `APP_ENCRYPTION_KEY` baru tanpa menulis `.env`. |
| `npm run secrets:reencrypt` | Mengenkripsi ulang credential tersimpan dari key lama ke `APP_ENCRYPTION_KEY` baru di `.env`. Tambahkan `-- --dry-run` untuk pemeriksaan tanpa perubahan. |
| `npm run auth:reset -- --role admin` | Mengganti hash Administrator dari `ADMIN_PASSWORD` di `.env`. |
| `npm run auth:reset -- --role operator` | Mengganti hash Operator dari `OPERATOR_PASSWORD` di `.env`. |
| `npm run auth:reset -- --role all` | Mengganti kedua hash sekaligus. |

### Release

| Perintah | Fungsi |
|---|---|
| `npm run release:package -- <versi>` | Membuat `release/stream-router-docker-<versi>.zip` berisi `docker-compose.yml` (tanpa `build:`, image `ghcr.io/<owner>/stream-router:<versi>`; owner dari `GITHUB_REPOSITORY_OWNER`, default `sanadunt`), `.env.example` dari `docker/.env.example`, script `windows/setup.ps1` dan `windows/update.ps1`, serta `README-WINDOWS.md`. Dipakai workflow release GitHub; lihat [Docker](DOCKER.md#membuat-release-github). |

### Lifecycle npm otomatis

Perintah berikut merupakan lifecycle hook dan biasanya tidak perlu dijalankan manual:

- `predev` berjalan otomatis sebelum `npm run dev`: memastikan `.env`, MediaMTX, dan migration.
- `postinstall` berjalan otomatis setelah `npm install`/`npm ci`: menghasilkan Prisma Client.

## Menjalankan workspace tertentu

Gunakan ini hanya untuk debugging; normalnya gunakan `npm run dev` dari root.

```bash
npm run dev --workspace=@stream-router/api
npm run dev --workspace=@stream-router/web
npm run build --workspace=@stream-router/api
npm run build --workspace=@stream-router/web
npm run test --workspace=@stream-router/web
```

API watch mode tidak otomatis menjalankan MediaMTX atau Vite. Web saja tetap memerlukan API aktif agar `/api` tidak gagal.

## Setup host production Linux

```bash
install -m 600 .env.example .env
npm run secrets:generate
# Salin hasil secret ke .env, lalu isi ADMIN_PASSWORD, OPERATOR_PASSWORD,
# CORS_ORIGIN (origin HTTPS dashboard di reverse proxy), port, dan path.
mkdir -p data/logs backups
chmod 700 data backups
chmod 600 .env

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
systemctl is-enabled "pm2-$(id -un)"
```

Atau jalankan `./scripts/install-production.sh`, yang menjalankan langkah di atas, menolak `.env` yang masih berisi nilai contoh, lalu menunggu `/api/ready`. User service tanpa `sudo` memakai `./scripts/install-production.sh --skip-system`; langkah sistem untuk admin dicetak di akhir (lihat [Deployment Linux](DEPLOYMENT.md)).

`npm install` dan `npm ci` tidak menjalankan `sudo`. Hanya installer systemd MediaMTX dan `pm2 startup` yang memerlukan hak administratif. Tanpa `pm2 startup`, API tidak kembali setelah reboot sehingga tidak ada kamera yang di-ingest, direkam, atau direlay.

Untuk update berikutnya:

```bash
npm ci
npm run prisma:deploy
npm run build
npm run verify:env
npm run test
npm run test:integration
npm run smoke
npm run verify:dist
pm2 reload ecosystem.config.cjs --env production
npm run media:install-service   # bila MEDIAMTX_VERSION di .env berubah
```

Jangan menjalankan `pm2 reload` bila `verify:env` atau `verify:dist` gagal: proses baru akan crash-loop dan menggantikan proses yang masih berjalan. Lihat juga langkah satu kali di [Upgrade dan rollback](DEPLOYMENT.md#7-upgrade-dan-rollback).

## Troubleshooting singkat

### Password baru dari `.env` tidak berfungsi

Pastikan key hanya ditulis satu kali dan gunakan reset eksplisit:

```bash
npm run auth:reset -- --role operator
```

Restart tidak diperlukan. Setelah lima percobaan login gagal, tunggu satu menit karena rate limit.

### Web terbuka tetapi API gagal

Pastikan `PORT` backend dan proxy Vite membaca `.env` yang sama. Jalankan seluruh stack dengan:

```bash
npm run dev
```

### Tabel database belum tersedia

```bash
npm run prisma:deploy
```

### MediaMTX tidak tersedia

```bash
npm run media:ensure
npm run media:config
npm run media:dev
```

Lihat juga [Deployment Linux](DEPLOYMENT.md), [MediaMTX dan Recording](MEDIAMTX_RECORDING.md), serta [Troubleshooting](TROUBLESHOOTING.md).
