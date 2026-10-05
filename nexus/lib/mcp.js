'use strict';

/**
 * Реальный клиент MCP (Model Context Protocol) — JSON-RPC 2.0.
 *
 * Транспорты:
 *   stdio — дочерний процесс, JSON-RPC поверх stdin/stdout (фреймы по \n)
 *   sse   — HTTP+SSE: GET на endpoint (поток событий), POST на /message для вызовов
 *   http  — Streamable HTTP: POST на endpoint, ответ JSON либо SSE
 *
 * Кэш соединений: один клиент на сервер, переиспользование между прогонами.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const crypto = require('crypto');

const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT = 30000;
const LIST_TIMEOUT = 12000;
const MAX_TEXT = 40000;

/* ------------------------------------------------------- stdio JSON-RPC процесс */

class StdioSession extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.log = [];
    this.child = spawn(cmdOf(cfg.target), shellArgs(cfg.target), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: os.homedir(),
      /* Многие MCP-серверы читают токены из переменных окружения
         (например GITHUB_PERSONAL_ACCESS_TOKEN), поэтому прокидываем их. */
      env: Object.assign({}, process.env, cfg.env && typeof cfg.env === 'object' ? cfg.env : null),
    });
    if (cfg.env && Object.keys(cfg.env).length) {
      this.push(`переменные окружения: ${Object.keys(cfg.env).join(', ')}`);
    }
    this.push(`запуск процесса: ${cfg.target}`);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      const line = String(d).trim().slice(0, 400);
      if (line) this.push(`stderr: ${line}`, 'warn');
    });
    this.child.on('error', (e) => {
      this.push(`ошибка процесса: ${e.message}`, 'err');
      this.close();
    });
    this.child.on('close', (code) => {
      this.push(`процесс завершён (код ${code})`, code === 0 ? 'ok' : 'warn');
      this.close();
    });
  }

  push(line, level = 'info') {
    this.log.push({ t: new Date().toISOString(), line, level });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
    this.emit('log', { line, level });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = '';
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.push(`не-JSON от сервера: ${line.slice(0, 200)}`, 'warn');
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') this.emit('toolsChanged');
  }

  send(method, params) {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new Error('MCP-процесс недоступен'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method}: таймаут ${CALL_TIMEOUT} мс`));
      }, method === 'initialize' ? LIST_TIMEOUT : CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Запись в stdin не удалась: ${err.message}`));
        }
      });
    });
  }

  notify(method, params) {
    if (this.closed || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    } catch {}
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP-соединение закрыто'));
    }
    this.pending.clear();
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill();
    } catch {}
  }
}

/** Команда + аргументы из строки вида: npx -y @scope/server --flag value */
function cmdOf(target) {
  const s = String(target).trim();
  if (!s) throw new Error('Не задана команда запуска');
  if (s.startsWith('"')) return s.slice(1, s.indexOf('"', 1));
  return s.split(/\s+/)[0];
}

function shellArgs(target) {
  const s = String(target).trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    const rest = s.slice(end + 1).trim();
    return rest ? rest.split(/\s+/).slice(0, 40) : [];
  }
  return s.split(/\s+/).slice(1, 40);
}

/* --------------------------------------------------------- HTTP/SSE транспорт */

