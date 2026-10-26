#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Pemakaian:
  npm run media:install-service
      Dijalankan oleh user service non-root yang memiliki sudo.
  sudo /usr/local/sbin/stream-router-mediamtx-service --user streamrouter --project-dir /opt/stream-router
      Dijalankan admin untuk user service khusus yang tidak memiliki sudo, dari salinan
      skrip milik root (lihat docs/DEPLOYMENT.md bagian 1).

Opsi:
  --user USER         User service non-root yang menjalankan MediaMTX (wajib bila dijalankan root).
  --project-dir DIR   Folder project; default folder induk skrip ini.
USAGE
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Service systemd MediaMTX hanya dapat dipasang pada Linux." >&2
  exit 1
fi

target_user=""
project_dir_arg=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--project-dir memerlukan folder project." >&2; exit 1; }
      project_dir_arg="$2"
      shift 2
      ;;
    --project-dir=*)
      project_dir_arg="${1#--project-dir=}"
      shift
      ;;
    --user)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--user memerlukan nama user service." >&2; exit 1; }
      target_user="$2"
      shift 2
      ;;
    --user=*)
      target_user="${1#--user=}"
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
  if [[ -z "$target_user" ]]; then
    echo "MediaMTX tidak boleh berjalan sebagai root. Tentukan user service: sudo bash scripts/install-mediamtx-service.sh --user streamrouter" >&2
    exit 1
  fi
  service_user="$target_user"
  as_root() { "$@"; }
  as_service_user() { runuser -u "$service_user" -- "$@"; }
  # Skrip di folder project dimiliki user service; user itu dapat mengubah perintah yang
  # dijalankan sebagai root. Admin sebaiknya menjalankan salinan milik root yang sudah ditinjau.
  script_owner="$(stat -L -c %u "${BASH_SOURCE[0]}")"
  if [[ "$script_owner" != 0 ]]; then
    echo "Peringatan: skrip ini dimiliki UID $script_owner, bukan root, tetapi dijalankan sebagai root. Salin skrip ke lokasi milik root setelah meninjau isinya, lalu jalankan dengan --project-dir (docs/DEPLOYMENT.md bagian 1)." >&2
  fi
else
  if [[ -n "$target_user" && "$target_user" != "$(id -un)" ]]; then
    echo "--user $target_user hanya dapat dipakai bila skrip dijalankan admin dengan sudo." >&2
    exit 1
  fi
  service_user="$(id -un)"
  as_root() { sudo "$@"; }
  as_service_user() { "$@"; }
fi

if ! id -u "$service_user" >/dev/null 2>&1; then
  echo "User service $service_user tidak ditemukan." >&2
  exit 1
fi
if [[ "$(id -u "$service_user")" -eq 0 ]]; then
  echo "MediaMTX harus berjalan sebagai user service non-root, bukan $service_user." >&2
  exit 1
fi
service_group="$(id -gn "$service_user")"

