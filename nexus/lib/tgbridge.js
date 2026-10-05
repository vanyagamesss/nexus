'use strict';

/**
 * NEXUS — мост Telegram → команда.
 *
 * Пользователь вводит токен своего бота (@BotFather) в разделе «Сервисы»,
 * затем здесь включает «Telegram-пульт» и указывает, какие чаты могут давать
 * задачи (allowlist chat ID) и кто выполняет (вся команда или один агент).
 * Сервер опрашивает getUpdates, входящие сообщения становятся задачами,
 * ответы агентов возвращаются в тот же чат.
 *
 * Безопасность:
 *   • без allowlist мост не включается — чужой чат получит тишину, не задачу;
 *   • токен хранится только зашифрованным в services.json, наружу не отдаётся;
 *   • задачи выполняются через тот же agentRuntime.run, что и UI-запуски,
 *     с записью в журнал прогонов и события команды.
 */

const store = require('./store');
const integrations = require('./integrations');
const agentRuntime = require('./agent');
const metrics = require('./metrics');

const POLL_MS = 5000;
const MAX_CHATS = 20;
const REPLY_LIMIT = 3900;

let chain = Promise.resolve();
let polling = false;
/* Последний опрос для диагностики в UI: когда был и чем кончился */
let lastPoll = { at: 0, ok: null, error: '' };

/* ------------------------------------------------------- конфигурация */

function defaults() {
  return { enabled: false, serviceId: null, chatIds: [], targetAgentId: null, lastUpdateId: 0 };
}

function getBridge() {
  const cfg = store.read('config.json', {});
  const b = (cfg && cfg.telegramBridge) || {};
  const d = defaults();
  return {
    enabled: b.enabled === true,
    serviceId: typeof b.serviceId === 'string' ? b.serviceId : null,
    chatIds: Array.isArray(b.chatIds) ? b.chatIds.map(String).filter(Boolean).slice(0, MAX_CHATS) : [],
    targetAgentId: typeof b.targetAgentId === 'string' ? b.targetAgentId : null,
    lastUpdateId: Number(b.lastUpdateId) || 0,
  };
}

function writeBridge(next) {
  const cfg = store.read('config.json', {});
  cfg.telegramBridge = next;
  store.write('config.json', cfg);
  return next;
}

/** Telegram-сервис для моста: указанный или первый подключённый. */
function tgService(serviceId) {
  const list = store.read('services.json', []);
  const isTg = (s) => (s.integrationId || s.id) === 'telegram';
  const svc = serviceId
    ? list.find((s) => s.id === serviceId && isTg(s))
    : list.find((s) => isTg(s) && s.lastCheckOk === true) || list.find(isTg);
  if (!svc) return { error: 'Подключите Telegram: Подключения → Сервисы → Telegram → вставьте токен бота' };
  const key = store.decrypt(svc.keyCipher || '');
  if (!key) return { error: 'У Telegram-сервиса нет ключа' };
  return { svc, key };
}

function telegramServices() {
  return store.read('services.json', [])
    .filter((s) => (s.integrationId || s.id) === 'telegram')
    .map((s) => ({ id: s.id, name: s.name, status: s.status, hasKey: !!store.decrypt(s.keyCipher || '') }));
}

function teamAgents() {
  const data = store.read('team.json', { agents: [] });
  return (data.agents || []).map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status }));
}

/* ------------------------------------------------------------- отправка */

async function tgSend(key, chatId, text, keyboard) {
  const body = String(text === undefined || text === null ? '' : text) || '—';
  const parts = [];
  for (let i = 0; i < body.length; i += REPLY_LIMIT) parts.push(body.slice(i, i + REPLY_LIMIT));
  const markup = keyboard === false ? { remove_keyboard: true } : {
    keyboard: [[{ text: 'Статус' }, { text: 'Агенты' }], [{ text: 'Расписание' }, { text: 'Помощь' }]],
    resize_keyboard: true,
  };
  let last = null;
  for (const chunk of parts.length ? parts : ['—']) {
    last = await integrations.runAction('telegram', 'sendMessage', { apiKey: key }, { chat_id: String(chatId), text: chunk, reply_markup: markup });
    if (!last.ok) return last;
  }
  return last || { ok: true };
}

const HELP_TG = 'NEXUS на связи. Напиши задачу текстом — команда посовещается и пришлёт итог.\n'
  + '@Имя — поручить конкретному агенту (например: @Архимед проверь код)\n'
  + '/status — состояние · /agents — состав · /schedule — расписание · /menu — это меню';

/* -------------------------------------------------------- опрос входящих */

