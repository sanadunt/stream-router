import { randomBytes } from 'node:crypto';
import type { MqttClient } from 'mqtt';

/**
 * Keepalive pendek agar koneksi half-open (NAT idle drop, 4G) terdeteksi dalam ±30 detik;
 * default mqtt.js 60 detik baru memutus setelah 90 detik.
 */
export const MQTT_KEEPALIVE_SECONDS = 20;

/** Batas tunggu SUBACK/UNSUBACK/publish/DISCONNECT agar broker macet tidak menahan start/stop route. */
export const MQTT_IO_TIMEOUT_MS = 4000;

/**
 * clientId unik per instance client. Dua client dengan clientId sama saling menendang
 * (takeover) di broker dan reconnect selamanya; clean session membuat suffix acak aman.
 */
export function mqttClientId(prefix: string, brokerId: string): string {
  return `${prefix}-${process.pid}-${brokerId.replaceAll('-', '').slice(0, 12)}-${randomBytes(4).toString('hex')}`;
}

export function withMqttTimeout<T>(operation: Promise<T>, label: string, timeoutMs = MQTT_IO_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Menutup client dengan DISCONNECT. Pada socket half-open `endAsync()` bisa menunggu FIN dari
 * peer yang sudah hilang, jadi setelah batas waktu stream dihancurkan paksa.
 */
export async function closeMqttClient(client: MqttClient): Promise<void> {
  try {
    await withMqttTimeout(client.endAsync(), 'Menutup koneksi MQTT');
  } catch {
    (client.stream as { destroy?: () => void } | undefined)?.destroy?.();
  }
}
