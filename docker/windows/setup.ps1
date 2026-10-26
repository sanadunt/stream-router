#Requires -Version 5.1
<#
.SYNOPSIS
    Menyiapkan dan menjalankan Camera Integration (stream-router) di Docker Desktop untuk Windows.

.DESCRIPTION
    Langkah yang dijalankan:
      1. Memeriksa Docker Desktop berjalan dalam mode Linux containers dan Docker Compose v2 tersedia.
      2. Membatasi izin folder instalasi ke akun ini, SYSTEM, dan Administrators.
      3. Membuat .env dari .env.example bila belum ada.
      4. Mendeteksi IPv4 LAN Windows (interface dengan default route, tanpa vEthernet/WSL/Hyper-V,
         loopback, dan APIPA) untuk HOST_LAN_IP, lalu meminta konfirmasi.
      5. Meminta ADMIN_PASSWORD dan OPERATOR_PASSWORD tanpa menampilkannya di layar.
      6. Opsional (-ConfigureFirewall): membuat rule inbound Windows Firewall profil Domain dan Private.
      7. docker compose pull (atau build / docker load), lalu docker compose up -d.
      8. Menunggu /api/health menjawab, memeriksa rule Block Windows Firewall untuk Docker Desktop
         Backend, lalu menampilkan URL dashboard untuk LAN.
    Secret dan password tidak pernah dicetak ke layar.

.PARAMETER Build
    Build image dari source alih-alih pull dari registry. Hanya untuk checkout repository yang memiliki Dockerfile.

.PARAMETER ImageArchive
    File image hasil docker save (.tar atau .tar.gz) dari halaman Release, untuk instalasi tanpa akses registry.

.PARAMETER HostLanIp
    IPv4 LAN Windows. Bila diisi, deteksi otomatis dan prompt konfirmasi dilewati.

.PARAMETER ChangePasswords
    Minta ulang ADMIN_PASSWORD dan OPERATOR_PASSWORD walaupun .env sudah berisi nilai yang valid.

.PARAMETER ConfigureFirewall
    Membuat rule inbound Windows Firewall (profil Domain dan Private) untuk port yang dipublikasikan,
    dan menawarkan menonaktifkan rule Block untuk Docker Desktop Backend (rule Block selalu menang atas
    rule Allow). Membutuhkan PowerShell "Run as administrator"; tanpa hak tersebut perintahnya hanya dicetak.

.PARAMETER HealthTimeoutSeconds
    Batas waktu menunggu /api/health menjawab 200. Default 180 detik.

.PARAMETER ProjectDir
    Folder berisi docker-compose.yml. Default: dicari otomatis dari lokasi script.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\setup.ps1 -ConfigureFirewall
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [string]$ImageArchive,
    [string]$HostLanIp,
    [switch]$ChangePasswords,
    [switch]$ConfigureFirewall,
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
$FirewallTcpPorts = @(3000, 18889, 18554, 18888, 11935)
$FirewallUdpPorts = @(18189, 18890)
$FirewallGroup = 'Stream Router'
$FirewallRuleTcp = 'Stream Router (TCP)'
$FirewallRuleUdp = 'Stream Router (UDP)'
# Profil Domain berlaku pada PC kantor yang tergabung domain; profil Public sengaja tidak dibuka.
$FirewallProfiles = 'Domain, Private'
# Port yang dipublikasikan Docker Desktop diterima di Windows oleh proses ini (Docker Desktop Backend).
$DockerBackendProgramPattern = '\\com\.docker\.backend\.exe$'
$DisableBlockRulesCommand = 'Get-NetFirewallRule -Direction Inbound -Action Block | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -like ''*\com.docker.backend.exe'' } | Disable-NetFirewallRule'
# CREATOR OWNER, OWNER RIGHTS, dan TrustedInstaller tidak memberi akses ke akun lain.
$HarmlessAclSids = @('S-1-3-0', 'S-1-3-4', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$PlaceholderPattern = '^(GANTI_DENGAN_|change-me)'
$ExcludedInterfacePattern = 'vEthernet|WSL|Hyper-V|Loopback|Docker|VirtualBox|VMware'

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
    # Bundle release: <folder>\windows\setup.ps1. Repository: <repo>\docker\windows\setup.ps1.
    $candidate = $PSScriptRoot
    for ($level = 0; $level -lt 3; $level++) {
        $candidate = Split-Path -Parent $candidate
        if (-not $candidate) { break }
        if (Test-Path -LiteralPath (Join-Path $candidate 'docker-compose.yml') -PathType Leaf) { return $candidate }
    }
    throw 'docker-compose.yml tidak ditemukan. Jalankan script dari folder hasil ekstrak release atau gunakan -ProjectDir.'
}

