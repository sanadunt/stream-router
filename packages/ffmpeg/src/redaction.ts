// Substring, bukan nama persis: kamera dan CDN juga memakai pwd, passwd, access_token, api_key, jwt, dll.
const SECRET_QUERY_KEY = /pass|pwd|secret|token|key|auth|sig|jwt/i;
// Kamera murah (XMEye/ICSee) menaruh kredensial di path, dipisah `&` atau `_`:
// `/user=admin&password=X&channel=1` atau `/user=admin_password=X_channel=1`. Seluruh segmen disamarkan
// karena password sendiri boleh memuat `_`.
const CREDENTIAL_PATH_SEGMENT = /(?:^|[&_?;])(?:pass(?:word|wd)?|pwd)=/i;
const RTMP_PROTOCOLS = new Set(['rtmp:', 'rtmps:']);
const MASK = '***';
// URL berhenti di pemisah slave muxer tee (`|` tanpa escape yang diikuti `[opsi]` atau URL berikutnya).
// Pasangan backslash (escape tee untuk `|`, `[`, `]`, `'`) tetap bagian URL, sehingga stream key yang memuat
// `|` tidak terpotong lalu bocor setelah pemisah; `|` biasa di password kamera juga tetap ikut disamarkan.
const URL_IN_TEXT = /\b(?:rtsp|rtmps?):\/\/(?:(?!(?:rtsp|rtmps?):\/\/)(?:\\\S|(?!\|(?:\[|(?:rtsp|rtmps?):\/\/))[^\s\\]))+/gi;
const TRAILING_PUNCTUATION = /['"),;:\]]+$/;

// Segmen pertama path RTMP adalah app; satu segmen saja tidak memuat stream key.
// FFmpeg juga membaca query/fragment sebagai bagian stream key, mis. backup YouTube `live2?backup=1/<key>`.
function maskStreamKey(pathname: string): string {
  if (pathname.split('/').filter(Boolean).length < 2) return pathname;
  return pathname.replace(/[^/]+(?=\/*$)/, MASK);
}

function maskCredentialSegments(pathname: string): string {
  return pathname.split('/').map((segment) => CREDENTIAL_PATH_SEGMENT.test(segment) ? MASK : segment).join('/');
}

function redactUnparsed(value: string): string {
  const match = /^([a-z][a-z\d+.-]*:\/\/[^/?#]*)([^?#]*)([?#]?)/i.exec(value);
  if (!match) return value;
  const [, authority = '', pathname = '', separator = ''] = match;
  const maskedPath = /^rtmps?:/i.test(authority) ? maskStreamKey(pathname) : maskCredentialSegments(pathname);
  return `${authority}${maskedPath}${separator && `${separator}${MASK}`}`;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = MASK;
    if (url.password) url.password = MASK;
    if (RTMP_PROTOCOLS.has(url.protocol)) {
      url.pathname = maskStreamKey(url.pathname);
      if (url.search) url.search = MASK;
      if (url.hash) url.hash = MASK;
    } else {
      const maskedPath = maskCredentialSegments(url.pathname);
      if (maskedPath !== url.pathname) url.pathname = maskedPath;
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_QUERY_KEY.test(key)) url.searchParams.set(key, MASK);
      }
    }
    return url.toString();
  } catch {
    return redactUnparsed(value.replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, '://***:***@'));
  }
}

export function redactText(value: string): string {
  return value.replace(URL_IN_TEXT, (match) => {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    return `${redactUrl(match.slice(0, match.length - tail.length))}${tail}`;
  });
}
