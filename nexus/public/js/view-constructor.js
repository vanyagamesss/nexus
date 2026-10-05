/* NEXUS — вид «Конструктор команды»: 4-шаговый мастер */

import {
  esc, icon, ROLES, roleMeta, MISSIONS, ORCH_MODES, DEFAULT_TASKS, AVATARS, avatarOrb,
  updateRangeFill, toast, confirmDialog, openModal, uid, reducedMotion, stagger, countUp, fmtInt,
} from './ui.js';
import { store, createTeam, getKb } from './store.js';

const NAMES = ['Атлас', 'Вектор', 'Дельта', 'Орбита', 'Пульс', 'Кристалл', 'Нейрон', 'Фаза', 'Сигма', 'Комета'];
const STEPS = ['Миссия', 'Агенты', 'Оркестрация', 'Обзор'];

/* Готовые слаженные составы: один клик — и команда собрана */
const TEAM_TEMPLATES = [
  { id: 'company', name: 'ИИ-компания', icon: 'bot', accent: '#FBBF24', roles: [{ role: 'assistant', name: 'Директор' }, 'dev', 'research', 'editor', 'analyst', 'devops', 'tester', 'designer', 'assistant'], mission: 'Разработка', desc: 'целая компания' },
  { id: 'research', name: 'Исследователи', icon: 'search', accent: '#8B5CF6', roles: ['research', 'research', 'analyst'], mission: 'Исследования', desc: 'глубокий ресерч' },
  { id: 'devs', name: 'Разработчики', icon: 'code', accent: '#38E8FF', roles: ['dev', 'dev', 'tester', 'devops'], mission: 'Разработка', desc: 'код и деплой' },
  { id: 'auto', name: 'Автопилот', icon: 'zap', accent: '#A3E635', roles: ['assistant', 'research', 'editor'], mission: 'Автоматизация', desc: 'универсалы' },
];

/* ------------------------------------------------- провайдеры и модели */

/** Настроенные и включённые провайдеры, которые реально можно выбрать. */
function activeProviders() {
  return (store.providers || []).filter((p) => p.enabled !== false);
}

/** Модели провайдера: из живой проверки, иначе из каталога. */
function modelsFor(p) {
  if (!p) return [];
  if (Array.isArray(p.models) && p.models.length) return p.models;
  const base = (store.catalog || []).find((c) => c.id === p.providerId);
  return base && Array.isArray(base.models) ? base.models.map((m) => m.id) : [];
}

/** Провайдер по умолчанию: помеченный в настройках, иначе первый рабочий. */
function defaultProvider() {
  const list = activeProviders();
  return list.find((p) => p.isDefault) || list[0] || null;
}

function freshDraft() {
  return {
    step: 1,
    name: '',
    description: '',
    mission: 'Разработка',
    workspace: '',
    agents: [],
    orchestration: 'parallel',
    budgetSteps: 80,
  };
}

let draft = freshDraft();

function newAgent(roleKey) {
  const meta = roleMeta(roleKey);
  const used = draft.agents.map((a) => a.name);
  const name = NAMES.find((n) => !used.includes(n)) || `${meta.name}-${draft.agents.length + 1}`;
  const p = defaultProvider();
  const models = modelsFor(p);
  return {
    id: uid('ag'),
    name,
    role: meta.name,
    roleKey: meta.key,
    accent: meta.accent,
    avatar: meta.avatar || '🤖',
    providerConfigId: p ? p.id : null,
    providerId: p ? p.providerId : null,
    model: models[0] || 'gpt-5.2-mini',
    temperature: 0.5,
    systemPrompt: defaultPrompt(meta.key),
    status: 'online',
    currentTask: 'готов к задаче',
    permissions: { services: [], programs: [], mcp: [], kb: [], input: false },
    spark: Array.from({ length: 12 }, () => 30 + Math.round(Math.random() * 55)),
  };
}

