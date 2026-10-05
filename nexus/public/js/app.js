/* NEXUS — точка входа: роутер hash-SPA, статус системы, инициализация */

import { store, loadAll, refreshSession, login } from './store.js';
import { initConsole, logSys } from './console.js';
import { icon, toast, esc, reducedMotion, toggleTheme, getTheme } from './ui.js';
import { initPalette } from './palette.js';
import * as viewControl from './view-control.js';
import * as viewMain from './view-main.js';
import * as viewKb from './view-kb.js';
import * as viewCtor from './view-constructor.js';
import * as viewSettings from './view-settings.js';

const ROUTES = {
  '/': viewControl,
  '/team': viewMain,
  '/kb': viewKb,
  '/connect': viewSettings,
  /* Совместимость со старыми ссылками */
  '/constructor': viewCtor,
  '/settings': viewSettings,
};

const view = document.getElementById('view');
const sysDot = document.getElementById('sysDot');
const sysText = document.getElementById('sysText');

let cleanup = null;
let renderSeq = 0;

function currentPath() {
  const raw = location.hash.replace(/^#/, '') || '/';
  if (!ROUTES[raw]) {
    toast('Нет такого раздела', `«${raw}» — открываю Пульт`, 'warn');
    return '/';
  }
  return raw;
}

function setActiveNav(path) {
  /* Старые разделы подсвечиваем как их преемников */
  const shown = path === '/constructor' ? '/team' : path === '/settings' ? '/connect' : path;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === shown;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function render() {
  const path = currentPath();
  const seq = ++renderSeq;
  setActiveNav(path);

  if (cleanup) {
    try { cleanup(); } catch { /* игнор */ }
    cleanup = null;
  }

  const old = view.firstElementChild;
  if (old && !reducedMotion) {
    old.style.transition = 'opacity .16s ease, transform .16s ease';
    old.style.opacity = '0';
    old.style.transform = 'translateY(-8px)';
    await wait(160);
  }
  if (seq !== renderSeq) return;

  view.innerHTML = '';
  const mod = ROUTES[path];
  try {
    const ret = mod.mount(view);
    cleanup = typeof ret === 'function' ? ret : null;
  } catch (e) {
    console.error('[nexus] ошибка рендера', e);
    view.innerHTML = `
      <div class="page">
        <div class="empty" style="max-width:640px;margin:40px auto">
          <div class="empty-icon" style="color:var(--rose)">${icon('alert')}</div>
          <h3>Не удалось открыть раздел</h3>
          <p>${esc(e.message || 'Неизвестная ошибка')}</p>
          <button class="btn btn-primary" onclick="location.reload()">${icon('refresh')}Перезагрузить</button>
        </div>
      </div>`;
  }
  view.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
}

function setSys(state, text) {
  if (sysDot) sysDot.dataset.state = state;
  if (sysText) sysText.textContent = text;
}

/** Экран входа для удалённых устройств: PIN либо одноразовый код приглашения. */
function showLogin() {
  setSys('wait', 'требуется вход');
  const acc = store.access || {};
  const pinOnly = acc.pinEnabled && !(acc.invites || []).length;

  view.innerHTML = `
    <div class="page">
      <div class="login-wrap">
        <div class="panel login-card">
          <div class="login-logo">${icon('bot')}</div>
          <h2>Вход в NEXUS</h2>
          <p class="login-sub">Узел защищён. Введите PIN-код, заданный на этом компьютере.</p>
          <form id="loginForm" autocomplete="off">
            <div class="field">
              <label for="lgPin">${pinOnly ? 'PIN-код' : 'PIN-код или код приглашения'}</label>
              <input class="input pin-input" id="lgPin" inputmode="text" autocomplete="one-time-code"
                placeholder="••••••" maxlength="64" autofocus>
            </div>
            <div id="lgErr" role="alert" aria-live="polite"></div>
            <button class="btn btn-primary login-go" id="lgGo" type="submit">${icon('check')}Войти</button>
          </form>
          <div class="login-hint">
            ${icon('info')}
            <span>Нет кода? Откройте NEXUS на самом компьютере: в разделе «Настройки → Доступ» создайте приглашение.</span>
          </div>
        </div>
      </div>
    </div>`;

  const form = view.querySelector('#loginForm');
  const pin = view.querySelector('#lgPin');
  const err = view.querySelector('#lgErr');
  const go = view.querySelector('#lgGo');

  pin.addEventListener('input', () => {
    const v = pin.value.replace(/[^\dA-Za-z\-_]/g, '').slice(0, 64);
    pin.value = v;
    err.innerHTML = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = pin.value.trim();
    if (!raw) return;
    go.disabled = true;
    go.innerHTML = '<span class="spinner"></span>Проверяем';
    /* Чисто цифры — это PIN, иначе пробуем как код приглашения. */
    const body = /^\d+$/.test(raw) ? { pin: raw } : { invite: raw };
    try {
      await login(body);
      location.reload();
    } catch (ex) {
      err.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(ex.message || 'Неверный код')}</div>`;
      go.disabled = false;
      go.innerHTML = `${icon('check')}Войти`;
      pin.select();
    }
  });
}

async function boot() {
  initConsole();
  initPalette();
  setSys('wait', 'подключение…');

  /* Горячие клавиши: 1/2/3 — разделы, ? — помощь (вне полей ввода) */
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '1') location.hash = '#/';
    else if (e.key === '2') location.hash = '#/team';
    else if (e.key === '3') location.hash = '#/connect';
    else if (e.key === '?') toast('Горячие клавиши', 'Ctrl+K — палитра · 1/2/3 — разделы · Ctrl+Enter — отправить · Esc — закрыть', 'ok');
  });

  /* Переключатель светлой/тёмной темы в подвале сайдбара */
  const themeBtn = document.getElementById('themeBtn');
  const paintThemeBtn = () => {
    if (!themeBtn) return;
    const light = getTheme() === 'light';
    themeBtn.setAttribute('aria-pressed', String(light));
    themeBtn.title = light ? 'Тёмная тема' : 'Светлая тема';
  };
  themeBtn?.addEventListener('click', () => { toggleTheme(); paintThemeBtn(); });
  paintThemeBtn();

  window.addEventListener('hashchange', render);

  /* Телефон из сети видит 401 на /api/team — показываем экран входа по PIN. */
  try {
    await refreshSession();
  } catch { /* публичный эндпоинт, ошибка не критична */ }
  const gate = store.session || null;
  if (gate && gate.requiresAuth && !gate.authed && !gate.isLocal) {
    showLogin();
    return;
  }

  try {
    await loadAll();
    const online = store.agents.filter((a) => a.status !== 'offline').length;
    setSys(store.offline ? 'down' : 'ok',
      store.offline
        ? `офлайн · кэш от ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
        : `api ok · ${online} из ${store.agents.length} в сети`);
    if (store.offline) toast('Офлайн-режим', 'Сервер недоступен, показан локальный кэш', 'warn');
    await render();
    logSys('система готова · ожидание задач');
  } catch (e) {
    setSys('down', 'нет связи с api');
    view.innerHTML = `
      <div class="page">
        <div class="empty" style="max-width:640px;margin:48px auto">
          <div class="empty-icon" style="color:var(--rose)">${icon('alert')}</div>
          <h3>Сервер NEXUS не отвечает</h3>
          <p>${esc(e.message || 'Запустите сервер командой')} <span class="mono">node server.js</span> в папке проекта и повторите попытку.</p>
          <button class="btn btn-primary" id="retryBoot">${icon('refresh')}Повторить подключение</button>
        </div>
      </div>`;
    view.querySelector('#retryBoot').addEventListener('click', () => location.reload());
  }

  /* пинг здоровья раз в 30 с (на паузе, когда вкладка скрыта) */
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const t0 = performance.now();
      const r = await fetch('./api/health');
      if (!r.ok) throw new Error('bad');
      const ms = Math.round(performance.now() - t0);
      setSys('ok', `api ok · ${ms} мс`);
    } catch {
      setSys('down', 'нет связи с api');
    }
  }, 30000);

  /* Офлайн-оболочка (PWA). На http в LAN это не secure context — пробуем всё равно, браузер сам решит. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* не критично */ });
    });
  }
}

boot();
