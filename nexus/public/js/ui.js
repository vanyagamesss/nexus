/* NEXUS — общие утилиты: иконки, форматирование, анимации, модалки, тосты */

import { t, getLang, localeTag } from './i18n.js';

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------- тема оформления */

const THEME_KEY = 'nexus_theme';

/** Текущая тема: 'light' либо 'dark' (по умолчанию тёмная). */
export function getTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* приватный режим */ }
  return 'dark';
}

export function setTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* приватный режим */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#07090F');
  return t;
}

export function toggleTheme() {
  return setTheme(getTheme() === 'light' ? 'dark' : 'light');
}

/* ------------------------------------------------------------ безопасность */

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Безопасный CSS-цвет для --accent: только #rgb/#rrggbb, иначе фолбэк. */
export function safeAccent(v, fallback = '#38E8FF') {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || '').trim()) ? String(v).trim() : fallback;
}

/** Безопасный id для SVG-градиентов: только [A-Za-z0-9_-]. */
export function safeGid(s) {
  const v = String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return v || ('g' + Math.random().toString(36).slice(2, 8));
}

/* ------------------------------------------------------------- иконки */

const PATHS = {
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  grip: '<circle cx="9" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1.3" fill="currentColor" stroke="none"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
  appWindow: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6.5 6.5h.01"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v4a6 6 0 0 1-12 0V8Z"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.5 4 4 0 0 0 6.5 19Z"/>',
  gitBranch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  layout: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  chart: '<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8"/><rect x="12" y="6" width="3" height="12"/><rect x="17" y="13" width="3" height="5"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  checkSquare: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="15.5" cy="10" r="1.2"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  headset: '<path d="M4 14a8 8 0 0 1 16 0"/><rect x="2" y="14" width="4" height="7" rx="2"/><rect x="18" y="14" width="4" height="7" rx="2"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>',
  translate: '<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1"/><path d="m22 22-5-10-5 10M14 18h6"/>',
  academic: '<path d="m22 10-10-5L2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"/><path d="M22 10v6"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M8 14h.01M16 14h.01"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  slack: '<rect x="4" y="3" width="4" height="10" rx="2"/><rect x="16" y="11" width="4" height="10" rx="2"/><rect x="11" y="4" width="10" height="4" rx="2"/><rect x="3" y="16" width="10" height="4" rx="2"/>',
  notion: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 17V8l6 9V8"/>',
  openai: '<path d="m12 2 8.7 5v10L12 22l-8.7-5V7Z"/><circle cx="12" cy="12" r="3.4"/>',
  ollama: '<circle cx="12" cy="12" r="9"/><path d="M8.2 14.8c1.6-3.6 6-3.6 7.6 0"/><circle cx="9.4" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14.6" cy="10" r="1" fill="currentColor" stroke="none"/>',
  k8s: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v5.8M12 15.2V21M3 12h5.8M15.2 12H21M5.6 5.6l4.1 4.1M14.3 14.3l4.1 4.1M18.4 5.6l-4.1 4.1M9.7 14.3l-4.1 4.1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.5 17.5 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a10.3 10.3 0 0 0 5.4-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>',
  layers: '<path d="m12 2 10 5.5L12 13 2 7.5Z"/><path d="m2 12.5 10 5.5 10-5.5"/><path d="m2 17.5 10 5.5 10-5.5"/>',
};

