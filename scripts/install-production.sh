#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Pemakaian: ./scripts/install-production.sh [--skip-system]

  (tanpa opsi)    Dijalankan user service non-root yang memiliki sudo. Memasang aplikasi,
                  service systemd MediaMTX, dan boot service PM2.
  --skip-system   Dijalankan user service tanpa sudo (mis. streamrouter). Hanya langkah
                  aplikasi; perintah sistem untuk admin dicetak di akhir.
USAGE
}

skip_system=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-system)
      skip_system=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Argumen tidak dikenal: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -eq 0 ]]; then
  echo "Jangan jalankan aplikasi sebagai root. Jalankan skrip sebagai user service non-root." >&2
  exit 1
fi
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
service_user="$(id -un)"

command -v node >/dev/null || { echo "Node.js 20+ belum tersedia" >&2; exit 1; }
command -v npm >/dev/null || { echo "npm belum tersedia bersama Node.js" >&2; exit 1; }
command -v pm2 >/dev/null || npm install -g pm2 || { echo "PM2 belum tersedia. Pasang sebagai admin: sudo npm install -g pm2" >&2; exit 1; }

if [[ ! -f .env ]]; then
  install -m 600 .env.example .env
  echo "File .env dibuat (mode 600). Isi AUTH_SECRET dan APP_ENCRYPTION_KEY dari 'npm run secrets:generate', ADMIN_PASSWORD, OPERATOR_PASSWORD, dan CORS_ORIGIN, lalu jalankan kembali." >&2
  exit 1
fi

