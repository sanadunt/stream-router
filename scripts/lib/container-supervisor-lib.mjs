// Logika container-supervisor.mjs yang dapat diuji tanpa Docker: backoff restart, bootstrap
// secret, validasi password role dan public host, serta supervisor proses anak (berjalan di bawah
// tini sebagai PID 1).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';

export const GENERATED_SECRET_KEYS = Object.freeze(['AUTH_SECRET', 'APP_ENCRYPTION_KEY']);
export const ROLE_PASSWORD_KEYS = Object.freeze(['ADMIN_PASSWORD', 'OPERATOR_PASSWORD']);
export const RESTART_POLICY = Object.freeze({ initialDelayMs: 1_000, maxDelayMs: 30_000, stableAfterMs: 60_000 });

// Harus sama dengan secureValue() di apps/api/src/config/env.ts.
const PLACEHOLDER = /^(?:GANTI_DENGAN_|change-me)/i;
const SECRET_MIN_LENGTH = 32;
const PASSWORD_MIN_LENGTH = 8;

export function generateSecret() {
  return randomBytes(32).toString('base64url');
}

/** Jeda restart ke-`failures` (0 = crash pertama): 1 s, 2 s, 4 s, ... dibatasi maxDelayMs. */
export function restartDelayMs(failures, policy = RESTART_POLICY) {
  const exponent = Math.min(Math.max(0, Math.floor(failures)), 30);
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
}

/**
 * `failures` = crash beruntun sebelum exit ini. Child yang sempat berjalan stabil minimal
 * stableAfterMs dianggap pulih, sehingga hitungan backoff dimulai lagi dari jeda awal.
 */
export function planRestart(failures, uptimeMs, policy = RESTART_POLICY) {
  const consecutive = uptimeMs >= policy.stableAfterMs ? 0 : failures;
  return { delayMs: restartDelayMs(consecutive, policy), failures: consecutive + 1 };
}

/** Parser KEY=VALUE minimal untuk file secret (baris kosong dan komentar # diabaikan). */
export function parseEnvFile(content) {
  const entries = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    entries[match[1]] = value;
  }
  return entries;
}

export function serializeSecretsFile(entries) {
  const lines = [
    '# Dibuat otomatis oleh scripts/container-supervisor.mjs. Jangan dibagikan dan jangan dihapus:',
    '# tanpa APP_ENCRYPTION_KEY yang sama, credential kamera terenkripsi di database tidak dapat dibuka.',
    '# Ikutkan file ini setiap kali mem-backup volume data.'
  ];
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value)) throw new Error(`Nilai ${key} tidak boleh berisi baris baru.`);
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Pesan masalah tanpa pernah menyertakan nilai secret. */
export function secretProblem(key, value) {
  if (PLACEHOLDER.test(value)) return `${key} masih memakai nilai contoh`;
  if (value.length < SECRET_MIN_LENGTH) return `${key} minimal ${SECRET_MIN_LENGTH} karakter`;
  return null;
}

/**
 * Menentukan AUTH_SECRET dan APP_ENCRYPTION_KEY: nilai dari environment menang, lalu nilai
 * tersimpan, lalu dibuat baru. APP_ENCRYPTION_KEY tidak pernah dibuat baru bila database sudah
 * ada, karena key baru membuat credential terenkripsi yang sudah tersimpan tidak dapat dibuka.
 * `persist` berisi isi file secret baru bila ada nilai yang dibuat, selain itu null.
 */
