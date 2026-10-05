'use strict';

/**
 * Доступ с телефона: PIN-код + сессии в cookie.
 *
 * Логика:
 *   • доступ с localhost (127.0.0.1 / ::1) — без PIN;
 *   • доступ из локальной сети (телефон) — требует PIN, если он включён;
 *   • приглашения (invite-ссылки) действуют 30 минут и одноразово помечаются использованными;
 *   • PIN хранится как scrypt-хеш с солью, ограничение попыток — 5 за 15 минут с IP.
 */

const crypto = require('crypto');
const store = require('./store');

const CONFIG_FILE = 'config.json';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 дней
const INVITE_TTL = 1000 * 60 * 30; // 30 минут
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW = 1000 * 60 * 15;
const PBKDF_ROUNDS = 120000;

const attempts = new Map(); // ip -> { count, first }

function defaults() {
  return {
    access: {
      mode: 'readonly', // readonly | full
      workspace: '',
      requirePinForLan: true,
      allowRemoteRun: true,
    },
    pin: { enabled: false, salt: '', hash: '', length: 6 },
    invites: [],
    sessions: [],
  };
}

function config() {
  const data = store.read(CONFIG_FILE, defaults());
  // миграция: гарантируем наличие всех секций
  const d = defaults();
  data.access = Object.assign({}, d.access, data.access || {});
  data.pin = Object.assign({}, d.pin, data.pin || {});
  data.invites = Array.isArray(data.invites) ? data.invites : [];
  data.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  return data;
}

function save(mutator) {
  return store.update(CONFIG_FILE, defaults(), (data) => {
    const d = defaults();
    data.access = Object.assign({}, d.access, data.access || {});
    data.pin = Object.assign({}, d.pin, data.pin || {});
    data.invites = Array.isArray(data.invites) ? data.invites : [];
    data.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return mutator(data) || data;
  });
}

/* --------------------------------------------------------------------- PIN */

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin), salt, PBKDF_ROUNDS, 32, 'sha256').toString('hex');
}

