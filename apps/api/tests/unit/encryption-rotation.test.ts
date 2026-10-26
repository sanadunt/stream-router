import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from '../../src/shared/crypto.js';
import {
  assertUsableKeys,
  collectCells,
  decryptValue,
  ENCRYPTED_COLUMNS,
  encryptValue,
  findShadowedEnv,
  planReencryption,
  selectEncryptedSql,
  summarizePlan,
  updateEncryptedSql
} from '../../../../scripts/lib/encryption-rotation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const oldKey = 'old-test-key-0123456789abcdefghijklmnop';
const newKey = 'new-test-key-0123456789abcdefghijklmnop';
const thirdKey = 'third-test-key-0123456789abcdefghijklmn';

describe('rotasi APP_ENCRYPTION_KEY', () => {
  it('memakai format yang identik dengan shared/crypto.ts', () => {
    const plaintext = 'rtsp://user:secret@192.168.1.10:554/stream';
    expect(decryptString(encryptValue(plaintext, oldKey), oldKey)).toBe(plaintext);
    expect(decryptValue(encryptString(plaintext, oldKey), oldKey)).toBe(plaintext);
    expect(() => decryptValue(encryptString(plaintext, oldKey), newKey)).toThrow();
  });

  it('mencakup seluruh kolom *Encrypted pada schema Prisma', async () => {
    const schema = await readFile(path.resolve(here, '../../../../prisma/schema.prisma'), 'utf8');
    const fromSchema: Record<string, string[]> = {};
    // Blok model ditutup oleh "}" di awal baris; nilai seperti @default("{}") tidak boleh memotongnya.
    for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const columns = [...match[2]!.matchAll(/^\s*(\w+Encrypted)\s/gm)].map((field) => field[1]!);
      if (columns.length) fromSchema[match[1]!] = columns.sort();
    }
    const fromScript = Object.fromEntries(Object.entries(ENCRYPTED_COLUMNS).map(([table, columns]) => [table, [...columns].sort()]));
    expect(fromScript).toEqual(fromSchema);
  });

  it('menolak key baru yang kosong, placeholder, terlalu pendek, atau sama dengan key lama', () => {
    expect(() => assertUsableKeys('', newKey)).toThrow();
    expect(() => assertUsableKeys(oldKey, 'short')).toThrow();
    expect(() => assertUsableKeys(oldKey, 'GANTI_DENGAN_KEY_ACAK_MINIMAL_32_KARAKTER')).toThrow();
    expect(() => assertUsableKeys(oldKey, oldKey)).toThrow();
    expect(() => assertUsableKeys(oldKey, newKey)).not.toThrow();
  });

  it('mengumpulkan hanya sel terenkripsi yang tidak kosong', () => {
    const cells = collectCells({
      StreamRoute: [{ id: 'r1', inputUrlEncrypted: 'a', outputsEncrypted: 'b', webrtcUrlEncrypted: null, ptzConfigEncrypted: '' }],
      MqttBroker: [{ id: 'm1', passwordEncrypted: null }]
    });
    expect(cells.map((cell) => `${cell.table}.${cell.column}.${cell.id}`)).toEqual([
      'StreamRoute.inputUrlEncrypted.r1',
      'StreamRoute.outputsEncrypted.r1'
    ]);
  });

  it('mengenkripsi ulang ke key baru dan melewati nilai yang sudah memakai key baru', () => {
    const plaintexts = ['rtsp://cam/one', JSON.stringify(['rtmp://vps/live/cam-1'])];
    const cells = [
      { table: 'StreamRoute', id: 'r1', column: 'inputUrlEncrypted', value: encryptString(plaintexts[0]!, oldKey) },
      { table: 'StreamRoute', id: 'r1', column: 'outputsEncrypted', value: encryptString(plaintexts[1]!, oldKey) },
      { table: 'MqttBroker', id: 'm1', column: 'passwordEncrypted', value: encryptString('broker-pass', newKey) }
    ];
    const plan = planReencryption(cells, oldKey, newKey);
    expect(plan.failures).toEqual([]);
    expect(plan.alreadyRotated).toEqual([{ table: 'MqttBroker', id: 'm1', column: 'passwordEncrypted' }]);
    expect(plan.updates.map((update) => decryptString(update.next, newKey))).toEqual(plaintexts);
    expect(plan.updates.map((update) => update.previous)).toEqual([cells[0]!.value, cells[1]!.value]);
    expect(JSON.stringify(plan)).not.toContain('rtsp://cam/one');
    expect(summarizePlan(plan).find((row) => row.table === 'MqttBroker')).toMatchObject({ rotated: 0, alreadyRotated: 1, failed: 0 });
  });

  it('membentuk SQL hanya dari tabel dan kolom terenkripsi yang terdaftar', () => {
    expect(selectEncryptedSql('MqttBroker')).toBe('SELECT "id", "passwordEncrypted" FROM "MqttBroker"');
    expect(updateEncryptedSql('StreamRoute', 'outputsEncrypted'))
      .toBe('UPDATE "StreamRoute" SET "outputsEncrypted" = ? WHERE "id" = ? AND "outputsEncrypted" = ?');
    expect(() => selectEncryptedSql('AppSetting')).toThrow();
    expect(() => selectEncryptedSql('__proto__')).toThrow();
    expect(() => updateEncryptedSql('StreamRoute', 'name')).toThrow();
    expect(() => updateEncryptedSql('StreamRoute', 'inputUrlEncrypted" = 1; --')).toThrow();
  });

  it('mendeteksi variabel shell yang menimpa nilai .env', () => {
    const names = ['APP_ENCRYPTION_KEY', 'DATABASE_URL', 'PORT'];
    expect(findShadowedEnv({ APP_ENCRYPTION_KEY: 'a', DATABASE_URL: 'file:x', PORT: '3000' }, { APP_ENCRYPTION_KEY: 'b', PORT: '3000' }, names))
      .toEqual(['APP_ENCRYPTION_KEY']);
    expect(findShadowedEnv({ PORT: '3000' }, { APP_ENCRYPTION_KEY: 'b', DATABASE_URL: 'file:y' }, names)).toEqual([]);
  });

  it('melaporkan nilai yang tidak dapat didekripsi dengan kedua key', () => {
    const plan = planReencryption([
      { table: 'WebrtcStream', id: 'w1', column: 'urlEncrypted', value: encryptString('https://stream', thirdKey) },
      { table: 'WebrtcStream', id: 'w2', column: 'urlEncrypted', value: 'bukan-ciphertext' }
    ], oldKey, newKey);
    expect(plan.updates).toEqual([]);
    expect(plan.failures.map((failure) => failure.id)).toEqual(['w1', 'w2']);
  });
});
