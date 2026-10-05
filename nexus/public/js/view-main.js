/* NEXUS — вид «Команда»: герой, сетка агентов, лента, шторка агента */

import {
  esc, icon, avatarOrb, agentAvatar, AVATARS, statusPill, sparkSVG, countUp, tilt, stagger,
  toast, confirmDialog, openModal, fmtInt, fmtCompact, fmtTime, relTime, roleMeta,
  DEFAULT_TASKS, reducedMotion, fmtBytes, fmtUptime, fmtUsd, loadLevel, safeAccent,
} from './ui.js';
import { store, bus, saveTeam, saveAgent, removeAgent, refreshMetrics, refreshRag, getKb } from './store.js';
import { runAgent, runTeam, agentHistory, setAgent, logSys } from './console.js';

const STATUS_RU = { online: 'онлайн', busy: 'занят', offline: 'офлайн' };

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  let teamRunning = false;
  let renameHandler = null;

  /* ------------------------------------------------------------ разметка */

  function heroHTML() {
    const t = store.team;
    const online = store.agents.filter((a) => a.status !== 'offline').length;
    return `
      ${store.offline ? `<div class="banner banner-warn">${icon('alert')}<div><b>Офлайн-режим.</b> Данные взяты из локального кэша, изменения сохранятся после восстановления связи.</div><button class="btn btn-mini" data-retry>Повторить</button></div>` : ''}
      <section class="hero">
        <div class="hero-main">
          <div class="hero-eyebrow mono">
            <span class="pulse-dot" data-state="${store.offline ? 'down' : 'ok'}"></span>
            СИСТЕМА ${store.offline ? 'В АВАРИЙНОМ РЕЖИМЕ' : 'АКТИВНА'}
            <span class="sep">·</span> УЗЕЛ NEXUS-01
            <span class="sep">·</span> МИССИЯ: ${esc((t.mission || '').toUpperCase())}
          </div>
          <div class="hero-title-row">
            <h1 id="teamName">${esc(t.name)}</h1>
            <button class="icon-btn" id="renameBtn" aria-label="Переименовать команду">${icon('pencil')}</button>
          </div>
          <p class="hero-desc">${esc(t.description || '')}</p>
          <div class="hero-root mono" title="Рабочая папка команды — все файлы агентов создаются здесь">папка: ${esc(t.workspace || 'общая папка узла')}
            <button class="icon-btn" id="rootBtn" aria-label="Сменить рабочую папку команды" style="width:26px;height:26px">${icon('pencil')}</button>
          </div>
          <div class="hero-actions">
            <button class="btn btn-primary" id="runTeamBtn">${icon('play')}<span>Запустить команду</span></button>
            <select class="select" id="runMode" aria-label="Режим запуска команды" style="max-width:190px">
              <option value="chain">цепочка → один итог</option>
              <option value="parallel">каждый сам по себе</option>
            </select>
            <a class="btn btn-ghost" href="#/constructor">${icon('plus')}Новая команда</a>
            <a class="btn btn-ghost" href="#/connect">${icon('sliders')}Подключения</a>
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat" style="--stat-c:var(--lime)">
            <span class="stat-num" id="stOnline">0</span>
            <span class="stat-label">агентов онлайн</span>
            <i class="stat-hint" id="stOnlineHint">из ${store.agents.length} в команде</i>
          </div>
          <div class="stat" style="--stat-c:var(--cyan)">
            <span class="stat-num" id="stDone">0</span>
            <span class="stat-label">задач выполнено</span>
            <i class="stat-hint">за всё время</i>
          </div>
          <div class="stat" style="--stat-c:var(--violet)">
            <span class="stat-num" id="stTokens">0</span>
            <span class="stat-label">токенов</span>
            <i class="stat-hint">израсходовано</i>
          </div>
          <div class="stat" style="--stat-c:var(--amber)">
            <span class="stat-num" id="stBudget">0</span>
            <span class="stat-label">бюджет шагов</span>
            <i class="stat-hint">на пакет задач</i>
          </div>
        </div>
      </section>`;
  }

  function cardHTML(a) {
    const meta = roleMeta(a.roleKey);
    const svc = a.permissions.services.map((id) => {
      const s = store.services.find((x) => x.id === id);
      return s ? `<span class="chip" style="--chip-c:${s.status === 'connected' ? 'var(--lime)' : 'var(--text-3)'}"><i></i>${esc(s.name)}</span>` : '';
    }).slice(0, 3).join('');
    const mcp = a.permissions.mcp.map((id) => {
      const m = store.mcp.find((x) => x.id === id);
      return m ? `<span class="chip" style="--chip-c:var(--violet)"><i></i>${esc(m.name)}</span>` : '';
    }).slice(0, 2).join('');
    const task = a.currentTask && a.currentTask !== 'готов к задаче'
      ? a.currentTask
      : `готов к задаче · ${DEFAULT_TASKS[a.roleKey] || 'выполнить задачу команды'}`;
    return `
      <article class="agent-card" data-agent="${esc(a.id)}" tabindex="0" role="button"
        aria-label="Агент ${esc(a.name)}, ${esc(a.role)}, ${STATUS_RU[a.status] || a.status}. Открыть панель"
        style="--accent:${safeAccent(a.accent || meta.accent)};--accent2:${esc(meta.accent2)}">
        <header class="ac-head">
          ${avatarOrb(a)}
          <div class="ac-id">
            <h3>${esc(agentAvatar(a))} ${esc(a.name)}</h3>
            <span class="ac-role mono">${esc(a.role)} · ${esc(a.roleKey)}</span>
          </div>
          ${statusPill(a.status)}
        </header>
        <div class="ac-task">
          <span class="task-label mono">текущая задача</span>
          <div class="ticker"><div class="ticker-in"><span>${esc(task)}</span><span>${esc(task)}</span></div></div>
        </div>
        <div class="ac-chips">${svc}${mcp}${a.permissions.programs.length ? `<span class="chip" style="--chip-c:var(--blue)"><i></i>пк:${a.permissions.programs.length}</span>` : ''}</div>
        <footer class="ac-foot">
          ${sparkSVG(a)}
          <span class="ac-model mono" title="${esc(a.model)}">${esc(a.model)}</span>
          <button class="btn btn-mini btn-run" data-run="${esc(a.id)}" ${a.status === 'offline' ? 'disabled' : ''}>${icon('play')}${a.status === 'busy' ? 'занят' : 'запустить'}</button>
        </footer>
      </article>`;
  }

  function emptyHTML() {
    return `
      <div class="empty">
        <div class="empty-icon">${icon('users')}</div>
        <h3>В команде пока нет агентов</h3>
        <p>Соберите экипаж в конструкторе: выберите роли, настройте разрешения и оркестрацию — старт за четыре шага.</p>
        <a class="btn btn-primary" href="#/constructor">${icon('plus')}Создать команду</a>
      </div>`;
  }

  function feedHTML() {
    const items = store.events.slice(0, 8).map((e) => `
      <li class="tl-item" data-kind="${esc(e.kind || 'system')}">
        <span class="tl-time mono">${fmtTime(e.t)} · ${relTime(e.t)}</span>
        <span class="tl-text">${esc(e.text)}</span>
      </li>`).join('') || '<li class="tl-text dim">Событий пока нет.</li>';
    return `
      <section class="panel feed" aria-label="Лента событий">
        <h3>Лента событий</h3>
        <div class="feed-note mono">журнал системы · последние ${Math.min(8, store.events.length)}</div>
        <ul class="timeline">${items}</ul>
      </section>`;
  }

  function sysMeter(label, pct, detail, color) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    const lv = loadLevel(v);
    const c = lv === 'lv-crit' ? 'var(--rose)' : lv === 'lv-warn' ? 'var(--amber)' : color;
    return `
      <div class="meter-row">
        <div class="meter-top"><span>${esc(label)}</span><b>${esc(detail)}</b></div>
        <div class="meter ${lv}"><i style="--m-c:${c};width:${v}%"></i></div>
      </div>`;
  }

  /* База знаний RAG: что видит агент в рабочей папке. */
  function ragHTML() {
    const r = store.rag;
    const body = r
      ? `<div class="meter-row"><div class="meter-top"><span>файлов / кусков</span><b>${fmtInt(r.files)} / ${fmtInt(r.chunks)}</b></div>`
        + `<div class="meter"><i style="--m-c:var(--cyan);width:${Math.min(100, (r.files / 200) * 100)}%"></i></div></div>
        <div class="meter-row"><div class="meter-top"><span>папка</span><b class="mono" style="font-size:10.5px">${esc(String(r.root || '').split(/[\\/]/).slice(-2).join('/'))}</b></div></div>`
      : '<div class="meter-row"><div class="meter-top"><span>сканирую папку…</span></div><div class="meter"><i style="--m-c:var(--cyan);width:35%"></i></div></div>';
    return `
      <section class="panel mini-panel" aria-label="База знаний">
        <h3>База знаний</h3>
        ${body}
        <span class="field-hint">Агенты спрашивают её инструментом rag_search, а похожие куски подкладываются в промпт сами.</span>
      </section>`;
  }

  function railHTML() {
    return feedHTML() + ragHTML() + metersHTML();
  }

  function metersHTML() {    const total = store.agents.length || 1;
    const online = store.agents.filter((a) => a.status !== 'offline').length;
    const svcOk = store.services.filter((s) => s.status === 'connected').length;
    const mcpOk = store.mcp.filter((m) => m.status === 'connected').length;
    const budget = (store.team && store.team.budgetSteps) || 0;

    /* Реальные данные с узла: os.loadavg/CPU, память, диск, аптайм. */
    const m = store.metrics;
    const n = m && m.node ? m.node : null;
    const sys = n ? `
      <h3 class="mt">Узел ${esc(n.host.hostname || '')}</h3>
      ${sysMeter('процессор', n.cpu.pct, `${n.cpu.cores} ядра · ${n.cpu.pct}%`, 'var(--cyan)')}
      ${sysMeter('память', n.memory.usedPct, `${fmtBytes(n.memory.used)} / ${fmtBytes(n.memory.total)}`, 'var(--violet)')}
      ${sysMeter(`диск ${esc(n.disk.fs || '')}`, n.disk.usedPct, `${fmtBytes(n.disk.free)} свободно`, 'var(--amber)')}
      <div class="meter-row">
        <div class="meter-top"><span>аптайм узла</span><b>${esc(fmtUptime(n.host.uptimeSec))}</b></div>
        <div class="meter"><i style="--m-c:var(--lime);width:100%"></i></div>
      </div>
      <div class="meter-row">
        <div class="meter-top"><span>память процесса</span><b>${esc(fmtBytes(n.process.rss))}</b></div>
        <div class="meter"><i style="--m-c:var(--blue);width:${Math.min(100, (n.process.rss / n.memory.total) * 100)}%"></i></div>
      </div>` : '';

    const stats = (m && m.stats && m.stats.totals) || null;
    const runBlock = stats ? `
      <h3 class="mt">Прогоны</h3>
      <div class="meter-row">
        <div class="meter-top"><span>успешно / всего</span><b>${stats.ok} / ${stats.runs}</b></div>
        <div class="meter"><i style="--m-c:var(--lime);width:${stats.runs ? (stats.ok / stats.runs) * 100 : 0}%"></i></div>
      </div>
      <div class="meter-row">
        <div class="meter-top"><span>токены</span><b>${esc(fmtCompact(stats.totalTokens || 0))}</b></div>
        <div class="meter"><i style="--m-c:var(--cyan);width:100%"></i></div>
      </div>
      <div class="meter-row">
        <div class="meter-top"><span>стоимость</span><b>${esc(fmtUsd(stats.costUsd || 0))}</b></div>
        <div class="meter"><i style="--m-c:var(--violet);width:100%"></i></div>
      </div>` : '';

    return `
      <section class="panel mini-panel" aria-label="Показатели системы">
        <h3>Пульс системы</h3>        <canvas class="pulse-canvas" id="pulseCanvas" width="260" height="46" aria-label="История нагрузки CPU и памяти"></canvas>
        <div class="pulse-legend mono"><span class="lg-cpu">— cpu</span><span class="lg-mem">— mem</span><span class="lg-v" id="pulseVal"></span></div>
        ${sys || '<div class="meter-row"><div class="meter-top"><span>загрузка узла…</span></div><div class="meter"><i style="--m-c:var(--cyan);width:35%"></i></div></div>'}
        ${runBlock}
        <h3 class="mt">Экипаж</h3>
        <div class="meter-row">
          <div class="meter-top"><span>экипаж в сети</span><b>${online} / ${store.agents.length}</b></div>
          <div class="meter"><i style="--m-c:var(--lime);width:${(online / total) * 100}%"></i></div>
        </div>
        <div class="meter-row">
          <div class="meter-top"><span>сервисы</span><b>${svcOk} / ${store.services.length}</b></div>
          <div class="meter"><i style="--m-c:var(--cyan);width:${(svcOk / Math.max(1, store.services.length)) * 100}%"></i></div>
        </div>
        <div class="meter-row">
          <div class="meter-top"><span>mcp-серверы</span><b>${mcpOk} / ${store.mcp.length}</b></div>
          <div class="meter"><i style="--m-c:var(--violet);width:${(mcpOk / Math.max(1, store.mcp.length)) * 100}%"></i></div>
        </div>
        <div class="meter-row">
          <div class="meter-top"><span>бюджет шагов</span><b>${budget}</b></div>
          <div class="meter"><i style="--m-c:var(--amber);width:${Math.min(100, (budget / 500) * 100)}%"></i></div>
        </div>
      </section>`;
  }

  function noTeamHTML() {
    return `
      <section class="hero">
        <div class="hero-main">
          <div class="hero-eyebrow mono">
            <span class="pulse-dot" data-state="wait"></span>
            КОМАНДА НЕ НАЙДЕНА
          </div>
          <div class="hero-title-row"><h1 id="teamName">Нет команды</h1></div>
          <p class="hero-desc">Файл команды отсутствует или повреждён. Создайте новую команду в конструкторе — это займёт минуту.</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#/constructor">${icon('plus')}<span>Создать команду</span></a>
            <button class="btn btn-ghost" id="noTeamRetry">${icon('refresh')}<span>Обновить</span></button>
          </div>
        </div>
      </section>`;
  }

  function render(animate = true) {
    /* Нет команды (битый team.json и т.п.) — дружелюбный экран вместо краша */
    if (!store.team) {
      page.innerHTML = noTeamHTML();
      page.querySelector('#noTeamRetry')?.addEventListener('click', () => window.location.reload());
      return;
    }
    const grid = store.agents.length
      ? `<div class="agent-grid" id="agentGrid">${store.agents.map(cardHTML).join('')}</div>`
      : emptyHTML();
    page.innerHTML = `
      ${heroHTML()}
      <div class="main-grid">
        <div>
          <div class="sec-head">
            <div>
              <div class="kicker">экипаж <span class="k-dim">/ ${store.agents.length} агентов</span></div>
              <h2>Состав команды</h2>
            </div>
            <span class="sec-note">клик по карточке → панель агента</span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="addAgentBtn">${icon('plus')}Новый агент</button>
          </div>
          </div>
          ${grid}
        </div>
        <aside class="rail">
          ${railHTML()}
        </aside>
      </div>`;

    if (animate && !reducedMotion) stagger(page.querySelector('.agent-grid'));
    updateStats(!animate);
    wireCards();
    wireHero();
    page.querySelector('#addAgentBtn')?.addEventListener('click', openAgentModal);
    checkTickers();
  }

  function checkTickers() {
    page.querySelectorAll('.ticker').forEach((t) => {
      const inner = t.querySelector('.ticker-in');
      if (inner.scrollWidth / 2 > t.clientWidth - 6) t.classList.add('scroll');
    });
  }

  function updateStats(instant) {
    const t = store.team || { tasksCompleted: 0, tokens: 0, budgetSteps: 0 };
    const online = store.agents.filter((a) => a.status !== 'offline').length;
    const done = { el: page.querySelector('#stDone') };
    if (!done.el) return;
    const set = (id, val, fmt) => {
      const el = page.querySelector(id);
      if (!el) return;
      if (instant) el.textContent = fmt(val);
      else countUp(el, val, { format: fmt });
    };
    set('#stOnline', online, (v) => fmtInt(v));
    set('#stDone', t.tasksCompleted, (v) => fmtInt(v));
    set('#stTokens', t.tokens, (v) => fmtCompact(v));
    set('#stBudget', t.budgetSteps, (v) => fmtInt(v));
    const hint = page.querySelector('#stOnlineHint');
    if (hint) hint.textContent = `из ${store.agents.length} в команде`;
  }

  /* ------------------------------------------------------------ события */

  function wireHero() {
    const retry = page.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => window.location.reload());

    page.querySelector('#renameBtn')?.addEventListener('click', startRename);
    page.querySelector('#rootBtn')?.addEventListener('click', changeRoot);

    const runBtn = page.querySelector('#runTeamBtn');
    runBtn?.addEventListener('click', async () => {
      if (teamRunning) return;
      const list = store.agents.filter((a) => a.status !== 'offline');
      if (!list.length) { toast('Некого запускать', 'В команде нет активных агентов', 'warn'); return; }
      const chain = page.querySelector('#runMode')?.value === 'chain';
      teamRunning = true;
      runBtn.classList.add('btn-busy');
      runBtn.innerHTML = `<span class="spinner"></span><span>Выполняется…</span>`;
      logSys(chain
        ? `цепочка: ${list.map((a) => a.name).join(' → ')} — один общий итог в конце`
        : `пакетный запуск: ${list.length} агентов`);
      await runTeam(list, (a) => DEFAULT_TASKS[a.roleKey] || 'выполнить задачу команды', { chain });
      teamRunning = false;
      const btn = page.querySelector('#runTeamBtn');
      if (btn) {
        btn.classList.remove('btn-busy');
        btn.innerHTML = `${icon('play')}<span>Запустить команду</span>`;
      }
      toast('Пакет завершён', `Команда выполнила задачи: ${list.length} агентов`, 'ok');
      updateStats(false);
    });
  }

  function startRename() {
    const h1 = page.querySelector('#teamName');
    if (!h1 || page.querySelector('.rename-input')) return;
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = store.team.name;
    input.setAttribute('aria-label', 'Название команды');
    input.maxLength = 60;
    h1.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      const el = document.createElement('h1');
      el.id = 'teamName';
      el.textContent = value || store.team.name;
      input.replaceWith(el);
      if (save && value && value !== store.team.name) {
        saveTeam({ name: value })
          .then(() => toast('Название обновлено', `Команда теперь «${value}»`, 'ok'))
          .catch((e) => {
            el.textContent = store.team.name;
            toast('Не удалось сохранить', e.message, 'err');
          });
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    renameHandler = finish;
  }

  /* Окно быстрого создания агента: имя, роль, аватар, модель, промпт. */
  function openAgentModal() {
    if (store.agents.length >= 12) {
      toast('Больше нельзя', 'Максимум 12 агентов в команде', 'warn');
      return;
    }
    const m = openModal({
      kicker: 'новый агент',
      title: 'Агент в команду',
      body: `
        <div class="field-row">
          <div class="field" style="flex:0 0 110px"><label>аватар</label>
            <select class="select" id="naAvatar">${AVATARS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></div>
          <div class="field" style="flex:1 1 auto"><label>имя</label>
            <input class="input" id="naName" maxlength="40" placeholder="например: Архимед" autocomplete="off"></div>
        </div>
        <div class="field" style="margin-top:12px"><label>роль</label>
          <select class="select" id="naRole">${['dev', 'research', 'editor', 'analyst', 'devops', 'assistant', 'tester', 'designer'].map((k) => { const r = roleMeta(k); return `<option value="${k}">${r.avatar || ''} ${r.name} — ${r.desc}</option>`; }).join('')}</select></div>
        <div class="field" style="margin-top:12px"><label>модель</label>
          <input class="input mono" id="naModel" maxlength="60" value="gpt-5.2-mini" placeholder="id модели из подключённого провайдера" autocomplete="off"></div>
        <div class="field" style="margin-top:12px"><label>системный промпт</label>
          <textarea class="textarea" id="naPrompt" rows="3" maxlength="2000" placeholder="Характер и правила агента (необязательно)"></textarea></div>
        <div id="naRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="naSave">${icon('plus')}Добавить</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#naSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#naSave');
      const resBox = m.modal.querySelector('#naRes');
      const name = (m.modal.querySelector('#naName').value || '').trim();
      if (!name) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:12px 0 0">Придумайте имя агенту.</div>';
        return;
      }
      const roleKey = m.modal.querySelector('#naRole').value || 'assistant';
      const meta = roleMeta(roleKey);
      btn.innerHTML = '<span class="spinner"></span>Добавляем';
      btn.style.pointerEvents = 'none';
      try {
        await saveAgent({
          name,
          role: meta.name,
          roleKey,
          avatar: m.modal.querySelector('#naAvatar').value,
          accent: meta.accent,
          model: (m.modal.querySelector('#naModel').value || '').trim() || 'gpt-5.2-mini',
          temperature: 0.5,
          systemPrompt: (m.modal.querySelector('#naPrompt').value || '').trim(),
          status: 'online',
          permissions: { services: [], programs: [], mcp: [], input: false },
        });
        toast('Агент в команде', `${name} готов к задачам`, 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('plus')}Добавить`;
        btn.style.pointerEvents = '';
      }
    });
  }

  function changeRoot() {    const cur = (store.team && store.team.workspace) || '';
    const m = openModal({
      kicker: 'рабочая папка',
      title: 'Папка команды',
      body: `
        <div class="field"><label>полный путь к папке</label>
          <input class="input mono" id="rootPath" maxlength="300" value="${esc(cur)}"
            placeholder="например: D:\проекты\бот (пусто — общая папка узла)" autocomplete="off"></div>
        <span class="field-hint">Все файлы агентов будут создаваться здесь. Папка должна существовать.</span>
        <div id="rootRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="rootSave">${icon('check')}Сохранить</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#rootSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#rootSave');
      const resBox = m.modal.querySelector('#rootRes');
      const value = (m.modal.querySelector('#rootPath').value || '').trim();
      btn.innerHTML = '<span class="spinner"></span>Сохраняем';
      btn.style.pointerEvents = 'none';
      try {
        await saveTeam({ workspace: value });
        toast('Папка обновлена', value || 'общая папка узла', 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}Сохранить`;
        btn.style.pointerEvents = '';
      }
    });
  }

  function wireCards() {
    page.querySelectorAll('.agent-card').forEach((card) => {
      tilt(card);
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-run]')) return;
        openDrawer(card.dataset.agent);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(card.dataset.agent); }
      });
    });
    page.querySelectorAll('[data-run]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = store.agents.find((x) => x.id === btn.dataset.run);
        if (!a) return;
        launch(a, DEFAULT_TASKS[a.roleKey] || 'выполнить задачу команды');
      });
    });
  }

  function launch(agent, task) {
    runAgent(agent, task, {
      onStart: () => { render(false); },
      onDone: (err) => {
        render(false);
        if (!err) toast(`${agent.name}: выполнено`, task, 'ok');
        else toast(`${agent.name}: ошибка`, err.message, 'err');
        if (drawerAgent && drawerAgent.id === agent.id) renderDrawer();
      },
    });
  }

  /* ----------------------------------------------------------- шторка */

  const drawer = document.getElementById('drawer');
  const backdrop = document.getElementById('drawerBackdrop');
  const drawerContent = document.getElementById('drawerContent');
  let drawerAgent = null;

  function openDrawer(id) {
    const a = store.agents.find((x) => x.id === id);
    if (!a) return;
    drawerAgent = a;
    drawer.hidden = false;
    backdrop.hidden = false;
    renderDrawer();
    requestAnimationFrame(() => drawer.classList.add('open'));
    setTimeout(() => drawer.querySelector('.dr-close')?.focus(), 120);
  }

  function closeDrawer() {
    if (drawer.hidden) return;
    drawer.classList.remove('open');
    const done = () => { drawer.hidden = true; backdrop.hidden = true; drawerAgent = null; };
    setTimeout(done, reducedMotion ? 10 : 400);
  }

  function renderDrawer() {
    const a = drawerAgent;
    if (!a || drawer.hidden) return;
    const meta = roleMeta(a.roleKey);
    const hist = agentHistory(a.id);
    const running = a.status === 'busy';

    const permGroup = (title, kind, items, selected) => `
      <div class="perm-group">
        <b>${title}</b>
        <div class="perm-list">
          ${items.length ? items.map((it) => `
            <button class="toggle-chip" role="switch" aria-checked="${selected.includes(it.id)}"
              data-perm="${kind}" data-pid="${esc(it.id)}" style="--t-c:${meta.accent}">${esc(it.name || it.id)}</button>`).join('')
          : '<span class="dim" style="font-size:12px">нет доступных элементов</span>'}
        </div>
      </div>`;

    const logs = hist.length
      ? hist.map((l) => `<div class="log-line lv-${l.level}"><span class="lt">${new Date(l.t).toLocaleTimeString('ru-RU')}</span><span class="lp">${{ info: '→', ok: '✔', warn: '!', err: '✗', mcp: '◆', sys: '»' }[l.level] || '·'}</span><span class="ltx">${esc(l.text)}</span></div>`).join('')
      : '<div class="dim" style="font-size:12px">Записей выполнения нет — запустите задачу, чтобы увидеть живой лог.</div>';

    drawerContent.innerHTML = `
      <header class="dr-head">
        ${avatarOrb(a, 'orb-lg')}
        <div class="ac-id">
          <h3 id="drawerTitle">${esc(a.name)}</h3>
          <div class="dr-tags">
            <span class="chip" style="--chip-c:${a.accent || meta.accent}"><i></i>${esc(a.role)}</span>
            ${statusPill(a.status)}
          </div>
        </div>
        <button class="icon-btn dr-close" aria-label="Закрыть панель агента">${icon('x')}</button>
      </header>

      <div class="dr-stats">
        <div class="dr-stat"><span>модель</span><b>${esc(a.model)}</b></div>
        <div class="dr-stat"><span>креативность</span><b>${Number(a.temperature).toFixed(1)}</b></div>
        <div class="dr-stat"><span>идентификатор</span><b>${esc(a.id)}</b></div>
        <div class="dr-stat"><span>активность</span><b>${relTime(a.lastActive)}</b></div>
      </div>

      <section class="dr-sec">
        <h4>новая задача</h4>
        <div class="field">
          <textarea class="textarea" id="drTask" rows="3" placeholder="${esc(DEFAULT_TASKS[a.roleKey] || 'выполнить задачу команды')}">${esc(DEFAULT_TASKS[a.roleKey] || 'выполнить задачу команды')}</textarea>
        </div>
        <div class="dr-actions">
          <button class="btn btn-primary" id="drRun" ${running ? 'disabled' : ''}>
            ${running ? '<span class="spinner"></span>в очереди…' : `${icon('play')}Запустить задачу`}
          </button>
        </div>
      </section>

      <section class="dr-sec">
        <h4>разрешения</h4>
        ${permGroup('сервисы', 'services', store.services, a.permissions.services)}
        ${permGroup('программы пк', 'programs', store.programs, a.permissions.programs)}
        ${permGroup('mcp-серверы', 'mcp', store.mcp, a.permissions.mcp)}
        ${permGroup('базы знаний', 'kb', store.kb, a.permissions.kb || [])}
        <span class="field-hint">Привязанные базы ищутся вместо всей папки (rag_search + автоконтекст). Управлять базами — в разделе «Базы знаний».</span>
        <div class="perm-group">
          <b>ввод и свой браузер</b>
          <div class="perm-list">
            <button class="toggle-chip" role="switch" aria-checked="${!!a.permissions.input}"
              data-input-toggle style="--t-c:var(--rose)">${a.permissions.input ? 'включён' : 'выключен'}</button>
          </div>
          <span class="field-hint">Агент сможет печатать, кликать мышью и водить свой браузер по сайтам. Работает только в режиме «полный доступ». Включайте только доверенным агентам.</span>
        </div>
      </section>

      <section class="dr-sec">
        <h4>лог агента</h4>
        <div class="dr-logs" id="drLogs">${logs}</div>
      </section>

      <section class="dr-sec">
        <h4>опасная зона</h4>
        <button class="btn btn-danger" id="drDelete" style="width:100%">${icon('trash')}Удалить агента из команды</button>
      </section>`;

    drawer.querySelector('.dr-close').addEventListener('click', closeDrawer);
    drawer.querySelector('#drRun').addEventListener('click', () => {
      const ta = drawer.querySelector('#drTask');
      const task = (ta.value || '').trim() || DEFAULT_TASKS[a.roleKey] || 'выполнить задачу команду';
      closeDrawer();
      launch(a, task);
    });
    drawer.querySelector('#drDelete').addEventListener('click', async () => {
      const ok = await confirmDialog({
        kicker: 'удаление агента',
        title: `Убрать «${a.name}» из команды?`,
        text: 'Агент и его разрешения будут удалены. Статистика команды сохранится.',
        okText: 'Удалить агента',
      });
      if (!ok) return;
      try {
        await removeAgent(a.id);
        closeDrawer();
        toast('Агент удалён', `${a.name} больше не в составе`, 'ok');
      } catch (e) {
        toast('Ошибка удаления', e.message, 'err');
      }
    });
    drawerContent.querySelector('[data-input-toggle]').addEventListener('click', async () => {
      const next = !a.permissions.input;
      try {
        await saveAgent({ ...a, permissions: { ...a.permissions, input: next } });
        renderDrawer();
        toast(next ? 'Ввод включён' : 'Ввод выключен',
          next
            ? `${a.name} теперь может управлять клавиатурой и мышью`
            : `${a.name} больше не управляет вводом`, next ? 'warn' : 'ok');
      } catch (e) {
        toast('Не удалось сохранить', e.message, 'err');
      }
    });
    drawerContent.querySelectorAll('[data-perm]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const kind = chip.dataset.perm;
        const pid = chip.dataset.pid;
        const next = { ...a.permissions, [kind]: [...a.permissions[kind]] };
        const idx = next[kind].indexOf(pid);
        if (idx >= 0) next[kind].splice(idx, 1);
        else next[kind].push(pid);
        try {
          await saveAgent({ ...a, permissions: next });
          renderDrawer();
        } catch (e) {
          toast('Не удалось сохранить', e.message, 'err');
        }
      });
    });
  }

  /* -------------------------------------------------------- подписки */

  const onTeam = () => {
    if (page.isConnected) {
      updateStats(false);
      const grid = page.querySelector('#agentGrid');
      const online = store.agents.filter((a) => a.status !== 'offline').length;
      const hint = page.querySelector('#stOnlineHint');
      if (hint) hint.textContent = `из ${store.agents.length} в команде`;
      if (grid) {
        grid.innerHTML = store.agents.map(cardHTML).join('');
        wireCards();
        checkTickers();
      } else if (store.agents.length) {
        render(false);
      }
      const rail = page.querySelector('.rail');
      if (rail) rail.innerHTML = railHTML();
    }
    if (drawerAgent) {
      drawerAgent = store.agents.find((x) => x.id === drawerAgent.id) || null;
      if (!drawerAgent) closeDrawer();
      else renderDrawer();
    }
  };
  bus.addEventListener('team', onTeam);

  /* Реальные метрики узла: тянем с сервера и обновляем только панель «Пульс». */
  const cpuHist = [];
  const memHist = [];
  function drawPulse() {
    const cv = page.querySelector('#pulseCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const grid = getComputedStyle(document.documentElement).getPropertyValue('--line') || 'rgba(255,255,255,.08)';
    ctx.strokeStyle = grid.trim() || 'rgba(148,163,184,.15)';
    ctx.lineWidth = 1;
    for (let g = 1; g <= 3; g++) {
      ctx.beginPath();
      ctx.moveTo(0, (H / 4) * g);
      ctx.lineTo(W, (H / 4) * g);
      ctx.stroke();
    }
    const line = (arr, color) => {
      if (arr.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      arr.forEach((v, i) => {
        const x = (i / 59) * W;
        const y = H - 3 - (Math.min(100, Math.max(0, v)) / 100) * (H - 8);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    /* Сначала сетка, поверх — две линии истории (до 60 точек) */
    line(cpuHist.slice(-60), '#38E8FF');
    line(memHist.slice(-60), '#8B5CF6');
    const val = page.querySelector('#pulseVal');
    if (val && cpuHist.length) val.textContent = `cpu ${Math.round(cpuHist[cpuHist.length - 1])}% · mem ${Math.round(memHist[memHist.length - 1])}%`;
  }
  const onMetrics = () => {
    if (!page.isConnected) return;
    const n = store.metrics && store.metrics.node;
    if (n) {
      cpuHist.push(Number(n.cpu.pct) || 0);
      memHist.push(Number(n.memory.usedPct) || 0);
      if (cpuHist.length > 60) cpuHist.shift();
      if (memHist.length > 60) memHist.shift();
    }
    const rail = page.querySelector('.rail');
    if (rail) rail.innerHTML = railHTML();
    drawPulse();
  };
  bus.addEventListener('metrics', onMetrics);
  const onRag = () => {
    if (!page.isConnected) return;
    const rail = page.querySelector('.rail');
    if (rail) rail.innerHTML = railHTML();
  };
  bus.addEventListener('rag', onRag);
  const onKb = () => {
    if (drawerAgent) {
      drawerAgent = store.agents.find((x) => x.id === drawerAgent.id) || null;
      if (!drawerAgent) closeDrawer();
      else if (!drawer.hidden) renderDrawer();
    }
  };
  bus.addEventListener('kb', onKb);
  const metricsTimer = setInterval(() => { if (!document.hidden) refreshMetrics(); }, 10000);
  refreshMetrics();
  refreshRag();
  getKb().then(() => { if (drawerAgent && !drawer.hidden) renderDrawer(); });
  /* Перерисовать canvas после первого рендера */
  setTimeout(drawPulse, 300);

  const onKey = (e) => { if (e.key === 'Escape' && !drawer.hidden) closeDrawer(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', closeDrawer);

  render(true);

  return () => {
    bus.removeEventListener('team', onTeam);
    bus.removeEventListener('metrics', onMetrics);
    bus.removeEventListener('rag', onRag);
    bus.removeEventListener('kb', onKb);
    clearInterval(metricsTimer);
    document.removeEventListener('keydown', onKey);
    backdrop.removeEventListener('click', closeDrawer);
    closeDrawer();
  };
}
