import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const webRoot = fileURLToPath(new URL('.', import.meta.url));

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} harus berupa port valid (1-65535)`);
  }
  return port;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, '');
  const apiPort = parsePort(env.PORT, 3000, 'PORT');
  const webPort = parsePort(env.WEB_PORT, 5173, 'WEB_PORT');
  const apiHost = env.HOST && env.HOST !== '0.0.0.0' ? env.HOST : '127.0.0.1';

  return {
    envDir: workspaceRoot,
    // npm dapat menyimpan Vite di root dan workspace; normalkan tipe plugin lintas instalasi.
    plugins: [react() as unknown as PluginOption],
    server: {
      host: '0.0.0.0',
      port: webPort,
      strictPort: true,
      fs: {
        // Tanpa allow eksplisit Vite melayani seluruh root workspace lewat /@fs/,
        // termasuk database, recording, dan backup di data/ tanpa autentikasi.
        allow: [webRoot, path.join(workspaceRoot, 'node_modules')],
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '*.db', '*.db-*', '*.sqlite*', '**/.runtime/**']
      },
      proxy: {
        '/api': {
          target: `http://${apiHost}:${apiPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
