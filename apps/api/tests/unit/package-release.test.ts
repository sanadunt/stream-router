import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createZip,
  ensurePowerShellEncoding,
  packageRelease,
  parseReleaseVersion,
  releaseImage,
  releaseOwner,
  rewriteComposeForRelease,
  rewriteMarkdownLinks
} from '../../../../scripts/package-release.mjs';

const image = 'ghcr.io/sanadunt/stream-router:1.2.3';
const pin = { image, version: '1.2.3' };

const contractCompose = `# Jalankan: docker compose up -d
services:
  stream-router:
    # Image rilis dari GHCR; override lewat STREAM_ROUTER_IMAGE di .env.
    image: \${STREAM_ROUTER_IMAGE:-ghcr.io/sanadunt/stream-router:latest}
    # Build lokal dari source: docker compose build
    build: .
    env_file: .env
    environment:
      NODE_ENV: production
      MEDIAMTX_PUBLIC_HOST: \${HOST_LAN_IP}
    ports:
      - "\${BIND_ADDRESS:-0.0.0.0}:3000:3000"
      - "\${BIND_ADDRESS:-0.0.0.0}:18189:18189/udp"
    volumes:
      - stream-router-data:/app/data
      # Windows: ganti dengan folder, mis. C:/StreamRouter/recordings:/recordings
      - stream-router-recordings:/recordings
    restart: unless-stopped
    stop_grace_period: 30s

volumes:
  stream-router-data:
  stream-router-recordings:
`;

