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
import { t, localeTag, getLang, langName, setLang, nextLang } from './i18n.js';
import {
  store, bus, createTeam, saveAgent,
  getSchedules, saveSchedule, removeSchedule, getRuns,
} from './store.js';
import { runAgent, runTeam } from './console.js';

const CHAT_KEY = 'nexus_chat_v1';

const HELP_TEXT = t('control.help_text');

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
  const tm = store.team || {};
  return t('control.status_summary', {
    online, total: store.agents.length,
    svc, svcTotal: store.services.length,
    mcp, mcpTotal: store.mcp.length,
    programs: store.programs.length, tasks: tm.tasksCompleted || 0,
  });
}

function connectCard() {
  return t('control.connect_card');
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
        <h2>${t('control.head_title')}</h2>
        <span class="ctl-status" id="ctlStatus">${t('control.status_connecting')}</span>
      </div>
      <a class="icon-btn" href="#/team" aria-label="${t('control.open_team_aria')}">${icon('users')}</a>
      <button class="icon-btn" id="ctlBrowser" aria-label="${t('control.browser_aria')}" title="${t('control.browser_title')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" x2="12" y1="8" y2="8"/><line x1="3.95" x2="8.54" y1="6.06" y2="14"/><line x1="10.88" x2="15.46" y1="21.94" y2="14"/></svg>
        <i class="dot" id="ctlBrowserDot"></i>
      </button>
      <button class="icon-btn" id="ctlNew" aria-label="${t('control.new_aria')}" title="${t('control.new_title')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="icon-btn" id="ctlRegen" aria-label="${t('control.regen_aria')}" title="${t('control.regen_title')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>
      </button>
      <button class="icon-btn" id="ctlClear" aria-label="${t('control.clear_aria')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      <button class="icon-btn theme-btn" id="ctlTheme" aria-label="${t('control.theme_aria')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>
      <button class="icon-btn" id="ctlVoice" aria-label="${t('control.voice_aria')}" aria-pressed="false" title="${t('control.voice_title_on')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>
      </button>
      <button class="icon-btn" id="ctlSearchBtn" aria-label="${t('control.search_btn_aria')}" title="${t('control.search_btn_title')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
      <button class="icon-btn" id="ctlFocus" aria-label="${t('control.focus_aria')}" title="${t('control.focus_title')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1 2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
      <button class="icon-btn lang-btn" id="ctlLang" aria-label="${t('control.lang_aria')}" title="${t('control.lang_aria')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>
        <span class="lang-tag mono">${langName(getLang())}</span>
      </button>
    </section>

    <div class="chat-search" id="chatSearch" hidden>
      <input class="input" id="searchInput" placeholder="${t('control.search_ph')}" aria-label="${t('control.search_ph')}">
      <span class="search-count mono" id="searchCount"></span>
      <button class="icon-btn" id="searchPrev" aria-label="${t('control.search_prev')}">↑</button>
      <button class="icon-btn" id="searchNext" aria-label="${t('control.search_next')}">↓</button>
    </div>

    <div class="ctl-to" id="ctlTo" role="group" aria-label="${t('control.to_group_aria')}"></div>

    <div class="chat" id="chatThread" role="log" aria-label="${t('control.thread_aria')}"></div>

    <div class="ctl-quick" id="ctlQuick" aria-label="${t('control.quick_aria')}"></div>

    <div class="ai-bar" id="aiBar" aria-label="${t('control.ai_aria')}"></div>

    <div class="attach-row" id="attachRow" hidden></div>

    <div class="slash-pop">
      <div class="slash-list" id="slashList" hidden role="listbox" aria-label="${t('control.slash_aria')}"></div>
    </div>

    <form class="composer" id="composer" autocomplete="off">
      <textarea class="input" id="chatInput" placeholder="${t('control.composer_ph')}" maxlength="2000" rows="1"
        aria-label="${t('control.composer_aria')}" enterkeyhint="send"></textarea>
      <span class="char-count mono" id="charCount">0/2000</span>
      <input type="file" id="chatFiles" multiple hidden>
      <button class="icon-btn composer-attach" id="chatAttach" type="button" aria-label="${t('control.attach_aria')}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button class="icon-btn composer-mic" id="chatMic" type="button" aria-label="${t('control.mic_aria')}" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
      </button>
      <button class="btn btn-primary composer-send" id="chatSend" type="submit" aria-label="${t('control.send_aria')}">${icon('send')}</button>
      <button class="btn composer-stop" id="chatStop" type="button" aria-label="${t('control.stop_aria')}" hidden>■</button>
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
      toast(t('control.stopping_t'), t('control.stopping_d'), 'warn');
    }
  });

  const QUICK = [
    { id: 'task', label: t('control.quick_task'), ic: 'message' },
    { id: 'together', label: t('control.quick_together'), ic: 'users' },
    { id: 'chain', label: t('control.quick_chain'), ic: 'gitBranch' },
    { id: 'team', label: t('control.quick_team'), ic: 'plus' },
    { id: 'connect', label: t('control.quick_connect'), ic: 'link' },
    { id: 'mcp', label: t('control.quick_mcp'), ic: 'layers' },
    { id: 'browser', label: t('control.quick_browser'), ic: 'appWindow' },
    { id: 'pc', label: t('control.quick_pc'), ic: 'appWindow' },
    { id: 'social', label: t('control.quick_social'), ic: 'megaphone' },
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
      return `<div class="msg me"${mid}><div class="bubble">${thumbs ? `<div class="attach-thumbs">${thumbs}</div>` : ''}${esc(m.text)}<div class="msg-actions"><button class="mini-btn" data-act="resend">${esc(t('control.msg_resend'))}</button><button class="mini-btn" data-act="edit">${esc(t('control.msg_edit'))}</button><button class="mini-btn" data-act="copy">${esc(t('control.msg_copy'))}</button></div></div></div>`;
    }
    if (m.from === 'img') {
      return `<div class="msg agent"${mid}><span class="agent-dot lv-info"></span><div><div class="agent-name">${esc(m.name || t('control.msg_screen'))}</div>`
        + `<div class="bubble"><a href="/api/shots/${esc(m.shot)}" target="_blank" rel="noopener"><img class="shot-img" src="/api/shots/${esc(m.shot)}" alt="${esc(t('control.msg_shot_alt'))}" loading="lazy"></a></div></div></div>`;
    }
    if (m.from === 'agent') {
      const lv = m.level === 'err' ? 'err' : m.level === 'ok' ? 'ok' : m.level === 'warn' ? 'warn' : 'info';
      const av = agentAvatar(store.agents.find((a) => a.name === m.name) || {});
      return `<div class="msg agent"${mid}><span class="agent-dot lv-${lv}"></span><div><div class="agent-name">${esc(av)} ${esc(m.name || t('control.msg_agent'))}<button class="mini-link" data-copy-answer>${esc(t('control.msg_copy'))}</button><span class="msg-time">${m.t ? esc(fmtTime(m.t)) : ''}</span></div><div class="bubble">${richText(m.text)}<div class="msg-actions"><button class="mini-btn" data-act="copy">${esc(t('control.msg_copy'))}</button><button class="mini-btn" data-act="speak">${esc(t('control.msg_speak'))}</button><button class="mini-btn" data-act="short">${esc(t('control.msg_short'))}</button><button class="mini-btn" data-act="resend-agent">${esc(t('control.msg_resend_agent'))}</button></div></div></div></div>`;
    }
    /* bot / sys: разрешаем ссылки из наших подсказок, остальное экранируем */
    const safe = esc(m.text).replace(/&lt;a href=&quot;([^&]*)&quot;&gt;(.*?)&lt;\/a&gt;/g, '<a href="$1">$2</a>');
    return `<div class="msg ${m.from === 'sys' ? 'sys' : 'bot'}"${mid}><div class="bubble">${safe}</div></div>`;
  }

  function heroHTML() {
    const sug = [
      [t('control.hero_sug_0'), t('control.hero_prefix_0')],
      [t('control.hero_sug_1'), t('control.hero_prefix_1')],
      [t('control.hero_sug_2'), t('control.hero_prefix_2')],
      [t('control.hero_sug_3'), t('control.hero_prefix_3')],
    ];
    return `<div class="gpt-hero">
      <div class="gpt-hero-mark">${icon('bot')}</div>
      <h2>${esc(t('control.hero_title'))}</h2>
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
  const welcome = () => bot(t('control.welcome', { status: statusSummary() }));

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
        const lang = (m[1] || t('control.code_lang')).slice(0, 20);
        html += `<div class="codeblock"><div class="code-head"><span>${esc(lang)}</span>`
          + `<button class="btn btn-mini btn-ghost" data-save-code>${esc(t('control.code_to_file'))}</button></div>`
          + `<pre><code>${esc(m[2].replace(/\n$/, ''))}</code></pre></div>`;
        last = m.index + m[0].length;
      }
      if (last < text.length) html += mdBlocks(text.slice(last));
      return html || mdBlocks(text);
    }
    if (text.length > COLLAPSE_AT) {
      return `<span class="clamp">${esc(text.slice(0, COLLAPSE_AT))}…</span>`
        + `<span class="fulltext" hidden>${mdBlocks(text)}</span>`
        + `<button class="link-btn" data-expand>${esc(t('control.expand_show'))}</button>`;
    }
    return mdBlocks(text);
  }

  /* Сохранение кода из чата в рабочую папку (только полный доступ) */
  function openSaveModal(code) {
    const m = openModal({
      kicker: t('control.save_kicker'),
      title: t('control.save_title'),
      body: `
        <div class="field"><label>${esc(t('control.save_label'))}</label>
          <input class="input mono" id="svPath" maxlength="180" placeholder="${esc(t('control.save_ph'))}" autocomplete="off"></div>
        <span class="field-hint">${esc(t('control.save_hint'))}</span>
        <div id="svRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${esc(t('control.save_cancel'))}</button>
               <button class="btn btn-primary" id="svGo">${icon('check')}${esc(t('control.save_go'))}</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#svGo').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#svGo');
      const resBox = m.modal.querySelector('#svRes');
      const p = (m.modal.querySelector('#svPath').value || '').trim();
      if (!p) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(t('control.save_need_path'))}</div>`;
        return;
      }
      btn.innerHTML = `<span class="spinner"></span>${esc(t('control.save_saving'))}`;
      btn.style.pointerEvents = 'none';
      try {
        const out = await api('/api/workspace/file', { method: 'POST', body: { path: p, content: code } });
        toast(out.created ? t('control.save_created_t') : t('control.save_overwrote_t'), out.path, 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}${esc(t('control.save_go'))}`;
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
    if (sel.kind === 'team') return t('control.recipient_team', { n: list.length });
    if (!list.length) return t('control.recipient_none');
    return t('control.recipient_list', { names: list.map((a) => a.name).join(', ') });
  }

  function renderTo() {
    const all = onlineAgents().length;
    const teamOn = sel.kind === 'team';
    const ids = new Set(sel.ids);
    toBar.innerHTML = `
      <button class="to-chip${teamOn ? ' on' : ''}" data-to="team">${icon('users')}${esc(t('control.to_all', { n: all }))}</button>
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
    statusEl.textContent = t('control.head_status', {
      team: store.team ? store.team.name : t('control.head_no_team'),
      online, total: store.agents.length,
    });
  }

  function updatePlaceholder() {
    input.placeholder = sel.kind === 'team' ? t('control.ph_team') : t('control.ph_multi');
  }

  /* ----------------------------------------------------- отправка задач */

  /* Ход работы виден в консоли выполнения; в чат падает только готовый ответ.
     Ошибки показываем сразу — их важно не пропустить. */

  function appendAgentLine(agent, ev) {
    /* Мысли вслух живут только в консоли; чат не засоряем */
    if (ev.type === 'think' || ev.type === 'tool') return;
    if (ev.type === 'step') {
      updateTyping(t('control.typing_step', {
        name: agent.name, step: ev.step,
        of: ev.of ? t('control.typing_of', { of: ev.of }) : '',
      }));
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
        ? t('control.agent_empty', { name: agent.name })
        : t('control.agent_done', { name: agent.name, tokens: ev.stats.tokens, steps: ev.stats.steps, seconds: ev.stats.seconds }));
    }
  }

  /* Индикатор «печатает…», пока агент работает; текст можно обновлять (шаги) */
  function showTyping(name) {
    hideTyping();
    thread.insertAdjacentHTML('beforeend',
      `<div class="msg agent" id="chatTyping"><span class="agent-dot lv-info"></span><div>`
      + `<div class="agent-name">${esc(t('control.typing', { name }))}</div>`
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
      bot(t('control.send_no_one'));
      return;
    }
    const refs = Array.isArray(fileRefs) ? fileRefs : [];
    const imgs = refs.filter((p) => IMG_RE.test(p));
    const fullTask = refs.length
      ? `${task}${t('control.files_suffix', { refs: refs.join(', ') })}${imgs.length ? t('control.files_suffix_vision') : ''}`
      : task;
    if (!quiet) push({ from: 'me', text: refs.length ? t('control.me_files', { task, files: refs.map((p) => p.split('/').pop()).join(', ') }) : task, images: imgs });
    sending = true;
    stopVoice();
    const ctrl = new AbortController();
    runCtrl = ctrl;
    paintSend();
    /* Остановка: объект сообщает об ошибке «Остановлено» — это норма, а не сбой */
    const onFail = (agentName) => (err) => {
      if (!err) return;
      hideTyping();
      if (err.stopped === true || String(err.message || err).includes('Остановлен')) {
        bot(t('control.stopped', { name: agentName }));
        return;
      }
      bot(t('control.start_fail', { name: agentName, err: err.message || err }));
    };
    try {
      const runId = `run_${Date.now().toString(36)}`;
      const onLine = (ev, agent) => appendAgentLine(agent || list[0], { ...ev, _run: runId });
      if (list.length === 1) {
        const agent = list[0];
        sys(t('control.sys_start_one', { name: agent.name, task }));
        showTyping(agent.name);
        await runAgent(agent, fullTask, { signal: ctrl.signal, attachments: refs, onLine: (ev) => onLine(ev, agent), onDone: onFail(agent.name) });
      } else {
        /* Несколько исполнителей всегда идут цепочкой: один общий итог вместо хора */
        sys(t('control.sys_start_chain', { names: list.map((a) => a.name).join(' → '), task }));
        showTyping(t('control.typing_team'));
        await runTeam(list, () => fullTask, { chain: true, signal: ctrl.signal, attachments: refs, onLine, onDone: (err, done, agent) => onFail(agent ? agent.name : t('control.msg_agent'))(err) });
      }
    } catch (e) {
      bot(t('control.run_fail', { err: e.message }));
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
      bot(t('control.need_model'));
      return;
    }
    const namedRole = named && named.role;
    const namedName = named && named.name;
    const valid = roleKeys.map((k) => ROLE_BY_WORD.get(String(k).toLowerCase())).filter(Boolean);
    if (!valid.length) {
      bot(t('control.unknown_roles', { roles: ROLES.map((r) => r.key).join(' ') }));
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
      bot(t('control.team_made', { name, agents: agents.map((a) => a.name).join(', ') }));
      toast(t('control.team_made_t'), t('control.team_made_d', { n: agents.length }), 'ok');
    } catch (e) {
      bot(t('control.team_fail', { err: e.message }));
    }
  }

  /* ------------------------------------------------------------- команды */

  async function handleCommand(raw) {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    /* English aliases → canonical commands (switch below stays Russian) */
    const canon = {
      status: 'статус', statistics: 'статистика', repeat: 'повтори',
      history: 'история', export: 'экспорт', find: 'найти', agents: 'агенты',
      clear: 'очистить', schedule: 'расписание', cancel: 'отмена', open: 'открой',
      pause: 'пауза', resume: 'включи', models: 'модели', services: 'сервисы',
      programs: 'пк', access: 'доступ', screen: 'экран',
    }[(cmd || '').toLowerCase()] || (cmd || '').toLowerCase();
    switch (canon) {
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
          ? t('control.together_on')
          : t('control.together_off'));
        return;
      case 'команда': {
        const parts = arg.split('|').map((s) => s.trim());
        if (parts.length < 1 || !parts[0]) {
          bot(t('control.team_format'));
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
        bot(t('control.models_card'));
        return;
      case 'сервисы':
      case 'соцсети':
      case 'соцсеть':
      case 'телеграм':
      case 'слак':
      case 'инстаграм':
      case 'тикток':
        bot(t('control.social_card'));
        return;
      case 'пк':
      case 'компьютер':
      case 'программы':
        bot(t('control.pc_card'));
        return;
      case 'mcp':
      case 'мсп':
      case 'мкп':
        bot(t('control.mcp_card'));
        return;
      case 'доступ':
      case 'телефон':
      case 'qr':
        bot(t('control.access_card'));
        return;
      case 'пин':
      case 'pin':
      case 'пароль':
        bot(t('control.pin_card'));
        return;
      case 'повтори':
      case 'повторить':
      case 'ещё':
      case 'еще': {
        const n = parseInt(arg, 10);
        const item = Number.isFinite(n) && n > 0 ? taskHistory[n - 1] : taskHistory[0];
        if (!item) {
          bot(t('control.repeat_empty'));
          return;
        }
        sendTask(item);
        return;
      }
      case 'история': {
        if (!taskHistory.length) {
          bot(t('control.history_empty'));
          return;
        }
        bot(t('control.history_head', { list: taskHistory.slice(0, 10).map((x, i) => `${i + 1}. ${x.slice(0, 90)}`).join('\n') }));
        return;
      }
      case 'цепочка':
      case 'chain':
      case 'вместе-цепочка': {
        const ctask = arg.trim();
        if (!ctask) {
          bot(t('control.chain_format'));
          return;
        }
        const chainList = selectedAgents();
        if (!chainList.length) {
          bot(t('control.chain_no_one'));
          return;
        }
        push({ from: 'me', text: `/цепочка ${ctask}` });
        sending = true;
        const chainCtrl = new AbortController();
        runCtrl = chainCtrl;
        paintSend();
        const chainFail = (agentName) => (err) => {
          if (!err) return;
          hideTyping();
          if (err.stopped === true || String(err.message || err).includes('Остановлен')) {
            bot(t('control.stopped', { name: agentName }));
            return;
          }
          bot(t('control.start_fail', { name: agentName, err: err.message || err }));
        };
        try {
          const runId = `run_${Date.now().toString(36)}`;
          sys(t('control.sys_start_chain', { names: chainList.map((a) => a.name).join(' → '), task: ctask }));
          showTyping(t('control.typing_team'));
          await runTeam(
            chainList,
            () => ctask,
            {
              chain: true,
              signal: chainCtrl.signal,
              onLine: (ev, agent) => appendAgentLine(agent || chainList[0], { ...ev, _run: runId }),
              onDone: (err, doneEv, agent) => chainFail(agent ? agent.name : t('control.msg_agent'))(err),
            },
          );
          bot(chainCtrl.signal.aborted ? t('control.chain_stopped') : t('control.chain_done'));
        } catch (e) {
          bot(t('control.run_fail', { err: e.message }));
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
        if (!messages.length) bot(t('control.export_empty'));
        else exportChat();
        return;
      case 'заметка':
      case 'запиши':
      case 'note': {
        const text = arg.trim();
        if (!text) {
          bot(t('control.note_format'));
          return;
        }
        try {
          const stamp = new Date().toLocaleString(localeTag(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const out = await api('/api/workspace/file', {
            method: 'POST',
            body: { path: 'notes/заметки.md', content: `## ${stamp}\n${text}`, append: true },
          });
          toast(t('control.note_done_t'), out.path, 'ok');
          sys(t('control.note_sys', { path: out.path }));
        } catch (e) {
          bot(t('control.note_fail', { err: e.message }));
        }
        return;
      }
      case 'найти':
      case 'поиск':
      case 'где': {
        const q = arg.trim().toLowerCase();
        if (!q) {
          bot(t('control.find_format'));
          return;
        }
        hideTyping();
        const els = [...thread.querySelectorAll('.msg')].filter((el) => el.id !== 'chatTyping');
        let hit = -1;
        for (let i = 0; i < els.length && i < messages.length; i++) {
          if (String(messages[i].text || messages[i].name || '').toLowerCase().includes(q)) { hit = i; break; }
        }
        if (hit < 0 || !els[hit]) {
          bot(t('control.find_notfound', { q: arg.trim().slice(0, 60) }));
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
        const rows = store.agents.map((a) => t('control.agents_row', { dot: a.status === 'offline' ? '⚫' : '🟢', name: a.name, role: a.role, model: a.model }));
        bot(rows.length ? t('control.agents_head', { team: (store.team || {}).name || '', rows: rows.join('\n') }) : t('control.agents_empty'));
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
          const totals = (runs && runs.totals) || {};
          const usd = Number(totals.costUsd || 0);
          const recent = ((runs && runs.recent) || []).slice(0, 3)
            .map((r) => t('control.stats_line', { name: r.agentName || '?', task: String(r.task || '').slice(0, 50), status: r.status, tokens: r.usage ? r.usage.totalTokens : 0 }))
            .join('\n');
          bot(t('control.stats_head', {
            runs: totals.runs || 0, ok: totals.ok || 0, tokens: totals.totalTokens || 0,
            usd: usd.toFixed(4),
            recent: recent ? t('control.stats_recent', { list: recent }) : t('control.stats_no_runs'),
          }));
        } catch (e) {
          bot(t('control.stats_fail', { err: e.message }));
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
          bot(t('control.sched_format'));
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
            bot(t('control.sched_empty'));
            return;
          }
          bot(t('control.sched_head', {
            list: list.map((s) => t('control.sched_row', {
              id: s.id.slice(-4),
              when: s.kind === 'every' ? t('control.sched_every', { n: s.everyMin }) : t('control.sched_daily', { at: s.at }),
              state: s.enabled ? t('control.sched_on') : t('control.sched_off'),
              task: String(s.task).slice(0, 60),
            })).join('\n'),
          }));
        } catch (e) {
          bot(t('control.stats_fail', { err: e.message }));
        }
        return;
      }
      case 'отмена':
      case 'убрать-расписание': {
        const id = arg.trim();
        if (!id) {
          bot(t('control.cancel_format'));
          return;
        }
        try {
          const out = await getSchedules();
          const hit = (out.schedules || []).find((s) => s.id === id || s.id.endsWith(id));
          if (!hit) {
            bot(t('control.cancel_notfound', { id }));
            return;
          }
          await removeSchedule(hit.id);
          bot(t('control.cancel_removed', { task: String(hit.task).slice(0, 60) }));
        } catch (e) {
          bot(t('control.stats_fail', { err: e.message }));
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
          sys(t('control.shot_sys'));
          const out = await api('/api/browser/shot', { method: 'POST', body: {} });
          push({ from: 'img', name: t('control.shot_name'), shot: out.path.split('/').pop() });
        } catch (e) {
          bot(t('control.shot_fail', { err: e.message }));
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
        bot(t('control.tg_card'));
        return;
      default:
        bot(t('control.cmd_unknown', { cmd, help: HELP_TEXT }));
    }
  }

  function quickAction(id) {
    switch (id) {
      case 'task':
        input.focus();
        input.placeholder = t('control.task_hint_ph');
        return;
      case 'together':
        handleCommand('/вместе');
        return;
      case 'chain':
        bot(t('control.chain_hint'));
        input.focus();
        return;
      case 'team':
        bot(t('control.team_hint'));
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

  const fmtSize = (n) => (n >= 1048576 ? t('control.size_mb', { n: (n / 1048576).toFixed(1) }) : t('control.size_kb', { n: Math.max(1, Math.round(n / 1024)) }));

  function renderAttachRow() {
    attachRow.hidden = !pendingFiles.length;
    attachRow.innerHTML = pendingFiles.map((f, i) => {
      const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '');
      const thumb = isImg && f._url ? `<img class="attach-thumb" src="${f._url}" alt="">` : '';
      return `
      <span class="chip chip-removable" style="--chip-c:var(--cyan)">${thumb}${esc(f.name)} · ${fmtSize(f.size)}
        <button type="button" data-unfile="${i}" aria-label="${esc(t('control.remove_file_aria'))}">${icon('x')}</button></span>`;
    }).join('');
  }

  page.querySelector('#chatAttach').addEventListener('click', () => fileInput.click());
  function addFiles(list) {
    for (const f of list) {
      if (f.size > MAX_FILE_MB * 1048576) {
        toast(t('control.file_big_t'), t('control.file_big_d', { name: f.name, max: MAX_FILE_MB }), 'warn');
        continue;
      }
      if (pendingFiles.length >= 5) {
        toast(t('control.files_limit_t'), t('control.files_limit_d'), 'warn');
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
      toast(t('control.files_added_t'), t('control.files_added_d', { n: e.dataTransfer.files.length }), 'ok');
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
    ['/компания', t('control.slash_company')],
    ['/цепочка', t('control.slash_chain')],
    ['/вместе', t('control.slash_together')],
    ['/команда', t('control.slash_team')],
    ['/исследуй', t('control.slash_research')],
    ['/повтори', t('control.slash_repeat')],
    ['/история', t('control.slash_history')],
    ['/найти', t('control.slash_find')],
    ['/экспорт', t('control.slash_export')],
    ['/заметка', t('control.slash_note')],
    ['/статус', t('control.slash_status')],
    ['/агенты', t('control.slash_agents')],
    ['/расписание', t('control.slash_sched')],
    ['/подключить', t('control.slash_connect')],
    ['/модели', t('control.slash_models')],
    ['/пк', t('control.slash_pc')],
    ['/mcp', t('control.slash_mcp')],
    ['/доступ', t('control.slash_access')],
    ['/очистить', t('control.slash_clear')],
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
    [t('control.ai_explain'), t('control.ai_prefix_explain')],
    [t('control.ai_shorten'), t('control.ai_prefix_shorten')],
    [t('control.ai_review'), t('control.ai_prefix_review')],
    [t('control.ai_translate'), t('control.ai_prefix_translate')],
    [t('control.ai_plan'), t('control.ai_prefix_plan')],
    [t('control.ai_fact'), t('control.ai_prefix_fact')],
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
    toast(on ? t('control.focus_on_t') : t('control.focus_off_t'), on ? t('control.focus_on_d') : t('control.focus_off_d'), 'ok');
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
    r.onerror = () => reject(new Error(t('control.read_fail')));
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
      toast(t('control.files_up_t'), t('control.files_up_d', { n: refs.length }), 'ok');
      await sendTaskInner(text || t('control.files_default_task'), refs);
    } catch (err) {
      bot(t('control.files_fail', { err: err.message }));
    } finally {
      sending = false;
      paintSend();
    }
  }

  /* Делегирование кликов в ленте: действия сообщений (sug — отдельным слушателем выше) */

  const SUG_PREFIX = [
    t('control.hero_prefix_0'),
    t('control.hero_prefix_1'),
    t('control.hero_prefix_2'),
    t('control.hero_prefix_3'),
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
        try { await navigator.clipboard.writeText(text); toast(t('control.copied_t'), t('control.copied_d'), 'ok'); }
        catch { toast(t('control.copy_fail_t'), t('control.copy_fail_d'), 'err'); }
      } else if (act === 'edit' && m && m.from === 'me') {
        input.value = text;
        autogrow();
        input.focus();
        toast(t('control.edit_t'), t('control.edit_d'), 'ok');
      } else if (act === 'resend' && text) {
        input.value = text;
        autogrow();
        form.requestSubmit();
      } else if (act === 'resend-agent' && taskHistory[0]) {
        sendTask(taskHistory[0]);
      } else if (act === 'speak' && text) {
        try {
          if (!('speechSynthesis' in window)) { toast(t('control.novoice_t'), t('control.novoice_d1'), 'warn'); }
          else {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
            u.lang = localeTag();
            window.speechSynthesis.speak(u);
          }
        } catch { /* игнор */ }
      } else if (act === 'short' && text) {
        input.value = t('control.short_prefix', { text: text.slice(0, 1500) });
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
        toast(t('control.copied_t'), t('control.answer_d'), 'ok');
      } catch {
        toast(t('control.copy_fail_t'), t('control.copy_fail_d'), 'err');
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
      exp.textContent = opening ? t('control.expand_hide') : t('control.expand_show');
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
    const th = toggleTheme();
    e.currentTarget.title = th === 'light' ? t('control.theme_dark') : t('control.theme_light');
  });

  /* Переключатель языка EN/RU/中文 */
  page.querySelector('#ctlLang').addEventListener('click', () => {
    toast(t('control.lang_t'), t('control.lang_d', { lang: langName(nextLang()) }), 'ok');
    setTimeout(() => setLang(nextLang()), 450);
  });

  /* Озвучка готовых ответов (синтез речи браузера, ничего не отправляется) */
  let voiceOn = false;
  try { voiceOn = localStorage.getItem('nexus_voice') === '1'; } catch { voiceOn = false; }
  const voiceBtn = page.querySelector('#ctlVoice');
  const paintVoice = () => {
    voiceBtn.setAttribute('aria-pressed', String(voiceOn));
    voiceBtn.style.color = voiceOn ? 'var(--cyan)' : '';
    voiceBtn.title = voiceOn ? t('control.voice_title_off') : t('control.voice_title_on');
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
    else if (!('speechSynthesis' in window)) toast(t('control.novoice_t'), t('control.novoice_d2'), 'warn');
    paintVoice();
  });
  function speak(text) {
    if (!voiceOn) return;
    try {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 1200));
      u.lang = localeTag();
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
        ? t('control.browser_on', { info: st.title || st.url || t('control.browser_open') })
        : t('control.browser_off');
    } catch {
      dot.classList.remove('on');
    }
  }
  async function showBrowser() {
    try {
      const out = await api('/api/browser/show', { method: 'POST', body: {} });
      sys(out.url && out.url !== 'about:blank'
        ? t('control.browser_shown', { title: out.title || out.url })
        : t('control.browser_blank'));
      toast(t('control.browser_toast_t'), out.title || out.url || t('control.browser_toast_d'), 'ok');
    } catch (e) {
      bot(t('control.browser_fail', { err: e.message }));
    }
    refreshBrowserDot();
  }
  page.querySelector('#ctlBrowser').addEventListener('click', showBrowser);

  /* Очистка переписки на этом устройстве (запуски и журнал не трогаем) */
  async function clearChat() {
    const ok = await confirmDialog({
      kicker: t('control.clear_kicker'),
      title: t('control.clear_title'),
      text: t('control.clear_text'),
      okText: t('control.clear_ok'),
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
      if (!taskHistory.length) toast(t('control.regen_empty_t'), t('control.regen_empty_d'), 'warn');
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
      bot(t('control.open_format', { names: names || t('control.open_none') }));
      return;
    }
    const found = store.programs.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(q));
    if (!found.length) {
      bot(t('control.open_notfound', { q: arg }));
      return;
    }
    if (found.length > 1) {
      bot(t('control.open_multi', { names: found.map((p) => p.name).join(', ') }));
      return;
    }
    try {
      const out = await api(`/api/programs/${encodeURIComponent(found[0].id)}/open`, { method: 'POST', body: {} });
      sys(t('control.sys_opening', { name: out.name }));
      toast(t('control.prog_started_t'), out.name, 'ok');
    } catch (e) {
      bot(t('control.prog_fail', { err: e.message }));
    }
  }

  /* Глубокое исследование темы: волны поиска → первоисточники → отчёт в файл */
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'tema';

  async function deepResearch(arg) {
    const topic = (arg || '').trim();
    if (!topic) {
      bot(t('control.research_format'));
      return;
    }
    const online = store.agents.filter((a) => a.status !== 'offline');
    if (!online.length) {
      bot(t('control.research_no_one'));
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
      ? t('control.rs_extra', { tools: extra.join(', ') })
      : t('control.rs_noextra');
    const fileName = `research/${slugify(topic)}.md`;
    const task = t('control.rs_task', {
      topic,
      searchLine,
      srcPart: full ? t('control.rs_src_full') : t('control.rs_src_snip'),
      savePart: full ? t('control.rs_save_file', { file: fileName }) : t('control.rs_save_chat'),
    });
    const prevSel = sel;
    sel = { kind: 'agents', ids: [agent.id] };
    renderTo();
    bot(t('control.research_assigned', {
      topic, agent: agent.name,
      dest: full ? t('control.research_dest_file', { file: fileName }) : t('control.research_dest_chat'),
    }));
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
      bot(t('control.agent_format', {
        cmd: status === 'offline' ? '/пауза' : '/включи',
        example: store.agents[0] ? store.agents[0].name : t('control.agent_atlas'),
      }));
      return;
    }
    const hit = store.agents.filter((a) => `${a.name} ${a.role} ${a.id}`.toLowerCase().includes(q));
    if (!hit.length) {
      bot(t('control.agent_notfound', { q: arg.trim() }));
      return;
    }
    if (hit.length > 1) {
      bot(t('control.agent_multi', { names: hit.map((a) => a.name).join(', ') }));
      return;
    }
    try {
      await saveAgent({ ...hit[0], status });
      toast(hit[0].name, status === 'offline' ? t('control.agent_paused') : t('control.agent_back'), status === 'offline' ? 'warn' : 'ok');
    } catch (e) {
      bot(t('control.stats_fail', { err: e.message }));
    }
  }

  /* Добавление расписания: /каждый 30м задача или ежедневно в 09:00 */
  async function addScheduleCmd(arg, at) {
    const text = (arg || '').trim();
    if (!text) {
      bot(t('control.sched_format'));
      return;
    }
    let kind;
    let everyMin;
    let dailyAt = at || null;
    let task = text;
    if (!dailyAt) {
      const m = /(\d+)\s*(м|мин|минут|ч|час|h|m)(?![a-zа-яё0-9])/i.exec(text);
      if (!m) {
        bot(t('control.sched_bad'));
        return;
      }
      const n = Number(m[1]);
      everyMin = /^(ч|час|h)$/i.test(m[2]) ? n * 60 : n;
      if (everyMin < 5 || everyMin > 10080) {
        bot(t('control.sched_range'));
        return;
      }
      task = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
      kind = 'every';
    } else {
      kind = 'daily';
    }
    if (!task) {
      bot(t('control.sched_no_task'));
      return;
    }
    const only = sel.kind === 'agents' && sel.ids.length === 1 ? sel.ids[0] : null;
    try {
      const out = await saveSchedule({ kind, everyMin, at: dailyAt, task: task.slice(0, 500), targetAgentId: only });
      const s = out.schedule;
      bot(t('control.sched_saved', {
        id: s.id.slice(-4),
        when: kind === 'every' ? t('control.sched_every', { n: s.everyMin }) : t('control.sched_daily', { at: s.at }),
        task: task.slice(0, 80),
      }));
    } catch (e) {
      bot(t('control.sched_fail', { err: e.message }));
    }
  }

  /* Выгрузка переписки в Markdown-файл */
  function exportChat() {
    const line = (m) => {
      if (m.from === 'img') return t('control.export_img', { name: m.name || t('control.msg_screen'), shot: m.shot });
      const who = m.from === 'me' ? t('control.export_you') : m.from === 'agent' ? (m.name || t('control.export_agent')) : m.from === 'sys' ? t('control.export_sys') : 'NEXUS';
      return `### ${who}\n\n${String(m.text || '').slice(0, 4000)}\n`;
    };
    const md = t('control.export_head', { date: new Date().toLocaleString(localeTag()), body: messages.map(line).join('\n') });
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(t('control.export_t'), t('control.export_d'), 'ok');
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
      rec.lang = localeTag();
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
      const totals = (runs && runs.totals) || {};
      const tokens = totals.totalTokens || 0;
      const usd = Number(totals.costUsd) || 0;
      const compact = tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
      statusEl.innerHTML = `${esc(statusSummary())} · <b class="tok">${esc(t('control.totals_tok', { c: compact, usd: usd.toFixed(4) }))}</b>`;
      statusEl.title = t('control.totals_title', { runs: totals.runs || 0, ok: totals.ok || 0, tokens, usd: usd.toFixed(4) });
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
