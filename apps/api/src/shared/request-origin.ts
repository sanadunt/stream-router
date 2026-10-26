import { isIP } from 'node:net';

// Host header hanya boleh berupa host[:port]. Tanpa batasan ini, Host seperti `x@target` akan
// di-parse URL sebagai userinfo dan ikut dianggap origin `target`.
const hostHeaderPattern = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Origin yang sama dengan alamat yang dipakai browser untuk membuka server ini, mis. dashboard
 * dibuka lewat http://192.168.1.10:3000 dari host lain di LAN. `protocol` berasal dari
 * request.protocol, sehingga X-Forwarded-Proto hanya berlaku dari proxy TRUST_PROXY.
 */
export function isSameOriginRequest(origin: string, protocol: string | undefined, host: string | undefined): boolean {
  if ((protocol !== 'http' && protocol !== 'https') || !host || !hostHeaderPattern.test(host)) return false;
  const requestOrigin = parseOrigin(`${protocol}://${host}`);
  return requestOrigin !== null && parseOrigin(origin) === requestOrigin;
}

/**
 * Request DNS rebinding juga lolos pemeriksaan ini (Origin dan Host sama-sama domain penyerang).
 * Yang menolaknya adalah allowlist Host (`isAllowedRequestHost`) yang berjalan lebih dulu untuk
 * setiap request production: tanpa itu halaman penyerang dapat login Viewer (tanpa password) dan
 * memakai cookie sesi miliknya sendiri untuk domain tersebut.
 */
export function isAllowedRequestOrigin(
  origin: string,
  corsOrigin: string,
  protocol: string | undefined,
  host: string | undefined
): boolean {
  return origin === corsOrigin || isSameOriginRequest(origin, protocol, host);
}

/** Hostname tanpa port dan kurung IPv6, huruf kecil, tanpa titik akhir; null bila Host tidak wajar. */
export function requestHostname(host: string): string | null {
  if (!hostHeaderPattern.test(host)) return null;
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  const hostname = bracketed ? bracketed[1]! : host.replace(/:\d{1,5}$/, '');
  return hostname.toLowerCase().replace(/\.$/, '') || null;
}

/** Hostname yang boleh dipakai browser untuk membuka dashboard, selain IP literal dan localhost. */
export function allowedRequestHostnames(options: {
  corsOrigin: string;
  publicHost?: string;
  allowedHosts?: readonly string[];
}): Set<string> {
  const hosts = new Set<string>(['localhost']);
  try {
    hosts.add(new URL(options.corsOrigin).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase());
  } catch {
    // CORS_ORIGIN sudah divalidasi env; nilai rusak cukup tidak menambah host.
  }
  const publicHost = options.publicHost?.trim().toLowerCase();
  if (publicHost) hosts.add(publicHost);
  for (const host of options.allowedHosts ?? []) hosts.add(host.toLowerCase());
  return hosts;
}

/**
 * Perlindungan DNS rebinding: domain penyerang yang di-resolve ke IP server tidak pernah cocok
 * dengan IP literal, localhost, maupun hostname yang didaftarkan Admin. Request tanpa Host
 * (klien HTTP/1.0 non-browser) diterima karena browser selalu mengirim Host.
 */
export function isAllowedRequestHost(host: string | undefined, allowedHostnames: ReadonlySet<string>): boolean {
  if (host === undefined || host === '') return true;
  const hostname = requestHostname(host);
  if (!hostname) return false;
  return isIP(hostname) !== 0 || allowedHostnames.has(hostname);
}
