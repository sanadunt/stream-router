import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = path.resolve(webRoot, '../..');
const probeDir = path.join(webRoot, 'node_modules', '.vite-fs-probe');

describe('Vite dev server /@fs/', () => {
  let server: ViteDevServer;
  let baseUrl = '';

  beforeAll(async () => {
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(path.join(probeDir, 'stream-router.db'), 'SQLite format 3\0');
    server = await createServer({
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: false }
    });
    await server.listen();
    const address = server.httpServer?.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30000);

  afterAll(async () => {
    await server?.close();
    rmSync(probeDir, { recursive: true, force: true });
  });

  it('menolak file di luar apps/web seperti package.json root workspace', async () => {
    const response = await fetch(`${baseUrl}/@fs${path.join(workspaceRoot, 'package.json')}`);
    expect(response.status).toBe(403);
  });

  it('menolak file database walau berada di dalam direktori yang diizinkan', async () => {
    const response = await fetch(`${baseUrl}/@fs${path.join(probeDir, 'stream-router.db')}`);
    expect(response.status).toBe(403);
  });

  it('tetap melayani source web dan dependency dari node_modules root', async () => {
    const source = await fetch(`${baseUrl}/src/navigation.ts`);
    expect(source.status).toBe(200);
    const dependency = await fetch(`${baseUrl}/@fs${path.join(workspaceRoot, 'node_modules', 'react', 'package.json')}`);
    expect(dependency.status).toBe(200);
  });
});
