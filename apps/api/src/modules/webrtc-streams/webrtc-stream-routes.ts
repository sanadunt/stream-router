import type { FastifyInstance } from 'fastify';
import { createWebrtcStreamSchema, updateWebrtcStreamSchema } from '@stream-router/contracts';
import { z } from 'zod';
import { requireAuth, requireRoles } from '../../plugins/auth.js';
import { releasePtzTarget } from '../ptz/ptz-controller.js';
import {
  createWebrtcStream,
  deleteWebrtcStream,
  getWebrtcStream,
  listMp4Files,
  listWebrtcStreams,
  localMp4Head,
  localMp4Response,
  toWebrtcStreamEditDto,
  toWebrtcStreamDto,
  updateWebrtcStream
} from './webrtc-stream-service.js';

export async function webrtcStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/webrtc-streams', { preHandler: requireRoles('admin', 'operator') }, async () => ({
    items: (await listWebrtcStreams()).map(toWebrtcStreamDto)
  }));

  app.post('/api/webrtc-streams', { preHandler: requireRoles('admin') }, async (request, reply) => {
    const row = await createWebrtcStream(createWebrtcStreamSchema.parse(request.body));
    return reply.code(201).send(toWebrtcStreamDto(row));
  });

  app.get('/api/webrtc-streams/files', { preHandler: requireRoles('admin') }, async (request) => {
    const { path } = z.object({ path: z.string().max(4096).optional() }).parse(request.query);
    return listMp4Files(path);
  });

  // HEAD otomatis Fastify tetap membuka stream lalu menguras seluruh file dari
  // disk hanya untuk dibuang, jadi HEAD didaftarkan eksplisit tanpa membuka file.
  app.get<{ Params: { id: string } }>('/api/viewer/stream-files/:id', {
    exposeHeadRoute: false,
    preHandler: requireAuth
  }, async (request, reply) => {
    const result = await localMp4Response(request.params.id, request.headers.range);
    return reply.code(result.status).headers(result.headers).send(result.stream);
  });

  app.head<{ Params: { id: string } }>('/api/viewer/stream-files/:id', { preHandler: requireAuth }, async (request, reply) => {
    const result = await localMp4Head(request.params.id, request.headers.range);
    return reply.code(result.status).headers(result.headers).send();
  });

  app.get<{ Params: { id: string } }>('/api/webrtc-streams/:id', { preHandler: requireRoles('admin', 'operator') }, async (request) => (
    toWebrtcStreamDto(await getWebrtcStream(request.params.id))
  ));

  app.get<{ Params: { id: string } }>('/api/webrtc-streams/:id/edit', { preHandler: requireRoles('admin') }, async (request) => (
    toWebrtcStreamEditDto(await getWebrtcStream(request.params.id))
  ));

  app.patch<{ Params: { id: string } }>('/api/webrtc-streams/:id', { preHandler: requireRoles('admin') }, async (request) => {
    const input = updateWebrtcStreamSchema.parse(request.body);
    const row = await updateWebrtcStream(request.params.id, input);
    if (input.enabled === false) await releasePtzTarget('WEBRTC_STREAM', request.params.id);
    return toWebrtcStreamDto(row);
  });

  app.delete<{ Params: { id: string } }>('/api/webrtc-streams/:id', { preHandler: requireRoles('admin') }, async (request, reply) => {
    await releasePtzTarget('WEBRTC_STREAM', request.params.id);
    await deleteWebrtcStream(request.params.id);
    return reply.code(204).send();
  });
}
