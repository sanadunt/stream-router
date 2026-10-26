import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: path.join(rootDir, '.env') });

function usage() {
  console.log('Penggunaan: npm run auth:reset -- --role <admin|operator|all>');
  console.log('Password dibaca dari ADMIN_PASSWORD / OPERATOR_PASSWORD di file .env.');
}

function selectedRoles(argv) {
  const roleIndex = argv.indexOf('--role');
  const role = roleIndex >= 0 ? argv[roleIndex + 1] : undefined;
  if (role === 'all') return ['admin', 'operator'];
  if (role === 'admin' || role === 'operator') return [role];
  return null;
}

function passwordFor(role) {
  const key = role === 'admin' ? 'ADMIN_PASSWORD' : 'OPERATOR_PASSWORD';
  const password = process.env[key] ?? '';
  if (password.length < 8) {
    throw new Error(`${key} wajib tersedia di .env dan minimal 8 karakter.`);
  }
  if (/^(?:GANTI_DENGAN_|change-me)/i.test(password)) {
    throw new Error(`${key} masih memakai nilai contoh.`);
  }
  return password;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

const roles = selectedRoles(process.argv.slice(2));
if (!roles) {
  usage();
  process.exitCode = 1;
} else {
  const passwords = new Map(roles.map((role) => [role, passwordFor(role)]));
  const prisma = new PrismaClient();
  try {
    for (const role of roles) {
      const passwordHash = await bcrypt.hash(passwords.get(role), 12);
      const credentialVersion = randomUUID();
      await prisma.$transaction([
        prisma.appSetting.upsert({
          where: { key: `auth.${role}.passwordHash` },
          update: { value: passwordHash, isSecret: true },
          create: { key: `auth.${role}.passwordHash`, value: passwordHash, isSecret: true }
        }),
        prisma.appSetting.upsert({
          where: { key: `auth.${role}.credentialVersion` },
          update: { value: credentialVersion, isSecret: true },
          create: {
            key: `auth.${role}.credentialVersion`,
            value: credentialVersion,
            isSecret: true
          }
        })
      ]);
      console.log(`Password ${role} diperbarui dari .env; seluruh sesi ${role} lama dicabut.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
