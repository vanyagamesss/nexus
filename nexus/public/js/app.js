/* NEXUS — точка входа: роутер hash-SPA, статус системы, инициализация */

import { store, loadAll, refreshSession, login } from './store.js';
import { t, localeTag, initI18n, applyI18n, getLang, langName, setLang, nextLang } from './i18n.js';
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
    toast(t('app.no_route'), t('app.no_route_text', { path: raw }), 'warn');
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
          <h3>${esc(t('app.render_fail'))}</h3>
          <p>${esc(e.message || t('app.unknown_err'))}</p>
          <button class="btn btn-primary" onclick="location.reload()">${icon('refresh')}${esc(t('app.reload'))}</button>
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
  setSys('wait', t('app.sys_login'));
  const acc = store.access || {};
  const pinOnly = acc.pinEnabled && !(acc.invites || []).length;

  view.innerHTML = `
    <div class="page">
      <div class="login-wrap">
        <div class="panel login-card">
          <div class="login-logo">${icon('bot')}</div>
          <h2>${esc(t('app.login_title'))}</h2>
          <p class="login-sub">${esc(t('app.login_sub'))}</p>
          <form id="loginForm" autocomplete="off">
            <div class="field">
              <label for="lgPin">${esc(pinOnly ? t('app.login_pin') : t('app.login_pin_or_invite'))}</label>
              <input class="input pin-input" id="lgPin" inputmode="text" autocomplete="one-time-code"
                placeholder="••••••" maxlength="64" autofocus>
            </div>
            <div id="lgErr" role="alert" aria-live="polite"></div>
            <button class="btn btn-primary login-go" id="lgGo" type="submit">${icon('check')}${esc(t('app.login_go'))}</button>
          </form>
          <div class="login-hint">
            ${icon('info')}
            <span>${esc(t('app.login_hint'))}</span>
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
    go.innerHTML = `<span class="spinner"></span>${esc(t('app.login_checking'))}`;
    /* Чисто цифры — это PIN, иначе пробуем как код приглашения. */
    const body = /^\d+$/.test(raw) ? { pin: raw } : { invite: raw };
    try {
      await login(body);
      location.reload();
    } catch (ex) {
      err.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(ex.message || t('app.login_bad'))}</div>`;
      go.disabled = false;
      go.innerHTML = `${icon('check')}${esc(t('app.login_go'))}`;
      pin.select();
    }
  });
}

async function boot() {
  initI18n();
  applyI18n();
  try { document.title = t('app.title'); } catch { /* ignore */ }
  initConsole();
  initPalette();
  setSys('wait', t('app.sys_connecting'));

  /* Переключатель языка EN/RU/中文 */
  const langBtn = document.getElementById('langBtn');
  const langTag = document.getElementById('langTag');
  if (langTag) langTag.textContent = langName(getLang());
  langBtn?.addEventListener('click', () => {
    toast(t('app.lang_t'), t('app.lang_d', { lang: langName(nextLang()) }), 'ok');
    setTimeout(() => setLang(nextLang()), 450);
  });

  /* Горячие клавиши: 1/2/3 — разделы, ? — помощь (вне полей ввода) */
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '1') location.hash = '#/';
    else if (e.key === '2') location.hash = '#/team';
    else if (e.key === '3') location.hash = '#/connect';
    else if (e.key === '?') toast(t('app.hotkeys_title'), t('app.hotkeys_text'), 'ok');
  });

  /* Переключатель светлой/тёмной темы в подвале сайдбара */
  const themeBtn = document.getElementById('themeBtn');
  const paintThemeBtn = () => {
    if (!themeBtn) return;
    const light = getTheme() === 'light';
    themeBtn.setAttribute('aria-pressed', String(light));
    themeBtn.title = light ? t('app.theme_dark') : t('app.theme_light');
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
        ? t('app.sys_offline', { time: new Date().toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) })
        : t('app.sys_online', { online, total: store.agents.length }));
    if (store.offline) toast(t('app.offline_title'), t('app.offline_text'), 'warn');
    await render();
    logSys(t('app.ready_log'));
  } catch (e) {
    setSys('down', t('app.sys_down'));
    view.innerHTML = `
      <div class="page">
        <div class="empty" style="max-width:640px;margin:48px auto">
          <div class="empty-icon" style="color:var(--rose)">${icon('alert')}</div>
          <h3>${esc(t('app.boot_fail_title'))}</h3>
          <p>${esc(e.message || t('app.boot_fail_text'))} <span class="mono">node server.js</span> ${esc(t('app.boot_fail_hint'))}</p>
          <button class="btn btn-primary" id="retryBoot">${icon('refresh')}${esc(t('app.retry'))}</button>
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
      setSys('ok', t('app.sys_ping', { ms }));
    } catch {
      setSys('down', t('app.sys_down'));
    }
  }, 30000);

  /* Офлайн-оболочка (PWA). На http в LAN это не secure context — пробуем всё равно, браузер сам решит. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* не критично */ });
    });
  }
}

document.title = t('app.title');
boot();
