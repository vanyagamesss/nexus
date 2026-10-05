/* NEXUS — вид «Настройки»: сервисы, программы ПК, MCP-серверы */

import {
  esc, icon, toast, confirmDialog, openModal, fmtTime, fmtDateTime,
  reducedMotion, SVC_COLORS, copyText, qrSvg,
} from './ui.js';
import {
  store, bus, saveService, removeService, checkService, runServiceAction,
  saveProgram, removeProgram, refreshPrograms, saveMcp, removeMcp, reconnectMcp,
  probeProvider, removeProvider, saveProvider,
  refreshAccess, refreshNet, setPin, clearPin, saveAccess, createInvite, revokeInvites,
  getTgBridge, saveTgBridge, testTgBridge, recentTgChats,
} from './store.js';
import { api } from './api.js';

const SVC_ICONS = {
  github: 'github', gitlab: 'gitBranch', telegram: 'send', slack: 'slack', notion: 'notion',
  gdrive: 'cloud', openai: 'openai', ollama: 'ollama', smtp: 'mail', obsidian: 'pen',
  trello: 'checkSquare', openweather: 'cloud', googlesearch: 'search', exa: 'zap',
  currency: 'chart', wikipedia: 'search',
  postgres: 'database', k8s: 'k8s', custom: 'plug',
};

