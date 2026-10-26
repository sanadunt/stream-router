import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerRoute } from '../types';

// Embed pihak ketiga tetap dapat memutar video, membuka popup, dan login di dalam frame,
// tetapi tidak dapat mengarahkan ulang dashboard (mis. ke halaman login palsu).
const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms';

interface Props {
  name: string;
  source: ViewerRoute['webrtc'];
}

export function StreamMediaPlayer({ name, source }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mjpegRef = useRef<HTMLImageElement | null>(null);
  const nativeHls = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(source.mode === 'HLS' || source.mode === 'MJPEG' || source.mode === 'MP4');

  useEffect(() => {
    setError('');
    setLoading(source.mode === 'HLS' || source.mode === 'MJPEG' || source.mode === 'MP4');
    nativeHls.current = false;
    if (source.mode !== 'HLS') return;
    const video = videoRef.current;
    if (!video) return;
    let hls: import('hls.js').default | undefined;
    let active = true;
    let networkRecoveryUsed = false;
    let mediaRecoveryUsed = false;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari/iOS dan Chromium terbaru memutar HLS native; error-nya ditangani onError <video>.
      nativeHls.current = true;
      video.src = source.url;
      void video.play().catch(() => undefined);
    } else {
      void import('hls.js').then(({ default: Hls, ErrorTypes }) => {
        if (!active) return;
        if (!Hls.isSupported()) {
          setLoading(false);
          setError('Browser ini tidak mendukung HLS.');
          return;
        }
        hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(source.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (active) void video.play().catch(() => undefined);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!active || !data.fatal) return;
          if (data.type === ErrorTypes.NETWORK_ERROR && !networkRecoveryUsed) {
            networkRecoveryUsed = true;
            hls?.startLoad();
          } else if (data.type === ErrorTypes.MEDIA_ERROR && !mediaRecoveryUsed) {
            mediaRecoveryUsed = true;
            hls?.recoverMediaError();
          } else {
            setLoading(false);
            setError('HLS gagal dimainkan. Periksa URL, CORS, dan kompatibilitas codec.');
          }
        });
      }).catch(() => {
        if (active) {
          setLoading(false);
          setError('Player HLS gagal dimuat.');
        }
      });
    }
    return () => {
      active = false;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [attempt, source.mode, source.url]);

  // Browser tetap menahan koneksi media setelah elemen dilepas dari DOM (MJPEG multipart
  // sampai GC), sehingga batas 6 koneksi per host habis. Lepaskan src saat elemen dilepas.
  const attachMjpeg = useCallback((img: HTMLImageElement | null) => {
    if (!img) mjpegRef.current?.removeAttribute('src');
    mjpegRef.current = img;
  }, []);
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    const previous = videoRef.current;
    if (!video && previous) {
      previous.removeAttribute('src');
      previous.load();
    }
    videoRef.current = video;
  }, []);

  if (source.mode === 'IFRAME' || source.mode === 'YOUTUBE') {
    return <div className="viewer-direct-player">
      <iframe
        key={source.url}
        src={source.url}
        title={`Viewer ${name}`}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
        sandbox={EMBED_SANDBOX}
        // YouTube menolak embed tanpa header Referer, jadi hanya IFRAME umum yang dikosongkan.
        referrerPolicy={source.mode === 'IFRAME' ? 'no-referrer' : undefined}
      />
      {source.mode === 'YOUTUBE' && <small className="viewer-player-note">Jika pemilik video menonaktifkan embed, gunakan tombol Buka di tab baru.</small>}
    </div>;
  }

  if (source.mode === 'WHEP') {
    return <div className="viewer-whep"><p>WHEP memerlukan player WebRTC dari provider media.</p><a href={source.openUrl ?? source.url} target="_blank" rel="noreferrer">Buka stream {name}</a></div>;
  }

  if (source.mode === 'MJPEG') {
    const retryUrl = attempt ? `${source.url}${source.url.includes('?') ? '&' : '?'}_retry=${attempt}` : source.url;
    return <div className="viewer-direct-player">
      {loading && !error && <div className="viewer-player-status">Memuat MJPEG…</div>}
      <img
        key={retryUrl}
        ref={attachMjpeg}
        src={retryUrl}
        alt={`Stream MJPEG ${name}`}
        onLoad={() => { setLoading(false); setError(''); }}
        onError={() => { setLoading(false); setError('MJPEG gagal dimuat. Periksa URL, koneksi kamera, dan mixed content.'); }}
      />
      {error && <PlayerError message={error} onRetry={() => setAttempt((value) => value + 1)} />}
    </div>;
  }

  return <div className="viewer-direct-player">
    {loading && !error && <div className="viewer-player-status">Memuat {source.mode}…</div>}
    <video
      key={`${source.mode}-${source.url}-${attempt}`}
      ref={attachVideo}
      src={source.mode === 'MP4' ? source.url : undefined}
      controls
      autoPlay
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={() => { setLoading(false); setError(''); }}
      onPlaying={() => setLoading(false)}
      onError={() => {
        if (source.mode === 'MP4') {
          setLoading(false);
          setError('MP4 gagal dimainkan. Periksa URL, Range request, mixed content, dan codec.');
        } else if (source.mode === 'HLS' && nativeHls.current) {
          setLoading(false);
          setError('HLS gagal dimainkan. Periksa URL, ketersediaan stream, dan kompatibilitas codec.');
        }
      }}
    />
    {error && <PlayerError message={error} onRetry={() => setAttempt((value) => value + 1)} />}
  </div>;
}

function PlayerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="viewer-player-error"><p>{message}</p><button type="button" onClick={onRetry}>Coba lagi</button></div>;
}
