/* NEXUS i18n — English / Русский / 中文, default English.
 *
 * How it works:
 *  - strings live in i18n.<ns>.js partials as { ns: { key: {en, ru, zh} } },
 *    merged below into one registry;
 *  - UI code uses t('ns.key') or t('ns.key', {name}) with {placeholders};
 *  - language persists in localStorage 'nexus_lang', switching reloads the app;
 *  - static index.html strings use data-i18n / data-i18n-ph / data-i18n-aria /
 *    data-i18n-title attributes, applied by applyI18n().
 */

import { dict_app } from './i18n.app.js';
import { dict_ui } from './i18n.ui.js';
import { dict_console } from './i18n.console.js';
import { dict_palette } from './i18n.palette.js';
import { dict_control } from './i18n.control.js';
import { dict_team } from './i18n.team.js';
import { dict_kb } from './i18n.kb.js';
import { dict_ctor } from './i18n.ctor.js';
import { dict_settings } from './i18n.settings.js';

export const LANGS = ['en', 'ru', 'zh'];
export const LANG_NAMES = { en: 'EN', ru: 'RU', zh: '中文' };
const LANG_KEY = 'nexus_lang';

const dicts = {};

function isLeaf(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    (typeof v.en === 'string' || typeof v.ru === 'string' || typeof v.zh === 'string');
}

function merge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !isLeaf(v)) {
      if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
      merge(dst[k], v);
    } else {
      dst[k] = v;
    }
  }
}

[dict_app, dict_ui, dict_console, dict_palette, dict_control,
  dict_team, dict_kb, dict_ctor, dict_settings].forEach((d) => merge(dicts, d));

export function getLang() {
  try {
    const l = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(l)) return l;
  } catch { /* private mode */ }
  return 'en';
}

export function langName(l) {
  return LANG_NAMES[l] || l;
}

/** BCP47-тег для дат, чисел и синтеза речи: en-US / ru-RU / zh-CN. */
export function localeTag() {
  const l = getLang();
  return l === 'ru' ? 'ru-RU' : l === 'zh' ? 'zh-CN' : 'en-US';
}

/** Switch language (persisted) and reload the app. */
export function setLang(l) {
  if (!LANGS.includes(l)) return;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ }
  location.reload();
}

/** Next language in the cycle, for the globe button. */
export function nextLang() {
  const i = LANGS.indexOf(getLang());
  return LANGS[(i + 1) % LANGS.length];
}

/** Translate 'ns.key' with optional {placeholders}. Falls back en → ru → key. */
export function t(path, vars) {
  const lang = getLang();
  let node = dicts;
  for (const part of String(path || '').split('.')) {
    if (node && typeof node === 'object') node = node[part];
    else { node = null; break; }
  }
  let s = null;
  if (node && typeof node === 'object') {
    s = node[lang] ?? node.en ?? node.ru ?? node.zh ?? null;
  } else if (typeof node === 'string') {
    s = node;
  }
  if (typeof s !== 'string') return String(path);
  if (vars && typeof vars === 'object') {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  }
  return s;
}

/** Apply data-i18n* attributes inside root (default: whole document). */
export function applyI18n(root) {
  const base = root || document;
  try {
    base.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    base.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.i18nPh)); });
    base.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    base.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.dataset.i18nTitle)); });
  } catch { /* best effort */ }
}

/** Call once at boot: sets <html lang> + dataset for CSS hooks. */
export function initI18n() {
  const l = getLang();
  try {
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
    document.documentElement.dataset.lang = l;
  } catch { /* ignore */ }
  return l;
}