async function tick() {
  if (polling) return;
  const b = getBridge();
  if (!b.enabled) return;
  const t = tgService(b.serviceId);
  if (!t.svc) return; /* сервис удалён — молча ждём настройки */
  polling = true;
  try {
    const args = { limit: '20' };
    if (b.lastUpdateId) args.offset = String(b.lastUpdateId + 1);
    const out = await integrations.runAction('telegram', 'getUpdates', { apiKey: t.key }, args);
    if (!out.ok) {
      lastPoll = { at: Date.now(), ok: false, error: String(out.error || 'неизвестная ошибка').slice(0, 200) };
      return;
    }
    lastPoll = { at: Date.now(), ok: true, error: '' };
    const updates = (out.result && out.result.result) || [];
    let maxId = b.lastUpdateId;
    for (const u of updates) {
      if (u.update_id > maxId) maxId = u.update_id;
      handleUpdate(u).catch(() => {});
    }
    if (maxId !== b.lastUpdateId) writeBridge({ ...getBridge(), lastUpdateId: maxId });
  } catch {
    /* сеть моргнула — попробуем на следующем тике */
    lastPoll = { at: Date.now(), ok: false, error: 'сеть недоступна' };
  } finally {
    polling = false;
  }
}

async function handleUpdate(u) {
  const b = getBridge();
  if (!b.enabled) return;
  const msg = u.message || u.edited_message;
  if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return;
  if (msg.from && msg.from.is_bot) return;
  const chatId = String(msg.chat.id);
  if (!b.chatIds.includes(chatId)) return; /* чужой чат — тишина */

  const text = msg.text.trim().slice(0, 400);
  const low = text.toLowerCase();
  const t = tgService(getBridge().serviceId);
  const send = (txt) => (t.svc ? tgSend(t.key, chatId, txt) : Promise.resolve());

  /* Кнопки меню прилетают обычным текстом — понимаем и команды, и русские подписи */
  if (/^\/start\b/i.test(text) || low === 'меню' || low === '/menu') {
    await send(HELP_TG);
    return;
  }
  if (/^\/help\b/i.test(text) || low === 'помощь') {
    await send(HELP_TG + '\nЗадачи — просто текстом. Чужие чаты игнорирую.');
    return;
  }
  if (/^\/status\b/i.test(text) || low === 'статус') {
    await send(statusText());
    return;
  }
  if (/^\/agents\b/i.test(text) || low === 'агенты') {
    await send(agentsText());
    return;
  }
  if (/^\/schedule\b/i.test(text) || low === 'расписание') {
    await send(scheduleText());
    return;
  }
  /* Обращение к конкретному агенту: «@Архимед проверь код» */
  const mention = /^@([^\s]+)\s+([\s\S]+)/.exec(text);
  if (mention) {
    const data = store.read('team.json', { agents: [] });
    const one = (data.agents || []).find((a) => a.name.toLowerCase() === mention[1].toLowerCase());
    if (!one) {
      await send(`Не знаю агента «${mention[1]}». Состав: /agents. Или пишите без @ — решит вся команда.`);
      return;
    }
    enqueue(chatId, mention[2].trim().slice(0, 400), one.id);
    return;
  }
  enqueue(chatId, text);
}

function statusText() {
  const data = store.read('team.json', { team: {}, agents: [] });
  const online = (data.agents || []).filter((a) => a.status !== 'offline').length;
  const totals = metrics.stats().totals;
  return `NEXUS · в сети ${online} из ${(data.agents || []).length} · задач: ${totals.ok}/${totals.runs} · токенов: ${totals.totalTokens}`;
}

function agentsText() {
  const data = store.read('team.json', { team: {}, agents: [] });
  const list = data.agents || [];
  if (!list.length) return 'Команда пуста.';
  return `Команда «${(data.team || {}).name || ''}»:\n` + list
    .map((a) => `${a.status === 'offline' ? '⚫' : '🟢'} ${a.avatar || '🤖'} ${a.name} — ${a.role}`)
    .join('\n');
}

function scheduleText() {
  let list = [];
  try {
    list = require('./schedule').list().filter((s) => s.enabled);
  } catch { list = []; }
  if (!list.length) return 'Расписание пусто.';
  return 'Расписание:\n' + list
    .map((s) => `• ${s.kind === 'every' ? `каждые ${s.everyMin} мин` : `в ${s.at}`} — «${String(s.task).slice(0, 60)}»`)
    .join('\n');
}

/** Очередь задач: не запускаем параллельно, чтобы не рвать статусы агентов. */
function enqueue(chatId, text, forcedAgentId) {
  chain = chain.then(() => processTask(chatId, text, forcedAgentId)).catch(() => {});
}

