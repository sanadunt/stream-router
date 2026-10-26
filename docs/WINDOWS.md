# Menjalankan di Windows dengan Docker Desktop

Panduan ini memasang Camera Integration (stream-router) di Windows 10/11 memakai Docker Desktop (backend WSL2) dari bundle GitHub Release. Satu container menjalankan dashboard + API, MediaMTX, dan FFmpeg; dashboard serta WebRTC dapat dibuka dari komputer lain di LAN.

Di dalam bundle release file ini bernama `README-WINDOWS.md`; link ke dokumen lain mengarah ke repository GitHub proyek.

## Gambaran singkat

```text
Kamera (LAN) ──RTSP──► container stream-router (Docker Desktop, WSL2)
                         ├─ supervisor (tini → container-supervisor.mjs)
                         │   ├─ MediaMTX: ingest, WebRTC, recording fMP4
                         │   └─ API + dashboard (Node.js): FFmpeg relay online
                         ├─ volume stream-router-data       → /app/data
                         └─ volume stream-router-recordings → /recordings
Windows host: port dipublikasikan di 0.0.0.0 → dibuka dari host lain via http://<HOST_LAN_IP>:3000
```

| Port di Windows | Fungsi | Dibutuhkan untuk |
|---|---|---|
| 3000/TCP | Dashboard + API | Selalu |
| 18889/TCP | WebRTC (WHEP) | Viewer WebRTC lokal |
| 18189/UDP | WebRTC ICE (media) | Viewer WebRTC lokal |
| 18554/TCP | RTSP MediaMTX | Pemutar/klien RTSP di LAN (opsional) |
| 18888/TCP | HLS MediaMTX | Klien HLS (opsional) |
| 11935/TCP | RTMP MediaMTX | Publish RTMP ke server ini (opsional) |
| 18890/UDP | SRT MediaMTX | Publish/baca SRT (opsional) |

Control API, playback, dan metrics MediaMTX tetap di `127.0.0.1` di dalam container dan tidak dipublikasikan.

## Persyaratan

- Windows 10 22H2 atau Windows 11, 64-bit (x86-64; Windows on ARM memakai image `arm64`).
- Virtualisasi aktif di BIOS/UEFI (Intel VT-x / AMD-V). Periksa di Task Manager → Performance → CPU → *Virtualization: Enabled*.
- WSL2. Bila belum ada, jalankan `wsl --install` di PowerShell administrator lalu restart.
- [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) versi terbaru dengan **Use the WSL 2 based engine** aktif dan mode **Linux containers** (default).
- RAM minimal 8 GB; ruang disk sesuai kebutuhan recording.
- IP LAN Windows sebaiknya tetap: buat reservasi DHCP di router atau set IP statis.
- Windows PowerShell 5.1 (bawaan Windows) atau PowerShell 7.

Periksa dari PowerShell:

```powershell
wsl --status
docker version
docker compose version
```

## Instalasi dari GitHub Release

1. Buka halaman **Releases** repository GitHub proyek (mis. `https://github.com/sanadunt/stream-router/releases`) dan unduh `stream-router-docker-<versi>.zip`. Opsional: unduh juga `SHA256SUMS.txt`, lalu cocokkan:

   ```powershell
   Get-FileHash .\stream-router-docker-<versi>.zip -Algorithm SHA256
   Select-String -Path .\SHA256SUMS.txt -Pattern 'stream-router-docker'
   ```

2. Ekstrak ke **folder tetap**, misalnya `C:\stream-router`. Folder ini menyimpan `.env` dan dipakai lagi saat update. Volume data bernama tetap (`stream-router-data`, `stream-router-recordings`) dan container bernama `stream-router`, sehingga satu komputer menjalankan satu instalasi.

   Folder baru di `C:\` mewarisi izin *Modify* untuk semua akun yang login ke Windows (*Authenticated Users*). Karena itu `setup.ps1` dan `update.ps1` membatasi izin folder instalasi beserta isinya, termasuk `backups\`, ke akun Anda, SYSTEM, dan Administrators. Tanpa pembatasan ini akun lain di komputer yang sama dapat mengubah script, `docker-compose.yml`, atau menambah `docker-compose.override.yml` yang ikut dijalankan saat update berikutnya, serta membaca file backup yang berisi secret.

   - Gunakan folder baru yang Anda buat sendiri khusus untuk instalasi ini. Bila folder dimiliki akun lain, script memberi peringatan: pemilik folder selalu dapat mengubah izinnya.
   - Izin root drive, share jaringan, dan folder Windows/profil (mis. `Downloads` atau `Desktop` itu sendiri) tidak diubah; script hanya memberi peringatan.
   - Alternatif: folder di profil Anda, mis. `%USERPROFILE%\stream-router`, yang secara default hanya dapat dibuka akun Anda, SYSTEM, dan Administrators.

   Isi folder:

   ```text
   C:\stream-router\
     docker-compose.yml     image ghcr.io/sanadunt/stream-router:<versi>
     .env.example           template konfigurasi
     README-WINDOWS.md      dokumen ini
     windows\setup.ps1      instalasi awal
     windows\update.ps1     update
   ```

3. Buka PowerShell di folder tersebut, lalu jalankan setup. Bentuk `-ExecutionPolicy Bypass` hanya berlaku untuk proses ini dan tidak mengubah policy sistem:

   ```powershell
   cd C:\stream-router
   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

   Untuk sekaligus membuat rule Windows Firewall, buka **Windows PowerShell (Run as administrator)** dan tambahkan `-ConfigureFirewall`.