project_dir="$(cd "${project_dir_arg:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"
cd "$project_dir"
[[ -f "$project_dir/scripts/ensure-mediamtx.mjs" ]] || {
  echo "$project_dir bukan folder project Camera Integration (scripts/ensure-mediamtx.mjs tidak ada)." >&2
  exit 1
}
command -v node >/dev/null || {
  echo "Node.js tidak ditemukan pada PATH. Bila memakai sudo, jalankan: sudo env PATH=\"\$PATH\" bash scripts/install-mediamtx-service.sh --user $service_user" >&2
  exit 1
}
[[ -d "$project_dir/node_modules/dotenv" ]] || {
  echo "Dependensi npm belum terpasang. Jalankan npm ci sebagai $service_user terlebih dahulu." >&2
  exit 1
}

# Unit systemd tidak dapat memuat tanda kutip/backslash/karakter kontrol dengan aman.
check_unit_path() {
  local label="$1" value="$2"
  if [[ "$value" != /* ]]; then
    echo "$label harus berupa path absolut: $value" >&2
    exit 1
  fi
  if [[ "$value" == *[\"\\]* || "$value" =~ [[:cntrl:]] ]]; then
    echo "$label memuat tanda kutip, backslash, atau karakter kontrol yang tidak didukung unit systemd: $value" >&2
    exit 1
  fi
}
# `%` adalah specifier systemd; `$` pada ExecStart diekspansi sebagai variabel environment.
unit_path() { printf '%s' "${1//\%/%%}"; }
exec_arg() {
  local value
  value="$(unit_path "$1")"
  printf '"%s"' "${value//\$/\$\$}"
}

as_service_user node "$project_dir/scripts/ensure-mediamtx.mjs"
binary_path="$(as_service_user node "$project_dir/scripts/ensure-mediamtx.mjs" --print-path | tail -1)"
# Path YAML mengikuti MEDIAMTX_CONFIG_PATH pada .env, sama seperti API dan run-mediamtx.
config_path="$(as_service_user node "$project_dir/scripts/run-mediamtx.mjs" --print-config-path | tail -1)"
log_dir="$project_dir/data/logs"
log_path="$log_dir/mediamtx.log"
check_unit_path "Folder project" "$project_dir"
check_unit_path "MEDIAMTX_CONFIG_PATH" "$config_path"

as_service_user node "$project_dir/scripts/run-mediamtx.mjs" --write-config-only

# Folder project dimiliki user service, jadi root tidak pernah membuat, chmod, atau menyalin
# file di sana dengan mengikuti symlink: symlink mediamtx.log -> /etc/shadow akan membuat root
# menyerahkan file tersebut ke user service. File log dibuat oleh user service sendiri.
as_service_user mkdir -p "$log_dir"
if [[ -L "$log_dir" || -L "$log_path" ]]; then
  echo "$log_dir atau mediamtx.log adalah symlink. Hapus symlink tersebut lalu jalankan ulang skrip." >&2
  exit 1
fi
[[ -e "$log_path" ]] || as_service_user install -m 0600 /dev/null "$log_path"
expected_log_path="$(realpath -e "$project_dir")/data/logs/mediamtx.log"
if [[ ! -f "$log_path" || "$(realpath -e "$log_path")" != "$expected_log_path" ]]; then
  echo "$log_path harus berupa file biasa di dalam folder project." >&2
  exit 1
fi
# systemd membuka target append: sebagai root, sehingga file lama dapat menjadi milik root.
# Kembalikan ke user service (API membacanya untuk halaman Terminal) tanpa mengikuti symlink.
if [[ "$(stat -c %U "$log_path")" != "$service_user" ]]; then
  as_root chown -h "$service_user:$service_group" "$log_path"
fi
as_service_user chmod 0600 "$log_path"

unit_workdir="$(unit_path "$project_dir")"
unit_log="$(unit_path "$log_path")"
unit_config_arg="$(exec_arg "$config_path")"

# Binary harus berasal dari cache .runtime project, dan dibaca sebagai user service: root tidak
# pernah menyalin file yang tidak dapat dibaca user tersebut ke /usr/local/bin yang world-readable.
runtime_dir="$(realpath -e "$project_dir")/.runtime/mediamtx/"
resolved_binary="$(realpath -e "$binary_path" 2>/dev/null || true)"
if [[ -z "$resolved_binary" || "$resolved_binary" != "$runtime_dir"* || ! -f "$resolved_binary" ]]; then
  echo "Binary MediaMTX harus berupa file biasa di dalam $runtime_dir: $binary_path" >&2
  exit 1
fi
staged_binary="$(as_root mktemp /usr/local/bin/.mediamtx.XXXXXX)"
if ! as_service_user cat "$resolved_binary" | as_root tee "$staged_binary" >/dev/null; then
  as_root rm -f "$staged_binary"
  echo "Gagal menyalin binary MediaMTX ke /usr/local/bin." >&2
  exit 1
fi
as_root chmod 0755 "$staged_binary"
as_root mv -f "$staged_binary" /usr/local/bin/mediamtx
as_root tee /etc/systemd/system/mediamtx.service >/dev/null <<EOF
[Unit]
Description=MediaMTX for Camera Integration
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$unit_workdir
ExecStart=/usr/local/bin/mediamtx $unit_config_arg
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=append:$unit_log
StandardError=append:$unit_log

[Install]
WantedBy=multi-user.target
EOF
as_root chmod 0644 /etc/systemd/system/mediamtx.service

# Output MediaMTX tidak masuk journald; tanpa rotasi file ini tumbuh tanpa batas.
# copytruncate aman karena systemd membuka target append: dengan O_APPEND.
logrotate_conf=/etc/logrotate.d/stream-router-mediamtx
if [[ -d /etc/logrotate.d ]]; then
  as_root tee "$logrotate_conf" >/dev/null <<EOF
# Dibuat oleh scripts/install-mediamtx-service.sh
"$log_path" {
    su $service_user $service_group
    size 10M
    rotate 5
    copytruncate
    compress
    delaycompress
    missingok
    notifempty
}
EOF
  as_root chmod 0644 "$logrotate_conf"
else
  echo "Peringatan: /etc/logrotate.d tidak ditemukan; $log_path tidak dirotasi otomatis. Pasang logrotate lalu jalankan ulang skrip ini." >&2
fi

as_root systemctl daemon-reload
as_root systemctl enable mediamtx
# restart, bukan enable --now: unit yang sudah berjalan harus memakai binary dan konfigurasi baru.
as_root systemctl restart mediamtx
as_root systemctl --no-pager status mediamtx
