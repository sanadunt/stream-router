import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Skrip Windows tidak dapat dijalankan di CI Linux/macOS; tes ini menjaga urutan langkah dan pola
// yang memperbaiki temuan review (backup sebelum image tersedia, izin folder, rule Block firewall).
// Bila PowerShell 7 (pwsh) tersedia, kedua skrip juga diperiksa parser PowerShell.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const setupPath = path.join(rootDir, 'docker/windows/setup.ps1');
const updatePath = path.join(rootDir, 'docker/windows/update.ps1');
const setup = readFileSync(setupPath, 'utf8');
const update = readFileSync(updatePath, 'utf8');
const scripts = [['setup.ps1', setupPath], ['update.ps1', updatePath]] as const;

/** Isi fungsi PowerShell dari `function Nama` sampai kurung kurawal penutup di kolom pertama. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^function ${name}\\b`, 'm'));
  if (start === -1) throw new Error(`Fungsi ${name} tidak ditemukan`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

/** Blok utama skrip, setelah semua definisi fungsi. */
function mainBlock(source: string): string {
  const start = source.indexOf('\n$exitCode = 0\n');
  if (start === -1) throw new Error('Blok utama skrip tidak ditemukan');
  return source.slice(start);
}

function positionOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  expect(index, `"${needle}" tidak ditemukan`).toBeGreaterThanOrEqual(0);
  return index;
}

function codeWithoutComments(source: string): string {
  return source.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
}

const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8',
  shell: false
}).status === 0;

