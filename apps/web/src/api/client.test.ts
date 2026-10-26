import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, onSessionExpired } from './client';

function respond(status: number, body: string, contentType = 'application/json; charset=utf-8') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } })));
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (reason) {
    return reason as ApiError;
  }
  throw new Error('request seharusnya gagal');
}

const unauthorized = JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Silakan login terlebih dahulu', details: null, requestId: 'r1' } });

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('memberi tahu App saat sesi ditolak pada request biasa', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    respond(401, unauthorized);
    const error = await rejection(api('/api/routes'));
    unsubscribe();
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tidak menganggap login gagal, cek sesi awal, atau 401 non-sesi sebagai sesi berakhir', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    respond(401, JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Username atau password salah' } }));
    await rejection(api('/api/auth/login', { method: 'POST', body: '{}' }));
    respond(401, unauthorized);
    await rejection(api('/api/auth/me'));
    respond(401, JSON.stringify({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Password Administrator saat ini salah' } }));
    const error = await rejection(api('/api/auth/passwords/operator', { method: 'PATCH', body: '{}' }));
    unsubscribe();
    expect(error.message).toBe('Password Administrator saat ini salah');
    expect(listener).not.toHaveBeenCalled();
  });

  it('mengubah halaman HTML 502 dari proxy menjadi ApiError berbahasa Indonesia', async () => {
    respond(502, '<html><head><title>502 Bad Gateway</title></head></html>', 'text/html');
    const error = await rejection(api('/api/routes'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toBe('Server sedang tidak tersedia (HTTP 502). Coba lagi beberapa saat.');
  });

  it('memakai pesan Indonesia untuk 429 tanpa envelope dan message biasa untuk error lain', async () => {
    respond(429, JSON.stringify({ statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }));
    expect((await rejection(api('/api/routes'))).message).toBe('Terlalu banyak permintaan ke server. Tunggu sebentar lalu coba lagi.');
    respond(413, JSON.stringify({ statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' }));
    expect((await rejection(api('/api/routes', { method: 'POST', body: '{}' }))).message).toBe('Request body is too large');
  });

  it('menambahkan isu validasi Zod pertama dari details ke pesan VALIDATION_ERROR', async () => {
    const validation = (details: unknown, message = 'Data request tidak valid') => JSON.stringify({
      error: { code: 'VALIDATION_ERROR', message, details, requestId: 'r1' }
    });
    respond(400, validation({ formErrors: [], fieldErrors: { outputs: ['Output online tidak boleh duplikat'] } }));
    expect((await rejection(api('/api/routes', { method: 'POST', body: '{}' }))).message)
      .toBe('Data request tidak valid — outputs: Output online tidak boleh duplikat');
    respond(400, validation({ formErrors: ['Minimal satu field wajib diisi'], fieldErrors: {} }));
    expect((await rejection(api('/api/routes', { method: 'POST', body: '{}' }))).message)
      .toBe('Data request tidak valid — Minimal satu field wajib diisi');
    respond(400, validation({ issues: [{ path: ['subscriptions', 0, 'cameraId'], message: 'Invalid' }] }));
    expect((await rejection(api('/api/routes', { method: 'POST', body: '{}' }))).message)
      .toBe('Data request tidak valid — subscriptions.0.cameraId: Invalid');
    // Pesan yang sudah spesifik tidak diulang.
    respond(400, validation({ formErrors: [], fieldErrors: { outputs: ['Output online tidak boleh duplikat'] } }, 'outputs: Output online tidak boleh duplikat'));
    expect((await rejection(api('/api/routes', { method: 'POST', body: '{}' }))).message)
      .toBe('outputs: Output online tidak boleh duplikat');
    respond(400, JSON.stringify({ error: { code: 'ROUTE_DISABLED', message: 'Route sedang disabled', details: { fieldErrors: { x: ['y'] } } } }));
    expect((await rejection(api('/api/routes', { method: 'POST', body: '{}' }))).message).toBe('Route sedang disabled');
  });

  it('membungkus kegagalan jaringan sebagai ApiError status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await rejection(api('/api/routes'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toBe('Tidak dapat terhubung ke server. Periksa koneksi jaringan.');
  });

  it('menerima body kosong tetapi menolak body sukses yang bukan JSON', async () => {
    respond(200, '');
    await expect(api('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    respond(200, '<!doctype html><html></html>', 'text/html');
    const error = await rejection(api('/api/routes'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Respons server tidak valid (HTTP 200).');
  });
});
