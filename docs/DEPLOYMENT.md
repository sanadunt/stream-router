# Deployment Linux

## 1. Buat user non-root

```bash
sudo useradd --system --create-home --shell /bin/bash streamrouter
sudo mkdir -p /opt/stream-router
sudo chown -R streamrouter:streamrouter /opt/stream-router
```

Salin project ke `/opt/stream-router`. User `streamrouter` sengaja tidak memiliki `sudo`, sehingga instalasi dibagi dua:

```bash
# a. Sebagai streamrouter: langkah aplikasi (validasi .env, dependency, migration, build, smoke, PM2).
sudo -iu streamrouter
cd /opt/stream-router
install -m 600 .env.example .env
npm run secrets:generate   # salin ke .env, lalu isi ADMIN_PASSWORD, OPERATOR_PASSWORD, dan .env bagian 4
./scripts/install-production.sh --skip-system
exit

# b. Sebagai admin (akun dengan sudo): langkah sistem untuk user tersebut.
cd /opt/stream-router
less scripts/install-mediamtx-service.sh   # tinjau isinya: skrip ini akan berjalan sebagai root
sudo install -m 0755 -o root -g root scripts/install-mediamtx-service.sh /usr/local/sbin/stream-router-mediamtx-service
sudo env PATH="$PATH" /usr/local/sbin/stream-router-mediamtx-service --user streamrouter --project-dir /opt/stream-router
sudo env PATH="$PATH:$(dirname "$(command -v node)")" "$(command -v pm2)" startup systemd -u streamrouter --hp /home/streamrouter
systemctl is-enabled pm2-streamrouter
curl -sS http://127.0.0.1:3000/api/ready
```

Folder `/opt/stream-router` dimiliki `streamrouter`, sehingga user tersebut dapat mengubah `scripts/install-mediamtx-service.sh`. Karena itu admin menjalankan salinan milik root yang sudah ditinjau, bukan file di folder project; ulangi peninjauan dan penyalinan bila skrip berubah saat upgrade. Installer tidak mengikuti symlink di folder project: file log dibuat oleh user service, dan binary hanya disalin dari cache `.runtime/mediamtx/` dengan hak baca user service.

Langkah (a) mencetak perintah (b) yang sudah disesuaikan dengan path Node/PM2 di server. Bila aplikasi dijalankan oleh user non-root yang memiliki `sudo`, cukup jalankan `./scripts/install-production.sh` tanpa opsi; skrip memasang service MediaMTX dan boot service PM2 sendiri, lalu gagal bila API tidak siap.

Tanpa sesi login, `/api/ready` menjawab `{"ready":true}` atau HTTP 503 `{"ready":false,"failing":[...]}` yang hanya menyebut nama pemeriksaan yang gagal (`database`, `ffmpeg`, `mediaMtx.controlApi`, `mediaMtx.recordingStorage`, atau `mediaMtx`). Teks error lengkapnya ditulis ke log API sebagai `Pemeriksaan kesiapan gagal` (`pm2 logs stream-router`). Bila satu-satunya yang gagal adalah `mediaMtx.recordingStorage` (ruang kosong di bawah batas aman, default nilai terbesar antara 15% disk dan 20 GB), installer menyelesaikan instalasi dengan peringatan: API dan MediaMTX berjalan, tetapi recording dipause sampai ruang kosong cukup atau batasnya diturunkan di Settings.

## 2. Install Node.js, npm, FFmpeg, dan PM2

Gunakan repository resmi distro/NodeSource sesuai kebijakan server. PM2 dipasang global oleh admin (`sudo npm install -g pm2`). Verifikasi:

```bash
node --version
npm --version
ffmpeg -version
pm2 --version
```

## 3. Permission

`.env` berisi `AUTH_SECRET`/`APP_ENCRYPTION_KEY` dan database berisi credential terenkripsi, sehingga keduanya tidak boleh terbaca user lokal lain. `install-production.sh` menerapkan permission berikut pada setiap eksekusi; untuk instalasi manual:

```bash
cd /opt/stream-router
install -m 600 .env.example .env   # hanya bila .env belum ada
mkdir -p data/logs backups
chmod 700 data backups
chmod 600 .env
chmod 600 data/*.db   # setelah npm run prisma:deploy membuat database
```

Bila `RECORDING_PATH` berada di luar `data/` (misalnya mount NAS), batasi folder tersebut ke user service, misalnya `sudo chown streamrouter:streamrouter /mnt/recordings && sudo chmod 700 /mnt/recordings`.

## 4. Nginx HTTPS

Contoh virtual host:

```nginx
server {
    listen 443 ssl http2;
    server_name stream-router.example.com;

    ssl_certificate /etc/letsencrypt/live/stream-router.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stream-router.example.com/privkey.pem;

    client_max_body_size 1m;

    # Hook recording hanya dipanggil MediaMTX melalui 127.0.0.1:3000, tidak lewat nginx.
    location /internal/ {
        return 404;
    }

    location /api/events {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID $request_id;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID $request_id;
    }
}
```

Set `.env`:

```env
NODE_ENV=production
HOST=127.0.0.1
CORS_ORIGIN=https://stream-router.example.com
TRUST_PROXY=true
MEDIAMTX_WEBRTC_PUBLIC_URL=https://webrtc.example.com
```

`TRUST_PROXY=true` hanya mempercayai proxy di host yang sama (127.0.0.1/::1). Bila nginx berada di host lain, isi IP/CIDR proxy tersebut, mis. `TRUST_PROXY=10.0.0.5`. Baris `X-Forwarded-For $remote_addr` wajib ada: header itu menimpa nilai kiriman client, sehingga rate limit login memakai IP client yang sebenarnya.

`MEDIAMTX_WEBRTC_PUBLIC_URL` adalah base URL player WebRTC yang disajikan nginx (bagian berikut). Variabel ini hanya dibaca dari `.env` dan tampil read-only di Settings sebagai **URL WebRTC publik**. Setelah mengubah `.env`, jalankan `npm run verify:env` lalu `pm2 reload ecosystem.config.cjs --env production`.

### WebRTC lewat HTTPS

Dashboard memutar video lokal dengan memuat halaman player MediaMTX di dalam iframe. URL bawaan `http://<MEDIAMTX_PUBLIC_HOST>:18889/cameras/<cameraKey>` diblokir browser sebagai *mixed content* bila dashboard dibuka lewat HTTPS. Karena itu player juga disajikan lewat nginx, dan base URL-nya diisi di `MEDIAMTX_WEBRTC_PUBLIC_URL`; dashboard lalu memakai `<MEDIAMTX_WEBRTC_PUBLIC_URL>/cameras/<cameraKey>/`. Yang lewat nginx hanya halaman player dan signaling WHEP (`POST` offer, `PATCH` kandidat ICE, `DELETE` sesi). Media tetap mengalir langsung lewat `18189/UDP` ke `MEDIAMTX_PUBLIC_HOST`, jadi di VPS isi `MEDIAMTX_PUBLIC_HOST` (atau **Public host/IP** di Settings) dengan IP publik server.

Terbitkan sertifikat untuk hostname WebRTC sebelum memasang virtual host-nya, karena nginx menolak start bila file `ssl_certificate` belum ada. Validasi HTTP-01 Let's Encrypt memerlukan port `80/tcp` yang dapat dijangkau dari internet (atau gunakan DNS-01):

```bash
sudo certbot certonly --nginx -d webrtc.example.com
```

Virtual host untuk hostname WebRTC:

```nginx
server {
    listen 443 ssl http2;
    server_name webrtc.example.com;

    ssl_certificate /etc/letsencrypt/live/webrtc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webrtc.example.com/privkey.pem;

    # WHEP hanya membawa SDP offer dan kandidat ICE (beberapa KB).
    client_max_body_size 64k;

    location / {
        # IP interface server, bukan 127.0.0.1 (lihat catatan di bawah).
        proxy_pass http://203.0.113.10:18889;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

**Alternatif satu hostname**: tambahkan location berikut ke virtual host dashboard di atas, lalu isi `MEDIAMTX_WEBRTC_PUBLIC_URL=https://stream-router.example.com/webrtc`:

```nginx
    location /webrtc/ {
        # Garis miring di akhir proxy_pass membuang prefix: /webrtc/cameras/<id>/ -> /cameras/<id>/.
        proxy_pass http://203.0.113.10:18889/;
        # Location dari MediaMTX berupa path absolut (/cameras/<id>/whep/<sesi>). Tanpa prefix
        # ini, PATCH/DELETE sesi WHEP jatuh ke dashboard.
        proxy_redirect / /webrtc/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        client_max_body_size 64k;
    }
```

Dashboard selalu membuka player dengan garis miring di akhir (`.../cameras/<id>/`). Dengan begitu MediaMTX tidak mengirim redirect, dan `reader.js` serta endpoint `whep` di-resolve relatif terhadap sub-path.

**Upstream bukan loopback.** Ganti `203.0.113.10` dengan IP interface server (`ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p'`). Jangan pakai `127.0.0.1`: MediaMTX memberi koneksi dari `127.0.0.1`/`::1` izin baca dan publish untuk semua path, karena izin itu dipakai relay FFmpeg dan transcode Opus. Bila nginx terhubung lewat loopback, setiap pengunjung ikut mendapat izin tersebut: kamera dengan Local Media OFF tetap dapat diputar, dan path `cameras/<id>/webrtc` dapat ditimpa lewat WHIP. Lewat IP interface, MediaMTX hanya menerapkan izin baca anonim per path. Port 18889 tetap tidak perlu dibuka di firewall, karena koneksi nginx ke IP server sendiri tidak keluar ke jaringan. Di Docker, upstream `127.0.0.1:18889` aman karena koneksi tiba di container dari IP gateway Docker ([DOCKER.md](DOCKER.md#reverse-proxy-https)).

Verifikasi setelah `sudo nginx -t && sudo systemctl reload nginx`:

- `curl -sS -o /dev/null -w '%{http_code}\n' https://webrtc.example.com/cameras/<cameraKey>/` menjawab `200` untuk route yang berjalan dengan Local Media ON; paling pasti, pakai **URL lokal** yang tampil di editor route. `401` berarti path itu tidak dibuka untuk baca anonim: Local Media OFF, atau route memakai audio lokal OPUS sehingga URL player-nya `.../cameras/<cameraKey>/webrtc/`. Gunakan GET, bukan `curl -I`, karena MediaMTX menjawab `HEAD` dengan `404`.
- Sub-path: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://stream-router.example.com/webrtc/cameras/<cameraKey>` menjawab `302` ke `https://stream-router.example.com/webrtc/cameras/<cameraKey>/`.
- Settings → MediaMTX & Recording menampilkan **URL WebRTC publik**, dan video lokal diputar tanpa peringatan *Mixed Content* di Console DevTools.

Player MediaMTX tidak memeriksa sesi dashboard, dan Viewer tidak memakai password. Siapa pun yang dapat menjangkau 443 kedua hostname dapat menonton route dengan Local Media ON, termasuk langsung lewat `https://webrtc.example.com/cameras/<cameraKey>/`. Bila kamera tidak boleh ditonton publik, batasi 443 ke jaringan admin/Viewer atau VPN (lihat [DOCKER.md](DOCKER.md#siapa-yang-dapat-menonton)).

## 5. Firewall

Control plane cukup membuka 443 dari jaringan admin, ditambah `80/tcp` dari internet bila sertifikat diterbitkan/diperpanjang lewat HTTP-01 Let's Encrypt. Port API tetap bind ke localhost. Untuk WebRTC lokal buka `18889/TCP` dan `18189/UDP` dari VLAN Viewer. Bila player disajikan nginx (`MEDIAMTX_WEBRTC_PUBLIC_URL`), Viewer cukup menjangkau `443/TCP` dan `18189/UDP`; `18889/TCP` tidak perlu dibuka. Control API `19997`, playback `19996`, dan metrics `19998` tidak boleh dibuka dari localhost. Pastikan server dapat keluar menuju endpoint RTMP/RTMPS dan dapat menjangkau kamera.

## 6. PM2

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
sudo env PATH="$PATH:$(dirname "$(command -v node)")" "$(command -v pm2)" startup systemd -u "$(id -un)" --hp "$HOME"
systemctl is-enabled "pm2-$(id -un)"
```

`pm2 startup` tanpa `sudo` hanya mencetak perintah dan tidak memasang apa pun. Tanpa boot service PM2, setelah reboot MediaMTX memang hidup kembali, tetapi YAML-nya tidak memuat path kamera (path dibuat oleh API), sehingga tidak ada kamera yang di-ingest, direkam, atau direlay sampai seseorang menjalankan `pm2 resurrect`. Untuk user tanpa `sudo`, admin menjalankan perintah di atas dengan `-u streamrouter --hp /home/streamrouter`.

`max_memory_restart` di `ecosystem.config.cjs` (1G) hanya pengaman kebocoran memori. Restart atau `pm2 stop` hanya menghentikan relay FFmpeg online dan bridge MQTT. Path MediaMTX tetap meng-ingest dan merekam kamera selama API mati, tetapi tanpa retention, storage guard, maupun indeks segment (hook gagal; scanner mengindeks file yang terlewat setelah API kembali). Saat API kembali, route auto-start diambil alih lagi, sedangkan path route lain yang dimulai manual dihapus.

PM2 hanya mengelola proses Node.js. Child process FFmpeg relay dikelola oleh Worker Manager dan dihentikan saat graceful shutdown. FFmpeg transcode Opus (path `cameras/{cameraKey}/webrtc`) adalah child process MediaMTX dan tetap berjalan selama path-nya ada. MediaMTX dikelola sebagai service systemd:

```bash
npm run media:ensure
npm run media:config
npm run media:install-service        # user dengan sudo
# atau, oleh admin untuk user tanpa sudo:
# sudo env PATH="$PATH" /usr/local/sbin/stream-router-mediamtx-service --user streamrouter --project-dir /opt/stream-router
sudo systemctl status mediamtx
```

Service berjalan sebagai user service non-root dengan `Restart=always`, membaca YAML dari `MEDIAMTX_CONFIG_PATH` di `.env` (sama dengan API), dan menulis output ke `data/logs/mediamtx.log`. Installer juga memasang `/etc/logrotate.d/stream-router-mediamtx` (10 MB, lima arsip, `copytruncate`) dan selalu me-restart unit agar binary/konfigurasi baru langsung dipakai.

## 7. Upgrade dan rollback

**Langkah satu kali untuk instalasi yang dibuat sebelum rilis ini.** Sebelum `pm2 reload`, samakan virtual host nginx dengan contoh di bagian 4:

- tambahkan `proxy_set_header X-Forwarded-For $remote_addr;` pada `location /api/events` dan `location /`;
- tambahkan tepat satu blok `location /internal/ { return 404; }`;
- uji dan muat ulang: `sudo nginx -t && sudo systemctl reload nginx`.

Bila nginx berjalan di host lain, isi `TRUST_PROXY` dengan IP/CIDR proxy tersebut. Tanpa baris `X-Forwarded-For`, nginx meneruskan header kiriman client apa adanya dan `TRUST_PROXY=true` memakainya sebagai IP client, sehingga rate limit login dapat dilewati dengan memalsukan header tersebut, dan seluruh client tanpa header berbagi satu batas koneksi realtime (127.0.0.1).

```bash
sqlite3 data/stream-router.db ".backup 'backups/pre-upgrade.db'"
chmod 600 backups/pre-upgrade.db
install -m 600 .env backups/pre-upgrade.env
npm ci
npm run prisma:deploy
npm run media:ensure
npm run build
npm run verify:env
npm run test
npm run test:integration
npm run smoke
npm run verify:dist
pm2 reload ecosystem.config.cjs --env production
npm run media:install-service
```

Jangan lanjut ke `pm2 reload` bila salah satu langkah gagal. `verify:env` memvalidasi `.env` dengan schema API yang sama; `verify:dist` menjalankan `apps/api/dist/server.js` dengan database sementara sampai `/api/health` menjawab. Tanpa keduanya, `.env` yang ditolak atau build yang tidak dapat dimuat Node baru ketahuan setelah `pm2 reload` mengganti proses yang berjalan dengan proses yang crash-loop.

Validasi `.env` kini lebih ketat; nilai yang dulu diam-diam dianggap `false` atau diterima apa adanya membuat API berhenti saat startup:

- Flag boolean (`MEDIAMTX_ENABLED`, `STREAM_VIEW_ALLOW_INSECURE_HTTP`) hanya menerima `true`/`1`/`yes`/`on` atau `false`/`0`/`no`/`off`/kosong, tanpa membedakan huruf besar-kecil.
- `TRUST_PROXY` menerima nilai boolean di atas (`true` = hanya proxy di host yang sama), preset `loopback`/`linklocal`/`uniquelocal`, atau daftar IP/CIDR dipisah koma. Jumlah hop (`TRUST_PROXY=2`) dan nama host (`localhost`) ditolak.
- `CORS_ORIGIN` wajib berupa origin `http(s)`, mis. `https://kamera.example.com`; path dan slash akhir dibuang otomatis, sedangkan `*` ditolak.

API terus menulis SQLite (hook recording, reconcile, status route), sehingga `cp` biasa terhadap file database yang sedang dipakai dapat menghasilkan backup rusak. `.backup` memakai online backup API SQLite dan konsisten walau API berjalan (pasang CLI dengan `sudo apt install sqlite3`). Tanpa `sqlite3`, hentikan API dulu: `pm2 stop stream-router`, salin database, lalu `pm2 start stream-router`. Selama API berhenti kamera tetap direkam oleh MediaMTX; segmentnya diindeks setelah API berjalan lagi.

`npm run media:install-service` menyalin binary versi `MEDIAMTX_VERSION` dari `.env` ke `/usr/local/bin` dan me-restart service; `systemctl restart mediamtx` saja tetap menjalankan binary lama. Untuk user tanpa `sudo`, admin menjalankan salinan installer milik root seperti pada bagian 1: `sudo env PATH="$PATH" /usr/local/sbin/stream-router-mediamtx-service --user streamrouter --project-dir /opt/stream-router` (perbarui salinannya setelah meninjau bila skrip berubah).

Rollback kode ke release sebelumnya, restore database hanya bila migration tidak backward-compatible, lalu reload PM2.

## 8. Pemeriksaan orphan

```bash
pgrep -a ffmpeg
pm2 status
systemctl status mediamtx
curl -sS http://127.0.0.1:3000/api/ready
```

Setelah `pm2 stop stream-router`, tidak boleh ada FFmpeg relay online yang tersisa. FFmpeg transcode Opus milik MediaMTX tetap berjalan bersama ingest dan recording sampai `sudo systemctl stop mediamtx`; bila dihentikan manual, MediaMTX menjalankannya lagi. Cocokkan PID dengan dashboard/log sebelum menghentikan proses secara manual.

API yang dihentikan tidak menghentikan recording: MediaMTX terus merekam kamera yang aktif tanpa retention dan storage guard, sehingga disk dapat penuh bila API mati lama. Untuk maintenance panjang, decommission, atau saat volume recording harus diam (mis. backup volume), hentikan juga MediaMTX dengan `sudo systemctl stop mediamtx` dan jalankan lagi sebelum API (`sudo systemctl start mediamtx`, lalu `pm2 start stream-router`).

## 9. Storage recording

Mount local disk/NAS sebelum service dimulai dan beri permission read/write hanya kepada user service (lihat bagian Permission). Pilih mount point melalui Settings lalu **Terapkan & Reload**. Backup database tidak termasuk file video; backup volume recording dilakukan terpisah. Lihat [MEDIAMTX_RECORDING.md](MEDIAMTX_RECORDING.md).