describe('skrip Windows Docker Desktop', () => {
  it.each(scripts)('%s hanya berisi ASCII dan akhir baris LF (dibaca Windows PowerShell 5.1 tanpa BOM)', (_name, file) => {
    const bytes = readFileSync(file);
    expect(bytes.findIndex((byte) => byte >= 0x80)).toBe(-1);
    expect(bytes.includes(0x0d)).toBe(false);
  });

  for (const [name, file] of scripts) {
    it.skipIf(!pwshAvailable)(`${name} lolos parser PowerShell`, () => {
      const script = [
        '$tokens = $null; $errors = $null',
        '[void][System.Management.Automation.Language.Parser]::ParseFile($env:STREAM_ROUTER_PS1, [ref]$tokens, [ref]$errors)',
        '$errors | ForEach-Object { "{0}: {1}" -f $_.Extent.StartLineNumber, $_.Message }'
      ].join('; ');
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        shell: false,
        env: { ...process.env, STREAM_ROUTER_PS1: file }
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });
  }

  it('update.ps1 menyiapkan image baru sebelum container dihentikan untuk backup', () => {
    const main = mainBlock(update);
    const fetch = positionOf(main, 'Invoke-ImageFetch $archivePath');
    const backup = positionOf(main, 'Invoke-DataBackup $root $previousImage');
    const apply = positionOf(main, 'Invoke-Update $healthHost');
    expect(fetch).toBeLessThan(backup);
    expect(backup).toBeLessThan(apply);
    expect(functionBody(update, 'Invoke-ImageFetch')).toMatch(/'pull'/);
    // Setelah backup tidak ada lagi pull/load/build: up -d memakai image yang sudah disiapkan.
    expect(functionBody(update, 'Invoke-Update')).not.toMatch(/'pull'|'load'|'build'/);
  });

  it('backup update.ps1 memakai image container yang sedang berjalan, bukan image docker-compose.yml', () => {
    const body = functionBody(update, 'Invoke-DataBackup');
    expect(body).toContain("@('run', '--rm', '--volumes-from', $containerId, '-v', $mount, $ContainerImage) + $tar");
    // docker compose run hanya dipakai bila container belum ada (cabang else).
    expect(body.indexOf("'compose', 'run'")).toBeGreaterThan(body.indexOf('} else {'));
    expect(body).toContain('Protect-File $backupFile $Identities');
  });

  it('setup.ps1 dan update.ps1 membatasi izin folder instalasi tanpa Set-Acl', () => {
    const setupMain = mainBlock(setup);
    expect(positionOf(setupMain, 'Protect-InstallDir $root')).toBeLessThan(positionOf(setupMain, 'Write-EnvLines $envPath'));
    expect(setupMain).toContain('Protect-EnvFile $envPath $privateIdentities');
    const updateMain = mainBlock(update);
    expect(positionOf(updateMain, 'Protect-InstallDir $root')).toBeLessThan(positionOf(updateMain, 'Invoke-DataBackup $root'));
    for (const source of [setup, update]) {
      const body = functionBody(source, 'Protect-InstallDir');
      expect(body).toContain('SetAccessRuleProtection($true, $false)');
      expect(body).toContain("[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'");
      expect(body).toContain('Test-DedicatedInstallDir $Path');
      // Set-Acl ikut menulis SACL bila ACL lama sudah diproteksi dan gagal tanpa SeSecurityPrivilege.
      expect(codeWithoutComments(source)).not.toMatch(/\bSet-Acl\b/);
    }
  });

  it.each(['Get-PrivateIdentities', 'Set-PathAccessControl', 'Test-PrivateAcl', 'Test-DedicatedInstallDir', 'Protect-InstallDir'])(
    'fungsi ACL %s identik di setup.ps1 dan update.ps1',
    (name) => {
      expect(functionBody(update, name)).toBe(functionBody(setup, name));
    }
  );

  it('rule firewall mencakup profil Domain dan Private, dan rule Block Docker Desktop Backend diperiksa setelah container sehat', () => {
    expect(setup).toContain("$FirewallProfiles = 'Domain, Private'");
    expect(setup).not.toMatch(/-Profile Private\b/);
    expect(functionBody(setup, 'Set-StreamRouterFirewall')).toContain('-Profile $FirewallProfiles');
    expect(functionBody(setup, 'Get-FirewallCommands')).toContain('-Profile {3}');
    const blockRules = functionBody(setup, 'Get-DockerBackendBlockRules');
    expect(blockRules).toContain("[string]$_.Direction -eq 'Inbound'");
    expect(blockRules).toContain("[string]$_.Action -eq 'Block'");
    expect(blockRules).toContain('Get-NetFirewallApplicationFilter');
    expect(functionBody(setup, 'Show-DockerBackendBlockRules')).toContain('Disable-NetFirewallRule');
    const main = mainBlock(setup);
    expect(positionOf(main, 'Wait-ForHealth $healthUrl')).toBeLessThan(positionOf(main, 'Show-DockerBackendBlockRules'));
    // Kategori DomainAuthenticated tidak dapat diubah dengan Set-NetConnectionProfile.
    const hint = functionBody(setup, 'Show-NetworkProfileHint');
    expect(positionOf(hint, "'DomainAuthenticated'")).toBeLessThan(positionOf(hint, 'Set-NetConnectionProfile'));
  });

  it('pola program mengenali Docker Desktop Backend pada filter aplikasi firewall', () => {
    const pattern = /\$DockerBackendProgramPattern = '([^']+)'/.exec(setup)?.[1];
    expect(pattern).toBeDefined();
    // Operator -match PowerShell tidak peka huruf besar/kecil.
    const program = new RegExp(pattern!, 'i');
    expect(program.test('C:\\Program Files\\Docker\\Docker\\resources\\com.docker.backend.exe')).toBe(true);
    expect(program.test('%ProgramFiles%\\Docker\\Docker\\resources\\COM.DOCKER.BACKEND.EXE')).toBe(true);
    expect(program.test('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe')).toBe(false);
    expect(program.test('C:\\tools\\notcom.docker.backend.exe')).toBe(false);
  });

  it.each(['docs/WINDOWS.md', 'docs/DOCKER.md'])('%s: backup dan restore manual tidak memakai docker compose run', (doc) => {
    const text = readFileSync(path.join(rootDir, doc), 'utf8').replace(/\\\n/g, ' ');
    const offending = text.split('\n').filter((line) => line.includes('docker compose run') && /\btar\b/.test(line));
    expect(offending).toEqual([]);
    expect(text).toContain('--volumes-from stream-router');
  });
});
