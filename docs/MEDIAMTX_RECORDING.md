# MediaMTX, WebRTC Lokal, dan Recording

## Runtime development

`npm run dev` menjalankan tiga proses bersama:

1. `media` — MediaMTX versi `MEDIAMTX_VERSION` di `.env` (default `v1.19.2`).
2. `api` — Fastify dan worker FFmpeg online.
3. `web` — Vite.

Binary MediaMTX diunduh dari release resmi GitHub ke `.runtime/mediamtx/`, dicocokkan dengan `checksums.sha256`, lalu disimpan sebagai cache lokal. Platform yang didukung otomatis adalah macOS/Linux `arm64` dan `amd64`. `npm install` tidak meminta `sudo`.

```bash
npm run media:ensure
npm run media:config
npm run dev
```

## Production Linux

Jalankan aplikasi sebagai user service non-root. Installer service memakai `sudo` hanya untuk menyalin binary ke `/usr/local/bin` dan menulis unit systemd:

```bash
npm ci
npm run prisma:deploy
npm run build
npm run media:install-service
sudo systemctl status mediamtx
```

User service tanpa `sudo` (misalnya `streamrouter`) cukup menjalankan `npm ci`; admin lalu memasang service untuk user tersebut dari salinan installer milik root yang sudah ditinjau: `sudo env PATH="$PATH" /usr/local/sbin/stream-router-mediamtx-service --user streamrouter --project-dir /opt/stream-router` (lihat [DEPLOYMENT.md](DEPLOYMENT.md) bagian 1). Langkah Node dan semua operasi file di folder project pada installer tetap dijalankan sebagai user service.

Unit menggunakan `Restart=always`, `NoNewPrivileges=true`, dan `PrivateTmp=true`, membaca YAML dari `MEDIAMTX_CONFIG_PATH` (sama dengan API), dan menulis output ke `data/logs/mediamtx.log` dengan rotasi logrotate 10 MB × 5. API Node tetap dikelola PM2. Jangan menjalankan PM2 atau MediaMTX sebagai root.

## Port dan firewall

| Komponen | Port | Bind |
|---|---:|---|
| RTMP | 11935/TCP | LAN bila dibutuhkan |
| RTSP internal | 18554/TCP | Listener host; pembacaan path dibatasi auth |
| HLS | 18888/TCP | LAN |
| WebRTC HTTP | 18889/TCP | LAN |
| WebRTC ICE | 18189/UDP | LAN |
| SRT | 18890/UDP | LAN bila dibutuhkan |
| Playback | 19996/TCP | localhost |
| Control API | 19997/TCP | localhost |
| Metrics | 19998/TCP | localhost |

Untuk Viewer LAN, buka `18889/TCP` dan `18189/UDP`. Set **Public host/IP** pada Settings ke alamat server yang dapat dijangkau browser. Nilai loopback lama (`127.0.0.1`/`localhost`) otomatis memilih interface IPv4 LAN yang paling sesuai, tetapi host eksplisit tetap disarankan pada server dengan beberapa NIC. Nilai ini juga dikirim sebagai `webrtcAdditionalHosts` agar kandidat ICE menunjuk ke server yang benar. Path Local Media OFF tidak diberikan izin read anonim dari LAN; localhost tetap dapat membaca untuk relay online.

## Lifecycle route

MediaMTX menarik kamera satu kali pada `cameras/{cameraKey}`. Camera ID unik dan tidak dapat diganti setelah recording pertama terindeks. FFmpeg online selalu membaca:

```text
rtsp://127.0.0.1:18554/cameras/{cameraKey}
```

Local OFF + Online ON mempertahankan ingest dan FFmpeg, tetapi URL lokal tidak diekspos dan izin read LAN dilepas. Edit route aktif hanya me-restart pipeline bila Camera ID, input, output, Local/Online, mode audio, atau opsi FFmpeg berubah; nama, deskripsi, autoStart, retention, retry policy, dan link WebRTC cukup disimpan, sedangkan Recording di-hot-apply. Bila route sudah `READY` dan source baru gagal `READY`, database dan runtime dikembalikan ke konfigurasi sebelumnya. Bila source belum `READY` sebelum edit, konfigurasi baru disimpan tanpa rollback dan dipakai oleh retry MediaMTX.

