/* NEXUS — нижняя консоль выполнения: очередь, эффект печати, таймер */

import { runAgentStream } from './api.js';
import { markLocalBusy, refreshTeam, emit, store } from './store.js';
import { esc, reducedMotion, fmtInt } from './ui.js';

const PREFIX = { info: '→', ok: '✔', warn: '!', err: '✗', mcp: '◆', sys: '»', think: '…' };

let els = {};
let chain = Promise.resolve();
let lineQueue = [];
let typing = false;
let pending = 0;
let timerId = null;
let timerStart = 0;
let runCount = 0;

export function initConsole() {
  els = {
    dock: document.getElementById('dock'),
    toggle: document.getElementById('dockToggle'),
    clear: document.getElementById('dockClear'),
    close: document.getElementById('dockClose'),
    fab: document.getElementById('dockFab'),
    log: document.getElementById('dockLog'),
    agent: document.getElementById('dockAgent'),
    timer: document.getElementById('dockTimer'),
    badge: document.getElementById('dockBadge'),
  };
  els.toggle.addEventListener('click', () => (isOpen() ? closeDock() : openDock()));
  els.fab.addEventListener('click', openDock);
  els.close.addEventListener('click', closeDock);
  els.clear.addEventListener('click', () => clearLog(true));
  showEmpty();
}

export const isOpen = () => els.dock && els.dock.dataset.state === 'open';

export function openDock() {
  if (!els.dock || isOpen()) return;
  els.dock.dataset.state = 'open';
  els.toggle.setAttribute('aria-expanded', 'true');
  els.toggle.setAttribute('aria-label', 'Свернуть консоль');
  document.body.classList.add('dock-open');
}

export function closeDock() {
  if (!els.dock) return;
  els.dock.dataset.state = 'closed';
  els.toggle.setAttribute('aria-expanded', 'false');
  els.toggle.setAttribute('aria-label', 'Развернуть консоль');
  document.body.classList.remove('dock-open');
}

function showEmpty() {
  if (!els.log || els.log.querySelector('.log-line')) return;
  els.log.innerHTML = '<div class="dock-empty">// консоль пуста — запустите агента или всю команду<span class="log-caret"></span></div>';
}

export function clearLog(quiet) {
  if (!els.log) return;
  els.log.innerHTML = '';
  lineQueue = [];
  pending = 0;
  showEmpty();
  els.agent.textContent = 'ожидание команды';
  els.badge.hidden = true;
  if (quiet) els.log.scrollTop = 0;
}

function stamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function atBottom() {
  const el = els.log;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 70;
}

function scrollToBottom(force) {
  if (force || atBottom()) els.log.scrollTop = els.log.scrollHeight;
}

function pushLine(level, text) {
  const empty = els.log.querySelector('.dock-empty');
  if (empty) empty.remove();
  lineQueue.push({ level, text: String(text ?? '') });
  pending++;
  if (!typing) processQueue();
}

async function processQueue() {
  typing = true;
  while (lineQueue.length) {
    const { level, text } = lineQueue.shift();
    const row = document.createElement('div');
    row.className = `log-line lv-${level}`;
    row.innerHTML = `<span class="lt">${stamp()}</span><span class="lp">${PREFIX[level] || '·'}</span><span class="ltx"></span>`;
    els.log.appendChild(row);
    pending = Math.max(0, pending - 1);
    const target = row.querySelector('.ltx');
    const instant = reducedMotion || pending > 7 || text.length > 220;
    if (instant) {
      target.textContent = text;
      scrollToBottom();
      await new Promise((r) => setTimeout(r, instant && !reducedMotion && pending > 7 ? 40 : 0));
    } else {
      await typeInto(target, text);
    }
    const rows = els.log.querySelectorAll('.log-line');
    if (rows.length > 400) rows[0].remove();
  }
  typing = false;
}