class HttpSession extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = [];
    this.pending = new Map();
    this.nextId = 1;
    this.sessionId = null;
    this.closed = false;
    this.push(`подключение ${cfg.transport} → ${cfg.target}`);
  }

  push(line, level = 'info') {
    this.log.push({ t: new Date().toISOString(), line, level });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
    this.emit('log', { line, level });
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.cfg.headers) {
      try {
        Object.assign(h, typeof this.cfg.headers === 'string' ? JSON.parse(this.cfg.headers) : this.cfg.headers);
      } catch {}
    }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async post(payload, timeout = CALL_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(this.cfg.target, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
      if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) return parseSse(trimmed);
      throw new Error(`Неожиданный ответ: ${trimmed.slice(0, 200)}`);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Таймаут ${timeout} мс`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(method, params) {
    if (this.closed) throw new Error('MCP-соединение закрыто');
    const payload = { jsonrpc: '2.0', id: this.nextId++, method, params: params || {} };
    if (method !== 'initialize' && !this.sessionId) {
      this.push('нет session id — сначала initialize', 'warn');
    }
    const res = await this.post(payload);
    if (res && res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return (res && (res.result || res)) || {};
  }

  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, params: params || {} }, 8000).catch(() => {});
  }

  close() {
    this.closed = true;
  }
}

function parseSse(text) {
  const out = [];
  let currentId = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('data:')) {
      const body = line.slice(5).trim();
      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined) out.push({ id: msg.id, ...msg });
        else if (msg.method) out.push(msg);
      } catch {}
    } else if (line.startsWith('id:')) {
      currentId = line.slice(3).trim();
    }
  }
  return out[out.length - 1] || {};
}

/* --------------------------------------------------------------- реестр сессий */

const sessions = new Map(); // id -> { session, info, ready }

function keyOf(id) {
  return `mcp:${id}`;
}

async function connect(entry) {
  const existing = sessions.get(keyOf(entry.id));
  if (existing && !existing.session.closed && existing.ready) return existing;

  let session;
  try {
    session = entry.transport === 'stdio' ? new StdioSession(entry) : new HttpSession(entry);
  } catch (e) {
    return { ok: false, session: null, error: `Не удалось запустить транспорт: ${e.message}`, tools: [] };
  }
  session.push(`handshake: ${PROTOCOL_VERSION}`, 'info');
  const record = { session, info: entry, ready: false, tools: [], toolDefs: [] };
  sessions.set(keyOf(entry.id), record);
  return record;
}

async function handshake(entry) {
  const record = await connect(entry);
  if (record.ok === false) return record;
  if (record.ready) return record;
  try {
    const init = await record.session.send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'NEXUS', version: '1.4.2' },
    });
    const serverInfo = init.serverInfo || {};
    record.serverInfo = serverInfo;
    record.protocolVersion = init.protocolVersion;
    record.session.push(`сервер: ${serverInfo.name || 'без имени'} ${serverInfo.version || ''}`, 'ok');
    record.session.notify('notifications/initialized', {});
    const list = await record.session.send('tools/list', {});
    record.toolDefs = (list.tools || []).map((t) => ({
      name: t.name,
      description: (t.description || '').slice(0, 400),
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    record.tools = record.toolDefs.map((t) => t.name);
    record.ready = true;
    record.session.push(`tools: ${record.tools.length}${record.tools.length ? ` (${record.tools.slice(0, 5).join(', ')}${record.tools.length > 5 ? '…' : ''})` : ''}`, 'ok');
    return record;
  } catch (e) {
    record.session.push(`handshake не удался: ${e.message}`, 'err');
    record.error = e.message;
    record.ready = false;
    return record;
  }
}

async function reconnect(entry) {
  disconnect(entry.id);
  return handshake(entry);
}

function disconnect(id) {
  const rec = sessions.get(keyOf(id));
  if (rec) {
    try {
      rec.session.close();
    } catch {}
    sessions.delete(keyOf(id));
  }
}

async function callTool(entry, toolName, args) {
  const record = await handshake(entry);
  if (!record.ready) throw new Error(record.error || 'MCP-сервер не подключён');
  const def = record.toolDefs.find((t) => t.name === toolName);
  const res = await record.session.send('tools/call', {
    name: toolName,
    arguments: typeof args === 'string' ? safeParse(args) : args || {},
  });
  if (res.isError) {
    const msg = (res.content || []).map((c) => c.text || '').join(' ');
    throw new Error(msg || 'MCP-инструмент вернул ошибку');
  }
  const text = (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return {
    ok: true,
    tool: toolName,
    description: def ? def.description : '',
    ms: undefined,
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** Проверка соединения для UI: handshake + список реальных tools. */
async function probe(entry) {
  const t0 = Date.now();
  const record = await handshake(entry);
  if (!record.ready) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      tools: [],
      log: (record.session && record.session.log) || [],
      error: record.error || 'не удалось выполнить handshake',
    };
  }
  return {
    ok: true,
    latencyMs: Date.now() - t0,
    tools: record.tools,
    toolDefs: record.toolDefs,
    serverInfo: record.serverInfo || {},
    log: record.session.log,
  };
}

function getLog(id) {
  const rec = sessions.get(keyOf(id));
  return rec && rec.session ? rec.session.log : [];
}

function statusOf(id) {
  const rec = sessions.get(keyOf(id));
  if (!rec) return 'off';
  if (rec.session.closed) return 'off';
  return rec.ready ? 'connected' : 'error';
}

function shutdownAll() {
  for (const [k] of sessions) {
    const rec = sessions.get(k);
    if (rec) {
      try {
        rec.session.close();
      } catch {}
    }
  }
  sessions.clear();
}

process.on('exit', shutdownAll);
process.on('SIGINT', () => {
  shutdownAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownAll();
  process.exit(0);
});

module.exports = { handshake, reconnect, callTool, probe, disconnect, statusOf, getLog, shutdownAll, PROTOCOL_VERSION, cmdOf, shellArgs };