/** Pembaca zip independen dari penulis di script, agar format diuji dari sisi konsumen. */
function readZip(buffer: Buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const files = new Map<string, { data: Buffer; crc: number; time: number; day: number; mode: number }>();
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const day = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    expect([0, 8]).toContain(method);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(size);
    files.set(name, { data, crc, time, day, mode });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stream-router-release-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('paket rilis Docker untuk Windows', () => {
  it('menghapus build dan mem-pin image ke versi rilis dengan tetap menghormati STREAM_ROUTER_IMAGE', () => {
    const output = rewriteComposeForRelease(contractCompose, pin);
    expect(output).not.toMatch(/^\s*build\s*:/m);
    expect(output).not.toContain('Build lokal dari source');
    expect(output).toContain(`    image: \${STREAM_ROUTER_IMAGE:-${image}}\n`);
    expect(output).not.toContain(':latest');
    expect(output.startsWith(`# Paket rilis stream-router 1.2.3: image dipin ke ${image}.\n`)).toBe(true);
    // Selain build dan image, seluruh baris (termasuk komentar panduan Windows) tetap utuh.
    const expected = contractCompose
      .replace('    # Build lokal dari source: docker compose build\n    build: .\n', '')
      .replace('ghcr.io/sanadunt/stream-router:latest', image);
    expect(output.split('\n').slice(2).join('\n')).toBe(expected);
  });

  it('menghapus blok build bertingkat tanpa menyentuh key berikutnya atau kata build di tempat lain', () => {
    const source = [
      'services:',
      '  stream-router:',
      '    build:',
      '      context: .',
      '',
      '      dockerfile: Dockerfile',
      '      # args sengaja kosong',
      '    labels:',
      '      build: "label ini bukan key build service"',
      '    environment:',
      '      - BUILD_INFO=ci',
      '    # build: . (contoh di komentar setelah key lain)',
      '    image: "ghcr.io/sanadunt/stream-router:latest" # dipin saat rilis',
      ''
    ].join('\n');
    const output = rewriteComposeForRelease(source, pin);
    expect(output).not.toContain('context: .');
    expect(output).not.toContain('dockerfile: Dockerfile');
    expect(output).not.toContain('args sengaja kosong');
    expect(output).toContain('    labels:\n      build: "label ini bukan key build service"\n');
    expect(output).toContain('      - BUILD_INFO=ci\n');
    expect(output).toContain(`    image: "${image}" # dipin saat rilis\n`);
  });

  it('menerima BOM, CRLF, dan variabel image tanpa default', () => {
    const source = '﻿services:\r\n  stream-router:\r\n    image: ${STREAM_ROUTER_IMAGE}\r\n    build: .\r\n';
    const output = rewriteComposeForRelease(source, pin);
    expect(output).toContain(`    image: \${STREAM_ROUTER_IMAGE:-${image}}\n`);
    expect(output).not.toContain('\r');
    expect(output).not.toContain('build');
  });

  it('menolak compose yang tidak dapat dijalankan tanpa source', () => {
    expect(() => rewriteComposeForRelease('name: x\n', pin)).toThrow(/services/);
    expect(() => rewriteComposeForRelease('services:\n  stream-router:\n    build: .\n', pin)).toThrow(/tanpa image/);
    expect(() => rewriteComposeForRelease('services:\n  web:\n    image: nginx:1.27\n', pin)).toThrow(/tepat satu image/);
    expect(() => rewriteComposeForRelease(
      'services:\n  stream-router:\n    image: ghcr.io/sanadunt/stream-router:latest\n    pull_policy: build\n',
      pin
    )).toThrow(/pull_policy/);
    expect(() => rewriteComposeForRelease('services:\n  stream-router:\n    image: ${OTHER_IMAGE:-stream-router}\n', pin)).toThrow(/tidak didukung/);
  });

  it('memvalidasi versi rilis dan nama image huruf kecil', () => {
    expect(parseReleaseVersion('v1.2.3')).toBe('1.2.3');
    expect(parseReleaseVersion('1.2.3')).toBe('1.2.3');
    expect(parseReleaseVersion('v2.0.0-rc.1')).toBe('2.0.0-rc.1');
    for (const invalid of ['', 'latest', '1.2', 'v1.2.3+build.5', '../1.2.3', '1.2.3/../x']) {
      expect(() => parseReleaseVersion(invalid)).toThrow(/Versi rilis tidak valid/);
    }
    expect(releaseOwner({})).toBe('sanadunt');
    expect(releaseOwner({ GITHUB_REPOSITORY_OWNER: 'SanaDunt' })).toBe('sanadunt');
    expect(() => releaseOwner({ GITHUB_REPOSITORY_OWNER: 'evil/owner' })).toThrow(/GITHUB_REPOSITORY_OWNER/);
    expect(releaseImage('sanadunt', '1.2.3')).toBe(image);
  });

  it('mengarahkan tautan relatif README-WINDOWS.md ke repository pada tag rilis', () => {
    const baseUrl = 'https://github.com/sanadunt/stream-router/blob/v1.2.3/';
    const markdown = [
      'Lihat [keamanan](SECURITY.md#rotasi-secret) dan [README](../README.md).',
      'Gambar ![diagram](./img/topologi.png "Topologi"), [bagian](#firewall), [web](https://docs.docker.com/desktop/).',
      '[ref]: ./DOCKER.md',
      '```powershell',
      '[contoh](SECURITY.md)',
      '```'
    ].join('\n');
    const output = rewriteMarkdownLinks(markdown, { sourcePath: 'docs/WINDOWS.md', baseUrl }).split('\n');
    expect(output[0]).toBe(`Lihat [keamanan](${baseUrl}docs/SECURITY.md#rotasi-secret) dan [README](${baseUrl}README.md).`);
    expect(output[1]).toBe(`Gambar ![diagram](${baseUrl}docs/img/topologi.png "Topologi"), [bagian](#firewall), [web](https://docs.docker.com/desktop/).`);
    expect(output[2]).toBe(`[ref]: ${baseUrl}docs/DOCKER.md`);
    expect(output[4]).toBe('[contoh](SECURITY.md)');
  });

  it('menambahkan BOM UTF-8 hanya pada skrip PowerShell yang memuat karakter non-ASCII', () => {
    const ascii = Buffer.from('Write-Host "Selesai"\n');
    expect(ensurePowerShellEncoding(ascii)).toBe(ascii);
    const unicode = Buffer.from('Write-Host "Selesai — siap"\n');
    const withBom = ensurePowerShellEncoding(unicode);
    expect([...withBom.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(withBom.subarray(3).equals(unicode)).toBe(true);
    expect(ensurePowerShellEncoding(withBom)).toBe(withBom);
  });

  it('menulis zip yang dapat dibaca kembali dengan CRC, mode, dan timestamp tetap', () => {
    const date = new Date(Date.UTC(2026, 9, 26, 10, 30, 42));
    const entries = [
      { name: 'docker-compose.yml', data: Buffer.from('services: {}\n'.repeat(50)) },
      { name: 'windows/setup.ps1', data: Buffer.from('x') }
    ];
    const zip = createZip(entries, { date });
    expect(createZip(entries, { date }).equals(zip)).toBe(true);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['docker-compose.yml', 'windows/setup.ps1']);
    for (const entry of entries) {
      const file = files.get(entry.name)!;
      expect(file.data.equals(entry.data)).toBe(true);
      if (typeof zlib.crc32 === 'function') expect(file.crc).toBe(zlib.crc32(entry.data));
      expect(file.mode).toBe(0o100644);
      expect(file.day).toBe(((2026 - 1980) << 9) | (10 << 5) | 26);
      expect(file.time).toBe((10 << 11) | (30 << 5) | 21);
    }
    expect(() => createZip([{ name: '../keluar.txt', data: Buffer.from('x') }])).toThrow(/tidak valid/);
    expect(() => createZip([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'a.txt', data: Buffer.from('2') }])).toThrow(/ganda/);
  });

  it('membuat paket lengkap dari struktur repository', async () => {
    const root = await temporaryDirectory();
    const outDir = path.join(root, 'out');
    await mkdir(path.join(root, 'docker/windows'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docker-compose.yml'), contractCompose);
    await writeFile(path.join(root, 'docker/.env.example'), 'ADMIN_PASSWORD=\nAUTH_SECRET=\n');
    await writeFile(path.join(root, 'docker/windows/setup.ps1'), 'Write-Host "setup"\n');
    await writeFile(path.join(root, 'docker/windows/update.ps1'), 'Write-Host "update"\n');
    await writeFile(path.join(root, 'docs/WINDOWS.md'), '# Windows\n\nLihat [keamanan](SECURITY.md).\n');
    await writeFile(path.join(root, 'LICENSE'), 'MIT\n');

    const result = await packageRelease({
      rootDir: root,
      version: 'v1.2.3',
      outDir,
      env: { GITHUB_REPOSITORY_OWNER: 'SanaDunt', GITHUB_REPOSITORY: 'SanaDunt/stream-router', SOURCE_DATE_EPOCH: '1793010642' }
    });

    expect(result.file).toBe(path.join(outDir, 'stream-router-docker-1.2.3.zip'));
    expect(result.image).toBe(image);
    const zip = await readFile(result.file);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual([
      'docker-compose.yml',
      '.env.example',
      'windows/setup.ps1',
      'windows/update.ps1',
      'README-WINDOWS.md',
      'LICENSE'
    ]);
    const compose = files.get('docker-compose.yml')!.data.toString('utf8');
    expect(compose).not.toMatch(/^\s*build\s*:/m);
    expect(compose).toContain(`image: \${STREAM_ROUTER_IMAGE:-${image}}`);
    expect(files.get('.env.example')!.data.toString('utf8')).toBe('ADMIN_PASSWORD=\nAUTH_SECRET=\n');
    expect(files.get('README-WINDOWS.md')!.data.toString('utf8'))
      .toContain('[keamanan](https://github.com/SanaDunt/stream-router/blob/v1.2.3/docs/SECURITY.md)');
  });

  it('menolak membuat paket bila file wajib belum ada', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'docker-compose.yml'), contractCompose);
    await expect(packageRelease({ rootDir: root, version: '1.2.3', outDir: path.join(root, 'out'), env: {} }))
      .rejects.toThrow(/docker\/\.env\.example, docker\/windows\/setup\.ps1, docker\/windows\/update\.ps1, docs\/WINDOWS\.md/);
  });
});