export function icon(name, cls = '') {
  const p = PATHS[name] || PATHS.info;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${p}</svg>`;
}

/* --------------------------------------------------- доменные токены */

export const ROLES = [
  { key: 'dev', name: t('ui.role_dev_name'), accent: '#38E8FF', accent2: '#8B5CF6', icon: 'code', avatar: '🧑‍💻', desc: t('ui.role_dev_desc') },
  { key: 'research', name: t('ui.role_research_name'), accent: '#8B5CF6', accent2: '#38E8FF', icon: 'search', avatar: '🔎', desc: t('ui.role_research_desc') },
  { key: 'editor', name: t('ui.role_editor_name'), accent: '#A3E635', accent2: '#2DD4BF', icon: 'pen', avatar: '✍️', desc: t('ui.role_editor_desc') },
  { key: 'analyst', name: t('ui.role_analyst_name'), accent: '#60A5FA', accent2: '#38E8FF', icon: 'chart', avatar: '📊', desc: t('ui.role_analyst_desc') },
  { key: 'devops', name: t('ui.role_devops_name'), accent: '#FBBF24', accent2: '#FB923C', icon: 'server', avatar: '🛠️', desc: t('ui.role_devops_desc') },
  { key: 'assistant', name: t('ui.role_assistant_name'), accent: '#F472B6', accent2: '#8B5CF6', icon: 'message', avatar: '🤖', desc: t('ui.role_assistant_desc') },
  { key: 'tester', name: t('ui.role_tester_name'), accent: '#2DD4BF', accent2: '#A3E635', icon: 'checkSquare', avatar: '🧪', desc: t('ui.role_tester_desc') },
  { key: 'designer', name: t('ui.role_designer_name'), accent: '#E879F9', accent2: '#F472B6', icon: 'palette', avatar: '🎨', desc: t('ui.role_designer_desc') },
  { key: 'pm', name: t('ui.role_pm_name'), accent: '#34D399', accent2: '#2DD4BF', icon: 'clipboard', avatar: '📋', desc: t('ui.role_pm_desc') },
  { key: 'marketer', name: t('ui.role_marketer_name'), accent: '#FB923C', accent2: '#FBBF24', icon: 'megaphone', avatar: '📣', desc: t('ui.role_marketer_desc') },
  { key: 'translator', name: t('ui.role_translator_name'), accent: '#67E8F9', accent2: '#38E8FF', icon: 'translate', avatar: '🌐', desc: t('ui.role_translator_desc') },
  { key: 'mentor', name: t('ui.role_mentor_name'), accent: '#C084FC', accent2: '#8B5CF6', icon: 'academic', avatar: '🎓', desc: t('ui.role_mentor_desc') },
  { key: 'custom', name: t('ui.role_custom_name'), accent: '#94A3B8', accent2: '#64748B', icon: 'plus', avatar: '⭐', desc: t('ui.role_custom_desc') },
];

/** Весёлые эмодзи для выбора аватара агента. */
export const AVATARS = ['🤖', '🧑‍💻', '🔎', '✍️', '📊', '🛠️', '🧪', '🎨', '🤵', '🦊', '🐙', '🦄', '👾', '🐳', '🦉', '🔥', '⚡', '💎', '🍩', '🚀'];

/** Эмодзи-аватар агента: свой, иначе по роли, иначе робот. */
export function agentAvatar(a) {
  if (a && typeof a.avatar === 'string' && a.avatar.trim()) return a.avatar.trim();
  return (a && roleMeta(a.roleKey).avatar) || '🤖';
}

export function roleMeta(key) {
  return ROLES.find((r) => r.key === key) || ROLES[5];
}

export const MISSIONS = [
  { key: t('ui.mission_development'), icon: 'code', color: '#38E8FF', desc: t('ui.mission_development_desc') },
  { key: t('ui.mission_marketing'), icon: 'megaphone', color: '#F472B6', desc: t('ui.mission_marketing_desc') },
  { key: t('ui.mission_analytics'), icon: 'chart', color: '#60A5FA', desc: t('ui.mission_analytics_desc') },
  { key: t('ui.mission_support'), icon: 'headset', color: '#A3E635', desc: t('ui.mission_support_desc') },
  { key: t('ui.mission_automation'), icon: 'bot', color: '#FBBF24', desc: t('ui.mission_automation_desc') },
];

export const DEFAULT_TASKS = {
  dev: t('ui.task_dev'),
  research: t('ui.task_research'),
  editor: t('ui.task_editor'),
  analyst: t('ui.task_analyst'),
  devops: t('ui.task_devops'),
  assistant: t('ui.task_assistant'),
  tester: t('ui.task_tester'),
  designer: t('ui.task_designer'),
  pm: t('ui.task_pm'),
  marketer: t('ui.task_marketer'),
  translator: t('ui.task_translator'),
  mentor: t('ui.task_mentor'),
  custom: t('ui.task_custom'),
};

export const SVC_COLORS = {
  github: '#d7dde8', telegram: '#4FB8FF', slack: '#F2749B', notion: '#f0f0f0',
  gdrive: '#FFD35C', openai: '#7CE8D2', ollama: '#C4B5FD', smtp: '#94A3B8',
  postgres: '#60A5FA', k8s: '#6EA8FF', custom: '#38E8FF',
};

export const ORCH_MODES = {
  parallel: { name: t('ui.orch_parallel_name'), desc: t('ui.orch_parallel_desc') },
  sequential: { name: t('ui.orch_sequential_name'), desc: t('ui.orch_sequential_desc') },
  hierarchy: { name: t('ui.orch_hierarchy_name'), desc: t('ui.orch_hierarchy_desc') },
};

/* ------------------------------------------------------------ формат */

export function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString(localeTag());
}

export function fmtCompact(n) {
  n = Math.round(Number(n) || 0);
  const comma = getLang() === 'ru';
  const fix = (v) => (comma ? v.toFixed(1).replace('.', ',').replace(/,0$/, '') : v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10).replace(/\.0$/, ''));
  if (n >= 1e6) return fix(n / 1e6) + ' ' + t('ui.num_million');
  if (n >= 1e3) return fix(n / 1e3) + ' ' + t('ui.num_thousand');
  return String(n);
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(localeTag(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60) return t('ui.time_now');
  if (diff < 3600) return t('ui.time_min', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('ui.time_hour', { n: Math.floor(diff / 3600) });
  return t('ui.time_day', { n: Math.floor(diff / 86400) });
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '••••••';
  return '••••••••••' + key.slice(-4);
}

/* ------------------------------------------------------------ анимации */

export function countUp(el, to, opts = {}) {
  const dur = opts.dur ?? 950;
  const format = opts.format ?? ((v) => fmtInt(v));
  const from = opts.from ?? 0;
  to = Number(to) || 0;
  if (reducedMotion) { el.textContent = format(to); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = format(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function stagger(root) {
  if (!root) return;
  [...root.children].forEach((c, i) => c.style.setProperty('--i', i));
  root.classList.add('stagger');
}

export function tilt(card) {
  if (reducedMotion || window.matchMedia('(pointer: coarse)').matches) return;
  let raf = null;
  card.addEventListener('pointermove', (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
      card.style.transform = `perspective(900px) rotateX(${((0.5 - py) * 7).toFixed(2)}deg) rotateY(${((px - 0.5) * 8).toFixed(2)}deg) translateY(-3px)`;
    });
  });
  card.addEventListener('pointerleave', () => {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    card.style.transform = '';
  });
}

/* ------------------------------------------------------------ графика */

export function avatarOrb(agent, cls = '') {
  const meta = roleMeta(agent.roleKey);
  const ac = safeAccent(agent.accent || meta.accent);
  const av = agentAvatar(agent);
  return `<span class="orb has-emoji ${cls}" data-status="${esc(agent.status)}" style="--accent:${ac};--accent2:${esc(meta.accent2)}" aria-hidden="true"><span class="av-emoji">${esc(av)}</span></span>`;
}

export function statusPill(status) {
  const label = { online: t('ui.status_online'), busy: t('ui.status_busy'), offline: t('ui.status_offline') }[status] || status;
  return `<span class="status-pill" data-status="${esc(status)}"><i></i>${label}</span>`;
}

export function sparkSVG(agent) {
  const data = (agent.spark && agent.spark.length ? agent.spark : [10, 20, 15]).slice(-12);
  const w = 120, h = 30;
  const max = Math.max(...data), min = Math.min(...data);
  const span = Math.max(1, max - min);
  const pts = data.map((v, i) => [
    +((i / Math.max(1, data.length - 1)) * w).toFixed(1),
    +(h - 3 - ((v - min) / span) * (h - 8)).toFixed(1),
  ]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const area = `M0,${h} L` + pts.map((p) => `${p[0]},${p[1]}`).join(' L') + ` L${w},${h} Z`;
  const gid = safeGid(`sg_${agent.id}`);
  const ac = safeAccent(agent.accent, '#38E8FF');
  return `<svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${ac}" stop-opacity=".4"/>
      <stop offset="1" stop-color="${ac}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${gid})" stroke="none"/>
    <polyline class="spark-line" points="${line}" stroke="${ac}"/>
  </svg>`;
}

/* -------------------------------------------------------------- тосты */

export function toast(title, text = '', kind = 'ok') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  const ic = kind === 'ok' ? 'check' : 'alert';
  el.innerHTML = `${icon(ic)}
    <div><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>
    <button class="icon-btn" aria-label="${esc(t('ui.toast_close'))}">${icon('x')}</button>`;
  root.appendChild(el);
  const kill = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  };
  el.querySelector('button').addEventListener('click', kill);
  setTimeout(kill, 4600);
  while (root.children.length > 4) root.firstElementChild.remove();
}

/* ------------------------------------------------------------- модалки */

let openModals = [];

export function openModal({ kicker = '', title, body = '', footer = '' }) {
  const layer = document.createElement('div');
  layer.className = 'modal-layer';
  layer.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div>${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}<h3>${esc(title)}</h3></div>
        <button class="icon-btn" data-close aria-label="${esc(t('ui.modal_close'))}">${icon('x')}</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${footer}</div>
    </div>`;
  document.body.appendChild(layer);
  const modal = layer.querySelector('.modal');
  const close = () => {
    openModals = openModals.filter((m) => m !== api);
    layer.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  const api = { layer, modal, close };
  openModals.push(api);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
  layer.querySelector('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  const focusable = modal.querySelector('input, textarea, select, .btn-primary');
  if (focusable) setTimeout(() => focusable.focus(), 60);
  return api;
}

export function confirmDialog({ kicker = t('ui.confirm_kicker'), title, text, okText = t('ui.confirm_ok'), danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); m.close(); finish(false); } };
    document.addEventListener('keydown', onKey);
    const m = openModal({
      kicker,
      title,
      body: `<p class="muted" style="font-size:13.5px;line-height:1.6">${esc(text)}</p>`,
      footer: `<button class="btn btn-ghost" data-cancel>${esc(t('ui.cancel'))}</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', () => { m.close(); finish(false); });
    m.modal.querySelector('[data-ok]').addEventListener('click', () => { m.close(); finish(true); });
    m.layer.addEventListener('mousedown', (e) => { if (e.target === m.layer) { m.close(); finish(false); } });
  });
}

export function updateRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

/* ============================================================ реальные данные */

/** Байты → человекочитаемый вид. */
export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(1).replace('.', ',') + ' ТБ';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace('.', ',') + ' ГБ';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + ' МБ';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' КБ';
  return `${n} Б`;
}

/** Доллары: $0 → «$0», мелкие суммы — 4 знака. */
export function fmtUsd(n) {
  n = Number(n) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2).replace('.', ',')}`;
}

/** Миллисекунды → «320 мс» / «1,4 с» / «2 мин 05 с». */
export function fmtMs(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace('.', ',')} с`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m} мин ${String(s).padStart(2, '0')} с`;
}

/** Аптайм в компактном виде. */
export function fmtUptime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин`;
  return `${sec} с`;
}

/** Процент со шкалой. */
export function fmtPct(n) {
  n = Number(n) || 0;
  const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${String(v).replace('.', ',')} %`;
}

