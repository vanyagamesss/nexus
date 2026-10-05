'use strict';

/**
 * NEXUS — свой браузер команды: Google Chrome + DevTools Protocol,
 * без внешних зависимостей (WebSocket встроен в Node 22+).
 *
 * Агент получает инструменты browser_open / snapshot / click / type / back
 * и реально ходит по сайтам: открывает страницы, читает содержимое,
 * нажимает кнопки, заполняет формы (в т.ч. регистрации).
 * Окно браузера обычное, видимое — оператор смотрит, что делает агент.
 *
 * Ограничения честно:
 *   • только публичные http(s)-адреса (приватные сети заблокированы);
 *   • капчи, SMS-коды и 2FA агент пройти не сможет — скажет об этом;
 *   • клики идут по слепку страницы: между snapshot и click страница
 *     не должна успеть перестроиться, иначе ref укажет не туда.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const store = require('./store');

const CDP_PORT = 9222;
const CLICKABLE = 'a,button,input,select,textarea,[role="button"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------- SSRF-фильтр */

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] >= 224) return true;
  return false;
}

async function assertPublicOpen(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    return { error: 'Некорректный URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Только http и https' };
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIPv4(host) || host === '::1' || host === '::') return { error: `Адрес ${host} — приватный, открывать запрещено` };
    return { url: u.toString() };
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return { error: `Хост ${host} — локальный, открывать запрещено` };
  try {
    const records = await dns.lookup(host, { all: true });
    for (const rec of records) {
      if (net.isIP(rec.address) && isPrivateIPv4(rec.address)) {
        return { error: `${host} резолвится в приватный адрес — открывать запрещено` };
      }
    }
  } catch (e) {
    return { error: `Не удалось разрешить хост: ${e.code || e.message}` };
  }
  return { url: u.toString() };
}

/* ------------------------------------------------------------------ CDP */

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
  return res.json();
}

function findChrome() {
  try {
    const programs = store.read('programs.json', []);
    const hit = programs.find((p) => /chrome/i.test(p.name || '') && p.path && fs.existsSync(p.path));
    if (hit) return hit.path;
  } catch { /* игнор */ }
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function ensureBrowser() {
  try {
    await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return { fresh: false };
  } catch { /* не запущен — стартуем */ }
  const exe = findChrome();
  if (!exe) throw new Error('Chrome не найден: добавь его в Подключения → Программы ПК');
  const profile = path.join(store.DATA_DIR, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(exe, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    /* Выглядеть как обычный человек: без флага автоматизации, русский язык, живое окно */
    '--disable-blink-features=AutomationControlled',
    '--lang=ru-RU',
    '--window-size=1360,900',
    '--start-maximized',
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  const t0 = Date.now();
  for (;;) {
    try {
      await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
      break;
    } catch {
      if (Date.now() - t0 > 20000) throw new Error('Браузер не стартовал за 20 с');
      await sleep(500);
    }
  }
  /* Свежее окно — сразу видно чьё: фирменная стартовая страница */
  try {
    await withPage(async (send) => {
      await send('Page.bringToFront');
      const tree = await send('Page.getResourceTree');
      const frameId = (tree && ((tree.frameTree && tree.frameTree.frame) || tree.frame) || {}).id;
      if (frameId) {
        await send('Page.setDocumentContent', {
          frameId,
          html: '<html><head><meta charset="utf-8"><title>NEXUS</title></head><body style="background:#07090F;color:#38E8FF;font-family:sans-serif;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100vh;margin:0"><h1 style="margin:0">NEXUS · браузер команды</h1><p style="color:#8a94a3;margin:0">Этим окном управляют агенты. Смотреть: пульт → /экран</p></body></html>',
        });
      }
    });
  } catch { /* окно и так видно */ }
  return { fresh: true };
}

async function withPage(fn) {
  await ensureBrowser();
  const targets = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^chrome/.test(t.url || ''))
    || targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('Нет открытых вкладок');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP: нет соединения за 10 с')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP недоступен')); };
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    } catch { /* игнор */ }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error(`CDP ${method}: таймаут`));
    }, 25000);
    pending.set(mid, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(`CDP ${method}: ${m.error.message || 'ошибка'}`));
      else resolve(m.result);
    });
    try {
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(mid);
      reject(e);
    }
  });
  try {
    return await fn(send);
  } finally {
    try { ws.close(); } catch { /* игнор */ }
  }
}

async function evaluate(js) {
  return withPage(async (send) => {
    const r = await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`Страница вернула ошибку: ${(r.exceptionDetails.text || '').slice(0, 200)}`);
    }
    return r.result && r.result.value;
  });
}

/* --------------------------------------------------------------- операции */

const SNAP_JS = `(() => {
  const els = Array.from(document.querySelectorAll('${CLICKABLE}'))
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .slice(0, 120);
  return {
    title: document.title || '',
    url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0, 6000),
    items: els.map((e, i) => ({
      ref: i,
      tag: (e.tagName || '').toLowerCase(),
      type: e.type || '',
      text: ((e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '') + '').slice(0, 80),
      href: e.href || '',
    })),
  };
})()`;