Local Media menyediakan dua mode audio:

- **COPY** mempertahankan audio kamera dan tidak menambah proses transcode.
- **OPUS** membuat path turunan `cameras/{cameraKey}/webrtc` melalui FFmpeg lokal dengan video `copy` dan audio `libopus`. Path yang sama dibagikan ketika Local Media dan Relay Online sama-sama membutuhkan Opus, sehingga audio hanya di-encode satu kali. Recording tetap membaca ingest asli; relay online Opus membaca path turunan dan melakukan audio-copy.

## Recording dan indeks

- Format: fMP4.
- Part: 1 detik.
- Target segment default: 3600 detik (1 jam) dan nilai Settings dibatasi 60–3600 detik. MediaMTX menutup segment pada fragment boundary berikutnya, sehingga durasi aktual dapat sedikit melewati target tanpa merusak fragment aktif.
- Timestamp metadata disimpan UTC dan ditampilkan mengikuti zona waktu browser/server.
- Hook segment-create langsung menulis status `RECORDING` ke SQLite agar file yang sedang berjalan terlihat di tabel dan timeline. Hook segment-complete menggantinya menjadi `COMPLETE` dengan durasi aktual dari MediaMTX.
- Bila hook durasi terlewat, scanner memakai `ffprobe` pada file stabil. Fallback terakhir memakai selisih timestamp file; durasi tidak pernah lagi diasumsikan sama dengan target segment.
- Scanner startup dan periodik mengindeks event yang terlewat, menandai file hilang sebagai `MISSING`, dan menyimpan file yang tidak dapat dibaca sebagai `ERROR` beserta alasannya tanpa langsung menghapus file.
- Route yang dihapus tidak menghapus arsip; `routeId` menjadi `null` dan snapshot Camera ID/nama tetap ada.

MediaMTX mewajibkan `%path` pada pola file. Path native proyek adalah:

```text
recordings/cameras/{cameraKey}/YYYY/MM/DD/YYYY-MM-DD_HH-MM-SS-ffffff.mp4
```

Untuk player interaktif, backend mengoptimalkan segment fMP4 `COMPLETE` secara on-demand menjadi MP4 `faststart` melalui FFmpeg codec-copy. Video dan audio tidak di-encode ulang, sehingga CPU tetap rendah; yang berubah hanya layout container agar metadata dan indeks seek berada di depan. Hasil sementara disimpan di `.playback-cache`, dilayani dengan HTTP Range, `ETag`, `Content-Length`, serta private browser cache, lalu dibersihkan otomatis setelah dua jam. Request bersamaan untuk recording yang sama berbagi satu proses optimasi. Jika FFmpeg, codec container, atau ruang disk tidak memungkinkan, backend tetap melayani fMP4 asli sebagai fallback. Folder cache tidak diindeks sebagai recording dan ikut dihapus ketika recording sumber dihapus. Semua jalur tetap memeriksa role, dan download memakai nama Camera ID serta timestamp. Control API serta playback MediaMTX tidak perlu diekspos dari browser.

Kalender dikelompokkan memakai zona waktu browser dengan fallback `Asia/Jakarta`. Tombol bulan membuka popover kalender ringkas dengan navigasi tahun dan 12 pilihan bulan; hari tanpa segment dinonaktifkan. Timeline harian menampilkan blok per kamera; tooltip hover menunjukkan jam mulai, selesai, durasi, dan status recording aktif. Klik blok memilih segment terkait. Tabel memakai pagination server-side dengan batas 5/10/20/50/100 baris.

Player dibuka sebagai overlay fokus di atas halaman Recording dan menyediakan timestamp aktual, screenshot PNG dengan timestamp yang dibakar ke frame, serta Fullscreen API. Tombol `Esc`, tombol tutup, atau klik backdrop menutup overlay.

Admin dan Operator dapat mencentang beberapa segment `COMPLETE` untuk mengunduh satu ZIP streaming. ZIP memakai mode store/level 0 karena video sudah terkompresi. Bulk delete hanya tersedia bagi Admin serta otomatis melewati recording aktif dan file terproteksi.

## Retention dan storage guard

Policy default diatur melalui Settings dan dapat dioverride per Stream Route:

- **Hari** — hapus segment `COMPLETE` maupun `ERROR` (file yang tidak dapat dibaca tetap memakai disk) setelah melewati umur yang dipilih.
- **Kuota GB** — batasi total arsip per `cameraKey`.
- **Hari atau GB** — jalankan kedua batas; kondisi yang tercapai lebih dahulu memicu cleanup.
- **Ikuti Settings** — route memakai policy global tanpa duplikasi konfigurasi.

Untuk kuota, cleanup menghitung seluruh segment COMPLETE kamera, termasuk segment terproteksi, lalu menghapus segment COMPLETE tidak terproteksi dari yang paling tua. Segment `ERROR` tidak dihitung dalam kuota GB. Protected recording tidak pernah dihapus otomatis. Jika protected recording sendiri melebihi kuota, kondisi tersebut tetap dilaporkan dan storage floor menjadi perlindungan terakhir.

Selain policy per kamera, cleanup tetap menghapus segment COMPLETE atau ERROR tertua yang tidak dilindungi ketika ruang kosong turun di bawah nilai terbesar antara 15% dan 20 GB.

Recording yang dihapus tetap tercatat di database sebagai `DELETED` (tidak tampil di daftar) selama 7 hari, lalu barisnya dibersihkan. Setiap penghapusan juga dicatat di log route. Recording yang gagal dihapus (mis. permission atau volume read-only) dilewati 10 menit lalu dicoba lagi; log server hanya mencatat lima kegagalan pertama per pass cleanup beserta satu ringkasan.

Recovery memakai hysteresis tambahan 5% atau 5 GB. Protected recording tidak pernah dihapus otomatis. Bila ruang tidak dapat dipulihkan, recording seluruh route dipause dan health menjadi merah; ingest dan relay tetap berjalan.

Mengganti recording root hanya memengaruhi file baru. Metadata menyimpan storage root asal sehingga arsip lama tetap dapat diputar selama volume lamanya masih mounted.

Admin dapat memilih folder melalui browser filesystem server di Settings. API hanya mengembalikan direktori, canonical path, permission writable, dan kapasitas disk; isi file tidak pernah diekspos. Sebelum Apply, folder diuji dengan write probe dan storage floor. Database SQLite tetap satu dan lokasinya hanya ditampilkan read-only—tidak ikut berpindah ketika recording root berubah.

## Mount NAS

Mount NAS melalui mekanisme OS terlebih dahulu, lalu pilih mount point tersebut di Settings. Pastikan user `streamrouter` memiliki permission read/write dan mount tersedia sebelum MediaMTX dimulai. Object storage tidak didukung.

## Upgrade MediaMTX

1. Backup database, `.env`, dan YAML aktif.
2. Ubah `MEDIAMTX_VERSION` di `.env` hanya ke release yang sudah diverifikasi (format `vX.Y.Z`).
3. Jalankan `npm run media:ensure`; script membaca versi dari `.env`, sama seperti `npm run dev` dan API.
4. Jalankan lint, test, build, dan smoke test.
5. Pasang ulang binary systemd dengan `npm run media:install-service` (atau perintah admin `--user` di atas). Installer menyalin binary versi baru ke `/usr/local/bin` dan me-restart service; `systemctl restart mediamtx` saja tetap menjalankan binary lama.
6. Periksa `/usr/local/bin/mediamtx --version`, `curl -sS http://127.0.0.1:3000/api/ready` (tanpa login hanya menyebut nama pemeriksaan yang gagal; detailnya ada di Settings saat login sebagai Admin/Operator dan di `pm2 logs stream-router`), listener, ingest path, dan playback.

Checksum selalu diverifikasi sebelum binary cache dipakai pertama kali. Arsip diekstrak ke folder staging dan baru dipindahkan ke cache setelah `mediamtx --version` berhasil; cache yang rusak atau terpotong diunduh ulang otomatis. Jangan mengganti binary di `.runtime` secara manual.

## Backup dan recovery

Backup minimal mencakup:

- `.env`, terutama `APP_ENCRYPTION_KEY`.
- `data/stream-router.db`.
- Semua volume recording yang masih direferensikan metadata.

Saat restore, gunakan encryption key yang sama, mount semua recording root lama, jalankan `npm run prisma:deploy`, lalu mulai MediaMTX sebelum API. Scanner akan merekonsiliasi file yang belum terindeks.
