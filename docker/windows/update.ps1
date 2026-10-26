#Requires -Version 5.1
<#
.SYNOPSIS
    Memperbarui Camera Integration (stream-router) yang berjalan di Docker Desktop untuk Windows.

.DESCRIPTION
    Langkah yang dijalankan:
      1. Memeriksa Docker Desktop (Linux containers, Compose v2), .env hasil setup.ps1, dan
         membatasi izin folder instalasi ke akun ini, SYSTEM, dan Administrators.
      2. Mengingatkan backup volume data (kecuali -Backup).
      3. docker compose pull (atau build / docker load) selagi container lama tetap berjalan.
      4. Dengan -Backup: hentikan container sebentar, backup volume data memakai image yang sedang
         dipakai container (tanpa mengunduh apa pun), lalu jalankan container lagi.
      5. docker compose up -d. Container hanya dibuat ulang bila image atau konfigurasi berubah;
         migration database dijalankan otomatis saat container mulai.
      6. Menunggu /api/health menjawab 200.
    Secret dan password tidak pernah dicetak ke layar.

.PARAMETER Backup
    Sebelum container dibuat ulang: hentikan container sebentar, simpan isi volume data (/app/data)
    ke .\backups\stream-router-data-<waktu>.tgz di folder instalasi, lalu jalankan container lagi.
    Backup memakai image container yang sedang berjalan, sehingga tetap berhasil tanpa akses
    registry (mis. bersama -ImageArchive). Image baru sudah diunduh/dimuat sebelum container dihentikan.

.PARAMETER BackupOnly
    Hanya membuat backup seperti -Backup, tanpa mengunduh image dan tanpa menjalankan update.

.PARAMETER Build
    Build image dari source. Hanya untuk checkout repository yang memiliki Dockerfile.

.PARAMETER ImageArchive
    File image hasil docker save (.tar atau .tar.gz) dari halaman Release, untuk update tanpa akses registry.

.PARAMETER Yes
    Lewati pertanyaan konfirmasi.

.PARAMETER HealthTimeoutSeconds
    Batas waktu menunggu /api/health menjawab 200. Default 180 detik.

