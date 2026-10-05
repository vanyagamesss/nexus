/* NEXUS — вид «Настройки»: сервисы, программы ПК, MCP-серверы */

import { t } from './i18n.js';
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
  { key: 'llm', labelKey: 'tab_llm', icon: 'openai' },
  { key: 'services', labelKey: 'tab_services', icon: 'link' },
  { key: 'programs', labelKey: 'tab_programs', icon: 'appWindow' },
  { key: 'mcp', labelKey: 'tab_mcp', icon: 'layers' },
  { key: 'access', labelKey: 'tab_access', icon: 'sliders' },
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
        <div class="kicker">${esc(t('settings.head_kicker'))} <span class="k-dim">/ ${esc(t('settings.head_node'))}</span></div>
        <h2>${esc(t('settings.head_title'))}</h2>
      </div>
      <span class="sec-note">${esc(t('settings.head_note'))}</span>
    </div>

    <div class="tabs" role="tablist" aria-label="${esc(t('settings.tabs_aria'))}">
      <span class="tab-ind" id="tabInd" aria-hidden="true"></span>
      ${TABS.map((t_, i) => `
        <button class="tab" role="tab" data-tab="${t_.key}" id="tab-${t_.key}" aria-selected="${i === 0}" aria-controls="tabPanel">
          ${icon(t_.icon)}${esc(t(`settings.${t_.labelKey}`))}<span class="tab-n" data-count="${t_.key}">0</span>
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
    if (!p.enabled) return `<span class="badge badge-off"><i></i>${esc(t('settings.llm_badge_off'))}</span>`;
    if (p.lastCheck === null || p.lastCheck === undefined) return `<span class="badge"><i></i>${esc(t('settings.llm_badge_unchecked'))}</span>`;
    if (p.lastCheckOk) return `<span class="badge badge-ok"><i></i>${esc(t('settings.llm_badge_ready', { ms: p.latencyMs || 0 }))}</span>`;
    return `<span class="badge badge-err"><i></i>${esc(t('settings.llm_badge_err'))}</span>`;
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
            ${p.isDefault ? `<span class="chip chip-def"><i></i>${esc(t('settings.llm_default_chip'))}</span>` : ''}
            ${provBadge(p)}
          </div>
        </div>

        <div class="llm-key">
          <span class="${p.hasKey ? 'k-ok' : 'k-no'}">${p.hasKey ? `${icon('check')} ${esc(t('settings.llm_key_ok', { hint: p.keyHint || '' }))}` : esc(t('settings.llm_key_missing'))}</span>
          ${p.lastCheck && p.lastCheckOk === false && p.lastCheckDetail
            ? `<span class="llm-err" title="${esc(p.lastCheckDetail)}">${esc(String(p.lastCheckDetail).slice(0, 80))}</span>` : ''}
        </div>

        <div class="llm-models">
          ${models.length
            ? models.slice(0, 6).map((m) => `<span class="chip" style="--chip-c:var(--cyan)"><i></i>${esc(typeof m === 'string' ? m : m.id)}</span>`).join('')
              + (models.length > 6 ? `<span class="chip">+${models.length - 6}</span>` : '')
            : `<span class="dim" style="font-size:11.5px">${esc(t('settings.llm_models_empty'))}</span>`}
        </div>

        <div class="llm-foot">
          <button class="btn btn-mini ${p.lastCheckOk ? '' : 'btn-run'}" data-probe>${icon('refresh')}${esc(t('settings.llm_btn_check'))}</button>
          <button class="btn btn-mini btn-ghost" data-models>${icon('layers')}${esc(t('settings.llm_btn_models'))}${models.length ? ` · ${models.length}` : ''}</button>
          ${!p.isDefault ? `<button class="btn btn-mini btn-ghost" data-def>${icon('check')}${esc(t('settings.llm_btn_default'))}</button>` : ''}
          <button class="btn btn-mini btn-ghost" data-key>${icon('pencil')}${esc(t('settings.llm_btn_key'))}</button>
          <button class="icon-btn danger" data-del aria-label="${esc(t('settings.llm_del_aria', { name }))}">${icon('trash')}</button>
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
          <div><div class="kicker">${esc(t('settings.llm_kicker'))}</div><h2>${esc(t('settings.llm_title'))}</h2></div>
          <span class="sub">${esc(t('settings.llm_sub'))}</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" data-add-prv>${icon('plus')}${esc(t('settings.llm_add'))}</button>
        </div>

        ${store.providers.length ? `<div class="llm-grid">${store.providers.map(provCard).join('')}</div>` : ''}

        ${free.length ? `
          <div class="llm-catalog">
            <div class="kicker" style="margin-bottom:10px">${esc(t('settings.llm_catalog_kicker', { n: cat.length }))}</div>
            <div class="llm-catalog-grid">
              ${free.map((c) => `
                <button class="llm-cat" data-quick="${esc(c.id)}" title="${esc(c.keyUrl || c.docs || '')}">
                  ${icon(c.family === 'anthropic' ? 'bot' : c.family === 'ollama' ? 'ollama' : 'cloud')}
                  <b>${esc(c.name)}</b>
                  <span>${c.keyRequired ? esc(t('settings.llm_need_key')) : esc(t('settings.llm_no_key'))}${c.dynamicModels ? esc(t('settings.llm_live_list')) : ''}</span>
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
        btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.llm_checking'))}`;
        btn.style.pointerEvents = 'none';
        try {
          const res = await probeProvider(p.id);
          const found = res.models || [];
          if (!res.ok) {
            toast(t('settings.llm_probe_denied', { name: p.providerName }), res.detail || res.message || t('settings.llm_no_link'), 'err');
          } else if (found.length) {
            /* Ключ рабочий - сразу предлагаем выбрать нужные модели */
            await openModelPicker(p, found, new Map((res.meta || []).map((x) => [x.id, x])));
          } else {
            toast(t('settings.llm_probe_done', { name: p.providerName }), t('settings.llm_probe_nomodels'), 'ok');
          }
        } catch (e) {
          toast(t('settings.llm_probe_err'), e.message, 'err');
        } finally {
          renderLlm();
        }
      });

      /* Выбор моделей по уже загруженному списку, без повторной проверки */
      card.querySelector('[data-models]').addEventListener('click', async () => {
        const known = (p.allModels && p.allModels.length ? p.allModels : p.models) || [];
        if (!known.length) {
          toast(t('settings.llm_models_empty_title'), t('settings.llm_models_empty_hint'), 'warn');
          return;
        }
        await openModelPicker(p, known, new Map());
      });

      card.querySelector('[data-def]')?.addEventListener('click', async () => {
        try {
          await saveProvider({ id: p.id, providerId: p.providerId, isDefault: true });
          toast(t('settings.llm_default_title'), p.providerName || p.providerId, 'ok');
        } catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
      });

      card.querySelector('[data-key]').addEventListener('click', () => providerModal(p));

      card.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: t('settings.llm_del_kicker'),
          title: t('settings.llm_del_title', { name: p.providerName || p.providerId }),
          text: t('settings.llm_del_text'),
          okText: t('settings.btn_delete'),
        });
        if (!ok) return;
        try { await removeProvider(p.id); toast(t('settings.llm_deleted'), p.providerName || p.providerId, 'ok'); }
        catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
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
          return t('settings.mp_price', { p: `${f(m.in)} / ${f(m.out)}` });
        }
        return '';
      };

      /** Окно контекста: 200000 -> "200K", 1048576 -> "1M". */
      const ctxLabel = (n) => {
        if (!n) return '';
        if (n >= 1000000) return t('settings.mp_ctx_m', { n: (n / 1000000).toFixed(n % 1000000 ? 1 : 0) });
        return t('settings.mp_ctx_k', { n: Math.round(n / 1000) });
      };

      const listHTML = () => {
        const r = rows();
        if (!r.length) return `<div class="dim" style="padding:22px;text-align:center;font-size:12.5px">${esc(t('settings.mp_empty'))}</div>`;
        return r
          .map((m) => {
            const id = m.id;
            const meta0 = src.get(id) || m;
            const bits = [];
            const cx = ctxLabel(meta0.ctx);
            if (cx) bits.push(cx);
            const pr = price(meta0);
            if (pr) bits.push(pr);
            if (meta0.src === 'catalog') bits.push(t('settings.mp_from_catalog'));
            return `<label class="mp-row${chosen.has(id) ? ' is-on' : ''}" data-mp-row="${esc(id)}">
              <input type="checkbox" data-mp="${esc(id)}" ${chosen.has(id) ? 'checked' : ''}>
              <span class="mp-id">${esc(id)}</span>
              ${bits.length ? `<span class="mp-meta">${esc(bits.join(' · '))}</span>` : ''}
            </label>`;
          })
          .join('');
      };

      const dlg = openModal({
        kicker: t('settings.mp_kicker'),
        title: t('settings.mp_title', { title }),
        body: `
          <div class="mp-bar">
            <input class="input" id="mpSearch" placeholder="${esc(t('settings.mp_search_ph'))}" autocomplete="off">
            <button class="btn btn-mini btn-ghost" id="mpAll" type="button">${esc(t('settings.mp_all'))}</button>
            <button class="btn btn-mini btn-ghost" id="mpNone" type="button">${esc(t('settings.mp_none'))}</button>
          </div>
          <div class="mp-count" id="mpCount"></div>
          <div class="mp-list" id="mpList">${listHTML()}</div>
          <div class="field" style="margin-top:14px">
            <label>${esc(t('settings.mp_manual_label'))}</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="mpManual" placeholder="${esc(t('settings.mp_manual_ph'))}" autocomplete="off">
              <button class="btn btn-mini btn-run" id="mpAdd" type="button">${icon('plus')}${esc(t('settings.btn_add'))}</button>
            </div>
            <span class="field-hint">${esc(t('settings.mp_manual_hint'))}</span>
          </div>
          <div id="mpManualList" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>`,
        footer: `<button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_cancel'))}</button>
                 <button class="btn btn-primary" id="mpOk">${icon('check')}${esc(t('settings.btn_done'))}</button>`,
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
          .map((id) => `<span class="chip chip-removable" style="--chip-c:var(--amber)">${esc(id)}<button type="button" data-rm="${esc(id)}" aria-label="${esc(t('settings.mp_remove_aria'))}">${icon('x')}</button></span>`)
          .join('');
      };
      const renderCount = () => {
        countBox.textContent = t('settings.mp_count', { sel: chosen.size, total: models.length, manual: manual.size ? t('settings.mp_count_manual', { n: manual.size }) : '' });
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
          toast(t('settings.mp_need_title'), t('settings.mp_need_text'), 'warn');
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
  toast(t('settings.llm_models_saved'), t('settings.llm_models_saved_text', { n: chosen.length }), 'ok');
  renderLlm();
}

  function providerModal(p, presetProviderId) {
    const isNew = !p;
    const cat = store.catalog || [];
    const cur = p ? p.providerId : (presetProviderId || (cat[0] && cat[0].id));
    const known = cat.find((c) => c.id === cur) || {};
    const m = openModal({
      kicker: isNew ? t('settings.pv_new_kicker') : t('settings.pv_edit_kicker'),
      title: isNew ? t('settings.pv_new_title') : t('settings.pv_edit_title', { name: p.providerName || p.providerId }),
      body: `
        ${isNew ? `
          <div class="field"><label>${esc(t('settings.pv_fld_provider'))}</label>
            <select class="select" id="pvId">
              ${cat.map((c) => `<option value="${esc(c.id)}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
            <span class="field-hint" id="pvHint">${esc(known.keyUrl ? t('settings.pv_key_hint_url', { url: known.keyUrl }) : t('settings.pv_key_hint_free'))}</span>
          </div>` : ''}
        <div class="field"><label>base url</label>
          <input class="input" id="pvUrl" maxlength="300" placeholder="https://api.openai.com/v1"
            value="${esc(p ? (p.baseUrl || '') : (known.baseUrl || ''))}">
          <span class="field-hint">${esc(t('settings.pv_base_hint'))}</span>
        </div>
        <div class="field"><label>${esc(t('settings.pv_fld_key'))}</label>
          <div style="display:flex;gap:8px">
            <input class="input" id="pvKey" type="password" autocomplete="off"
              placeholder="${esc(isNew ? t('settings.pv_key_ph_new') : t('settings.pv_key_ph_keep'))}"
              value="">
            <button class="icon-btn" id="pvEye" aria-label="${esc(t('settings.ph_show_key'))}"
              style="flex:none;width:44px;border:1px solid var(--line)">${icon('eye')}</button>
          </div>
          <span class="field-hint">${esc(t('settings.pv_key_store_hint'))}</span>
        </div>
        <label class="chk-row"><input type="checkbox" id="pvDef" ${isNew ? 'checked' : ''}>
          <span>${esc(t('settings.pv_make_default'))}</span></label>
        <div id="pvRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_cancel'))}</button>
               <button class="btn btn-primary" id="pvSave">${icon('check')}${esc(isNew ? t('settings.pv_save_new') : t('settings.btn_save'))}</button>`,
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
      m.modal.querySelector('#pvHint').textContent = c.keyUrl ? t('settings.pv_key_hint_url', { url: c.keyUrl }) : t('settings.pv_key_hint_free');
    });

    m.modal.querySelector('#pvSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#pvSave');
      const resBox = m.modal.querySelector('#pvRes');
      const providerId = isNew ? sel.value : p.providerId;
      const baseUrl = (m.modal.querySelector('#pvUrl').value || '').trim();
      const apiKey = (keyInput.value || '').trim();
      const isDefault = m.modal.querySelector('#pvDef').checked;

      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.pv_err_url'))}</div>`;
        return;
      }
      const catEntry = cat.find((c) => c.id === providerId) || {};
      if (isNew && catEntry.keyRequired && !apiKey) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.pv_err_need_key'))}</div>`;
        return;
      }

      btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.btn_saving'))}`;
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

        resBox.innerHTML = `<div class="banner banner-warn" style="margin:0"><span class="spinner"></span>${esc(t('settings.pv_checking'))}</div>`;
        const res = targetId ? await probeProvider(targetId) : { ok: false, detail: t('settings.pv_not_created'), models: [] };

        const found = res.models || [];
        if (!targetId || !found.length) {
          resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.pv_saved_no_models', { detail: res.detail || res.message || t('settings.llm_no_link') }))}</div>`;
          btn.innerHTML = `${icon('check')}${esc(t('settings.btn_close'))}`;
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
        toast(t('settings.pv_connected'), t('settings.pv_connected_text', { n: found.length }), 'ok');
        renderLlm();
        await openModelPicker(fresh, found, new Map((res.meta || []).map((x) => [x.id, x])));
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}${esc(isNew ? t('settings.pv_save_new') : t('settings.btn_save'))}`;
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
          <span class="badge ${connected ? 'badge-ok' : 'badge-off'}"><i></i>${esc(connected ? t('settings.svc_connected') : t('settings.svc_off'))}</span>
        </div>
        <div class="svc-key">
          ${s.noKey
            ? `<span class="k-ok">${esc((s.url || '').slice(0, 40))}</span><span>${esc(t('settings.svc_path_set'))}</span>`
            : s.hasKey
              ? `<span class="k-ok">${esc(s.keyHintMask || '')}</span><span>${esc(t('settings.svc_key_saved'))}</span>`
              : `<span class="k-no">${esc(t('settings.llm_key_missing'))}</span>`}
          ${checked ? `<span style="margin-left:auto;color:var(--text-3)">${fmtTime(s.lastCheck)}</span>` : ''}
        </div>
        ${s.checkDetail ? `<div class="svc-detail" title="${esc(s.checkDetail)}">${esc(s.checkDetail)}</div>` : ''}
        ${(s.actions || []).length ? `<div class="svc-ops"><b>${readOps}</b> ${esc(t('settings.svc_read'))} · <b>${writeOps}</b> ${esc(t('settings.svc_write'))}</div>` : ''}
        <div class="svc-foot">
          <button class="btn btn-mini ${connected ? '' : 'btn-run'}" data-check>${esc(s.noKey ? t('settings.svc_check_path') : s.hasKey ? t('settings.llm_btn_check') : t('settings.svc_add_key'))}</button>
          ${(s.actions || []).length ? `<button class="btn btn-mini btn-ghost" data-ops>${esc(t('settings.svc_ops_btn'))}</button>` : ''}
          <button class="btn btn-mini btn-ghost" data-edit>${esc(s.noKey ? t('settings.svc_path_btn') : s.hasKey ? t('settings.svc_change_key') : t('settings.llm_btn_key'))}</button>
          <button class="icon-btn danger" data-del aria-label="${esc(t('settings.svc_del_aria', { name: s.name }))}">${icon('trash')}</button>
        </div>
      </article>`;
  }

  function renderServices() {
    const available = (store.integrations || []).filter((i) => !store.services.some((s) => s.id === i.id));
    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">${esc(t('settings.svc_kicker'))}</div><h2>${esc(t('settings.svc_title'))}</h2></div>
          <span class="sub">${esc(t('settings.svc_sub'))}</span>
        </div>
        ${store.services.length ? `
          <div class="svc-grid">
            ${store.services.map(svcCardHTML).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">${icon('plug')}</div>
            <h3>${esc(t('settings.svc_empty_title'))}</h3>
            <p>${esc(t('settings.svc_empty_text'))}</p>
          </div>`}

        ${available.length ? `
        <div class="tool-head" style="margin-top:26px">
          <div><div class="kicker">${esc(t('settings.svc_catalog_kicker'))}</div><h2>${esc(t('settings.svc_catalog_title'))}</h2></div>
          <span class="sub">${esc(t('settings.svc_catalog_sub'))}</span>
        </div>
        <div class="svc-grid">
          ${available.map((i) => `
            <article class="svc-card svc-card-add" style="--sc:${SVC_COLORS[i.id] || SVC_COLORS.custom}">
              <div class="svc-top">
                <span class="svc-ico">${icon(SVC_ICONS[i.id] || i.icon || 'plug')}</span>
                <div class="svc-name"><b>${esc(i.name)}</b><span>${esc(i.category)}</span></div>
                <span class="badge badge-off"><i></i>${esc(t('settings.svc_off'))}</span>
              </div>
              <div class="svc-detail">${esc(i.keyLabel)}${i.actions.length ? esc(t('settings.svc_catalog_ops', { n: i.actions.length })) : ''}</div>
              <div class="svc-foot">
                <button class="btn btn-mini btn-run" data-add-int="${esc(i.id)}">${icon('plus')}${esc(t('settings.svc_connect'))}</button>
                ${i.docs ? `<a class="btn btn-mini btn-ghost" href="${esc(i.docs)}" target="_blank" rel="noopener">${esc(t('settings.svc_docs'))}</a>` : ''}
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
          kicker: t('settings.svc_del_kicker'),
          title: t('settings.svc_del_title', { name: svc.name }),
          text: t('settings.svc_del_text'),
          okText: t('settings.btn_delete'),
        });
        if (!ok) return;
        try { await removeService(svc.id); toast(t('settings.svc_deleted'), svc.name, 'ok'); }
        catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
      });
    });
  }

  async function runCheck(svc, card) {
    const btn = card && card.querySelector('[data-check]');
    if (btn) { btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.svc_checking'))}`; btn.style.pointerEvents = 'none'; }
    try {
      const res = await checkService(svc.id);
      const detail = res.detail || res.message || '';
      if (res.ok) toast(t('settings.svc_ok', { name: svc.name }), t('settings.svc_ok_text', { detail: detail || t('settings.svc_ok_fallback'), ms: res.latencyMs }), 'ok');
      else toast(t('settings.svc_fail', { name: svc.name }), detail || t('settings.svc_fail_text'), 'err');
    } catch (e) {
      toast(t('settings.llm_probe_err'), e.message, 'err');
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
      title: t('settings.op_title'),
      body: `
        <div class="field"><label>${esc(t('settings.op_fld'))}</label>
          <select class="select" id="aName">${acts.map((a) => `<option value="${esc(a.name)}"${a.write && !full ? ' disabled' : ''}>${esc(a.label)}${a.write ? esc(t('settings.op_write_suffix')) : ''}</option>`).join('')}</select></div>
        <div id="aFields"></div>
        <div id="aRes"></div>
        ${!full ? `<div class="banner banner-warn" style="margin:0 0 12px">${esc(t('settings.op_write_warn'))}</div>` : ''}`,
      footer: `
        <button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_close'))}</button>
        <button class="btn btn-primary" id="aRun">${icon('play')}${esc(t('settings.op_run'))}</button>`,
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
        : `<span class="field-hint">${esc(t('settings.op_no_params'))}</span>`;
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
      btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.op_running'))}`;
      btn.style.pointerEvents = 'none';
      try {
        const out = await runServiceAction(svc.id, act.name, args);
        if (out.ok) {
          resBox.innerHTML = `<div class="banner banner-ok" style="margin:0"><b>${esc(t('settings.op_done', { ms: out.latencyMs }))}</b><pre class="svc-pre">${esc(out.result)}</pre></div>`;
          toast(t('settings.op_done_toast', { name: svc.name }), act.label, 'ok');
        } else {
          resBox.innerHTML = `<div class="banner banner-err" style="margin:0"><b>${esc(t('settings.op_failed', { label: act.label }))}</b><pre class="svc-pre">${esc(out.error)}</pre></div>`;
        }
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
      } finally {
        btn.innerHTML = `${icon('play')}${esc(t('settings.op_retry'))}`;
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
      kicker: isNew ? t('settings.svc_modal_new_kicker') : t('settings.svc_modal_edit_kicker'),
      title: isNew ? t('settings.svc_modal_new_title', { name: model.name }) : t('settings.svc_modal_edit_title', { name: model.name }),
      body: `
        ${isNew && !it ? `
          <div class="field"><label>${esc(t('settings.svc_fld_name'))}</label>
            <input class="input" id="mName" maxlength="40" placeholder="${esc(t('settings.svc_fld_name_ph'))}" required></div>` : ''}
        ${isNew ? `
          <div class="field-row">
            <div class="field"><label>${esc(t('settings.svc_fld_cat'))}</label>
              <input class="input" id="mCat" maxlength="40" value="${esc(model.category)}"></div>
          </div>` : ''}
        ${it ? (it.keyRequired === false ? `
          <div class="field"><label>${esc(it.keyLabel)}</label>
            <div class="banner" style="margin:0">${esc(it.keyHint)}</div>
          </div>` : `
          <div class="field"><label>${esc(it.keyLabel)}</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="mKey" type="password" autocomplete="off" placeholder="${esc(svc && svc.hasKey ? t('settings.svc_key_ph_keep') : t('settings.svc_key_ph_new'))}">
              <button class="icon-btn" id="mEye" aria-label="${esc(t('settings.ph_show_key'))}" style="flex:none;width:44px;border:1px solid var(--line)">${icon('eye')}</button>
            </div>
            <span class="field-hint">${esc(it.keyHint)}${it.keyUrl ? ` · <a href="${esc(it.keyUrl)}" target="_blank" rel="noopener">${esc(t('settings.svc_key_where'))}</a>` : ''}</span>
          </div>`) : `
          <div class="field"><label>${esc(t('settings.svc_fld_key'))}</label>
            <div style="display:flex;gap:8px">
              <input class="input" id="mKey" type="password" autocomplete="off" placeholder="${esc(t('settings.svc_fld_key_ph'))}">
              <button class="icon-btn" id="mEye" aria-label="${esc(t('settings.ph_show_key'))}" style="flex:none;width:44px;border:1px solid var(--line)">${icon('eye')}</button>
            </div>
            <span class="field-hint">${esc(t('settings.svc_key_store_hint'))}</span>
          </div>`}
        <div class="field"><label>${esc((it && it.urlLabel) || t('settings.svc_fld_url'))}</label>
          <input class="input" id="mUrl" maxlength="200" placeholder="${esc((it && it.id === 'obsidian') ? 'C:\\Users\\you\\Documents\\vault' : 'https://api.example.com')}" value="${esc(model.url)}"></div>
        ${it ? '<div id="mRes"></div>' : '<div id="mRes"></div>'}`,
      footer: `
        <button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_cancel'))}</button>
        <button class="btn btn-primary" id="mSave">${icon('link')}${esc(t('settings.svc_save_check'))}</button>`,
    });

    const keyInput = m.modal.querySelector('#mKey');
    const resBox = m.modal.querySelector('#mRes');
    m.modal.querySelector('#mEye')?.addEventListener('click', (e) => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
      e.currentTarget.setAttribute('aria-label', show ? t('settings.ph_hide_key') : t('settings.ph_show_key'));
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
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.svc_err_name'))}</div>`;
        return;
      }
      /* Сервисы без ключа (локальный Obsidian) сохраняются по пути */
      const needsKey = !(it && it.keyRequired === false);
      if (needsKey && !apiKey && !(svc && svc.hasKey)) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.svc_err_key'))}</div>`;
        return;
      }
      if (apiKey && apiKey.length < 6) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.svc_err_short'))}</div>`;
        return;
      }
      btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.btn_saving'))}`;
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

        resBox.innerHTML = `<div class="banner banner-warn" style="margin:0"><span class="spinner"></span>${esc(t('settings.svc_checking_real'))}</div>`;
        const res = await checkService(item.id);
        if (res.ok) {
          toast(t('settings.svc_connected_toast', { name }), t('settings.svc_ok_text', { detail: res.detail || t('settings.svc_ok_fallback'), ms: res.latencyMs }), 'ok');
          m.close();
          return;
        }
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0"><b>${esc(t('settings.svc_saved_fail'))}</b><div>${esc(res.detail || res.message || t('settings.svc_fail_text'))}</div></div>`;
        btn.innerHTML = `${icon('refresh')}${esc(t('settings.svc_recheck'))}`;
        btn.style.pointerEvents = '';
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('link')}${esc(t('settings.svc_save_check'))}`;
        btn.style.pointerEvents = '';
      }
    });
  }

  /* ================================================== ПРОГРАММЫ */

  function permBtn(p, key, labelKey) {
    return `<button class="perm-toggle" role="switch" aria-checked="${!!p.perms[key]}" data-perm="${key}"
      aria-label="${esc(t('settings.prg_perm_aria', { label: t(`settings.perm_${key}`), name: p.name }))}"><i class="switch" aria-hidden="true"></i><span>${esc(t(`settings.${labelKey}`))}</span></button>`;
  }

  function renderPrograms() {
    panel.innerHTML = `
      <div class="tab-panel">
        <div class="tool-head">
          <div><div class="kicker">${esc(t('settings.prg_kicker'))}</div><h2>${esc(t('settings.prg_title'))}</h2></div>
          <span class="sub">${esc(t('settings.prg_sub'))}</span>
          <div class="spacer"></div>
          <button class="btn" id="scanBtn" ${scanning ? 'disabled' : ''}>${icon('scan')}${esc(t('settings.prg_scan'))}</button>
          <button class="btn btn-primary" id="addPrgBtn">${icon('plus')}${esc(t('settings.prg_add'))}</button>
        </div>

        <div id="scanHost"></div>

        ${store.programs.length ? `
          <div class="prg-list">
            ${store.programs.map((p) => `
              <div class="prg-row" data-prg="${esc(p.id)}">
                <span class="prg-ico">${icon('appWindow')}</span>
                <div class="prg-info">
                  <b>${esc(p.name)}${p.source === 'scan' ? '' : ` <span class="chip" style="--chip-c:var(--amber);height:19px;font-size:9.5px"><i></i>${esc(t('settings.prg_manual_badge'))}</span>`}${p.missing ? ` <span class="chip" style="--chip-c:var(--rose);height:19px;font-size:9.5px"><i></i>${esc(t('settings.prg_missing_badge'))}</span>` : ''}</b>
                  <span title="${esc(p.path)}">${esc(p.path)}</span>
                </div>
                <div class="prg-perms">
                  ${permBtn(p, 'run', 'perm_run')}
                  ${permBtn(p, 'read', 'perm_read')}
                  ${permBtn(p, 'write', 'perm_write')}
                </div>
                <button class="icon-btn danger" data-del aria-label="${esc(t('settings.prg_del_aria', { name: p.name }))}">${icon('trash')}</button>
              </div>`).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">${icon('appWindow')}</div>
            <h3>${esc(t('settings.prg_empty_title'))}</h3>
            <p>${esc(t('settings.prg_empty_text'))}</p>
            <button class="btn btn-primary" id="scanBtn2">${icon('scan')}${esc(t('settings.prg_scan'))}</button>
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
            toast(t('settings.prg_perm_updated'), t('settings.prg_perm_updated_text', { name: p.name, perm: t(`settings.perm_${key}`), state: t(next[key] ? 'settings.prg_on' : 'settings.prg_off') }), 'ok');
          } catch (e) {
            btn.setAttribute('aria-checked', String(p.perms[key]));
            toast(t('settings.err_title'), e.message, 'err');
          }
        });
      });
      row.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: t('settings.prg_del_kicker'),
          title: t('settings.prg_del_title', { name: p.name }),
          text: t('settings.prg_del_text'),
          okText: t('settings.btn_delete'),
        });
        if (!ok) return;
        try { await removeProgram(p.id); toast(t('settings.prg_deleted'), p.name, 'ok'); }
        catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
      });
    });
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    const btn = page.querySelector('#scanBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.prg_scanning_btn'))}`; }
    const host = panel.querySelector('#scanHost') || document.getElementById('scanHost');
    host.innerHTML = `
      <div class="panel scan-panel">
        <div class="scan-top">
          <b>${esc(t('settings.prg_scanning_title'))}</b>
          <span class="mono" id="scanPct">${esc(t('settings.prg_scanning_sub'))}</span>
        </div>
        <div class="progress"><i id="scanBar" style="width:60%"></i></div>
        <div class="scan-file mono" id="scanFile">${esc(t('settings.prg_scanning_note'))}</div>
      </div>`;
    try {
      /* Настоящий скан на сервере: известные пути + PATH, слияние по путям */
      const out = await api('/api/programs/scan', { method: 'POST', body: {} });
      await refreshPrograms();
      toast(t('settings.prg_scan_done'), out.added ? t('settings.prg_scan_added', { added: out.added, total: out.total }) : t('settings.prg_scan_none', { total: out.total }), out.added ? 'ok' : 'warn');
    } catch (e) {
      toast(t('settings.prg_scan_fail'), e.message, 'err');
    } finally {
      scanning = false;
      renderPanel();
    }
  }

  function programModal() {
    const m = openModal({
      kicker: t('settings.prg_modal_kicker'),
      title: t('settings.prg_modal_title'),
      body: `
        <div class="field"><label>${esc(t('settings.svc_fld_name'))}</label>
          <input class="input" id="pName" maxlength="60" placeholder="${esc(t('settings.prg_name_ph'))}"></div>
        <div class="field"><label>${esc(t('settings.prg_path_label'))}</label>
          <input class="input" id="pPath" maxlength="300" placeholder="C:\\Program Files\\...\\app.exe"></div>
        <div class="field"><span class="field-label">${esc(t('settings.prg_perms_label'))}</span>
          <div class="prg-perms" style="flex-wrap:wrap">
            <button class="perm-toggle" role="switch" aria-checked="true" data-p="run"><i class="switch"></i><span>${esc(t('settings.perm_run'))}</span></button>
            <button class="perm-toggle" role="switch" aria-checked="true" data-p="read"><i class="switch"></i><span>${esc(t('settings.perm_read'))}</span></button>
            <button class="perm-toggle" role="switch" aria-checked="false" data-p="write"><i class="switch"></i><span>${esc(t('settings.perm_write'))}</span></button>
          </div>
        </div>
        <div id="pRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_cancel'))}</button>
               <button class="btn btn-primary" id="pSave">${icon('plus')}${esc(t('settings.btn_add'))}</button>`,
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
        m.modal.querySelector('#pRes').innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.prg_err_fill'))}</div>`;
        return;
      }
      try {
        const list = await saveProgram({ name, path, perms, source: 'manual' });
        const saved = (list || []).find((x) => x.path === path) || {};
        if (saved.missing) {
          toast(t('settings.prg_saved_warn'), t('settings.prg_saved_warn_text'), 'warn');
        } else {
          toast(t('settings.prg_added'), name, 'ok');
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
      connected: ['badge-ok', t('settings.mcp_st_connected')],
      off: ['badge-off', t('settings.mcp_st_off')],
      connecting: ['badge-warn badge-live', t('settings.mcp_st_connecting')],
      error: ['badge-err', t('settings.mcp_st_error')],
    };
    const [cls, label] = map[m.status] || map.off;
    return `<span class="badge ${cls}"><i></i>${esc(label)}</span>`;
  }

  function mcpLogHTML(m) {
    const lines = (m.log || []).slice(-14);
    if (!lines.length) return `<div class="dim" style="font-size:12px;padding:2px 0">${esc(t('settings.mcp_log_empty'))}</div>`;
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
          <div><div class="kicker">${esc(t('settings.mcp_kicker'))}</div><h2>${esc(t('settings.mcp_title'))}</h2></div>
          <span class="sub">${esc(t('settings.mcp_sub'))}</span>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="addMcpBtn">${icon('plus')}${esc(t('settings.mcp_add'))}</button>
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
                      ${(m.tools || []).slice(0, 4).map((tool_) => `<span class="chip" style="--chip-c:var(--violet)"><i></i>${esc(tool_)}</span>`).join('')}
                      ${(m.tools || []).length > 4 ? `<span class="chip">+${m.tools.length - 4}</span>` : ''}
                    </div>
                  </div>
                  <div class="mcp-actions">
                    <button class="switch switch-cyan" role="switch" aria-checked="${m.status === 'connected'}"
                      data-toggle aria-label="${esc(t(m.status === 'connected' ? 'settings.mcp_aria_off' : 'settings.mcp_aria_on', { name: m.name }))}"></button>
                    <button class="icon-btn" data-recon aria-label="${esc(t('settings.mcp_aria_recon', { name: m.name }))}">${icon('refresh')}</button>
                    <button class="icon-btn" data-edit aria-label="${esc(t('settings.mcp_aria_edit', { name: m.name }))}">${icon('pencil')}</button>
                    <button class="icon-btn danger" data-del aria-label="${esc(t('settings.mcp_aria_del', { name: m.name }))}">${icon('trash')}</button>
                  </div>
                </div>
                <details class="mcp-log">
                  <summary>${esc(t('settings.mcp_log_sum', { n: (m.log || []).length }))}</summary>
                  <pre>${mcpLogHTML(m)}</pre>
                </details>
              </article>`).join('')}
          </div>` : `
          <div class="empty">
            <div class="empty-icon">${icon('layers')}</div>
            <h3>${esc(t('settings.mcp_empty_title'))}</h3>
            <p>${esc(t('settings.mcp_empty_text'))}</p>
            <button class="btn btn-primary" id="addMcpBtn2">${icon('plus')}${esc(t('settings.mcp_add'))}</button>
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
          try { await saveMcp({ ...m, status: 'off' }); toast(t('settings.mcp_off'), m.name, 'ok'); }
          catch (err) { toast(t('settings.err_title'), err.message, 'err'); }
        } else {
          sw.setAttribute('aria-checked', 'true');
          await doReconnect(m);
        }
      });

      card.querySelector('[data-recon]').addEventListener('click', () => doReconnect(m));

      card.querySelector('[data-edit]').addEventListener('click', () => mcpModal(m));

      card.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: t('settings.mcp_del_kicker'),
          title: t('settings.mcp_del_title', { name: m.name }),
          text: t('settings.mcp_del_text'),
          okText: t('settings.btn_delete'),
        });
        if (!ok) return;
        try { await removeMcp(m.id); toast(t('settings.mcp_deleted'), m.name, 'ok'); }
        catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
      });
    });
  }

  async function doReconnect(m) {
    const card = panel.querySelector(`[data-mcp="${m.id}"]`);
    const ico = card ? card.querySelector('.mcp-ico') : null;
    const badge = card ? card.querySelector('.badge') : null;
    if (ico) ico.classList.add('spinning');
    if (badge) { badge.className = 'badge badge-warn badge-live'; badge.innerHTML = `<i></i>${esc(t('settings.mcp_st_connecting'))}`; }
    try {
      const updated = await reconnectMcp(m.id);
      if (updated.status === 'connected') toast(t('settings.mcp_recon_ok'), t('settings.mcp_recon_ok_text', { name: m.name }), 'ok');
      else toast(t('settings.mcp_recon_fail'), t('settings.mcp_recon_fail_text', { name: m.name }), 'err');
    } catch (e) {
      toast(t('settings.mcp_recon_err'), e.message, 'err');
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
      kicker: isNew ? t('settings.mcp_modal_new_kicker') : t('settings.mcp_modal_edit_kicker'),
      title: isNew ? t('settings.mcp_modal_new_title') : t('settings.mcp_modal_edit_title', { name: model.name }),
      body: `
        <div class="field-row">
          <div class="field" style="flex:1 1 180px"><label>${esc(t('settings.mcp_fld_name'))}</label>
            <input class="input" id="cName" maxlength="60" placeholder="mcp-github" value="${esc(model.name)}"></div>
          <div class="field" style="flex:0 1 190px"><label>${esc(t('settings.mcp_fld_transport'))}</label>
            <select class="select" id="cTransport">
              ${['stdio', 'sse', 'http'].map((t_) => `<option value="${t_}" ${t_ === model.transport ? 'selected' : ''}>${t_ === 'stdio' ? esc(t('settings.mcp_tr_stdio')) : esc(t('settings.mcp_tr_remote', { t: t_ }))}</option>`).join('')}
            </select></div>
        </div>
        <div class="field"><label id="cTargetLabel">${esc(t('settings.mcp_fld_cmd'))}</label>
          <input class="input" id="cTarget" maxlength="300" value="${esc(model.target)}"></div>
        <span class="field-hint" id="cHint"></span>

        <div class="field" id="cEnvWrap"><label>${esc(t('settings.mcp_fld_env'))}</label>
          <textarea class="input mono" id="cEnv" rows="3" maxlength="2000">${esc(envText)}</textarea>
          <span class="field-hint">${t('settings.mcp_env_hint')}</span></div>

        <div class="field" id="cHeadWrap" style="display:none"><label>${esc(t('settings.mcp_fld_headers'))}</label>
          <textarea class="input mono" id="cHead" rows="2" maxlength="2000">${esc(headersText)}</textarea>
          <span class="field-hint">${t('settings.mcp_headers_hint')}</span></div>

        <div id="cRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_cancel'))}</button>
               <button class="btn btn-ghost" id="cTest">${icon('refresh')}${esc(t('settings.mcp_test'))}</button>
               <button class="btn btn-primary" id="cSave">${icon('check')}${esc(isNew ? t('settings.mcp_save_new') : t('settings.btn_save'))}</button>`,
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
      tLabel.textContent = remote ? t('settings.mcp_fld_url') : t('settings.mcp_fld_cmd');
      tInput.placeholder = remote
        ? 'https://example.com/mcp'
        : 'npx -y @modelcontextprotocol/server-filesystem D:\\projects';
      hint.textContent = remote
        ? t('settings.mcp_hint_remote')
        : t('settings.mcp_hint_local');
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
      if (c.name.length < 2) return t('settings.mcp_err_name');
      const remote = c.transport === 'http' || c.transport === 'sse';
      if (remote && !/^https?:\/\//i.test(c.target)) return t('settings.mcp_err_url');
      if (!remote && c.target.length < 2) {
        return t('settings.mcp_err_cmd');
      }
      return '';
    };

    /* Проверка до сохранения: настоящий handshake, показываем найденные инструменты */
    mdl.modal.querySelector('#cTest').addEventListener('click', async () => {
      const b = mdl.modal.querySelector('#cTest');
      const c = collect();
      const err = validate(c);
      if (err) { setRes(`<div class="banner banner-err" style="margin:0">${esc(err)}</div>`); return; }
      b.innerHTML = `<span class="spinner"></span>${esc(t('settings.mcp_testing'))}`;
      b.style.pointerEvents = 'none';
      setRes(`<div class="banner banner-warn" style="margin:0"><span class="spinner"></span>${esc(t('settings.mcp_handshake'))}</div>`);
      try {
        const probe = await testMcp(c);
        if (probe.ok) {
          setRes(`<div class="banner banner-ok" style="margin:0">
            <b>${esc(probe.serverName || t('settings.mcp_server_fallback'))}</b> ${esc(t('settings.mcp_probe_ok', { n: probe.tools.length }))}
            ${probe.tools.length ? `<div class="dim" style="font-size:11.5px;margin-top:6px;overflow-wrap:anywhere">${esc(probe.tools.slice(0, 40).join(', '))}${probe.tools.length > 40 ? '…' : ''}</div>` : ''}
          </div>`);
        } else {
          setRes(`<div class="banner banner-err" style="margin:0">${esc(t('settings.mcp_probe_fail', { err: probe.error || t('settings.mcp_unknown_err') }))}</div>`);
        }
      } catch (e) {
        setRes(`<div class="banner banner-err" style="margin:0">${esc(e.message)}</div>`);
      }
      b.innerHTML = `${icon('refresh')}${esc(t('settings.mcp_test'))}`;
      b.style.pointerEvents = '';
    });

    mdl.modal.querySelector('#cSave').addEventListener('click', async () => {
      const c = collect();
      const err = validate(c);
      if (err) { setRes(`<div class="banner banner-err" style="margin:0">${esc(err)}</div>`); return; }
      const btn = mdl.modal.querySelector('#cSave');
      btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.btn_saving'))}`;
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
        btn.innerHTML = `${icon('check')}${esc(t('settings.btn_save'))}`;
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
          <div><div class="kicker">${esc(t('settings.acc_kicker'))}</div><h2>${esc(t('settings.acc_title'))}</h2></div>
          <span class="sub">${esc(t('settings.acc_sub'))}</span>
        </div>

        <div class="acc-grid">
          <section class="panel acc-card">
            <div class="acc-head">${icon('sliders')}<b>${esc(t('settings.acc_mode_title'))}</b>
              <span class="badge ${mode === 'full' ? 'badge-warn' : 'badge-ok'}"><i></i>${esc(mode === 'full' ? t('settings.acc_mode_full') : t('settings.acc_mode_ro'))}</span>
            </div>
            <p class="acc-desc">${esc(mode === 'full'
              ? t('settings.acc_mode_full_desc')
              : t('settings.acc_mode_ro_desc'))}</p>
            <div class="acc-row">
              <button class="btn ${mode === 'readonly' ? 'btn-primary' : 'btn-ghost'}" data-mode="readonly">${icon('eye')}${esc(t('settings.acc_mode_ro_btn'))}</button>
              <button class="btn ${mode === 'full' ? 'btn-primary' : 'btn-ghost'}" data-mode="full">${icon('pen')}${esc(t('settings.acc_mode_full_btn'))}</button>
            </div>
          </section>

          <section class="panel acc-card">
            <div class="acc-head">${icon('checkSquare')}<b>${esc(t('settings.acc_pin_title'))}</b>
              ${pinEnabled ? `<span class="badge badge-ok"><i></i>${esc(t('settings.acc_pin_on'))}</span>` : `<span class="badge badge-err"><i></i>${esc(t('settings.acc_pin_off'))}</span>`}
            </div>
            ${pinIsDefault ? `<div class="banner banner-warn" style="margin:0 0 12px">${t('settings.acc_pin_default_warn')}</div>` : ''}
            <p class="acc-desc">${esc(pinEnabled
              ? t('settings.acc_pin_on_desc', { n: a.pinLength || 6 })
              : t('settings.acc_pin_off_desc'))}</p>
            <div class="acc-row">
              <button class="btn btn-primary" data-pin>${icon('pencil')}${esc(pinEnabled ? t('settings.acc_pin_change') : t('settings.acc_pin_set'))}</button>
              ${pinEnabled ? `<button class="btn btn-ghost" data-unpin>${esc(t('settings.acc_pin_disable'))}</button>` : ''}
            </div>
          </section>
        </div>

        <section class="panel acc-card" id="tgCard">
          <div class="acc-head">${icon('send')}<b>${esc(t('settings.tg_title'))}</b>
            <span class="acc-note">${esc(t('settings.tg_note'))}</span>
          </div>
          <div id="tgBody"><div class="dim" style="font-size:12.5px"><span class="spinner"></span>${esc(t('settings.tg_loading'))}</div></div>
        </section>

        <section class="panel acc-card">
          <div class="acc-head">${icon('server')}<b>${esc(t('settings.net_title'))}</b>
            <span class="acc-note">${esc(isLocal ? t('settings.net_local') : t('settings.net_remote'))}</span>
          </div>
          ${lan.length ? `
            <div class="qr-grid">
              ${lan.map((n) => {
                const url = n.url || `http://${n.address}:${(store.net && store.net.port) || ''}`;
                const qr = qrSvg(url, { size: 168 });
                return `
                  <div class="qr-item">
                    <div class="qr-box">${qr || `<div class="qr-none">${esc(t('settings.net_qr_none'))}</div>`}</div>
                    <div class="qr-cap">
                      <b>${esc(n.iface || t('settings.net_iface'))}</b>
                      <span class="mono" title="${esc(url)}">${esc(n.address)}</span>
                      <button class="btn btn-mini btn-ghost" data-copy="${esc(url)}">${icon('link')}${esc(t('settings.net_copy'))}</button>
                    </div>
                  </div>`;
              }).join('')}
            </div>
            <p class="acc-hint">${esc(t('settings.net_hint'))}</p>
          ` : `<div class="acc-hint">${esc(t('settings.net_empty'))}</div>`}
        </section>

        <section class="panel acc-card">
          <div class="acc-head">${icon('users')}<b>${esc(t('settings.inv_title'))}</b>
            <span class="acc-note">${esc(t('settings.inv_note'))}</span>
            <div class="spacer"></div>
            <button class="btn btn-mini" data-invite>${icon('plus')}${esc(t('settings.inv_create'))}</button>
            ${invites.length ? `<button class="btn btn-mini btn-ghost" data-revoke>${esc(t('settings.inv_revoke'))}</button>` : ''}
          </div>
          ${invites.length ? `
            <div class="inv-list">
              ${invites.map((i) => `
                <div class="inv-row">
                  <span class="mono inv-code">${esc(i.code)}</span>
                  <span class="dim">${i.used ? esc(t('settings.inv_used')) : esc(t('settings.inv_until', { dt: fmtDateTime(i.expires) }))}</span>
                </div>`).join('')}
            </div>` : `<div class="acc-hint">${esc(t('settings.inv_empty'))}</div>`}
        </section>
      </div>`;

    panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode, isLocal)));

    panel.querySelector('[data-pin]')?.addEventListener('click', pinModal);
    panel.querySelector('[data-unpin]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        kicker: t('settings.unpin_kicker'),
        title: t('settings.unpin_title'),
        text: t('settings.unpin_text'),
        okText: t('settings.acc_pin_disable'),
      });
      if (!ok) return;
      try { await clearPin(); toast(t('settings.unpin_done'), t('settings.unpin_done_text'), 'warn'); }
      catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
    });

    panel.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        const okCopy = await copyText(b.dataset.copy);
        toast(t(okCopy ? 'settings.net_copied' : 'settings.net_copy_fail'), b.dataset.copy, okCopy ? 'ok' : 'err');
      }));

    panel.querySelector('[data-invite]')?.addEventListener('click', async () => {
      try {
        const out = await createInvite(30);
        toast(t('settings.inv_created'), t('settings.inv_created_text', { code: out.invite.code }), 'ok');
      } catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
    });
    panel.querySelector('[data-revoke]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        kicker: t('settings.inv_revoke_kicker'),
        title: t('settings.inv_revoke_title'),
        text: t('settings.inv_revoke_text'),
        okText: t('settings.inv_revoke'),
      });
      if (!ok) return;
      try { await revokeInvites(); toast(t('settings.inv_revoked'), null, 'ok'); }
      catch (e) { toast(t('settings.err_title'), e.message, 'err'); }
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
      box.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.tg_load_fail', { err: e.message }))}</div>`;
      return;
    }
    const svcs = data.services || [];
    const agents = (data.agents || []).filter((a) => a.status !== 'offline');
    const poll = data.lastPoll;
    const pollLine = !data.enabled
      ? `<span class="field-hint">${esc(t('settings.tg_poll_off'))}</span>`
      : !poll
        ? `<span class="field-hint">${esc(t('settings.tg_poll_soon'))}</span>`
        : poll.ok
          ? `<span class="field-hint">${esc(t('settings.tg_poll_ok', { time: fmtTime(poll.at) }))}</span>`
          : `<div class="banner banner-err" style="margin:0 0 12px">${esc(t('settings.tg_poll_fail', { time: fmtTime(poll.at), err: poll.error || t('settings.mcp_unknown_err') }))}</div>`;
    box.innerHTML = `
      <p class="acc-desc">${t('settings.tg_desc')}</p>
      ${pollLine}
      <div class="acc-row" style="margin-bottom:12px">
        <span class="badge ${data.enabled ? 'badge-ok' : 'badge-off'}"><i></i>${esc(data.enabled ? t('settings.tg_on') : t('settings.tg_off'))}</span>
        <div class="spacer"></div>
        <button class="btn btn-mini btn-ghost" data-tg-refresh>${icon('refresh')}${esc(t('settings.tg_status'))}</button>
        <button class="btn ${data.enabled ? 'btn-ghost' : 'btn-primary'}" data-tg-toggle>${icon('power')}${esc(data.enabled ? t('settings.tg_disable') : t('settings.tg_enable'))}</button>
      </div>
      <div class="field"><label>${esc(t('settings.tg_svc_label'))}</label>
        <select class="select" id="tgSvc">
          ${svcs.length ? svcs.map((s) => `
            <option value="${esc(s.id)}" ${s.id === data.serviceId ? 'selected' : ''}>${esc(s.name)}${s.status === 'connected' ? '' : esc(t('settings.tg_svc_unchecked'))}${s.hasKey ? '' : esc(t('settings.tg_svc_nokey'))}</option>`).join('')
            : `<option value="">${esc(t('settings.tg_svc_empty'))}</option>`}
        </select></div>
      <div class="field"><label>${esc(t('settings.tg_target_label'))}</label>
        <select class="select" id="tgTarget">
          <option value="">${esc(t('settings.tg_target_team'))}</option>
          ${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === data.targetAgentId ? 'selected' : ''}>${esc(a.avatar || '')} ${esc(a.name)} · ${esc(a.role)}</option>`).join('')}
        </select>
        <span class="field-hint">${esc(t('settings.tg_target_hint'))}</span></div>
      <div class="field"><label>${esc(t('settings.tg_chats_label'))}</label>
        <input class="input mono" id="tgChats" placeholder="${esc(t('settings.tg_chats_ph'))}" value="${esc((data.chatIds || []).join(', '))}">
        <span class="field-hint">${esc(t('settings.tg_chats_hint'))}</span></div>
      <div class="acc-row">
        <button class="btn btn-primary" data-tg-save>${icon('check')}${esc(t('settings.btn_save'))}</button>
        <button class="btn btn-ghost" data-tg-recent>${esc(t('settings.tg_recent'))}</button>
        <button class="btn btn-ghost" data-tg-test>${esc(t('settings.tg_test'))}</button>
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
        toast(t('settings.tg_saved'), t(out.enabled ? 'settings.tg_saved_on' : 'settings.tg_saved_off'), 'ok');
        await refreshTgCard();
      } catch (e) { toast(t('settings.tg_save_fail'), e.message, 'err'); }
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
        toast(t(!data.enabled ? 'settings.tg_enabled' : 'settings.tg_disabled'),
          t(!data.enabled ? 'settings.tg_enabled_text' : 'settings.tg_disabled_text'), !data.enabled ? 'ok' : 'warn');
        await refreshTgCard();
      } catch (e) { toast(t('settings.tg_toggle_fail'), e.message, 'err'); }
    });
    box.querySelector('[data-tg-recent]').addEventListener('click', async () => {
      const recent = box.querySelector('#tgRecent');
      recent.innerHTML = `<div class="dim" style="font-size:12.5px"><span class="spinner"></span>${esc(t('settings.tg_recent_loading'))}</div>`;
      try {
        const out = await recentTgChats();
        const chats = out.chats || [];
        recent.innerHTML = chats.length ? `
          <div class="perm-list">
            ${chats.map((c) => `<button class="toggle-chip" role="switch" aria-checked="${c.allowed}" data-chat="${esc(c.id)}" style="--t-c:var(--cyan)">${esc(c.name)} · <span class="mono">${esc(c.id)}</span></button>`).join('')}
          </div>
          <span class="field-hint">${esc(t('settings.tg_recent_hint'))}</span>`
          : `<div class="dim" style="font-size:12.5px">${esc(t('settings.tg_recent_empty'))}</div>`;
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
      if (!first) { toast(t('settings.tg_test_nochat'), t('settings.tg_test_nochat_text'), 'warn'); return; }
      try {
        await testTgBridge(first);
        toast(t('settings.tg_test_sent'), t('settings.tg_test_sent_text', { id: first }), 'ok');
      } catch (e) { toast(t('settings.tg_test_fail'), e.message, 'err'); }
    });
  }

  async function switchMode(next, isLocal) {
    const cur = accessState().mode;
    if (cur === next) return;
    if (next === 'full') {
      const ok = await confirmDialog({
        kicker: t('settings.mode_full_kicker'),
        title: t('settings.mode_full_title'),
        text: t('settings.mode_full_text'),
        okText: t('settings.mode_full_ok'),
      });
      if (!ok) return;
    }
    try {
      await saveAccess({ mode: next });
      toast(t(next === 'full' ? 'settings.mode_full_on' : 'settings.mode_ro_on'), t(next === 'full' ? 'settings.mode_full_on_text' : 'settings.mode_ro_on_text'), next === 'full' ? 'warn' : 'ok');
    } catch (e) {
      toast(t('settings.err_title'), e.message, 'err');
    }
    void isLocal;
  }

  function pinModal() {
    const m = openModal({
      kicker: t('settings.pin_kicker'),
      title: t('settings.pin_title'),
      body: `
        <p class="field-hint" style="margin:0 0 14px">${esc(t('settings.pin_hint'))}</p>
        <div class="field"><label>${esc(t('settings.pin_new'))}</label>
          <input class="input pin-input" id="pin1" inputmode="numeric" maxlength="12" placeholder="••••••" autocomplete="off"></div>
        <div class="field"><label>${esc(t('settings.pin_repeat'))}</label>
          <input class="input pin-input" id="pin2" inputmode="numeric" maxlength="12" placeholder="••••••" autocomplete="off"></div>
        <div id="pinRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${esc(t('settings.btn_cancel'))}</button>
               <button class="btn btn-primary" id="pinSave">${icon('check')}${esc(t('settings.pin_save'))}</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelectorAll('.pin-input').forEach((i) =>
      i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); }));
    m.modal.querySelector('#pinSave').addEventListener('click', async () => {
      const a = m.modal.querySelector('#pin1').value;
      const b = m.modal.querySelector('#pin2').value;
      const resBox = m.modal.querySelector('#pinRes');
      if (!/^\d{4,12}$/.test(a)) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.pin_err_format'))}</div>`;
        return;
      }
      if (a !== b) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('settings.pin_err_mismatch'))}</div>`;
        return;
      }
      try {
        await setPin(a);
        await refreshAccess();
        toast(t('settings.pin_done'), t('settings.pin_done_text'), 'ok');
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