function normalizePin(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function setPin(pin) {
  const clean = normalizePin(pin);
  if (![4, 6, 8].includes(clean.length)) {
    const err = new Error('PIN должен содержать 4, 6 или 8 цифр');
    err.status = 400;
    throw err;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await save((data) => {
    data.pin = { enabled: true, salt, hash: hashPin(clean, salt), length: clean.length, isDefault: false };
    data.sessions = []; // сброс старых сессий
  });
  return { ok: true, length: clean.length };
}

async function clearPin() {
  await save((data) => {
    data.pin = { enabled: false, salt: '', hash: '', length: 6, isDefault: false };
    data.sessions = [];
  });
  return { ok: true };
}

/**
 * PIN по умолчанию — 1111. Применяется только если владелец не задавал свой
 * код и явно его не убирал (флаг isDefault). Так свежие установки сразу
 * пускают с телефона, а свой PIN никто не теряет.
 */
const DEFAULT_PIN = '1111';

async function ensureDefaultPin() {
  const cfg = config();
  if (cfg.pin.enabled || cfg.pin.isDefault === false) return false;
  await setPin(DEFAULT_PIN);
  await save((data) => {
    data.pin.isDefault = true;
    return data;
  });
  return true;
}

function verifyPin(pin, cfg) {
  if (!cfg.pin.enabled || !cfg.pin.hash) return true;
  const clean = normalizePin(pin);
  const h = hashPin(clean, cfg.pin.salt);
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(cfg.pin.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- попытки входа */

function attemptState(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW) {
    attempts.set(ip, { count: 0, first: Date.now() });
    return attempts.get(ip);
  }
  return rec;
}

function registerFailure(ip) {
  const rec = attemptState(ip);
  rec.count++;
  attempts.set(ip, rec);
  return rec;
}

function attemptsLeft(ip) {
  const rec = attemptState(ip);
  return Math.max(0, MAX_ATTEMPTS - rec.count);
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

/* ------------------------------------------------------------------ сессии */

function createSession(label, isLocal) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  return save((data) => {
    data.sessions = data.sessions.filter((s) => s.expires > now);
    if (!isLocal) data.sessions = data.sessions.filter((s) => s.token !== token);
    data.sessions.push({
      token: crypto.createHash('sha256').update(token).digest('hex'),
      created: now,
      expires: now + SESSION_TTL,
      label: String(label || 'сессия').slice(0, 40),
      isLocal: !!isLocal,
    });
    if (data.sessions.length > 40) data.sessions = data.sessions.slice(-40);
    return data;
  }).then(() => token);
}

function sessionValid(token, cfg) {
  if (!token) return false;
  const h = crypto.createHash('sha256').update(token).digest('hex');
  return cfg.sessions.some((s) => s.token === h && s.expires > Date.now());
}

function dropSession(token) {
  if (!token) return Promise.resolve();
  const h = crypto.createHash('sha256').update(token).digest('hex');
  return save((data) => {
    data.sessions = data.sessions.filter((s) => s.token !== h);
    return data;
  });
}

/* ---------------------------------------------------------------- приглашения */

async function createInvite(ttlMin = 30) {
  const code = crypto.randomBytes(9).toString('base64url');
  const now = Date.now();
  await save((data) => {
    data.invites = data.invites.filter((i) => i.expires > now);
    data.invites.push({ code, created: now, expires: now + ttlMin * 60000, usedAt: null });
    if (data.invites.length > 20) data.invites = data.invites.slice(-20);
  });
  return { code, expires: now + ttlMin * 60000 };
}

async function consumeInvite(code) {
  const now = Date.now();
  const clean = String(code || '');
  let ok = false;
  await save((data) => {
    data.invites = data.invites.filter((i) => i.expires > now);
    const inv = data.invites.find((i) => i.code === clean && !i.usedAt && i.expires > now);
    if (inv) {
      inv.usedAt = now;
      ok = true;
    }
  });
  return ok;
}

function listInvites() {
  const now = Date.now();
  return config()
    .invites.filter((i) => i.expires > now)
    .map((i) => ({ code: i.code, expires: i.expires, used: !!i.usedAt }));
}

async function revokeInvites() {
  await save((data) => {
    data.invites = [];
  });
  return { ok: true };
}

/* --------------------------------------------------------------------- вход */

/* Доверять X-Forwarded-For нельзя: любой клиент из сети мог бы подделать
   127.0.0.1 и выдать себя за локальный, обойдя PIN. Поэтому по умолчанию
   заголовок игнорируется, а proxy включается только явной настройкой. */
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(String(process.env.NEXUS_TRUST_PROXY || ''));

function clientIp(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!TRUST_PROXY) return socketIp;
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return socketIp;
}

function isLocalRequest(req) {
  const addr = clientIp(req);
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
}

/**
 * Проверка авторизации. Возвращает { ok, reason }.
 * isLocal → всегда ok. Иначе требуется валидная сессия.
 */
function authorize(req, cfg, cookies) {
  if (isLocalRequest(req)) return { ok: true, local: true };
  if (cfg.access.requirePinForLan === false) return { ok: true, local: false };
  if (sessionValid(cookies.nexus_session, cfg)) return { ok: true, local: false };
  const inv = cookies.nexus_invite;
  return { ok: false, local: false, reason: inv ? 'invite' : 'pin', ip: clientIp(req) };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token, secure) {
  const bits = [
    `nexus_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookie() {
  return 'nexus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* --------------------------------------------------- чувствительные операции */

/**
 * Действия, доступные только с локальной машины или по приглашению:
 * смена режима доступа, PIN, ключей провайдеров, запуск агентов.
 */
function isPrivileged(cfg) {
  return !!(cfg.pin.enabled || cfg.access.requirePinForLan !== false);
}

module.exports = {
  config,
  save,
  setPin,
  clearPin,
  verifyPin,
  createSession,
  dropSession,
  sessionValid,
  createInvite,
  consumeInvite,
  listInvites,
  revokeInvites,
  authorize,
  parseCookies,
  sessionCookie,
  clearCookie,
  clientIp,
  isLocalRequest,
  attemptsLeft,
  registerFailure,
  clearAttempts,
  isPrivileged,
  ensureDefaultPin,
  DEFAULT_PIN,
};