const TABS = [
  { key: 'llm', label: 'LLM-модели', icon: 'openai' },
  { key: 'services', label: 'Сервисы и соцсети', icon: 'link' },
  { key: 'programs', label: 'Программы ПК', icon: 'appWindow' },
  { key: 'mcp', label: 'MCP-серверы', icon: 'layers' },
  { key: 'access', label: 'Доступ', icon: 'sliders' },
];

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  let active = 'llm';
  let scanning = false;

  page.innerHTML = `
    <div class="sec-head" style="margin-top:0">
      <div>
        <div class="kicker">модели · сервисы · пк · mcp <span class="k-dim">/ узел nexus-01</span></div>
        <h2>Подключения</h2>
      </div>
      <span class="sec-note">ключи хранятся локально · data/*.json</span>
    </div>

    <div class="tabs" role="tablist" aria-label="Разделы настроек">
      <span class="tab-ind" id="tabInd" aria-hidden="true"></span>
      ${TABS.map((t, i) => `
        <button class="tab" role="tab" data-tab="${t.key}" id="tab-${t.key}" aria-selected="${i === 0}" aria-controls="tabPanel">
          ${icon(t.icon)}${t.label}<span class="tab-n" data-count="${t.key}">0</span>
        </button>`).join('')}
    </div>

    <div id="tabPanel" role="tabpanel" aria-labelledby="tab-${active}"></div>`;

  const panel = page.querySelector('#tabPanel');
  const ind = page.querySelector('#tabInd');

  function counts() {
    const map = {
      services: store.services.length,
      programs: store.programs.length,
      mcp: store.mcp.length,
      llm: store.providers.length,
      access: store.access && store.access.pinEnabled ? 1 : 0,
    };
    page.querySelectorAll('[data-count]').forEach((el) => { el.textContent = map[el.dataset.count] ?? 0; });
  }

  function moveIndicator() {
    const btn = page.querySelector(`[data-tab="${active}"]`);
    if (!btn) return;
    ind.style.left = `${btn.offsetLeft}px`;
    ind.style.width = `${btn.offsetWidth}px`;
  }

  function setTab(key) {
    active = key;
    page.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === key)));
    panel.setAttribute('aria-labelledby', `tab-${key}`);
    renderPanel();
    moveIndicator();
  }

  page.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  /* ==================================================== LLM-ПРОВАЙДЕРЫ */

  function provBadge(p) {
    if (!p.enabled) return '<span class="badge badge-off"><i></i>выключен</span>';
    if (p.lastCheck === null || p.lastCheck === undefined) return '<span class="badge"><i></i>не проверен</span>';
    if (p.lastCheckOk) return `<span class="badge badge-ok"><i></i>готов · ${p.latencyMs || 0} мс</span>`;
    return `<span class="badge badge-err"><i></i>ошибка</span>`;
  }

  function provCard(p) {
    const models = p.models || [];
    const known = store.catalog.find((c) => c.id === p.providerId);
    const name = known ? known.name : p.providerName || p.providerId;
    return `
      <article class="panel llm-card" data-prv="${esc(p.id)}">
        <div class="llm-top">
          <span class="llm-ico">${icon(known && known.icon === 'openai' ? 'openai' : known && known.family === 'ollama' ? 'ollama' : 'cloud')}</span>
          <div class="llm-name">
            <b>${esc(name)}</b>
            <span class="mono" title="${esc(p.baseUrl || '')}">${esc(p.baseUrl || '—')}</span>
          </div>
          <div class="llm-right">
            ${p.isDefault ? '<span class="chip chip-def"><i></i>по умолчанию</span>' : ''}
            ${provBadge(p)}
          </div>
        </div>

        <div class="llm-key">
          <span class="${p.hasKey ? 'k-ok' : 'k-no'}">${p.hasKey ? `${icon('check')} ключ ${esc(p.keyHint || '')}` : 'ключ не задан'}</span>
          ${p.lastCheck && p.lastCheckOk === false && p.lastCheckDetail
            ? `<span class="llm-err" title="${esc(p.lastCheckDetail)}">${esc(String(p.lastCheckDetail).slice(0, 80))}</span>` : ''}
        </div>

        <div class="llm-models">
          ${models.length
            ? models.slice(0, 6).map((m) => `<span class="chip" style="--chip-c:var(--cyan)"><i></i>${esc(typeof m === 'string' ? m : m.id)}</span>`).join('')
              + (models.length > 6 ? `<span class="chip">+${models.length - 6}</span>` : '')
            : '<span class="dim" style="font-size:11.5px">модели не получены — нажмите «Проверить»</span>'}
        </div>

        <div class="llm-foot">
          <button class="btn btn-mini ${p.lastCheckOk ? '' : 'btn-run'}" data-probe>${icon('refresh')}Проверить</button>
          <button class="btn btn-mini btn-ghost" data-models>${icon('layers')}Модели${models.length ? ` · ${models.length}` : ''}</button>
          ${!p.isDefault ? `<button class="btn btn-mini btn-ghost" data-def>${icon('check')}По умолчанию</button>` : ''}
          <button class="btn btn-mini btn-ghost" data-key>${icon('pencil')}Ключ</button>
          <button class="icon-btn danger" data-del aria-label="Удалить провайдера ${esc(name)}">${icon('trash')}</button>
        </div>
      </article>`;
  }

  function renderLlm() {
    const cat = store.catalog || [];
    const used = new Set(store.providers.map((p) => p.providerId));
    const free = cat.filter((c) => !used.has(c.id));

    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">мозг команды</div><h2>LLM-провайдеры</h2></div>
          <span class="sub">реальные ключи и живой список моделей. Ключи шифруются и лежат в data/config.json.</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-add-prv>${icon('plus')}Добавить провайдера</button>
        </div>

        ${store.providers.length ? `<div class="llm-grid">${store.providers.map(provCard).join('')}</div>` : ''}

        ${free.length ? `
          <div class="llm-catalog">
            <div class="kicker" style="margin-bottom:10px">быстрое добавление · каталог ${cat.length}</div>
            <div class="llm-catalog-grid">
              ${free.map((c) => `
                <button class="llm-cat" data-quick="${esc(c.id)}" title="${esc(c.keyUrl || c.docs || '')}">
                  ${icon(c.family === 'anthropic' ? 'bot' : c.family === 'ollama' ? 'ollama' : 'cloud')}
                  <b>${esc(c.name)}</b>
                  <span>${c.keyRequired ? 'нужен ключ' : 'без ключа'}${c.dynamicModels ? ' · живой список' : ''}</span>
                </button>`).join('')}
            </div>
          </div>` : ''}
      </div>`;

    panel.querySelectorAll('[data-add-prv]').forEach((b) => b.addEventListener('click', () => providerModal(null)));
    panel.querySelectorAll('[data-quick]').forEach((b) =>
      b.addEventListener('click', () => providerModal(null, b.dataset.quick)));

    panel.querySelectorAll('[data-prv]').forEach((card) => {
      const p = store.providers.find((x) => x.id === card.dataset.prv);
      if (!p) return;

      card.querySelector('[data-probe]').addEventListener('click', async () => {
        const btn = card.querySelector('[data-probe]');
        btn.innerHTML = '<span class="spinner"></span>Проверяем';
        btn.style.pointerEvents = 'none';
        try {
          const res = await probeProvider(p.id);
          const found = res.models || [];
          if (!res.ok) {
            toast(`${p.providerName}: отказ`, res.detail || res.message || 'нет связи', 'err');
          } else if (found.length) {
            /* Ключ рабочий - сразу предлагаем выбрать нужные модели */
            await openModelPicker(p, found, new Map((res.meta || []).map((x) => [x.id, x])));
          } else {
            toast(`${p.providerName}: готово`, 'Провайдер ответил, моделей не вернул', 'ok');
          }
        } catch (e) {
          toast('Ошибка проверки', e.message, 'err');
        } finally {
          renderLlm();
        }
      });

      /* Выбор моделей по уже загруженному списку, без повторной проверки */
      card.querySelector('[data-models]').addEventListener('click', async () => {
        const known = (p.allModels && p.allModels.length ? p.allModels : p.models) || [];
        if (!known.length) {
          toast('Список моделей пуст', 'Нажмите «Проверить», чтобы получить его у провайдера.', 'warn');
          return;
        }
        await openModelPicker(p, known, new Map());
      });

      card.querySelector('[data-def]')?.addEventListener('click', async () => {
        try {
          await saveProvider({ id: p.id, providerId: p.providerId, isDefault: true });
          toast('Провайдер по умолчанию', p.providerName || p.providerId, 'ok');
        } catch (e) { toast('Ошибка', e.message, 'err'); }
      });

      card.querySelector('[data-key]').addEventListener('click', () => providerModal(p));

      card.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: 'удаление провайдера',
          title: `Отключить «${p.providerName || p.providerId}»?`,
          text: 'Ключ и список моделей будут удалены из data/config.json.',
          okText: 'Удалить',
        });
        if (!ok) return;
        try { await removeProvider(p.id); toast('Провайдер удалён', p.providerName || p.providerId, 'ok'); }
        catch (e) { toast('Ошибка', e.message, 'err'); }
      });
    });
  }

  /* ======================================================== выбор моделей */

  /**
   * Поисковая модалка моделей провайдера.
   * Список может быть длинным (у OpenRouter сотни), поэтому: поиск по id,
   * показ окна контекста и цены, «выбрать все/снять всё», и ручной ввод id,
   * если нужной модели нет в выдаче провайдера.
   * resolve -> массив выбранных id, reject если отменил.
   */
  function pickModels({ title, models: rawModels, meta = new Map(), selected = new Set(), extra = [] }) {
    return new Promise((resolve, reject) => {
      /* Принимаем и строки-id, и объекты моделей */
      const models = rawModels.map((m) => (typeof m === 'string' ? { id: m } : m));
      const ids = new Set(models.map((m) => m.id));
      const chosen = new Set(selected);
      const src = new Map(models.map((m) => [m.id, meta.get(m.id) || m || {}]));
      /* listHTML() вызывается при создании модалки - searches уже могут быть нет */
      let searchInput = null;

      const rows = () => {
        const q = ((searchInput && searchInput.value) || '').trim().toLowerCase();
        return models
          .filter((m) => !q || String(m.id).toLowerCase().includes(q))
          .slice(0, 300);
      };

      const price = (m) => {
        if (m.in || m.out) {
          const f = (v) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
          return `${f(m.in)} / ${f(m.out)} за 1M`;
        }
        return '';
      };

      /** Окно контекста: 200000 -> "200K", 1048576 -> "1M". */
      const ctxLabel = (n) => {
        if (!n) return '';
        if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M контекст`;
        return `${Math.round(n / 1000)}K контекст`;
      };

      const listHTML = () => {
        const r = rows();
        if (!r.length) return '<div class="dim" style="padding:22px;text-align:center;font-size:12.5px">Ничего не найдено. Проверьте запрос или введите id вручную ниже.</div>';
        return r
          .map((m) => {
            const id = m.id;
            const meta0 = src.get(id) || m;
            const bits = [];
            const cx = ctxLabel(meta0.ctx);
            if (cx) bits.push(cx);
            const pr = price(meta0);
            if (pr) bits.push(pr);
            if (meta0.src === 'catalog') bits.push('каталог');
            return `<label class="mp-row${chosen.has(id) ? ' is-on' : ''}" data-mp-row="${esc(id)}">
              <input type="checkbox" data-mp="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}>
              <span class="mp-id">${esc(id)}</span>
              ${bits.length ? `<span class="mp-meta">${esc(bits.join(' · '))}</span>` : ''}
            </label>`;
          })
          .join('');
      };

      const dlg = openModal({
        kicker: 'модели провайдера',
        title: `Выбор моделей · ${title}`,
        body: `
          <div class="mp-bar">
            <input class="input" id="mpSearch" placeholder="Поиск по названию… (например gpt-4o, claude, llama)" autocomplete="off">
            <button class="btn btn-mini btn-ghost" id="mpAll" type="button">выбрать все</button>
            <button class="btn btn-mini btn-ghost" id="mpNone" type="button">снять всё</button>
          </div>
          <div class="mp-count" id="mpCount"></div>
          <div class="mp-list" id="mpList">${listHTML()}</div>
          <div class="field" style="margin-top:14px">
            <label>Добавить модель вручную</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="mpManual" placeholder="id модели, например provider/model-id" autocomplete="off">
              <button class="btn btn-mini btn-run" id="mpAdd" type="button">${icon('plus')}Добавить</button>
            </div>
            <span class="field-hint">Если модель есть у провайдера, но не попала в список — впишите её id вручную.</span>
          </div>
          <div id="mpManualList" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>`,
        footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
                 <button class="btn btn-primary" id="mpOk">${icon('check')}Готово</button>`,
      });

      searchInput = dlg.modal.querySelector('#mpSearch');
      const listBox = dlg.modal.querySelector('#mpList');
      const countBox = dlg.modal.querySelector('#mpCount');
      const manualInput = dlg.modal.querySelector('#mpManual');
      const manualBox = dlg.modal.querySelector('#mpManualList');

      /* Уже сохранённые id, которых нет в свежем списке, показываем как ручные */
      const manual = new Set(extra);
      const renderManual = () => {
        manualBox.innerHTML = [...manual]
          .map((id) => `<span class="chip chip-removable" style="--chip-c:var(--amber)">${esc(id)}<button type="button" data-rm="${esc(id)}" aria-label="Убрать">${icon('x')}</button></span>`)
          .join('');
      };
      const renderCount = () => {
        countBox.textContent = `Выбрано ${chosen.size} из ${models.length}${manual.size ? ` + ${manual.size} вручную` : ''}`;
      };

      const repaint = () => {
        listBox.innerHTML = listHTML();
        renderCount();
      };

      dlg.modal.querySelector('#mpAll').addEventListener('click', () => {
        for (const m of models) chosen.add(m.id);
        repaint();
      });
      dlg.modal.querySelector('#mpNone').addEventListener('click', () => {
        chosen.clear();
        repaint();
      });
      searchInput.addEventListener('input', repaint);

      listBox.addEventListener('change', (e) => {
        const id = e.target.dataset.mp;
        if (!id) return;
        if (e.target.checked) chosen.add(id);
        else chosen.delete(id);
        e.target.closest('.mp-row')?.classList.toggle('is-on', e.target.checked);
        renderCount();
      });

      const addManual = () => {
        const v = (manualInput.value || '').trim();
        if (!v) return;
        for (const part of v.split(/[,\s]+/)) {
          const id = part.trim();
          if (id && !ids.has(id) && !manual.has(id)) manual.add(id);
        }
        manualInput.value = '';
        renderManual();
        renderCount();
      };
      dlg.modal.querySelector('#mpAdd').addEventListener('click', addManual);
      manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } });
      manualBox.addEventListener('click', (e) => {
        const id = e.target.dataset.rm;
        if (id) { manual.delete(id); renderManual(); renderCount(); }
      });

      dlg.modal.querySelector('[data-cancel]').addEventListener('click', () => { dlg.close(); reject(new Error('отменено')); });
      dlg.modal.querySelector('#mpOk').addEventListener('click', () => {
        if (!chosen.size && !manual.size) {
          toast('Выберите хотя бы одну модель', 'Без моделей агентам нечего использовать.', 'warn');
          return;
        }
        dlg.close();
        resolve([...chosen, ...manual]);
      });

      renderManual();
      renderCount();
      setTimeout(() => searchInput.focus(), 30);
    });
  }

  /**
 * Открывает выбор моделей и сохраняет результат.
 * meta: Map(id -> {ctx, in, out, src}) либо массив таких объектов.
 */
async function openModelPicker(providerEntry, modelIds, meta) {
  const map = meta instanceof Map ? meta : new Map((meta || []).map((x) => [x.id, x]));
  const saved = providerEntry.models || [];
  const chosen0 = new Set(saved.filter((id) => modelIds.includes(id)));
  /* Сохранённые вручную id не приходят от провайдера - показываем их отдельно,
     иначе повторное сохранение их бы стёрло */
  const extra = saved.filter((id) => !modelIds.includes(id));
  if (!chosen0.size) for (const id of modelIds.slice(0, 5)) chosen0.add(id);

  let chosen;
  try {
    chosen = await pickModels({
      title: providerEntry.providerName || providerEntry.providerId,
      models: modelIds,
      meta: map,
      selected: chosen0,
      extra,
    });
  } catch {
    return; /* отменил выбор - ничего не меняем */
  }
  await saveProvider({
    id: providerEntry.id,
    providerId: providerEntry.providerId,
    models: chosen,
  });
  toast('Модели сохранены', `${chosen.length} доступно агенту`, 'ok');
  renderLlm();
}

  function providerModal(p, presetProviderId) {
    const isNew = !p;
    const cat = store.catalog || [];
    const cur = p ? p.providerId : (presetProviderId || (cat[0] && cat[0].id));
    const known = cat.find((c) => c.id === cur) || {};
    const m = openModal({
      kicker: isNew ? 'новый провайдер' : 'доступ к API',
      title: isNew ? 'Добавить LLM-провайдера' : `${p.providerName || p.providerId} — ключ`,
      body: `
        ${isNew ? `
          <div class="field"><label>провайдер</label>
            <select class="select" id="pvId">
              ${cat.map((c) => `<option value="${esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
            <span class="field-hint" id="pvHint">${esc(known.keyUrl ? `ключ: ${known.keyUrl}` : 'ключ не требуется')}</span>
          </div>` : ''}
        <div class="field"><label>base url</label>
          <input class="input" id="pvUrl" maxlength="300" placeholder="https://api.openai.com/v1"
            value="${esc(p ? (p.baseUrl || '') : (known.baseUrl || ''))}">
          <span class="field-hint">свой адрес нужен для прокси, Ollama или совместимых сервисов</span>
        </div>
        <div class="field"><label>api-ключ</label>
          <div style="display:flex;gap:8px">
            <input class="input" id="pvKey" type="password" autocomplete="off"
              placeholder="${esc(isNew ? 'вставьте ключ' : 'оставьте пустым — ключ не менять')}"
              value="">
            <button class="icon-btn" id="pvEye" aria-label="Показать ключ"
              style="flex:none;width:44px;border:1px solid var(--line)">${icon('eye')}</button>
          </div>
          <span class="field-hint">хранится зашифрованным (AES-256-GCM) в data/.secret — не показывается снова</span>
        </div>
        <label class="chk-row"><input type="checkbox" id="pvDef" ${isNew ? 'checked' : ''}>
          <span>Сделать провайдером по умолчанию</span></label>
        <div id="pvRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="pvSave">${icon('check')}${isNew ? 'Сохранить и проверить' : 'Сохранить'}</button>`,
    });

    const keyInput = m.modal.querySelector('#pvKey');
    m.modal.querySelector('#pvEye').addEventListener('click', (e) => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);

    const sel = m.modal.querySelector('#pvId');
    sel?.addEventListener('change', () => {
      const c = cat.find((x) => x.id === sel.value) || {};
      m.modal.querySelector('#pvUrl').value = c.baseUrl || '';
      m.modal.querySelector('#pvHint').textContent = c.keyUrl ? `ключ: ${c.keyUrl}` : 'ключ не требуется';
    });

    m.modal.querySelector('#pvSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#pvSave');
      const resBox = m.modal.querySelector('#pvRes');
      const providerId = isNew ? sel.value : p.providerId;
      const baseUrl = (m.modal.querySelector('#pvUrl').value || '').trim();
      const apiKey = (keyInput.value || '').trim();
      const isDefault = m.modal.querySelector('#pvDef').checked;

      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">base url должен начинаться с http:// или https://</div>';
        return;
      }
      const catEntry = cat.find((c) => c.id === providerId) || {};
      if (isNew && catEntry.keyRequired && !apiKey) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">Для этого провайдера нужен API-ключ.</div>';
        return;
      }

      btn.innerHTML = '<span class="spinner"></span>Сохраняем';
      btn.style.pointerEvents = 'none';
      const body = { providerId, baseUrl, isDefault };
      if (isNew) body.test = true;
      if (apiKey) body.apiKey = apiKey;
      if (!isNew) body.id = p.id;

      const beforeIds = new Set(store.providers.map((x) => x.id));
      try {
        const saved = await saveProvider(body);
        const targetId = isNew
          ? ((saved.providers || []).find((x) => !beforeIds.has(x.id)) || {}).id
          : p.id;

        resBox.innerHTML = '<div class="banner banner-warn" style="margin:0"><span class="spinner"></span>Проверяем соединение…</div>';
        const res = targetId ? await probeProvider(targetId) : { ok: false, detail: 'провайдер не создан', models: [] };

        const found = res.models || [];
        if (!targetId || !found.length) {
          resBox.innerHTML = `<div class="banner banner-err" style="margin:0">Сохранено, но модели получить не удалось: ${esc(res.detail || res.message || 'нет связи')}</div>`;
          btn.innerHTML = `${icon('check')}Закрыть`;
          btn.style.pointerEvents = '';
          btn.onclick = m.close;
          return;
        }

        /* Ключ рабочий - сразу даём выбрать модели, вместо тихого выбора всех */
        const preselect = new Set(
          (p && p.models && p.models.length ? p.models : found.slice(0, 5)).slice(0, 500),
        );
        const fresh = { id: targetId, providerId, providerName: catEntry.name || providerId, models: [...preselect] };
        m.close();
        toast('Провайдер подключён', `Найдено моделей: ${found.length}`, 'ok');
        renderLlm();
        await openModelPicker(fresh, found, new Map((res.meta || []).map((x) => [x.id, x])));
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}${isNew ? 'Сохранить и проверить' : 'Сохранить'}`;
        btn.style.pointerEvents = '';
      }
    });
  }

  /* ====================================================== СЕРВИСЫ */

  function svcCardHTML(s) {
    const color = SVC_COLORS[s.id] || SVC_COLORS[s.icon] || SVC_COLORS.custom;
    const connected = s.status === 'connected';
    const checked = s.lastCheck != null;
    const readOps = (s.actions || []).filter((a) => !a.write).length;
    const writeOps = (s.actions || []).filter((a) => a.write).length;
    return `
      <article class="svc-card" style="--sc:${color}" data-svc="${esc(s.id)}">
        <div class="svc-top">
          <span class="svc-ico">${icon(SVC_ICONS[s.id] || s.icon || 'plug')}</span>
          <div class="svc-name">
            <b>${esc(s.name)}</b>
            <span>${esc(s.category)}</span>
          </div>
          <span class="badge ${connected ? 'badge-ok' : 'badge-off'}"><i></i>${connected ? 'подключён' : 'не подключён'}</span>
        </div>
        <div class="svc-key">
          ${s.noKey
            ? `<span class="k-ok">${esc((s.url || '').slice(0, 40))}</span><span>путь задан</span>`
            : s.hasKey
              ? `<span class="k-ok">${esc(s.keyHintMask || '')}</span><span>ключ сохранён</span>`
              : '<span class="k-no">ключ не задан</span>'}
          ${checked ? `<span style="margin-left:auto;color:var(--text-3)">${fmtTime(s.lastCheck)}</span>` : ''}
        </div>
        ${s.checkDetail ? `<div class="svc-detail" title="${esc(s.checkDetail)}">${esc(s.checkDetail)}</div>` : ''}
        ${(s.actions || []).length ? `<div class="svc-ops"><b>${readOps}</b> чтение · <b>${writeOps}</b> запись</div>` : ''}
        <div class="svc-foot">
          <button class="btn btn-mini ${connected ? '' : 'btn-run'}" data-check>${s.noKey ? 'проверить путь' : s.hasKey ? 'проверить' : 'добавить ключ'}</button>
          ${(s.actions || []).length ? `<button class="btn btn-mini btn-ghost" data-ops>операции</button>` : ''}
          <button class="btn btn-mini btn-ghost" data-edit>${s.noKey ? 'путь' : s.hasKey ? 'сменить ключ' : 'ключ'}</button>
          <button class="icon-btn danger" data-del aria-label="Удалить сервис ${esc(s.name)}">${icon('trash')}</button>
        </div>
      </article>`;
  }

  function renderServices() {
    const available = (store.integrations || []).filter((i) => !store.services.some((s) => s.id === i.id));
    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">внешние узлы</div><h2>Сервисы</h2></div>
          <span class="sub">Telegram, Google Drive, GitHub и другие — операции доступны агентам по разрешениям.</span>
        </div>
        ${store.services.length ? `
          <div class="svc-grid">
            ${store.services.map(svcCardHTML).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">${icon('plug')}</div>
            <h3>Сервисы не подключены</h3>
            <p>Выберите сервис ниже и вставьте его API-ключ.</p>
          </div>`}

        ${available.length ? `
        <div class="tool-head" style="margin-top:26px">
          <div><div class="kicker">каталог</div><h2>Доступные интеграции</h2></div>
          <span class="sub">Готовые коннекторы: у каждого свои операции для агента.</span>
        </div>
        <div class="svc-grid">
          ${available.map((i) => `
            <article class="svc-card svc-card-add" style="--sc:${SVC_COLORS[i.id] || SVC_COLORS.custom}">
              <div class="svc-top">
                <span class="svc-ico">${icon(SVC_ICONS[i.id] || i.icon || 'plug')}</span>
                <div class="svc-name"><b>${esc(i.name)}</b><span>${esc(i.category)}</span></div>
                <span class="badge badge-off"><i></i>не подключён</span>
              </div>
              <div class="svc-detail">${esc(i.keyLabel)}${i.actions.length ? ` · ${i.actions.length} операций` : ''}</div>
              <div class="svc-foot">
                <button class="btn btn-mini btn-run" data-add-int="${esc(i.id)}">${icon('plus')}Подключить</button>
                ${i.docs ? `<a class="btn btn-mini btn-ghost" href="${esc(i.docs)}" target="_blank" rel="noopener">документация</a>` : ''}
              </div>
            </article>`).join('')}
        </div>` : ''}
      </div>`;

    panel.querySelectorAll('[data-add-int]').forEach((b) => b.addEventListener('click', () => {
      connectModal(null, store.integrations.find((x) => x.id === b.dataset.addInt));
    }));
    panel.querySelectorAll('[data-svc]').forEach((card) => {
      const svc = store.services.find((x) => x.id === card.dataset.svc);
      if (!svc) return;
      const check = card.querySelector('[data-check]');
      if (check) check.addEventListener('click', () => {
        if (!svc.hasKey) { connectModal(svc); return; }
        runCheck(svc, card);
      });
      const ops = card.querySelector('[data-ops]');
      if (ops) ops.addEventListener('click', () => actionModal(svc));
      const edit = card.querySelector('[data-edit]');
      if (edit) edit.addEventListener('click', () => connectModal(svc));
      const del = card.querySelector('[data-del]');
      if (del) del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: 'удаление сервиса',
          title: `Отключить «${svc.name}»?`,
          text: 'Сервис и сохранённый ключ будут удалены из data/services.json.',
          okText: 'Удалить',
        });
        if (!ok) return;
        try { await removeService(svc.id); toast('Сервис удалён', svc.name, 'ok'); }
        catch (e) { toast('Ошибка', e.message, 'err'); }
      });
    });
  }

  async function runCheck(svc, card) {
    const btn = card && card.querySelector('[data-check]');
    if (btn) { btn.innerHTML = '<span class="spinner"></span>проверка'; btn.style.pointerEvents = 'none'; }
    try {
      const res = await checkService(svc.id);
      const detail = res.detail || res.message || '';
      if (res.ok) toast(`${svc.name}: ок`, `${detail || 'Соединение установлено'} · ${res.latencyMs} мс`, 'ok');
      else toast(`${svc.name}: отказ`, detail || 'сервис не ответил', 'err');
    } catch (e) {
      toast('Ошибка проверки', e.message, 'err');
    } finally {
      renderPanel();
    }
  }

  /** Ручной вызов операции сервиса — проверить ключ на реальном действии. */
  function actionModal(svc) {
    const acts = svc.actions || [];
    if (!acts.length) return;
    const full = store.access && store.access.mode === 'full';

    const m = openModal({
      kicker: svc.name.toLowerCase(),
      title: 'Проверка операции',
      body: `
        <div class="field"><label>операция</label>
          <select class="select" id="aName">${acts.map((a) => `<option value="${esc(a.name)}"${a.write && !full ? ' disabled' : ''}>${esc(a.label)}${a.write ? ' · запись' : ''}</option>`).join('')}</select></div>
        <div id="aFields"></div>
        <div id="aRes"></div>
        ${!full ? '<div class="banner banner-warn" style="margin:0 0 12px">Операции записи доступны в режиме «полный доступ» (Настройки → Доступ).</div>' : ''}`,
      footer: `
        <button class="btn btn-ghost" data-cancel>Закрыть</button>
        <button class="btn btn-primary" id="aRun">${icon('play')}Выполнить</button>`,
    });

    const nameSel = m.modal.querySelector('#aName');
    const fields = m.modal.querySelector('#aFields');
    const resBox = m.modal.querySelector('#aRes');

    const paint = () => {
      const act = acts.find((a) => a.name === nameSel.value);
      const it = store.integrations.find((x) => x.id === (svc.integrationId || svc.id));
      const params = (it && it.actions.find((a) => a.name === act.name) || {}).params || [];
      fields.innerHTML = params.length
        ? params.map((p) => `<div class="field"><label>${esc(p.name)}</label><input class="input" data-arg="${esc(p.name)}" placeholder="${esc(p.description)}"></div>`).join('')
        : '<span class="field-hint">Параметров нет.</span>';
    };
    nameSel.addEventListener('change', paint);
    paint();

    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#aRun').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#aRun');
      const act = acts.find((a) => a.name === nameSel.value);
      const it = store.integrations.find((x) => x.id === (svc.integrationId || svc.id));
      const params = (it && it.actions.find((a) => a.name === act.name) || {}).params || [];
      const args = {};
      for (const p of params) {
        const inp = m.modal.querySelector(`[data-arg="${CSS.escape(p.name)}"]`);
        const v = inp && inp.value;
        if (v !== undefined && String(v).trim() !== '') args[p.name] = String(v).trim();
      }
      btn.innerHTML = '<span class="spinner"></span>Выполняем';
      btn.style.pointerEvents = 'none';
      try {
        const out = await runServiceAction(svc.id, act.name, args);
        if (out.ok) {
          resBox.innerHTML = `<div class="banner banner-ok" style="margin:0"><b>Готово за ${out.latencyMs} мс</b><pre class="svc-pre">${esc(out.result)}</pre></div>`;
          toast(`${svc.name}: операция выполнена`, act.label, 'ok');
        } else {
          resBox.innerHTML = `<div class="banner banner-err" style="margin:0"><b>${esc(act.label)} не выполнена</b><pre class="svc-pre">${esc(out.error)}</pre></div>`;
        }
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
      } finally {
        btn.innerHTML = `${icon('play')}Повторить`;
        btn.style.pointerEvents = '';
      }
    });
  }

  function connectModal(svc, integration) {
    const isNew = !svc;
    const it = integration || (svc && store.integrations.find((x) => x.id === (svc.integrationId || svc.id)));
    const model = svc || {
      id: it ? it.id : '',
      name: it ? it.name : '',
      category: it ? it.category : 'Прочее',
      url: it ? it.baseUrl : '',
      icon: it ? it.icon : 'plug',
      integrationId: it ? it.id : null,
    };

    const m = openModal({
      kicker: isNew ? 'новый сервис' : 'подключение',
      title: isNew ? `Подключить ${model.name}` : `${model.name} — ключ доступа`,
      body: `
        ${isNew && !it ? `
          <div class="field"><label>название</label>
            <input class="input" id="mName" maxlength="40" placeholder="например: GitLab" required></div>` : ''}
        ${isNew ? `
          <div class="field-row">
            <div class="field"><label>категория</label>
              <input class="input" id="mCat" maxlength="40" value="${esc(model.category)}"></div>
          </div>` : ''}
        ${it ? (it.keyRequired === false ? `
          <div class="field"><label>${esc(it.keyLabel)}</label>
            <div class="banner" style="margin:0">${esc(it.keyHint)}</div>
          </div>` : `
          <div class="field"><label>${esc(it.keyLabel)}</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="mKey" type="password" autocomplete="off" placeholder="${svc && svc.hasKey ? 'оставьте пустым, чтобы не менять' : 'вставьте ключ'}">
              <button class="icon-btn" id="mEye" aria-label="Показать ключ" style="flex:none;width:44px;border:1px solid var(--line)">${icon('eye')}</button>
            </div>
            <span class="field-hint">${esc(it.keyHint)}${it.keyUrl ? ` · <a href="${esc(it.keyUrl)}" target="_blank" rel="noopener">где взять</a>` : ''}</span>
          </div>`) : `
          <div class="field"><label>api-ключ / токен</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="mKey" type="password" autocomplete="off" placeholder="вставьте ключ (мин. 6 символов)">
              <button class="icon-btn" id="mEye" aria-label="Показать ключ" style="flex:none;width:44px;border:1px solid var(--line)">${icon('eye')}</button>
            </div>
            <span class="field-hint">хранится зашифрованно в data/.secret</span>
          </div>`}
        <div class="field"><label>${esc((it && it.urlLabel) || 'базовый url')}</label>
          <input class="input" id="mUrl" maxlength="200" placeholder="${esc((it && it.id === 'obsidian') ? 'C:\\Users\\you\\Documents\\vault' : 'https://api.example.com')}" value="${esc(model.url)}"></div>
        ${it ? `<div id="mRes"></div>` : '<div id="mRes"></div>'}`,
      footer: `
        <button class="btn btn-ghost" data-cancel>Отмена</button>
        <button class="btn btn-primary" id="mSave">${icon('link')}Сохранить и проверить</button>`,
    });

    const keyInput = m.modal.querySelector('#mKey');
    const resBox = m.modal.querySelector('#mRes');
    m.modal.querySelector('#mEye')?.addEventListener('click', (e) => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
      e.currentTarget.setAttribute('aria-label', show ? 'Скрыть ключ' : 'Показать ключ');
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);

    m.modal.querySelector('#mSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#mSave');
      const nameEl = m.modal.querySelector('#mName');
      const name = nameEl ? (nameEl.value || '').trim() : model.name;
      const apiKey = ((keyInput && keyInput.value) || '').trim();
      const url = (m.modal.querySelector('#mUrl').value || '').trim();
      const catEl = m.modal.querySelector('#mCat');

      if (!name || name.length < 2) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">Укажите название сервиса (мин. 2 символа).</div>';
        return;
      }
      /* Сервисы без ключа (локальный Obsidian) сохраняются по пути */
      const needsKey = !(it && it.keyRequired === false);
      if (needsKey && !apiKey && !(svc && svc.hasKey)) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">Вставьте API-ключ сервиса.</div>';
        return;
      }
      if (apiKey && apiKey.length < 6) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">Ключ слишком короткий: минимум 6 символов.</div>';
        return;
      }
      btn.innerHTML = '<span class="spinner"></span>Сохраняем';
      btn.style.pointerEvents = 'none';
      try {
        let id = model.id;
        if (!id) {
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'svc';
          id = store.services.some((s) => s.id === base) ? `${base}_${Math.random().toString(36).slice(2, 6)}` : base;
        }
        const item = {
          id,
          name,
          icon: model.icon || 'plug',
          category: catEl ? (catEl.value || 'Прочее').trim() : model.category,
          url,
          integrationId: it ? it.id : null,
        };
        if (apiKey) item.apiKey = apiKey;
        await saveService(item);

        resBox.innerHTML = '<div class="banner banner-warn" style="margin:0"><span class="spinner"></span>Проверяем соединение настоящим запросом…</div>';
        const res = await checkService(item.id);
        if (res.ok) {
          toast(`${name}: подключено`, `${res.detail || 'ок'} · ${res.latencyMs} мс`, 'ok');
          m.close();
          return;
        }
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0"><b>Ключ сохранён, но проверка не пройдена</b><div>${esc(res.detail || res.message || 'сервис не ответил')}</div></div>`;
        btn.innerHTML = `${icon('refresh')}Проверить ещё раз`;
        btn.style.pointerEvents = '';
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('link')}Сохранить и проверить`;
        btn.style.pointerEvents = '';
      }
    });
  }

  /* ================================================== ПРОГРАММЫ */

  function permBtn(p, key, label) {
    return `<button class="perm-toggle" role="switch" aria-checked="${!!p.perms[key]}" data-perm="${key}"
      aria-label="Разрешение «${label}» для ${esc(p.name)}"><i class="switch" aria-hidden="true"></i><span>${label}</span></button>`;
  }

  function renderPrograms() {
    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">локальный узел</div><h2>Программы ПК</h2></div>
          <span class="sub">что агентам можно запускать, читать и перезаписывать.</span>
          <div class="spacer"></div>
          <button class="btn" id="scanBtn" ${scanning ? 'disabled' : ''}>${icon('scan')}Сканировать ПК</button>
          <button class="btn btn-primary" id="addPrgBtn">${icon('plus')}Добавить программу</button>
        </div>

        <div id="scanHost"></div>

        ${store.programs.length ? `
          <div class="prg-list">
            ${store.programs.map((p) => `
              <div class="prg-row" data-prg="${esc(p.id)}">
                <span class="prg-ico">${icon('appWindow')}</span>
                <div class="prg-info">
                  <b>${esc(p.name)}${p.source === 'scan' ? '' : ' <span class="chip" style="--chip-c:var(--amber);height:19px;font-size:9.5px"><i></i>вручную</span>'}${p.missing ? ' <span class="chip" style="--chip-c:var(--rose);height:19px;font-size:9.5px"><i></i>файл не найден</span>' : ''}</b>
                  <span title="${esc(p.path)}">${esc(p.path)}</span>
                </div>
                <div class="prg-perms">
                  ${permBtn(p, 'run', 'запуск')}
                  ${permBtn(p, 'read', 'чтение')}
                  ${permBtn(p, 'write', 'запись')}
                </div>
                <button class="icon-btn danger" data-del aria-label="Удалить ${esc(p.name)}">${icon('trash')}</button>
              </div>`).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">${icon('appWindow')}</div>
            <h3>Программы не найдены</h3>
            <p>Просканируйте ПК или добавьте исполняемый файл вручную.</p>
            <button class="btn btn-primary" id="scanBtn2">${icon('scan')}Сканировать ПК</button>
          </div>`}
      </div>`;

    page.querySelector('#scanBtn')?.addEventListener('click', scan);
    page.querySelector('#scanBtn2')?.addEventListener('click', scan);
    page.querySelector('#addPrgBtn').addEventListener('click', programModal);

    panel.querySelectorAll('[data-prg]').forEach((row) => {
      const p = store.programs.find((x) => x.id === row.dataset.prg);
      if (!p) return;
      row.querySelectorAll('[data-perm]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.perm;
          const next = { ...p.perms, [key]: !p.perms[key] };
          btn.setAttribute('aria-checked', String(next[key]));
          try {
            await saveProgram({ ...p, perms: next });
            toast('Разрешение обновлено', `${p.name}: ${key === 'run' ? 'запуск' : key === 'read' ? 'чтение' : 'запись'} ${next[key] ? 'включены' : 'выключены'}`, 'ok');
          } catch (e) {
            btn.setAttribute('aria-checked', String(p.perms[key]));
            toast('Ошибка', e.message, 'err');
          }
        });
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: 'удаление программы',
          title: `Убрать «${p.name}»?`,
          text: 'Программа исчезнет из списка доступных агентам.',
          okText: 'Удалить',
        });
        if (!ok) return;
        try { await removeProgram(p.id); toast('Программа удалена', p.name, 'ok'); }
        catch (e) { toast('Ошибка', e.message, 'err'); }
      });
    });
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    const btn = page.querySelector('#scanBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Сканируем'; }
    const host = panel.querySelector('#scanHost') || document.getElementById('scanHost');
    host.innerHTML = `
      <div class="panel scan-panel">
        <div class="scan-top">
          <b>Сканирование ПК…</b>
          <span class="mono" id="scanPct">ищем в известных путях и PATH</span>
        </div>
        <div class="progress"><i id="scanBar" style="width:60%"></i></div>
        <div class="scan-file mono" id="scanFile">реальное сканирование на сервере, ваши записи и разрешения сохраняются…</div>
      </div>`;
    try {
      /* Настоящий скан на сервере: известные пути + PATH, слияние по путям */
      const out = await api('/api/programs/scan', { method: 'POST', body: {} });
      await refreshPrograms();
      toast('Сканирование завершено', out.added ? `Новых программ: ${out.added} (всего ${out.total})` : `Нового нет, всего в списке: ${out.total}`, out.added ? 'ok' : 'warn');
    } catch (e) {
      toast('Скан не удался', e.message, 'err');
    } finally {
      scanning = false;
      renderPanel();
    }
  }

  function programModal() {
    const m = openModal({
      kicker: 'новая программа',
      title: 'Добавить программу',
      body: `
        <div class="field"><label>название</label>
          <input class="input" id="pName" maxlength="60" placeholder="например: Blender"></div>
        <div class="field"><label>путь к исполняемому файлу</label>
          <input class="input" id="pPath" maxlength="300" placeholder="C:\\Program Files\\...\\app.exe"></div>
        <div class="field"><span class="field-label">разрешения</span>
          <div class="prg-perms" style="flex-wrap:wrap">
            <button class="perm-toggle" role="switch" aria-checked="true" data-p="run"><i class="switch"></i><span>запуск</span></button>
            <button class="perm-toggle" role="switch" aria-checked="true" data-p="read"><i class="switch"></i><span>чтение</span></button>
            <button class="perm-toggle" role="switch" aria-checked="false" data-p="write"><i class="switch"></i><span>запись</span></button>
          </div>
        </div>
        <div id="pRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="pSave">${icon('plus')}Добавить</button>`,
    });
    const perms = { run: true, read: true, write: false };
    m.modal.querySelectorAll('[data-p]').forEach((b) => {
      b.addEventListener('click', () => {
        perms[b.dataset.p] = !perms[b.dataset.p];
        b.setAttribute('aria-checked', String(perms[b.dataset.p]));
      });
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelector('#pSave').addEventListener('click', async () => {
      const name = (m.modal.querySelector('#pName').value || '').trim();
      const path = (m.modal.querySelector('#pPath').value || '').trim();
      if (name.length < 2 || path.length < 3) {
        m.modal.querySelector('#pRes').innerHTML = '<div class="banner banner-err" style="margin:0">Заполните название и полный путь.</div>';
        return;
      }
      try {
        const list = await saveProgram({ name, path, perms, source: 'manual' });
        const saved = (list || []).find((x) => x.path === path) || {};
        if (saved.missing) {
          toast('Сохранено с предупреждением', 'Файл не найден — запись помечена, запуск будет заблокирован до исправления пути', 'warn');
        } else {
          toast('Программа добавлена', name, 'ok');
        }
        m.close();
      } catch (e) {
        m.modal.querySelector('#pRes').innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
      }
    });
  }

  /* ======================================================= MCP */

  function mcpStatusBadge(m) {
    const map = {
      connected: ['badge-ok', 'подключён'],
      off: ['badge-off', 'выключен'],
      connecting: ['badge-warn badge-live', 'подключение…'],
      error: ['badge-err', 'ошибка'],
    };
    const [cls, label] = map[m.status] || map.off;
    return `<span class="badge ${cls}"><i></i>${label}</span>`;
  }

  function mcpLogHTML(m) {
    const lines = (m.log || []).slice(-14);
    if (!lines.length) return '<div class="dim" style="font-size:12px;padding:2px 0">Лог пуст.</div>';
    return lines.map((l) => `
      <div class="log-line lv-${l.level === 'err' ? 'err' : l.level === 'warn' ? 'warn' : l.level === 'ok' ? 'ok' : 'info'}">
        <span class="lt">${fmtTime(l.t)}</span>
        <span class="lp">${{ info: '→', ok: '✔', warn: '!', err: '✗' }[l.level] || '·'}</span>
        <span class="ltx">${esc(l.line)}</span>
      </div>`).join('');
  }

  function renderMcp() {
    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">протокол mcp</div><h2>MCP-серверы</h2></div>
          <span class="sub">tools, которые агенты дёргают по stdio / SSE / HTTP.</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="addMcpBtn">${icon('plus')}Добавить сервер</button>
        </div>

        ${store.mcp.length ? `
          <div class="mcp-list">
            ${store.mcp.map((m) => `
              <article class="panel mcp-card" data-mcp="${esc(m.id)}">
                <div class="mcp-main">
                  <div class="mcp-id">
                    <span class="mcp-ico ${m.status === 'connecting' ? 'spinning' : ''}">${icon('layers')}</span>
                    <div>
                      <b>${esc(m.name)}</b>
                      <div class="mcp-meta">
                        <span class="transport" data-t="${esc(m.transport)}">${esc(m.transport)}</span>
                        ${mcpStatusBadge(m)}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div class="mcp-target" title="${esc(m.target)}">${esc(m.target)}</div>
                    <div class="mcp-tools">
                      ${(m.tools || []).slice(0, 4).map((t) => `<span class="chip" style="--chip-c:var(--violet)"><i></i>${esc(t)}</span>`).join('')}
                      ${(m.tools || []).length > 4 ? `<span class="chip">+${m.tools.length - 4}</span>` : ''}
                    </div>
                  </div>
                  <div class="mcp-actions">
                    <button class="switch switch-cyan" role="switch" aria-checked="${m.status === 'connected'}"
                      data-toggle aria-label="${m.status === 'connected' ? 'Выключить' : 'Включить'} сервер ${esc(m.name)}"></button>
                    <button class="icon-btn" data-recon aria-label="Переподключить ${esc(m.name)}">${icon('refresh')}</button>
                    <button class="icon-btn" data-edit aria-label="Редактировать ${esc(m.name)}">${icon('pencil')}</button>
                    <button class="icon-btn danger" data-del aria-label="Удалить ${esc(m.name)}">${icon('trash')}</button>
                  </div>
                </div>
                <details class="mcp-log">
                  <summary>лог подключения · ${(m.log || []).length}</summary>
                  <pre>${mcpLogHTML(m)}</pre>
                </details>
              </article>`).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">${icon('layers')}</div>
            <h3>MCP-серверы не подключены</h3>
            <p>Добавьте сервер с tools — агенты получат доступ к репозиториям, базам и браузеру.</p>
            <button class="btn btn-primary" id="addMcpBtn2">${icon('plus')}Добавить сервер</button>
          </div>`}
      </div>`;

    page.querySelector('#addMcpBtn')?.addEventListener('click', () => mcpModal(null));
    page.querySelector('#addMcpBtn2')?.addEventListener('click', () => mcpModal(null));

    panel.querySelectorAll('[data-mcp]').forEach((card) => {
      const m = store.mcp.find((x) => x.id === card.dataset.mcp);
      if (!m) return;

      card.querySelector('[data-toggle]').addEventListener('click', async (e) => {
        const sw = e.currentTarget;
        if (m.status === 'connected' || m.status === 'connecting') {
          sw.setAttribute('aria-checked', 'false');
          try { await saveMcp({ ...m, status: 'off' }); toast('Сервер выключен', m.name, 'ok'); }
          catch (err) { toast('Ошибка', err.message, 'err'); }
        } else {
          sw.setAttribute('aria-checked', 'true');
          await doReconnect(m);
        }
      });

      card.querySelector('[data-recon]').addEventListener('click', () => doReconnect(m));

      card.querySelector('[data-edit]').addEventListener('click', () => mcpModal(m));

      card.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: 'удаление mcp',
          title: `Удалить «${m.name}»?`,
          text: 'Сервер и его лог подключения будут удалены.',
          okText: 'Удалить',
        });
        if (!ok) return;
        try { await removeMcp(m.id); toast('MCP удалён', m.name, 'ok'); }
        catch (e) { toast('Ошибка', e.message, 'err'); }
      });
    });
  }

  async function doReconnect(m) {
    const card = panel.querySelector(`[data-mcp="${m.id}"]`);
    const ico = card ? card.querySelector('.mcp-ico') : null;
    const badge = card ? card.querySelector('.badge') : null;
    if (ico) ico.classList.add('spinning');
    if (badge) { badge.className = 'badge badge-warn badge-live'; badge.innerHTML = '<i></i>подключение…'; }
    try {
      const updated = await reconnectMcp(m.id);
      if (updated.status === 'connected') toast('Переподключено', `${m.name} · tools доступны`, 'ok');
      else toast('Сбой подключения', `${m.name}: смотрите лог`, 'err');
    } catch (e) {
      toast('Ошибка переподключения', e.message, 'err');
    } finally {
      renderPanel();
    }
  }

  function mcpModal(m) {
    const isNew = !m;
    const model = m || { name: '', transport: 'stdio', target: '' };
    const envText = Object.entries(model.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const headersText = Object.entries(model.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    const mdl = openModal({
      kicker: isNew ? 'новая связка' : 'изменение',
      title: isNew ? 'Подключение MCP-сервера' : `MCP: ${model.name}`,
      body: `
        <div class="field-row">
          <div class="field" style="flex:1 1 180px"><label>Имя</label>
            <input class="input" id="cName" maxlength="60" placeholder="mcp-github" value="${esc(model.name)}"></div>
          <div class="field" style="flex:0 1 190px"><label>Транспорт</label>
            <select class="select" id="cTransport">
              ${['stdio', 'sse', 'http'].map((t) => `<option value="${t}" ${t === model.transport ? 'selected' : ''}>${t === 'stdio' ? 'stdio — локальная команда' : `${t} — удалённый URL`}</option>`).join('')}
            </select></div>
        </div>
        <div class="field"><label id="cTargetLabel">Команда запуска</label>
          <input class="input" id="cTarget" maxlength="300" value="${esc(model.target)}"></div>
        <span class="field-hint" id="cHint"></span>

        <div class="field" id="cEnvWrap"><label>Переменные окружения</label>
          <textarea class="input mono" id="cEnv" rows="3" maxlength="2000">${esc(envText)}</textarea>
          <span class="field-hint">По одной на строку, вида <code>ИМЯ=значение</code>. Нужно MCP-серверам, читающим токены из переменных (например GITHUB_PERSONAL_ACCESS_TOKEN).</span></div>

        <div class="field" id="cHeadWrap" style="display:none"><label>Заголовки запроса</label>
          <textarea class="input mono" id="cHead" rows="2" maxlength="2000">${esc(headersText)}</textarea>
          <span class="field-hint">По одному на строку, вида <code>Заголовок: значение</code>. Для удалённых серверов с авторизацией.</span></div>

        <div id="cRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-ghost" id="cTest">${icon('refresh')}Проверить</button>
               <button class="btn btn-primary" id="cSave">${icon('check')}${isNew ? 'Сохранить и подключить' : 'Сохранить'}</button>`,
    });

    const selT = mdl.modal.querySelector('#cTransport');
    const hint = mdl.modal.querySelector('#cHint');
    const tLabel = mdl.modal.querySelector('#cTargetLabel');
    const tInput = mdl.modal.querySelector('#cTarget');
    const isRemote = () => selT.value === 'http' || selT.value === 'sse';

    const syncTransport = () => {
      const remote = isRemote();
      mdl.modal.querySelector('#cEnvWrap').style.display = remote ? 'none' : '';
      mdl.modal.querySelector('#cHeadWrap').style.display = remote ? '' : 'none';
      tLabel.textContent = remote ? 'URL сервера' : 'Команда запуска';
      tInput.placeholder = remote
        ? 'https://example.com/mcp'
        : 'npx -y @modelcontextprotocol/server-filesystem D:\\projects';
      hint.textContent = remote
        ? 'Поддерживаются потоковый HTTP (JSON-RPC поверх POST) и SSE.'
        : 'Команда выполняется на сервере NEXUS. Каталог передайте аргументом, если сервер его требует.';
    };
    selT.addEventListener('change', syncTransport);
    syncTransport();

    mdl.modal.querySelector('[data-cancel]').addEventListener('click', mdl.close);

    /* Строки вида "KEY=value" или "Key: value" в объект; мусор пропускаем */
    const parsePairs = (txt, sep) => {
      const out = {};
      for (const line of String(txt || '').split(/\r?\n/)) {
        const k = line.indexOf(sep);
        if (k > 0) out[line.slice(0, k).trim()] = line.slice(k + 1).trim();
      }
      return out;
    };

    const collect = () => {
      const transport = selT.value;
      const remote = transport === 'http' || transport === 'sse';
      return {
        name: (mdl.modal.querySelector('#cName').value || '').trim(),
        transport,
        target: (tInput.value || '').trim(),
        env: remote ? undefined : parsePairs(mdl.modal.querySelector('#cEnv').value, '='),
        headers: remote ? parsePairs(mdl.modal.querySelector('#cHead').value, ':') : undefined,
      };
    };

    const setRes = (html) => { mdl.modal.querySelector('#cRes').innerHTML = html; };

    const validate = (c) => {
      if (c.name.length < 2) return 'Задайте имя сервера.';
      const remote = c.transport === 'http' || c.transport === 'sse';
      if (remote && !/^https?:\/\//i.test(c.target)) return 'URL должен начинаться с http:// или https://';
      if (!remote && c.target.length < 2) {
        return 'Укажите команду запуска, например: npx -y @modelcontextprotocol/server-filesystem D:\\projects';
      }
      return '';
    };

    /* Проверка до сохранения: настоящий handshake, показываем найденные инструменты */
    mdl.modal.querySelector('#cTest').addEventListener('click', async () => {
      const b = mdl.modal.querySelector('#cTest');
      const c = collect();
      const err = validate(c);
      if (err) { setRes(`<div class="banner banner-err" style="margin:0">${esc(err)}</div>`); return; }
      b.innerHTML = '<span class="spinner"></span>Подключаем…';
      b.style.pointerEvents = 'none';
      setRes('<div class="banner banner-warn" style="margin:0"><span class="spinner"></span>Handshake MCP…</div>');
      try {
        const probe = await testMcp(c);
        if (probe.ok) {
          setRes(`<div class="banner banner-ok" style="margin:0">
            <b>${esc(probe.serverName || 'Сервер')}</b> отвечает · инструментов: ${probe.tools.length}
            ${probe.tools.length ? `<div class="dim" style="font-size:11.5px;margin-top:6px;overflow-wrap:anywhere">${esc(probe.tools.slice(0, 40).join(', '))}${probe.tools.length > 40 ? '…' : ''}</div>` : ''}
          </div>`);
        } else {
          setRes(`<div class="banner banner-err" style="margin:0">Не подключился: ${esc(probe.error || 'неизвестная ошибка')}</div>`);
        }
      } catch (e) {
        setRes(`<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`);
      }
      b.innerHTML = `${icon('refresh')}Проверить`;
      b.style.pointerEvents = '';
    });

    mdl.modal.querySelector('#cSave').addEventListener('click', async () => {
      const c = collect();
      const err = validate(c);
      if (err) { setRes(`<div class="banner banner-err" style="margin:0">${esc(err)}</div>`); return; }
      const btn = mdl.modal.querySelector('#cSave');
      btn.innerHTML = '<span class="spinner"></span>Сохраняем';
      btn.style.pointerEvents = 'none';
      try {
        let id = model.id;
        if (!id) {
          const base = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp_srv';
          id = store.mcp.some((x) => x.id === base) ? `${base}_${Math.random().toString(36).slice(2, 6)}` : base;
        }
        const body = Object.assign({ id, status: isNew ? 'connecting' : model.status, log: model.log || [] }, c);
        if (c.env === undefined) delete body.env;
        if (c.headers === undefined) delete body.headers;
        const saved = await saveMcp(body);
        const item = saved.find((x) => x.id === id) || saved[saved.length - 1];
        mdl.close();
        await doReconnect(item);
      } catch (e) {
        setRes(`<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`);
        btn.innerHTML = `${icon('check')}Сохранить`;
        btn.style.pointerEvents = '';
      }
    });
  }

/* ======================================================== ДОСТУП */

  function accessState() {
    const a = store.access || {};
    return { a, pinEnabled: !!a.pinEnabled, pinIsDefault: !!a.pinIsDefault, isLocal: a.isLocal !== false, mode: (a.access && a.access.mode) || 'readonly' };
  }

  async function ensureNet() {
    if (store.net) return store.net;
    try { return await refreshNet(); } catch { return null; }
  }

  function renderAccess() {
    const { a, pinEnabled, pinIsDefault, isLocal, mode } = accessState();
    const lan = (store.net && store.net.lan) || [];
    const invites = a.invites || [];

    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">локальный узел</div><h2>Доступ и безопасность</h2></div>
          <span class="sub">PIN для входа с телефона, режим работы агентов и подключение по сети.</span>
        </div>

        <div class="acc-grid">
          <section class="panel acc-card">
            <div class="acc-head">${icon('sliders')}<b>Режим работы</b>
              <span class="badge ${mode === 'full' ? 'badge-warn' : 'badge-ok'}"><i></i>${mode === 'full' ? 'полный' : 'только чтение'}</span>
            </div>
            <p class="acc-desc">${mode === 'full'
              ? 'Агенты могут создавать и изменять файлы в рабочей папке.'
              : 'Агенты только читают. Запись и запуск программ заблокированы.'}</p>
            <div class="acc-row">
              <button class="btn ${mode === 'readonly' ? 'btn-primary' : 'btn-ghost'}" data-mode="readonly">${icon('eye')}Только чтение</button>
              <button class="btn ${mode === 'full' ? 'btn-primary' : 'btn-ghost'}" data-mode="full">${icon('pen')}Полный доступ</button>
            </div>
          </section>

          <section class="panel acc-card">
            <div class="acc-head">${icon('checkSquare')}<b>PIN-код</b>
              ${pinEnabled ? '<span class="badge badge-ok"><i></i>защита включена</span>' : '<span class="badge badge-err"><i></i>не задан</span>'}
            </div>
            ${pinIsDefault ? '<div class="banner banner-warn" style="margin:0 0 12px">Стоит PIN по умолчанию <b class="mono">1111</b> — его знает каждый. Смените код кнопкой ниже.</div>' : ''}
            <p class="acc-desc">${pinEnabled
              ? `Вход с других устройств требует PIN (${a.pinLength || 6} цифр).`
              : 'Без PIN любой вход из сети блокируется — задайте код, чтобы открыть доступ телефону.'}</p>
            <div class="acc-row">
              <button class="btn btn-primary" data-pin>${icon('pencil')}${pinEnabled ? 'Сменить PIN' : 'Задать PIN'}</button>
              ${pinEnabled ? '<button class="btn btn-ghost" data-unpin>Отключить</button>' : ''}
            </div>
          </section>
        </div>

        <section class="panel acc-card" id="tgCard">
          <div class="acc-head">${icon('send')}<b>Telegram-пульт</b>
            <span class="acc-note">задачи команде из мессенджера</span>
          </div>
          <div id="tgBody"><div class="dim" style="font-size:12.5px"><span class="spinner"></span>Загружаем настройки моста…</div></div>
        </section>

        <section class="panel acc-card">
          <div class="acc-head">${icon('server')}<b>Подключение по сети</b>
            <span class="acc-note">${isLocal ? 'вы на этом компьютере' : 'вы вошли удалённо'}</span>
          </div>
          ${lan.length ? `
            <div class="qr-grid">
              ${lan.map((n) => {
                const url = n.url || `http://${n.address}:${(store.net && store.net.port) || ''}`;
                const qr = qrSvg(url, { size: 168 });
                return `
                  <div class="qr-item">
                    <div class="qr-box">${qr || '<div class="qr-none">QR недоступен</div>'}</div>
                    <div class="qr-cap">
                      <b>${esc(n.iface || 'сеть')}</b>
                      <span class="mono" title="${esc(url)}">${esc(n.address)}</span>
                      <button class="btn btn-mini btn-ghost" data-copy="${esc(url)}">${icon('link')}Скопировать</button>
                    </div>
                  </div>`;
              }).join('')}
            </div>
            <p class="acc-hint">Откройте камеру телефона на QR-коде, введите PIN — и NEXUS откроется в браузере.</p>
          ` : `<div class="acc-hint">Сеть не найдена. Подключите компьютер к Wi-Fi или Ethernet.</div>`}
        </section>

        <section class="panel acc-card">
          <div class="acc-head">${icon('users')}<b>Приглашения</b>
            <span class="acc-note">одноразовые коды для гостей</span>
            <div class="spacer"></div>
            <button class="btn btn-mini" data-invite>${icon('plus')}Создать код</button>
            ${invites.length ? '<button class="btn btn-mini btn-ghost" data-revoke>Отозвать все</button>' : ''}
          </div>
          ${invites.length ? `
            <div class="inv-list">
              ${invites.map((i) => `
                <div class="inv-row">
                  <span class="mono inv-code">${esc(i.code)}</span>
                  <span class="dim">${i.used ? 'использован' : `до ${fmtDateTime(i.expires)}`}</span>
                </div>`).join('')}
            </div>` : '<div class="acc-hint">Активных кодов нет.</div>'}
        </section>
      </div>`;

    panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode, isLocal)));

    panel.querySelector('[data-pin]')?.addEventListener('click', pinModal);
    panel.querySelector('[data-unpin]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        kicker: 'отключение защиты',
        title: 'Отключить PIN?',
        text: 'Доступ из сети останется заблокирован, пока PIN не задан заново.',
        okText: 'Отключить',
      });
      if (!ok) return;
      try { await clearPin(); toast('PIN отключён', 'Вход из сети заблокирован', 'warn'); }
      catch (e) { toast('Ошибка', e.message, 'err'); }
    });

    panel.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        const okCopy = await copyText(b.dataset.copy);
        toast(okCopy ? 'Адрес скопирован' : 'Не удалось скопировать', b.dataset.copy, okCopy ? 'ok' : 'err');
      }));

    panel.querySelector('[data-invite]')?.addEventListener('click', async () => {
      try {
        const out = await createInvite(30);
        toast('Код создан', `${out.invite.code} · действует 30 минут`, 'ok');
      } catch (e) { toast('Ошибка', e.message, 'err'); }
    });
    panel.querySelector('[data-revoke]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        kicker: 'отзыв кодов',
        title: 'Отозвать все приглашения?',
        text: 'Все активные коды перестанут работать.',
        okText: 'Отозвать',
      });
      if (!ok) return;
      try { await revokeInvites(); toast('Коды отозваны', null, 'ok'); }
      catch (e) { toast('Ошибка', e.message, 'err'); }
    });

    void ensureNet();
    void refreshTgCard();
  }

  /* ------------------------------------------------- Telegram-пульт */

  /**
   * Карточка моста Telegram → команда. Токен вводит пользователь в разделе
   * «Сервисы» (Telegram), здесь — только включение, выбор чатов и исполнителя.
   */
  async function refreshTgCard() {
    const box = panel.querySelector('#tgBody');
    if (!box) return;
    /* Сохраняем черновик пользователя: статус обновляем, ввод не трогаем */
    const draft = {
      svc: box.querySelector('#tgSvc')?.value,
      target: box.querySelector('#tgTarget')?.value,
      chats: box.querySelector('#tgChats')?.value,
    };
    let data;
    try {
      data = await getTgBridge();
    } catch (e) {
      box.innerHTML = `<div class="banner banner-err" style="margin:0">Не удалось загрузить: ${esc(e.message)}</div>`;
      return;
    }
    const svcs = data.services || [];
    const agents = (data.agents || []).filter((a) => a.status !== 'offline');
    const poll = data.lastPoll;
    const pollLine = !data.enabled
      ? '<span class="field-hint">Мост выключен — бот молчит. Включи кнопкой справа.</span>'
      : !poll
        ? '<span class="field-hint">Опрос вот-вот начнётся (каждые 5 секунд)…</span>'
        : poll.ok
          ? `<span class="field-hint">Последний опрос: ${esc(fmtTime(poll.at))} — связь есть.</span>`
          : `<div class="banner banner-err" style="margin:0 0 12px">Последний опрос ${esc(fmtTime(poll.at))}: ${esc(poll.error || 'ошибка')}</div>`;
    box.innerHTML = `
      <p class="acc-desc">Бот превращает сообщения из разрешённых чатов в задачи. Чужие чаты игнорируются. Токен задаётся в <a href="#/connect">Подключения → Сервисы → Telegram</a>.</p>
      ${pollLine}
      <div class="acc-row" style="margin-bottom:12px">
        <span class="badge ${data.enabled ? 'badge-ok' : 'badge-off'}"><i></i>${data.enabled ? 'мост включён' : 'мост выключен'}</span>
        <div class="spacer"></div>
        <button class="btn btn-mini btn-ghost" data-tg-refresh>${icon('refresh')}Статус</button>
        <button class="btn ${data.enabled ? 'btn-ghost' : 'btn-primary'}" data-tg-toggle>${icon('power')}${data.enabled ? 'Выключить' : 'Включить'}</button>
      </div>
      <div class="field"><label>Telegram-сервис (токен бота)</label>
        <select class="select" id="tgSvc">
          ${svcs.length ? svcs.map((s) => `
            <option value="${esc(s.id)}" ${s.id === data.serviceId ? 'selected' : ''}>${esc(s.name)}${s.status === 'connected' ? '' : ' (не проверен)'}${s.hasKey ? '' : ' (без ключа)'}</option>`).join('')
            : '<option value="">— сначала подключите Telegram в Сервисах —</option>'}
        </select></div>
      <div class="field"><label>Исполнитель</label>
        <select class="select" id="tgTarget">
          <option value="">Вся команда (совещание → общий итог)</option>
          ${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === data.targetAgentId ? 'selected' : ''}>${esc(a.avatar || '')} ${esc(a.name)} · ${esc(a.role)}</option>`).join('')}
        </select>
        <span class="field-hint">Без исполнителя агенты обсуждают задачу цепочкой, в чат падает только итог. Лично — через @Имя прямо в Telegram (например: @Архимед проверь код).</span></div>
      <div class="field"><label>Разрешённые chat ID (через запятую)</label>
        <input class="input mono" id="tgChats" placeholder="например: 123456789, 987654321" value="${esc((data.chatIds || []).join(', '))}">
        <span class="field-hint">Только эти чаты могут давать задачи. Свой ID узнайте кнопкой ниже: напишите боту любое сообщение и нажмите «Показать чаты».</span></div>
      <div class="acc-row">
        <button class="btn btn-primary" data-tg-save>${icon('check')}Сохранить</button>
        <button class="btn btn-ghost" data-tg-recent>Показать чаты</button>
        <button class="btn btn-ghost" data-tg-test>Проверка связи</button>
      </div>
      <div id="tgRecent" style="margin-top:10px"></div>`;

    const read = () => ({
      serviceId: box.querySelector('#tgSvc').value || null,
      targetAgentId: box.querySelector('#tgTarget').value || null,
      chatIds: (box.querySelector('#tgChats').value || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
    });

    /* Возвращаем черновик, если пользователь уже что-то вводил */
    if (draft.svc && box.querySelector(`#tgSvc option[value="${draft.svc}"]`)) box.querySelector('#tgSvc').value = draft.svc;
    if (draft.target !== undefined && box.querySelector(`#tgTarget option[value="${draft.target || ''}"]`)) {
      box.querySelector('#tgTarget').value = draft.target || '';
    }
    if (draft.chats !== undefined && !(data.chatIds || []).length) box.querySelector('#tgChats').value = draft.chats;

    box.querySelector('[data-tg-save]').addEventListener('click', async () => {
      try {
        const out = await saveTgBridge({ ...read(), enabled: data.enabled });
        toast('Мост сохранён', out.enabled ? 'Telegram-пульт включён' : 'Настройки сохранены', 'ok');
        await refreshTgCard();
      } catch (e) { toast('Не сохранено', e.message, 'err'); }
    });
    box.querySelector('[data-tg-refresh]').addEventListener('click', async () => {
      /* Только статус опроса, без перерисовки — введённые данные не теряются */
      const btn = box.querySelector('[data-tg-refresh]');
      btn.style.pointerEvents = 'none';
      try {
        await refreshTgCard();
      } finally {
        btn.style.pointerEvents = '';
      }
    });
    box.querySelector('[data-tg-toggle]').addEventListener('click', async () => {
      try {
        const out = await saveTgBridge({ ...read(), enabled: !data.enabled });
        toast(!data.enabled ? 'Мост включён' : 'Мост выключен',
          !data.enabled ? 'Бот слушает разрешённые чаты' : 'Входящие больше не обрабатываются', !data.enabled ? 'ok' : 'warn');
        await refreshTgCard();
      } catch (e) { toast('Не переключено', e.message, 'err'); }
    });
    box.querySelector('[data-tg-recent]').addEventListener('click', async () => {
      const recent = box.querySelector('#tgRecent');
      recent.innerHTML = '<div class="dim" style="font-size:12.5px"><span class="spinner"></span>Читаем входящие бота…</div>';
      try {
        const out = await recentTgChats();
        const chats = out.chats || [];
        recent.innerHTML = chats.length ? `
          <div class="perm-list">
            ${chats.map((c) => `<button class="toggle-chip" role="switch" aria-checked="${c.allowed}" data-chat="${esc(c.id)}" style="--t-c:var(--cyan)">${esc(c.name)} · <span class="mono">${esc(c.id)}</span></button>`).join('')}
          </div>
          <span class="field-hint">Нажмите на чат, чтобы добавить/убрать его из разрешённых.</span>`
          : '<div class="dim" style="font-size:12.5px">Боту ещё никто не писал. Напишите ему сообщение и повторите.</div>';
        recent.querySelectorAll('[data-chat]').forEach((chip) => {
          chip.addEventListener('click', () => {
            const field = box.querySelector('#tgChats');
            const cur = (field.value || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
            const id = chip.dataset.chat;
            field.value = cur.includes(id) ? cur.filter((x) => x !== id).join(', ') : [...cur, id].join(', ');
            chip.setAttribute('aria-checked', String(!cur.includes(id)));
          });
        });
      } catch (e) {
        recent.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
      }
    });
    box.querySelector('[data-tg-test]').addEventListener('click', async () => {
      const first = ((box.querySelector('#tgChats').value || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))[0];
      if (!first) { toast('Некому слать', 'Укажите chat ID и сохраните', 'warn'); return; }
      try {
        await testTgBridge(first);
        toast('Сообщение ушло', `Проверьте Telegram в чате ${first}`, 'ok');
      } catch (e) { toast('Не отправлено', e.message, 'err'); }
    });
  }

  async function switchMode(next, isLocal) {
    const cur = accessState().mode;
    if (cur === next) return;
    if (next === 'full') {
      const ok = await confirmDialog({
        kicker: 'полный доступ',
        title: 'Разрешить запись и запуск?',
        text: 'Агенты смогут изменять файлы в рабочей папке и запускать разрешённые программы. Действие обратимо.',
        okText: 'Включить',
      });
      if (!ok) return;
    }
    try {
      await saveAccess({ mode: next });
      toast(next === 'full' ? 'Полный доступ включён' : 'Режим только чтения', next === 'full' ? 'Агенты могут изменять файлы' : 'Запись заблокирована', next === 'full' ? 'warn' : 'ok');
    } catch (e) {
      toast('Ошибка', e.message, 'err');
    }
    void isLocal;
  }

  function pinModal() {
    const m = openModal({
      kicker: 'защита входа',
      title: 'Установить PIN-код',
      body: `
        <p class="field-hint" style="margin:0 0 14px">От 4 до 12 цифр. Ввод с клавиатуры телефона.</p>
        <div class="field"><label>новый PIN</label>
          <input class="input pin-input" id="pin1" inputmode="numeric" maxlength="12" placeholder="••••••" autocomplete="off"></div>
        <div class="field"><label>повторите PIN</label>
          <input class="input pin-input" id="pin2" inputmode="numeric" maxlength="12" placeholder="••••••" autocomplete="off"></div>
        <div id="pinRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="pinSave">${icon('check')}Сохранить PIN</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelectorAll('.pin-input').forEach((i) =>
      i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); }));
    m.modal.querySelector('#pinSave').addEventListener('click', async () => {
      const a = m.modal.querySelector('#pin1').value;
      const b = m.modal.querySelector('#pin2').value;
      const resBox = m.modal.querySelector('#pinRes');
      if (!/^\d{4,12}$/.test(a)) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">PIN — от 4 до 12 цифр.</div>';
        return;
      }
      if (a !== b) {
        resBox.innerHTML = '<div class="banner banner-err" style="margin:0">Коды не совпадают.</div>';
        return;
      }
      try {
        await setPin(a);
        await refreshAccess();
        toast('PIN установлен', 'Вход с телефона защищён', 'ok');
        m.close();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
      }
    });
  }

  /* ---------------------------------------------------- рендер панели */

  function renderPanel() {
    counts();
    if (active === 'llm') renderLlm();
    else if (active === 'services') renderServices();
    else if (active === 'programs') renderPrograms();
    else if (active === 'mcp') renderMcp();
    else renderAccess();
    moveIndicator();
  }

  function onKind(kind) {
    if (!page.isConnected) return;
    if (active === kind) renderPanel();
    else counts();
  }
  const onServices = () => onKind('services');
  const onPrograms = () => onKind('programs');
  const onMcp = () => onKind('mcp');
  const onProviders = () => onKind('llm');
  const onAccess = () => onKind('access');
  const onNet = () => onKind('access');
  bus.addEventListener('services', onServices);
  bus.addEventListener('programs', onPrograms);
  bus.addEventListener('mcp', onMcp);
  bus.addEventListener('providers', onProviders);
  bus.addEventListener('access', onAccess);
  bus.addEventListener('net', onNet);

  const onResize = () => moveIndicator();
  window.addEventListener('resize', onResize);

  refreshAccess().catch(() => {});
  ensureNet();

  renderPanel();
  requestAnimationFrame(moveIndicator);

  return () => {
    bus.removeEventListener('services', onServices);
    bus.removeEventListener('programs', onPrograms);
    bus.removeEventListener('mcp', onMcp);
    bus.removeEventListener('providers', onProviders);
    bus.removeEventListener('access', onAccess);
    bus.removeEventListener('net', onNet);
    window.removeEventListener('resize', onResize);
    void reducedMotion;
    void fmtDateTime;
  };
}