async function processTask(chatId, text, forcedAgentId) {
  const b = getBridge();
  const t = tgService(b.serviceId);
  if (!t.svc) return;
  await tgSend(t.key, chatId, `Принято: «${text.slice(0, 120)}». Выполняю…`);

  const data = store.read('team.json', { team: {}, agents: [] });
  const agents = data.agents || [];
  let targets = agents.filter((a) => a.status !== 'offline');
  const effectiveTarget = forcedAgentId || b.targetAgentId;
  if (effectiveTarget) {
    const one = agents.find((a) => a.id === effectiveTarget);
    if (!one) {
      await tgSend(t.key, chatId, 'Назначенный агент не найден — проверьте настройки моста.');
      return;
    }
    if (one.status === 'offline') {
      await tgSend(t.key, chatId, `${one.avatar || '🤖'} ${one.name} офлайн — включите его или выберите другого исполнителя.`);
      return;
    }
    targets = [one];
  }
  if (!targets.length) {
    await tgSend(t.key, chatId, 'Некому выполнять: все агенты офлайн.');
    return;
  }

  /* Без назначенного исполнителя команда совещается цепочкой: переговоры
     видны в ленте событий и консоли, в Telegram падает только общий итог. */
  const chainMode = !effectiveTarget && targets.length > 1;
  if (chainMode && targets.length > 5) targets = targets.slice(0, 5);
  let contextSoFar = '';
  if (chainMode) {
    await tgSend(t.key, chatId, `🗣️ Совещание команды: ${targets.map((a) => `${a.avatar || '🤖'} ${a.name}`).join(' → ')}. Итог пришлю сюда.`);
  }

  for (const a of targets) {
    const fresh = (store.read('team.json', { agents: [] }).agents || []).find((x) => x.id === a.id);
    if (!fresh || fresh.status === 'busy') {
      await tgSend(t.key, chatId, `${a.avatar || '🤖'} ${a.name} сейчас занят — пропускаю.`);
      continue;
    }
    if (chainMode) {
      /* Совещание: каждый следующий видит ответы предыдущих, в чат — только итог */
      const prev = contextSoFar.length
        ? `\n\nМнения коллег выше (дополни, а не повторяй):${contextSoFar}`
        : '';
      const outcome = await runOne(a.id, text + prev);
      if (outcome.failure) {
        await tgSend(t.key, chatId, `${a.avatar || '🤖'} ${a.name}: ошибка — ${outcome.failure.slice(0, 500)}`);
      } else {
        contextSoFar += `\n\n--- ${a.name}: ${(outcome.text || '').slice(0, 1500)}`;
      }
      continue;
    }
    const outcome = await runOne(a.id, text);
    if (outcome.failure) {
      await tgSend(t.key, chatId, `${a.avatar || '🤖'} ${a.name}: ошибка — ${outcome.failure.slice(0, 500)}`);
    } else {
      const answer = (outcome.text || 'Готово.').slice(0, REPLY_LIMIT);
      await tgSend(t.key, chatId, `${a.avatar || '🤖'} ${a.name}: ${answer}`);
    }
  }
  if (chainMode && contextSoFar) {
    const lastName = targets[targets.length - 1].name;
    const lastText = contextSoFar.split('--- ').pop() || '';
    await tgSend(t.key, chatId, `🏁 Итог команды (совещались: ${targets.map((a) => `${a.avatar || '🤖'} ${a.name}`).join(', ')}):\n${lastText.replace(/^[^:]+:\s*/, '').slice(0, REPLY_LIMIT - 100)}`);
    void lastName;
  }
}

