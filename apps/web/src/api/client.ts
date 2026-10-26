export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();
// Login (password salah) dan pemeriksaan sesi awal menangani 401 sendiri.
const SESSION_CHECK_PATHS = new Set(['/api/auth/login', '/api/auth/me']);
const NOT_JSON = Symbol('not-json');

/** Dipanggil saat API menolak sesi yang sedang dipakai (kedaluwarsa atau dicabut). */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => { sessionExpiredListeners.delete(listener); };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers
    });
  } catch (reason) {
    if (init.signal?.aborted) throw reason;
    throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi jaringan.', 0);
  }
  if (response.status === 204) return undefined as T;
  const data = await readBody(response);
  if (!response.ok) {
    const envelope = isRecord(data) && isRecord(data.error) ? data.error : undefined;
    const code = typeof envelope?.code === 'string' ? envelope.code : undefined;
    const error = new ApiError(errorMessage(data, envelope, response.status), response.status, code);
    if (response.status === 401 && code === 'UNAUTHORIZED' && !SESSION_CHECK_PATHS.has(path.split('?')[0])) {
      for (const listener of [...sessionExpiredListeners]) listener();
    }
    throw error;
  }
  if (data === NOT_JSON) throw new ApiError(`Respons server tidak valid (HTTP ${response.status}).`, response.status);
  return data as T;
}

async function readBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return NOT_JSON;
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Halaman HTML 502/504 dari nginx atau proxy saat API sedang restart.
    return NOT_JSON;
  }
}

function errorMessage(data: unknown, envelope: Record<string, unknown> | undefined, status: number): string {
  if (typeof envelope?.message === 'string' && envelope.message) {
    const issue = envelope.code === 'VALIDATION_ERROR' ? firstValidationIssue(envelope.details) : null;
    // Pesan Zod spesifik (mis. "Output online tidak boleh duplikat") hanya ada di details.
    if (!issue || envelope.message.includes(issue.message)) return envelope.message;
    return `${envelope.message} — ${issue.field ? `${issue.field}: ` : ''}${issue.message}`;
  }
  if (status === 429) return 'Terlalu banyak permintaan ke server. Tunggu sebentar lalu coba lagi.';
  if (isRecord(data) && typeof data.message === 'string' && data.message) return data.message;
  if (status === 502 || status === 503 || status === 504) return `Server sedang tidak tersedia (HTTP ${status}). Coba lagi beberapa saat.`;
  return `Server tidak merespons dengan benar (HTTP ${status}).`;
}

/** Isu pertama dari ZodError.flatten() ({formErrors, fieldErrors}) atau fallback {issues}. */
function firstValidationIssue(details: unknown): { field: string; message: string } | null {
  if (!isRecord(details)) return null;
  const formError = Array.isArray(details.formErrors) ? details.formErrors.find(isNonEmptyString) : undefined;
  if (formError) return { field: '', message: formError };
  if (isRecord(details.fieldErrors)) {
    for (const [field, messages] of Object.entries(details.fieldErrors)) {
      const message = Array.isArray(messages) ? messages.find(isNonEmptyString) : undefined;
      if (message) return { field, message };
    }
  }
  if (Array.isArray(details.issues)) {
    for (const item of details.issues) {
      if (!isRecord(item) || !isNonEmptyString(item.message)) continue;
      return { field: Array.isArray(item.path) ? item.path.join('.') : '', message: item.message };
    }
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
