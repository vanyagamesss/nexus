/* NEXUS — «Пульт»: чат управления командой, задачами и подключениями.
 *
 * Идея: один экран как мессенджер. Обычный текст — это задача выбранному
 * получателю (вся команда или конкретный агент). Команды со слэшем — быстрые
 * действия: собрать группу, создать команду, открыть подключения, показать статус.
 * Всё выполняется через те же API, что и остальные разделы: runAgent/runTeam,
 * createTeam, разделы подключений. Никакой магии: бот пульта честно говорит,
 * что он делает.
 */

import {
  esc, icon, toast, confirmDialog, openModal, ROLES, roleMeta, DEFAULT_TASKS, agentAvatar,
  toggleTheme, getTheme, reducedMotion, fmtTime,
} from './ui.js';
import { api } from './api.js';
import {
  store, bus, createTeam, saveAgent,
  getSchedules, saveSchedule, removeSchedule, getRuns,
} from './store.js';
import { runAgent, runTeam } from './console.js';

const CHAT_KEY = 'nexus_chat_v1';

const HELP_TEXT = `Пишите задачу обычным текстом — выполнит выбранный получатель выше.
Команды:
/вместе — выбирать нескольких агентов для одной задачи
Несколько исполнителей всегда идут цепочкой: дополняют друг друга, итог один.
/цепочка <задача> — то же самое явно, переговоры в консоли
/команда Имя | Миссия | роли — создать команду (роли: dev research editor analyst devops assistant tester designer pm marketer translator mentor)
/компания — целая ИИ-компания из 9 агентов с аватарами в один клик
/подключить — что и где подключить: модели, соцсети, ПК, MCP
/телеграм — управление командой из Telegram
/пин — где сменить код входа
/повтори — выполнить последнюю задачу ещё раз
/исследуй <тема> — глубокое исследование: волны поиска, первоисточники, отчёт в файл
/открой <программа> — запустить программу на ПК
/браузер — показать окно браузера команды
/агенты — кто в команде и в каком статусе
/экспорт — скачать переписку файлом
/найти <текст> — найти сообщение в переписке
/заметка <текст> — дописать в notes/заметки.md
/пауза <имя> / /включи <имя> — выключить/включить агента
/каждый 30м <задача> — повторять по расписанию
/в 09:00 <задача> — каждый день в это время
/расписание — что запланировано, /отмена <id> — убрать
/статистика — цифры: задачи, токены, расходы
/очистить — стереть переписку на этом устройстве
/статус — кто в сети и что подключено
/помощь — это сообщение`;

const ROLE_BY_WORD = (() => {
  const m = new Map();
  for (const r of ROLES) {
    m.set(r.key.toLowerCase(), r.key);
    m.set(r.name.toLowerCase(), r.key);
  }
  return m;
})();

function activeProviders() {
  return (store.providers || []).filter((p) => p.enabled !== false);
}

function defaultProvider() {
  const list = activeProviders().filter((p) => Array.isArray(p.models) && p.models.length);
  return list.find((p) => p.isDefault) || list[0] || null;
}

function statusSummary() {
  const online = store.agents.filter((a) => a.status !== 'offline').length;
  const svc = store.services.filter((s) => s.status === 'connected').length;
  const mcp = store.mcp.filter((m) => m.status === 'connected').length;
  const t = store.team || {};
  return `В сети ${online} из ${store.agents.length} агентов · `
    + `сервисы ${svc}/${store.services.length} · MCP ${mcp}/${store.mcp.length} · `
    + `программ ПК ${store.programs.length} · задач выполнено ${t.tasksCompleted || 0}`;
}

