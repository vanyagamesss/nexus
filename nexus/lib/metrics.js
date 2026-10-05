'use strict';

/**
 * Реальные показатели: состояние узла (CPU/память/диск/аптайм) + журнал прогонов.
 *
 * CPU считается по дельте счётчиков os.cpus() между двумя замерами (реальная
 * загрузка, а не os.loadavg — тот на Windows всегда 0).
 * Журнал прогонов пишется в data/runs.json и является источником правды для
 * статистики на главной: токены, стоимость, длительность, успех/ошибка.
 */

const os = require('os');
const fs = require('fs');
const store = require('./store');

const RUNS_FILE = 'runs.json';
const HISTORY = 400;

/* ------------------------------------------------------------- загрузка CPU */

let prevCpu = null;
let lastCpu = 0;

function cpuSnapshot() {
  const cpus = os.cpus();
  const now = cpus.reduce(
    (acc, c) => {
      for (const k of Object.keys(c.times)) acc[k] = acc[k] || 0, (acc[k] += c.times[k]);
      return acc;
    },
    {},
  );
  if (prevCpu) {
    const totalDelta = now.user + now.nice + now.sys + now.irq + now.idle - (prevCpu.total || 0);
    if (totalDelta > 0) {
      const idleDelta = now.idle - prevCpu.idle;
      lastCpu = clampPct((1 - idleDelta / totalDelta) * 100);
    }
  }
  prevCpu = { idle: now.idle, total: now.user + now.nice + now.sys + now.irq + now.idle };
  return lastCpu;
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/* ------------------------------------------------------------------ диск */

function diskOf(dir) {
  try {
    // Синхронный расчёт через fs.statfs (Node 18.15+). Если недоступен — null.
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    return {
      total,
      used,
      free,
      usedPct: total ? clampPct((used / total) * 100) : 0,
      fs: `${total > 1024 ** 3 ? (total / 1024 ** 3).toFixed(1) + ' ГБ' : (total / 1024 ** 2).toFixed(0) + ' МБ'}`,
    };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- снимок узла */

function snapshot() {
  const cpu = cpuSnapshot();
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const cpus = os.cpus();
  return {
    ts: Date.now(),
    cpu: { pct: cpu, cores: cpus.length, model: (cpus[0] || {}).model || '—', speedMhz: (cpus[0] || {}).speed || 0 },
    memory: { total, used, free, usedPct: clampPct((used / total) * 100) },
    disk: diskOf(store.DATA_DIR),
    process: {
      pid: process.pid,
      node: process.version,
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
      uptimeSec: Math.round(process.uptime()),
    },
    host: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
      cores: cpus.length,
      loadAvg: os.loadavg(),
      networkInterfaces: countInterfaces(),
      ip: primaryIPv4(),
    },
  };
}

function countInterfaces() {
  let n = 0;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i && !i.internal) n++;
  }
  return n;
}

function primaryIPv4() {
  const nets = os.networkInterfaces();
  const external = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const i of list || []) {
      if (i && i.family === 'IPv4' && !i.internal) external.push({ iface: name, address: i.address, mac: i.mac });
    }
  }
  external.sort((a, b) => (b.iface === 'Wi-Fi' || b.iface === 'WLAN' ? 1 : 0) - (a.iface === 'Wi-Fi' || a.iface === 'WLAN' ? 1 : 0));
  return external[0] || null;
}

/** Все непубличные IPv4 — для QR-кодов на телефоне. */
function lanAddresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (!i || i.internal || i.family !== 'IPv4') continue;
      out.push({ iface, address: i.address, netmask: i.netmask });
    }
  }
  return out;
}

/* ------------------------------------------------------------ журнал прогонов */

function emptyRuns() {
  return { runs: [], totals: { runs: 0, ok: 0, failed: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, msTotal: 0 }, byDay: {} };
}

function runs() {
  return store.read(RUNS_FILE, emptyRuns());
}

/**
 * Записать прогон. Все поля — реальные значения, полученные от провайдера/системы.
 */
