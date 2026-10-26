import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { currentSession, requireAuth, type SessionPayload } from '../../plugins/auth.js';
import type { UserRole } from '../auth/auth-service.js';
import { listViewerRoutes } from '../routes/route-service.js';
import { eventBus, type AppEvent } from './event-bus.js';

const HEARTBEAT_MS = 15_000;
// Satu tab memakai satu koneksi. Batas ini mencegah satu cookie (termasuk Viewer yang tidak
// memakai password) membuka stream tanpa batas; tab yang ditolak tetap memakai polling 15 detik.
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS_PER_IP = 64;
const VIEWER_ROUTE_CACHE_MS = 5_000;

interface EventClient {
  request: FastifyRequest;
  response: ServerResponse;
  role: UserRole;
  sessionKey: string;
  ip: string;
}

const clients = new Set<EventClient>();
let heartbeat: NodeJS.Timeout | undefined;
let viewerRoutes: { ids: Set<string>; expiresAt: number } | null = null;
let viewerRoutesLoading: Promise<Set<string>> | null = null;

function frameFor(event: AppEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isGone(response: ServerResponse): boolean {
  return response.writableEnded || response.destroyed;
}

function send(client: EventClient, frame: string): void {
  if (isGone(client.response)) return;
  client.response.write(frame);
}

/** Viewer hanya butuh pemicu reload monitor: tanpa lastError, PID, atau detail retry. */
export function viewerEvent(event: AppEvent): AppEvent {
  const data = event.data as { status?: unknown } | null | undefined;
  const status = data && typeof data === 'object' && typeof data.status === 'string' ? data.status : undefined;
  return {
    type: event.type,
    ...(event.routeId ? { routeId: event.routeId } : {}),
    timestamp: event.timestamp,
    data: status ? { status } : {}
  };
}

async function viewerRouteIds(): Promise<Set<string>> {
  if (viewerRoutes && viewerRoutes.expiresAt > Date.now()) return viewerRoutes.ids;
  viewerRoutesLoading ??= listViewerRoutes()
    .then((rows) => {
      const ids = new Set(rows.map((row) => row.id));
      viewerRoutes = { ids, expiresAt: Date.now() + VIEWER_ROUTE_CACHE_MS };
      return ids;
    })
    .finally(() => { viewerRoutesLoading = null; });
  return viewerRoutesLoading;
}

async function sendToViewers(event: AppEvent, targets: EventClient[]): Promise<void> {
  // Viewer hanya menerima event untuk route yang dapat tampil di monitor Viewer.
  if (!event.routeId || !(await viewerRouteIds()).has(event.routeId)) return;
  const frame = frameFor(viewerEvent(event));
  for (const client of targets) {
    if (clients.has(client)) send(client, frame);
  }
}

function broadcast(event: AppEvent): void {
  let frame: string | undefined;
  const viewers: EventClient[] = [];
  for (const client of clients) {
    if (client.role === 'viewer') {
      viewers.push(client);
      continue;
    }
    // Diserialisasi sekali per event, bukan sekali per koneksi.
    frame ??= frameFor(event);
    send(client, frame);
  }
  if (viewers.length) void sendToViewers(event, viewers).catch(() => undefined);
}

function closeClient(client: EventClient): void {
  if (!clients.delete(client)) return;
  if (!client.response.writableEnded) client.response.end();
  if (clients.size) return;
  eventBus.off('event', broadcast);
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
}

/**
 * Kirim heartbeat dan periksa ulang sesi setiap stream. Sesi yang dicabut (password diganti),
 * kedaluwarsa, atau berganti role diputus; browser lalu tersambung ulang dengan sesi barunya.
 */
export async function revalidateEventStreams(): Promise<void> {
  const checks = new Map<string, Promise<SessionPayload | null | undefined>>();
  await Promise.all([...clients].map(async (client) => {
    // Koneksi yang sudah tertutup tanpa event 'close' terpasang tetap dilepas dari batas slot.
    if (isGone(client.response)) {
      closeClient(client);
      return;
    }
    let check = checks.get(client.sessionKey);
    if (!check) {
      // undefined = database tidak dapat diperiksa; koneksi dipertahankan sampai pemeriksaan berikutnya.
      check = currentSession(client.request).catch(() => undefined);
      checks.set(client.sessionKey, check);
    }
    const session = await check;
    if (session === null || (session && session.role !== client.role)) {
      closeClient(client);
      return;
    }
    send(client, ': heartbeat\n\n');
  }));
}

function addClient(client: EventClient): void {
  if (!clients.size) {
    eventBus.on('event', broadcast);
    heartbeat = setInterval(() => void revalidateEventStreams().catch(() => undefined), HEARTBEAT_MS);
    heartbeat.unref();
  }
  clients.add(client);
}

function countClients(predicate: (client: EventClient) => boolean): number {
  let count = 0;
  for (const client of clients) if (!isGone(client.response) && predicate(client)) count += 1;
  return count;
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  // Akhiri stream secara rapi saat server berhenti; listener event bus dan heartbeat ikut dilepas.
  app.addHook('preClose', async () => {
    for (const client of [...clients]) closeClient(client);
  });

  app.get('/api/events', { preHandler: requireAuth }, async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Silakan login terlebih dahulu', details: null, requestId: request.id }
      });
    }
    const sessionKey = request.cookies.stream_router_session ?? '';
    if (
      countClients((client) => client.sessionKey === sessionKey) >= MAX_STREAMS_PER_SESSION
      || countClients((client) => client.ip === request.ip) >= MAX_STREAMS_PER_IP
    ) {
      return reply.code(429).send({
        error: {
          code: 'EVENT_STREAM_LIMIT',
          message: 'Terlalu banyak koneksi realtime yang terbuka. Tutup tab lain; data tetap diperbarui berkala.',
          details: null,
          requestId: request.id
        }
      });
    }
    reply.hijack();
    // Client yang menutup koneksi selama pemeriksaan sesi (async) sudah memicu 'close' sebelum
    // listener di bawah terpasang; mendaftarkannya akan menahan slot sampai sesi kedaluwarsa.
    if (request.raw.destroyed || reply.raw.destroyed || request.raw.socket?.destroyed) return;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
    const client: EventClient = { request, response: reply.raw, role: session.role, sessionKey, ip: request.ip };
    addClient(client);
    reply.raw.once('close', () => closeClient(client));
  });
}