function defaultPrompt(key) {
  const map = {
    dev: 'Ты — разработчик. Пиши чистый код, добавляй тесты, объясняй решения кратко.',
    research: 'Ты — исследователь. Сверяй источники, приводи факты и ссылки, отмечай уверенность.',
    editor: 'Ты — редактор. Правь стиль и грамматику, сохраняя авторский посыл (было → стало).',
    analyst: 'Ты — аналитик. Считай метрики, ищи аномалии, формулируй выводы для бизнеса.',
    devops: 'Ты — DevOps. Деплой осторожно: сначала план и откат, каждый шаг логируй.',
    assistant: 'Ты — ассистент. Отвечай быстро и по делу, сложные кейсы эскалируй.',
    tester: 'Ты — тестировщик. Ищи регрессии, фиксируй шаги воспроизведения и важность.',
    designer: 'Ты — дизайнер. Держи систему, решай через иерархию, а не через декор.',
    pm: 'Ты — менеджер. Дроби цель на задачи, расставляй приоритеты и следи за сроками.',
    marketer: 'Ты — маркетолог. Пиши цепляющие тексты и предлагай каналы продвижения.',
    translator: 'Ты — переводчик. Переводи точно, сохраняй стиль и термины.',
    mentor: 'Ты — наставник. Объясняй просто, с примерами и проверкой понимания.',
  };
  return map[key] || 'Работай по задаче команды и отчитывайся результатом.';
}

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  page.innerHTML = `
    <div class="sec-head" style="margin-top:0">
      <div>
        <div class="kicker">конструктор <span class="k-dim">/ сборка с нуля</span></div>
        <h2>Новая команда</h2>
      </div>
      <span class="sec-note">прогресс сохраняется между шагами</span>
    </div>

    <div class="panel wizard-head">
      <ol class="steps" id="steps">
        ${STEPS.map((name, i) => `
          <li class="step" data-step="${i + 1}">
            <span class="step-dot mono">${i + 1}</span>
            <span class="step-name">${name}</span>
          </li>`).join('')}
      </ol>
    </div>

    <div class="wizard-body" id="wizardBody"></div>

    <div class="wizard-foot">
      <span class="step-note mono" id="stepNote"></span>
      <button class="btn btn-ghost" id="prevBtn">${icon('chevronLeft')}Назад</button>
      <button class="btn btn-primary" id="nextBtn">Далее${icon('arrowRight')}</button>
    </div>`;

  const body = page.querySelector('#wizardBody');
  const note = page.querySelector('#stepNote');
  const prevBtn = page.querySelector('#prevBtn');
  const nextBtn = page.querySelector('#nextBtn');

  /* ------------------------------------------------------ индикатор */

  function renderSteps() {
    page.querySelectorAll('.step').forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle('done', n < draft.step);
      el.classList.toggle('current', n === draft.step);
    });
  }

  /* ------------------------------------------------------- шаг 1 */

  function step1() {
    body.innerHTML = `
      <div class="step-panel form-card panel">
        <div class="kicker">шаг 01 <span class="k-dim">/ идентичность</span></div>
        <h2>Имя, описание и миссия</h2>
        <p class="sub">Задайте, зачем команда существует. Миссия подставит рекомендованные роли на следующем шаге — изменить можно в любой момент.</p>
        <div class="field-row">
          <div class="field" style="flex:1 1 260px">
            <label for="cwName">название команды</label>
            <input class="input" id="cwName" maxlength="60" placeholder="например: Протокол Нексус" value="${esc(draft.name)}">
            <span class="field-hint">1–60 символов · отображается на главной</span>
          </div>
        </div>
        <div class="field" style="margin-top:16px">
          <label for="cwDesc">описание</label>
          <textarea class="textarea" id="cwDesc" rows="3" maxlength="280" placeholder="Что команда делает и для кого">${esc(draft.description)}</textarea>
        </div>
        <div class="field" style="margin-top:16px">
          <label for="cwRoot">рабочая папка команды</label>
          <input class="input mono" id="cwRoot" maxlength="300" placeholder="например: D:\проекты\бот (пусто — общая папка узла)" value="${esc(draft.workspace)}">
          <span class="field-hint">Все файлы агентов будут создаваться здесь. Папка должна существовать.</span>
        </div>
        <div class="field" style="margin-top:20px">
          <span class="field-label">миссия</span>
          <div class="mission-grid" role="group" aria-label="Выбор миссии">
            ${MISSIONS.map((m) => `
              <button class="mission-card" data-mission="${esc(m.key)}" style="--mc:${m.color}" aria-pressed="${draft.mission === m.key}">
                ${icon(m.icon)}
                <b>${esc(m.key)}</b>
                <span>${esc(m.desc)}</span>
              </button>`).join('')}
          </div>
        </div>
      </div>`;

    body.querySelector('#cwName').addEventListener('input', (e) => { draft.name = e.target.value; updateFoot(); });
    body.querySelector('#cwDesc').addEventListener('input', (e) => { draft.description = e.target.value; });
    body.querySelector('#cwRoot').addEventListener('input', (e) => { draft.workspace = e.target.value; });
    body.querySelectorAll('[data-mission]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.mission = btn.dataset.mission;
        body.querySelectorAll('[data-mission]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      });
    });
  }

  /* ------------------------------------------------------- шаг 2 */

  function step2() {
    const hint = draft.agents.length === 0 && draft.mission
      ? `<div class="banner banner-warn" style="margin-top:0;margin-bottom:14px">${icon('zap')}Миссия «${esc(draft.mission)}» — быстрый старт: начните с рекомендованных ролей.</div>`
      : '';
    body.innerHTML = `
      <div class="step-panel">
        ${hint}
        <div class="constructor-grid">
          <aside class="panel roles-col">
            <h3>Доступные роли</h3>
            <div class="sub">клик — добавить в команду</div>
            ${ROLES.map((r) => `
              <button class="role-btn" data-add-role="${r.key}" style="--rc:${r.accent}">
                <span class="role-ico">${icon(r.icon)}</span>
                <b>${esc(r.name)}</b>
                <span class="role-add">+</span>
              </button>`).join('')}
            <h3 style="margin-top:18px">Готовые команды</h3>
            <div class="sub">один клик — собрать слаженный состав</div>
            ${TEAM_TEMPLATES.map((t) => `
              <button class="role-btn" data-add-template="${esc(t.id)}" style="--rc:${t.accent}">
                <span class="role-ico">${icon(t.icon)}</span>
                <b>${esc(t.name)}</b>
                <span class="role-add">↧</span>
              </button>`).join('')}
          </aside>
          <div class="members-col" id="membersCol">
            ${membersHTML()}
          </div>
        </div>
      </div>`;
    wireMembers();
  }

  function membersHTML() {
    if (!draft.agents.length) {
      return `
        <div class="empty">
          <div class="empty-icon">${icon('users')}</div>
          <h3>Состав пуст</h3>
          <p>Добавьте агентов слева. Каждого можно настроить: имя, модель, креативность, промпт и разрешения.</p>
        </div>`;
    }
    return draft.agents.map((a, i) => memberHTML(a, i)).join('');
  }

  /** Выбор провайдера и модели агента — только из реально настроенных. */
  function providerPickerHTML(a) {
    const list = activeProviders();
    if (!list.length) {
      return `
        <div class="field" style="margin-top:14px">
          <div class="banner banner-warn" style="margin:0">
            <b>Провайдер LLM не настроен</b>
            <div>Добавьте ключ API или локальный Ollama в <a href="#/connect">Подключения → Модели</a>, затем выберите провайдера и модель для агента.</div>
          </div>
        </div>`;
    }

    const cur = list.find((p) => p.id === a.providerConfigId)
      || list.find((p) => p.providerId === a.providerId)
      || list[0];
    const models = modelsFor(cur);
    const model = models.includes(a.model) ? a.model : (models[0] || a.model);

    /* Синхронизируем драфт с тем, что реально доступно */
    a.providerConfigId = cur.id;
    a.providerId = cur.providerId;
    a.model = model;

    return `
      <div class="field-row" style="margin-top:14px">
        <div class="field" style="flex:1 1 220px">
          <label>провайдер</label>
          <select class="select" data-f="providerConfigId">
            ${list.map((p) => `
              <option value="${esc(p.id)}" ${p.id === cur.id ? 'selected' : ''}>
                ${esc(p.providerName || p.providerId)}${p.hasKey === false ? ' (без ключа)' : ''}${p.isDefault ? ' ★' : ''}
              </option>`).join('')}
          </select>
        </div>
        <div class="field" style="flex:1 1 220px">
          <label>модель</label>
          ${models.length ? `
            <select class="select" data-f="model">
              ${models.map((m) => `<option value="${esc(m)}" ${m === model ? 'selected' : ''}>${esc(m)}</option>`).join('')}
            </select>` : `
            <input class="input" data-f="model" maxlength="60" value="${esc(model)}" placeholder="введите id модели">`}
          ${models.length ? `<span class="field-hint">${models.length} моделей у провайдера</span>` : '<span class="field-hint">проверьте провайдера, чтобы увидеть список моделей</span>'}
        </div>
      </div>`;
  }

  function memberHTML(a, i) {
    const meta = roleMeta(a.roleKey);
    const open = a._open ? ' open' : '';
    const chips = (items, kind, sel) => items.length
      ? items.map((it) => `
          <button class="toggle-chip${it.dim ? ' dim' : ''}" role="switch" aria-checked="${sel.includes(it.id)}" data-perm="${kind}" data-pid="${esc(it.id)}" style="--t-c:${meta.accent}" ${it.disabled ? 'disabled' : ''}>${esc(it.name || it.id)}${it.dim ? ' · не подключён' : ''}</button>`).join('')
      : '<span class="dim" style="font-size:12px">нет элементов — подключите их в настройках</span>';
    return `
      <div class="member${open}" data-aid="${esc(a.id)}" style="--accent:${a.accent}">
        <div class="member-head" draggable="true" data-toggle="${esc(a.id)}">
          <span class="member-grip" aria-hidden="true">${icon('grip')}</span>
          ${avatarOrb(a, 'member-orb')}
          <span class="member-title">
            <b>${esc(a.name)}</b>
            <span>${esc(a.role)} · шаг ${i + 1}</span>
          </span>
          <span class="model-badge" data-model-badge>${esc(a.model)}</span>
          <span class="member-tools">
            <button class="icon-btn danger" data-del="${esc(a.id)}" aria-label="Удалить агента ${esc(a.name)}">${icon('trash')}</button>
            <button class="icon-btn member-expand" data-toggle="${esc(a.id)}" aria-label="Настройки агента ${esc(a.name)}">${icon('chevronDown')}</button>
          </span>
        </div>
        <div class="member-body">
          <div class="field-row">
            <div class="field" style="flex:0 0 120px">
              <label>аватар</label>
              <select class="select" data-f="avatar">
                ${AVATARS.map((e) => `<option value="${e}" ${e === a.avatar ? 'selected' : ''}>${e}</option>`).join('')}
              </select>
            </div>
            <div class="field" style="flex:1 1 180px">
              <label>имя</label>
              <input class="input" data-f="name" maxlength="40" value="${esc(a.name)}">
            </div>
          </div>
          ${providerPickerHTML(a)}
          <div class="field" style="margin-top:14px">
            <label>креативность / температура</label>
            <div class="temp-row">
              <input type="range" min="0" max="1" step="0.1" value="${a.temperature}" data-f="temperature" aria-label="Креативность агента ${esc(a.name)}">
              <span class="temp-val" data-temp>${Number(a.temperature).toFixed(1)}</span>
            </div>
          </div>
          <div class="field" style="margin-top:14px">
            <label>системный промпт</label>
            <textarea class="textarea" rows="3" data-f="systemPrompt" maxlength="2000" placeholder="Роль, правила и стиль ответов">${esc(a.systemPrompt)}</textarea>
          </div>
          <div class="perm-block">
            <b>сервисы и соцсети</b>
            <div class="perm-list">${chips(
              store.services.map((s) => ({
                id: s.id,
                name: s.name,
                dim: s.status !== 'connected',
                disabled: !(s.actions || []).length && s.status !== 'connected',
              })),
              'services',
              a.permissions.services,
            )}</div>
            <span class="field-hint">агенту доступны операции только у подключённых сервисов; запись — в режиме «полный доступ». <a href="#/connect">Подключить сервис</a></span>
          </div>
          <div class="perm-block">
            <b>программы пк</b>
            <div class="perm-list">${chips(store.programs.map((p) => ({ id: p.id, name: p.name })), 'programs', a.permissions.programs)}</div>
            ${store.programs.length ? '' : '<span class="field-hint">Пока пусто — <a href="#/connect">найдите программы в Подключениях</a>.</span>'}
          </div>
          <div class="perm-block">
            <b>mcp-серверы</b>
            <div class="perm-list">${chips(store.mcp.map((m) => ({ id: m.id, name: m.name })), 'mcp', a.permissions.mcp)}</div>
            ${store.mcp.length ? '' : '<span class="field-hint">Свой сервер добавляется в <a href="#/connect">Подключения → MCP</a>.</span>'}
          </div>
          <div class="perm-block">
            <b>базы знаний</b>
            <div class="perm-list">${chips(store.kb.map((b) => ({ id: b.id, name: b.name })), 'kb', a.permissions.kb || [])}</div>
            ${store.kb.length ? '<span class="field-hint">Привязанные базы ищутся вместо всей папки.</span>' : '<span class="field-hint">Пока нет баз — <a href="#/kb">создайте в Базах знаний</a>.</span>'}
          </div>
          <div class="perm-block">
            <b>ввод и свой браузер</b>
            <label class="check-row"><input type="checkbox" data-f="inputPerm" ${a.permissions.input ? 'checked' : ''}>
              <span>разрешить агенту печатать, нажимать клавиши и кликать мышью</span></label>
            <span class="field-hint">Фактическое управление ПК: браузер, Photoshop, Blender и другие программы. Работает только в режиме «полный доступ». Включайте только доверенным агентам.</span>
          </div>
        </div>
      </div>`;
  }

  function refreshMembers() {
    const col = body.querySelector('#membersCol');
    if (col) {
      col.innerHTML = membersHTML();
      /* Переподключаем обработчики: кнопки внутри колонки пересозданы */
      col.querySelectorAll('input[type="range"]').forEach(updateRangeFill);
    }
    updateFoot();
  }

  function wireMembers() {
    const col = body.querySelector('#membersCol');
    if (!col) return;

    /* Своя профессия: название + пара слов о том, что она делает */
    function customRoleModal() {
      const m = openModal({
        kicker: 'своя роль',
        title: 'Новая профессия',
        body: `
          <div class="field"><label>название профессии</label>
            <input class="input" id="crName" maxlength="40" placeholder="например: Юрист" autocomplete="off"></div>
          <div class="field" style="margin-top:12px"><label>что она делает</label>
            <textarea class="textarea" id="crDesc" rows="3" maxlength="500" placeholder="например: проверяет договоры и находит риски"></textarea></div>
          <div class="field-row" style="margin-top:12px">
            <div class="field" style="flex:0 0 120px"><label>аватар</label>
              <select class="select" id="crAvatar">${AVATARS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select></div>
          </div>
          <div id="crRes"></div>`,
        footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
                 <button class="btn btn-primary" id="crSave">${icon('plus')}Добавить</button>`,
      });
      m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.modal.querySelector('#crSave').addEventListener('click', () => {
        const name = (m.modal.querySelector('#crName').value || '').trim();
        const desc = (m.modal.querySelector('#crDesc').value || '').trim();
        if (name.length < 2) {
          m.modal.querySelector('#crRes').innerHTML = '<div class="banner banner-err" style="margin:12px 0 0">Придумайте название профессии.</div>';
          return;
        }
        const fresh = newAgent('custom');
        fresh.role = name.slice(0, 40);
        if (!draft.agents.some((a) => a.name === name)) fresh.name = name;
        fresh.avatar = m.modal.querySelector('#crAvatar').value || '⭐';
        fresh.systemPrompt = desc ? `Ты — ${name}. ${desc}`.slice(0, 2000) : `Ты — ${name}. Работай по задаче команды и отчитывайся результатом.`;
        fresh._open = true;
        draft.agents.push(fresh);
        m.close();
        refreshMembers();
        toast('Профессия добавлена', name, 'ok');
      });
    }

    body.querySelectorAll('[data-add-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (draft.agents.length >= 12) { toast('Больше нельзя', 'Максимум 12 агентов', 'warn'); return; }
        if (btn.dataset.addRole === 'custom') { customRoleModal(); return; }
        const fresh = newAgent(btn.dataset.addRole);
        fresh._open = true;
        draft.agents.push(fresh);
        refreshMembers();
        const cards = col.querySelectorAll('.member');
        if (cards.length) {
          cards[cards.length - 1].scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
        }
      });
    });

    body.querySelectorAll('[data-add-template]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = TEAM_TEMPLATES.find((x) => x.id === btn.dataset.addTemplate);
        if (!t) return;
        const room = 12 - draft.agents.length;
        if (room <= 0) { toast('Больше нельзя', 'Максимум 12 агентов', 'warn'); return; }
        const roles = t.roles.slice(0, room);
        draft.mission = t.mission;
        for (const key of roles) {
          const rk = typeof key === 'string' ? key : key.role;
          const fresh = newAgent(rk);
          if (typeof key !== 'string' && key.name && !draft.agents.some((a) => a.name === key.name)) {
            fresh.name = key.name;
            fresh.role = key.name;
          }
          fresh._open = false;
          draft.agents.push(fresh);
        }
        refreshMembers();
        toast(`Команда «${t.name}»`, `${roles.length} агентов · миссия «${t.mission}»`, 'ok');
        col.querySelector('.member')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
      });
    });

    col.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const a = draft.agents.find((x) => x.id === del.dataset.del);
        confirmDialog({
          kicker: 'конструктор',
          title: `Убрать «${a ? a.name : ''}» из проекта?`,
          text: 'Агент не сохранён — это только черновик состава.',
          okText: 'Убрать',
        }).then((ok) => {
          if (!ok) return;
          draft.agents = draft.agents.filter((x) => x.id !== del.dataset.del);
          refreshMembers();
        });
        return;
      }
      const perm = e.target.closest('[data-perm]');
      if (perm) {
        const card = perm.closest('.member');
        const a = draft.agents.find((x) => x.id === card.dataset.aid);
        if (!a) return;
        const kind = perm.dataset.perm;
        const pid = perm.dataset.pid;
        if (!Array.isArray(a.permissions[kind])) a.permissions[kind] = [];
        const arr = a.permissions[kind];
        const idx = arr.indexOf(pid);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(pid);
        perm.setAttribute('aria-checked', String(idx < 0));
        return;
      }
      const tog = e.target.closest('[data-toggle]');
      if (tog && !e.target.closest('[data-del]')) {
        const card = tog.closest('.member');
        const a = draft.agents.find((x) => x.id === card.dataset.aid);
        if (a) { a._open = !a._open; card.classList.toggle('open', !!a._open); }
      }
    });

    col.addEventListener('input', (e) => {
      const f = e.target.closest('[data-f]');
      if (!f) return;
      const card = f.closest('.member');
      const a = draft.agents.find((x) => x.id === card.dataset.aid);
      if (!a) return;
      const key = f.dataset.f;

      /* Смена провайдера: подставляем его первую модель и перерисовываем карточку */
      if (key === 'providerConfigId') {
        const p = activeProviders().find((x) => x.id === f.value);
        if (p) {
          a.providerConfigId = p.id;
          a.providerId = p.providerId;
          const models = modelsFor(p);
          a.model = models[0] || a.model;
        }
        refreshMembers();
        return;
      }

      if (key === 'temperature') {
        a.temperature = Number(f.value);
        updateRangeFill(f);
        const out = card.querySelector('[data-temp]');
        if (out) out.textContent = a.temperature.toFixed(1);
      } else if (key === 'inputPerm') {
        a.permissions.input = f.checked === true;
      } else {
        a[key] = f.value;
        if (key === 'name') {
          const title = card.querySelector('.member-title b');
          if (title) title.textContent = f.value || 'Без имени';
        }
        if (key === 'model') {
          const badge = card.querySelector('[data-model-badge]');
          if (badge) badge.textContent = f.value;
        }
      }
    });

    col.querySelectorAll('input[type="range"]').forEach(updateRangeFill);

    /* drag & drop */
    let dragId = null;
    col.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.member');
      if (!card) return;
      dragId = card.dataset.aid;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    col.addEventListener('dragover', (e) => {
      const card = e.target.closest('.member');
      if (!card || !dragId || card.dataset.aid === dragId) return;
      e.preventDefault();
      col.querySelectorAll('.member').forEach((m) => m.classList.remove('drop-before', 'drop-after'));
      const r = card.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      card.classList.add(before ? 'drop-before' : 'drop-after');
    });
    col.addEventListener('drop', (e) => {
      const card = e.target.closest('.member');
      if (!card || !dragId) return;
      e.preventDefault();
      const before = card.classList.contains('drop-before');
      const from = draft.agents.findIndex((x) => x.id === dragId);
      let to = draft.agents.findIndex((x) => x.id === card.dataset.aid);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = draft.agents.splice(from, 1);
      if (from < to) to--;
      draft.agents.splice(before ? to : to + 1, 0, moved);
      dragId = null;
      refreshMembers();
    });
    col.addEventListener('dragend', () => {
      dragId = null;
      col.querySelectorAll('.member').forEach((m) => m.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
  }

  /* ------------------------------------------------------- шаг 3 */

  function step3() {
    body.innerHTML = `
      <div class="step-panel orch-grid">
        <section class="panel graph-panel">
          <div class="kicker">схема связей <span class="k-dim">/ ${esc(ORCH_MODES[draft.orchestration].name.toLowerCase())}</span></div>
          <div id="graphHost">${graphHTML()}</div>
        </section>
        <aside class="orch-side">
          <div class="panel">
            <h3>Режим работы</h3>
            <div class="sub">как агенты передают друг другу контекст</div>
            <div class="seg" role="group" aria-label="Режим оркестрации">
              ${Object.entries(ORCH_MODES).map(([k, m]) => `
                <button data-mode="${k}" aria-pressed="${draft.orchestration === k}">${m.name}</button>`).join('')}
            </div>
            <p class="mode-desc" id="modeDesc" style="margin-top:13px">${esc(ORCH_MODES[draft.orchestration].desc)}</p>
          </div>
          <div class="panel">
            <h3>Бюджет шагов</h3>
            <div class="sub">лимит на один пакет задач команды</div>
            <div class="budget-top">
              <b id="budgetVal" class="mono">${draft.budgetSteps}</b>
              <span class="dim mono" style="font-size:11px">макс. 500</span>
            </div>
            <input type="range" min="10" max="500" step="10" value="${draft.budgetSteps}" id="budgetRange" aria-label="Бюджет шагов">
          </div>
        </aside>
      </div>`;

    body.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.orchestration = btn.dataset.mode;
        body.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        body.querySelector('#modeDesc').textContent = ORCH_MODES[draft.orchestration].desc;
        body.querySelector('#graphHost').innerHTML = graphHTML();
        body.querySelector('.graph-panel .k-dim').textContent = `/ ${ORCH_MODES[draft.orchestration].name.toLowerCase()}`;
      });
    });
    const range = body.querySelector('#budgetRange');
    updateRangeFill(range);
    range.addEventListener('input', () => {
      draft.budgetSteps = Number(range.value);
      body.querySelector('#budgetVal').textContent = draft.budgetSteps;
      updateRangeFill(range);
    });
  }

  function graphHTML() {
    if (!draft.agents.length) {
      return `<div class="empty" style="padding:38px 20px"><div class="empty-icon">${icon('gitBranch')}</div>
        <h3>Нечего связывать</h3><p>Вернитесь на шаг 2 и добавьте хотя бы одного агента.</p></div>`;
    }
    const W = 720, H = 340;
    const n = draft.agents.length;
    const nodes = [];
    const edges = [];

    if (draft.orchestration === 'parallel') {
      const hub = { x: 128, y: 170, hub: true };
      nodes.push(hub);
      const top = 46, bottom = H - 46;
      draft.agents.forEach((a, i) => {
        const y = n === 1 ? 170 : top + (i * (bottom - top)) / (n - 1);
        nodes.push({ x: 556, y, a });
        edges.push([hub, { x: 556, y }]);
      });
    } else if (draft.orchestration === 'sequential') {
      const cols = Math.min(4, n);
      const rows = Math.ceil(n / cols);
      let prev = null;
      draft.agents.forEach((a, i) => {
        const row = Math.floor(i / cols);
        const inRow = Math.min(cols, n - row * cols);
        const col = i - row * cols;
        const x = inRow === 1 ? W / 2 : 96 + (col * (W - 192)) / (inRow - 1);
        const y = rows === 1 ? 130 : row === 0 ? 96 : 246;
        const node = { x, y, a };
        nodes.push(node);
        if (prev) edges.push([prev, node]);
        prev = node;
      });
    } else {
      const root = { x: W / 2, y: 58, a: draft.agents[0], root: true };
      nodes.push(root);
      const kids = draft.agents.slice(1);
      const top = 232;
      kids.forEach((a, i) => {
        const x = kids.length === 1 ? W / 2 : 84 + (i * (W - 168)) / (kids.length - 1);
        const node = { x, y: top, a };
        nodes.push(node);
        edges.push([root, node]);
      });
      if (!kids.length) edges.push([root, { x: W / 2 + 170, y: 170 }]);
    }

    const path = (p1, p2) => {
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2 - 22;
      return `M${p1.x},${p1.y} Q${mx},${my} ${p2.x},${p2.y}`;
    };

    const nodeSVG = (nd) => {
      if (nd.hub) {
        return `<g transform="translate(${nd.x},${nd.y})">
          <circle class="g-halo" r="30" fill="#38E8FF" opacity=".16"/>
          <circle class="g-node-core" r="21" fill="#0a0d16" stroke="#38E8FF" stroke-width="1.6" stroke-dasharray="4 4"/>
          <circle r="6" fill="#38E8FF"/>
          <text class="g-label" y="42">ЯДРО</text>
          <text class="g-sub" y="56">оркестратор</text>
        </g>`;
      }
      const meta = roleMeta(a_roleKey(nd));
      const a = nd.a;
      const col = a.accent || meta.accent;
      return `<g transform="translate(${nd.x},${nd.y})">
        <circle class="g-halo" r="26" fill="${col}" opacity=".18"/>
        <circle class="g-node-core" r="18" fill="#0a0d16" stroke="${col}" stroke-width="1.6"/>
        <circle r="6.5" fill="${col}"/>
        <text class="g-label" y="38">${esc(a.name)}</text>
        <text class="g-sub" y="52">${esc(a.role)}</text>
      </g>`;
    };

    const a_roleKey = (nd) => nd.a ? nd.a.roleKey : 'assistant';

    return `
      <div class="graph-wrap">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Схема связей: ${esc(ORCH_MODES[draft.orchestration].name)}, агентов: ${n}">
          <defs>
            <linearGradient id="edge-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#38E8FF"/>
              <stop offset="1" stop-color="#8B5CF6"/>
            </linearGradient>
          </defs>
          ${edges.map(([p1, p2]) => `<path class="g-edge" d="${path(p1, p2)}"/>`).join('')}
          ${nodes.map(nodeSVG).join('')}
        </svg>
      </div>`;
  }

  /* ------------------------------------------------------- шаг 4 */

  function step4() {
    const svc = countPerms('services');
    const prg = countPerms('programs');
    const mcp = countPerms('mcp');
    body.innerHTML = `
      <div class="step-panel">
        <div class="review-grid stagger">
          <div class="panel review-card">
            <h4>миссия</h4>
            <div class="big">${esc(draft.name || 'Без названия')}</div>
            <p>${esc(draft.description || 'Описание не задано.')}</p>
            <span class="chip" style="--chip-c:var(--cyan);margin-top:10px"><i></i>${esc(draft.mission)}</span>
            <p class="mono dim" style="margin-top:10px;font-size:11.5px">папка: ${esc(draft.workspace || 'общая папка узла')}</p>
          </div>
          <div class="panel review-card">
            <h4>оркестрация</h4>
            <div class="big">${esc(ORCH_MODES[draft.orchestration].name)}</div>
            <p>${esc(ORCH_MODES[draft.orchestration].desc)}</p>
            <span class="chip" style="--chip-c:var(--amber);margin-top:10px"><i></i>бюджет: ${draft.budgetSteps} шагов</span>
          </div>
          <div class="panel review-card">
            <h4>состав · ${draft.agents.length}</h4>
            <div class="review-agents">
              ${draft.agents.map((a) => `
                <div class="review-agent" style="--accent:${a.accent}">
                  <span class="dot"></span>${esc(a.name)} <span>${esc(a.model)}</span>
                </div>`).join('')}
            </div>
          </div>
          <div class="panel review-card">
            <h4>разрешения</h4>
            <div class="review-agents">
              <div class="review-agent"><span class="dot" style="--accent:var(--cyan)"></span>сервисы <span>${svc}</span></div>
              <div class="review-agent"><span class="dot" style="--accent:var(--blue)"></span>программы пк <span>${prg}</span></div>
              <div class="review-agent"><span class="dot" style="--accent:var(--violet)"></span>mcp-серверы <span>${mcp}</span></div>
            </div>
          </div>
        </div>

        <div class="panel create-zone" id="createZone">
          <div class="kicker" style="justify-content:center">финал <span class="k-dim">/ шаг 04</span></div>
          <h3>Команда готова к развёртыванию</h3>
          <p>Кнопка атомарно сохранит состав в <span class="mono">data/team.json</span> и вернёт вас на главную, где экипаж сразу можно запустить.</p>
          <button class="btn btn-primary" id="createBtn">${icon('zap')}Создать команду</button>
        </div>
      </div>`;

    stagger(body.querySelector('.review-grid'));
    body.querySelector('#createBtn').addEventListener('click', create);
  }

  function countPerms(kind) {
    return draft.agents.reduce((sum, a) => sum + (a.permissions[kind] ? a.permissions[kind].length : 0), 0);
  }

  /* ------------------------------------------------------ создание */

  async function create() {
    const btn = body.querySelector('#createBtn');
    if (!btn || btn.classList.contains('btn-busy')) return;
    if (!validate(1) || !validate(2)) {
      toast('Черновик неполон', 'Вернитесь на шаги 1–2 и заполните обязательные поля', 'warn');
      return;
    }
    btn.classList.add('btn-busy');
    btn.innerHTML = `<span class="spinner"></span>Сохраняем…`;
    try {
      await createTeam({
        team: {
          name: draft.name.trim(),
          description: draft.description.trim(),
          mission: draft.mission,
          orchestration: draft.orchestration,
          budgetSteps: draft.budgetSteps,
          workspace: (draft.workspace || '').trim(),
        },
        agents: draft.agents.map((a) => ({
          id: a.id,
          name: a.name.trim(),
          role: a.role,
          roleKey: a.roleKey,
          accent: a.accent,
          providerConfigId: a.providerConfigId,
          providerId: a.providerId,
          model: a.model,
          temperature: a.temperature,
          systemPrompt: a.systemPrompt,
          status: 'online',
          currentTask: 'готов к задаче',
          permissions: a.permissions,
          spark: a.spark,
        })),
        event: {
          text: `Команда «${draft.name.trim()}» создана: ${draft.agents.length} агентов, режим ${ORCH_MODES[draft.orchestration].name.toLowerCase()}`,
          kind: 'ok',
        },
      });
      burst(btn);
      toast('Команда создана', `${draft.agents.length} агентов готовы к запуску`, 'ok');
      draft = freshDraft();
      setTimeout(() => { window.location.hash = '#/'; }, reducedMotion ? 60 : 760);
    } catch (e) {
      toast('Ошибка создания', e.message, 'err');
      btn.classList.remove('btn-busy');
      btn.innerHTML = `${icon('zap')}Создать команду`;
    }
  }

  function burst(anchor) {
    const zone = body.querySelector('#createZone');
    if (zone && !reducedMotion) {
      const ring = document.createElement('span');
      ring.className = 'pulse-ring';
      zone.appendChild(ring);
      setTimeout(() => ring.remove(), 1500);
    }
    if (reducedMotion) return;
    const r = anchor.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const colors = ['#38E8FF', '#8B5CF6', '#A3E635', '#FBBF24', '#F472B6', '#60A5FA'];
    for (let i = 0; i < 64; i++) {
      const p = document.createElement('span');
      p.className = 'confetti';
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      p.style.background = colors[i % colors.length];
      const ang = (Math.PI * 2 * i) / 64 + Math.random() * 0.5;
      const dist = 90 + Math.random() * 260;
      p.style.setProperty('--tx', `${Math.cos(ang) * dist}px`);
      p.style.setProperty('--ty', `${Math.sin(ang) * dist + 120}px`);
      p.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
      p.style.animationDelay = `${Math.random() * 0.12}s`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1800);
    }
  }

  /* ------------------------------------------------- навигация/валидация */

  function validate(step) {
    if (step === 1) return draft.name.trim().length >= 2;
    if (step === 2) return draft.agents.length >= 0 && draft.agents.length > 0;
    return true;
  }

  function updateFoot() {
    const ok = validate(draft.step);
    prevBtn.style.visibility = draft.step === 1 ? 'hidden' : 'visible';
    nextBtn.hidden = draft.step >= 4;
    nextBtn.disabled = !ok;
    if (draft.step === 1) note.textContent = ok ? 'готово к переходу' : 'укажите название (мин. 2 символа)';
    else if (draft.step === 2) note.textContent = ok ? `агентов: ${draft.agents.length}` : 'добавьте хотя бы одного агента';
    else if (draft.step === 3) note.textContent = `режим: ${ORCH_MODES[draft.orchestration].name.toLowerCase()} · бюджет ${draft.budgetSteps}`;
    else note.textContent = `проверьте обзор и создавайте`;
  }

  function renderStep() {
    renderSteps();
    if (draft.step === 1) step1();
    else if (draft.step === 2) step2();
    else if (draft.step === 3) step3();
    else step4();
    updateFoot();
    body.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }

  prevBtn.addEventListener('click', () => {
    if (draft.step > 1) { draft.step--; renderStep(); }
  });
  nextBtn.addEventListener('click', () => {
    if (!validate(draft.step)) {
      toast('Шаг неполон', note.textContent, 'warn');
      return;
    }
    if (draft.step < 4) { draft.step++; renderStep(); }
  });

  renderStep();

  /* Базы знаний для чипов привязки: подтягиваем и обновляем шаг 2, если он открыт */
  getKb().then(() => { if (draft.step === 2 && body.querySelector('#membersCol')) refreshMembers(); });

  return () => { /* черновик сохраняется в памяти модуля */ };
}