function recordRun(entry) {
  return store.update(RUNS_FILE, emptyRuns(), (data) => {
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const run = {
      id: 'run_' + require('crypto').randomBytes(5).toString('hex'),
      ts: entry.ts || Date.now(),
      agentId: entry.agentId,
      agentName: entry.agentName,
      task: String(entry.task || '').slice(0, 300),
      status: entry.status === 'ok' ? 'ok' : 'failed',
      provider: entry.provider || '',
      model: entry.model || '',
      usage: {
        promptTokens: num(entry.usage && entry.usage.promptTokens),
        completionTokens: num(entry.usage && entry.usage.completionTokens),
        totalTokens: num(entry.usage && entry.usage.totalTokens),
      },
      costUsd: num(entry.costUsd),
      durationMs: Math.max(0, num(entry.durationMs)),
      ttftMs: Math.max(0, num(entry.ttftMs)),
      steps: Math.max(0, Math.round(num(entry.steps))),
      toolCalls: Math.max(0, Math.round(num(entry.toolCalls))),
      error: entry.error ? String(entry.error).slice(0, 400) : null,
      toolLog: Array.isArray(entry.toolLog) ? entry.toolLog.slice(-40) : [],
    };
    data.runs.unshift(run);
    data.runs = data.runs.slice(0, HISTORY);

    const t = data.totals;
    t.runs++;
    if (run.status === 'ok') t.ok++;
    else t.failed++;
    t.promptTokens += run.usage.promptTokens;
    t.completionTokens += run.usage.completionTokens;
    t.totalTokens += run.usage.totalTokens;
    t.costUsd = Math.round((t.costUsd + run.costUsd) * 1e6) / 1e6;
    t.msTotal += run.durationMs;

    const day = new Date(run.ts).toISOString().slice(0, 10);
    const d = (data.byDay[day] = data.byDay[day] || { runs: 0, ok: 0, tokens: 0, costUsd: 0, ms: 0 });
    d.runs++;
    if (run.status === 'ok') d.ok++;
    d.tokens += run.usage.totalTokens;
    d.costUsd = Math.round((d.costUsd + run.costUsd) * 1e6) / 1e6;
    d.ms += run.durationMs;

    const days = Object.keys(data.byDay).sort();
    while (days.length > 30) delete data.byDay[days.shift()];
    return data;
  });
}

function clearRuns() {
  return store.write(RUNS_FILE, emptyRuns());
}

/** Агрегированная статистика по журналу (реальные цифры). */
function stats() {
  const data = runs();
  const t = data.totals;
  const byAgent = {};
  for (const r of data.runs) {
    const key = r.agentId || 'unknown';
    const a = (byAgent[key] = byAgent[key] || {
      agentId: key,
      agentName: r.agentName,
      runs: 0,
      ok: 0,
      failed: 0,
      tokens: 0,
      costUsd: 0,
      msTotal: 0,
      toolCalls: 0,
      lastTs: 0,
      lastStatus: null,
      lastError: null,
      providers: {},
    });
    a.runs++;
    if (r.status === 'ok') a.ok++;
    else a.failed++;
    a.tokens += r.usage.totalTokens;
    a.costUsd = Math.round((a.costUsd + r.costUsd) * 1e6) / 1e6;
    a.msTotal += r.durationMs;
    a.toolCalls += r.toolCalls || 0;
    if (r.provider) a.providers[r.provider] = (a.providers[r.provider] || 0) + 1;
    if (r.ts > a.lastTs) {
      a.lastTs = r.ts;
      a.lastStatus = r.status;
      a.lastError = r.error;
      a.lastModel = r.model;
    }
  }
  for (const a of Object.values(byAgent)) {
    a.avgMs = a.runs ? Math.round(a.msTotal / a.runs) : 0;
    a.successRate = a.runs ? Math.round((a.ok / a.runs) * 100) : 0;
    a.costUsd = Math.round(a.costUsd * 1e6) / 1e6;
  }
  return {
    totals: t,
    byAgent: Object.values(byAgent).sort((a, b) => b.runs - a.runs),
    byDay: Object.entries(data.byDay)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, ...v })),
    recent: data.runs.slice(0, 30),
  };
}

module.exports = { snapshot, lanAddresses, recordRun, stats, runs, clearRuns, cpuSnapshot, diskOf };