/* NEXUS — состояние приложения: загрузка, кэш, мутации через API */

import { api } from './api.js';

export const store = {
  loaded: false,
  offline: false,
  loadError: null,
  team: null,
  agents: [],
  events: [],
  services: [],
  programs: [],
  mcp: [],
  providers: [],
  catalog: [],
  integrations: [],
  metrics: null,
  rag: null,
  kb: [],
  access: null,
  session: null,
  net: null,
};

export const bus = new EventTarget();
export function emit(kind = 'team') {
  bus.dispatchEvent(new CustomEvent(kind));
}

const CACHE_KEY = 'nexus_cache_v1';

function snapshot() {
  return {
    team: store.team,
    agents: store.agents,
    events: store.events,
    services: store.services,
    programs: store.programs,
    mcp: store.mcp,
    savedAt: Date.now(),
  };
}

function cacheSave() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot())); } catch { /* приватный режим */ }
}

function apply(data) {
  store.team = data.team;
  store.agents = data.agents || [];
  store.events = data.events || [];
  if (data.services) store.services = data.services;
  if (data.programs) store.programs = data.programs;
  if (data.mcp) store.mcp = data.mcp;
  store.loaded = true;
}

/** Провайдеры, интеграции, метрики и параметры доступа — необязательны для отрисовки. */
export async function loadExtras() {
  const [providers, catalog, access, integrations] = await Promise.allSettled([
    api('/api/providers'),
    api('/api/providers/catalog'),
    api('/api/access'),
    api('/api/integrations'),
  ]);
  if (providers.status === 'fulfilled') store.providers = providers.value;
  if (catalog.status === 'fulfilled') {
    store.catalog = catalog.value.catalog || [];
    if (providers.status === 'rejected') store.providers = catalog.value.configured || [];
  }
  if (integrations.status === 'fulfilled') store.integrations = integrations.value.integrations || [];
  if (access.status === 'fulfilled') store.access = access.value;
  return store;
}

export async function refreshMetrics() {
  try {
    store.metrics = await api('/api/metrics');
    emit('metrics');
    return store.metrics;
  } catch {
    return null;
  }
}

