import type { MqttBrokerProfile, PtzConnectionStatus } from '../types';
import type { PtzFormState } from './ptz-form';

function cleanTopic(value: string): string {
  return value.split('/').map((part) => part.trim()).filter(Boolean).join('/');
}

export function PtzConfigFields({ value, onChange, brokers = [], onTest, testing = false, canTest = false }: {
  value: PtzFormState;
  onChange: (value: PtzFormState) => void;
  brokers?: MqttBrokerProfile[];
  onTest?: () => void;
  testing?: boolean;
  canTest?: boolean;
}) {
  const set = (next: Partial<PtzFormState>) => onChange({ ...value, ...next });
  const setOnvif = (next: Partial<PtzFormState['onvif']>) => set({ onvif: { ...value.onvif, ...next } });
  const setMqtt = (next: Partial<PtzFormState['mqtt']>) => set({ mqtt: { ...value.mqtt, ...next } });
  const selectedBroker = brokers.find((broker) => broker.id === value.mqtt.brokerId);
  const fullTopic = [cleanTopic(selectedBroker?.rootTopic ?? ''), value.mqtt.cameraId.trim()].filter(Boolean).join('/');

  return <section className="ptz-config full">
    <div className="ptz-config-heading">
      <div><h3>Kontrol PTZ</h3><p>Opsional. Hubungkan kamera melalui ONVIF atau kirim payload kontrol ke broker MQTT.</p></div>
      {value.provider !== 'NONE' && <PtzConnectionIndicator connection={value.connection} provider={value.provider} />}
    </div>
    <div className="form-grid">
      <label>Metode PTZ<select value={value.provider} onChange={(event) => {
        const provider = event.target.value as PtzFormState['provider'];
        set({
          provider,
          connection: provider === 'NONE'
            ? { state: 'DISABLED', checkedAt: null, message: 'PTZ dinonaktifkan' }
            : { state: 'UNTESTED', checkedAt: null, message: 'Simpan lalu uji koneksi PTZ' }
        });
      }}>
        <option value="NONE">Tidak menggunakan PTZ</option>
        <option value="ONVIF">ONVIF langsung ke CCTV</option>
        <option value="MQTT">MQTT payload</option>
      </select></label>
      {value.provider !== 'NONE' && <>
        <label className="check"><input type="checkbox" checked={value.enabled} onChange={(event) => set({ enabled: event.target.checked })} /> Aktifkan kontrol PTZ di Viewer</label>
        <label className="check full"><input type="checkbox" checked={value.zoomEnabled} onChange={(event) => set({ zoomEnabled: event.target.checked })} /> Kamera mendukung kontrol zoom</label>
      </>}
      {value.provider === 'ONVIF' && <>
        <label>Host / IP CCTV<input value={value.onvif.host} onChange={(event) => setOnvif({ host: event.target.value })} required placeholder="192.168.1.13" /></label>
        <label>Port ONVIF<input type="number" min="1" max="65535" value={value.onvif.port} onChange={(event) => setOnvif({ port: Number(event.target.value) })} required /></label>
        <label>Username<input autoComplete="off" value={value.onvif.username} onChange={(event) => setOnvif({ username: event.target.value })} placeholder="admin" /></label>
        <label>Password<input type="password" autoComplete="new-password" value={value.onvif.password} onChange={(event) => setOnvif({ password: event.target.value })} placeholder={value.passwordConfigured ? 'Tersimpan — kosongkan untuk mempertahankan' : 'Password CCTV'} /></label>
        <label className="full">Path service<input value={value.onvif.path} onChange={(event) => setOnvif({ path: event.target.value })} required placeholder="/onvif/device_service" /></label>
        <label className="full">Media Profile Token (opsional)<input value={value.onvif.profileToken} onChange={(event) => setOnvif({ profileToken: event.target.value })} maxLength={255} placeholder="Kosong = otomatis, contoh: 000 atau 100" /><small>Gunakan token profile channel yang mengendalikan PTZ/zoom. Jika kosong, kamera memakai profile default pertama.</small></label>
        <label className="check full"><input type="checkbox" checked={value.onvif.useTls} onChange={(event) => setOnvif({ useTls: event.target.checked })} /> Gunakan koneksi HTTPS/TLS ke ONVIF</label>
      </>}
      {value.provider === 'MQTT' && <>
        <label>Profil broker<select value={value.mqtt.brokerId} onChange={(event) => setMqtt({ brokerId: event.target.value })} required>
          <option value="">Pilih broker MQTT</option>
          {brokers.map((broker) => <option key={broker.id} value={broker.id}>{broker.name} · {broker.rootTopic}</option>)}
        </select></label>
        <label>ID camera<input value={value.mqtt.cameraId} onChange={(event) => setMqtt({ cameraId: event.target.value })} required pattern="[a-zA-Z0-9._-]+" placeholder="cctv-tes-1" /></label>
        <div className="masked-info full">Root topic: <code>{selectedBroker?.rootTopic ?? 'pilih-broker'}</code><br />Topic PTZ: <code>{fullTopic || 'root-topic/id-camera'}</code><br />Status: <code>{fullTopic ? `${fullTopic}/status` : 'root-topic/id-camera/status'}</code></div>
      </>}
      {value.provider !== 'NONE' && <div className="ptz-test-row full">
        <div>
          <PtzConnectionIndicator connection={value.connection} provider={value.provider} detailed />
          {!canTest && <small>Simpan data stream terlebih dahulu sebelum menguji koneksi.</small>}
        </div>
        {onTest && <button type="button" onClick={onTest} disabled={!canTest || testing || !value.enabled}>
          {testing ? 'Menguji koneksi…' : 'Simpan & Tes Koneksi'}
        </button>}
      </div>}
    </div>
  </section>;
}

export function PtzConnectionIndicator({ connection, provider, detailed = false }: {
  connection: PtzConnectionStatus;
  provider?: 'NONE' | 'ONVIF' | 'MQTT';
  detailed?: boolean;
}) {
  const labels: Record<PtzConnectionStatus['state'], string> = {
    DISABLED: 'Tidak aktif',
    UNTESTED: 'Belum diuji',
    CONNECTING: 'Menghubungkan',
    CONNECTED: 'Terkoneksi',
    DISCONNECTED: 'Terputus',
    ERROR: 'Koneksi gagal'
  };
  return <span className={`ptz-connection ptz-connection-${connection.state.toLowerCase()} ${detailed ? 'ptz-connection-detailed' : ''}`}>
    <span className="ptz-connection-light" aria-hidden="true" />
    <span><b>{provider && provider !== 'NONE' ? `${provider} · ` : ''}{labels[connection.state]}</b>
      {detailed && <small>{connection.message}{connection.checkedAt ? ` · ${new Date(connection.checkedAt).toLocaleString('id-ID')}` : ''}</small>}
    </span>
  </span>;
}