# Nilai terakhir sebuah key di .env, mengikuti aturan dotenv (kutip, komentar #, export).
env_value() {
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" .env | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *) value="${value%%#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$value"
}

# Pemeriksaan awal secret sebelum npm ci/build. Validasi lengkap dengan schema API yang sama
# (`npm run verify:env`) dijalankan setelah build, sebelum PM2 me-reload proses yang berjalan.
env_errors=()
check_secret() {
  local key="$1" min_length="$2" value lower
  value="$(env_value "$key")"
  lower="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$value" ]]; then
    env_errors+=("$key belum diisi")
  elif [[ "$lower" == ganti_dengan_* || "$lower" == change-me* ]]; then
    env_errors+=("$key masih memakai nilai contoh")
  elif (( ${#value} < min_length )); then
    env_errors+=("$key minimal $min_length karakter")
  fi
}
check_secret AUTH_SECRET 32
check_secret APP_ENCRYPTION_KEY 32
check_secret ADMIN_PASSWORD 8
check_secret OPERATOR_PASSWORD 8
if (( ${#env_errors[@]} > 0 )); then
  echo "Konfigurasi .env belum siap untuk production:" >&2
  printf '  - %s\n' "${env_errors[@]}" >&2
  echo "Gunakan 'npm run secrets:generate' untuk AUTH_SECRET dan APP_ENCRYPTION_KEY." >&2
  exit 1
fi

cors_origin="$(env_value CORS_ORIGIN)"
if [[ "$cors_origin" != https://* ]]; then
  echo "Peringatan: CORS_ORIGIN=${cors_origin:-http://localhost:5173} bukan origin HTTPS. Pada production cookie login bersifat Secure dan request dari origin lain ditolak; buka dashboard melalui reverse proxy HTTPS dan set CORS_ORIGIN ke origin tersebut (docs/DEPLOYMENT.md)." >&2
fi

ffmpeg_path="$(env_value FFMPEG_PATH)"
ffmpeg_path="${ffmpeg_path:-ffmpeg}"
command -v "$ffmpeg_path" >/dev/null || { echo "FFmpeg belum tersedia: $ffmpeg_path (FFMPEG_PATH)" >&2; exit 1; }

# .env berisi AUTH_SECRET/APP_ENCRYPTION_KEY dan database berisi credential terenkripsi;
# keduanya tidak boleh terbaca user lokal lain. Diterapkan ulang pada setiap eksekusi.
mkdir -p data/logs backups
chmod 700 data backups
chmod 600 .env
secure_database_files() {
  local file
  for file in data/*.db data/*.db-journal data/*.db-wal data/*.db-shm; do
    if [[ -e "$file" ]]; then chmod 600 "$file"; fi
  done
}
recording_path="$(env_value RECORDING_PATH)"
if [[ "$recording_path" == /* && "$recording_path" != "$project_dir/data"/* ]]; then
  echo "Catatan: RECORDING_PATH=$recording_path berada di luar data/. Batasi akses folder tersebut ke user $service_user (mis. chmod 700)." >&2
fi

npm ci
npm run prisma:generate
npm run prisma:deploy
secure_database_files
npm run media:ensure
npm run media:config
npm run build
# Schema environment API yang sebenarnya: nilai yang ditolak (mis. TRUST_PROXY=2, CORS_ORIGIN=*)
# membuat proses baru crash-loop setelah `pm2 startOrReload`, jadi hentikan instalasi di sini.
npm run verify:env
npm run smoke
# Menjalankan dist/server.js dengan database sementara: kegagalan yang hanya muncul di build
# production (mis. resolusi modul Node ESM) tidak boleh sampai menggantikan proses yang berjalan.
npm run verify:dist
if [[ "$skip_system" == false ]]; then
  npm run media:install-service
fi

pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
pm2_bin="$(command -v pm2)"
node_dir="$(dirname "$(command -v node)")"
if [[ "$skip_system" == false ]]; then
  # Tanpa boot service PM2, setelah reboot tidak ada kamera yang di-ingest, direkam, atau
  # direlay: YAML MediaMTX tidak memuat path dan path hanya dibuat oleh API. `pm2 startup`
  # tanpa root hanya mencetak perintah, jadi jalankan langsung melalui sudo.
  sudo env PATH="$PATH:$node_dir" "$pm2_bin" startup systemd -u "$service_user" --hp "$HOME"
  systemctl is-enabled "pm2-$service_user" >/dev/null || {
    echo "Boot service pm2-$service_user belum aktif; API tidak akan kembali setelah reboot." >&2
    exit 1
  }
fi

api_host="$(env_value HOST)"
api_host="${api_host:-127.0.0.1}"
case "$api_host" in
  0.0.0.0|::|'[::]') api_host=127.0.0.1 ;;
esac
if [[ "$api_host" == *:* && "$api_host" != \[* ]]; then api_host="[$api_host]"; fi
api_port="$(env_value PORT)"
ready_url="http://$api_host:${api_port:-3000}/api/ready"
# Tanpa MediaMTX (--skip-system) /api/ready wajar bernilai 503; cukup pastikan API menjawab.
probe_mode=ready
if [[ "$skip_system" == true ]]; then probe_mode=listening; fi
# Exit 0 = siap, 3 = hanya storage recording di bawah batas aman (API dan MediaMTX berjalan),
# lainnya = belum siap. Tanpa sesi, /api/ready hanya menyebut nama pemeriksaan yang gagal.
probe_api() {
  node -e '
    const [url, mode] = process.argv.slice(1);
    fetch(url, { signal: AbortSignal.timeout(5000) })
      .then(async (response) => {
        if (response.ok || mode === "listening") process.exit(0);
        const body = await response.text();
        if (mode === "report") console.error(`HTTP ${response.status}: ${body.slice(0, 2000)}`);
        let failing = [];
        try { failing = JSON.parse(body).failing ?? []; } catch { failing = []; }
        if (failing.length === 1 && failing[0] === "mediaMtx.recordingStorage") process.exit(3);
        process.exit(2);
      })
      .catch((error) => {
        if (mode === "report") console.error(error.message);
        process.exit(1);
      });
  ' "$1" "$2"
}
echo "Menunggu API di $ready_url ..."
api_ready=false
storage_paused=false
for _ in $(seq 1 30); do
  probe_status=0
  probe_api "$ready_url" "$probe_mode" || probe_status=$?
  if (( probe_status == 0 )); then
    api_ready=true
    break
  fi
  if (( probe_status == 3 )); then
    # Storage guard bukan kegagalan instalasi: recording dipause sampai ruang kosong cukup.
    api_ready=true
    storage_paused=true
    break
  fi
  sleep 2
done
if [[ "$api_ready" != true ]]; then
  echo "API belum siap setelah 60 detik ($ready_url):" >&2
  probe_api "$ready_url" report || true
  echo "Penyebab rinci tercatat di log API ('Pemeriksaan kesiapan gagal'): pm2 logs stream-router --lines 100 --nostream" >&2
  exit 1
fi
secure_database_files
if [[ "$storage_paused" == true ]]; then
  echo "Peringatan: recording dipause karena ruang kosong di RECORDING_PATH berada di bawah batas aman Settings (default nilai terbesar antara 15% disk dan 20 GB). API dan MediaMTX berjalan; kosongkan ruang disk, pilih volume lain, atau turunkan batas di Settings, maka recording dilanjutkan otomatis." >&2
fi

echo "Instalasi selesai. API menjawab di $ready_url; buka dashboard melalui reverse proxy HTTPS ${cors_origin:-}."
if [[ "$skip_system" == true ]]; then
  echo
  echo "Langkah berikut wajib dijalankan admin (akun dengan sudo) agar MediaMTX berjalan dan PM2 kembali setelah reboot:"
  echo "  # Tinjau skrip lalu jalankan salinan milik root (user $service_user dapat mengubah file di folder project):"
  printf '  sudo install -m 0755 -o root -g root %q /usr/local/sbin/stream-router-mediamtx-service\n' "$project_dir/scripts/install-mediamtx-service.sh"
  printf '  sudo env PATH=%q /usr/local/sbin/stream-router-mediamtx-service --user %q --project-dir %q\n' "$PATH" "$service_user" "$project_dir"
  printf '  sudo env PATH=%q %q startup systemd -u %q --hp %q\n' "$PATH:$node_dir" "$pm2_bin" "$service_user" "$HOME"
fi