async function openPage(url) {
  const check = await assertPublicOpen(url);
  if (check.error) return { ok: false, error: check.error };
  await withPage(async (send) => {
    await send('Page.bringToFront');
    await send('Page.navigate', { url: check.url });
  });
  await sleep(2500); /* даём странице прогрузиться */
  const snap = await snapshot();
  if (!snap.ok) return snap;
  return { ok: true, url: check.url, title: snap.title, textLength: (snap.text || '').length, elements: (snap.items || []).length };
}

async function snapshot() {
  let v;
  try {
    v = await evaluate(SNAP_JS);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!v || typeof v !== 'object') return { ok: false, error: 'Пустой слепок страницы' };
  return { ok: true, title: v.title || '', url: v.url || '', text: v.text || '', items: Array.isArray(v.items) ? v.items : [] };
}

async function clickRef(ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 0 || n > 500) return { ok: false, error: 'ref — номер элемента из snapshot (0–500)' };
  let v;
  try {
    v = await evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('${CLICKABLE}'))
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const el = els[${n}];
      if (!el) return 'no-such-element';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'clicked:' + (el.tagName || '');
    })()`);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (v === 'no-such-element') return { ok: false, error: `Элемента ${n} нет — обнови snapshot` };
  await sleep(1500);
  const snap = await snapshot();
  return { ok: true, clicked: v, url: snap.url || '', title: snap.title || '', elements: (snap.items || []).length };
}

async function typeRef(ref, text, submit) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 0 || n > 500) return { ok: false, error: 'ref — номер элемента из snapshot (0–500)' };
  const t = String(text == null ? '' : text);
  if (!t) return { ok: false, error: 'Пустой текст' };
  if (t.length > 2000) return { ok: false, error: 'Текст длиннее 2000 символов' };
  let v;
  try {
    v = await evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('${CLICKABLE}'))
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const el = els[${n}];
      if (!el) return 'no-such-element';
      el.scrollIntoView({ block: 'center' });
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
      const proto = el.__proto__.__proto__ || el.__proto__;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || setter;
      if (desc && desc.set && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        desc.set.call(el, ${JSON.stringify(t)});
      } else if ('value' in el) {
        el.value = ${JSON.stringify(t)};
      } else {
        return 'not-editable';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));` : ''}
      return 'typed';
    })()`);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (v === 'no-such-element') return { ok: false, error: `Элемента ${n} нет — обнови snapshot` };
  if (v === 'not-editable') return { ok: false, error: 'Элемент не редактируемый — выбери поле ввода' };
  await sleep(1200);
  const snap = await snapshot();
  return { ok: true, url: snap.url || '', title: snap.title || '' };
}

async function goBack() {
  await withPage(async (send) => {
    const hist = await send('Page.getNavigationHistory');
    if (hist && hist.currentIndex > 0) await send('Page.navigateToHistoryEntry', { entryId: hist.entries[hist.currentIndex - 1].id });
    else await send('Page.reload');
  });
  await sleep(1500);
  return snapshot();
}

/** Показать окно браузера человеку: поднять на передний план, вернуть адрес */
async function showWindow() {
  await ensureBrowser();
  const state = await withPage(async (send) => {
    await send('Page.bringToFront');
    return true;
  }).catch(() => false);
  let snap = null;
  try {
    snap = await snapshot();
  } catch { snap = null; }
  return { ok: true, shown: !!state, url: (snap && snap.url) || '', title: (snap && snap.title) || '' };
}

/** Скриншот текущего окна в shots/: оператор смотрит глазами агента */
async function shot() {
  const data = await withPage(async (send) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r || !r.data) throw new Error('Пустой скриншот');
    return r.data;
  });
  const dir = path.join(store.DATA_DIR, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const name = `shot-${Date.now().toString(36)}.png`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'));
  /* Чистим старые: держим последние 30 */
  try {
    const all = fs.readdirSync(dir)
      .filter((f) => /^shot-[a-z0-9]+\.png$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(30)) {
      try { fs.unlinkSync(path.join(dir, old.f)); } catch { /* игнор */ }
    }
  } catch { /* игнор */ }
  return { ok: true, path: `shots/${name}` };
}

/** Состояние для индикатора: запущен ли, что открыто. Не запускает браузер. */
async function state() {
  try {
    await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  } catch {
    return { ok: true, running: false };
  }
  try {
    const targets = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page' && !/^chrome/.test(t.url || ''));
    return { ok: true, running: true, url: (page && page.url) || '', title: (page && page.title) || '' };
  } catch {
    return { ok: true, running: true };
  }
}

module.exports = { openPage, snapshot, clickRef, typeRef, goBack, showWindow, shot, state };