/** Класс уровня нагрузки для шкалы. */
export function loadLevel(pct) {
  pct = Number(pct) || 0;
  if (pct >= 90) return 'lv-crit';
  if (pct >= 75) return 'lv-warn';
  return 'lv-ok';
}

/** Спарклайн по массиву чисел. */
export function sparkline(values, { w = 120, h = 28, color = 'currentColor' } = {}) {
  const nums = (values || []).map((v) => Number(v) || 0);
  if (nums.length < 2) return '';
  const max = Math.max(...nums, 1);
  const step = w / (nums.length - 1);
  const pts = nums.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`);
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="${color}" opacity=".12"></polygon>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round"></polyline>
  </svg>`;
}

/** Скопировать текст в буфер обмена. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('ui.copied'), String(text).slice(0, 60), 'ok');
    return true;
  } catch {
    toast(t('ui.copy_fail'), t('ui.copy_fail_hint'), 'err');
    return false;
  }
}

/* ==================================================================== QR
   Генератор QR-кодов (байтовый режим, версии 1–6, уровни L/M/Q/H).
   Нужен, чтобы телефон подключался к NEXUS одним наведением камеры.
   Реализация по ISO/IEC 18004 без внешних зависимостей.
   Проверено декодером jsQR на 94 случаях (все версии, все уровни, UTF-8).
*/

