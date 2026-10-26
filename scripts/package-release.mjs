#!/usr/bin/env node
// Membuat paket rilis Docker untuk Windows: release/stream-router-docker-<versi>.zip berisi
// docker-compose.yml (tanpa `build:`, image dipin ke versi rilis), .env.example, skrip
// windows/*.ps1, README-WINDOWS.md, serta LICENSE/NOTICE bila ada. Tidak memakai dependency npm
// maupun perintah zip eksternal, sehingga job rilis cukup memakai Node.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateRawSync } from 'node:zlib';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_OWNER = 'sanadunt';
export const IMAGE_NAME = 'stream-router';
const COMPOSE_IMAGE_VARIABLE = 'STREAM_ROUTER_IMAGE';

/** Isi paket: file sumber di repository -> nama di dalam zip. */
export const RELEASE_FILES = Object.freeze([
  { source: 'docker-compose.yml', target: 'docker-compose.yml', kind: 'compose' },
  { source: 'docker/.env.example', target: '.env.example' },
  { source: 'docker/windows/setup.ps1', target: 'windows/setup.ps1', kind: 'powershell' },
  { source: 'docker/windows/update.ps1', target: 'windows/update.ps1', kind: 'powershell' },
  { source: 'docs/WINDOWS.md', target: 'README-WINDOWS.md', kind: 'markdown' }
]);
const OPTIONAL_FILES = Object.freeze(['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md', 'NOTICE.txt']);

// Tag Docker tidak menerima `+`, jadi build metadata semver ditolak.
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `v1.2.3`, `1.2.3`, atau `1.2.3-rc.1` -> versi tanpa awalan `v` (sama dengan tag image). */
export function parseReleaseVersion(input) {
  const match = VERSION_PATTERN.exec(String(input ?? '').trim());
  if (!match) {
    throw new Error(`Versi rilis tidak valid: ${JSON.stringify(input)}. Gunakan MAJOR.MINOR.PATCH, misalnya 1.2.0 atau v1.2.0-rc.1.`);
  }
  return match[1];
}

/** Owner image GHCR selalu huruf kecil; GitHub mengizinkan huruf besar pada nama akun. */
export function releaseOwner(env = process.env) {
  const owner = (env.GITHUB_REPOSITORY_OWNER || DEFAULT_OWNER).trim().toLowerCase();
  if (!OWNER_PATTERN.test(owner)) throw new Error(`GITHUB_REPOSITORY_OWNER tidak valid untuk nama image: ${JSON.stringify(owner)}`);
  return owner;
}

export function releaseImage(owner, version) {
  return `ghcr.io/${owner}/${IMAGE_NAME}:${version}`;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line) {
  const text = line.trim();
  return text === '' || text.startsWith('#');
}

const KEY_LINE = /^( *)([A-Za-z0-9_.-]+|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]|$)/;

