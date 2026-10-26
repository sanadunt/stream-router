import { useEffect, useRef } from 'react';
import { connectStreamEvents, createRefreshScheduler } from './stream-events';

const REFRESH_COALESCE_MS = 500;
const FALLBACK_POLL_MS = 15000;

/**
 * Memanggil `onChange` saat status worker berubah, digabung per 500 ms dan tidak
 * pernah tumpang tindih. `routeId` membatasi ke event route tersebut. Koneksi SSE
 * dan polling cadangan dihentikan selama tab tersembunyi agar tidak menghabiskan
 * batas 6 koneksi HTTP/1.1 per host.
 */
export function useStreamEvents(onChange: () => unknown, options: { routeId?: string } = {}): void {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const { routeId } = options;

  useEffect(() => {
    const refresh = createRefreshScheduler(() => onChangeRef.current(), REFRESH_COALESCE_MS);
    const connection = connectStreamEvents({
      createSource: () => new EventSource('/api/events', { withCredentials: true }),
      onChange: refresh.schedule,
      routeId
    });
    const polling = window.setInterval(() => {
      if (!document.hidden) refresh.schedule();
    }, FALLBACK_POLL_MS);
    const onVisibilityChange = () => {
      if (document.hidden) {
        connection.pause();
        return;
      }
      connection.resume();
      refresh.schedule();
    };
    if (!document.hidden) connection.resume();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(polling);
      connection.close();
      refresh.dispose();
    };
  }, [routeId]);
}