function connectCard() {
  return `Подключения — раздел <a href="#/connect">Подключения</a>:
• <b>Модели</b> — ключ OpenAI/OpenRouter/совместимого API, затем выбор моделей
• <b>Соцсети и сервисы</b> — Telegram, Slack, Discord, Notion, GitHub, Google Drive
• <b>ПК</b> — программы, которые агенты могут запускать (в режиме «полный доступ» — любые разрешённые)
• <b>Свой MCP</b> — ваш сервер с tools: имя, транспорт, команда или URL, кнопка «Проверить»
• <b>Доступ</b> — PIN и QR, чтобы этот пульт работал с телефона
Instagram и TikTok не имеют официальных API для управления: их подключают через свой MCP-сервер или сервис Webhook / HTTP с вашим ключом.`;
}

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page ctl';
  container.appendChild(page);

  /* ---------------------------------------------------------- состояние */

  let sel = { kind: 'team', ids: [] }; // получатель задачи
  let multiMode = false;
  let sending = false;
  let runCtrl = null;

  let messages = [];
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    if (Array.isArray(raw)) messages = raw.slice(-60);
  } catch { messages = []; }

  const save = () => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-60)));
    } catch { /* приватный режим */ }
  };

  /* ---------------------------------------------------------- разметка */

  page.innerHTML = `
    <section class="ctl-head">
      <div class="ctl-bot">${icon('bot')}</div>
      <div class="ctl-title">
        <h2>Пульт</h2>
        <span class="ctl-status" id="ctlStatus">подключение…</span>
      </div>
      <a class="icon-btn" href="#/team" aria-label="Открыть команду">${icon('users')}</a>
      <button class="icon-btn" id="ctlBrowser" aria-label="Показать браузер команды" title="Браузер команды">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" x2="12" y1="8" y2="8"/><line x1="3.95" x2="8.54" y1="6.06" y2="14"/><line x1="10.88" x2="15.46" y1="21.94" y2="14"/></svg>
        <i class="dot" id="ctlBrowserDot"></i>
      </button>
      <button class="icon-btn" id="ctlNew" aria-label="Новый чат" title="Новый чат">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="icon-btn" id="ctlRegen" aria-label="Повторить последнюю задачу" title="Повторить последнюю задачу">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>
      </button>
      <button class="icon-btn" id="ctlClear" aria-label="Очистить переписку">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      <button class="icon-btn theme-btn" id="ctlTheme" aria-label="Переключить тему оформления">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <button class="icon-btn" id="ctlVoice" aria-label="Озвучивать ответы" aria-pressed="false" title="Озвучивать ответы">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>
      </button>
      <button class="icon-btn" id="ctlSearchBtn" aria-label="Поиск по переписке" title="Поиск по переписке ( /найти )">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
      <button class="icon-btn" id="ctlFocus" aria-label="Фокус-режим чата" title="Фокус-режим: чат на весь экран">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
    </section>

    <div class="chat-search" id="chatSearch" hidden>
      <input class="input" id="searchInput" placeholder="Поиск по переписке…" aria-label="Поиск по переписке">
      <span class="search-count mono" id="searchCount"></span>
      <button class="icon-btn" id="searchPrev" aria-label="Предыдущее">↑</button>
      <button class="icon-btn" id="searchNext" aria-label="Следующее">↓</button>
    </div>

    <div class="ctl-to" id="ctlTo" role="group" aria-label="Получатель задачи"></div>

    <div class="chat" id="chatThread" role="log" aria-label="Переписка пульта"></div>

    <div class="ctl-quick" id="ctlQuick" aria-label="Быстрые действия"></div>

    <div class="ai-bar" id="aiBar" aria-label="ИИ-помощники"></div>

    <div class="attach-row" id="attachRow" hidden></div>

    <div class="slash-pop">
      <div class="slash-list" id="slashList" hidden role="listbox" aria-label="Команды"></div>
    </div>

    <form class="composer" id="composer" autocomplete="off">
      <textarea class="input" id="chatInput" placeholder="Задача команде…  (Enter — отправить · Shift+Enter — новая строка)" maxlength="2000" rows="1"
        aria-label="Сообщение пульту" enterkeyhint="send"></textarea>
      <span class="char-count mono" id="charCount">0/2000</span>
      <input type="file" id="chatFiles" multiple hidden>
      <button class="icon-btn composer-attach" id="chatAttach" type="button" aria-label="Прикрепить файлы">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button class="icon-btn composer-mic" id="chatMic" type="button" aria-label="Голосовой ввод" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
      </button>
      <button class="btn btn-primary composer-send" id="chatSend" type="submit" aria-label="Отправить">${icon('send')}</button>
      <button class="btn composer-stop" id="chatStop" type="button" aria-label="Остановить генерацию" hidden>■</button>
    </form>`;

  const thread = page.querySelector('#chatThread');
  const toBar = page.querySelector('#ctlTo');
  const quick = page.querySelector('#ctlQuick');
  const form = page.querySelector('#composer');
  const input = page.querySelector('#chatInput');
  const statusEl = page.querySelector('#ctlStatus');
  const sendBtn = page.querySelector('#chatSend');
  const stopBtn = page.querySelector('#chatStop');
  function paintSend() {
    const run = !!sending;
    sendBtn.hidden = run;
    stopBtn.hidden = !run;
  }
  stopBtn.addEventListener('click', () => {
    if (runCtrl) {
      try { runCtrl.abort(); } catch { /* игнор */ }
      toast('Останавливаю', 'Прерываю генерацию…', 'warn');
    }
  });

  const QUICK = [
    { id: 'task', label: 'Дать задачу', ic: 'message' },
    { id: 'together', label: 'Собрать вместе', ic: 'users' },
    { id: 'chain', label: 'Цепочка', ic: 'gitBranch' },
    { id: 'team', label: 'Новая команда', ic: 'plus' },
    { id: 'connect', label: 'Подключить', ic: 'link' },
    { id: 'mcp', label: 'Мой MCP', ic: 'layers' },
    { id: 'browser', label: 'Браузер', ic: 'appWindow' },
    { id: 'pc', label: 'ПК', ic: 'appWindow' },
    { id: 'social', label: 'Соцсети', ic: 'megaphone' },
  ];

  /* ------------------------------------------------------------ рендер */

  function nearBottom() {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
  }

  function scrollDown(force) {
    /* Не дёргаем ленту, если человек читает историю выше */
    requestAnimationFrame(() => {
      if (force || nearBottom()) thread.scrollTop = thread.scrollHeight;
    });
  }

  function bubbleHTML(m, idx) {
    const mid = idx == null ? '' : ` data-mid="${idx}"`;
    if (m.from === 'me') {
      const thumbs = (Array.isArray(m.images) ? m.images : [])
        .map((p) => `<a href="/api/files?path=${encodeURIComponent(p)}" target="_blank" rel="noopener"><img class="attach-img" src="/api/files?path=${encodeURIComponent(p)}" alt="${esc(String(p).split('/').pop())}" loading="lazy"></a>`).join('');
      return `<div class="msg me"${mid}><div class="bubble">${thumbs ? `<div class="attach-thumbs">${thumbs}</div>` : ''}${esc(m.text)}<div class="msg-actions"><button class="mini-btn" data-act="resend">↻ повторить</button><button class="mini-btn" data-act="edit">✎ править</button><button class="mini-btn" data-act="copy">копировать</button></div></div></div>`;
    }
    if (m.from === 'img') {
      return `<div class="msg agent"${mid}><span class="agent-dot lv-info"></span><div><div class="agent-name">${esc(m.name || 'экран')}</div>`
        + `<div class="bubble"><a href="/api/shots/${esc(m.shot)}" target="_blank" rel="noopener"><img class="shot-img" src="/api/shots/${esc(m.shot)}" alt="Скриншот браузера" loading="lazy"></a></div></div></div>`;
    }
    if (m.from === 'agent') {
      const lv = m.level === 'err' ? 'err' : m.level === 'ok' ? 'ok' : m.level === 'warn' ? 'warn' : 'info';
      const av = agentAvatar(store.agents.find((a) => a.name === m.name) || {});
      return `<div class="msg agent"${mid}><span class="agent-dot lv-${lv}"></span><div><div class="agent-name">${esc(av)} ${esc(m.name || 'агент')}<button class="mini-link" data-copy-answer>копировать</button><span class="msg-time">${m.t ? esc(fmtTime(m.t)) : ''}</span></div><div class="bubble">${richText(m.text)}<div class="msg-actions"><button class="mini-btn" data-act="copy">копировать</button><button class="mini-btn" data-act="speak">▶ озвучить</button><button class="mini-btn" data-act="short">сжать</button><button class="mini-btn" data-act="resend-agent">↻ ещё раз</button></div></div></div></div>`;
    }
    /* bot / sys: разрешаем ссылки из наших подсказок, остальное экранируем */
    const safe = esc(m.text).replace(/&lt;a href=&quot;([^&]*)&quot;&gt;(.*?)&lt;\/a&gt;/g, '<a href="$1">$2</a>');
    return `<div class="msg ${m.from === 'sys' ? 'sys' : 'bot'}"${mid}><div class="bubble">${safe}</div></div>`;
  }

  function heroHTML() {
    const sug = [
      ['Разобрать задачу', 'Разбери задачу по шагам и предложи план: '],
      ['Проверить код', 'Проверь код, найди ошибки и предложи исправления: '],
      ['Исследовать тему', 'Собери сводку по теме с фактами и выводами: '],
      ['Написать текст', 'Напиши грамотный текст по черновику: '],
    ];
    return `<div class="gpt-hero">
      <div class="gpt-hero-mark">${icon('bot')}</div>
      <h2>Чем помочь?</h2>
      <p class="gpt-hero-sub">${esc(statusSummary())}</p>
      <div class="gpt-sug">${sug.map((s, i) => `<button class="gpt-sug-card" data-sug="${i}"><b>${esc(s[0])}</b></button>`).join('')}</div>
    </div>`;
  }

  function renderThread() {
    if (!messages.length) {
      thread.innerHTML = heroHTML();
      return;
    }
    thread.innerHTML = messages.map((m, i) => bubbleHTML(m, i)).join('');
    scrollDown(true);
  }

  function push(m) {
    messages.push({ ...m, t: Date.now() });
    if (messages.length > 120) messages = messages.slice(-120);
    save();
    /* Индекс может съехать после обрезки — перерисовываем ленту целиком */
    renderThread();
  }

  const bot = (text) => push({ from: 'bot', text });
  const sys = (text) => push({ from: 'sys', text });
  const welcome = () => bot(`Это пульт NEXUS. ${statusSummary()}. Напишите задачу — выполнит вся команда. Чтобы выбрать агентов, нажмите на них выше.`);

  /* Длинные ответы сворачиваем, блоки кода — с кнопкой «В файл» */
  const COLLAPSE_AT = 600;

  /** Строчная разметка поверх уже экранированного текста */
  function mdInline(escaped) {
    let h = escaped;
    h = h.replace(/\[([^\]]+)\]\((#[^)\s]*|https?:[^)\s]*)\)/g, '<a href="$2">$1</a>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    h = h.replace(/`([^`\n]+)`/g, '<code class="ic">$1</code>');
    return h;
  }

  /** Блочная разметка: заголовки, списки, таблицы */
  function mdBlocks(rawText) {
    const lines = String(rawText == null ? '' : rawText).split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const row = (s, tag) => s.trim().replace(/^\||\|$/g, '').split('|')
          .map((c) => `<${tag}>${mdInline(esc(c.trim()))}</${tag}>`).join('');
        let rows = `<tr>${row(line, 'th')}</tr>`;
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows += `<tr>${row(lines[i], 'td')}</tr>`;
          i++;
        }
        html += `<table class="md-table"><tbody>${rows}</tbody></table>`;
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        html += `<div class="md-h${h[1].length}">${mdInline(esc(h[2]))}</div>`;
        i++;
        continue;
      }
      if (/^\s*[-*•]\s+.+/.test(line)) {
        let items = '';
        while (i < lines.length && /^\s*[-*•]\s+(.+)/.test(lines[i])) {
          items += `<li>${mdInline(esc(/^\s*[-*•]\s+(.+)/.exec(lines[i])[1]))}</li>`;
          i++;
        }
        html += `<ul class="md-list">${items}</ul>`;
        continue;
      }
      if (/^\s*\d+[.)]\s+.+/.test(line)) {
        let items = '';
        while (i < lines.length && /^\s*\d+[.)]\s+(.+)/.test(lines[i])) {
          items += `<li>${mdInline(esc(/^\s*\d+[.)]\s+(.+)/.exec(lines[i])[1]))}</li>`;
          i++;
        }
        html += `<ol class="md-list">${items}</ol>`;
        continue;
      }
      if (line.trim()) html += `<div class="msg-text">${mdInline(esc(line))}</div>`;
      i++;
    }
    return html;
  }

  function richText(raw) {
    const text = String(raw == null ? '' : raw);
    const fence = /```(\w*)\n?([\s\S]*?)```/g;
    if (fence.test(text)) {
      fence.lastIndex = 0;
      let html = '';
      let last = 0;
      let m;
      while ((m = fence.exec(text))) {
        if (m.index > last) html += mdBlocks(text.slice(last, m.index));
        const lang = (m[1] || 'код').slice(0, 20);
        html += `<div class="codeblock"><div class="code-head"><span>${esc(lang)}</span>`
          + `<button class="btn btn-mini btn-ghost" data-save-code>В файл</button></div>`
          + `<pre><code>${esc(m[2].replace(/\n$/, ''))}</code></pre></div>`;
        last = m.index + m[0].length;
      }
      if (last < text.length) html += mdBlocks(text.slice(last));
      return html || mdBlocks(text);
    }
    if (text.length > COLLAPSE_AT) {
      return `<span class="clamp">${esc(text.slice(0, COLLAPSE_AT))}…</span>`
        + `<span class="fulltext" hidden>${mdBlocks(text)}</span>`
        + `<button class="link-btn" data-expand>Показать полностью</button>`;
    }
    return mdBlocks(text);
  }

  /* Сохранение кода из чата в рабочую папку (только полный доступ) */
  function openSaveModal(code) {
    const m = openModal({
      kicker: 'файл из чата',
      title: 'Сохранить код в файл',
      body: `
        <div class="field"><label>путь в рабочей папке</label>
          <input class="input mono" id="svPath" maxlength="180" placeholder="например: scripts/parser.py" autocomplete="off"></div>
        <span class="field-hint">Папки создаются сами. Перезапись существующего файла — без спроса.</span>
        <div id="svRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="svGo">${icon('check')}Сохранить</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#svGo').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#svGo');
      const resBox = m.modal.querySelector('#svRes');
      const p = (m.modal.querySelector('#svPath').value || '').trim();
      if (!p) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:12px 0 0">Укажите путь к файлу.</div>';
        return;
      }
      btn.innerHTML = '<span class="spinner"></span>Сохраняем';
      btn.style.pointerEvents = 'none';
      try {
        const out = await api('/api/workspace/file', { method: 'POST', body: { path: p, content: code } });
        toast(out.created ? 'Файл создан' : 'Файл перезаписан', out.path, 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}Сохранить`;
        btn.style.pointerEvents = '';
      }
    });
  }

  function onlineAgents() {
    return store.agents.filter((a) => a.status !== 'offline');
  }

  function selectedAgents() {
    if (sel.kind === 'team') return onlineAgents();
    const ids = new Set(sel.ids);
    return store.agents.filter((a) => ids.has(a.id) && a.status !== 'offline');
  }

  function recipientLabel() {
    const list = selectedAgents();
    if (sel.kind === 'team') return `Задача команде · ${list.length} в сети`;
    if (!list.length) return 'Выберите получателя выше';
    return `Получатели: ${list.map((a) => a.name).join(', ')}`;
  }

  function renderTo() {
    const all = onlineAgents().length;
    const teamOn = sel.kind === 'team';
    const ids = new Set(sel.ids);
    toBar.innerHTML = `
      <button class="to-chip${teamOn ? ' on' : ''}" data-to="team">${icon('users')}Вся команда · ${all}</button>
      ${store.agents.map((a) => `
        <button class="to-chip${!teamOn && ids.has(a.id) ? ' on' : ''}${a.status === 'offline' ? ' off' : ''}"
          data-to="${esc(a.id)}" ${a.status === 'offline' ? 'disabled' : ''}>${esc(agentAvatar(a))} ${esc(a.name)}</button>`).join('')}`;
    toBar.querySelectorAll('[data-to]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.to;
        if (id === 'team') {
          if (multiMode) {
            /* В режиме «вместе» кнопка выбирает всех */
            sel = { kind: 'agents', ids: store.agents.filter((a) => a.status !== 'offline').map((a) => a.id) };
          } else sel = { kind: 'team', ids: [] };
        } else if (multiMode) {
          const next = new Set(sel.kind === 'agents' ? sel.ids : []);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          sel = next.size ? { kind: 'agents', ids: [...next] } : { kind: 'team', ids: [] };
        } else {
          sel = { kind: 'agents', ids: [id] };
        }
        renderTo();
        updatePlaceholder();
      });
    });
  }

  function renderQuick() {
    quick.innerHTML = QUICK.map((q) => `
      <button class="q-chip${q.id === 'together' && multiMode ? ' on' : ''}" data-q="${q.id}">${icon(q.ic)}${q.label}</button>`).join('');
    quick.querySelectorAll('[data-q]').forEach((b) => {
      b.addEventListener('click', () => quickAction(b.dataset.q));
    });
  }

  function updateHead() {
    const online = onlineAgents().length;
    statusEl.textContent = `${store.team ? store.team.name : 'команда'} · ${online} из ${store.agents.length} в сети`;
  }

  function updatePlaceholder() {
    input.placeholder = sel.kind === 'team' ? 'Задача команде…' : 'Задача получателям…';
  }

  /* ----------------------------------------------------- отправка задач */

  /* Ход работы виден в консоли выполнения; в чат падает только готовый ответ.
     Ошибки показываем сразу — их важно не пропустить. */

  function appendAgentLine(agent, ev) {
    /* Мысли вслух живут только в консоли; чат не засоряем */
    if (ev.type === 'think' || ev.type === 'tool') return;
    if (ev.type === 'step') {
      updateTyping(`${agent.name} · шаг ${ev.step}${ev.of ? ` из ${ev.of}` : ''}…`);
      return;
    }
    if (ev.type === 'line') {
      if (ev.level === 'err') push({ from: 'agent', name: agent.name, level: 'err', text: ev.text });
      return;
    }
    if (ev.type === 'done') {
      hideTyping();
      /* Готовый ответ — целиком в чат (сворачивание всё равно спрячет длинное) */
      const answer = String((ev.text || '')).trim();
      if (answer) {
        push({ from: 'agent', name: agent.name, level: 'ok', text: answer });
        speak(`${agent.name}. ${answer}`);
      }
      const failed = !answer && (ev.stats.tokens || 0) === 0 && (ev.stats.steps || 0) === 0;
      bot(failed
        ? `${agent.name}: не выполнено — причина выше, подробности в консоли выполнения`
        : `${agent.name}: готово · ${ev.stats.tokens} токенов · ${ev.stats.steps} шагов · ${ev.stats.seconds} с`);
    }
  }

  /* Индикатор «печатает…», пока агент работает; текст можно обновлять (шаги) */
  function showTyping(name) {
    hideTyping();
    thread.insertAdjacentHTML('beforeend',
      `<div class="msg agent" id="chatTyping"><span class="agent-dot lv-info"></span><div>`
      + `<div class="agent-name">${esc(name)} печатает…</div>`
      + `<div class="bubble"><span class="typing-dots"><i></i><i></i><i></i></span></div></div></div>`);
    scrollDown();
  }
  function updateTyping(label) {
    const el = thread.querySelector('#chatTyping .agent-name');
    if (el) el.textContent = label;
  }
  function hideTyping() {
    thread.querySelector('#chatTyping')?.remove();
  }

  async function sendTask(task, fileRefs) {
    await sendTaskInner(task, fileRefs);
  }

  /** fileRefs — пути вида uploads/x.pdf: агент читает их через read_file.
      Картинки (png/jpg/gif/webp) модель дополнительно ВИДИТ через vision.
      quiet — не дублировать пузырь задачи (для встроенных сценариев). */
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  async function sendTaskInner(task, fileRefs, quiet) {
    const list = selectedAgents();
    if (!list.length) {
      bot('Некому выполнять: все выбранные агенты офлайн. Выберите получателя выше.');
      return;
    }
    const refs = Array.isArray(fileRefs) ? fileRefs : [];
    const imgs = refs.filter((p) => IMG_RE.test(p));
    const fullTask = refs.length
      ? `${task}\n\nПрикреплённые файлы (лежат в рабочей папке, читай через read_file): ${refs.join(', ')}${imgs.length ? '\nКартинки из списка выше ты ВИДИШЬ прямо в сообщении — анализируй их содержимое.' : ''}`
      : task;
    if (!quiet) push({ from: 'me', text: refs.length ? `${task}\nФайлы: ${refs.map((p) => p.split('/').pop()).join(', ')}` : task, images: imgs });
    sending = true;
    stopVoice();
    const ctrl = new AbortController();
    runCtrl = ctrl;
    paintSend();
    /* Остановка: объект сообщает об ошибке «Остановлено» — это норма, а не сбой */
    const onFail = (agentName) => (err) => {
      if (!err) return;
      hideTyping();
      if (String(err.message || err).includes('Остановлен')) {
        bot(`${agentName}: остановлено.`);
        return;
      }
      bot(`${agentName}: не запустилось — ${err.message || err}. Подробности в консоли.`);
    };
    try {
      const runId = `run_${Date.now().toString(36)}`;
      const onLine = (ev, agent) => appendAgentLine(agent || list[0], { ...ev, _run: runId });
      if (list.length === 1) {
        const agent = list[0];
        sys(`Запускаю: ${agent.name} — ${task}`);
        showTyping(agent.name);
        await runAgent(agent, fullTask, { signal: ctrl.signal, attachments: refs, onLine: (ev) => onLine(ev, agent), onDone: onFail(agent.name) });
      } else {
        /* Несколько исполнителей всегда идут цепочкой: один общий итог вместо хора */
        sys(`Запускаю команду цепочкой: ${list.map((a) => a.name).join(' → ')} — ${task}`);
        showTyping('команда');
        await runTeam(list, () => fullTask, { chain: true, signal: ctrl.signal, attachments: refs, onLine, onDone: (err, done, agent) => onFail(agent ? agent.name : 'агент')(err) });
      }
    } catch (e) {
      bot(`Не получилось запустить: ${e.message}`);
    } finally {
      hideTyping();
      sending = false;
      runCtrl = null;
      paintSend();
    }
  }

  /* ------------------------------------------------------- создание команды */

  async function quickCreateTeam(name, mission, roleKeys, named) {
    const prov = defaultProvider();
    if (!prov) {
      bot('Сначала подключите модель: <a href="#/connect">Подключения → Модели</a>, затем повторите.');
      return;
    }
    const namedRole = named && named.role;
    const namedName = named && named.name;
    const valid = roleKeys.map((k) => ROLE_BY_WORD.get(String(k).toLowerCase())).filter(Boolean);
    if (!valid.length) {
      bot(`Не узнал роли. Доступны: ${ROLES.map((r) => r.key).join(' ')}. Пример: /команда Запуск | Исследуем рынок | research analyst pm`);
      return;
    }
    let namedUsed = false;
    const agents = valid.slice(0, 12).map((key, i) => {
      const r = ROLES.find((x) => x.key === key);
      const meta = roleMeta(key);
      const useNamed = key === namedRole && namedName && !namedUsed;
      if (useNamed) namedUsed = true;
      return {
        id: `ag_${Date.now().toString(36)}${i}`,
        name: useNamed ? namedName : r.name,
        role: useNamed ? namedName : r.name,
        roleKey: key,
        accent: meta.accent,
        avatar: useNamed ? '🤵' : (meta.avatar || '🤖'),
        providerConfigId: prov.id,
        providerId: prov.providerId,
        model: prov.models[0],
        temperature: 0.5,
        systemPrompt: '',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: { services: [], programs: [], mcp: [], kb: [], input: false },
        spark: [],
      };
    });
    try {
      await createTeam({
        team: {
          name, description: mission || `Команда «${name}»`, mission: mission || 'Разработка',
          orchestration: 'parallel', budgetSteps: 80,
        },
        agents,
        event: { text: `Команда «${name}» создана из пульта: ${agents.length} агентов`, kind: 'ok' },
      });
      sel = { kind: 'team', ids: [] };
      renderTo();
      updateHead();
      bot(`Команда «${name}» создана: ${agents.map((a) => a.name).join(', ')}. Дайте первую задачу текстом.`);
      toast('Команда создана', `${agents.length} агентов готовы`, 'ok');
    } catch (e) {
      bot(`Не удалось создать команду: ${e.message}`);
    }
  }

  /* ------------------------------------------------------------- команды */

  async function handleCommand(raw) {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch ((cmd || '').toLowerCase()) {
      case 'помощь':
      case 'help':
      case 'старт':
        bot(HELP_TEXT);
        return;
      case 'статус':
        bot(statusSummary());
        return;
      case 'вместе':
        multiMode = !multiMode;
        if (multiMode && sel.kind === 'team') sel = { kind: 'agents', ids: [] };
        if (!multiMode) sel = { kind: 'team', ids: [] };
        renderQuick();
        renderTo();
        updatePlaceholder();
        bot(multiMode
          ? 'Режим «вместе»: нажмите на нескольких агентов выше, затем напишите одну задачу для всех.'
          : 'Обычный режим: одна задача — одному получателю или всей команде.');
        return;
      case 'команда': {
        const parts = arg.split('|').map((s) => s.trim());
        if (parts.length < 1 || !parts[0]) {
          bot('Формат: /команда Имя | Миссия | роли. Пример: /команда Запуск | Исследуем рынок | research analyst');
          return;
        }
        await quickCreateTeam(parts[0].slice(0, 60), parts[1] || '', (parts[2] || 'dev research assistant').split(/[\s,]+/).filter(Boolean));
        return;
      }
      case 'компания':
      case 'фирма':
      case 'company': {
        await quickCreateTeam(
          'Нексус',
          'Целая ИИ-компания: разработка, исследования, тексты, цифры и поддержка',
          ['assistant', 'dev', 'research', 'editor', 'analyst', 'devops', 'tester', 'designer', 'assistant'],
          { role: 'assistant', name: 'Директор' },
        );
        return;
      }
      case 'подключить':
      case 'подключения':
        bot(connectCard());
        return;
      case 'модели':
        bot('Модели подключаются здесь: <a href="#/connect">Подключения → Модели</a>: вставьте ключ, нажмите «Проверить» и выберите нужные модели.');
        return;
      case 'сервисы':
      case 'соцсети':
      case 'соцсеть':
      case 'телеграм':
      case 'слак':
      case 'инстаграм':
      case 'тикток':
        bot('Соцсети и сервисы — здесь: <a href="#/connect">Подключения → Сервисы</a>. Из коробки: Telegram, Slack, Discord, Notion, GitHub, Google Drive. Instagram и TikTok официальных API для ботов не дают — их подключают через свой MCP-сервер или сервис Webhook / HTTP.');
        return;
      case 'пк':
      case 'компьютер':
      case 'программы':
        bot('Программы ПК — здесь: <a href="#/connect">Подключения → Программы ПК</a>. Отметьте, что агенты могут запускать. Разрешения раздаются в карточке агента.');
        return;
      case 'mcp':
      case 'мсп':
      case 'мкп':
        bot('Свой MCP — здесь: <a href="#/connect">Подключения → MCP-серверы</a>: имя, транспорт (stdio/sse/http), команда или URL, затем «Проверить». Список tools подтянется сам.');
        return;
      case 'доступ':
      case 'телефон':
      case 'qr':
        bot('Доступ с телефона — здесь: <a href="#/connect">Подключения → Доступ</a>: задайте PIN и покажите QR.');
        return;
      case 'пин':
      case 'pin':
      case 'пароль':
        bot('PIN меняется здесь: <a href="#/connect">Подключения → Доступ → PIN-код → Сменить PIN</a>. Введите новый код дважды.');
        return;
      case 'повтори':
      case 'повторить':
      case 'ещё':
      case 'еще': {
        const n = parseInt(arg, 10);
        const item = Number.isFinite(n) && n > 0 ? taskHistory[n - 1] : taskHistory[0];
        if (!item) {
          bot('Пока нечего повторять — сначала дайте хоть одну задачу.');
          return;
        }
        sendTask(item);
        return;
      }
      case 'история': {
        if (!taskHistory.length) {
          bot('История пуста — задачи появятся здесь после первых поручений.');
          return;
        }
        bot(`Прошлые задачи (повтор: /повтори N):\n${taskHistory.slice(0, 10).map((t, i) => `${i + 1}. ${t.slice(0, 90)}`).join('\n')}`);
        return;
      }
      case 'цепочка':
      case 'chain':
      case 'вместе-цепочка': {
        const t = arg.trim();
        if (!t) {
          bot('Формат: /цепочка <задача>. Агенты пойдут по очереди, каждый дополняет предыдущего, последний собирает ЕДИНЫЙ итог. Переговоры видны в консоли выполнения.');
          return;
        }
        const chainList = selectedAgents();
        if (!chainList.length) {
          bot('Некому выполнять: все выбранные агенты офлайн.');
          return;
        }
        push({ from: 'me', text: `/цепочка ${t}` });
        sending = true;
        const chainCtrl = new AbortController();
        runCtrl = chainCtrl;
        paintSend();
        const chainFail = (agentName) => (err) => {
          if (!err) return;
          hideTyping();
          if (String(err.message || err).includes('Остановлен')) {
            bot(`${agentName}: остановлено.`);
            return;
          }
          bot(`${agentName}: не запустилось — ${err.message || err}. Подробности в консоли.`);
        };
        try {
          const runId = `run_${Date.now().toString(36)}`;
          sys(`Цепочка: ${chainList.map((a) => a.name).join(' → ')} — ${t}`);
          showTyping('команда');
          await runTeam(
            chainList,
            () => t,
            {
              chain: true,
              signal: chainCtrl.signal,
              onLine: (ev, agent) => appendAgentLine(agent || chainList[0], { ...ev, _run: runId }),
              onDone: (err, doneEv, agent) => chainFail(agent ? agent.name : 'агент')(err),
            },
          );
          bot(chainCtrl.signal.aborted ? 'Цепочка остановлена.' : 'Цепочка завершена: единый итог — в последнем ответе выше, переговоры — в консоли.');
        } catch (e) {
          bot(`Не получилось запустить: ${e.message}`);
        } finally {
          hideTyping();
          sending = false;
          runCtrl = null;
          paintSend();
        }
        return;
      }
      case 'очистить':
      case 'очисти':
        clearChat();
        return;
      case 'экспорт':
      case 'выгрузить':
      case 'сохранить':
        if (!messages.length) bot('Переписка пуста — выгружать нечего.');
        else exportChat();
        return;
      case 'заметка':
      case 'запиши':
      case 'note': {
        const text = arg.trim();
        if (!text) {
          bot('Формат: /заметка <текст>. Допишу в файл notes/заметки.md с датой.');
          return;
        }
        try {
          const stamp = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const out = await api('/api/workspace/file', {
            method: 'POST',
            body: { path: 'notes/заметки.md', content: `## ${stamp}\n${text}`, append: true },
          });
          toast('Записано', out.path, 'ok');
          sys(`Заметка дописана в ${out.path}`);
        } catch (e) {
          bot(`Не записалось: ${e.message}`);
        }
        return;
      }
      case 'найти':
      case 'поиск':
      case 'где': {
        const q = arg.trim().toLowerCase();
        if (!q) {
          bot('Формат: /найти <текст>. Найду сообщение в переписке и подсвечу его.');
          return;
        }
        hideTyping();
        const els = [...thread.querySelectorAll('.msg')].filter((el) => el.id !== 'chatTyping');
        let hit = -1;
        for (let i = 0; i < els.length && i < messages.length; i++) {
          if (String(messages[i].text || messages[i].name || '').toLowerCase().includes(q)) { hit = i; break; }
        }
        if (hit < 0 || !els[hit]) {
          bot(`«${arg.trim().slice(0, 60)}» в переписке не нашёл.`);
          return;
        }
        els[hit].scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
        els[hit].classList.remove('flash');
        void els[hit].offsetWidth;
        els[hit].classList.add('flash');
        setTimeout(() => els[hit] && els[hit].classList.remove('flash'), 2200);
        return;
      }
      case 'агенты':
      case 'команда?': {
        const rows = store.agents.map((a) => `${a.status === 'offline' ? '⚫' : '🟢'} ${a.name} — ${a.role}, модель ${a.model}`);
        bot(rows.length ? `Команда «${(store.team || {}).name || ''}»:\n${rows.join('\n')}` : 'В команде пока нет агентов. Создайте: /команда Имя | Миссия | роли');
        return;
      }
      case 'пауза':
      case 'выключи':
      case 'стоп-агент': {
        await setAgentStatus(arg, 'offline');
        return;
      }
      case 'включи':
      case 'разбуди': {
        await setAgentStatus(arg, 'online');
        return;
      }
      case 'статистика':
      case 'статы':
      case 'цифры': {
        try {
          const runs = await getRuns();
          const t = (runs && runs.totals) || {};
          const usd = Number(t.costUsd || 0);
          const recent = ((runs && runs.recent) || []).slice(0, 3)
            .map((r) => `• ${r.agentName || '?'}: ${String(r.task || '').slice(0, 50)} — ${r.status}, ${r.usage ? r.usage.totalTokens : 0} ток.`)
            .join('\n');
          bot(`Статистика команды:\nЗадач: ${t.runs || 0} (успешно ${t.ok || 0}) · токенов: ${t.totalTokens || 0} · расходы $${usd.toFixed(4)}\n${recent ? `Последние:\n${recent}` : 'Прогонов пока не было.'}`);
        } catch (e) {
          bot(`Не получилось: ${e.message}`);
        }
        return;
      }
      case 'каждый':
      case 'повторяй':
      case 'расписание-добавить': {
        await addScheduleCmd(arg, null);
        return;
      }
      case 'в': {
        const m = /^([01]?\d|2[0-3]):([0-5]\d)\b/.exec(arg.trim());
        if (!m) {
          bot('Формат: /в 09:00 своди отчёт — каждый день в это время.');
          return;
        }
        const at = `${m[1].padStart(2, '0')}:${m[2]}`;
        await addScheduleCmd(arg.trim().slice(m[0].length).trim(), at);
        return;
      }
      case 'расписание':
      case 'план': {
        try {
          const out = await getSchedules();
          const list = out.schedules || [];
          if (!list.length) {
            bot('Расписание пусто. Примеры:\n/каждый 30м проверь почту\n/в 09:00 своди утренний отчёт');
            return;
          }
          bot(`Расписание (отмена: /отмена ID):\n${list.map((s) => `• ${s.id.slice(-4)} · ${s.kind === 'every' ? `каждые ${s.everyMin} мин` : `в ${s.at}`} · ${s.enabled ? 'вкл' : 'выкл'} · «${String(s.task).slice(0, 60)}»`).join('\n')}`);
        } catch (e) {
          bot(`Не получилось: ${e.message}`);
        }
        return;
      }
      case 'отмена':
      case 'убрать-расписание': {
        const id = arg.trim();
        if (!id) {
          bot('Формат: /отмена <ID> — ID видно в /расписание (последние 4 символа).');
          return;
        }
        try {
          const out = await getSchedules();
          const hit = (out.schedules || []).find((s) => s.id === id || s.id.endsWith(id));
          if (!hit) {
            bot(`Не нашёл расписание «${id}». Смотри /расписание.`);
            return;
          }
          await removeSchedule(hit.id);
          bot(`Убрал: «${String(hit.task).slice(0, 60)}».`);
        } catch (e) {
          bot(`Не получилось: ${e.message}`);
        }
        return;
      }
      case 'открой':
      case 'открыть':
      case 'запусти': {
        await openProgramCmd(arg);
        return;
      }
      case 'браузер':
      case 'покажи':
      case 'окно': {
        await showBrowser();
        return;
      }
      case 'экран':
      case 'скрин':
      case 'скриншот':
      case 'screenshot': {
        try {
          sys('Снимаю экран браузера…');
          const out = await api('/api/browser/shot', { method: 'POST', body: {} });
          push({ from: 'img', name: 'экран браузера', shot: out.path.split('/').pop() });
        } catch (e) {
          bot(`Не снял экран: ${e.message}`);
        }
        return;
      }
      case 'исследуй':
      case 'исследование':
      case 'research': {
        await deepResearch(arg);
        return;
      }
      case 'телеграм':
      case 'telegram':
      case 'тг':
        bot('Telegram-пульт: сначала вставьте токен бота в <a href="#/connect">Подключения → Сервисы → Telegram</a>, затем включите мост во вкладке «Доступ → Telegram-пульт», укажите свой chat ID и исполнителя. После этого боту можно писать задачи текстом.');
        return;
      default:
        bot(`Не знаю команду «/${cmd}». ${HELP_TEXT}`);
    }
  }

  function quickAction(id) {
    switch (id) {
      case 'task':
        input.focus();
        input.placeholder = 'Напишите задачу и нажмите отправку…';
        return;
      case 'together':
        handleCommand('/вместе');
        return;
      case 'chain':
        bot('Цепочка: агенты идут по очереди и дополняют друг друга, последний собирает единый итог. Формат: /цепочка <задача>. Например: /цепочка изучите призраков и напишите один общий доклад в файл.');
        input.focus();
        return;
      case 'team':
        bot('Создам команду. Формат: /команда Имя | Миссия | роли. Пример: /команда Запуск | Исследуем рынок | research analyst');
        input.focus();
        return;
      case 'connect':
        handleCommand('/подключить');
        return;
      case 'mcp':
        handleCommand('/mcp');
        return;
      case 'browser':
        showBrowser();
        return;
      case 'pc':
        handleCommand('/пк');
        return;
      case 'social':
        handleCommand('/соцсети');
        return;
      default:
        return;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending) return;
    const text = (input.value || '').trim();
    if (text.startsWith('/')) {
      if (!text) return;
      input.value = '';
      autogrow();
      slashItems = [];
      paintSlash();
      handleCommand(text);
      return;
    }
    if (!text && !pendingFiles.length) return;
    input.value = '';
    autogrow();
    slashItems = [];
    paintSlash();
    if (text) rememberTask(text);
    sendTaskWithFiles(text);
  });

  /* ------------------------------------------------- вложения к задачам */

  const MAX_FILE_MB = 5;
  let pendingFiles = []; // File из <input>, ещё не загружены
  const fileInput = page.querySelector('#chatFiles');
  const attachRow = page.querySelector('#attachRow');

  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

  function renderAttachRow() {
    attachRow.hidden = !pendingFiles.length;
    attachRow.innerHTML = pendingFiles.map((f, i) => {
      const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '');
      const thumb = isImg && f._url ? `<img class="attach-thumb" src="${f._url}" alt="">` : '';
      return `
      <span class="chip chip-removable" style="--chip-c:var(--cyan)">${thumb}${esc(f.name)} · ${fmtSize(f.size)}
        <button type="button" data-unfile="${i}" aria-label="Убрать файл">${icon('x')}</button></span>`;
    }).join('');
  }

  page.querySelector('#chatAttach').addEventListener('click', () => fileInput.click());
  function addFiles(list) {
    for (const f of list) {
      if (f.size > MAX_FILE_MB * 1048576) {
        toast('Файл слишком большой', `${f.name}: лимит ${MAX_FILE_MB} МБ`, 'warn');
        continue;
      }
      if (pendingFiles.length >= 5) {
        toast('Хватит', 'Не больше 5 файлов за раз', 'warn');
        break;
      }
      /* Превью картинок прямо в строке вложений */
      try {
        if ((f.type || '').startsWith('image/')) f._url = URL.createObjectURL(f);
      } catch { /* без превью */ }
      pendingFiles.push(f);
    }
    renderAttachRow();
    if (pendingFiles.length) input.focus();
  }
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  /* Drag-n-drop + вставка из буфера: файлы падают в те же pendingFiles.
     Слушаем сам page (.ctl висит на нём, а не на потомках). */
  const composer = page.querySelector('#composer');
  let dragDepth = 0;
  const setDrag = (on) => composer.classList.toggle('drag', on);
  page.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    setDrag(true);
  });
  page.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  page.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; setDrag(false); }
  });
  page.addEventListener('drop', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth = 0;
    setDrag(false);
    if (e.dataTransfer.files.length) {
      addFiles([...e.dataTransfer.files]);
      toast('Файлы добавлены', `${e.dataTransfer.files.length} шт. — нажмите «Отправить»`, 'ok');
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  /* Enter — отправить · Shift+Enter — новая строка · Ctrl+Enter — тоже отправить */
  const charCount = page.querySelector('#charCount');
  const autogrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(180, Math.max(54, input.scrollHeight)) + 'px';
    if (charCount) {
      charCount.textContent = `${(input.value || '').length}/2000`;
      charCount.classList.toggle('over', (input.value || '').length >= 2000);
    }
  };
  input.addEventListener('input', autogrow);
  autogrow();
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const chatCmd = (e) => {
    const cmd = e.detail;
    if (typeof cmd !== 'string') return;
    input.value = cmd;
    autogrow();
    form.requestSubmit();
  };
  window.addEventListener('nexus:chat', chatCmd);

  /* ---------- Слеш-меню: / + фильтр + Enter/Tab ---------- */
  const SLASH_CMDS = [
    ['/компания', 'целая ИИ-компания из 9 агентов'],
    ['/цепочка', 'цепочка агентов с единым итогом'],
    ['/вместе', 'несколько агентов на одну задачу'],
    ['/команда', 'Имя | Миссия | роли — новая команда'],
    ['/исследуй', 'глубокое исследование темы'],
    ['/повтори', 'повторить прошлую задачу (/повтори N)'],
    ['/история', 'прошлые задачи'],
    ['/найти', 'поиск по переписке'],
    ['/экспорт', 'скачать переписку (.md)'],
    ['/заметка', 'дописать в notes/заметки.md'],
    ['/статус', 'состояние команды'],
    ['/агенты', 'список агентов'],
    ['/расписание', 'планировщик задач'],
    ['/подключить', 'что и где подключить'],
    ['/модели', 'LLM-модели и ключи'],
    ['/пк', 'программы компьютера'],
    ['/mcp', 'MCP-серверы'],
    ['/доступ', 'PIN, QR, телефон'],
    ['/очистить', 'новая переписка'],
  ];
  const slashList = page.querySelector('#slashList');
  let slashIdx = 0;
  let slashItems = [];
  const paintSlash = () => {
    if (!slashItems.length) { slashList.hidden = true; slashList.innerHTML = ''; return; }
    slashList.hidden = false;
    slashList.innerHTML = slashItems.map((c, i) =>
      `<button class="slash-item${i === slashIdx ? ' on' : ''}" data-sl="${i}" role="option"><b class="mono">${esc(c[0])}</b><small>${esc(c[1])}</small></button>`).join('');
  };
  input.addEventListener('input', () => {
    const v = input.value;
    if (v.startsWith('/') && !v.includes(' ') && !v.includes('\n')) {
      const q = v.slice(1).toLowerCase();
      slashItems = SLASH_CMDS.filter((c) => c[0].slice(1).startsWith(q) || c[1].toLowerCase().includes(q)).slice(0, 8);
      slashIdx = 0;
      paintSlash();
    } else {
      slashItems = [];
      paintSlash();
    }
  });
  slashList.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sl]');
    if (!b) return;
    const c = slashItems[Number(b.dataset.sl)];
    if (!c) return;
    input.value = c[0] + ' ';
    slashItems = [];
    paintSlash();
    autogrow();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (slashList.hidden || !slashItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = Math.min(slashItems.length - 1, slashIdx + 1); paintSlash(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = Math.max(0, slashIdx - 1); paintSlash(); }
    else if (e.key === 'Tab' || (e.key === 'Enter' && input.value.startsWith('/') && !input.value.includes(' '))) {
      e.preventDefault();
      const c = slashItems[slashIdx];
      if (c) {
        input.value = c[0] + ' ';
        slashItems = [];
        paintSlash();
        autogrow();
      }
    } else if (e.key === 'Escape') { slashItems = []; paintSlash(); }
  });

  /* ---------- ИИ-быстрые действия: один тап — готовый промпт ---------- */
  const AI_QUICK = [
    ['Объяснить', 'Объясни простыми словами: '],
    ['Сократить', 'Сократи до сути, 5 пунктов: '],
    ['Код-ревью', 'Сделай код-ревью, найди проблемы и предложи исправления: '],
    ['Перевести', 'Переведи на английский, сохрани стиль: '],
    ['План', 'Разбей на пошаговый план: '],
    ['Фактчек', 'Проверь факты и отметь сомнительное: '],
  ];
  const aiBar = page.querySelector('#aiBar');
  aiBar.innerHTML = AI_QUICK.map((a, i) => `<button class="ai-chip" data-ai="${i}">${esc(a[0])}</button>`).join('');
  aiBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ai]');
    if (!b) return;
    const prefix = AI_QUICK[Number(b.dataset.ai)][1];
    input.value = prefix + (input.value || '');
    autogrow();
    input.focus();
  });

  /* ---------- Фокус-режим ---------- */
  page.querySelector('#ctlFocus').addEventListener('click', (e) => {
    const on = document.body.classList.toggle('chat-focus');
    e.currentTarget.style.color = on ? 'var(--cyan)' : '';
    toast(on ? 'Фокус-режим' : 'Обычный вид', on ? 'Чат на весь экран · повторный клик вернёт всё' : 'Сайдбар возвращён', 'ok');
  });

  /* ---------- Поиск по переписке с навигацией ---------- */
  const searchBar = page.querySelector('#chatSearch');
  const searchInput = page.querySelector('#searchInput');
  const searchCount = page.querySelector('#searchCount');
  let searchHits = [];
  let searchPos = 0;
  const paintSearch = () => {
    thread.querySelectorAll('.msg').forEach((el) => el.classList.remove('flash'));
    if (!searchHits.length) { searchCount.textContent = ''; return; }
    searchCount.textContent = `${searchPos + 1}/${searchHits.length}`;
    const el = searchHits[searchPos];
    if (el) {
      el.classList.add('flash');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
  const runSearch = () => {
    const q = searchInput.value.trim().toLowerCase();
    searchHits = [];
    searchPos = 0;
    if (!q) { paintSearch(); return; }
    thread.querySelectorAll('.msg').forEach((el) => {
      if (el.textContent.toLowerCase().includes(q)) searchHits.push(el);
    });
    paintSearch();
  };
  page.querySelector('#ctlSearchBtn').addEventListener('click', () => {
    searchBar.hidden = !searchBar.hidden;
    if (!searchBar.hidden) searchInput.focus();
  });
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (searchHits.length) { searchPos = (searchPos + 1) % searchHits.length; paintSearch(); } }
    if (e.key === 'Escape') { searchBar.hidden = true; }
  });
  page.querySelector('#searchNext').addEventListener('click', () => { if (searchHits.length) { searchPos = (searchPos + 1) % searchHits.length; paintSearch(); } });
  page.querySelector('#searchPrev').addEventListener('click', () => { if (searchHits.length) { searchPos = (searchPos - 1 + searchHits.length) % searchHits.length; paintSearch(); } });
  attachRow.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unfile]');
    if (!b) return;
    const removed = pendingFiles.splice(Number(b.dataset.unfile), 1);
    freePreviews(removed);
    renderAttachRow();
  });

  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsDataURL(file);
  });

  /** Загружает вложения в uploads/ и дописывает их пути к задаче */
  const freePreviews = (files) => {
    for (const f of files || []) {
      try { if (f._url) URL.revokeObjectURL(f._url); } catch { /* игнор */ }
    }
  };
  async function sendTaskWithFiles(text) {
    if (!pendingFiles.length) {
      sendTask(text);
      return;
    }
    const files = pendingFiles;
    pendingFiles = [];
    renderAttachRow();
    sending = true;
    paintSend();
    try {
      const refs = [];
      for (const f of files) {
        const contentBase64 = await readAsBase64(f);
        const out = await api('/api/workspace/upload', { method: 'POST', body: { name: f.name, contentBase64 } });
        refs.push(out.path);
      }
      freePreviews(files);
      toast('Файлы загружены', `${refs.length} шт. → рабочая папка`, 'ok');
      await sendTaskInner(text || 'Разбери прикреплённые файлы и отчитайся.', refs);
    } catch (err) {
      bot(`Файлы не ушли: ${err.message}`);
    } finally {
      sending = false;
      paintSend();
    }
  }

  /* Делегирование кликов в ленте: действия сообщений (sug — отдельным слушателем выше) */

  const SUG_PREFIX = [
    'Разбери задачу по шагам и предложи план: ',
    'Проверь код, найди ошибки и предложи исправления: ',
    'Собери сводку по теме с фактами и выводами: ',
    'Напиши грамотный текст по черновику: ',
  ];
  thread.addEventListener('click', (e) => {
    const sg = e.target.closest('[data-sug]');
    if (sg) {
      input.value = SUG_PREFIX[Number(sg.dataset.sug)] || '';
      autogrow();
      input.focus();
      return;
    }
  }, true);

  /* Делегирование кликов в ленте: развернуть ответ / сохранить код / копировать / действия */
  thread.addEventListener('click', async (e) => {
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const el = actBtn.closest('.msg');
      const idx = el && el.dataset.mid !== undefined ? Number(el.dataset.mid) : -1;
      const m = idx >= 0 && messages[idx] ? messages[idx] : null;
      const act = actBtn.dataset.act;
      const text = m ? String(m.text || '') : '';
      if (act === 'copy' && text) {
        try { await navigator.clipboard.writeText(text); toast('Скопировано', 'Текст в буфере обмена', 'ok'); }
        catch { toast('Не скопировалось', 'Браузер запретил доступ к буферу', 'err'); }
      } else if (act === 'edit' && m && m.from === 'me') {
        input.value = text;
        autogrow();
        input.focus();
        toast('Правка', 'Отредактируй и отправь заново', 'ok');
      } else if (act === 'resend' && text) {
        input.value = text;
        autogrow();
        form.requestSubmit();
      } else if (act === 'resend-agent' && taskHistory[0]) {
        sendTask(taskHistory[0]);
      } else if (act === 'speak' && text) {
        try {
          if (!('speechSynthesis' in window)) { toast('Нет голоса', 'Браузер не умеет синтез речи', 'warn'); }
          else {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
            u.lang = 'ru-RU';
            window.speechSynthesis.speak(u);
          }
        } catch { /* игнор */ }
      } else if (act === 'short' && text) {
        input.value = `Сократи до сути, 5 буллетов:\n\n${text.slice(0, 1500)}`;
        autogrow();
        form.requestSubmit();
      }
      return;
    }
    const cp = e.target.closest('[data-copy-answer]');
    if (cp) {
      const el = cp.closest('.msg');
      const idx = el && el.dataset.mid !== undefined ? Number(el.dataset.mid) : -1;
      const text = idx >= 0 && messages[idx] ? String(messages[idx].text || '') : '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        toast('Скопировано', 'Ответ в буфере обмена', 'ok');
      } catch {
        toast('Не скопировалось', 'Браузер запретил доступ к буферу', 'err');
      }
      return;
    }
    const exp = e.target.closest('[data-expand]');
    if (exp) {
      const b = exp.closest('.bubble');
      const clamp = b && b.querySelector('.clamp');
      const full = b && b.querySelector('.fulltext');
      if (!clamp || !full) return;
      const opening = full.hidden;
      full.hidden = !opening;
      clamp.hidden = opening;
      exp.textContent = opening ? 'Свернуть' : 'Показать полностью';
      scrollDown();
      return;
    }
    const sv = e.target.closest('[data-save-code]');
    if (sv) {
      const code = sv.closest('.codeblock').querySelector('code').textContent;
      openSaveModal(code);
    }
  });

  page.querySelector('#ctlTheme').addEventListener('click', (e) => {
    const t = toggleTheme();
    e.currentTarget.title = t === 'light' ? 'Тёмная тема' : 'Светлая тема';
  });

  /* Озвучка готовых ответов (синтез речи браузера, ничего не отправляется) */
  let voiceOn = false;
  try { voiceOn = localStorage.getItem('nexus_voice') === '1'; } catch { voiceOn = false; }
  const voiceBtn = page.querySelector('#ctlVoice');
  const paintVoice = () => {
    voiceBtn.setAttribute('aria-pressed', String(voiceOn));
    voiceBtn.style.color = voiceOn ? 'var(--cyan)' : '';
    voiceBtn.title = voiceOn ? 'Не озвучивать' : 'Озвучивать ответы';
  };
  paintVoice();
  function stopVoice() {
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch { /* игнор */ }
  }
  voiceBtn.addEventListener('click', () => {
    voiceOn = !voiceOn;
    try { localStorage.setItem('nexus_voice', voiceOn ? '1' : '0'); } catch { /* игнор */ }
    if (!voiceOn) stopVoice();
    else if (!('speechSynthesis' in window)) toast('Нет голоса', 'Этот браузер не умеет синтез речи', 'warn');
    paintVoice();
  });
  function speak(text) {
    if (!voiceOn) return;
    try {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 1200));
      u.lang = 'ru-RU';
      window.speechSynthesis.speak(u);
    } catch { /* игнор */ }
  }

  /* Индикатор и кнопка браузера команды: видно, запущен ли он */
  async function refreshBrowserDot() {
    const dot = page.querySelector('#ctlBrowserDot');
    if (!dot) return;
    try {
      const st = await api('/api/browser/state');
      const on = !!(st && st.running);
      dot.classList.toggle('on', on);
      page.querySelector('#ctlBrowser').title = on
        ? `Браузер команды: ${st.title || st.url || 'открыт'} — нажать, чтобы показать`
        : 'Браузер команды не запущен — нажать, чтобы открыть';
    } catch {
      dot.classList.remove('on');
    }
  }
  async function showBrowser() {
    try {
      const out = await api('/api/browser/show', { method: 'POST', body: {} });
      sys(out.url && out.url !== 'about:blank'
        ? `Браузер команды на экране: ${out.title || out.url}`
        : 'Браузер команды открыт — смотри окно Chrome.');
      toast('Браузер на экране', out.title || out.url || 'окно поднято', 'ok');
    } catch (e) {
      bot(`Не показал браузер: ${e.message}`);
    }
    refreshBrowserDot();
  }
  page.querySelector('#ctlBrowser').addEventListener('click', showBrowser);

  /* Очистка переписки на этом устройстве (запуски и журнал не трогаем) */
  async function clearChat() {
    const ok = await confirmDialog({
      kicker: 'переписка',
      title: 'Очистить переписку?',
      text: 'Сообщения пульта удалятся на этом устройстве. Выполненные задачи и журнал команды сохранятся.',
      okText: 'Очистить',
    });
    if (!ok) return;
    messages = [];
    try { localStorage.removeItem(CHAT_KEY); } catch { /* приватный режим */ }
    renderThread();
  }
  page.querySelector('#ctlClear').addEventListener('click', clearChat);
  /* Новый чат — то же самое, но без диалога: как в ChatGPT */
  page.querySelector('#ctlNew').addEventListener('click', () => {
    if (!messages.length) return;
    messages = [];
    try { localStorage.removeItem(CHAT_KEY); } catch { /* приватный режим */ }
    renderThread();
    input.focus();
  });
  page.querySelector('#ctlRegen').addEventListener('click', () => {
    if (sending || !taskHistory.length) {
      if (!taskHistory.length) toast('Нечего повторять', 'Сначала дайте хоть одну задачу', 'warn');
      return;
    }
    sendTask(taskHistory[0]);
  });

  /* История задач пользователя — для /история и /повтори N */
  let taskHistory = [];
  try {
    const raw = JSON.parse(localStorage.getItem('nexus_task_history') || '[]');
    if (Array.isArray(raw)) taskHistory = raw.filter((s) => typeof s === 'string').slice(0, 20);
    /* Переезд со старого ключа последнего задания */
    if (!taskHistory.length) {
      const one = JSON.parse(localStorage.getItem('nexus_last_task') || '""');
      if (typeof one === 'string' && one) taskHistory = [one];
    }
  } catch { taskHistory = []; }
  const rememberTask = (t) => {
    taskHistory = [t, ...taskHistory.filter((x) => x !== t)].slice(0, 20);
    try { localStorage.setItem('nexus_task_history', JSON.stringify(taskHistory)); } catch { /* приватный режим */ }
  };

  /* Открыть программу ПК по имени (кнопка человека, не инструмент агента) */
  async function openProgramCmd(arg) {
    const q = (arg || '').trim().toLowerCase();
    if (!q) {
      const names = store.programs.map((p) => p.name).join(', ');
      bot(`Формат: /открой <название>. Доступно: ${names || 'пока пусто — смотри Подключения → Программы ПК'}.`);
      return;
    }
    const found = store.programs.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(q));
    if (!found.length) {
      bot(`Не нашёл программу «${arg}». Список — в Подключения → Программы ПК.`);
      return;
    }
    if (found.length > 1) {
      bot(`Нашлось несколько: ${found.map((p) => p.name).join(', ')}. Уточни название.`);
      return;
    }
    try {
      const out = await api(`/api/programs/${encodeURIComponent(found[0].id)}/open`, { method: 'POST', body: {} });
      sys(`Открываю: ${out.name}`);
      toast('Программа запущена', out.name, 'ok');
    } catch (e) {
      bot(`Не открылось: ${e.message}`);
    }
  }

  /* Глубокое исследование темы: волны поиска → первоисточники → отчёт в файл */
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'tema';

  async function deepResearch(arg) {
    const topic = (arg || '').trim();
    if (!topic) {
      bot('Формат: /исследуй <тема>. Пример: /исследуй дешёвые роботы-пылесосы 2026. Исследователь пройдёт волнами поиска, прочитает первоисточники и сложит отчёт в файл.');
      return;
    }
    const online = store.agents.filter((a) => a.status !== 'offline');
    if (!online.length) {
      bot('Некому исследовать: все агенты офлайн.');
      return;
    }
    const agent = online.find((a) => a.roleKey === 'research') || online[0];
    const full = ((store.access || {}).access || {}).mode === 'full';
    const svcOk = new Set(store.services.filter((s) => s.status === 'connected').map((s) => s.integrationId || s.id));
    const mine = new Set(agent.permissions.services || []);
    const extra = [];
    if (mine.has('googlesearch') && svcOk.has('googlesearch')) extra.push('svc_googlesearch_search');
    if (mine.has('exa') && svcOk.has('exa')) extra.push('svc_exa_search', 'svc_exa_contents');
    const searchLine = extra.length
      ? `Дополнительный поиск (у тебя есть доступ): ${extra.join(', ')} — сверяй их между собой.`
      : 'Если хочешь Google или Exa-нейропоиск — попроси оператора подключить их тебе в конструкторе.';
    const fileName = `research/${slugify(topic)}.md`;
    const task = `Глубокое исследование темы: «${topic}».\n`
      + `Работай волнами, минимум три:\n`
      + `1) Разбей тему на 4–6 подвопросов (цены, варианты, отзывы, подводные камни, свежие данные).\n`
      + `2) По каждому подвопросу выполни web_search. ${searchLine}\n`
      + `3) Прочитай минимум 3 первоисточника целиком${full ? ' через http_request' : ' (в этом режиме опирайся на сниппеты поиска и честно укажи это)'}.\n`
      + `4) Сопоставь факты, отметь противоречия и устаревшие данные.\n`
      + `5) Итог — связный отчёт на русском: выжимка, разбор по подвопросам, таблица вариантов если уместно, список источников (название + URL).\n`
      + (full
        ? `6) Сохрани отчёт файлом ${fileName} через write_file и продублируй в ответе только выжимку и путь к файлу.`
        : `6) Верни полный отчёт прямо в ответе.`);
    const prevSel = sel;
    sel = { kind: 'agents', ids: [agent.id] };
    renderTo();
    bot(`Исследование «${topic}» поручаю: ${agent.name}. Отчёт ${full ? `ляжет в ${fileName}` : 'вернётся в чат'}.`);
    try {
      await sendTaskInner(task, null, true);
    } finally {
      sel = prevSel;
      renderTo();
    }
  }

  /* Включение/пауза агента прямо из чата */
  async function setAgentStatus(arg, status) {
    const q = (arg || '').trim().toLowerCase();
    if (!q) {
      bot(`Формат: ${status === 'offline' ? '/пауза' : '/включи'} <имя>. Например: /пауза ${store.agents[0] ? store.agents[0].name : 'Атлас'}.`);
      return;
    }
    const hit = store.agents.filter((a) => `${a.name} ${a.role} ${a.id}`.toLowerCase().includes(q));
    if (!hit.length) {
      bot(`Не нашёл агента «${arg.trim()}». Смотри /агенты.`);
      return;
    }
    if (hit.length > 1) {
      bot(`Подходит несколько: ${hit.map((a) => a.name).join(', ')}. Уточни имя.`);
      return;
    }
    try {
      await saveAgent({ ...hit[0], status });
      toast(hit[0].name, status === 'offline' ? 'Поставлен на паузу' : 'Снова в строю', status === 'offline' ? 'warn' : 'ok');
    } catch (e) {
      bot(`Не получилось: ${e.message}`);
    }
  }

  /* Добавление расписания: /каждый 30м задача или ежедневно в 09:00 */
  async function addScheduleCmd(arg, at) {
    const text = (arg || '').trim();
    if (!text) {
      bot('Формат: /каждый 30м проверь почту — или — /в 09:00 своди отчёт. Минимум каждые 5 минут.');
      return;
    }
    let kind;
    let everyMin;
    let dailyAt = at || null;
    let task = text;
    if (!dailyAt) {
      const m = /(\d+)\s*(м|мин|минут|ч|час|h|m)(?![a-zа-яё0-9])/i.exec(text);
      if (!m) {
        bot('Не понял интервал. Примеры: /каждый 30м проверь почту · /каждый 2ч своди отчёт.');
        return;
      }
      const n = Number(m[1]);
      everyMin = /^(ч|час|h)$/i.test(m[2]) ? n * 60 : n;
      if (everyMin < 5 || everyMin > 10080) {
        bot('Интервал — от 5 минут до недели.');
        return;
      }
      task = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
      kind = 'every';
    } else {
      kind = 'daily';
    }
    if (!task) {
      bot('А что делать-то? Добавь задачу после времени.');
      return;
    }
    const only = sel.kind === 'agents' && sel.ids.length === 1 ? sel.ids[0] : null;
    try {
      const out = await saveSchedule({ kind, everyMin, at: dailyAt, task: task.slice(0, 500), targetAgentId: only });
      const s = out.schedule;
      bot(`Запланировал (${s.id.slice(-4)}): ${kind === 'every' ? `каждые ${s.everyMin} мин` : `ежедневно в ${s.at}`} — «${task.slice(0, 80)}». Смотреть: /расписание.`);
    } catch (e) {
      bot(`Не запланировалось: ${e.message}`);
    }
  }

  /* Выгрузка переписки в Markdown-файл */
  function exportChat() {
    const line = (m) => {
      if (m.from === 'img') return `### ${m.name || 'экран'}\n\nСкриншот: /api/shots/${m.shot}\n`;
      const who = m.from === 'me' ? 'Вы' : m.from === 'agent' ? (m.name || 'агент') : m.from === 'sys' ? 'система' : 'NEXUS';
      return `### ${who}\n\n${String(m.text || '').slice(0, 4000)}\n`;
    };
    const md = `# Переписка NEXUS · ${new Date().toLocaleString('ru-RU')}\n\n${messages.map(line).join('\n')}`;
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Переписка выгружена', 'Markdown-файл сохранён', 'ok');
  }

  /* Голосовой ввод: распознавание речи браузера, ничего никуда не отправляем сами */
  (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = page.querySelector('#chatMic');
    if (!SR || !micBtn) return;
    micBtn.hidden = false;
    let rec = null;
    let listening = false;
    micBtn.addEventListener('click', () => {
      if (listening) { try { rec.stop(); } catch { /* игнор */ } return; }
      rec = new SR();
      rec.lang = 'ru-RU';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      listening = true;
      micBtn.classList.add('live');
      micBtn.setAttribute('aria-pressed', 'true');
      rec.onresult = (e) => {
        const text = [...e.results].map((r) => r[0].transcript).join(' ').trim();
        if (text) {
          input.value = input.value ? `${input.value} ${text}` : text;
          input.focus();
        }
      };
      const stop = () => {
        listening = false;
        micBtn.classList.remove('live');
        micBtn.setAttribute('aria-pressed', 'false');
      };
      rec.onend = stop;
      rec.onerror = stop;
      try { rec.start(); } catch { stop(); }
    });
  })();

  /* ------------------------------------------------------------ подписки */

  const onTeam = () => {
    if (!page.isConnected) return;
    /* Чистим выбор от удалённых агентов */
    if (sel.kind === 'agents') {
      const alive = new Set(store.agents.map((a) => a.id));
      sel.ids = sel.ids.filter((id) => alive.has(id));
      if (!sel.ids.length) sel = { kind: 'team', ids: [] };
    }
    renderTo();
    updateHead();
  };
  bus.addEventListener('team', onTeam);
  const onAll = () => { if (page.isConnected) { renderTo(); updateHead(); } };
  bus.addEventListener('all', onAll);

  /* -------------------------------------------------------------- старт */

  renderTo();
  renderQuick();
  renderThread();
  updateHead();
  updatePlaceholder();
  refreshBrowserDot();
  const browserTimer = setInterval(() => { if (page.isConnected) refreshBrowserDot(); }, 20000);
  if (!('ontouchstart' in window)) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { /* игнор */ } }, 350);

  /* Счётчик токенов и расходов в шапке пульта — из реальных totals /api/runs */
  const paintTotals = async () => {
    if (!page.isConnected) return;
    try {
      const runs = await getRuns();
      const t = (runs && runs.totals) || {};
      const tokens = t.totalTokens || 0;
      const usd = Number(t.costUsd) || 0;
      const compact = tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
      statusEl.innerHTML = `${esc(statusSummary())} · <b class="tok">◈ ${esc(compact)} ток · $${usd.toFixed(4)}</b>`;
      statusEl.title = `Прогонов: ${t.runs || 0} (успешно ${t.ok || 0}) · токенов: ${tokens} · $${usd.toFixed(4)}`;
    } catch { /* тихий ретрай следующим тиком */ }
  };
  paintTotals();
  const totalsTimer = setInterval(paintTotals, 60000);

  return () => {
    clearInterval(browserTimer);
    clearInterval(totalsTimer);
    window.removeEventListener('nexus:chat', chatCmd);
    bus.removeEventListener('team', onTeam);
    bus.removeEventListener('all', onAll);
  };
}