export function resolveSecrets({ env, stored = {}, databaseExists = false, generate = generateSecret }) {
  const values = {};
  const sources = {};
  const problems = [];
  const warnings = [];
  const persisted = { ...stored };
  let changed = false;

  for (const key of GENERATED_SECRET_KEYS) {
    const fromEnv = (env[key] ?? '').trim();
    const fromFile = (stored[key] ?? '').trim();
    if (fromEnv) {
      const problem = secretProblem(key, fromEnv);
      if (problem) {
        problems.push(`${problem}. Kosongkan ${key} di .env agar dibuat otomatis, atau isi dengan nilai acak minimal ${SECRET_MIN_LENGTH} karakter`);
        continue;
      }
      values[key] = fromEnv;
      sources[key] = 'env';
      if (key === 'APP_ENCRYPTION_KEY' && fromFile && fromFile !== fromEnv) {
        warnings.push('APP_ENCRYPTION_KEY dari environment berbeda dengan key yang tersimpan di volume data. Key dari environment dipakai; credential yang terenkripsi dengan key tersimpan hanya dapat dibuka setelah `npm run secrets:reencrypt`.');
      }
      continue;
    }
    if (fromFile) {
      const problem = secretProblem(key, fromFile);
      if (problem) {
        problems.push(`${problem} di file secret tersimpan. Perbaiki atau pulihkan file tersebut dari backup; key tidak dibuat ulang otomatis`);
        continue;
      }
      values[key] = fromFile;
      sources[key] = 'file';
      continue;
    }
    if (key === 'APP_ENCRYPTION_KEY' && databaseExists) {
      problems.push('APP_ENCRYPTION_KEY tidak ditemukan, padahal database sudah ada. Pulihkan file secret dari backup volume data atau isi APP_ENCRYPTION_KEY lama di .env; key baru tidak dibuat agar credential kamera yang tersimpan tetap dapat dibuka');
      continue;
    }
    const generated = generate();
    values[key] = generated;
    sources[key] = 'generated';
    persisted[key] = generated;
    changed = true;
  }

  return { values, sources, problems, warnings, persist: changed ? persisted : null };
}

/** Password bootstrap role wajib ada sebelum API dijalankan (pesan tanpa nilai password). */
export function credentialProblems(env) {
  const problems = [];
  for (const key of ROLE_PASSWORD_KEYS) {
    const value = env[key] ?? '';
    if (!value.trim()) problems.push(`${key} belum diisi`);
    else if (PLACEHOLDER.test(value)) problems.push(`${key} masih memakai nilai contoh`);
    else if (value.length < PASSWORD_MIN_LENGTH) problems.push(`${key} minimal ${PASSWORD_MIN_LENGTH} karakter`);
  }
  return problems;
}

// Harus sama dengan publicHostValue() di apps/api/src/config/env.ts.
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_PATTERN = new RegExp(`^(?=.{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*$`, 'i');

/**
 * MEDIAMTX_PUBLIC_HOST dengan aturan yang sama dengan API: IP (IPv6 boleh dalam kurung siku) atau
 * hostname, tanpa skema, port, atau path. Mengembalikan host ternormalisasi, '' bila kosong, atau
 * null bila tidak valid. Nilai yang ditolak di sini membuat API keluar terus-menerus saat start.
 */
export function normalizePublicHost(value) {
  const host = String(value ?? '').trim();
  if (!host) return '';
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare)) return bare;
  if (HOSTNAME_PATTERN.test(host) && !/(?:^|\.)\d+$/.test(host)) return host;
  return null;
}

/** Path file SQLite dari DATABASE_URL; path relatif mengikuti Prisma (relatif ke folder schema). */
export function sqliteDatabaseFile(databaseUrl, schemaDir) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.startsWith('file:')) return null;
  const location = databaseUrl.slice('file:'.length).split('?')[0];
  if (!location) return null;
  return path.resolve(schemaDir, location);
}

/** Lokasi binary yang diunduh ensure-mediamtx.mjs dan dijalankan run-mediamtx.mjs. */
export function mediaMtxExecutable(rootDir, { version, platform = process.platform, arch = process.arch }) {
  const archName = arch === 'x64' ? 'amd64' : arch;
  return path.join(rootDir, '.runtime', 'mediamtx', version, `${platform}-${archName}`, 'mediamtx');
}

function describeExit(code, signal) {
  return signal ? `sinyal ${signal}` : `exit ${code}`;
}

