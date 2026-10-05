/* NEXUS — командная палитра Ctrl+K: команды, разделы, агенты. Без зависимостей. */
import { esc, icon } from './ui.js';
import { store } from './store.js';
import { t } from './i18n.js';

const COMMANDS = [
  { id: 'go-pulse', titleKey: 'palette.go_pulse', hint: '1', run: () => { location.hash = '#/'; } },
  { id: 'go-team', titleKey: 'palette.go_team', hint: '2', run: () => { location.hash = '#/team'; } },
  { id: 'go-connect', titleKey: 'palette.go_connect', hint: '3', run: () => { location.hash = '#/connect'; } },
  { id: 'cmd-status', titleKey: 'palette.cmd_status', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/статус' })), 120); } },
  { id: 'cmd-agents', titleKey: 'palette.cmd_agents', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/агенты' })), 120); } },
  { id: 'cmd-schedule', titleKey: 'palette.cmd_schedule', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/расписание' })), 120); } },
  { id: 'cmd-history', titleKey: 'palette.cmd_history', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/история' })), 120); } },
  { id: 'cmd-export', titleKey: 'palette.cmd_export', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/экспорт' })), 120); } },
  { id: 'cmd-clear', titleKey: 'palette.cmd_clear', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/очистить' })), 120); } },
  { id: 'cmd-company', titleKey: 'palette.cmd_company', hintKey: 'palette.hint_chat', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/компания' })), 120); } },
  { id: 'theme', titleKey: 'palette.theme', hintKey: 'palette.hint_view', run: () => { document.getElementById('themeBtn')?.click(); } },
  { id: 'console', titleKey: 'palette.console', hintKey: 'palette.hint_dock', run: () => { document.getElementById('dockToggle')?.click(); } },
];

/* Локализованный снимок команды: title/hint вычисляются в момент открытия (текущий язык). */
function localize(c) {
  return {
    ...c,
    title: c.titleKey ? t(c.titleKey) : c.title,
    hint: c.hintKey ? t(c.hintKey) : c.hint,
  };
}

let root = null;
let listEl = null;
let inputEl = null;
let items = [];
let active = 0;
let onPick = null;

function buildItems(q) {
  const query = q.trim().toLowerCase();
  const dyn = (store.agents || []).map((a) => ({
    id: 'agent:' + a.id,
    title: t('palette.agent_title', { avatar: a.avatar || '🤖', name: a.name, role: a.role }),
    hint: a.status === 'offline' ? t('palette.agent_offline') : t('palette.agent'),
    run: () => {
      location.hash = '#/team';
      setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:agent', { detail: a.id })), 200);
    },
  }));
  const all = [...COMMANDS.map(localize), ...dyn];
  if (!query) return all.slice(0, 14);
  return all.filter((c) => (c.title + ' ' + c.id).toLowerCase().includes(query)).slice(0, 14);
}

function paint() {
  if (!listEl) return;
  listEl.innerHTML = items.length
    ? items.map((c, i) => `<button class="pal-item${i === active ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${i === active}"><span class="pal-t">${esc(c.title)}</span><span class="pal-h mono">${esc(c.hint || '')}</span></button>`).join('')
    : `<div class="pal-empty">${esc(t('palette.empty'))}</div>`;
}

function open() {
  if (root) {
    root.hidden = false;
    inputEl.value = '';
    items = buildItems('');
    active = 0;
    paint();
    setTimeout(() => inputEl.focus(), 30);
    return;
  }
  root = document.createElement('div');
  root.className = 'pal-back';
  root.innerHTML = `
    <div class="pal" role="dialog" aria-modal="true" aria-label="${esc(t('palette.dialog_aria'))}">
      <div class="pal-box">${icon('search')}<input id="palInput" class="pal-input" placeholder="${esc(t('palette.placeholder'))}" autocomplete="off" aria-label="${esc(t('palette.input_aria'))}"><kbd class="mono">ctrl+k</kbd></div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <div class="pal-foot mono">${esc(t('palette.footer'))}</div>
    </div>`;
  document.body.appendChild(root);
  listEl = root.querySelector('#palList');
  inputEl = root.querySelector('#palInput');
  items = buildItems('');
  paint();
  inputEl.addEventListener('input', () => { items = buildItems(inputEl.value); active = 0; paint(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    active = Number(b.dataset.i);
    pick();
  });
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  setTimeout(() => inputEl.focus(), 30);
}

function pick() {
  const c = items[active];
  close();
  if (c) {
    try { c.run(); } catch {}
    if (onPick) onPick(c);
  }
}

export function closePalette() {
  if (root) root.hidden = true;
}
export function togglePalette() {
  if (root && !root.hidden) closePalette();
  else open();
}
export function initPalette() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      togglePalette();
    } else if (e.key === 'Escape') {
      if (root && !root.hidden) closePalette();
    }
  });
  if (onPick) return;
  onPick = null;
}