.PARAMETER ProjectDir
    Folder berisi docker-compose.yml. Default: dicari otomatis dari lokasi script.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1 -Backup

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1 -BackupOnly
#>
[CmdletBinding()]
param(
    [switch]$Backup,
    [switch]$BackupOnly,
    [switch]$Build,
    [string]$ImageArchive,
    [switch]$Yes,
    [ValidateRange(30, 1800)]
    [int]$HealthTimeoutSeconds = 180,
    [string]$ProjectDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# File ini sengaja hanya berisi karakter ASCII: Windows PowerShell 5.1 membaca script tanpa BOM
# memakai code page ANSI, sehingga karakter non-ASCII dapat merusak parsing.

$ServiceName = 'stream-router'
$DashboardPort = 3000
# CREATOR OWNER, OWNER RIGHTS, dan TrustedInstaller tidak memberi akses ke akun lain.
$HarmlessAclSids = @('S-1-3-0', 'S-1-3-4', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host ('==> {0}' -f $Message) -ForegroundColor Cyan
}

function Write-Info([string]$Message) {
    Write-Host ('    {0}' -f $Message)
}

function Write-Ok([string]$Message) {
    Write-Host ('    {0}' -f $Message) -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host ('    PERINGATAN: {0}' -f $Message) -ForegroundColor Yellow
}

# Menjalankan program native tanpa membuat stderr menjadi error terminating (perilaku Windows
# PowerShell 5.1 bila $ErrorActionPreference = 'Stop'). Kode keluar selalu diperiksa pemanggil.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [switch]$CaptureOutput
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @()
    try {
        if ($CaptureOutput) {
            $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ })
        } else {
            & $FilePath @Arguments | Out-Host
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Invoke-Compose {
    param([string[]]$Arguments, [string]$FailureMessage)
    $result = Invoke-Native -FilePath 'docker' -Arguments (@('compose') + $Arguments)
    if ($result.ExitCode -ne 0) { throw $FailureMessage }
}

function Resolve-ProjectDir([string]$Explicit) {
    if ($Explicit) {
        $resolved = (Resolve-Path -LiteralPath $Explicit).ProviderPath
        if (-not (Test-Path -LiteralPath (Join-Path $resolved 'docker-compose.yml') -PathType Leaf)) {
            throw ('docker-compose.yml tidak ditemukan di "{0}".' -f $resolved)
        }
        return $resolved
    }
    # Bundle release: <folder>\windows\update.ps1. Repository: <repo>\docker\windows\update.ps1.
    $candidate = $PSScriptRoot
    for ($level = 0; $level -lt 3; $level++) {
        $candidate = Split-Path -Parent $candidate
        if (-not $candidate) { break }
        if (Test-Path -LiteralPath (Join-Path $candidate 'docker-compose.yml') -PathType Leaf) { return $candidate }
    }
    throw 'docker-compose.yml tidak ditemukan. Jalankan script dari folder instalasi atau gunakan -ProjectDir.'
}

function Get-EnvValue([string]$Path, [string]$Key) {
    $pattern = '^\s*(?:export\s+)?' + [regex]::Escape($Key) + '\s*=(.*)$'
    $value = $null
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $match = [regex]::Match($line, $pattern)
        if ($match.Success) { $value = $match.Groups[1].Value }
    }
    if ($null -eq $value) { return '' }
    $value = $value.Trim()
    if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        if (($first -eq "'" -or $first -eq '"') -and $value.EndsWith($first)) {
            return $value.Substring(1, $value.Length - 2)
        }
    }
    $comment = $value.IndexOf(' #')
    if ($comment -ge 0) { $value = $value.Substring(0, $comment).TrimEnd() }
    return $value
}

# Akun yang boleh mengakses folder instalasi dan file berisi secret: akun saat ini, pemilik folder
# instalasi (pemilik selalu dapat mengubah izin; berbeda bila script dijalankan "Run as administrator"
# dengan akun admin lain), SYSTEM, dan Administrators.
function Get-PrivateIdentities($Owner) {
    $list = New-Object 'System.Collections.Generic.List[System.Security.Principal.SecurityIdentifier]'
    $list.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
    if ($null -ne $Owner -and $Owner.IsAccountSid() -and -not $list.Contains($Owner)) { $list.Add($Owner) }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
        if (-not $list.Contains($identity)) { $list.Add($identity) }
    }
    return , $list
}

function Get-PathOwner([string]$Path) {
    try {
        return (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier])
    } catch {
        return $null
    }
}

# Set-Acl ikut menulis SACL (butuh SeSecurityPrivilege) bila ACL lama sudah diproteksi, sehingga gagal
# saat dijalankan ulang. API .NET hanya menulis DACL yang diubah.
function Set-PathAccessControl([string]$Path, $Security) {
    if ($Security -is [System.Security.AccessControl.DirectorySecurity]) {
        $target = [System.IO.DirectoryInfo]::new($Path)
    } else {
        $target = [System.IO.FileInfo]::new($Path)
    }
    if ($null -ne $target.GetType().GetMethod('SetAccessControl')) {
        # .NET Framework (Windows PowerShell 5.1).
        $target.SetAccessControl($Security)
    } else {
        # .NET (PowerShell 7): extension method dari System.IO.FileSystem.AccessControl.
        [System.IO.FileSystemAclExtensions]::SetAccessControl($target, $Security)
    }
}

# Hanya akun pada $Identities yang dapat membaca file backup (berisi secret).
function Protect-File([string]$Path, $Identities) {
    try {
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($identity in $Identities) {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                $identity,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            $acl.AddAccessRule($rule)
        }
        Set-PathAccessControl $Path $acl
    } catch {
        Write-Warn ('Izin file "{0}" tidak dapat dibatasi ({1}).' -f $Path, $_.Exception.Message)
    }
}

