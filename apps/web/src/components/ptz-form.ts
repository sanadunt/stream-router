import type { MqttBridgeConfig, MqttBridgeSubscription, PtzConfigDto, PtzConnectionStatus } from '../types';

export interface PtzFormState {
  provider: 'NONE' | 'ONVIF' | 'MQTT';
  enabled: boolean;
  zoomEnabled: boolean;
  passwordConfigured: boolean;
  connection: PtzConnectionStatus;
  onvif: {
    host: string;
    port: number;
    username: string;
    password: string;
    useTls: boolean;
    path: string;
    profileToken: string;
  };
  mqtt: {
    brokerId: string;
    cameraId: string;
  };
}

export function emptyPtzForm(): PtzFormState {
  return {
    provider: 'NONE',
    enabled: true,
    zoomEnabled: false,
    passwordConfigured: false,
    connection: { state: 'DISABLED', checkedAt: null, message: 'PTZ dinonaktifkan' },
    onvif: {
      host: '',
      port: 80,
      username: '',
      password: '',
      useTls: false,
      path: '/onvif/device_service',
      profileToken: ''
    },
    mqtt: {
      brokerId: '',
      cameraId: ''
    }
  };
}

export function ptzFormFromDto(dto: PtzConfigDto): PtzFormState {
  const state = emptyPtzForm();
  state.connection = dto.connection;
  if (dto.provider === 'NONE') return state;
  state.provider = dto.provider;
  state.enabled = dto.enabled;
  state.zoomEnabled = dto.zoomEnabled;
  if (dto.provider === 'ONVIF') {
    state.passwordConfigured = dto.passwordConfigured;
    state.onvif = {
      ...state.onvif,
      host: dto.host,
      port: dto.port,
      username: dto.username,
      useTls: dto.useTls,
      path: dto.path,
      profileToken: dto.profileToken ?? ''
    };
  } else {
    state.mqtt = {
      brokerId: dto.brokerId,
      cameraId: dto.cameraId
    };
  }
  return state;
}

export function ptzRequestBody(state: PtzFormState): Record<string, unknown> | null {
  if (state.provider === 'NONE') return null;
  const shared = { provider: state.provider, enabled: state.enabled, zoomEnabled: state.zoomEnabled };
  if (state.provider === 'ONVIF') {
    return {
      ...shared,
      host: state.onvif.host.trim(),
      port: state.onvif.port,
      username: state.onvif.username.trim(),
      ...(state.onvif.password ? { password: state.onvif.password } : {}),
      useTls: state.onvif.useTls,
      path: state.onvif.path.trim(),
      profileToken: state.onvif.profileToken.trim()
    };
  }
  return {
    ...shared,
    brokerId: state.mqtt.brokerId,
    cameraId: state.mqtt.cameraId.trim()
  };
}

export type PtzSaveAction =
  | { kind: 'PUT'; body: Record<string, unknown> }
  | { kind: 'DELETE' }
  | { kind: 'KEEP' };

/**
 * storedProvider = provider yang tersimpan di server, atau null bila konfigurasi
 * PTZ belum berhasil dimuat ke form. Tanpa konfigurasi termuat, form kosong
 * (provider NONE) bukan pilihan pengguna, jadi PTZ tersimpan tidak boleh dihapus.
 */
export function ptzSaveAction(state: PtzFormState, storedProvider: PtzFormState['provider'] | null): PtzSaveAction {
  const body = ptzRequestBody(state);
  if (body) return { kind: 'PUT', body };
  if (storedProvider !== null && storedProvider !== 'NONE') return { kind: 'DELETE' };
  return { kind: 'KEEP' };
}

export function mqttBridgeRequestBody(
  provider: PtzFormState['provider'],
  enabled: boolean,
  subscriptions: MqttBridgeSubscription[]
): { enabled: boolean; subscriptions: Array<{ brokerId: string; cameraId: string }> } {
  if (provider !== 'ONVIF') return { enabled: false, subscriptions: [] };
  const items = subscriptions.map((item) => ({ brokerId: item.brokerId, cameraId: item.cameraId.trim() }));
  return {
    enabled,
    // Saat bridge nonaktif, assignment ber-ID kosong tersembunyi dan ditolak schema API, jadi tidak
    // dikirim. Saat aktif, baris kosong tetap dikirim: membuangnya membuat API menghapus subscription
    // broker tersebut tanpa peringatan (PUT mengganti seluruh daftar).
    subscriptions: enabled ? items : items.filter((item) => item.cameraId)
  };
}

/** Broker yang dicentang pada bridge aktif tetapi ID camera-nya masih kosong. */
export function blankBridgeAssignments(
  provider: PtzFormState['provider'],
  enabled: boolean,
  subscriptions: MqttBridgeSubscription[]
): string[] {
  if (provider !== 'ONVIF' || !enabled) return [];
  return subscriptions.filter((item) => !item.cameraId.trim()).map((item) => item.brokerId);
}

export interface MqttBridgeStatusView {
  state: 'connected' | 'connecting' | 'disconnected';
  label: string;
}

/** Bridge aktif yang belum terhubung ONVIF belum subscribe topic apa pun dan masih mencoba ulang. */
export function mqttBridgeStatus(runtime: MqttBridgeConfig['runtime']): MqttBridgeStatusView {
  if (!runtime.active) return { state: 'disconnected', label: 'Bridge tidak aktif' };
  if (!runtime.onvifConnected) return { state: 'connecting', label: 'Menunggu ONVIF (dicoba ulang otomatis)' };
  return { state: 'connected', label: 'Bridge aktif' };
}