function typeInto(target, text) {
  return new Promise((resolve) => {
    const total = Math.min(760, 130 + text.length * 9);
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / total);
      const n = Math.round(text.length * p);
      target.textContent = text.slice(0, n);
      scrollToBottom();
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

export function logLine(level, text) { pushLine(level, text); }
export function logInfo(t) { pushLine('info', t); }
export function logOk(t) { pushLine('ok', t); }
export function logErr(t) { pushLine('err', t); }
export function logSys(t) { pushLine('sys', t); }

export function setAgent(name) {
  els.agent.textContent = name;
}

export function setBadge(text) {
  els.badge.hidden = !text;
  els.badge.textContent = text || '';
}

function startTimer() {
  if (timerId) return;
  timerStart = Date.now();
  els.timer.classList.add('run');
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function stopTimer() {
  if (!timerId) return;
  clearInterval(timerId);
  timerId = null;
  els.timer.classList.remove('run');
}

export function isRunning() {
  return pending > 0 || typing || lineQueue.length > 0;
}

/**
 * Ставит запуск агента в общую очередь консоли.
 * Возвращает промис, который завершается после синхронизации состояния с сервером.
 */
export function runAgent(agent, task, { onStart, onDone, onLine, signal, attachments } = {}) {
  const job = async () => {
    if (signal && signal.aborted) {
      if (onDone) onDone(new Error('Остановлено'));
      return null;
    }
    openDock();
    runCount++;
    setAgent(`${agent.name} · ${agent.role}`);
    setBadge('выполняет…');
    startTimer();
    logSys(`── запуск «${agent.name}» · задача: ${task}`);
    markLocalBusy(agent.id, task);
    if (onStart) onStart();
    let thinkBuf = '';
    let thinkCount = 0;
    let thinkLast = 0;
    try {
      const done = await runAgentStream(agent.id, task, {
        signal,
        attachments,
        onLine: (ev) => {
          if (ev.type === 'line') {
            pushLine(ev.level || 'info', ev.text);
            rememberLine(agent.id, ev.level || 'info', ev.text);
          } else if (ev.type === 'tool') {
            /* Видно, что делает агент прямо сейчас: открытия, клики, вызовы */
            if (ev.state === 'start') pushLine('info', ev.text);
            else if (ev.state === 'done' && ev.ok === false) pushLine('warn', `${ev.name}: ${ev.text}`);
          } else if (ev.type === 'think') {
            /* Мысли вслух: копим и показываем редко, чтобы не топить консоль */
            thinkBuf += ev.text;
            thinkCount++;
            const now = Date.now();
            if (now - thinkLast > 4000) {
              thinkLast = now;
              pushLine('think', `думает… ${thinkBuf.slice(-220)}`);
            }
          } else if (ev.type === 'done') {
            pushLine('ok', `сводка: ${ev.stats.tokens} токенов · ${ev.stats.steps} шагов · ${ev.stats.seconds} с`);
          }
          /* Внешний подписчик (чат-пульт) получает те же события живьём. */
          if (onLine) { try { onLine(ev); } catch { /* игнор */ } }
        },
      });
      if (done) {
        if (thinkCount && thinkBuf) pushLine('think', `додумал · всего ${thinkCount} фрагментов`);
        pushLine('sys', `«${agent.name}» завершил(а) задачу`);
        notify(`NEXUS: ${agent.name} готов`, (done.text || task || '').slice(0, 180));
        await refreshTeam();
      }
      if (onDone) onDone(null, done);
      return done;
    } catch (e) {
      if (e && (e.name === 'AbortError' || (signal && signal.aborted))) {
        pushLine('warn', `«${agent.name}» остановлен(а) оператором`);
        if (onDone) onDone(new Error('Остановлено оператором'));
        return null;
      }
      pushLine('err', `сбой запуска: ${e.message}`);
      notify(`NEXUS: ${agent.name} — ошибка`, e.message);
      if (onDone) onDone(e);
      return null;
    } finally {
      runCount = Math.max(0, runCount - 1);
      if (runCount === 0) {
        stopTimer();
        setBadge('');
      }
    }
  };
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

/**
 * Запускает всю команду последовательно, с разделителями в консоли.
 * opts.chain — режим цепочки: результат каждого агента передаётся дальше,
 * последний собирает единый итог. Переговоры видны прямо здесь, в консоли.
 */
export async function runTeam(agents, taskFor, opts = {}) {
  const list = agents.filter((a) => a.status !== 'offline');
  if (!list.length) return;
  const chain = !!opts.chain;
  openDock();
  logSys(`════════ запуск команды «${store.team ? store.team.name : ''}» · агентов: ${list.length}${chain ? ' · режим: ЦЕПОЧКА' : ''} ════════`);
  let context = '';
  let stopped = false;
  for (let i = 0; i < list.length; i++) {
    if (opts.signal && opts.signal.aborted) {
      stopped = true;
      logSys('пакет остановлен оператором');
      break;
    }
    const a = list[i];
    const base = typeof taskFor === 'function' ? taskFor(a, i, context) : String(taskFor);
    const isLast = chain && i === list.length - 1;
    const task = chain && context
      ? `${base}\n\nЭстафета от коллег (не начинай с нуля — дополни и улучши):${context}`
        + (isLast ? '\nТы финишёр цепочки: собери ЕДИНЫЙ итоговый результат (один файл / один ответ), а не свой отдельный.' : '')
      : base;
    logInfo(`[${i + 1}/${list.length}] очередь: ${a.name} — ${task.slice(0, 120)}`);
    if (chain && context) logSys(`переговоры: ${i === 0 ? 'старт' : `контекст ${context.length} символов → ${a.name}`}`);
    /* onLine пробрасываем с привязкой к агенту, чтобы чат знал автора строк. */
    const done = await runAgent(a, task, {
      ...opts,
      onLine: opts.onLine ? ((ev) => opts.onLine(ev, a)) : undefined,
      onDone: opts.onDone ? ((err, d) => opts.onDone(err, d, a)) : undefined,
    });
    if (chain && done && done.text) {
      context += `\n\n--- ${a.name}: ${done.text.slice(0, 3000)}`;
      logOk(`эстафета: ${a.name} передал дальше (${done.text.length} символов)`);
    } else if (chain) {
      logSys(`эстафета: ${a.name} ничего не передал — следующий идёт без его контекста`);
    }
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, 260));
  }
  logSys(stopped ? '════════ пакет остановлен ════════' : '════════ команда завершила пакет задач ════════');
  emit('team');
}

/* история логов агента для боковой панели */
const history = new Map();

export function agentHistory(agentId) {
  if (!history.has(agentId)) {
    history.set(agentId, []);
  }
  return history.get(agentId);
}

export function rememberLine(agentId, level, text) {
  const h = agentHistory(agentId);
  h.push({ level, text, t: Date.now() });
  if (h.length > 60) h.shift();
}

export function formatStat(n) { return fmtInt(n); }

/** Desktop-уведомление, только если вкладка скрыта и разрешение дано */
export function notify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(title, { body: String(body || '').slice(0, 180) });
      setTimeout(() => { try { n.close(); } catch {} }, 8000);
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch { /* игнор */ }
}
export { esc };
