/* NEXUS — командная палитра Ctrl+K: команды, разделы, агенты. Без зависимостей. */
import { esc, icon } from './ui.js';
import { store } from './store.js';

const COMMANDS = [
  { id: 'go-pulse', title: 'Пульт — чат команды', hint: '1', run: () => { location.hash = '#/'; } },
  { id: 'go-team', title: 'Команда — агенты и пульс', hint: '2', run: () => { location.hash = '#/team'; } },
  { id: 'go-connect', title: 'Подключения — модели и сервисы', hint: '3', run: () => { location.hash = '#/connect'; } },
  { id: 'cmd-status', title: '/статус — состояние команды', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/статус' })), 120); } },
  { id: 'cmd-agents', title: '/агенты — список агентов', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/агенты' })), 120); } },
  { id: 'cmd-schedule', title: '/расписание — планировщик', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/расписание' })), 120); } },
  { id: 'cmd-history', title: '/история — прошлые задачи', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/история' })), 120); } },
  { id: 'cmd-export', title: '/экспорт — скачать переписку', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/экспорт' })), 120); } },
  { id: 'cmd-clear', title: '/очистить — новая переписка', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/очистить' })), 120); } },
  { id: 'cmd-company', title: '/компания — целая ИИ-компания в один клик', hint: 'чат', run: () => { location.hash = '#/'; setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:chat', { detail: '/компания' })), 120); } },
  { id: 'theme', title: 'Переключить тему (светлая/тёмная)', hint: 'вид', run: () => { document.getElementById('themeBtn')?.click(); } },
  { id: 'console', title: 'Открыть/закрыть консоль', hint: 'док', run: () => { document.getElementById('dockToggle')?.click(); } },
];

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
    title: `${a.avatar || '🤖'} ${a.name} — ${a.role}`,
    hint: a.status === 'offline' ? 'офлайн' : 'агент',
    run: () => {
      location.hash = '#/team';
      setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:agent', { detail: a.id })), 200);
    },
  }));
  const all = [...COMMANDS, ...dyn];
  if (!query) return all.slice(0, 14);
  return all.filter((c) => (c.title + ' ' + c.id).toLowerCase().includes(query)).slice(0, 14);
}

function paint() {
  if (!listEl) return;
  listEl.innerHTML = items.length
    ? items.map((c, i) => `<button class="pal-item${i === active ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${i === active}"><span class="pal-t">${esc(c.title)}</span><span class="pal-h mono">${esc(c.hint || '')}</span></button>`).join('')
    : '<div class="pal-empty">Ничего не найдено — попробуйте «статус» или имя агента</div>';
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
    <div class="pal" role="dialog" aria-modal="true" aria-label="Командная палитра">
      <div class="pal-box">${icon('search')}<input id="palInput" class="pal-input" placeholder="Команда, раздел или агент… (Esc — закрыть)" autocomplete="off" aria-label="Поиск команды"><kbd class="mono">ctrl+k</kbd></div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <div class="pal-foot mono">↑↓ — выбор · enter — выполнить · 1/2/3 — разделы</div>
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
