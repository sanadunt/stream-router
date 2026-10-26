# Troubleshooting

## FFmpeg tidak ditemukan

```bash
which ffmpeg
ffmpeg -version
```

Isi `FFMPEG_PATH=/usr/bin/ffmpeg` lalu restart PM2. `npm run smoke` menguji binary dari `FFMPEG_PATH` di `.env`, termasuk encoder `libx264`/`aac`/`libopus` dan protokol `rtmp`/`rtmps`.

## Route RUNNING tetapi stream tidak muncul

Periksa lampu **Ingest MediaMTX** dan **Relay Online** secara terpisah:

```bash
curl -b cookie.txt http://127.0.0.1:3000/api/routes/ROUTE_ID/logs
```

Jika ingest belum `READY`, uji source kamera dari host. Jika ingest ready tetapi online gagal, pastikan output URL/key benar, DNS dapat di-resolve, firewall mengizinkan koneksi keluar, dan server tujuan menerima codec/container.

## MediaMTX tidak start

```bash
npm run media:ensure
npm run media:config
npm run media:dev
```

Periksa bentrok port `11935`, `18554`, `18888`, `18889`, `18189`, `18890`, `19996`, `19997`, dan `19998`. Proyek memaksa RTSP-over-TCP agar MediaMTX tidak membuka RTP `8000/8001`, serta menonaktifkan MoQ `8892`.

Di Linux production:

```bash
sudo systemctl status mediamtx
tail -n 200 data/logs/mediamtx.log
sudo journalctl -u mediamtx -n 50 --no-pager
```

Output MediaMTX ditulis ke `data/logs/mediamtx.log` (juga tampil di halaman Terminal), bukan ke journald. `journalctl` hanya memuat pesan systemd, misalnya binary atau file konfigurasi gagal dibuka dan restart berulang. File log dirotasi oleh `/etc/logrotate.d/stream-router-mediamtx` (10 MB, lima arsip) yang dipasang `npm run media:install-service`.

## Recording berstatus PAUSED

Storage guard aktif ketika free space kurang dari 15% atau 20 GB (mana yang lebih besar). Hapus file non-protected melalui GUI, tambah volume, atau ubah floor secara sadar di Settings. Protected recording tidak akan dihapus otomatis. Jangan menurunkan floor untuk menyembunyikan disk yang benar-benar penuh.

## WebRTC lokal tidak bisa dibuka dari komputer lain

- Isi **Public host/IP** dengan IP/DNS server, bukan `127.0.0.1`.
- Buka `18889/TCP` dan `18189/UDP`.
- Pastikan Local Media route aktif dan ingest `READY`.
- Jika status menunjukkan codec tidak kompatibel, gunakan source Online atau ubah codec kamera; sistem tidak menyalakan transcoding diam-diam.

## Mode copy gagal karena audio

Kamera sering mengirim G.711/PCM yang tidak kompatibel dengan FLV. Ubah **Audio online** ke AAC atau Opus. Video dapat tetap Copy bila tidak perlu ditranscode.

Jika Opus ditolak sebelum worker dimulai, pastikan `ffmpeg -encoders` menampilkan `libopus`. Jika worker mulai tetapi tujuan RTMP menolak stream, tujuan kemungkinan belum mendukung enhanced RTMP/Opus; pilih AAC secara eksplisit karena aplikasi tidak melakukan fallback otomatis.

## HLS/MJPEG/MP4 tidak tampil di Viewer

- HLS harus mengirim header CORS yang mengizinkan origin dashboard.
- URL tidak boleh memuat `username:password@host`; gunakan sumber publik terbatas jaringan atau mekanisme token pada query bila provider mendukungnya.
- Aplikasi HTTPS dapat diblokir saat membuka sumber HTTP karena mixed content.
- Untuk LAN HTTP tepercaya, set `STREAM_VIEW_ALLOW_INSECURE_HTTP=true`, lalu restart API.
- MP4 perlu mendukung byte-range agar seeking browser mulus.

## RTSP timeout

- Uji dari server: `ffprobe -rtsp_transport tcp 'rtsp://...'`.
- Pastikan kamera menerima koneksi TCP.
- Verifikasi routing/VLAN/firewall.
- Kurangi jumlah koneksi serentak ke kamera.

## Auto-restart terus menerus

Lihat `lastError` dan log FFmpeg. Retry memakai exponential backoff sampai `maxRetries`; setelah itu status menjadi `FAILED`. Perbaiki sumber/tujuan, lalu tekan Start/Restart.

## Database terkunci

Pastikan hanya satu instance control plane memakai file SQLite yang sama. `ecosystem.config.cjs` memakai mode fork satu instance. Jangan menjalankan cluster mode untuk SQLite.

## Cookie login tidak tersimpan

Pada production, cookie bersifat Secure. Dashboard harus dibuka melalui HTTPS. Pastikan `CORS_ORIGIN` sama persis dengan origin browser dan reverse proxy mengirim `X-Forwarded-Proto`.

## npm registry tidak dapat diakses

Periksa DNS/proxy perusahaan dan konfigurasi registry:

```bash
npm config get registry
npm ping
```

Gunakan registry internal perusahaan bila diwajibkan.
