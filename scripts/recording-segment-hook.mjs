#!/usr/bin/env node
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: path.join(rootDir, '.env') });

const segmentPath = process.env.MTX_SEGMENT_PATH;
if (!segmentPath) process.exit(0);
const event = process.argv[2] === 'create' ? 'CREATE' : 'COMPLETE';

const port = Number(process.env.PORT || 3000);
// Harus sama dengan mediamtxHookToken() di recording-routes.ts: token diturunkan dari
// AUTH_SECRET agar kunci penandatangan session tidak pernah dikirim lewat header.
const token = createHmac('sha256', process.env.AUTH_SECRET || '')
  .update('stream-router:mediamtx-segment-hook')
  .digest('base64url');
try {
  const response = await fetch(`http://127.0.0.1:${port}/internal/mediamtx/segments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mediamtx-hook-token': token
    },
    body: JSON.stringify({
      path: process.env.MTX_PATH || '',
      segmentPath,
      event,
      duration: process.env.MTX_SEGMENT_DURATION || ''
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  // Startup reconciliation akan mengindeks segmen ketika API sedang restart.
  process.exitCode = 0;
}
