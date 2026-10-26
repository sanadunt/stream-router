import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  open,
  readdir,
  realpath,
  stat,
  statfs,
  unlink
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { resolveProjectPath } from '../mediamtx/mediamtx-config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');

export interface StorageValidation {
  ok: boolean;
  path: string;
  writable: boolean;
  totalBytes: number;
  freeBytes: number;
  thresholdBytes: number;
  meetsStorageFloor: boolean;
  error: string | null;
}

async function canonicalExistingDirectory(input: string): Promise<string> {
  const resolved = resolveProjectPath(input);
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch {
    throw new AppError('STORAGE_PATH_NOT_FOUND', 'Folder storage tidak ditemukan pada server', 400);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new AppError('STORAGE_PATH_NOT_DIRECTORY', 'Path storage harus berupa folder', 400);
  }
  return canonical;
}

async function isWritable(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function validateStorageDirectory(
  input: string,
  minFreePercent: number,
  minFreeGb: number,
  probeWrite = true
): Promise<StorageValidation> {
  const canonical = await canonicalExistingDirectory(input);
  const disk = await statfs(canonical);
  const totalBytes = Number(disk.blocks) * Number(disk.bsize);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  const thresholdBytes = Math.max(totalBytes * minFreePercent / 100, minFreeGb * 1024 ** 3);
  let writable = await isWritable(canonical);
  let error: string | null = writable ? null : 'Folder tidak dapat ditulis oleh proses Node';

  if (writable && probeWrite) {
    const probe = path.join(canonical, `.stream-router-write-test-${randomUUID()}`);
    try {
      const handle = await open(probe, 'wx', 0o600);
      await handle.close();
      await unlink(probe);
    } catch (reason) {
      writable = false;
      error = `Tes tulis gagal: ${(reason as NodeJS.ErrnoException).code ?? (reason as Error).message}`;
      await unlink(probe).catch(() => undefined);
    }
  }

  const meetsStorageFloor = freeBytes >= thresholdBytes;
  if (writable && !meetsStorageFloor) {
    error = 'Ruang kosong berada di bawah minimum storage yang dipilih';
  }
  return {
    ok: writable && meetsStorageFloor,
    path: canonical,
    writable,
    totalBytes,
    freeBytes,
    thresholdBytes,
    meetsStorageFloor,
    error
  };
}

export async function listStorageDirectories(input?: string): Promise<Record<string, unknown>> {
  const requested = input?.trim() || path.parse(projectRoot).root;
  const current = await canonicalExistingDirectory(requested);
  const directoryEntries = await readdir(current, { withFileTypes: true });
  const entries = await Promise.all(directoryEntries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const target = path.join(current, entry.name);
      return {
        name: entry.name,
        path: target,
        writable: await isWritable(target)
      };
    }));
  entries.sort((left, right) => left.name.localeCompare(right.name, 'id-ID', { sensitivity: 'base' }));
  const disk = await statfs(current);
  const root = path.parse(current).root;
  return {
    current,
    parent: current === root ? null : path.dirname(current),
    writable: await isWritable(current),
    totalBytes: Number(disk.blocks) * Number(disk.bsize),
    freeBytes: Number(disk.bavail) * Number(disk.bsize),
    entries
  };
}

export function databaseFilePath(): string {
  const databaseUrl = getEnv().DATABASE_URL;
  if (!databaseUrl.startsWith('file:')) return 'Database non-file';
  const withoutScheme = databaseUrl.slice('file:'.length).split('?')[0] ?? '';
  if (!withoutScheme) return 'Path database tidak tersedia';
  return path.isAbsolute(withoutScheme)
    ? path.normalize(withoutScheme)
    : path.resolve(projectRoot, 'prisma', withoutScheme);
}
