import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Format ini harus identik dengan apps/api/src/shared/crypto.ts. Script berjalan tanpa build API,
// sehingga logikanya diduplikasi di sini dan kompatibilitasnya dijaga oleh test unit.
export const ENCRYPTED_COLUMNS = Object.freeze({
  StreamRoute: Object.freeze(['inputUrlEncrypted', 'outputsEncrypted', 'webrtcUrlEncrypted', 'ptzConfigEncrypted']),
  WebrtcStream: Object.freeze(['urlEncrypted', 'ptzConfigEncrypted']),
  MqttBroker: Object.freeze(['passwordEncrypted'])
});

const placeholderPattern = /^(?:GANTI_DENGAN_|change-me)/i;
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]*$/;

function quoteIdentifier(name) {
  if (!identifierPattern.test(name)) throw new Error(`Identifier SQL tidak valid: ${name}`);
  return `"${name}"`;
}

function encryptedColumnsOf(table) {
  if (!Object.hasOwn(ENCRYPTED_COLUMNS, table)) throw new Error(`Tabel ${table} tidak terdaftar`);
  return ENCRYPTED_COLUMNS[table];
}

function assertEncryptedColumn(table, column) {
  if (!encryptedColumnsOf(table).includes(column)) throw new Error(`Kolom ${table}.${column} tidak terdaftar sebagai kolom terenkripsi`);
}

// SQL mentah dipakai agar @updatedAt Prisma tidak ikut berubah dan model baru cukup didaftarkan di ENCRYPTED_COLUMNS.
// Nama tabel/kolom hanya berasal dari allowlist di atas; nilai selalu dikirim sebagai parameter.
export function selectEncryptedSql(table) {
  return `SELECT "id", ${encryptedColumnsOf(table).map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`;
}

export function updateEncryptedSql(table, column) {
  assertEncryptedColumn(table, column);
  const quoted = quoteIdentifier(column);
  return `UPDATE ${quoteIdentifier(table)} SET ${quoted} = ? WHERE "id" = ? AND ${quoted} = ?`;
}

/** Nama variabel yang di-export shell dengan nilai berbeda dari file .env (dotenv tidak menimpanya). */
export function findShadowedEnv(fileValues, processEnv, names) {
  return names.filter((name) => (
    fileValues[name] !== undefined
    && processEnv[name] !== undefined
    && processEnv[name] !== fileValues[name]
  ));
}

function deriveKey(secret) {
  return createHash('sha256').update(secret).digest();
}

export function encryptValue(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptValue(payload, secret) {
  const [version, ivPart, tagPart, cipherPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !cipherPart) throw new Error('Encrypted payload tidak valid');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function tryDecrypt(payload, secret) {
  try {
    return { ok: true, plaintext: decryptValue(payload, secret) };
  } catch {
    return { ok: false };
  }
}

export function assertUsableKeys(oldKey, newKey) {
  if (!oldKey) throw new Error('Key lama belum diberikan.');
  if (!newKey || newKey.length < 32 || placeholderPattern.test(newKey)) {
    throw new Error('APP_ENCRYPTION_KEY baru di .env wajib minimal 32 karakter dan bukan nilai contoh.');
  }
  if (oldKey === newKey) {
    throw new Error('APP_ENCRYPTION_KEY di .env masih sama dengan key lama. Isi .env dengan key baru dari `npm run secrets:generate` terlebih dahulu.');
  }
}

/** Mengubah baris per tabel menjadi daftar sel terenkripsi yang tidak kosong. */
export function collectCells(rowsByTable) {
  const cells = [];
  for (const [table, columns] of Object.entries(ENCRYPTED_COLUMNS)) {
    for (const row of rowsByTable[table] ?? []) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === 'string' && value !== '') cells.push({ table, id: row.id, column, value });
      }
    }
  }
  return cells;
}

/**
 * Menyiapkan ciphertext baru tanpa menyentuh database. Plaintext tidak pernah keluar dari fungsi ini.
 * Sel yang sudah terenkripsi dengan key baru dilewati agar script aman dijalankan ulang.
 */
export function planReencryption(cells, oldKey, newKey) {
  assertUsableKeys(oldKey, newKey);
  const updates = [];
  const alreadyRotated = [];
  const failures = [];
  for (const cell of cells) {
    const location = { table: cell.table, id: cell.id, column: cell.column };
    const previous = tryDecrypt(cell.value, oldKey);
    if (previous.ok) {
      const next = encryptValue(previous.plaintext, newKey);
      const check = tryDecrypt(next, newKey);
      if (!check.ok || check.plaintext !== previous.plaintext) {
        throw new Error(`Verifikasi enkripsi ulang gagal pada ${cell.table}.${cell.column} id=${cell.id}`);
      }
      updates.push({ ...location, previous: cell.value, next });
    } else if (tryDecrypt(cell.value, newKey).ok) {
      alreadyRotated.push(location);
    } else {
      failures.push(location);
    }
  }
  return { updates, alreadyRotated, failures };
}

export function summarizePlan(plan) {
  const rows = [];
  for (const [table, columns] of Object.entries(ENCRYPTED_COLUMNS)) {
    for (const column of columns) {
      const match = (entry) => entry.table === table && entry.column === column;
      rows.push({
        table,
        column,
        rotated: plan.updates.filter(match).length,
        alreadyRotated: plan.alreadyRotated.filter(match).length,
        failed: plan.failures.filter(match).length
      });
    }
  }
  return rows;
}
