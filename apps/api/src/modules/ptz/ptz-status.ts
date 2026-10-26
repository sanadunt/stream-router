import type { PtzTargetType } from './ptz-service.js';

export type PtzConnectionState = 'DISABLED' | 'UNTESTED' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface PtzConnectionStatus {
  state: PtzConnectionState;
  checkedAt: string | null;
  message: string;
}

const statuses = new Map<string, PtzConnectionStatus>();

function key(targetType: PtzTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}

export function getPtzConnectionStatus(
  targetType: PtzTargetType,
  targetId: string,
  enabled: boolean
): PtzConnectionStatus {
  if (!enabled) return { state: 'DISABLED', checkedAt: null, message: 'PTZ dinonaktifkan' };
  return statuses.get(key(targetType, targetId))
    ?? { state: 'UNTESTED', checkedAt: null, message: 'Koneksi PTZ belum diuji sejak aplikasi dimulai' };
}

export function setPtzConnectionStatus(
  targetType: PtzTargetType,
  targetId: string,
  state: PtzConnectionState,
  message: string,
  checked = false
): PtzConnectionStatus {
  const status = {
    state,
    checkedAt: checked ? new Date().toISOString() : (statuses.get(key(targetType, targetId))?.checkedAt ?? null),
    message
  };
  statuses.set(key(targetType, targetId), status);
  return status;
}

export function resetPtzConnectionStatus(targetType: PtzTargetType, targetId: string): void {
  statuses.delete(key(targetType, targetId));
}

export function clearPtzConnectionStatuses(): void {
  statuses.clear();
}
