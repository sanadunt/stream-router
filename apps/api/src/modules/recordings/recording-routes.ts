import { createHmac, timingSafeEqual } from 'node:crypto';
import { ZipArchive } from 'archiver';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { requireRoles } from '../../plugins/auth.js';
import { audit } from '../routes/route-service.js';
import {
  indexRecordingSegment,
  indexRecordingStarted,
  proxyRecording,
  recordingArchiveEntries,
  recordingDto,
  recordingStorageStatus,
  refreshActiveRecordings,
  removeRecording
} from './recording-service.js';

const listQuery = z.object({
  routeId: z.string().uuid().optional(),
  cameraKey: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
const bulkIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100)
}).refine((value) => new Set(value.ids).size === value.ids.length, {
  message: 'ID recording bulk harus unik',
  path: ['ids']
});

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

// Membuat Intl.DateTimeFormat mahal (~35 µs); kalender dan timeline memakai ulang
// formatter per zona waktu. Dibatasi agar variasi penulisan zona tidak menumpuk.
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const TIMELINE_LIMIT = 5000;

function dateKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateKeyFormatters.get(timeZone);
  if (!formatter) {
    if (dateKeyFormatters.size >= 64) dateKeyFormatters.clear();
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    dateKeyFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function recordingDateKey(date: Date, timeZone: string): string {
  const parts = dateKeyFormatter(timeZone).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(dateKey: string, days: number): string {
  const [year = 0, month = 1, day = 1] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Instant UTC pertama yang jatuh pada tanggal lokal `dateKey` di `timeZone`.
 * Dicari dengan binary search di sekitar tengah malam UTC (offset zona waktu
 * berada di antara -12 dan +14 jam), sehingga DST dan tengah malam yang
 * dilompati tetap menghasilkan batas hari yang sama dengan recordingDateKey.
 */
export function localDayStart(dateKey: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = dateKey.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  let before = utcMidnight - 15 * 3_600_000;
  let onOrAfter = utcMidnight + 15 * 3_600_000;
  while (onOrAfter - before > 1) {
    const middle = Math.floor((before + onOrAfter) / 2);
    if (recordingDateKey(new Date(middle), timeZone) >= dateKey) onOrAfter = middle;
    else before = middle;
  }
  return new Date(onOrAfter);
}

/** Token hook dari AUTH_SECRET dengan domain terpisah: kunci session tidak dikirim lewat header. */
export function mediamtxHookToken(secret = getEnv().AUTH_SECRET): string {
  return createHmac('sha256', secret).update('stream-router:mediamtx-segment-hook').digest('base64url');
}

function validHookToken(received: string | undefined): boolean {
  const expected = Buffer.from(mediamtxHookToken());
  const actual = Buffer.from(received ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Alamat socket, bukan request.ip: dengan TRUST_PROXY nilai request.ip berasal dari
// X-Forwarded-For yang dapat diisi client. Listener dual-stack memakai bentuk IPv4-mapped.
function fromLoopbackSocket(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/mediamtx/segments', {
    // Dijaga token hook; hook MediaMTX tidak boleh ikut kuota rate limit dashboard.
    config: { rateLimit: false }
  }, async (request, reply) => {
    if (!fromLoopbackSocket(request.socket.remoteAddress)) return reply.code(403).send({ error: 'localhost only' });
    if (!validHookToken(request.headers['x-mediamtx-hook-token']?.toString())) return reply.code(401).send({ error: 'invalid hook token' });
    const body = z.object({
      path: z.string().default(''),
      segmentPath: z.string().min(1),
      event: z.enum(['CREATE', 'COMPLETE']).default('COMPLETE'),
      duration: z.string().default('')
    }).parse(request.body);
    return body.event === 'CREATE'
      ? indexRecordingStarted(body)
      : indexRecordingSegment(body);
  });

  app.get('/api/recordings', { preHandler: requireRoles('admin', 'operator') }, async (request) => {
    const query = listQuery.parse(request.query);
    await refreshActiveRecordings();
    const where = {
      status: { in: ['RECORDING', 'COMPLETE', 'MISSING', 'ERROR'] },
      ...(query.routeId ? { routeId: query.routeId } : {}),
      ...(query.cameraKey ? { cameraKey: query.cameraKey } : {}),
      ...((query.from || query.to) ? {
        startTime: {
          ...(query.from ? { gte: query.from } : {}),
          ...(query.to ? { lt: query.to } : {})
        }
      } : {})
    };
    const [items, total] = await Promise.all([
      prisma.recordingSegment.findMany({ where, orderBy: { startTime: 'desc' }, skip: query.offset, take: query.limit }),
      prisma.recordingSegment.count({ where })
    ]);
    return { items: items.map(recordingDto), total };
  });

  app.get('/api/recordings/calendar', { preHandler: requireRoles('admin', 'operator') }, async (request) => {
    const query = z.object({
      month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
      routeId: z.string().uuid().optional(),
      timeZone: z.string().min(1).max(100).default('Asia/Jakarta')
    }).refine((value) => isValidTimeZone(value.timeZone), {
      message: 'Zona waktu kalender tidak valid',
      path: ['timeZone']
    }).parse(request.query);
    await refreshActiveRecordings();
    // Agregasi per hari lokal dilakukan di SQL dengan batas UTC tiap hari; tidak ada
    // baris recording yang dimuat atau diformat satu per satu di event loop.
    const firstDay = `${query.month}-01`;
    const nextMonth = addDays(`${query.month}-28`, 4).slice(0, 7);
    const dates: string[] = [];
    for (let date = firstDay; date.startsWith(query.month); date = addDays(date, 1)) dates.push(date);
    const boundaries = [...dates, `${nextMonth}-01`].map((date) => localDayStart(date, query.timeZone));
    const days = await Promise.all(dates.map(async (date, index) => {
      const aggregate = await prisma.recordingSegment.aggregate({
        where: {
          status: { in: ['RECORDING', 'COMPLETE'] },
          ...(query.routeId ? { routeId: query.routeId } : {}),
          startTime: { gte: boundaries[index]!, lt: boundaries[index + 1]! }
        },
        _count: { _all: true },
        _sum: { sizeBytes: true, durationMs: true }
      });
      return {
        date,
        count: aggregate._count._all,
        sizeBytes: aggregate._sum.sizeBytes ?? 0,
        durationMs: aggregate._sum.durationMs ?? 0
      };
    }));
    return {
      month: query.month,
      timeZone: query.timeZone,
      days: days.filter((day) => day.count > 0)
    };
  });

  app.get('/api/recordings/timeline', { preHandler: requireRoles('admin', 'operator') }, async (request) => {
    const query = z.object({
      date: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/),
      routeId: z.string().uuid().optional(),
      timeZone: z.string().min(1).max(100).default('Asia/Jakarta')
    }).refine((value) => isValidTimeZone(value.timeZone), {
      message: 'Zona waktu timeline tidak valid',
      path: ['timeZone']
    }).parse(request.query);
    await refreshActiveRecordings();
    // Query tepat satu hari lokal agar batas `take` tidak terpakai oleh hari lain.
    const rows = await prisma.recordingSegment.findMany({
      where: {
        status: { in: ['RECORDING', 'COMPLETE'] },
        ...(query.routeId ? { routeId: query.routeId } : {}),
        startTime: {
          gte: localDayStart(query.date, query.timeZone),
          lt: localDayStart(addDays(query.date, 1), query.timeZone)
        }
      },
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      take: TIMELINE_LIMIT + 1
    });
    return {
      date: query.date,
      timeZone: query.timeZone,
      items: rows.slice(0, TIMELINE_LIMIT).map(recordingDto),
      truncated: rows.length > TIMELINE_LIMIT
    };
  });

  app.get('/api/recordings/storage', { preHandler: requireRoles('admin', 'operator') }, recordingStorageStatus);

  app.get('/api/recordings/playback', {
    preHandler: requireRoles('admin', 'operator'),
    // Seeking dan cache browser menggunakan beberapa byte-range request untuk
    // satu sesi playback. Jangan hitung traffic media sebagai request control
    // plane; autentikasi dan validasi ID tetap dijalankan.
    config: { rateLimit: false }
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.query);
    const result = await proxyRecording(id, request.headers.range, false);
    return reply.code(result.status).headers(result.headers).send(result.stream);
  });

  app.get('/api/recordings/download', {
    preHandler: requireRoles('admin', 'operator'),
    config: { rateLimit: false }
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.query);
    const result = await proxyRecording(id, request.headers.range, true);
    return reply.code(result.status).headers(result.headers).send(result.stream);
  });

  app.get('/api/recordings/bulk-download', {
    preHandler: requireRoles('admin', 'operator'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const query = z.object({ ids: z.string().min(36).max(4000) }).parse(request.query);
    const { ids } = bulkIdsSchema.parse({ ids: query.ids.split(',') });
    const entries = await recordingArchiveEntries(ids);
    if (!entries.length) {
      return reply.code(409).send({
        error: { code: 'RECORDING_BULK_EMPTY', message: 'Tidak ada recording COMPLETE yang dapat diunduh' }
      });
    }
    const archive = new ZipArchive({ zlib: { level: 0 } });
    archive.on('warning', (error) => app.log.warn({ err: error }, 'Peringatan bulk archive recording'));
    archive.on('error', (error) => archive.destroy(error));
    for (const entry of entries) {
      archive.file(entry.fullPath, { name: entry.archiveName });
    }
    reply.headers({
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="camera-recordings-${new Date().toISOString().slice(0, 10)}.zip"`,
      'cache-control': 'no-store'
    });
    void archive.finalize();
    return reply.send(archive);
  });

  app.patch<{ Params: { id: string } }>('/api/recordings/:id/protection', { preHandler: requireRoles('admin') }, async (request) => {
    const { protected: protectedValue } = z.object({ protected: z.boolean() }).parse(request.body);
    const row = await prisma.recordingSegment.update({
      where: { id: request.params.id },
      data: { protected: protectedValue }
    });
    await audit(protectedValue ? 'RECORDING_PROTECT' : 'RECORDING_UNPROTECT', row.routeId, { recordingId: row.id });
    return recordingDto(row);
  });

  app.delete<{ Params: { id: string } }>('/api/recordings/:id', { preHandler: requireRoles('admin') }, async (request, reply) => {
    await removeRecording(request.params.id);
    await audit('RECORDING_DELETE', null, { recordingId: request.params.id });
    return reply.code(204).send();
  });

  app.post('/api/recordings/bulk-delete', {
    preHandler: requireRoles('admin'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request) => {
    const { ids } = bulkIdsSchema.parse(request.body);
    const deletedIds: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      try {
        await removeRecording(id);
        deletedIds.push(id);
      } catch (error) {
        skipped.push({ id, reason: (error as Error).message });
      }
    }
    await audit('RECORDING_BULK_DELETE', null, {
      recordingIds: deletedIds,
      skippedCount: skipped.length
    });
    return { deletedIds, skipped };
  });
}