function Test-PrivateAcl($Acl, $Identities) {
    $allowed = @($Identities | ForEach-Object { $_.Value }) + $HarmlessAclSids
    foreach ($rule in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($allowed -notcontains $rule.IdentityReference.Value) { return $false }
    }
    return $true
}

# Izin hanya diubah pada folder khusus instalasi: bukan root drive, share jaringan, atau folder
# Windows/profil pengguna (mengubahnya ikut mengubah izin seluruh isinya).
function Test-DedicatedInstallDir([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.StartsWith('\\')) { return $false }
    $driveRoot = [System.IO.Path]::GetPathRoot($full)
    if (-not $driveRoot -or $full.Length -le $driveRoot.TrimEnd('\').Length) { return $false }
    $profileDir = [Environment]::GetFolderPath('UserProfile')
    $special = @(
        [Environment]::GetFolderPath('Windows'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('ProgramFilesX86'),
        [Environment]::GetFolderPath('CommonApplicationData'),
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('MyDocuments'),
        $profileDir
    )
    if ($profileDir) {
        $special += (Join-Path $profileDir 'Downloads')
        $special += (Split-Path -Parent $profileDir)
    }
    foreach ($folder in $special) {
        if (-not $folder) { continue }
        $candidate = ([string]$folder).TrimEnd('\')
        if ($full -ieq $candidate) { return $false }
        if ($candidate.StartsWith($full + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    }
    return $true
}

# Folder baru di C:\ mewarisi izin Modify untuk Authenticated Users. Tanpa pembatasan, akun lain di
# komputer ini dapat mengubah script, docker-compose.yml, atau menambah docker-compose.override.yml
# (dijalankan pada update berikutnya) dan membaca file backup berisi secret.
function Protect-InstallDir([string]$Path) {
    try {
        $acl = Get-Acl -LiteralPath $Path
        $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
        $identities = Get-PrivateIdentities $owner
        $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -ne $owner -and $owner.IsAccountSid() -and -not $owner.Equals($currentUser)) {
            $ownerName = $owner.Value
            try { $ownerName = $owner.Translate([System.Security.Principal.NTAccount]).Value } catch { $ownerName = $owner.Value }
            Write-Warn ('Folder instalasi dimiliki akun lain ({0}); pemilik folder selalu dapat mengubah izinnya.' -f $ownerName)
            Write-Info 'Pastikan akun tersebut tepercaya, atau pasang ulang di folder baru milik akun Anda.'
        }
        if (Test-PrivateAcl $acl $identities) {
            Write-Info 'Izin folder instalasi sudah terbatas (akun Anda, SYSTEM, Administrators).'
            return
        }
        if (-not (Test-DedicatedInstallDir $Path)) {
            Write-Warn ('Folder "{0}" dapat diakses akun lain, tetapi bukan folder khusus instalasi sehingga izinnya tidak diubah.' -f $Path)
            Write-Info 'Pindahkan instalasi ke folder tersendiri, mis. C:\stream-router atau %USERPROFILE%\stream-router.'
            return
        }
        $security = [System.Security.AccessControl.DirectorySecurity]::new()
        $security.SetAccessRuleProtection($true, $false)
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($identity in $identities) {
            $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                $identity,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                $inheritance,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
            $security.AddAccessRule($rule)
        }
        Set-PathAccessControl $Path $security
        Write-Ok 'Izin folder instalasi (beserta isinya) dibatasi ke akun Anda, SYSTEM, dan Administrators.'
    } catch {
        Write-Warn ('Izin folder instalasi tidak dapat dibatasi ({0}).' -f $_.Exception.Message)
        Write-Info 'Pastikan akun lain di komputer ini tidak dapat mengubah isi folder instalasi.'
    }
}

function Get-HostIPv4Addresses {
    $interNetwork = [System.Net.Sockets.AddressFamily]::InterNetwork
    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
        foreach ($unicast in $nic.GetIPProperties().UnicastAddresses) {
            if ($unicast.Address.AddressFamily -eq $interNetwork) { $unicast.Address.ToString() }
        }
    }
}

function Test-HealthEndpoint([string]$Url) {
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = 'GET'
        $request.Timeout = 5000
        $request.Proxy = $null
        $response = $request.GetResponse()
        try {
            return ([int]$response.StatusCode -eq 200)
        } finally {
            $response.Close()
        }
    } catch {
        return $false
    }
}

function Get-ContainerId {
    $ps = Invoke-Native -FilePath 'docker' -Arguments @('compose', 'ps', '-a', '-q', $ServiceName) -CaptureOutput
    if ($ps.ExitCode -ne 0) { return '' }
    $ids = @($ps.Output | Where-Object { $_ -match '^[0-9a-f]{12,64}$' })
    if ($ids.Count -eq 0) { return '' }
    return $ids[0]
}

function Get-ContainerField([string]$Template) {
    $id = Get-ContainerId
    if (-not $id) { return '' }
    $inspect = Invoke-Native -FilePath 'docker' -Arguments @('inspect', '--format', $Template, $id) -CaptureOutput
    if ($inspect.ExitCode -ne 0) { return '' }
    return ([string]($inspect.Output -join '')).Trim()
}

function Wait-ForHealth([string]$Url, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Write-Host -NoNewline '    '
    while ((Get-Date) -lt $deadline) {
        if (Test-HealthEndpoint $Url) {
            Write-Host ''
            return $true
        }
        $state = Get-ContainerField '{{.State.Status}}'
        if ($state -eq 'exited' -or $state -eq 'dead' -or $state -eq 'restarting') {
            Write-Host ''
            Write-Warn ('Container berstatus "{0}".' -f $state)
            return $false
        }
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 3
    }
    Write-Host ''
    return $false
}

function Show-RecentLogs {
    Write-Info ('Log terakhir (docker compose logs --tail 80 {0}):' -f $ServiceName)
    Invoke-Native -FilePath 'docker' -Arguments @('compose', 'logs', '--no-color', '--tail', '80', $ServiceName) | Out-Null
}

function Assert-DockerReady {
    if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'Perintah docker tidak ditemukan. Pasang Docker Desktop (backend WSL2), buka aplikasinya, lalu buka ulang PowerShell.'
    }
    $info = Invoke-Native -FilePath 'docker' -Arguments @('info', '--format', '{{.OSType}}') -CaptureOutput
    if ($info.ExitCode -ne 0) {
        throw 'Docker Desktop belum berjalan. Buka Docker Desktop, tunggu sampai status "Engine running", lalu ulangi.'
    }
    if (-not (@($info.Output | Where-Object { $_.Trim() -eq 'linux' }).Count -gt 0)) {
        throw 'Docker Desktop tidak memakai mode Linux containers. Klik kanan ikon Docker di system tray, pilih "Switch to Linux containers...", lalu ulangi.'
    }
    $compose = Invoke-Native -FilePath 'docker' -Arguments @('compose', 'version', '--short') -CaptureOutput
    if ($compose.ExitCode -ne 0) {
        throw 'Docker Compose v2 ("docker compose") tidak tersedia. Perbarui Docker Desktop.'
    }
    Write-Ok 'Docker Desktop siap (Linux containers, Compose v2).'
}

function Confirm-Continue([string]$Question) {
    if ($Yes) { return }
    $answer = ([string](Read-Host ('{0} [y/N]' -f $Question))).Trim()
    if ($answer -notmatch '^(y|ya|yes)$') { throw 'Update dibatalkan.' }
}

function Get-ContainerMount([string]$Destination) {
    $json = Get-ContainerField '{{json .Mounts}}'
    if (-not $json) { return $null }
    try {
        # Diassign dulu: Windows PowerShell 5.1 mengeluarkan array JSON sebagai satu objek.
        $mounts = $json | ConvertFrom-Json
        foreach ($mount in $mounts) {
            if ([string]$mount.Destination -eq $Destination) { return $mount }
        }
    } catch {
        return $null
    }
    return $null
}

# docker-compose.yml ditimpa setiap update dari zip release. Bind mount recording yang ditulis langsung
# di file itu (bukan di docker-compose.override.yml) hilang tanpa pesan dan recording baru masuk ke
# volume Docker. Pemeriksaan ini hanya memberi peringatan; kegagalan membaca konfigurasi diabaikan.
function Test-RecordingsMountKept {
    $current = Get-ContainerMount '/recordings'
    if ($null -eq $current) { return }
    try {
        if ([string]$current.Type -ne 'bind') { return }
        $source = [string]$current.Source
    } catch {
        return
    }
    $nextType = ''
    try {
        # Output memuat nilai .env (termasuk password) dan tidak pernah dicetak.
        $config = Invoke-Native -FilePath 'docker' -Arguments @('compose', 'config', '--format', 'json') -CaptureOutput
        if ($config.ExitCode -ne 0) { return }
        # Output juga memuat peringatan stderr Compose; ambil hanya blok JSON.
        $lines = @($config.Output)
        $config = $null
        $start = -1
        $end = -1
        for ($index = 0; $index -lt $lines.Count; $index++) {
            $text = ([string]$lines[$index]).Trim()
            if ($start -lt 0 -and $text.StartsWith('{')) { $start = $index }
            if ($start -ge 0 -and $text.EndsWith('}')) { $end = $index }
        }
        if ($start -lt 0 -or $end -lt $start) { return }
        $model = ($lines[$start..$end] -join "`n") | ConvertFrom-Json
        $lines = $null
        foreach ($volume in @($model.services.$ServiceName.volumes)) {
            if ([string]$volume.target -eq '/recordings') { $nextType = [string]$volume.type }
        }
        $model = $null
    } catch {
        return
    }
    if ($nextType -eq 'bind') { return }
    Write-Warn ('Container saat ini menyimpan recording di folder host (bind mount {0}),' -f $source)
    Write-Info 'tetapi docker-compose.yml/docker-compose.override.yml sekarang memakai volume Docker untuk /recordings.'
    Write-Info 'Bind mount yang ditulis langsung di docker-compose.yml hilang saat file itu ditimpa zip release.'
    Write-Info 'Pindahkan ke docker-compose.override.yml (README-WINDOWS.md, "Recording di folder Windows"),'
    Write-Info 'lalu jalankan script ini lagi agar recording baru tetap disimpan di folder tersebut.'
    Confirm-Continue 'Tetap lanjutkan dengan recording di volume Docker?'
}

# Image baru disiapkan selagi container lama tetap berjalan, sehingga backup dan docker compose up -d
# tidak perlu mengunduh apa pun saat container berhenti.
function Invoke-ImageFetch([string]$ArchivePath) {
    if ($Build) {
        Write-Step 'Build image dari source (docker compose build); container lama tetap berjalan'
        Invoke-Compose @('build', $ServiceName) 'docker compose build gagal. Periksa output di atas.'
    } elseif ($ArchivePath) {
        Write-Step 'Memuat image dari file (docker load); container lama tetap berjalan'
        $load = Invoke-Native -FilePath 'docker' -Arguments @('load', '-i', $ArchivePath)
        if ($load.ExitCode -ne 0) { throw 'docker load gagal. Pastikan file image utuh (cocokkan dengan SHA256SUMS.txt).' }
    } else {
        Write-Step 'Mengunduh image (docker compose pull); container lama tetap berjalan'
        Invoke-Compose @('pull', $ServiceName) 'docker compose pull gagal. Periksa koneksi internet, login registry (docker login ghcr.io) bila image privat, atau gunakan -ImageArchive.'
    }
}

function Invoke-DataBackup([string]$Root, [string]$ContainerImage, $Identities) {
    $backupDir = Join-Path $Root 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $fileName = 'stream-router-data-{0}.tgz' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
    $mount = '{0}:/backup' -f $backupDir
    $tar = @('tar', '-czf', ('/backup/' + $fileName), '-C', '/app/data', '.')
    $containerId = Get-ContainerId
    if ($containerId -and $ContainerImage) {
        # Image yang dipakai container sudah ada di komputer ini. docker compose run akan memakai image
        # dari docker-compose.yml yang mungkin sudah ditimpa versi baru, lalu mencoba mengunduhnya.
        $arguments = @('run', '--rm', '--volumes-from', $containerId, '-v', $mount, $ContainerImage) + $tar
    } else {
        # Tanpa container: volume data bernama tetap di docker-compose.yml, image sudah disiapkan.
        $arguments = @('compose', 'run', '--rm', '--no-deps', '-T', '-v', $mount, $ServiceName) + $tar
    }
    $wasRunning = ((Get-ContainerField '{{.State.Running}}') -eq 'true')
    Write-Info 'Menghentikan container sementara agar database SQLite konsisten...'
    Invoke-Compose @('stop', $ServiceName) 'docker compose stop gagal.'
    try {
        $result = Invoke-Native -FilePath 'docker' -Arguments $arguments
        if ($result.ExitCode -ne 0) { throw 'Backup volume data gagal; update tidak dilanjutkan.' }
    } finally {
        if ($wasRunning) {
            Write-Info 'Menjalankan container kembali...'
            Invoke-Native -FilePath 'docker' -Arguments @('compose', 'start', $ServiceName) | Out-Null
        } else {
            Write-Info 'Container tidak berjalan sebelum backup; dibiarkan berhenti.'
        }
    }
    $backupFile = Join-Path $backupDir $fileName
    Protect-File $backupFile $Identities
    Write-Ok ('Backup data: {0}' -f $backupFile)
    Write-Info 'File ini berisi database dan secret otomatis. Simpan di lokasi aman, terpisah dari komputer ini.'
}

function Invoke-Update([string]$HealthHost, [string]$PreviousImage, [string]$LanIp) {
    Write-Step 'Menerapkan update (docker compose up -d)'
    Invoke-Compose @('up', '-d', $ServiceName) 'docker compose up -d gagal. Periksa pesan di atas.'

    $healthUrl = 'http://{0}:{1}/api/health' -f $HealthHost, $DashboardPort
    Write-Step ('Menunggu {0} (maks. {1} detik)' -f $healthUrl, $HealthTimeoutSeconds)
    if (-not (Wait-ForHealth $healthUrl $HealthTimeoutSeconds)) {
        Show-RecentLogs
        Write-Info 'Rollback: isi STREAM_ROUTER_IMAGE di .env dengan tag versi sebelumnya lalu jalankan script ini lagi.'
        Write-Info 'Bila migration versi baru sudah berjalan, pulihkan juga backup volume data (README-WINDOWS.md).'
        throw 'Aplikasi belum sehat setelah update.'
    }

    $currentImage = Get-ContainerField '{{.Image}}'
    Write-Step 'Selesai'
    if ($PreviousImage -and $currentImage -eq $PreviousImage) {
        Write-Ok 'Image tidak berubah; aplikasi sudah memakai versi yang dirujuk docker-compose.yml/.env.'
    } else {
        Write-Ok 'Update diterapkan dan aplikasi sehat.'
        Write-Info 'Image lama dapat dihapus setelah aplikasi terverifikasi: docker image prune'
    }
    if ($LanIp) { Write-Ok ('Dashboard dari host lain: http://{0}:{1}' -f $LanIp, $DashboardPort) }
}

$exitCode = 0
$locationPushed = $false
try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Script ini untuk Windows. Untuk Linux/macOS ikuti docs/DOCKER.md.'
    }
    if ($Build -and $ImageArchive) { throw 'Gunakan salah satu: -Build atau -ImageArchive.' }
    if ($BackupOnly -and ($Build -or $ImageArchive)) { throw '-BackupOnly tidak dapat digabung dengan -Build atau -ImageArchive.' }

    $root = Resolve-ProjectDir $ProjectDir
    $archivePath = ''
    if ($ImageArchive) { $archivePath = (Resolve-Path -LiteralPath $ImageArchive).ProviderPath }
    if ($Build -and -not (Test-Path -LiteralPath (Join-Path $root 'Dockerfile') -PathType Leaf)) {
        throw 'Mode -Build hanya tersedia pada checkout repository (Dockerfile tidak ditemukan).'
    }
    Push-Location -LiteralPath $root
    $locationPushed = $true

    Write-Step 'Memeriksa Docker Desktop dan konfigurasi'
    Assert-DockerReady
    Protect-InstallDir $root
    $privateIdentities = Get-PrivateIdentities (Get-PathOwner $root)
    $envPath = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        throw '.env tidak ditemukan di folder instalasi. Jalankan windows\setup.ps1 terlebih dahulu.'
    }
    $lanIp = Get-EnvValue $envPath 'HOST_LAN_IP'
    $bindAddress = Get-EnvValue $envPath 'BIND_ADDRESS'
    if (-not $lanIp) {
        Write-Warn 'HOST_LAN_IP kosong di .env; WebRTC dari host lain tidak akan berjalan. Jalankan setup.ps1 lagi.'
    } elseif (@(Get-HostIPv4Addresses) -notcontains $lanIp) {
        Write-Warn ('HOST_LAN_IP={0} tidak lagi dimiliki komputer ini (IP berubah?). Jalankan setup.ps1 lagi' -f $lanIp)
        Write-Info 'atau buat reservasi DHCP di router agar IP Windows tetap. Bila "Public host/IP" di Settings >'
        Write-Info 'MediaMTX & Recording diisi manual, kosongkan agar mengikuti HOST_LAN_IP atau isi IP baru.'
    }

    $previousImage = Get-ContainerField '{{.Image}}'
    if (-not $previousImage) {
        Write-Warn 'Container stream-router belum ada (belum pernah dijalankan atau sudah dihapus).'
        Write-Info 'Untuk instalasi baru gunakan windows\setup.ps1. Volume data yang sudah ada tetap dipakai bila ada.'
        Confirm-Continue 'Tetap lanjutkan?'
    }

    $withBackup = ($Backup -or $BackupOnly)
    if (-not $BackupOnly) { Test-RecordingsMountKept }
    if (-not $withBackup) {
        Write-Step 'Backup'
        Write-Info 'Update menjalankan migration database yang tidak dapat dibatalkan. Buat backup volume data dulu:'
        Write-Info '  jalankan ulang script ini dengan -Backup, atau ikuti bagian "Backup dan restore" di README-WINDOWS.md.'
        Confirm-Continue 'Backup sudah tersedia dan lanjutkan update?'
    }

    # Urutan penting: image baru disiapkan sebelum container dihentikan untuk backup.
    if (-not $BackupOnly) { Invoke-ImageFetch $archivePath }

    if ($withBackup) {
        Write-Step 'Backup volume data'
        Invoke-DataBackup $root $previousImage $privateIdentities
    }

    if ($BackupOnly) {
        Write-Step 'Selesai'
        Write-Ok 'Mode -BackupOnly: update tidak dijalankan.'
    } else {
        $healthHost = '127.0.0.1'
        if ($bindAddress -and $bindAddress -ne '0.0.0.0' -and $bindAddress -ne '::') { $healthHost = $bindAddress }
        Invoke-Update $healthHost $previousImage $lanIp
    }
} catch {
    Write-Host ''
    Write-Host ('GAGAL: {0}' -f $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
