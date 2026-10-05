'use strict';

/**
 * NEXUS — планировщик задач команды.
 *
 * Владелец пишет в чат «каждый час проверь почту» или «в 09:00 своди отчёт» —
 * сервер сам запускает агентов по времени. Результаты падают в журнал прогонов
 * и ленту событий, как обычные запуски.
 *
 * Форматы:
 *   { kind: 'every', everyMin } — каждые N минут (минимум 5);
 *   { kind: 'daily', at: 'HH:MM' } — раз в день в это время (локальное время сервера).
 * Исполнитель: конкретный агент (targetAgentId) или вся команда (все онлайн).
 */

const store = require('./store');
const tgbridge = require('./tgbridge');

const MIN_EVERY = 5;

function defaults() {
  return [];
}

function list() {
  const cfg = store.read('config.json', {});
  const arr = Array.isArray(cfg.schedules) ? cfg.schedules : [];
  return arr.filter((s) => s && typeof s.id === 'string');
}

function writeAll(arr) {
  const cfg = store.read('config.json', {});
  cfg.schedules = arr;
  store.write('config.json', cfg);
  return arr;
}

function parseEvery(text) {
  /* \b после кириллицы не срабатывает — граница задана явно */
  const m = /(\d+)\s*(м|мин|минут|ч|час|h|m)(?![a-zа-яё0-9])/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const min = /^(ч|час|h)$/.test(unit) ? n * 60 : n;
  if (!Number.isFinite(min) || min < MIN_EVERY || min > 60 * 24 * 7) return null;
  return min;
}

function parseDaily(text) {
  const m = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/.exec(String(text || ''));
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function nextRun(s, now) {
  if (!s.enabled) return null;
  if (s.kind === 'every') {
    const base = Number(s.lastRun) || 0;
    return base + Number(s.everyMin) * 60000;
  }
  if (s.kind === 'daily' && s.at) {
    const parts = String(s.at).split(':').map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
    const t = dayTime(now, parts[0], parts[1]);
    if (now < t) return t; /* сегодняшнее время ещё впереди */
    /* Время сегодня уже прошло: если отработали — завтра, если пропустили — сейчас */
    return Number(s.lastRun) >= t ? t + 24 * 3600 * 1000 : now;
  }
  return null;
}

function dayTime(now, hh, mm) {
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function add({ kind, everyMin, at, task, targetAgentId }) {
  const clean = String(task || '').trim().slice(0, 500);
  if (!clean) throw new Error('Пустая задача');
  const item = {
    id: 'sch_' + require('crypto').randomBytes(4).toString('hex'),
    kind,
    everyMin: kind === 'every' ? everyMin : undefined,
    at: kind === 'daily' ? at : undefined,
    task: clean,
    targetAgentId: targetAgentId || null,
    enabled: true,
    /* Первый запуск — через полный интервал от создания, а не сразу */
    lastRun: Date.now(),
    createdAt: Date.now(),
  };
  const arr = list();
  arr.push(item);
  writeAll(arr);
  return item;
}

function remove(id) {
  const arr = list().filter((s) => s.id !== id);
  writeAll(arr);
  return arr;
}

function toggle(id, enabled) {
  const arr = list();
  const s = arr.find((x) => x.id === id);
  if (!s) throw new Error('Расписание не найдено');
  s.enabled = enabled !== false;
  writeAll(arr);
  return s;
}

function describe(s, now) {
  const who = s.targetAgentId ? `агент ${s.targetAgentId}` : 'вся команда';
  const when = s.kind === 'every' ? `каждые ${s.everyMin} мин` : `ежедневно в ${s.at}`;
  const nx = nextRun(s, now || Date.now());
  const next = nx ? `, следующий: ${new Date(nx).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
  return `${s.enabled ? '🟢' : '⚫'} ${s.id.slice(-4)} · ${when} · ${who} · «${s.task.slice(0, 60)}»${next}`;
}

/** Один тик планировщика (сервер дёргает раз в 30 с). */
async function tick() {
  const now = Date.now();
  for (const s of list()) {
    if (!s.enabled) continue;
    const nx = nextRun(s, now);
    if (nx === null || nx > now) continue;
    /* Фиксируем запуск ДО работы — чтобы повторный тик не задвоил */
    const arr = list();
    const cur = arr.find((x) => x.id === s.id);
    if (!cur || !cur.enabled) continue;
    cur.lastRun = now;
    writeAll(arr);
    console.log(`[schedule] запуск «${s.task.slice(0, 80)}» (${s.kind})`);
    runSchedule(cur).catch((e) => console.error('[schedule] сбой:', e.message));
  }
}

async function runSchedule(s) {
  const data = store.read('team.json', { agents: [] });
  const agents = data.agents || [];
  let targets = agents.filter((a) => a.status !== 'offline');
  if (s.targetAgentId) {
    const one = agents.find((a) => a.id === s.targetAgentId);
    targets = one && one.status !== 'offline' ? [one] : [];
  }
  if (!targets.length) {
    console.log('[schedule] некому выполнять — все офлайн');
    return;
  }
  for (const a of targets) {
    const fresh = (store.read('team.json', { agents: [] }).agents || []).find((x) => x.id === a.id);
    if (!fresh || fresh.status === 'busy') continue;
    /* Тот же учёт, что у ручных запусков: журнал, события, счётчики */
    await tgbridge.runOne(a.id, `[по расписанию] ${s.task}`);
  }
}

module.exports = { list, add, remove, toggle, describe, tick, parseEvery, parseDaily, nextRun };