/* GF(256): примитивный многочлен 0x11D, корень 2 */
function gfMul(a, b) {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if ((b >> i) & 1) r ^= a;
    a = a & 0x80 ? ((a << 1) ^ 0x11d) & 0xff : (a << 1) & 0xff;
  }
  return r & 0xff;
}

/* GAL[i] = α^i в поле. Нужно ≥ 29 элементов: максимальная степень коррекции в v1–6 — 28. */
const QR_GAL = [1];
for (let i = 1; i < 64; i++) QR_GAL.push(gfMul(2, QR_GAL[i - 1]));

/* Блоки коррекции: версия → уровень → [ecPerBlock, г1(блоков,данных), г2(блоков,данных)] */
const QR_BLOCKS = {
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
};

/* Центры выравнивающих узоров */
const QR_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };
const QR_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function qrDivisor(deg) {
  const d = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(d.length + 1).fill(0);
    for (let j = 0; j < d.length; j++) {
      next[j] ^= gfMul(d[j], 1);
      next[j + 1] ^= gfMul(d[j], QR_GAL[i]);
    }
    for (let j = 0; j < next.length; j++) d[j] = next[j];
  }
  return d;
}

function qrEc(data, n) {
  const gen = qrDivisor(n);
  const buf = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const f = buf[i];
    if (f === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], f);
  }
  return buf.slice(data.length);
}