/** Сводка базы знаний RAG для панели «База знаний». */
export async function refreshRag() {
  try {
    store.rag = await api('/api/rag/status');
    emit('rag');
    return store.rag;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- базы знаний */

export async function getKb() {
  try {
    store.kb = await api('/api/kb');
    emit('kb');
  } catch {
    store.kb = [];
  }
  return store.kb;
}

export async function saveKb(item) {
  store.kb = await api('/api/kb', { method: 'POST', body: { item } });
  cacheSave();
  emit('kb');
  return store.kb;
}

export async function removeKb(id) {
  store.kb = await api('/api/kb', { method: 'POST', body: { removeId: id } });
  cacheSave();
  emit('kb');
  return store.kb;
}

export async function searchKb(id, query) {
  return api('/api/kb/search', { method: 'POST', body: { id, query } });
}

export async function loadAll() {
  store.loadError = null;
  try {
    const [team, services, programs, mcp] = await Promise.all([
      api('/api/team'),
      api('/api/services'),
      api('/api/programs'),
      api('/api/mcp'),
    ]);
    apply({ ...team, services, programs, mcp });
    store.offline = false;
    cacheSave();
  } catch (e) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { /* пусто */ }
    if (cached && cached.team) {
      apply(cached);
      store.offline = true;
      store.loadError = e.message;
    } else {
      store.loadError = e.message;
      throw e;
    }
  }
  await loadExtras().catch(() => {});
  emit('all');
  return store;
}

export async function refreshTeam() {
  const d = await api('/api/team');
  store.team = d.team;
  store.agents = d.agents || [];
  store.events = d.events || [];
  cacheSave();
  emit('team');
  return d;
}

export async function refreshServices() {
  store.services = await api('/api/services');
  cacheSave();
  emit('services');
  return store.services;
}

export async function refreshPrograms() {
  store.programs = await api('/api/programs');
  cacheSave();
  emit('programs');
  return store.programs;
}

/* ------------------------------------------------------------- команда */

export async function saveTeam(patch) {
  const d = await api('/api/team', { method: 'POST', body: { team: patch } });
  store.team = d.team;
  store.agents = d.agents;
  store.events = d.events;
  cacheSave();
  emit('team');
  return d;
}

export async function saveAgent(agent) {
  const d = await api('/api/team', { method: 'POST', body: { agent } });
  store.team = d.team;
  store.agents = d.agents;
  store.events = d.events;
  cacheSave();
  emit('team');
  return d;
}

export async function removeAgent(id) {
  const d = await api('/api/team', { method: 'POST', body: { removeAgentId: id } });
  store.agents = d.agents;
  cacheSave();
  emit('team');
  return d;
}

export async function addEvent(text, kind = 'system') {
  const d = await api('/api/team', { method: 'POST', body: { event: { text, kind } } });
  store.events = d.events;
  cacheSave();
  emit('team');
  return d;
}

/** Атомарно заменяет состав команды: создание/пересборка в конструкторе. */
export async function createTeam({ team, agents, event }) {
  const d = await api('/api/team', { method: 'POST', body: { team, agents, event } });
  store.team = d.team;
  store.agents = d.agents;
  store.events = d.events;
  cacheSave();
  emit('team');
  return d;
}

/* ------------------------------------------------------------ ресурсы */

async function resource(path, item) {
  const d = await api(path, { method: 'POST', body: { item } });
  return d;
}

export async function saveService(item) {
  store.services = await resource('/api/services', item);
  cacheSave();
  emit('services');
  return store.services;
}

export async function removeService(id) {
  store.services = await api('/api/services', { method: 'POST', body: { removeId: id } });
  cacheSave();
  emit('services');
  return store.services;
}

export async function checkService(id) {
  const out = await api(`/api/services/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} });
  await refreshServices();
  return out;
}

/** Выполнить операцию сервиса (например, отправить сообщение в Telegram). */
export async function runServiceAction(id, action, args = {}) {
  return api(`/api/services/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action, args } });
}

/** Каталог доступных интеграций: что вводить и какие операции отдаются агенту. */
export async function loadIntegrations() {
  const out = await api('/api/integrations');
  store.integrations = out.integrations || [];
  cacheSave();
  return store.integrations;
}

/* ------------------------------------------------- мост Telegram → команда */

export async function getTgBridge() {
  return api('/api/telegram-bridge');
}

export async function saveTgBridge(body) {
  return api('/api/telegram-bridge', { method: 'POST', body });
}

export async function testTgBridge(chat_id) {
  return api('/api/telegram-bridge/test', { method: 'POST', body: { chat_id } });
}

export async function recentTgChats() {
  return api('/api/telegram-bridge/recent');
}

/* -------------------------------------------------------- планировщик */

export async function getSchedules() {
  return api('/api/schedules');
}

export async function saveSchedule(schedule) {
  return api('/api/schedules', { method: 'POST', body: { schedule } });
}

export async function removeSchedule(id) {
  return api('/api/schedules', { method: 'POST', body: { removeId: id } });
}

export async function toggleSchedule(id, enabled) {
  return api('/api/schedules', { method: 'POST', body: { toggleId: id, enabled } });
}

/* -------------------------------------------------------------- прогоны */

export async function getRuns() {
  return api('/api/runs');
}

export const getIntegration = (id) => (store.integrations || []).find((x) => x.id === id);

export async function saveProgram(item) {
  store.programs = await resource('/api/programs', item);
  cacheSave();
  emit('programs');
  return store.programs;
}

export async function removeProgram(id) {
  store.programs = await api('/api/programs', { method: 'POST', body: { removeId: id } });
  cacheSave();
  emit('programs');
  return store.programs;
}

export async function saveMcp(item) {
  store.mcp = await resource('/api/mcp', item);
  cacheSave();
  emit('mcp');
  return store.mcp;
}

