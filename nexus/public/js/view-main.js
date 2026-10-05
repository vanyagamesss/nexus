/* NEXUS — вид «Команда»: герой, сетка агентов, лента, шторка агента */

import {
  esc, icon, avatarOrb, agentAvatar, AVATARS, statusPill, sparkSVG, countUp, tilt, stagger,
  toast, confirmDialog, openModal, fmtInt, fmtCompact, fmtTime, relTime, roleMeta,
  DEFAULT_TASKS, reducedMotion, fmtBytes, fmtUptime, fmtUsd, loadLevel, safeAccent,
} from './ui.js';
import { store, bus, saveTeam, saveAgent, removeAgent, refreshMetrics, refreshRag, getKb } from './store.js';
import { runAgent, runTeam, agentHistory, setAgent, logSys } from './console.js';
import { t, localeTag } from './i18n.js';

const STATUS_RU = {
  get online() { return t('team.status_online'); },
  get busy() { return t('team.status_busy'); },
  get offline() { return t('team.status_offline'); },
};

/* Дефолтная задача роли: ключи ui.task_<rolekey> / ui.task_default создаёт другой файл, здесь только чтение. */
const defaultTask = (rk) => {
  const path = `ui.task_${rk || ''}`;
  const s = t(path);
  return s === path ? t('ui.task_default') : s;
};

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  let teamRunning = false;
  let renameHandler = null;

  /* ------------------------------------------------------------ разметка */

  function heroHTML() {
    const tm = store.team;
    const online = store.agents.filter((a) => a.status !== 'offline').length;
    return `
      ${store.offline ? `<div class="banner banner-warn">${icon('alert')}<div><b>${t('team.offline_title')}</b> ${t('team.offline_text')}</div><button class="btn btn-mini" data-retry>${t('team.retry')}</button></div>` : ''}
      <section class="hero">
        <div class="hero-main">
          <div class="hero-eyebrow mono">
            <span class="pulse-dot" data-state="${store.offline ? 'down' : 'ok'}"></span>
            ${t('team.system')} ${store.offline ? t('team.system_down') : t('team.system_active')}
            <span class="sep">·</span> ${t('team.node')}
            <span class="sep">·</span> ${t('team.mission')}: ${esc((tm.mission || '').toUpperCase())}
          </div>
          <div class="hero-title-row">
            <h1 id="teamName">${esc(tm.name)}</h1>
            <button class="icon-btn" id="renameBtn" aria-label="${esc(t('team.rename_aria'))}">${icon('pencil')}</button>
          </div>
          <p class="hero-desc">${esc(tm.description || '')}</p>
          <div class="hero-root mono" title="${esc(t('team.root_title'))}">${t('team.folder')}: ${esc(tm.workspace || t('team.folder_default'))}
            <button class="icon-btn" id="rootBtn" aria-label="${esc(t('team.root_aria'))}" style="width:26px;height:26px">${icon('pencil')}</button>
          </div>
          <div class="hero-actions">
            <button class="btn btn-primary" id="runTeamBtn">${icon('play')}<span>${t('team.run_team')}</span></button>
            <select class="select" id="runMode" aria-label="${esc(t('team.runmode_aria'))}" style="max-width:190px">
              <option value="chain">${t('team.runmode_chain')}</option>
              <option value="parallel">${t('team.runmode_parallel')}</option>
            </select>
            <a class="btn btn-ghost" href="#/constructor">${icon('plus')}${t('team.new_team')}</a>
            <a class="btn btn-ghost" href="#/connect">${icon('sliders')}${t('team.connections')}</a>
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat" style="--stat-c:var(--lime)">
            <span class="stat-num" id="stOnline">0</span>
            <span class="stat-label">${t('team.stat_online')}</span>
            <i class="stat-hint" id="stOnlineHint">${esc(t('team.stat_online_hint', { n: store.agents.length }))}</i>
          </div>
          <div class="stat" style="--stat-c:var(--cyan)">
            <span class="stat-num" id="stDone">0</span>
            <span class="stat-label">${t('team.stat_done')}</span>
            <i class="stat-hint">${t('team.stat_done_hint')}</i>
          </div>
          <div class="stat" style="--stat-c:var(--violet)">
            <span class="stat-num" id="stTokens">0</span>
            <span class="stat-label">${t('team.stat_tokens')}</span>
            <i class="stat-hint">${t('team.stat_tokens_hint')}</i>
          </div>
          <div class="stat" style="--stat-c:var(--amber)">
            <span class="stat-num" id="stBudget">0</span>
            <span class="stat-label">${t('team.stat_budget')}</span>
            <i class="stat-hint">${t('team.stat_budget_hint')}</i>
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
      : t('team.task_ready', { task: defaultTask(a.roleKey) });
    return `
      <article class="agent-card" data-agent="${esc(a.id)}" tabindex="0" role="button"
        aria-label="${esc(t('team.card_aria', { name: a.name, role: a.role, status: STATUS_RU[a.status] || a.status }))}"
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
          <span class="task-label mono">${t('team.card_task')}</span>
          <div class="ticker"><div class="ticker-in"><span>${esc(task)}</span><span>${esc(task)}</span></div></div>
        </div>
        <div class="ac-chips">${svc}${mcp}${a.permissions.programs.length ? `<span class="chip" style="--chip-c:var(--blue)"><i></i>${esc(t('team.card_pc', { n: a.permissions.programs.length }))}</span>` : ''}</div>
        <footer class="ac-foot">
          ${sparkSVG(a)}
          <span class="ac-model mono" title="${esc(a.model)}">${esc(a.model)}</span>
          <button class="btn btn-mini btn-run" data-run="${esc(a.id)}" ${a.status === 'offline' ? 'disabled' : ''}>${icon('play')}${a.status === 'busy' ? t('team.card_busy') : t('team.card_run')}</button>
        </footer>
      </article>`;
  }

  function emptyHTML() {
    return `
      <div class="empty">
        <div class="empty-icon">${icon('users')}</div>
        <h3>${t('team.empty_title')}</h3>
        <p>${t('team.empty_text')}</p>
        <a class="btn btn-primary" href="#/constructor">${icon('plus')}${t('team.empty_cta')}</a>
      </div>`;
  }

  function feedHTML() {
    const items = store.events.slice(0, 8).map((e) => `
      <li class="tl-item" data-kind="${esc(e.kind || 'system')}">
        <span class="tl-time mono">${fmtTime(e.t)} · ${relTime(e.t)}</span>
        <span class="tl-text">${esc(e.text)}</span>
      </li>`).join('') || `<li class="tl-text dim">${t('team.feed_empty')}</li>`;
    return `
      <section class="panel feed" aria-label="${esc(t('team.feed_title'))}">
        <h3>${t('team.feed_title')}</h3>
        <div class="feed-note mono">${esc(t('team.feed_note', { n: Math.min(8, store.events.length) }))}</div>
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
      ? `<div class="meter-row"><div class="meter-top"><span>${t('team.rag_files')}</span><b>${fmtInt(r.files)} / ${fmtInt(r.chunks)}</b></div>`
        + `<div class="meter"><i style="--m-c:var(--cyan);width:${Math.min(100, (r.files / 200) * 100)}%"></i></div></div>
        <div class="meter-row"><div class="meter-top"><span>${t('team.rag_folder')}</span><b class="mono" style="font-size:10.5px">${esc(String(r.root || '').split(/[\\/]/).slice(-2).join('/'))}</b></div></div>`
      : `<div class="meter-row"><div class="meter-top"><span>${t('team.rag_scan')}</span></div><div class="meter"><i style="--m-c:var(--cyan);width:35%"></i></div></div>`;
    return `
      <section class="panel mini-panel" aria-label="${esc(t('team.rag_title'))}">
        <h3>${t('team.rag_title')}</h3>
        ${body}
        <span class="field-hint">${t('team.rag_hint')}</span>
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
      <h3 class="mt">${esc(t('team.node_title', { host: n.host.hostname || '' }))}</h3>
      ${sysMeter(t('team.m_cpu'), n.cpu.pct, t('team.m_cpu_v', { cores: n.cpu.cores, pct: n.cpu.pct }), 'var(--cyan)')}
      ${sysMeter(t('team.m_mem'), n.memory.usedPct, `${fmtBytes(n.memory.used)} / ${fmtBytes(n.memory.total)}`, 'var(--violet)')}
      ${sysMeter(t('team.m_disk', { fs: n.disk.fs || '' }), n.disk.usedPct, t('team.m_disk_v', { free: fmtBytes(n.disk.free) }), 'var(--amber)')}
      <div class="meter-row">
        <div class="meter-top"><span>${t('team.m_uptime')}</span><b>${esc(fmtUptime(n.host.uptimeSec))}</b></div>
        <div class="meter"><i style="--m-c:var(--lime);width:100%"></i></div>
      </div>
      <div class="meter-row">
        <div class="meter-top"><span>${t('team.m_rss')}</span><b>${esc(fmtBytes(n.process.rss))}</b></div>
        <div class="meter"><i style="--m-c:var(--blue);width:${Math.min(100, (n.process.rss / n.memory.total) * 100)}%"></i></div>
      </div>` : '';

    const stats = (m && m.stats && m.stats.totals) || null;
    const runBlock = stats ? `
      <h3 class="mt">${t('team.runs')}</h3>
      <div class="meter-row">
        <div class="meter-top"><span>${t('team.runs_ok')}</span><b>${stats.ok} / ${stats.runs}</b></div>
        <div class="meter"><i style="--m-c:var(--lime);width:${stats.runs ? (stats.ok / stats.runs) * 100 : 0}%"></i></div>
      </div>
      <div class="meter-row">
        <div class="meter-top"><span>${t('team.tokens')}</span><b>${esc(fmtCompact(stats.totalTokens || 0))}</b></div>
        <div class="meter"><i style="--m-c:var(--cyan);width:100%"></i></div>
      </div>
      <div class="meter-row">
        <div class="meter-top"><span>${t('team.cost')}</span><b>${esc(fmtUsd(stats.costUsd || 0))}</b></div>
        <div class="meter"><i style="--m-c:var(--violet);width:100%"></i></div>
      </div>` : '';

    return `
      <section class="panel mini-panel" aria-label="${esc(t('team.pulse_aria'))}">
        <h3>${t('team.pulse')}</h3>        <canvas class="pulse-canvas" id="pulseCanvas" width="260" height="46" aria-label="${esc(t('team.pulse_aria'))}"></canvas>
        <div class="pulse-legend mono"><span class="lg-cpu">— cpu</span><span class="lg-mem">— mem</span><span class="lg-v" id="pulseVal"></span></div>
        ${sys || `<div class="meter-row"><div class="meter-top"><span>${t('team.pulse_loading')}</span></div><div class="meter"><i style="--m-c:var(--cyan);width:35%"></i></div></div>`}
        ${runBlock}
        <h3 class="mt">${t('team.crew')}</h3>
        <div class="meter-row">
          <div class="meter-top"><span>${t('team.crew_online')}</span><b>${online} / ${store.agents.length}</b></div>
          <div class="meter"><i style="--m-c:var(--lime);width:${(online / total) * 100}%"></i></div>
        </div>
        <div class="meter-row">
          <div class="meter-top"><span>${t('team.crew_svc')}</span><b>${svcOk} / ${store.services.length}</b></div>
          <div class="meter"><i style="--m-c:var(--cyan);width:${(svcOk / Math.max(1, store.services.length)) * 100}%"></i></div>
        </div>
        <div class="meter-row">
          <div class="meter-top"><span>${t('team.crew_mcp')}</span><b>${mcpOk} / ${store.mcp.length}</b></div>
          <div class="meter"><i style="--m-c:var(--violet);width:${(mcpOk / Math.max(1, store.mcp.length)) * 100}%"></i></div>
        </div>
        <div class="meter-row">
          <div class="meter-top"><span>${t('team.stat_budget')}</span><b>${budget}</b></div>
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
            ${t('team.noteam_eyebrow')}
          </div>
          <div class="hero-title-row"><h1 id="teamName">${t('team.noteam_title')}</h1></div>
          <p class="hero-desc">${t('team.noteam_text')}</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#/constructor">${icon('plus')}<span>${t('team.empty_cta')}</span></a>
            <button class="btn btn-ghost" id="noTeamRetry">${icon('refresh')}<span>${t('team.noteam_retry')}</span></button>
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
              <div class="kicker">${t('team.crew_kicker')} <span class="k-dim">/ ${esc(t('team.crew_n', { n: store.agents.length }))}</span></div>
              <h2>${t('team.crew_title')}</h2>
            </div>
            <span class="sec-note">${t('team.crew_note')}</span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="addAgentBtn">${icon('plus')}${t('team.add_agent')}</button>
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
    const tm = store.team || { tasksCompleted: 0, tokens: 0, budgetSteps: 0 };
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
    set('#stDone', tm.tasksCompleted, (v) => fmtInt(v));
    set('#stTokens', tm.tokens, (v) => fmtCompact(v));
    set('#stBudget', tm.budgetSteps, (v) => fmtInt(v));
    const hint = page.querySelector('#stOnlineHint');
    if (hint) hint.textContent = t('team.stat_online_hint', { n: store.agents.length });
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
      if (!list.length) { toast(t('team.toast_nobody'), t('team.toast_nobody_text'), 'warn'); return; }
      const chain = page.querySelector('#runMode')?.value === 'chain';
      teamRunning = true;
      runBtn.classList.add('btn-busy');
      runBtn.innerHTML = `<span class="spinner"></span><span>${t('team.running')}</span>`;
      logSys(chain
        ? t('team.log_chain', { names: list.map((a) => a.name).join(' → ') })
        : t('team.log_batch', { n: list.length }));
      await runTeam(list, (a) => defaultTask(a.roleKey), { chain });
      teamRunning = false;
      const btn = page.querySelector('#runTeamBtn');
      if (btn) {
        btn.classList.remove('btn-busy');
        btn.innerHTML = `${icon('play')}<span>${t('team.run_team')}</span>`;
      }
      toast(t('team.toast_batch'), t('team.toast_batch_text', { n: list.length }), 'ok');
      updateStats(false);
    });
  }

  function startRename() {
    const h1 = page.querySelector('#teamName');
    if (!h1 || page.querySelector('.rename-input')) return;
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = store.team.name;
    input.setAttribute('aria-label', t('team.rename_aria_input'));
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
          .then(() => toast(t('team.toast_renamed'), t('team.toast_renamed_text', { name: value }), 'ok'))
          .catch((e) => {
            el.textContent = store.team.name;
            toast(t('team.toast_save_fail'), e.message, 'err');
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
      toast(t('team.toast_max'), t('team.toast_max_text'), 'warn');
      return;
    }
    const m = openModal({
      kicker: t('team.na_kicker'),
      title: t('team.na_title'),
      body: `
        <div class="field-row">
          <div class="field" style="flex:0 0 110px"><label>${t('team.na_avatar')}</label>
            <select class="select" id="naAvatar">${AVATARS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></div>
          <div class="field" style="flex:1 1 auto"><label>${t('team.na_name')}</label>
            <input class="input" id="naName" maxlength="40" placeholder="${esc(t('team.na_name_ph'))}" autocomplete="off"></div>
        </div>
        <div class="field" style="margin-top:12px"><label>${t('team.na_role')}</label>
          <select class="select" id="naRole">${['dev', 'research', 'editor', 'analyst', 'devops', 'assistant', 'tester', 'designer'].map((k) => { const r = roleMeta(k); return `<option value="${k}">${r.avatar || ''} ${r.name} — ${r.desc}</option>`; }).join('')}</select></div>
        <div class="field" style="margin-top:12px"><label>${t('team.na_model')}</label>
          <input class="input mono" id="naModel" maxlength="60" value="gpt-5.2-mini" placeholder="${esc(t('team.na_model_ph'))}" autocomplete="off"></div>
        <div class="field" style="margin-top:12px"><label>${t('team.na_prompt')}</label>
          <textarea class="textarea" id="naPrompt" rows="3" maxlength="2000" placeholder="${esc(t('team.na_prompt_ph'))}"></textarea></div>
        <div id="naRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${t('team.cancel')}</button>
               <button class="btn btn-primary" id="naSave">${icon('plus')}${t('team.add')}</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#naSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#naSave');
      const resBox = m.modal.querySelector('#naRes');
      const name = (m.modal.querySelector('#naName').value || '').trim();
      if (!name) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${t('team.na_need_name')}</div>`;
        return;
      }
      const roleKey = m.modal.querySelector('#naRole').value || 'assistant';
      const meta = roleMeta(roleKey);
      btn.innerHTML = `<span class="spinner"></span>${t('team.adding')}`;
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
        toast(t('team.toast_agent_added'), t('team.toast_agent_added_text', { name }), 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('plus')}${t('team.add')}`;
        btn.style.pointerEvents = '';
      }
    });
  }

  function changeRoot() {    const cur = (store.team && store.team.workspace) || '';
    const m = openModal({
      kicker: t('team.root_kicker'),
      title: t('team.root_title2'),
      body: `
        <div class="field"><label>${t('team.root_label')}</label>
          <input class="input mono" id="rootPath" maxlength="300" value="${esc(cur)}"
            placeholder="${esc(t('team.root_ph'))}" autocomplete="off"></div>
        <span class="field-hint">${t('team.root_hint')}</span>
        <div id="rootRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${t('team.cancel')}</button>
               <button class="btn btn-primary" id="rootSave">${icon('check')}${t('team.save')}</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#rootSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#rootSave');
      const resBox = m.modal.querySelector('#rootRes');
      const value = (m.modal.querySelector('#rootPath').value || '').trim();
      btn.innerHTML = `<span class="spinner"></span>${t('team.saving')}`;
      btn.style.pointerEvents = 'none';
      try {
        await saveTeam({ workspace: value });
        toast(t('team.toast_root'), value || t('team.folder_default'), 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}${t('team.save')}`;
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
        launch(a, defaultTask(a.roleKey));
      });
    });
  }

  function launch(agent, task) {
    runAgent(agent, task, {
      onStart: () => { render(false); },
      onDone: (err) => {
        render(false);
        if (!err) toast(t('team.toast_done', { name: agent.name }), task, 'ok');
        else toast(t('team.toast_fail', { name: agent.name }), err.message, 'err');
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
          : `<span class="dim" style="font-size:12px">${t('team.perm_empty')}</span>`}
        </div>
      </div>`;

    const logs = hist.length
      ? hist.map((l) => `<div class="log-line lv-${l.level}"><span class="lt">${new Date(l.t).toLocaleTimeString(localeTag())}</span><span class="lp">${{ info: '→', ok: '✔', warn: '!', err: '✗', mcp: '◆', sys: '»' }[l.level] || '·'}</span><span class="ltx">${esc(l.text)}</span></div>`).join('')
      : `<div class="dim" style="font-size:12px">${t('team.log_empty')}</div>`;

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
        <button class="icon-btn dr-close" aria-label="${esc(t('team.drawer_close'))}">${icon('x')}</button>
      </header>

      <div class="dr-stats">
        <div class="dr-stat"><span>${t('team.dr_model')}</span><b>${esc(a.model)}</b></div>
        <div class="dr-stat"><span>${t('team.dr_temp')}</span><b>${Number(a.temperature).toFixed(1)}</b></div>
        <div class="dr-stat"><span>${t('team.dr_id')}</span><b>${esc(a.id)}</b></div>
        <div class="dr-stat"><span>${t('team.dr_active')}</span><b>${relTime(a.lastActive)}</b></div>
      </div>

      <section class="dr-sec">
        <h4>${t('team.dr_task')}</h4>
        <div class="field">
          <textarea class="textarea" id="drTask" rows="3" placeholder="${esc(defaultTask(a.roleKey))}">${esc(defaultTask(a.roleKey))}</textarea>
        </div>
        <div class="dr-actions">
          <button class="btn btn-primary" id="drRun" ${running ? 'disabled' : ''}>
            ${running ? `<span class="spinner"></span>${t('team.dr_queued')}` : `${icon('play')}${t('team.dr_run')}`}
          </button>
        </div>
      </section>

      <section class="dr-sec">
        <h4>${t('team.dr_perms')}</h4>
        ${permGroup(t('team.perm_svc'), 'services', store.services, a.permissions.services)}
        ${permGroup(t('team.perm_prog'), 'programs', store.programs, a.permissions.programs)}
        ${permGroup(t('team.perm_mcp'), 'mcp', store.mcp, a.permissions.mcp)}
        ${permGroup(t('team.perm_kb'), 'kb', store.kb, a.permissions.kb || [])}
        <span class="field-hint">${t('team.perm_kb_hint')}</span>
        <div class="perm-group">
          <b>${t('team.perm_input')}</b>
          <div class="perm-list">
            <button class="toggle-chip" role="switch" aria-checked="${!!a.permissions.input}"
              data-input-toggle style="--t-c:var(--rose)">${a.permissions.input ? t('team.input_on') : t('team.input_off')}</button>
          </div>
          <span class="field-hint">${t('team.perm_input_hint')}</span>
        </div>
      </section>

      <section class="dr-sec">
        <h4>${t('team.dr_log')}</h4>
        <div class="dr-logs" id="drLogs">${logs}</div>
      </section>

      <section class="dr-sec">
        <h4>${t('team.dr_danger')}</h4>
        <button class="btn btn-danger" id="drDelete" style="width:100%">${icon('trash')}${t('team.dr_delete')}</button>
      </section>`;

    drawer.querySelector('.dr-close').addEventListener('click', closeDrawer);
    drawer.querySelector('#drRun').addEventListener('click', () => {
      const ta = drawer.querySelector('#drTask');
      const task = (ta.value || '').trim() || defaultTask(a.roleKey);
      closeDrawer();
      launch(a, task);
    });
    drawer.querySelector('#drDelete').addEventListener('click', async () => {
      const ok = await confirmDialog({
        kicker: t('team.del_kicker'),
        title: t('team.del_title', { name: a.name }),
        text: t('team.del_text'),
        okText: t('team.del_ok'),
      });
      if (!ok) return;
      try {
        await removeAgent(a.id);
        closeDrawer();
        toast(t('team.toast_deleted'), t('team.toast_deleted_text', { name: a.name }), 'ok');
      } catch (e) {
        toast(t('team.toast_del_fail'), e.message, 'err');
      }
    });
    drawerContent.querySelector('[data-input-toggle]').addEventListener('click', async () => {
      const next = !a.permissions.input;
      try {
        await saveAgent({ ...a, permissions: { ...a.permissions, input: next } });
        renderDrawer();
        toast(next ? t('team.toast_input_on') : t('team.toast_input_off'),
          next
            ? t('team.toast_input_on_text', { name: a.name })
            : t('team.toast_input_off_text', { name: a.name }), next ? 'warn' : 'ok');
      } catch (e) {
        toast(t('team.toast_save_fail'), e.message, 'err');
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
          toast(t('team.toast_save_fail'), e.message, 'err');
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
      if (hint) hint.textContent = t('team.stat_online_hint', { n: store.agents.length });
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