function Resolve-EnvExample([string]$Root) {
    foreach ($relative in @('docker\.env.example', '.env.example')) {
        $path = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        # .env.example di root repository adalah template development; template Docker memuat HOST_LAN_IP.
        $content = [System.IO.File]::ReadAllText($path)
        if ($content -match '(?m)^\s*#?\s*HOST_LAN_IP\s*=') { return $path }
    }
    throw 'Template .env.example untuk Docker (berisi HOST_LAN_IP) tidak ditemukan di folder instalasi.'
}

function Read-EnvLines([string]$Path) {
    $list = New-Object 'System.Collections.Generic.List[string]'
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) { $list.Add($line) }
    return , $list
}

# UTF-8 tanpa BOM dan akhir baris LF agar parser .env Docker Compose membaca key pertama dengan benar.
function Write-EnvLines([string]$Path, $Lines) {
    $content = [string]::Join("`n", $Lines.ToArray()) + "`n"
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Get-EnvValue($Lines, [string]$Key) {
    $pattern = '^\s*(?:export\s+)?' + [regex]::Escape($Key) + '\s*=(.*)$'
    $value = $null
    foreach ($line in $Lines) {
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

# Mengganti deklarasi terakhir (yang dipakai Compose) atau menambahkan baris baru.
function Set-EnvValue($Lines, [string]$Key, [string]$Value) {
    $pattern = '^\s*(?:export\s+)?' + [regex]::Escape($Key) + '\s*='
    $newLine = '{0}={1}' -f $Key, $Value
    for ($index = $Lines.Count - 1; $index -ge 0; $index--) {
        if ($Lines[$index] -match $pattern) {
            $Lines[$index] = $newLine
            return
        }
    }
    $Lines.Add($newLine)
}

# Akun yang boleh mengakses folder instalasi dan .env: akun saat ini, pemilik folder instalasi
# (pemilik selalu dapat mengubah izin; berbeda bila script dijalankan "Run as administrator" dengan
# akun admin lain), SYSTEM, dan Administrators.
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
# saat setup dijalankan ulang. API .NET hanya menulis DACL yang diubah.
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

# Hanya akun pada $Identities yang dapat membaca .env (berisi password).
function Protect-EnvFile([string]$Path, $Identities) {
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
        Write-Warn ('Izin file .env tidak dapat dibatasi ({0}). Pastikan folder instalasi tidak dapat dibaca pengguna lain.' -f $_.Exception.Message)
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
# (dijalankan pada setup/update berikutnya) dan membaca file backup berisi secret.
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

function Test-UsableLanIPv4([string]$Value) {
    if ($Value -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    $octets = @($Value.Split('.') | ForEach-Object { [int]$_ })
    foreach ($octet in $octets) { if ($octet -gt 255) { return $false } }
    if ($octets[0] -eq 0 -or $octets[0] -eq 127 -or $octets[0] -ge 224) { return $false }
    if ($octets[0] -eq 169 -and $octets[1] -eq 254) { return $false }
    return $true
}

function Test-ExcludedInterface([string]$Alias, [string]$Description) {
    return (($Alias -match $ExcludedInterfacePattern) -or ($Description -match $ExcludedInterfacePattern))
}

function Get-LanCandidatesFromNetTcpIp {
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction Stop)
    foreach ($route in $routes) {
        $index = [int]$route.InterfaceIndex
        $ipInterface = Get-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $ipInterface) { continue }
        if ([string]$ipInterface.ConnectionState -ne 'Connected') { continue }
        $alias = [string]$route.InterfaceAlias
        $description = ''
        $adapter = Get-NetAdapter -InterfaceIndex $index -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $adapter) { $description = [string]$adapter.InterfaceDescription }
        if (Test-ExcludedInterface $alias $description) { continue }
        $metric = [int]$route.RouteMetric + [int]$ipInterface.InterfaceMetric
        foreach ($address in @(Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
            $ip = [string]$address.IPAddress
            if ([string]$address.AddressState -ne 'Preferred') { continue }
            if (-not (Test-UsableLanIPv4 $ip)) { continue }
            [pscustomobject]@{ IPAddress = $ip; Interface = $alias; Metric = $metric }
        }
    }
}

function Get-LanCandidatesFromDotNet {
    $interNetwork = [System.Net.Sockets.AddressFamily]::InterNetwork
    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
        if ($nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
        if (Test-ExcludedInterface $nic.Name $nic.Description) { continue }
        $properties = $nic.GetIPProperties()
        $hasGateway = $false
        foreach ($gateway in $properties.GatewayAddresses) {
            if ($gateway.Address.AddressFamily -eq $interNetwork -and $gateway.Address.ToString() -ne '0.0.0.0') { $hasGateway = $true }
        }
        if (-not $hasGateway) { continue }
        foreach ($unicast in $properties.UnicastAddresses) {
            if ($unicast.Address.AddressFamily -ne $interNetwork) { continue }
            $ip = $unicast.Address.ToString()
            if (Test-UsableLanIPv4 $ip) { [pscustomobject]@{ IPAddress = $ip; Interface = $nic.Name; Metric = 0 } }
        }
    }
}

function Get-LanCandidates {
    $found = @()
    try {
        $found = @(Get-LanCandidatesFromNetTcpIp)
    } catch {
        try { $found = @(Get-LanCandidatesFromDotNet) } catch { $found = @() }
    }
    $seen = @{}
    foreach ($candidate in @($found | Sort-Object -Property Metric)) {
        if ($seen.ContainsKey($candidate.IPAddress)) { continue }
        $seen[$candidate.IPAddress] = $true
        $candidate
    }
}

function Select-HostLanIp([string]$Preset, [string]$Existing) {
    if ($Preset) {
        if (-not (Test-UsableLanIPv4 $Preset)) { throw ('-HostLanIp "{0}" bukan IPv4 LAN yang valid.' -f $Preset) }
        return $Preset
    }
    $candidates = @(Get-LanCandidates)
    $default = ''
    if ($candidates.Count -gt 0) {
        Write-Info 'IPv4 LAN terdeteksi (interface dengan default route):'
        foreach ($candidate in $candidates) { Write-Info ('  {0}  ({1})' -f $candidate.IPAddress, $candidate.Interface) }
        $default = $candidates[0].IPAddress
    } else {
        Write-Warn 'IPv4 LAN tidak terdeteksi otomatis. Lihat "IPv4 Address" adapter Wi-Fi/Ethernet pada output ipconfig.'
    }
    if ($Existing -and (Test-UsableLanIPv4 $Existing)) {
        if (-not $default) {
            $default = $Existing
        } elseif ($Existing -ne $default) {
            Write-Info ('HOST_LAN_IP di .env saat ini: {0}' -f $Existing)
        }
    }
    while ($true) {
        if ($default) {
            $answer = Read-Host ('HOST_LAN_IP [{0}] (Enter = pakai nilai ini)' -f $default)
        } else {
            $answer = Read-Host 'HOST_LAN_IP (IPv4 LAN Windows, mis. 192.168.1.10)'
        }
        $answer = ([string]$answer).Trim()
        if (-not $answer) { $answer = $default }
        if (Test-UsableLanIPv4 $answer) { return $answer }
        Write-Warn 'Masukkan IPv4 LAN yang valid (bukan 0.x, 127.x, 169.254.x, atau multicast).'
    }
}

function ConvertTo-PlainText([System.Security.SecureString]$Secure) {
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Test-ExistingPassword([string]$Value) {
    return ($Value.Length -ge 8 -and $Value -notmatch $PlaceholderPattern)
}

# Password ditulis dalam kutip tunggal agar Compose tidak menginterpolasi '$' atau memotong '#'.
function Get-PasswordProblem([string]$Value) {
    if ($Value.Length -lt 8) { return 'Password minimal 8 karakter.' }
    if ($Value -match $PlaceholderPattern) { return 'Password tidak boleh memakai nilai contoh (GANTI_DENGAN_...).' }
    if ($Value.Contains("'")) { return "Password tidak boleh mengandung tanda kutip tunggal (')." }
    if ($Value.EndsWith('\')) { return 'Password tidak boleh diakhiri garis miring terbalik (\).' }
    if ($Value -match '[\x00-\x1F\x7F]') { return 'Password tidak boleh mengandung karakter kontrol.' }
    if ($Value.Trim() -cne $Value) { return 'Password tidak boleh diawali atau diakhiri spasi.' }
    return ''
}

function Read-NewPassword([string]$Label) {
    while ($true) {
        $first = ConvertTo-PlainText (Read-Host -AsSecureString ('{0} (minimal 8 karakter)' -f $Label))
        $second = ConvertTo-PlainText (Read-Host -AsSecureString ('Ulangi {0}' -f $Label))
        if ($first -cne $second) {
            Write-Warn 'Kedua isian tidak sama. Ulangi.'
            continue
        }
        $problem = Get-PasswordProblem $first
        if ($problem) {
            Write-Warn $problem
            continue
        }
        return $first
    }
}

function Test-IsAdministrator {
    $principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FirewallCommands {
    $tcp = $FirewallTcpPorts -join ','
    $udp = $FirewallUdpPorts -join ','
    $profiles = $FirewallProfiles -replace ' ', ''
    return @(
        ("Remove-NetFirewallRule -DisplayName '{0}' -ErrorAction SilentlyContinue" -f $FirewallRuleTcp),
        ("New-NetFirewallRule -DisplayName '{0}' -Group '{1}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort {2} -Profile {3}" -f $FirewallRuleTcp, $FirewallGroup, $tcp, $profiles),
        ("Remove-NetFirewallRule -DisplayName '{0}' -ErrorAction SilentlyContinue" -f $FirewallRuleUdp),
        ("New-NetFirewallRule -DisplayName '{0}' -Group '{1}' -Direction Inbound -Action Allow -Protocol UDP -LocalPort {2} -Profile {3}" -f $FirewallRuleUdp, $FirewallGroup, $udp, $profiles)
    )
}

function Set-StreamRouterFirewall {
    $specs = @(
        @{ Name = $FirewallRuleTcp; Protocol = 'TCP'; Ports = $FirewallTcpPorts },
        @{ Name = $FirewallRuleUdp; Protocol = 'UDP'; Ports = $FirewallUdpPorts }
    )
    foreach ($spec in $specs) {
        $existing = @(Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue)
        if ($existing.Count -gt 0) { Remove-NetFirewallRule -DisplayName $spec.Name }
        $ports = [string[]]@($spec.Ports | ForEach-Object { [string]$_ })
        New-NetFirewallRule -DisplayName $spec.Name -Group $FirewallGroup `
            -Description 'Port Camera Integration (stream-router) di Docker Desktop.' `
            -Direction Inbound -Action Allow -Protocol $spec.Protocol -LocalPort $ports -Profile $FirewallProfiles | Out-Null
        Write-Ok ('Rule "{0}" dibuat: {1} {2}, profil {3}.' -f $spec.Name, $spec.Protocol, ($ports -join ','), $FirewallProfiles)
    }
}

# Prompt firewall untuk Docker Desktop Backend yang di-Cancel, atau muncul pada akun non-administrator,
# membuat rule Block inbound untuk program itu. Rule Block selalu menang atas rule Allow per port.
function Get-DockerBackendBlockRules {
    $candidates = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object {
        ([string]$_.Direction -eq 'Inbound') -and ([string]$_.Action -eq 'Block') -and
        ([string]$_.Enabled -eq 'True') -and ([string]$_.Profile -match 'Any|Domain|Private')
    })
    foreach ($rule in $candidates) {
        $programs = @($rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Program })
        if (@($programs | Where-Object { $_ -match $DockerBackendProgramPattern }).Count -gt 0) { $rule }
    }
}

function Show-DockerBackendBlockRules([bool]$CanDisable) {
    try {
        $blocked = @(Get-DockerBackendBlockRules)
    } catch {
        Write-Info 'Rule Block untuk Docker Desktop Backend tidak dapat diperiksa. Periksa manual di wf.msc > Inbound Rules.'
        return
    }
    if ($blocked.Count -eq 0) {
        Write-Info 'Tidak ada rule Block inbound Windows Firewall untuk Docker Desktop Backend.'
        Write-Info 'Bila Windows menampilkan prompt firewall untuk Docker Desktop Backend, pilih Allow dengan akun'
        Write-Info 'administrator; Cancel (atau prompt pada akun non-administrator) membuat rule Block.'
        return
    }
    Write-Warn ('Windows Firewall memiliki {0} rule Block inbound untuk Docker Desktop Backend:' -f $blocked.Count)
    foreach ($rule in $blocked) { Write-Info ('  "{0}" (profil {1})' -f $rule.DisplayName, $rule.Profile) }
    Write-Info 'Rule Block selalu menang atas rule Allow, sehingga host lain tetap tidak dapat membuka dashboard dan'
    Write-Info 'WebRTC walaupun rule "Stream Router" ada. Rule ini dibuat Windows saat prompt firewall Docker Desktop'
    Write-Info 'di-Cancel atau muncul pada akun non-administrator.'
    if ($CanDisable) {
        $answer = ([string](Read-Host 'Nonaktifkan rule Block tersebut? [y/N]')).Trim()
        if ($answer -match '^(y|ya|yes)$') {
            try {
                foreach ($rule in $blocked) { $rule | Disable-NetFirewallRule -ErrorAction Stop }
                Write-Ok 'Rule Block Docker Desktop Backend dinonaktifkan. Hapus permanen lewat wf.msc bila tidak diperlukan.'
                return
            } catch {
                Write-Warn ('Rule Block tidak dapat dinonaktifkan ({0}).' -f $_.Exception.Message)
            }
        }
    }
    Write-Info 'Nonaktifkan dari PowerShell "Run as administrator":'
    Write-Host ('      {0}' -f $DisableBlockRulesCommand)
    Write-Info 'atau wf.msc > Inbound Rules > rule "Docker Desktop Backend" bertanda Block > Disable Rule.'
}

function Show-NetworkProfileHint([string]$Ip) {
    try {
        $address = Get-NetIPAddress -IPAddress $Ip -ErrorAction Stop | Select-Object -First 1
        $connectionProfile = Get-NetConnectionProfile -InterfaceIndex ([int]$address.InterfaceIndex) -ErrorAction Stop | Select-Object -First 1
        $category = [string]$connectionProfile.NetworkCategory
        if ($category -eq 'DomainAuthenticated') {
            # Kategori jaringan domain ditentukan Windows (NLA) dan tidak dapat diubah ke Private.
            Write-Info ('Jaringan "{0}" berprofil Domain; rule firewall script ini mencakup profil Domain.' -f $connectionProfile.InterfaceAlias)
            Write-Info 'Bila port tetap tertutup, Group Policy kantor mungkin menonaktifkan rule firewall lokal'
            Write-Info '(local rule merging); minta tim IT membuka port tersebut lewat GPO.'
        } elseif ($category -ne 'Private') {
            Write-Warn ('Jaringan "{0}" berprofil {1}. Rule firewall hanya berlaku untuk profil Domain dan Private.' -f $connectionProfile.InterfaceAlias, $category)
            Write-Info 'Ubah di Settings > Network & Internet > (Wi-Fi/Ethernet) > Network profile type: Private,'
            Write-Info ('atau dari PowerShell administrator: Set-NetConnectionProfile -InterfaceIndex {0} -NetworkCategory Private' -f $address.InterfaceIndex)
        }
    } catch {
        Write-Info 'Profil jaringan tidak dapat diperiksa; pastikan jaringan LAN memakai profil Private (atau Domain di PC kantor).'
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

function Get-ContainerState {
    $ps = Invoke-Native -FilePath 'docker' -Arguments @('compose', 'ps', '-a', '-q', $ServiceName) -CaptureOutput
    if ($ps.ExitCode -ne 0) { return '' }
    $ids = @($ps.Output | Where-Object { $_ -match '^[0-9a-f]{12,64}$' })
    if ($ids.Count -eq 0) { return '' }
    $inspect = Invoke-Native -FilePath 'docker' -Arguments @('inspect', '--format', '{{.State.Status}}', $ids[0]) -CaptureOutput
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
        $state = Get-ContainerState
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
    $info = Invoke-Native -FilePath 'docker' -Arguments @('info', '--format', '{{.OSType}}|{{.KernelVersion}}') -CaptureOutput
    if ($info.ExitCode -ne 0) {
        throw 'Docker Desktop belum berjalan. Buka Docker Desktop, tunggu sampai status "Engine running", lalu ulangi.'
    }
    $line = @($info.Output | Where-Object { $_ -match '^\s*(linux|windows)\|' } | Select-Object -Last 1)
    if ($line.Count -eq 0) { throw 'Status Docker tidak dapat dibaca dari "docker info".' }
    $parts = $line[0].Trim().Split('|')
    if ($parts[0] -ne 'linux') {
        throw 'Docker Desktop memakai mode Windows containers. Klik kanan ikon Docker di system tray, pilih "Switch to Linux containers...", lalu ulangi.'
    }
    if ($parts.Count -lt 2 -or $parts[1] -notmatch 'WSL2') {
        Write-Warn 'Backend WSL2 tidak terdeteksi. Disarankan: Docker Desktop > Settings > General > "Use the WSL 2 based engine".'
    }
    $compose = Invoke-Native -FilePath 'docker' -Arguments @('compose', 'version', '--short') -CaptureOutput
    if ($compose.ExitCode -ne 0) {
        throw 'Docker Compose v2 ("docker compose") tidak tersedia. Perbarui Docker Desktop.'
    }
    Write-Ok ('Docker Desktop siap (Linux containers, Compose {0}).' -f ([string]($compose.Output -join '')).Trim())
}

function Test-VersionedFolderName([string]$Root) {
    $composeText = [System.IO.File]::ReadAllText((Join-Path $Root 'docker-compose.yml'))
    if ($composeText -match '(?m)^name\s*:') { return }
    # Tanpa `name:` Compose menamai project (dan volume) dari nama folder.
    $leaf = Split-Path -Leaf $Root
    if ($leaf -match '\d+\.\d+') {
        Write-Warn ('Nama folder "{0}" memuat nomor versi. Nama folder menentukan nama volume data Docker Compose;' -f $leaf)
        Write-Info 'gunakan folder tetap (mis. C:\stream-router) dan timpa isinya saat update agar data tidak terpisah.'
    }
}

$exitCode = 0
$locationPushed = $false
try {
    if ($env:OS -ne 'Windows_NT') {
        throw 'Script ini untuk Windows. Untuk Linux/macOS ikuti docs/DOCKER.md.'
    }
    if ($Build -and $ImageArchive) { throw 'Gunakan salah satu: -Build atau -ImageArchive.' }

    $root = Resolve-ProjectDir $ProjectDir
    $archivePath = ''
    if ($ImageArchive) { $archivePath = (Resolve-Path -LiteralPath $ImageArchive).ProviderPath }
    if ($Build -and -not (Test-Path -LiteralPath (Join-Path $root 'Dockerfile') -PathType Leaf)) {
        throw 'Mode -Build hanya tersedia pada checkout repository (Dockerfile tidak ditemukan). Bundle release memakai image dari registry.'
    }
    Push-Location -LiteralPath $root
    $locationPushed = $true

    Write-Step 'Memeriksa Docker Desktop'
    Assert-DockerReady
    Test-VersionedFolderName $root

    Write-Step 'Membatasi izin folder instalasi'
    Protect-InstallDir $root
    $privateIdentities = Get-PrivateIdentities (Get-PathOwner $root)

    Write-Step 'Menyiapkan .env'
    $envPath = Join-Path $root '.env'
    if (Test-Path -LiteralPath $envPath -PathType Leaf) {
        Write-Info ('Memakai .env yang sudah ada: {0}' -f $envPath)
    } else {
        $examplePath = Resolve-EnvExample $root
        Copy-Item -LiteralPath $examplePath -Destination $envPath
        Write-Ok ('.env dibuat dari {0}' -f $examplePath)
    }
    $lines = Read-EnvLines $envPath

    Write-Step 'Menentukan HOST_LAN_IP (alamat Windows yang dibuka dari host lain dan dipakai WebRTC)'
    $lanIp = Select-HostLanIp $HostLanIp (Get-EnvValue $lines 'HOST_LAN_IP')
    Set-EnvValue $lines 'HOST_LAN_IP' $lanIp
    Write-Ok ('HOST_LAN_IP = {0}' -f $lanIp)

    Write-Step 'Password bootstrap Administrator dan Operator'
    $passwordKeys = @(
        @{ Key = 'ADMIN_PASSWORD'; Label = 'Password Administrator' },
        @{ Key = 'OPERATOR_PASSWORD'; Label = 'Password Operator' }
    )
    foreach ($entry in $passwordKeys) {
        $current = Get-EnvValue $lines $entry.Key
        if (-not $ChangePasswords -and (Test-ExistingPassword $current)) {
            Write-Info ('{0} sudah terisi di .env; nilai lama dipertahankan (gunakan -ChangePasswords untuk mengganti).' -f $entry.Key)
            continue
        }
        $password = Read-NewPassword $entry.Label
        Set-EnvValue $lines $entry.Key ("'" + $password + "'")
        $password = $null
        Write-Ok ('{0} disimpan ke .env.' -f $entry.Key)
    }
    $current = $null
    Write-Info 'Password .env hanya dipakai saat database pertama kali dibuat. Setelah itu ganti melalui'
    Write-Info 'Settings > Keamanan Akun di dashboard (lihat README-WINDOWS.md / docs/WINDOWS.md).'
    if (-not (Get-EnvValue $lines 'AUTH_SECRET') -or -not (Get-EnvValue $lines 'APP_ENCRYPTION_KEY')) {
        Write-Info 'AUTH_SECRET/APP_ENCRYPTION_KEY yang kosong dibuat otomatis saat container pertama berjalan dan'
        Write-Info 'disimpan di volume data. Backup volume tersebut; tanpa key itu credential kamera tidak dapat dibuka.'
    }

    Write-EnvLines $envPath $lines
    Protect-EnvFile $envPath $privateIdentities
    $bindAddress = Get-EnvValue $lines 'BIND_ADDRESS'
    $localOnly = ($bindAddress -eq '127.0.0.1')
    $lines = $null

    Write-Step 'Windows Firewall'
    if ($ConfigureFirewall) {
        if (Test-IsAdministrator) {
            Set-StreamRouterFirewall
        } else {
            Write-Warn 'Hak administrator diperlukan. Jalankan perintah berikut di PowerShell "Run as administrator":'
            foreach ($command in Get-FirewallCommands) { Write-Host ('      {0}' -f $command) }
        }
    } else {
        Write-Info 'Dilewati. Gunakan -ConfigureFirewall (PowerShell administrator) bila host lain tidak dapat'
        Write-Info ('membuka dashboard atau WebRTC. Port: TCP {0}; UDP {1}.' -f ($FirewallTcpPorts -join ','), ($FirewallUdpPorts -join ','))
    }
    Show-NetworkProfileHint $lanIp

    if ($Build) {
        Write-Step 'Build image dari source (docker compose build)'
        Invoke-Compose @('build', $ServiceName) 'docker compose build gagal. Periksa output di atas.'
    } elseif ($archivePath) {
        Write-Step 'Memuat image dari file (docker load)'
        $load = Invoke-Native -FilePath 'docker' -Arguments @('load', '-i', $archivePath)
        if ($load.ExitCode -ne 0) { throw 'docker load gagal. Pastikan file image utuh (cocokkan dengan SHA256SUMS.txt).' }
    } else {
        Write-Step 'Mengunduh image (docker compose pull)'
        Invoke-Compose @('pull', $ServiceName) 'docker compose pull gagal. Periksa koneksi internet, login registry (docker login ghcr.io) bila image privat, atau gunakan -ImageArchive.'
    }

    Write-Step 'Menjalankan container (docker compose up -d)'
    Invoke-Compose @('up', '-d', $ServiceName) 'docker compose up -d gagal. Periksa pesan di atas (mis. port sudah dipakai).'

    $healthHost = '127.0.0.1'
    if ($bindAddress -and $bindAddress -ne '0.0.0.0' -and $bindAddress -ne '::') { $healthHost = $bindAddress }
    $healthUrl = 'http://{0}:{1}/api/health' -f $healthHost, $DashboardPort
    Write-Step ('Menunggu {0} (maks. {1} detik)' -f $healthUrl, $HealthTimeoutSeconds)
    if (-not (Wait-ForHealth $healthUrl $HealthTimeoutSeconds)) {
        Show-RecentLogs
        throw 'Aplikasi belum sehat. Periksa log di atas dan bagian Troubleshooting di README-WINDOWS.md.'
    }
    Write-Ok 'Aplikasi sehat.'

    if (-not $localOnly) {
        # Diperiksa setelah port dipublikasikan: prompt firewall Docker Desktop muncul saat itu.
        Write-Step 'Memeriksa rule Block Windows Firewall untuk Docker Desktop Backend'
        Show-DockerBackendBlockRules ([bool]($ConfigureFirewall -and (Test-IsAdministrator)))
    }

    Write-Step 'Selesai'
    Write-Ok ('Dashboard di komputer ini : http://localhost:{0}' -f $DashboardPort)
    if ($localOnly) {
        Write-Warn 'BIND_ADDRESS=127.0.0.1: dashboard hanya dapat dibuka dari komputer ini.'
    } else {
        Write-Ok ('Dashboard dari host lain : http://{0}:{1}' -f $lanIp, $DashboardPort)
    }
    Write-Info 'Login: username admin (atau ADMIN_USERNAME) dengan password yang Anda masukkan; Viewer tanpa password.'
    Write-Info 'Biarkan "Public host/IP" di Settings > MediaMTX & Recording kosong agar WebRTC mengikuti HOST_LAN_IP.'
    Write-Info 'Dashboard selalu dapat dibuka lewat IP dan localhost. Untuk membuka lewat nama komputer'
    Write-Info ('(mis. http://{0}:{1}), tambahkan nama itu ke ALLOWED_HOSTS di .env lalu jalankan docker compose up -d.' -f ([string]$env:COMPUTERNAME).ToLowerInvariant(), $DashboardPort)
} catch {
    Write-Host ''
    Write-Host ('GAGAL: {0}' -f $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