4. Script akan:
   - memeriksa Docker Desktop berjalan dalam mode Linux containers dan Compose v2 tersedia;
   - membatasi izin folder instalasi (langkah 2);
   - membuat `.env` dari `.env.example` bila belum ada, lalu membatasi izin file `.env` ke akun Anda, SYSTEM, dan Administrators;
   - mendeteksi IPv4 LAN Windows (interface dengan default route, tanpa vEthernet/WSL/Hyper-V, loopback, dan APIPA `169.254.x.x`) dan meminta konfirmasi; tekan Enter untuk menerima atau ketik IP lain;
   - meminta password Administrator dan Operator dua kali tanpa menampilkannya (minimal 8 karakter, bukan nilai contoh, tanpa tanda kutip tunggal `'`). Password yang sudah valid di `.env` dipertahankan;
   - menjalankan `docker compose pull` lalu `docker compose up -d`;
   - menunggu `http://127.0.0.1:3000/api/health` menjawab, memeriksa rule Block Windows Firewall untuk *Docker Desktop Backend* (lihat [Windows Firewall](#windows-firewall)), lalu mencetak URL dashboard untuk LAN.

   Secret dan password tidak pernah dicetak ke layar. `AUTH_SECRET` dan `APP_ENCRYPTION_KEY` yang kosong dibuat otomatis oleh container saat pertama berjalan dan disimpan di volume data (`/app/data/secrets/stream-router.env`), lalu dipakai ulang pada start berikutnya.

5. Buka `http://localhost:3000` di Windows atau `http://<HOST_LAN_IP>:3000` dari komputer lain. Login Administrator memakai username `admin` dan password dari langkah 4; Viewer tidak memerlukan password.

### Parameter setup.ps1

| Parameter | Fungsi |
|---|---|
| `-ConfigureFirewall` | Membuat rule inbound Windows Firewall profil Domain dan Private, lalu menawarkan menonaktifkan rule Block *Docker Desktop Backend*. Membutuhkan PowerShell administrator; tanpa itu perintahnya dicetak. |
| `-HostLanIp 192.168.1.10` | Memakai IP ini tanpa deteksi dan prompt. |
| `-ChangePasswords` | Meminta ulang kedua password walaupun `.env` sudah berisi nilai valid. Setelah database dibuat, nilai `.env` hanya dipakai untuk recovery; lihat [Password](#password-administrator-dan-operator). |
| `-ImageArchive <file>` | Memuat image dari file release (`docker load`) alih-alih pull dari registry. |
| `-Build` | Build image dari source; hanya pada checkout repository yang memiliki `Dockerfile`. Lihat [Build dari clone Git di Windows](#build-dari-clone-git-di-windows). |
| `-HealthTimeoutSeconds 300` | Batas tunggu health check (default 180 detik). |
| `-ProjectDir <folder>` | Folder berisi `docker-compose.yml` bila script dijalankan dari lokasi lain. |

Script aman dijalankan ulang, misalnya setelah IP Windows berubah: nilai `.env` lain dipertahankan dan container dibuat ulang bila konfigurasi berubah.

### Build dari clone Git di Windows

`-Build` membangun image dari checkout repository (`docker\windows\setup.ps1 -Build`). Git for Windows secara default (`core.autocrlf=true`) mengubah akhir baris file teks menjadi CRLF saat checkout. Repository menyertakan `.gitattributes` yang memaksa LF, sehingga clone baru menghasilkan file yang sama dengan image GHCR. Clone yang dibuat sebelum `.gitattributes` ada tetap berisi CRLF sampai file di-checkout ulang. Periksa dari folder repository:

```powershell
git ls-files --eol -- Dockerfile scripts prisma docker | Select-String 'w/crlf'
```

Bila ada hasil, buat clone baru, atau checkout ulang semua file. `git reset --hard` membuang perubahan yang belum di-commit, jadi commit atau salin dulu perubahan lokal:

```powershell
git rm -r --cached -q .
git reset --hard
```

Checksum migration database dihitung dari isi yang dinormalisasi ke LF, sehingga volume data tetap dapat dipakai bergantian oleh image hasil `-Build` dan image GHCR. Script dan file lain ber-CRLF tetap membuat isi image berbeda dengan image GHCR.

### Isi .env

| Variable | Fungsi |
|---|---|
| `ADMIN_PASSWORD`, `OPERATOR_PASSWORD` | Password bootstrap; di-hash bcrypt saat database pertama kali dibuat. Wajib diisi, minimal 8 karakter. |
| `HOST_LAN_IP` | IPv4 LAN Windows. Dipakai sebagai `MEDIAMTX_PUBLIC_HOST` (URL WebRTC dan kandidat ICE) selama **Public host/IP** di Settings kosong. |
| `TZ` | Zona waktu container, default `Asia/Jakarta`. |
| `BIND_ADDRESS` | Alamat host untuk port yang dipublikasikan, default `0.0.0.0` (semua interface). `127.0.0.1` membatasi akses ke komputer ini saja. |
| `ALLOWED_HOSTS` | Opsional. Nama host lain untuk membuka dashboard, dipisah koma tanpa `http://` dan port, mis. `ALLOWED_HOSTS=PC-KAMERA,pc-kamera.local`. Akses lewat IP dan `localhost` selalu diterima; lihat [Membuka dari komputer lain](#membuka-dari-komputer-lain). |
| `STREAM_ROUTER_IMAGE` | Opsional. Menimpa image, mis. `ghcr.io/sanadunt/stream-router:1.2.0` atau `:latest`. |
| `AUTH_SECRET`, `APP_ENCRYPTION_KEY` | Opsional. Kosongkan agar dibuat otomatis dan disimpan di volume data. Jangan mengisi atau mengubahnya setelah instalasi berjalan kecuali sebagai bagian dari [rotasi](#rotasi-secret). |
| `PUBLIC_APP_NAME` | Nama aplikasi di dashboard. |
| `COOKIE_SECURE`, `TRUST_PROXY`, `CORS_ORIGIN` | Lanjutan, default `auto`, `false`, `http://localhost:3000`. Ubah hanya untuk reverse proxy HTTPS. |

`docker-compose.yml` menetapkan `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, `DATABASE_URL=file:/app/data/stream-router.db`, `MEDIAMTX_ENABLED=true`, `MEDIAMTX_CONFIG_PATH=data/mediamtx/mediamtx.yml`, dan `RECORDING_PATH=/recordings`; nilai ini menimpa `.env` karena volume dan port yang dipublikasikan bergantung padanya. Variable API lain (mis. `LOG_LEVEL`, `MAX_WORKERS`, `STREAM_VIEW_ALLOW_INSECURE_HTTP`) dapat ditambahkan ke `.env`.

Edit `.env` dengan Notepad bila perlu, lalu terapkan dengan `docker compose up -d` dari folder instalasi. Simpan sebagai UTF-8 (bukan "UTF-8 with BOM"); nilai yang memuat `$`, `#`, atau spasi ditulis dalam kutip tunggal, mis. `ADMIN_PASSWORD='Rahasia#2024$'`.

## Membuka dari komputer lain

- Dashboard: `http://<HOST_LAN_IP>:3000`. Request dari origin yang sama dengan alamat yang dibuka diterima walaupun `CORS_ORIGIN` bernilai `http://localhost:3000`.
- Alamat IP apa pun milik Windows (`http://<HOST_LAN_IP>:3000`, `http://127.0.0.1:3000`) dan `http://localhost:3000` selalu dapat dipakai tanpa konfigurasi. Nama host lain, mis. nama komputer Windows (`http://PC-KAMERA:3000`) atau nama `.local`, ditolak dengan `421 HOST_NOT_ALLOWED` untuk mencegah DNS rebinding (halaman internet yang me-resolve domainnya ke IP komputer ini). Tambahkan nama yang Anda pakai ke `ALLOWED_HOSTS` di `.env`, dipisah koma tanpa `http://` dan port, lalu terapkan dengan `docker compose up -d`. Nilai yang tidak valid membuat API gagal start; periksa `docker compose logs stream-router`.
- `COOKIE_SECURE=auto` membuat cookie login tanpa atribut Secure saat diakses lewat HTTP, sehingga login berfungsi di LAN. Konsekuensinya cookie sesi terkirim tanpa enkripsi: gunakan hanya di LAN tepercaya. Untuk akses jarak jauh gunakan VPN atau reverse proxy HTTPS (lihat [docs/DOCKER.md](DOCKER.md#reverse-proxy-https)); jangan meneruskan port 3000 dari router ke internet.
- Bila host lain tidak dapat membuka dashboard, periksa [Windows Firewall](#windows-firewall) (termasuk rule Block *Docker Desktop Backend*), profil jaringan, dan `BIND_ADDRESS`.

## Windows Firewall

Port yang dipublikasikan Docker Desktop diterima di Windows oleh proses *Docker Desktop Backend* (`com.docker.backend.exe`). Saat port pertama kali dipublikasikan, Windows dapat menampilkan prompt firewall untuk program tersebut:

- Jawab **Allow** dengan akun administrator.
- Bila prompt di-*Cancel*, atau muncul saat Anda login dengan akun non-administrator (apa pun pilihannya), Windows membuat rule **Block** inbound untuk *Docker Desktop Backend*. Rule Block selalu menang atas rule Allow, sehingga host lain tetap tidak dapat membuka dashboard dan WebRTC walaupun rule per port di bawah sudah ada.

Jalankan `setup.ps1 -ConfigureFirewall` dari PowerShell administrator. Script membuat rule Allow per port untuk profil Domain dan Private (rule lama dengan nama yang sama diganti), lalu setelah container sehat mencari rule Block *Docker Desktop Backend* dan menawarkan untuk menonaktifkannya. Tanpa `-ConfigureFirewall` atau tanpa hak administrator, script hanya melaporkan rule Block yang ditemukan dan mencetak perintahnya.

Rule per port manual (PowerShell administrator; baris pertama menghapus rule lama, mis. yang hanya berprofil Private):

```powershell
Remove-NetFirewallRule -Group 'Stream Router' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Stream Router (TCP)' -Group 'Stream Router' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000,18889,18554,18888,11935 -Profile Domain,Private
New-NetFirewallRule -DisplayName 'Stream Router (UDP)' -Group 'Stream Router' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 18189,18890 -Profile Domain,Private
```

### Rule Block Docker Desktop Backend

Memeriksa lalu menonaktifkan rule Block untuk *Docker Desktop Backend* (PowerShell administrator). Bila tidak ada rule Block inbound sama sekali, perintah pertama dapat menampilkan error *No MSFT_NetFirewallRule objects found*; artinya tidak ada yang perlu dinonaktifkan:

```powershell
$dockerBlock = Get-NetFirewallRule -Direction Inbound -Action Block | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -like '*\com.docker.backend.exe' }
$dockerBlock | Format-Table DisplayName, Enabled, Profile
$dockerBlock | Disable-NetFirewallRule
```

Lewat GUI: jalankan `wf.msc` → **Inbound Rules** → cari rule *Docker Desktop Backend* dengan ikon lingkaran merah (kolom *Action* = Block) → **Disable Rule**, atau **Delete** untuk menghapusnya. Rule *Docker Desktop Backend* ber-*Action* Allow tidak perlu diubah.

### Profil jaringan

Rule `Stream Router` berlaku untuk profil **Domain** dan **Private**, tidak untuk **Public**. Periksa profil dengan `Get-NetConnectionProfile`:

- `Public`: ubah di Settings → Network & Internet → Wi-Fi/Ethernet → *Network profile type* → Private, atau `Set-NetConnectionProfile -InterfaceIndex <n> -NetworkCategory Private` dari PowerShell administrator.
- `DomainAuthenticated` (PC kantor yang tergabung domain): profil ditentukan Windows dan tidak dapat diubah ke Private; rule `Stream Router` sudah mencakup profil Domain. Bila Group Policy kantor menonaktifkan rule firewall lokal (*local rule merging*), rule buatan script diabaikan; minta tim IT membuka port tersebut lewat GPO.

Port RTSP/HLS/RTMP/SRT yang tidak dipakai boleh dihapus dari rule. Menghapus semua rule `Stream Router`:

```powershell
Remove-NetFirewallRule -Group 'Stream Router'
```

## WebRTC

- `HOST_LAN_IP` wajib berisi IP LAN Windows (bukan IP container `172.x`, bukan `127.0.0.1`). Compose meneruskannya sebagai `MEDIAMTX_PUBLIC_HOST`, yang dipakai untuk URL WHEP dan sebagai kandidat ICE (`webrtcAdditionalHosts`) sehingga browser di host lain mengirim media ke `HOST_LAN_IP:18189/UDP`.
- Buka `18889/TCP` dan `18189/UDP`. ICE lewat TCP dinonaktifkan, jadi UDP `18189` wajib terbuka.
- **Public host/IP** di Settings → MediaMTX & Recording bersifat opsional. Bila kosong (field menampilkan `Otomatis: <HOST_LAN_IP>`), WebRTC mengikuti `HOST_LAN_IP`. Nilai hanya disimpan bila Anda mengisi host yang berbeda, mis. nama DNS; nilai yang sama dengan `HOST_LAN_IP` tidak disimpan. Nilai yang tersimpan selalu menang atas `HOST_LAN_IP`; kosongkan field lalu **Terapkan & Reload** untuk kembali mengikuti `HOST_LAN_IP`.
- Jangan mengubah port MediaMTX di Settings saat berjalan di Docker. Port yang dipublikasikan di `docker-compose.yml` tetap, sehingga port baru tidak dapat dijangkau dari luar container.
- Bila IP Windows berubah, jalankan `setup.ps1` lagi (atau ubah `HOST_LAN_IP` di `.env` lalu `docker compose up -d`). Bila **Public host/IP** di Settings masih berisi IP lama (mis. tersimpan oleh versi sebelumnya), kosongkan lalu **Terapkan & Reload**.
- Masalah codec dan audio dijelaskan di [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md#webrtc-lokal-tidak-bisa-dibuka-dari-komputer-lain).

## Recording di folder Windows

Secara default recording disimpan di volume `stream-router-recordings` di dalam disk virtual WSL2 Docker Desktop. Opsi ini paling cepat; file diputar dan diunduh melalui halaman Recording di dashboard.

Agar file langsung terlihat di Windows Explorer atau disimpan di drive lain, ganti volume dengan bind mount. Tentukan sebelum mulai merekam: berpindah lokasi tidak memindahkan file lama.

1. Buat folder, mis. `D:\StreamRouter\recordings`:

   ```powershell
   New-Item -ItemType Directory -Force -Path 'D:\StreamRouter\recordings'
   ```

2. Buat `docker-compose.override.yml` di folder instalasi (di samping `docker-compose.yml`). Docker Compose, `setup.ps1`, dan `update.ps1` membacanya otomatis, dan file ini tidak ada di zip release sehingga tidak tertimpa saat update:

   ```yaml
   services:
     stream-router:
       volumes:
         - type: bind
           source: D:/StreamRouter/recordings
           target: /recordings
   ```

3. Terapkan dengan `docker compose up -d`.

Jangan menulis bind mount langsung di `docker-compose.yml`. File itu ditimpa setiap kali zip release baru diekstrak, sehingga bind mount hilang tanpa pesan dan recording baru kembali masuk ke volume `stream-router-recordings`. Bila instalasi lama Anda mengubah `docker-compose.yml`, pindahkan bind mount ke `docker-compose.override.yml` sebelum update. `update.ps1` memberi peringatan dan meminta konfirmasi bila container yang berjalan memakai bind mount untuk `/recordings` tetapi konfigurasi baru tidak.

Catatan:

- Bind mount dari filesystem Windows melewati lapisan berbagi file WSL2 dan lebih lambat serta lebih berat di CPU dibanding volume. Untuk beberapa kamera umumnya cukup; untuk banyak kamera gunakan volume default atau SSD lokal. Hindari network drive dan disk USB yang dapat sleep.
- Real-time scan antivirus pada folder recording menambah beban setiap segment ditulis. Pengecualian folder di Windows Security adalah pertimbangan keamanan Anda sendiri.
- Storage guard mengukur ruang kosong filesystem tempat `/recordings` berada. Pada volume default itu adalah disk virtual WSL2 (dibatasi *Disk image size* di Docker Desktop → Settings → Resources), bukan sisa ruang drive `C:` yang sebenarnya. Atur retention kuota GB per kamera di Settings agar drive fisik tidak penuh.
- Tetap gunakan `/recordings` sebagai path recording di Settings. Path lain di dalam container tidak berada di volume dan hilang saat container dibuat ulang.
- Izin folder recording di luar folder instalasi tidak diubah script. Bila komputer dipakai bersama, batasi izinnya sendiri karena rekaman dapat dibuka akun lain.

## Batasan di Docker Desktop

- **ONVIF Discovery**: WS-Discovery multicast (`239.255.255.250:3702`) dari container tidak menjangkau LAN, sehingga **Scan Jaringan** tidak menemukan kamera. Gunakan input IP/host, port, TLS, dan service path manual pada wizard; inspect dan import tetap berjalan.
- **Tanpa host networking**: semua akses lewat port yang dipublikasikan pada tabel di atas.
- **IP klien**: Docker Desktop umumnya meneruskan koneksi dari satu alamat gateway internal, sehingga audit log tidak mencatat IP asli dan rate limit login per IP berlaku bersama untuk semua klien. Login Viewer memakai batas terpisah, dan browser yang pernah berhasil login sebagai Administrator/Operator memakai batas sendiri (cookie perangkat login). Percobaan password dari browser yang belum pernah login tetap berbagi batas 5 per menit, sehingga perangkat mana pun di LAN dapat membuat login dari browser seperti itu dijawab `429 RATE_LIMITED`; sesi yang sudah berjalan tidak terpengaruh. Detail di [docs/SECURITY.md](SECURITY.md).
- **Start setelah reboot**: Docker Desktop baru berjalan setelah pengguna login ke Windows. Aktifkan Docker Desktop → Settings → General → *Start Docker Desktop when you sign in*; container memakai `restart: unless-stopped` sehingga ikut berjalan setelah Docker siap. Untuk server rekaman, matikan sleep/hibernate dan pertimbangkan akun Windows khusus dengan login otomatis.
- **Resource**: transcoding FFmpeg memakai CPU (tanpa akselerasi GPU). Batas memori/CPU WSL2 diatur lewat `%UserProfile%\.wslconfig`.
- Port MediaMTX tetap seperti tabel di atas; jangan diubah dari Settings.

## Update

1. Unduh zip release baru dan ekstrak **menimpa** isi folder instalasi yang sama (`.env` tidak ada di dalam zip sehingga tidak tertimpa; `docker-compose.override.yml` milik Anda juga tetap, tetapi perubahan pada `docker-compose.yml` hilang).
2. Jalankan:

   ```powershell
   cd C:\stream-router
   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1 -Backup
   ```

   Urutan langkah dengan `-Backup`:

   1. Image baru diunduh (`docker compose pull`), atau dimuat/dibangun dengan `-ImageArchive`/`-Build`, selagi container lama tetap berjalan.
   2. Container dihentikan sebentar, isi volume data disimpan ke `backups\stream-router-data-<waktu>.tgz` memakai image yang sedang dipakai container (tanpa akses registry), lalu container dijalankan lagi.
   3. `docker compose up -d` membuat ulang container dengan image baru, lalu script menunggu health check. Migration database berjalan otomatis saat container mulai.

   Tanpa `-Backup`, script meminta konfirmasi bahwa backup sudah ada; `-Yes` melewati konfirmasi, `-ImageArchive <file>` memakai image offline, `-Build` membangun dari source, dan `-BackupOnly` hanya membuat backup tanpa mengunduh image. Script juga membatasi izin folder instalasi bila belum (instalasi dari versi lama) dan memperingatkan bila bind mount recording di `docker-compose.yml` lama hilang (lihat [Recording di folder Windows](#recording-di-folder-windows)).

`docker-compose.yml` dari release merujuk image versi tersebut. Untuk mengikuti versi terbaru tanpa mengunduh zip, isi `STREAM_ROUTER_IMAGE=ghcr.io/sanadunt/stream-router:latest` di `.env` lalu jalankan `update.ps1`. Setelah aplikasi terverifikasi, image lama dapat dihapus dengan `docker image prune`.

**Rollback**: isi `STREAM_ROUTER_IMAGE` dengan tag versi sebelumnya lalu jalankan `update.ps1`. Bila versi baru sudah menjalankan migration database, pulihkan juga backup data dari sebelum update (lihat bagian berikut) karena migration tidak dapat dibatalkan.

### Instalasi tanpa akses registry

Halaman Release juga menyediakan image `amd64` hasil `docker save`: `stream-router-image-<versi>-linux-amd64.tar.gz`. Image yang dimuat bertag sama dengan yang dirujuk `docker-compose.yml` di zip versi tersebut. Gunakan untuk host tanpa internet atau bila image GHCR privat:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1 -ImageArchive .\stream-router-image-<versi>-linux-amd64.tar.gz
```

Untuk update offline, gunakan parameter yang sama pada `update.ps1`. Image dimuat sebelum backup, dan backup memakai image yang sedang dipakai container, sehingga `-Backup` juga berjalan tanpa akses registry:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1 -Backup -ImageArchive .\stream-router-image-<versi>-linux-amd64.tar.gz
```

Bila image GHCR privat dan Anda ingin pull langsung, login dulu dengan `docker login ghcr.io` memakai Personal Access Token GitHub ber-scope `read:packages`.

## Backup dan restore

Yang perlu dibackup:

- Volume data `/app/data`: database SQLite, secret otomatis (`secrets/stream-router.env`), konfigurasi MediaMTX, dan log route.
- File `.env` (password bootstrap dan secret bila diisi manual).
- Volume atau folder recording bila file video juga harus disimpan; ukurannya besar sehingga biasanya dibackup terpisah.

Backup berisi `APP_ENCRYPTION_KEY`; tanpa key tersebut credential kamera di database tidak dapat dibuka. Simpan backup di lokasi aman dan terpisah dari komputer ini.

Backup tanpa update (container berhenti sebentar lalu berjalan lagi; hasilnya di `backups\` dan hanya dapat dibaca akun Anda, SYSTEM, dan Administrators):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1 -BackupOnly
```

Backup manual dari folder instalasi. Perintah ini memakai image yang sedang dipakai container (`docker inspect`), bukan image di `docker-compose.yml`, sehingga tidak mengunduh apa pun walaupun zip versi baru sudah diekstrak:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path .\backups | Out-Null
$image = docker inspect --format '{{.Image}}' stream-router
docker compose stop stream-router
docker run --rm --volumes-from stream-router -v "${PWD}\backups:/backup" $image tar -czf "/backup/stream-router-data-$stamp.tgz" -C /app/data .
docker compose start stream-router
```

Selama container berhenti, kamera tidak di-ingest maupun direkam. `backups\` mewarisi izin folder instalasi yang dibatasi `setup.ps1`; bila backup disalin ke lokasi lain, pastikan lokasi itu tidak dapat dibaca akun lain.

Restore (menimpa seluruh isi volume data dengan isi backup; container `stream-router` harus sudah dibuat oleh `setup.ps1`):

```powershell
$image = docker inspect --format '{{.Image}}' stream-router
docker compose stop stream-router
docker run --rm --volumes-from stream-router -v "${PWD}\backups:/backup:ro" $image sh -c 'find /app/data -mindepth 1 -delete && tar -xzf /backup/stream-router-data-YYYYMMDD-HHMMSS.tgz -C /app/data'
docker compose start stream-router
```

Pindah ke komputer lain: ekstrak bundle release yang sama ke folder baru, salin `.env` dan file backup ke folder tersebut, jalankan `setup.ps1` (memperbarui `HOST_LAN_IP` dan membuat container), lalu jalankan restore.

## Password Administrator dan Operator

- Setelah database dibuat, ganti password melalui **Settings → Keamanan Akun**. Perubahan langsung aktif dan mencabut sesi lama role terkait.
- Recovery bila password hilang: isi password baru di `.env` (atau `setup.ps1 -ChangePasswords`), terapkan dengan `docker compose up -d`, lalu jalankan:

  ```powershell
  docker compose exec stream-router node scripts/reset-auth-password.mjs --role all
  ```

  Ganti `all` dengan `admin` atau `operator` untuk satu role saja.

## Rotasi secret

Latar belakang dan pertimbangan keamanan ada di [docs/SECURITY.md](SECURITY.md#rotasi-key). Di Docker:

- Secret yang kosong di `.env` dibuat otomatis dan disimpan di volume data (`/app/data/secrets/stream-router.env`). Nilai di `.env` selalu didahulukan, sehingga menambahkan atau mengganti `APP_ENCRYPTION_KEY` di `.env` tanpa langkah rotasi membuat credential tersimpan tidak dapat dibuka; log container lalu memuat peringatan bahwa key dari environment berbeda dengan key tersimpan. `APP_ENCRYPTION_KEY` tidak pernah dibuat ulang otomatis bila database sudah ada.
- **AUTH_SECRET**:
  - Bila dibuat otomatis: hapus barisnya dari file secret lalu restart; nilai baru dibuat saat start.

    ```powershell
    docker compose run --rm --no-deps -T stream-router sed -i '/^AUTH_SECRET=/d' /app/data/secrets/stream-router.env
    docker compose restart stream-router
    ```

  - Bila diisi di `.env`: ganti dengan nilai baru lalu `docker compose up -d`. Nilai acak dapat dibuat dengan perintah berikut (mencetak dua nilai baru; pakai baris yang dibutuhkan saja):

    ```powershell
    docker compose run --rm --no-deps -T stream-router node scripts/generate-secrets.mjs
    ```

  Semua pengguna perlu login ulang.

- **APP_ENCRYPTION_KEY**:
  1. Buat backup data (`update.ps1 -BackupOnly`, lihat bagian sebelumnya).
  2. `docker compose stop stream-router`.
  3. Isi `APP_ENCRYPTION_KEY=<key baru>` di `.env` (nilai dari `generate-secrets.mjs`). Simpan key lama di password manager bila key lama berasal dari `.env`.
  4. Uji lalu jalankan re-enkripsi. Bila key lama berasal dari `.env`, script meminta key lama lewat prompt tersembunyi:

     ```powershell
     docker compose run --rm --no-deps stream-router node scripts/reencrypt-secrets.mjs --dry-run
     docker compose run --rm --no-deps stream-router node scripts/reencrypt-secrets.mjs
     ```

     Bila key lama dibuat otomatis, script dapat membacanya langsung dari file secret di volume tanpa menampilkannya:

     ```powershell
     docker compose run --rm --no-deps -T stream-router sh -c 'OLD_APP_ENCRYPTION_KEY=$(sed -n s/^APP_ENCRYPTION_KEY=//p /app/data/secrets/stream-router.env) node scripts/reencrypt-secrets.mjs --dry-run'
     docker compose run --rm --no-deps -T stream-router sh -c 'OLD_APP_ENCRYPTION_KEY=$(sed -n s/^APP_ENCRYPTION_KEY=//p /app/data/secrets/stream-router.env) node scripts/reencrypt-secrets.mjs'
     ```

  5. Bila key lama dibuat otomatis, samakan file secret dengan key baru agar backup volume data tetap memuat key yang benar dan peringatan key berbeda tidak muncul lagi:

     ```powershell
     docker compose run --rm --no-deps -T stream-router sh -c 'set -f; sed -i s/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY/ /app/data/secrets/stream-router.env'
     ```

  6. `docker compose up -d`, lalu periksa route, MQTT broker, PTZ, dan Stream View.
  7. Pertahankan `APP_ENCRYPTION_KEY` baru di `.env` dan backup `.env`. Script menyimpan salinan database sebelum rotasi di `/app/data/backups/`; hapus salinan itu dan backup lama setelah aplikasi terverifikasi karena masih dapat dibuka dengan key lama.

- Password Administrator/Operator: lihat bagian [Password](#password-administrator-dan-operator).

## Troubleshooting

### Login berhasil tetapi kembali ke halaman login

Cookie Secure tidak disimpan browser pada HTTP. Pastikan `COOKIE_SECURE` kosong/tidak diisi atau bernilai `auto` di `.env` (default compose `auto`), bukan `true`. Bila dashboard dibuka lewat reverse proxy HTTPS, proxy wajib mengirim `X-Forwarded-Proto` dan `TRUST_PROXY` harus mempercayai proxy tersebut.

### Port sudah dipakai atau tidak dapat di-bind

Pesan `port is already allocated` berarti aplikasi lain memakai port tersebut:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalAddress, OwningProcess
Get-Process -Id <OwningProcess>
```

Pesan `An attempt was made to access a socket in a way forbidden by its access permissions` biasanya berarti port masuk rentang yang dicadangkan Hyper-V/WinNAT:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
netsh interface ipv4 show excludedportrange protocol=udp
```

Bila port proyek berada di rentang tersebut, `net stop winnat` lalu `net start winnat` dari PowerShell administrator biasanya melepas reservasi; jalankan ulang `docker compose up -d`.

### Container unhealthy atau terus restart

```powershell
docker compose ps
docker compose logs --tail 200 stream-router
```

Baris log berawalan `[supervisor]` menjelaskan langkah start. Penyebab umum:

- `ADMIN_PASSWORD`/`OPERATOR_PASSWORD` kosong, kurang dari 8 karakter, atau masih nilai contoh; supervisor berhenti dengan pesan yang menyebut key tersebut. Perbaiki dengan `setup.ps1 -ChangePasswords`.
- `APP_ENCRYPTION_KEY tidak ditemukan, padahal database sudah ada`: file secret di volume data hilang. Pulihkan dari backup atau isi key lama di `.env`; key baru sengaja tidak dibuat.
- Peringatan key dari environment berbeda dengan key tersimpan: `APP_ENCRYPTION_KEY` di `.env` bukan key yang mengenkripsi database. Kembalikan nilai lama atau ikuti [rotasi](#rotasi-secret).
- Disk virtual Docker Desktop penuh.

Health check container memanggil `http://127.0.0.1:3000/api/health` dari dalam container.

### Dashboard terbuka di Windows tetapi tidak dari komputer lain

- Rule **Block** *Docker Desktop Backend* di Windows Firewall, yang dibuat saat prompt firewall di-*Cancel* atau muncul pada akun non-administrator, menang atas rule Allow per port. Periksa dan nonaktifkan sesuai [Rule Block Docker Desktop Backend](#rule-block-docker-desktop-backend), atau jalankan `setup.ps1 -ConfigureFirewall` dari PowerShell administrator.
- Rule `Stream Router` ada dan jaringan berprofil Private atau Domain ([Profil jaringan](#profil-jaringan)). Di PC kantor, Group Policy dapat menonaktifkan rule firewall lokal.
- `BIND_ADDRESS` kosong atau `0.0.0.0`.
- Komputer lain berada di subnet yang sama dan Wi-Fi tidak memakai *client/AP isolation* (umum di jaringan tamu).
- VPN di Windows dapat mengubah default route; jalankan `setup.ps1` lagi dan pilih IP adapter LAN.
- Dibuka lewat nama komputer dan dijawab `HOST_NOT_ALLOWED`: lihat bagian berikut.

### Pesan `HOST_NOT_ALLOWED` (HTTP 421)

Dashboard dibuka lewat nama host yang tidak ada di allowlist, mis. `http://PC-KAMERA:3000`. Buka lewat IP (`http://<HOST_LAN_IP>:3000`) atau `http://localhost:3000`, atau tambahkan nama tersebut ke `ALLOWED_HOSTS` di `.env` (dipisah koma, tanpa `http://` dan port, mis. `ALLOWED_HOSTS=PC-KAMERA,pc-kamera.local`) lalu jalankan `docker compose up -d`.

### WebRTC gagal dari komputer lain

- `18189/UDP` dan `18889/TCP` terbuka di firewall, dan tidak ada rule Block *Docker Desktop Backend*.
- `HOST_LAN_IP` masih sesuai IP Windows saat ini, dan **Public host/IP** di Settings kosong (`Otomatis: <HOST_LAN_IP>`) atau berisi host yang benar. Nilai yang tersimpan, termasuk IP lama dari versi sebelumnya, menang atas `HOST_LAN_IP`.
- Route berstatus READY dan Local Media aktif.

### Kamera tidak READY

Kamera dihubungi dari dalam container melalui NAT Docker Desktop. Uji dari container (hindari menyimpan password kamera di riwayat shell bersama):

```powershell
docker compose exec stream-router ffprobe -rtsp_transport tcp 'rtsp://user:password@192.168.1.64:554/stream'
```

Lihat juga [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md#rtsp-timeout).

### `docker compose pull` ditolak

Image GHCR privat atau tidak ada koneksi. Gunakan `docker login ghcr.io` atau `-ImageArchive` dengan file image dari halaman Release.

### Script PowerShell tidak dapat dijalankan

Pesan `running scripts is disabled on this system` muncul bila script dijalankan langsung (`.\windows\setup.ps1`). Gunakan bentuk `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1`.
