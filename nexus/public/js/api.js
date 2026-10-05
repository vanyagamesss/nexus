/* NEXUS — обёртка над REST API + потоковый запуск агента (NDJSON) */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api(pathname, { method = 'GET', body, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(pathname, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError(0, 'Сервер отвечает слишком долго (таймаут)');
    throw new ApiError(0, 'Нет связи с сервером NEXUS');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, (data && data.error) || `Ошибка ${res.status}`);
    err.auth = !!(data && data.auth);
    err.reason = data && data.reason;
    throw err;
  }
  if (data === null) throw new ApiError(500, 'Пустой ответ сервера');
  return data;
}

/**
 * Запуск агента: POST /api/agents/:id/run, чтение NDJSON-потока построчно.
 * onLine(ev) получает {type:'line', level, text} и финальный {type:'done', stats}.
 */
export async function runAgentStream(agentId, task, { onLine, signal, attachments } = {}) {
  let res;
  const body = { task };
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments.slice(0, 10);
  try {
    res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Поток выполнения оборван: нет связи');
  }
  if (!res.ok || !res.body) {
    let d = null;
    try { d = await res.json(); } catch { /* игнор */ }
    throw new ApiError(res.status, (d && d.error) || `Запуск невозможен (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = null;
  for (;;) {
    const { done: rd, value } = await reader.read();
    if (rd) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (onLine) onLine(ev);
      if (ev.type === 'done') done = ev;
    }
  }
  return done;
}