function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(1))} detik`;
}

// Child berjalan di process group sendiri (detached), sehingga sisa proses miliknya (FFmpeg dari
// API, MediaMTX dari run-mediamtx.mjs) dapat dihentikan bersama tanpa menyentuh supervisor.
function killGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group sudah kosong.
  }
}

/**
 * Menjalankan beberapa child secara independen: child yang crash dijalankan ulang dengan backoff
 * tanpa menyentuh child lain, dan shutdown menghentikan child satu per satu sesuai urutan.
 * service: { name, label, command, args, cwd, env, stopTimeoutMs }.
 */
export class ProcessSupervisor {
  #entries;
  #policy;
  #log;
  #stopping = false;

  constructor({ services, policy = RESTART_POLICY, log = () => undefined }) {
    this.#entries = new Map(services.map((service) => [service.name, {
      service,
      child: null,
      exited: Promise.resolve(),
      startedAt: 0,
      failures: 0,
      timer: null
    }]));
    this.#policy = policy;
    this.#log = log;
  }

  pid(name) {
    return this.#entries.get(name)?.child?.pid ?? null;
  }

  start() {
    for (const name of this.#entries.keys()) this.#launch(name);
  }

  #launch(name) {
    const entry = this.#entries.get(name);
    entry.timer = null;
    if (this.#stopping) return;
    const { service } = entry;
    const child = spawn(service.command, service.args, {
      cwd: service.cwd,
      env: service.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit']
    });
    entry.child = child;
    entry.startedAt = Date.now();
    entry.exited = new Promise((resolve) => {
      let settled = false;
      const settle = (code, signal, error) => {
        if (settled) return;
        settled = true;
        this.#handleExit(entry, child, code, signal, error);
        resolve();
      };
      child.once('exit', (code, signal) => settle(code, signal, null));
      child.once('error', (error) => {
        // Tanpa pid berarti spawn gagal dan event exit tidak akan pernah datang.
        if (child.pid === undefined) settle(null, null, error);
        else this.#log(`${service.label}: ${error.message}`);
      });
    });
    if (child.pid !== undefined) this.#log(`${service.label} dijalankan (pid ${child.pid}).`);
  }

  #handleExit(entry, child, code, signal, error) {
    const { service } = entry;
    if (entry.child === child) entry.child = null;
    killGroup(child.pid, 'SIGKILL');
    const reason = error ? `gagal dijalankan: ${error.message}` : describeExit(code, signal);
    if (this.#stopping) {
      this.#log(`${service.label} berhenti (${reason}).`);
      return;
    }
    const plan = planRestart(entry.failures, Date.now() - entry.startedAt, this.#policy);
    entry.failures = plan.failures;
    this.#log(`${service.label} berhenti tidak terduga (${reason}); dijalankan ulang dalam ${formatSeconds(plan.delayMs)}.`);
    entry.timer = setTimeout(() => this.#launch(service.name), plan.delayMs);
  }

  async #stop(entry) {
    const { service } = entry;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const child = entry.child;
    if (!child) return false;
    const timeoutMs = service.stopTimeoutMs;
    this.#log(`Menghentikan ${service.label} (SIGTERM, batas ${formatSeconds(timeoutMs)})...`);
    child.kill('SIGTERM');
    let timer;
    const timedOut = await Promise.race([
      entry.exited.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      })
    ]);
    clearTimeout(timer);
    if (!timedOut) return false;
    this.#log(`${service.label} tidak berhenti dalam ${formatSeconds(timeoutMs)}; dihentikan paksa (SIGKILL).`);
    killGroup(child.pid, 'SIGKILL');
    child.kill('SIGKILL');
    await entry.exited;
    return true;
  }

  /**
   * Menghentikan child sesuai `order` (child yang tidak disebut dihentikan terakhir).
   * Mengembalikan label child yang harus dihentikan paksa karena melewati stopTimeoutMs.
   */
  async shutdown(order = []) {
    this.#stopping = true;
    for (const entry of this.#entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
    const names = [...order.filter((name) => this.#entries.has(name)), ...[...this.#entries.keys()].filter((name) => !order.includes(name))];
    const forced = [];
    for (const name of names) {
      const entry = this.#entries.get(name);
      if (await this.#stop(entry)) forced.push(entry.service.label);
    }
    return forced;
  }

  /** Penghentian paksa sinkron, untuk sinyal kedua atau handler `exit` proses supervisor. */
  killAll() {
    this.#stopping = true;
    for (const entry of this.#entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      if (entry.child) {
        killGroup(entry.child.pid, 'SIGKILL');
        entry.child.kill('SIGKILL');
      }
    }
  }
}
