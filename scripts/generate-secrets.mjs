#!/usr/bin/env node
import { randomBytes } from 'node:crypto';

const secret = () => randomBytes(32).toString('base64url');

console.log('# Salin dua baris berikut ke .env. Setiap eksekusi menghasilkan key baru.');
console.log(`AUTH_SECRET=${secret()}`);
console.log(`APP_ENCRYPTION_KEY=${secret()}`);
console.log('# Jangan commit .env dan jangan mengganti APP_ENCRYPTION_KEY pada instalasi yang sudah berisi credential terenkripsi tanpa npm run secrets:reencrypt.');