/** Прогон одного агента с тем же учётом, что у UI-запусков. */
async function runOne(agentId, task) {
  const data = store.read('team.json', null);
  if (!data) return { failure: 'Файл команды повреждён' };
  const agent = (data.agents || []).find((x) => x.id === agentId);
  if (!agent) return { failure: 'Агент не найден' };
  const prevStatus = agent.status;
  agent.status = 'busy';
  agent.currentTask = String(task).slice(0, 140);
  agent.lastActive = new Date().toISOString();
  store.write('team.json', data);

  let outcome = null;
  let failure = null;
  const startedAt = Date.now();
  try {
    outcome = await agentRuntime.run({ agent, task, emit: () => {} });
  } catch (e) {
    failure = e;
  }
  const durationMs = Date.now() - startedAt;
  const usage = (outcome && outcome.usage) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  metrics.recordRun({
    agentId: agent.id,
    agentName: agent.name,
    task,
    status: failure ? 'failed' : 'ok',
    provider: outcome ? outcome.provider : '',
    model: outcome ? outcome.model : agent.model,
    usage,
    costUsd: outcome ? outcome.costUsd : 0,
    durationMs,
    ttftMs: outcome ? outcome.ttftMs : 0,
    steps: outcome ? outcome.steps : 0,
    toolCalls: outcome ? outcome.toolCalls : 0,
    error: failure ? failure.message : null,
    toolLog: outcome ? outcome.toolLog : [],
  });

  const fresh = store.read('team.json', null) || data;
  const a = (fresh.agents || []).find((x) => x.id === agentId);
  if (a) {
    a.status = prevStatus === 'offline' ? 'online' : prevStatus === 'busy' ? 'online' : prevStatus;
    a.currentTask = failure ? 'ошибка выполнения' : 'готов к задаче';
    a.lastActive = new Date().toISOString();
  }
  fresh.events = fresh.events || [];
  fresh.events.unshift({
    id: 'ev_' + require('crypto').randomBytes(4).toString('hex'),
    t: new Date().toISOString(),
    text: failure
      ? `${agent.name} (Telegram): ошибка — ${failure.message.slice(0, 120)}`
      : `${agent.name} (Telegram): «${task.slice(0, 60)}» за ${(durationMs / 1000).toFixed(1)} с · ${usage.totalTokens} токенов`,
    kind: failure ? 'warn' : 'ok',
  });
  fresh.events = fresh.events.slice(0, 60);
  try {
    const totals = metrics.stats().totals;
    fresh.team.tasksCompleted = Math.max(0, Math.round(totals.ok || 0));
    fresh.team.tokens = Math.max(0, Math.round(totals.totalTokens || 0));
  } catch { /* журнал недоступен — счётчики не трогаем */ }
  store.write('team.json', fresh);

  if (failure) return { failure: failure.message || String(failure) };
  return { text: outcome.text, usage };
}

/* ------------------------------------------------------ публичное API */

function getPublic() {
  const b = getBridge();
  return {
    enabled: b.enabled,
    serviceId: b.serviceId,
    chatIds: b.chatIds,
    targetAgentId: b.targetAgentId,
    lastPoll: lastPoll.at ? { at: lastPoll.at, ok: lastPoll.ok, error: lastPoll.error } : null,
    services: telegramServices(),
    agents: teamAgents(),
  };
}

function save(patch) {
  const cur = getBridge();
  const next = {
    enabled: patch.enabled === true,
    serviceId: typeof patch.serviceId === 'string' && patch.serviceId ? patch.serviceId : null,
    chatIds: Array.isArray(patch.chatIds)
      ? patch.chatIds.map((c) => String(c).trim()).filter(Boolean).slice(0, MAX_CHATS)
      : cur.chatIds,
    targetAgentId: typeof patch.targetAgentId === 'string' && patch.targetAgentId ? patch.targetAgentId : null,
    lastUpdateId: cur.lastUpdateId,
  };
  if (next.enabled) {
    const t = tgService(next.serviceId);
    if (!t.svc) throw new Error(t.error || 'Нет Telegram-сервиса');
    if (!next.chatIds.length) throw new Error('Укажите хотя бы один chat ID — иначе мост никому не ответит');
  }
  if (next.targetAgentId) {
    const ok = teamAgents().some((a) => a.id === next.targetAgentId);
    if (!ok) throw new Error('Выбранный исполнитель не найден в команде');
  }
  return writeBridge(next);
}

async function sendTest(chatId) {
  const b = getBridge();
  const t = tgService(b.serviceId);
  if (!t.svc) throw new Error(t.error || 'Нет Telegram-сервиса');
  const id = String(chatId || '').trim();
  if (!id) throw new Error('Укажите chat ID получателя');
  const out = await tgSend(t.key, id, 'NEXUS на связи. Этот чат может давать задачи команде.');
  if (!out.ok) throw new Error(out.error || 'Telegram отклонил сообщение');
  return { ok: true };
}

/** Последние чаты, писавшие боту, — чтобы узнать свой chat ID. */
async function recentChats() {
  const b = getBridge();
  const t = tgService(b.serviceId);
  if (!t.svc) throw new Error(t.error || 'Нет Telegram-сервиса');
  const out = await integrations.runAction('telegram', 'getUpdates', { apiKey: t.key }, { limit: '20' });
  if (!out.ok) throw new Error(out.error || 'Не удалось прочитать входящие');
  const seen = new Map();
  for (const u of (out.result && out.result.result) || []) {
    const msg = u.message || u.edited_message;
    if (!msg || !msg.chat) continue;
    const id = String(msg.chat.id);
    if (!seen.has(id)) {
      const from = msg.from || {};
      seen.set(id, {
        id,
        name: [from.first_name, from.last_name].filter(Boolean).join(' ') || msg.chat.title || msg.chat.username || id,
        allowed: getBridge().chatIds.includes(id),
      });
    }
  }
  return [...seen.values()].slice(0, 20);
}

module.exports = { getBridge, getPublic, save, sendTest, recentChats, tick, statusText, runOne };
