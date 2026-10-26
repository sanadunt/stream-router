import { isIP } from 'node:net';
import { z } from 'zod';

const truthyValue = /^(?:true|1|yes|on)$/i;
const falsyValue = /^(?:false|0|no|off)?$/i;

// Nilai yang tidak dikenali ditolak, bukan diam-diam dianggap false (mis. MEDIAMTX_ENABLED=TRUE).
const booleanString = z.string().default('false').transform((value, context) => {
  const normalized = value.trim();
  if (truthyValue.test(normalized)) return true;
  if (falsyValue.test(normalized)) return false;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Gunakan true atau false' });
  return z.NEVER;
});

const proxyPresets = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isTrustedProxyEntry(entry: string): boolean {
  if (proxyPresets.has(entry.toLowerCase())) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (!family || rest.length) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

// `true` hanya mempercayai reverse proxy di host yang sama (loopback). Mempercayai semua hop
// membuat X-Forwarded-For kiriman client menentukan request.ip, sehingga rate limit login dan
// pemeriksaan localhost dapat dilewati. Proxy di host lain harus disebut sebagai IP/CIDR.
const trustProxyValue = z.string().default('false').transform((value, context): false | string[] => {
  const normalized = value.trim();
  if (falsyValue.test(normalized)) return false;
  if (truthyValue.test(normalized)) return ['loopback'];
  const entries = normalized.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || !entries.every(isTrustedProxyEntry)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Gunakan true, false, atau daftar IP/CIDR proxy dipisah koma'
    });
    return z.NEVER;
  }
  return entries;
});

// Browser selalu mengirim header Origin tanpa path atau slash akhir, jadi nilai dinormalisasi
// agar pemeriksaan CSRF yang membandingkan string secara persis tidak menolak semua mutasi.
const originValue = z.string().trim().transform((value, context) => {
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null') return url.origin;
  } catch {
    // ditangani di bawah
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Gunakan origin http(s), mis. https://kamera.example.com' });
  return z.NEVER;
});

/**
 * Kosong = belum diatur: Secure mengikuti NODE_ENV seperti sebelumnya. `auto` = Secure hanya bila
 * request tiba lewat HTTPS. Hasil parse sengaja tetap berupa nilai yang bila di-String() dan
 * di-parse ulang menghasilkan nilai sama, karena verify-dist membangun env boot dengan cara itu.
 */
export type CookieSecureSetting = '' | 'auto' | boolean;

const cookieSecureValue = z.string().default('').transform((value, context): CookieSecureSetting => {
  const normalized = value.trim();
  if (!normalized) return '';
  if (/^auto$/i.test(normalized)) return 'auto';
  if (truthyValue.test(normalized)) return true;
  if (falsyValue.test(normalized)) return false;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Gunakan auto, true, atau false' });
  return z.NEVER;
});

const dnsLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const hostnamePattern = new RegExp(`^(?=.{1,253}$)${dnsLabel}(?:\\.${dnsLabel})*$`, 'i');

// Dipakai apa adanya di URL WHEP dan webrtcAdditionalHosts MediaMTX, jadi skema, port, atau path
// (mis. http://192.168.1.10:3000) ditolak saat startup alih-alih menghasilkan URL Viewer rusak.
const publicHostValue = z.string().default('').transform((value, context) => {
  const host = value.trim();
  if (!host) return '';
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (isIP(bare)) return bare;
  // Label terakhir yang seluruhnya angka berarti IPv4 salah ketik (mis. 192.168.1), bukan hostname.
  if (hostnamePattern.test(host) && !/(?:^|\.)\d+$/.test(host)) return host;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Gunakan IP atau hostname tanpa skema dan port, mis. 192.168.1.10'
  });
  return z.NEVER;
});

// Hostname tambahan (tanpa skema dan port) yang boleh dipakai browser untuk membuka dashboard di
// production, mis. nama komputer Windows atau nama .local. IP literal dan localhost selalu diterima.
// Hasil parse berupa array; verify-dist menggabungkannya kembali dengan koma.
const allowedHostsValue = z.string().default('').transform((value, context): string[] => {
  const hosts: string[] = [];
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const bare = entry.replace(/^\[(.*)\]$/, '$1');
    const host = (isIP(bare) ? bare : entry.replace(/\.$/, '')).toLowerCase();
    if (!isIP(host) && (!hostnamePattern.test(host) || /(?:^|\.)\d+$/.test(host))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Gunakan daftar hostname tanpa skema dan port dipisah koma, mis. kamera.lan,PC-KAMERA'
      });
      return z.NEVER;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
});

const secureValue = (field: string, minLength: number) => z.string().min(minLength).refine(
  (value) => !/^(?:GANTI_DENGAN_|change-me)/i.test(value),
  `${field} masih memakai nilai contoh`
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1).default('file:../data/stream-router.db'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  MEDIAMTX_ENABLED: booleanString,
  MEDIAMTX_VERSION: z.string().default('v1.19.2'),
  MEDIAMTX_CONFIG_PATH: z.string().default('data/mediamtx/mediamtx.yml'),
  MEDIAMTX_READY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
  MEDIAMTX_PUBLIC_HOST: publicHostValue,
  RECORDING_PATH: z.string().default('data/recordings'),
  AUTH_SECRET: secureValue('AUTH_SECRET', 32),
  APP_ENCRYPTION_KEY: secureValue('APP_ENCRYPTION_KEY', 32),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: secureValue('ADMIN_PASSWORD', 8),
  OPERATOR_PASSWORD: secureValue('OPERATOR_PASSWORD', 8),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_WORKERS: z.coerce.number().int().min(1).max(100).default(10),
  DEFAULT_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(500).default(2000),
  DEFAULT_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1000).default(60000),
  DEFAULT_MAX_RETRIES: z.coerce.number().int().min(0).max(100).default(10),
  FFMPEG_STOP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  MAX_LOG_LINES_PER_ROUTE: z.coerce.number().int().min(100).max(100000).default(5000),
  CORS_ORIGIN: originValue.default('http://localhost:5173'),
  ALLOWED_HOSTS: allowedHostsValue,
  PUBLIC_APP_NAME: z.string().default('Camera Integration'),
  TRUST_PROXY: trustProxyValue,
  COOKIE_SECURE: cookieSecureValue,
  WEBRTC_ALLOWED_ORIGINS: z.string().default(''),
  STREAM_VIEW_ALLOWED_ORIGINS: z.string().default(''),
  STREAM_VIEW_ALLOW_INSECURE_HTTP: booleanString
});

export type AppEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(fields: string[]) {
    super(`Konfigurasi belum lengkap: ${fields.join(', ')}. Buat atau lengkapi file .env di root project.`);
    this.name = 'EnvValidationError';
  }
}

let cached: AppEnv | undefined;
export function getEnv(): AppEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')).filter(Boolean))];
    throw new EnvValidationError(fields);
  }
  cached = result.data;
  return cached;
}