function keyOf(line) {
  const match = KEY_LINE.exec(line);
  return match ? match[2].replace(/^(["'])(.*)\1$/, '$2') : null;
}

/** Nilai skalar setelah `key:` beserta kutip dan komentar akhir baris, agar keduanya dipertahankan. */
function splitScalar(rest) {
  const text = rest.trim();
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    const close = text.indexOf(quote, 1);
    if (close === -1) throw new Error(`Nilai bertanda kutip tidak ditutup: ${text}`);
    return { quote, value: text.slice(1, close), comment: text.slice(close + 1).trim() };
  }
  const hash = text.search(/\s#/);
  if (hash === -1) return { quote: '', value: text, comment: '' };
  return { quote: '', value: text.slice(0, hash).trim(), comment: text.slice(hash).trim() };
}

function isStreamRouterImage(value) {
  if (value.includes(COMPOSE_IMAGE_VARIABLE)) return true;
  const fallback = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}$/.exec(value)?.[1] ?? value;
  return /(?:^|\/)stream-router(?:[:@]|$)/.test(fallback);
}

// Variabel STREAM_ROUTER_IMAGE tetap dihormati; hanya default-nya yang dipin ke versi rilis.
function pinImageValue(value, image) {
  if (new RegExp(`^\\$\\{${COMPOSE_IMAGE_VARIABLE}(?::?[-?][^}]*)?\\}$`).test(value)) return `\${${COMPOSE_IMAGE_VARIABLE}:-${image}}`;
  if (value.includes('$')) throw new Error(`Nilai image di docker-compose.yml tidak didukung untuk paket rilis: ${value}`);
  return image;
}

function composeServices(lines) {
  const servicesIndex = lines.findIndex((line) => /^services[ \t]*:[ \t]*(?:#.*)?$/.test(line));
  if (servicesIndex === -1) throw new Error('docker-compose.yml tidak memiliki blok `services:` di tingkat atas.');
  let servicesEnd = lines.length;
  for (let index = servicesIndex + 1; index < lines.length; index += 1) {
    if (!isBlankOrComment(lines[index]) && indentOf(lines[index]) === 0) {
      servicesEnd = index;
      break;
    }
  }
  const services = [];
  let serviceIndent = null;
  for (let index = servicesIndex + 1; index < servicesEnd; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    serviceIndent ??= indent;
    if (indent > serviceIndent) continue;
    const name = indent === serviceIndent ? keyOf(line) : null;
    if (!name) throw new Error(`Baris ${index + 1} docker-compose.yml tidak dikenali sebagai nama service.`);
    if (services.length) services[services.length - 1].end = index;
    services.push({ name, start: index, end: servicesEnd });
  }
  for (const service of services) {
    for (let index = service.start + 1; index < service.end; index += 1) {
      if (isBlankOrComment(lines[index])) continue;
      service.childIndent = indentOf(lines[index]);
      break;
    }
  }
  return services;
}

/** Rentang baris key `build:` beserta blok bertingkat dan komentar yang menempel tepat di atasnya. */
function buildRange(lines, index, service) {
  let start = index;
  while (start - 1 > service.start && lines[start - 1].trim().startsWith('#') && indentOf(lines[start - 1]) === service.childIndent) {
    start -= 1;
  }
  let end = index + 1;
  while (end < service.end) {
    const line = lines[end];
    if (line.trim() === '') {
      let next = end + 1;
      while (next < service.end && lines[next].trim() === '') next += 1;
      if (next < service.end && indentOf(lines[next]) > service.childIndent) {
        end = next;
        continue;
      }
      break;
    }
    if (indentOf(line) <= service.childIndent) break;
    end += 1;
  }
  return { start, end };
}

/**
 * docker-compose.yml untuk paket rilis: key `build:` dihapus dari setiap service (paket tidak
 * memuat source) dan image stream-router dipin ke versi rilis. Diproses per baris agar komentar
 * panduan di compose tetap utuh untuk pengguna Windows.
 */
export function rewriteComposeForRelease(source, { image, version }) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const services = composeServices(lines);
  if (!services.length) throw new Error('docker-compose.yml tidak memiliki service.');
  const removed = new Set();
  const replacements = new Map();
  let pinnedImages = 0;
  for (const service of services) {
    if (service.childIndent === undefined) continue;
    let hasBuild = false;
    let hasImage = false;
    for (let index = service.start + 1; index < service.end; index += 1) {
      const line = lines[index];
      if (isBlankOrComment(line) || indentOf(line) !== service.childIndent) continue;
      const key = keyOf(line);
      const rest = line.slice(line.indexOf(':') + 1);
      if (key === 'build') {
        hasBuild = true;
        const range = buildRange(lines, index, service);
        for (let position = range.start; position < range.end; position += 1) removed.add(position);
      } else if (key === 'image') {
        hasImage = true;
        const { quote, value, comment } = splitScalar(rest);
        if (!isStreamRouterImage(value)) continue;
        pinnedImages += 1;
        const pinned = `${' '.repeat(service.childIndent)}image: ${quote}${pinImageValue(value, image)}${quote}`;
        replacements.set(index, comment ? `${pinned} ${comment}` : pinned);
      } else if (key === 'pull_policy' && splitScalar(rest).value === 'build') {
        throw new Error(`Service ${service.name} memakai pull_policy: build; paket rilis tidak memuat source untuk build.`);
      }
    }
    if (hasBuild && !hasImage) throw new Error(`Service ${service.name} hanya memiliki build tanpa image; paket rilis membutuhkan image.`);
  }
  if (pinnedImages !== 1) {
    throw new Error(`docker-compose.yml harus memiliki tepat satu image stream-router (ditemukan ${pinnedImages}).`);
  }
  const output = [
    `# Paket rilis stream-router ${version}: image dipin ke ${image}.`,
    `# Isi ${COMPOSE_IMAGE_VARIABLE} di .env hanya bila sengaja memakai image lain.`
  ];
  lines.forEach((line, index) => {
    if (!removed.has(index)) output.push(replacements.get(index) ?? line);
  });
  while (output.length && output[output.length - 1].trim() === '') output.pop();
  return `${output.join('\n')}\n`;
}

/**
 * Tautan relatif di docs/WINDOWS.md (mis. ke docs/SECURITY.md) tidak ikut masuk paket, jadi
 * diarahkan ke file yang sama di GitHub pada tag rilis. Isi blok kode tidak diubah.
 */
export function rewriteMarkdownLinks(markdown, { sourcePath, baseUrl }) {
  const resolve = (target) => {
    const bracketed = target.startsWith('<') && target.endsWith('>');
    const raw = bracketed ? target.slice(1, -1) : target;
    if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return target;
    const hashIndex = raw.indexOf('#');
    const pathPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
    const anchor = hashIndex === -1 ? '' : raw.slice(hashIndex);
    const resolved = pathPart.startsWith('/')
      ? path.posix.normalize(pathPart.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), pathPart));
    if (resolved === '..' || resolved.startsWith('../')) return target;
    const url = `${baseUrl}${resolved === '.' ? '' : resolved}${anchor}`;
    return bracketed ? `<${url}>` : url;
  };
  let fence = null;
  return markdown.split('\n').map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return line;
    }
    if (fence !== null) return line;
    const reference = /^( {0,3}\[[^\]]+\]:[ \t]*)(<[^>]*>|\S+)(.*)$/.exec(line);
    if (reference) return `${reference[1]}${resolve(reference[2])}${reference[3]}`;
    return line.replace(/(\]\()(<[^>]*>|[^)\s]+)/g, (_match, open, target) => `${open}${resolve(target)}`);
  }).join('\n');
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI; karakter non-ASCII butuh BOM UTF-8. */
export function ensurePowerShellEncoding(content) {
  if (content.subarray(0, 3).equals(UTF8_BOM) || !content.some((byte) => byte >= 0x80)) return content;
  return Buffer.concat([UTF8_BOM, content]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Tanggal DOS (resolusi 2 detik, tanpa zona waktu) dari komponen UTC. */
function dosDateTime(date) {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

function assertEntryName(name) {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name) || name.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Nama entri zip tidak valid: ${JSON.stringify(name)}`);
  }
}

/**
 * Penulis zip minimal (deflate, tanpa zip64) dengan timestamp tetap, sehingga isi yang sama
 * menghasilkan checksum yang sama. Cukup untuk paket rilis yang hanya berisi file teks kecil.
 */
export function createZip(entries, { date = new Date() } = {}) {
  const { time, day } = dosDateTime(date);
  const parts = [];
  const central = [];
  const names = new Set();
  let offset = 0;
  for (const entry of entries) {
    assertEntryName(entry.name);
    if (names.has(entry.name)) throw new Error(`Entri zip ganda: ${entry.name}`);
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    // Dibuat oleh "Unix" agar mode 0644 di atribut eksternal dipakai unzip; Windows mengabaikannya.
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) throw new Error('Paket terlalu besar untuk zip tanpa zip64.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directory, end]);
}

/** SOURCE_DATE_EPOCH (detik) membuat zip reproducible; tanpa itu dipakai waktu sekarang. */
function releaseDate(env) {
  const epoch = env.SOURCE_DATE_EPOCH?.trim();
  if (!epoch) return new Date();
  if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH tidak valid: ${JSON.stringify(epoch)}`);
  return new Date(Number(epoch) * 1000);
}

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function packageRelease({ rootDir: sourceRoot = rootDir, version: versionInput, outDir, env = process.env }) {
  const version = parseReleaseVersion(versionInput);
  const owner = releaseOwner(env);
  const image = releaseImage(owner, version);
  const repository = REPOSITORY_PATTERN.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : `${owner}/${IMAGE_NAME}`;
  const serverUrl = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const docsBaseUrl = `${serverUrl}/${repository}/blob/v${version}/`;

  const sources = await Promise.all(RELEASE_FILES.map(async (file) => ({ ...file, content: await readOptional(path.join(sourceRoot, file.source)) })));
  const missing = sources.filter((file) => file.content === null).map((file) => file.source);
  if (missing.length) throw new Error(`File wajib untuk paket rilis belum ada: ${missing.join(', ')}`);

  const entries = sources.map((file) => {
    if (file.kind === 'compose') return { name: file.target, data: Buffer.from(rewriteComposeForRelease(file.content.toString('utf8'), { image, version })) };
    if (file.kind === 'markdown') {
      return { name: file.target, data: Buffer.from(rewriteMarkdownLinks(file.content.toString('utf8'), { sourcePath: file.source, baseUrl: docsBaseUrl })) };
    }
    if (file.kind === 'powershell') return { name: file.target, data: ensurePowerShellEncoding(file.content) };
    return { name: file.target, data: file.content };
  });
  for (const name of OPTIONAL_FILES) {
    const content = await readOptional(path.join(sourceRoot, name));
    if (content !== null) entries.push({ name, data: content });
  }

  const zip = createZip(entries, { date: releaseDate(env) });
  const targetDir = outDir ?? path.join(sourceRoot, 'release');
  await mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, `stream-router-docker-${version}.zip`);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, zip);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    file,
    version,
    image,
    bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
    entries: entries.map((entry) => entry.name)
  };
}

const USAGE = 'Pemakaian: npm run release:package -- <versi> [--out-dir <folder>]\nContoh:    npm run release:package -- 1.2.0';

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'out-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) throw new Error(`Versi rilis wajib diisi tepat satu.\n${USAGE}`);
  const outDir = values['out-dir'] ? path.resolve(values['out-dir']) : undefined;
  const result = await packageRelease({ version: positionals[0], outDir });
  const relative = path.relative(process.cwd(), result.file);
  const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : result.file;
  console.log(`[release] Paket: ${shown} (${(result.bytes / 1024).toFixed(1)} KB)`);
  console.log(`[release] Image: ${result.image}`);
  console.log(`[release] Isi: ${result.entries.join(', ')}`);
  console.log(`[release] SHA-256: ${result.sha256}`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release] GAGAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
