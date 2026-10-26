import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { AppError } from '../../shared/errors.js';

export const userRoleValues = ['admin', 'operator', 'viewer'] as const;
export type UserRole = (typeof userRoleValues)[number];
const credentialRoles = ['admin', 'operator'] as const;
export type CredentialRole = (typeof credentialRoles)[number];

function passwordHashKey(role: UserRole): string {
  return `auth.${role}.passwordHash`;
}

function usernameKey(role: UserRole): string {
  return `auth.${role}.username`;
}

function credentialVersionKey(role: CredentialRole): string {
  return `auth.${role}.credentialVersion`;
}

function rolePassword(role: CredentialRole): string {
  const env = getEnv();
  if (role === 'admin') return env.ADMIN_PASSWORD;
  return env.OPERATOR_PASSWORD;
}

export async function ensureRoleCredentials(): Promise<void> {
  const env = getEnv();
  for (const role of credentialRoles) {
    await ensureCredentialVersion(role);
    const hashKey = passwordHashKey(role);
    const existing = await prisma.appSetting.findUnique({ where: { key: hashKey } });
    if (existing) continue;
    const username = role === 'admin' ? env.ADMIN_USERNAME : role;
    const passwordHash = await bcrypt.hash(rolePassword(role), 12);
    await prisma.$transaction([
      prisma.appSetting.upsert({
        where: { key: usernameKey(role) },
        update: { value: username },
        create: { key: usernameKey(role), value: username, isSecret: false }
      }),
      prisma.appSetting.upsert({
        where: { key: hashKey },
        update: { value: passwordHash },
        create: { key: hashKey, value: passwordHash, isSecret: true }
      })
    ]);
  }
}

// bcryptjs berjalan di thread utama dan memproses round dalam potongan ±100 ms. Verifikasi
// paralel menumpuk potongan itu dalam satu putaran event loop (10 login serentak menahan SSE,
// PTZ dead-man stop, dan hook recording ±1 detik), jadi verifikasi dijalankan satu per satu
// dengan antrean terbatas. Viewer tidak memakai password sehingga tidak ikut antre.
//
// Antrean dibagi dua jalur agar banjir percobaan dari perangkat tak dikenal tidak membuat seluruh
// login Administrator/Operator ditolak LOGIN_BUSY: browser yang membawa cookie perangkat login
// bertanda tangan (login-device.ts, didapat dari login Administrator/Operator yang berhasil) dan
// verifikasi dari sesi Administrator memakai jalur `trusted` dengan kapasitas sendiri dan selalu
// dilayani lebih dulu. Kepercayaan sengaja tidak berbasis IP: di Docker Desktop semua klien LAN
// terlihat dari satu IP gateway, sehingga satu login sukses akan membuat semua klien dipercaya.
export type PasswordCheckLane = 'trusted' | 'general';
const PASSWORD_CHECK_CAPACITY: Readonly<Record<PasswordCheckLane, number>> = { trusted: 4, general: 8 };
const pendingPasswordChecks: Record<PasswordCheckLane, number> = { trusted: 0, general: 0 };
const waitingPasswordChecks: Record<PasswordCheckLane, Array<() => void>> = { trusted: [], general: [] };
let passwordCheckRunning = false;

/** Slot antrean verifikasi password yang dipesan sebelum request dihitung rate limit login. */
export class PasswordCheckSlot {
  private state: 'reserved' | 'claimed' | 'done' = 'reserved';

  constructor(readonly lane: PasswordCheckLane) {}

  /** Melepas slot yang belum dipakai verifikasi (request gagal lebih awal atau client menutup koneksi). */
  cancel(): void {
    if (this.state === 'reserved') this.complete();
  }

  /** @internal Dipanggil verifikasi password; slot yang sudah dibatalkan tidak dapat dipakai. */
  claim(): boolean {
    if (this.state !== 'reserved') return false;
    this.state = 'claimed';
    return true;
  }

  /** @internal */
  complete(): void {
    if (this.state === 'done') return;
    this.state = 'done';
    pendingPasswordChecks[this.lane] -= 1;
  }
}

function loginBusyError(): AppError {
  return new AppError('LOGIN_BUSY', 'Server sedang memproses banyak percobaan login. Coba lagi beberapa detik lagi.', 429);
}

export function reservePasswordCheck(lane: PasswordCheckLane): PasswordCheckSlot {
  if (pendingPasswordChecks[lane] >= PASSWORD_CHECK_CAPACITY[lane]) throw loginBusyError();
  pendingPasswordChecks[lane] += 1;
  return new PasswordCheckSlot(lane);
}

function runNextPasswordCheck(): void {
  if (passwordCheckRunning) return;
  const next = waitingPasswordChecks.trusted.shift() ?? waitingPasswordChecks.general.shift();
  if (!next) return;
  passwordCheckRunning = true;
  next();
}

async function comparePassword(password: string, hash: string, access: PasswordCheckLane | PasswordCheckSlot): Promise<boolean> {
  const slot = typeof access === 'string' ? reservePasswordCheck(access) : access;
  if (!slot.claim()) throw loginBusyError();
  try {
    await new Promise<void>((resolve) => {
      waitingPasswordChecks[slot.lane].push(resolve);
      runNextPasswordCheck();
    });
    try {
      return await bcrypt.compare(password, hash);
    } finally {
      passwordCheckRunning = false;
      runNextPasswordCheck();
    }
  } finally {
    slot.complete();
  }
}

export async function verifyRole(
  role: UserRole,
  password: string,
  access: PasswordCheckLane | PasswordCheckSlot = 'general'
): Promise<boolean> {
  if (role === 'viewer') {
    if (typeof access !== 'string') access.cancel();
    return true;
  }
  const storedHash = await prisma.appSetting.findUnique({ where: { key: passwordHashKey(role) } });
  if (!storedHash) {
    await comparePassword(password, '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW', access);
    return false;
  }
  return comparePassword(password, storedHash.value, access);
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (userRoleValues as readonly string[]).includes(value);
}

// Viewer tidak memakai password, jadi versinya tetap '0': cookie Viewer palsu tidak memberi akses
// melebihi login Viewer biasa. Administrator/Operator tanpa versi tersimpan bernilai null dan sesinya
// selalu ditolak (fail closed).
export async function getCredentialVersion(role: UserRole): Promise<string | null> {
  if (role === 'viewer') return '0';
  const stored = await prisma.appSetting.findUnique({ where: { key: credentialVersionKey(role) } });
  return stored?.value ?? null;
}

// Dipanggil saat startup dan login agar database baru maupun backup lama selalu memiliki versi acak.
export async function ensureCredentialVersion(role: UserRole): Promise<string> {
  if (role === 'viewer') return '0';
  const key = credentialVersionKey(role);
  const stored = await prisma.appSetting.upsert({
    where: { key },
    update: {},
    create: { key, value: randomUUID(), isSecret: true }
  });
  return stored.value;
}

export async function updateRolePassword(role: CredentialRole, password: string): Promise<void> {
  const passwordHash = await bcrypt.hash(password, 12);
  const credentialVersion = randomUUID();
  await prisma.$transaction([
    prisma.appSetting.upsert({
      where: { key: passwordHashKey(role) },
      update: { value: passwordHash, isSecret: true },
      create: { key: passwordHashKey(role), value: passwordHash, isSecret: true }
    }),
    prisma.appSetting.upsert({
      where: { key: credentialVersionKey(role) },
      update: { value: credentialVersion, isSecret: true },
      create: { key: credentialVersionKey(role), value: credentialVersion, isSecret: true }
    })
  ]);
}
