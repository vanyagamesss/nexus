'use strict';

/**
 * Атомарное хранилище JSON + шифрование секретов.
 * Секреты (API-ключи, PIN) не хранятся в открытом виде: AES-256-GCM,
 * ключ шифрования выводится из машинного секрета (data/.secret).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.NEXUS_DATA
  ? path.resolve(process.env.NEXUS_DATA)
  : path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* ----------------------------------------------------------- машинный секрет */

function machineSecret() {
  ensureDir();
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

const SECRET = machineSecret();

function encrypt(plain) {
  if (typeof plain !== 'string' || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(SECRET).digest(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('v1:')) return '';
  try {
    const [, ivB, tagB, dataB] = value.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      crypto.createHash('sha256').update(SECRET).digest(),
      Buffer.from(ivB, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Короткое отпечатокное представление для UI: sk-ab…9f2c */
function fingerprint(secret) {
  if (!secret) return '';
  if (secret.length <= 10) return '•'.repeat(secret.length);
  return `${secret.slice(0, 5)}…${secret.slice(-3)}`;
}

/* ------------------------------------------------------------- JSON хранилище */

const cache = new Map();

function filePath(name) {
  return path.join(DATA_DIR, name.endsWith('.json') ? name : `${name}.json`);
}

function read(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  let value;
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8').replace(/^\uFEFF/, '');
    value = JSON.parse(raw);
  } catch {
    value = typeof fallback === 'function' ? fallback() : fallback;
  }
  cache.set(name, value);
  return value;
}

function write(name, value) {
  ensureDir();
  const target = filePath(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  cache.set(name, value);
  return value;
}

/** Обновление с блокировкой конкурентных записей (простая очередь на файл). */
const locks = new Map();

function update(name, fallback, mutator) {
  const prev = locks.get(name) || Promise.resolve();
  const next = prev.then(async () => {
    const current = read(name, fallback);
    const result = mutator(current);
    await write(name, result === undefined ? current : result);
    return result;
  });
  locks.set(
    name,
    next.catch(() => {}),
  );
  return next;
}

module.exports = { DATA_DIR, ensureDir, encrypt, decrypt, fingerprint, read, write, update, secretPath: SECRET_FILE };