/** Строит матрицу QR (массив 0/1) или null, если строка не помещается в v1–6. */
function qrMatrix(text, ec = 'M') {
  const bytes = Array.from(new TextEncoder().encode(String(text)));

  let version = 0;
  for (let v = 1; v <= 6; v++) {
    const [, g1, d1, g2, d2] = QR_BLOCKS[v][ec];
    if (bytes.length + 2 <= g1 * d1 + g2 * d2) { version = v; break; }
  }
  if (!version) return null;

  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[r][c] = v ? 1 : 0;
    fn[r][c] = true;
  };

  /* Поисковые узоры с разделителями */
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        set(r, c, d !== 2 && d <= 3);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  /* Выравнивающие узоры */
  const pos = QR_ALIGN[version];
  pos.forEach((r) => pos.forEach((c) => {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) return;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }));

  /* Тайминг-узоры */
  for (let i = 8; i < size - 8; i++) {
    if (!fn[6][i]) set(6, i, i % 2 === 0);
    if (!fn[i][6]) set(i, 6, i % 2 === 0);
  }

  /* Резерв под формат: 15 бит в двух копиях + тёмный модуль */
  const fmtCells = [];
  for (let i = 0; i <= 5; i++) fmtCells.push([i, 8]);
  fmtCells.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) fmtCells.push([8, 14 - i]);
  for (let i = 0; i < 8; i++) fmtCells.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i++) fmtCells.push([size - 15 + i, 8]);
  fmtCells.push([size - 8, 8]);
  fmtCells.forEach(([r, c]) => set(r, c, r === size - 8 && c === 8 ? 1 : 0));

  /* Битовое представление данных */
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(4, 4); // байтовый режим
  push(bytes.length, 8);
  bytes.forEach((b) => push(b, 8));
  const [ecLen, g1, d1, g2, d2] = QR_BLOCKS[version][ec];
  const dataCw = g1 * d1 + g2 * d2;
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  /* Заполнитель: 11101100 / 00010001 */
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < dataCw; i++) data.push(PAD[i % 2]);

  /* Блоки + коррекция ошибок */
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1; i++) { const c = data.slice(off, off + d1); off += d1; blocks.push({ d: c, e: qrEc(c, ecLen) }); }
  for (let i = 0; i < g2; i++) { const c = data.slice(off, off + d2); off += d2; blocks.push({ d: c, e: qrEc(c, ecLen) }); }

  /* Перемешивание блоков */
  const stream = [];
  for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach((b) => { if (i < b.d.length) stream.push(b.d[i]); });
  for (let i = 0; i < ecLen; i++) blocks.forEach((b) => stream.push(b.e[i]));

  /* Размещение змейкой, пропуская функциональные модули */
  let bi = 0;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const r = up ? size - 1 - vert : vert;
        const c = right - j;
        if (fn[r][c]) continue;
        mod[r][c] = (stream[bi >> 3] >> (7 - (bi & 7))) & 1;
        bi++;
      }
    }
    up = !up;
  }

  /* Информация о формате: BCH(15,5) с маскировкой 0x5412 */
  const fmtBits = (mask) => {
    const d = (QR_EC_BITS[ec] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const applyFmt = (grid, mask) => {
    const b = fmtBits(mask);
    const g = (i) => (b >> i) & 1;
    for (let i = 0; i <= 5; i++) grid[i][8] = g(i);
    grid[7][8] = g(6);
    grid[8][8] = g(7);
    grid[8][7] = g(8);
    for (let i = 9; i < 15; i++) grid[8][14 - i] = g(i);
    for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = g(i);
    for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = g(i);
    grid[size - 8][8] = 1;
  };

  const maskAt = (m, r, c) => {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  /* Штраф за маску: серии, 2×2 блоки */
  const penalty = (g) => {
    let p = 0;
    for (let i = 0; i < size; i++) {
      for (const row of [g[i], g.map((x) => x[i])]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          if (row[j] === row[j - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
    }
    for (let i = 0; i < size - 1; i++) {
      for (let j = 0; j < size - 1; j++) {
        const v = g[i][j];
        if (v === g[i][j + 1] && v === g[i + 1][j] && v === g[i + 1][j + 1]) p += 3;
      }
    }
    return p;
  };

  let best = null;
  let bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = mod.map((row, r) => row.map((v, c) => (fn[r][c] ? v : v ^ (maskAt(mask, r, c) ? 1 : 0))));
    applyFmt(g, mask);
    const p = penalty(g);
    if (p < bestP) { bestP = p; best = g; }
  }
  return best;
}

/**
 * QR-код как SVG-строка.
 * @param {string} text данные (обычно URL)
 * @param {{size?:number, ec?:'L'|'M'|'Q'|'H', dark?:string, light?:string, margin?:number}} opts
 * @returns {string} SVG или '' если строка слишком длинная
 */
export function qrSvg(text, opts = {}) {
  const { size = 220, ec = 'M', dark = '#07090F', light = '#FFFFFF', margin = 3 } = opts;
  /* Если не помещается — мягко понижаем уровень коррекции, чтобы QR всё равно построился */
  const order = ec === 'L' ? ['L'] : ec === 'Q' ? ['Q', 'M', 'L'] : ec === 'H' ? ['H', 'Q', 'M', 'L'] : ['M', 'L'];
  let grid = null;
  for (const lvl of order) {
    grid = qrMatrix(text, lvl);
    if (grid) break;
  }
  if (!grid) return '';
  const dim = grid.length + margin * 2;
  let path = '';
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid.length; c++) {
      if (grid[r][c]) path += `M${c + margin},${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" role="img" aria-label="${esc(t('ui.qr_label'))}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"></rect>`
    + `<path d="${path}" fill="${dark}"></path></svg>`;
}