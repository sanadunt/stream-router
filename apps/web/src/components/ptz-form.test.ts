import { describe, expect, it } from 'vitest';
import { blankBridgeAssignments, emptyPtzForm, mqttBridgeRequestBody, mqttBridgeStatus, ptzSaveAction } from './ptz-form';

describe('PTZ form save action', () => {
  it('tidak menghapus PTZ tersimpan bila konfigurasinya belum berhasil dimuat ke form', () => {
    expect(ptzSaveAction(emptyPtzForm(), null)).toEqual({ kind: 'KEEP' });
  });

  it('menghapus PTZ hanya bila konfigurasi termuat dan pengguna memilih tanpa PTZ', () => {
    expect(ptzSaveAction(emptyPtzForm(), 'ONVIF')).toEqual({ kind: 'DELETE' });
    expect(ptzSaveAction(emptyPtzForm(), 'NONE')).toEqual({ kind: 'KEEP' });
  });

  it('menyimpan konfigurasi PTZ yang diisi', () => {
    const form = emptyPtzForm();
    form.provider = 'MQTT';
    form.mqtt = { brokerId: 'broker-1', cameraId: ' cam-1 ' };
    expect(ptzSaveAction(form, null)).toEqual({
      kind: 'PUT',
      body: { provider: 'MQTT', enabled: true, zoomEnabled: false, brokerId: 'broker-1', cameraId: 'cam-1' }
    });
  });
});

describe('MQTT bridge request body', () => {
  const subscriptions = [
    { brokerId: 'online', cameraId: '', commandTopic: '' },
    { brokerId: 'lokal', cameraId: ' cam-1 ', commandTopic: '' }
  ];

  it('tidak mengirim assignment broker dengan ID camera kosong yang tersembunyi', () => {
    expect(mqttBridgeRequestBody('ONVIF', false, subscriptions)).toEqual({
      enabled: false,
      subscriptions: [{ brokerId: 'lokal', cameraId: 'cam-1' }]
    });
  });

  it('mengosongkan bridge bila provider PTZ bukan ONVIF', () => {
    expect(mqttBridgeRequestBody('MQTT', true, subscriptions)).toEqual({ enabled: false, subscriptions: [] });
  });

  it('tetap mengirim broker ber-ID kosong saat bridge aktif agar subscription tidak terhapus diam-diam', () => {
    expect(mqttBridgeRequestBody('ONVIF', true, subscriptions)).toEqual({
      enabled: true,
      subscriptions: [{ brokerId: 'online', cameraId: '' }, { brokerId: 'lokal', cameraId: 'cam-1' }]
    });
    expect(blankBridgeAssignments('ONVIF', true, subscriptions)).toEqual(['online']);
    expect(blankBridgeAssignments('ONVIF', false, subscriptions)).toEqual([]);
    expect(blankBridgeAssignments('MQTT', true, subscriptions)).toEqual([]);
  });
});

describe('Status MQTT bridge di editor route', () => {
  it('membedakan bridge aktif, menunggu ONVIF, dan tidak aktif', () => {
    expect(mqttBridgeStatus({ active: true, onvifConnected: true, lastPresenceAt: null }))
      .toEqual({ state: 'connected', label: 'Bridge aktif' });
    expect(mqttBridgeStatus({ active: true, onvifConnected: false, lastPresenceAt: null }))
      .toEqual({ state: 'connecting', label: 'Menunggu ONVIF (dicoba ulang otomatis)' });
    expect(mqttBridgeStatus({ active: false, onvifConnected: false, lastPresenceAt: null }).label).toBe('Bridge tidak aktif');
  });
});