export async function removeMcp(id) {
  store.mcp = await api('/api/mcp', { method: 'POST', body: { removeId: id } });
  cacheSave();
  emit('mcp');
  return store.mcp;
}

export async function reconnectMcp(id) {
    const updated = await api(`/api/mcp/${encodeURIComponent(id)}/reconnect`, { method: 'POST', body: {} });
    store.mcp = store.mcp.map((m) => (m.id === id ? Object.assign({}, m, updated) : m));
    emit('mcp');
    return updated;
  }

/** Проверка MCP-сервера до сохранения: настоящий handshake, ничего не меняет на диске. */
export async function testMcp(draft) {
    return api('/api/mcp/test', { method: 'POST', body: draft });
  }

/** Реальная проверка MCP: handshake + список tools с сервера. */
export async function probeMcp(id) {
  const out = await api(`/api/mcp/${encodeURIComponent(id)}/probe`, { method: 'POST', body: {} });
  store.mcp = store.mcp.map((m) =>
    m.id === id ? Object.assign({}, m, { status: out.ok ? 'connected' : 'error', tools: out.tools || [], log: out.log || [] }) : m,
  );
  emit('mcp');
  return out;
}

export async function probeAllMcp() {
  const out = await api('/api/mcp/probe-all', { method: 'POST', body: {} });
  await refreshMcp();
  return out;
}

export async function refreshMcp() {
  store.mcp = await api('/api/mcp');
  emit('mcp');
  return store.mcp;
}

/* --------------------------------------------------- провайдеры LLM */

export async function saveProvider(entry) {
  const d = await api('/api/providers', { method: 'POST', body: entry });
  store.providers = d.providers;
  emit('providers');
  return d;
}

export async function removeProvider(id) {
  store.providers = await api('/api/providers', { method: 'POST', body: { removeId: id } });
  emit('providers');
  return store.providers;
}

/** Реальная проверка соединения + подтягивание живого списка моделей. */
export async function probeProvider(id) {
  const out = await api(`/api/providers/${encodeURIComponent(id)}/probe`, { method: 'POST', body: {} });
  await refreshProviders();
  return out;
}

export async function refreshProviders() {
  store.providers = await api('/api/providers');
  emit('providers');
  return store.providers;
}

/* ------------------------------------------------------ доступ и PIN */

export async function refreshAccess() {
  store.access = await api('/api/access');
  emit('access');
  return store.access;
}

export async function refreshSession() {
  store.session = await api('/api/access/session');
  return store.session;
}

export async function login(payload) {
  const out = await api('/api/access/login', { method: 'POST', body: payload });
  await refreshSession();
  return out;
}

export async function logout() {
  await api('/api/access/logout', { method: 'POST', body: {} });
  await refreshSession();
}

export async function setPin(pin) {
  return api('/api/access/pin', { method: 'POST', body: { pin } });
}

export async function clearPin() {
  const out = await api('/api/access/pin/clear', { method: 'POST', body: {} });
  await refreshAccess();
  return out;
}

export async function saveAccess(patch) {
  const out = await api('/api/access/mode', { method: 'POST', body: patch });
  store.access = Object.assign({}, store.access, out);
  emit('access');
  return out;
}

export async function createInvite(ttlMin = 30) {
  const out = await api('/api/access/invite', { method: 'POST', body: { ttlMin } });
  await refreshAccess();
  return out;
}

export async function revokeInvites() {
  await api('/api/access/invite/revoke', { method: 'POST', body: {} });
  await refreshAccess();
}

export async function refreshNet() {
  store.net = await api('/api/net');
  emit('net');
  return store.net;
}

/* ------------------------------------------------------------- поиск */

export const getAgent = (id) => store.agents.find((a) => a.id === id);
export const getService = (id) => store.services.find((s) => s.id === id);
export const getProgram = (id) => store.programs.find((p) => p.id === id);
export const getMcp = (id) => store.mcp.find((m) => m.id === id);

export function markLocalBusy(agentId, task) {
  const a = getAgent(agentId);
  if (!a) return;
  a.status = 'busy';
  a.currentTask = task;
  emit('team');
}
