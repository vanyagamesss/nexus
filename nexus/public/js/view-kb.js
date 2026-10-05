/* NEXUS — вид «Базы знаний»: RAG-наборы для одного или нескольких агентов.
 *
 * База = название + папки/файлы рабочей папки + список агентов.
 * Привязанные агенты ищут ТОЛЬКО в своих базах (инструмент rag_search
 * и автоконтекст скоупятся автоматически). Без привязок агент, как раньше,
 * видит всю рабочую папку.
 */

import {
  esc, icon, toast, confirmDialog, openModal, fmtInt, agentAvatar,
} from './ui.js';
import { store, getKb, saveKb, removeKb, searchKb, refreshRag } from './store.js';
import { t } from './i18n.js';

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  function filesOf(id) {
    const b = (store.rag && store.rag.bases || []).find((x) => x.id === id);
    return b ? b.files : null;
  }

  function agentChips(ids) {
    return (ids || []).map((id) => {
      const a = store.agents.find((x) => x.id === id);
      if (!a) return '';
      return `<span class="chip" style="--chip-c:var(--cyan)"><i></i>${esc(agentAvatar(a))} ${esc(a.name)}</span>`;
    }).join('') || `<span class="dim" style="font-size:12px">${t('kb.no_agents')}</span>`;
  }

  function cardHTML(b) {
    const n = filesOf(b.id);
    return `
      <article class="panel kb-card" data-kb="${esc(b.id)}">
        <header class="kb-head">
          <div>
            <div class="kicker">${t('kb.card_kicker')}</div>
            <h3>${esc(b.name)}</h3>
          </div>
          <span class="chip" style="--chip-c:var(--violet)"><i></i>${n === null ? '…' : esc(t('kb.files_n', { n: fmtInt(n) }))}</span>
        </header>
        ${b.description ? `<p class="kb-desc">${esc(b.description)}</p>` : ''}
        <div class="kb-paths">${(b.paths || []).map((p) => `<span class="chip" style="--chip-c:var(--blue)"><i></i>${esc(p)}</span>`).join('')}</div>
        <div class="kb-agents"><span class="dim" style="font-size:11.5px">${t('kb.agents_label')}</span> ${agentChips(b.agentIds)}</div>
        <div class="kb-test" hidden>
          <div class="field-row" style="margin-top:10px">
            <input class="input" data-test-q maxlength="300" placeholder="${esc(t('kb.test_ph'))}">
            <button class="btn btn-mini" data-test-go>${icon('search')}${t('kb.test_go')}</button>
          </div>
          <div class="kb-results" data-test-res></div>
        </div>
        <footer class="kb-foot">
          <button class="btn btn-mini btn-ghost" data-kb-test>${icon('search')}<span>${t('kb.test_go')}</span></button>
          <button class="btn btn-mini btn-ghost" data-kb-edit>${icon('pencil')}<span>${t('kb.edit')}</span></button>
          <button class="btn btn-mini btn-ghost danger" data-kb-del>${icon('trash')}<span>${t('kb.del')}</span></button>
        </footer>
      </article>`;
  }

  function render() {
    if (!page.isConnected) return;
    page.innerHTML = `
      <div class="sec-head" style="margin-top:0">
        <div>
          <div class="kicker">rag <span class="k-dim">/ ${t('kb.kicker_sub')}</span></div>
          <h2>${t('kb.title')}</h2>
        </div>
        <button class="btn btn-primary" id="kbAdd">${icon('plus')}<span>${t('kb.add')}</span></button>
      </div>
      <div class="banner" style="margin-bottom:14px">${icon('info')}<div>${t('kb.banner')}</div></div>
      ${store.kb.length ? `<div class="kb-grid">${store.kb.map(cardHTML).join('')}</div>` : `
        <div class="empty">
          <div class="empty-icon">${icon('database')}</div>
          <h3>${t('kb.empty_title')}</h3>
          <p>${t('kb.empty_text')}</p>
          <button class="btn btn-primary" id="kbAdd2">${icon('plus')}${t('kb.empty_cta')}</button>
        </div>`}`;
    page.querySelector('#kbAdd')?.addEventListener('click', () => kbModal(null));
    page.querySelector('#kbAdd2')?.addEventListener('click', () => kbModal(null));
    wireCards();
  }

  function wireCards() {
    page.querySelectorAll('[data-kb]').forEach((card) => {
      const id = card.dataset.kb;
      const base = store.kb.find((x) => x.id === id);
      if (!base) return;
      card.querySelector('[data-kb-test]').addEventListener('click', () => {
        const box = card.querySelector('.kb-test');
        box.hidden = !box.hidden;
        if (!box.hidden) box.querySelector('[data-test-q]').focus();
      });
      card.querySelector('[data-test-go]').addEventListener('click', async () => {
        const q = (card.querySelector('[data-test-q]').value || '').trim();
        const box = card.querySelector('[data-test-res]');
        if (!q) return;
        box.innerHTML = `<div class="dim" style="font-size:12px">${t('kb.searching')}</div>`;
        try {
          const out = await searchKb(id, q);
          box.innerHTML = out.results.length
            ? out.results.map((r) => `<div class="kb-hit"><b class="mono">${esc(r.path)}</b><span class="mono dim"> · ${r.score}</span><p>${esc(r.text.slice(0, 280))}</p></div>`).join('')
            : `<div class="dim" style="font-size:12px">${t('kb.nothing')}</div>`;
        } catch (e) {
          box.innerHTML = `<div class="banner banner-err" style="margin:8px 0 0">${esc(e.message)}</div>`;
        }
      });
      card.querySelector('[data-kb-edit]').addEventListener('click', () => kbModal(base));
      card.querySelector('[data-kb-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: t('kb.del_kicker'),
          title: t('kb.del_title', { name: base.name }),
          text: t('kb.del_text'),
          okText: t('kb.del_ok'),
        });
        if (!ok) return;
        try {
          await removeKb(id);
          toast(t('kb.toast_deleted'), base.name, 'ok');
          render();
        } catch (e) {
          toast(t('kb.toast_del_fail'), e.message, 'err');
        }
      });
    });
  }

  /* Окно создания/редактирования: название, описание, пути, агенты */
  function kbModal(base) {
    const sel = new Set(base ? base.agentIds || [] : store.agents.filter((a) => a.status !== 'offline').map((a) => a.id));
    const m = openModal({
      kicker: base ? t('kb.modal_edit_kicker') : t('kb.modal_new_kicker'),
      title: base ? base.name : t('kb.modal_new_title'),
      body: `
        <div class="field"><label>${t('kb.f_name')}</label>
          <input class="input" id="kbName" maxlength="60" value="${esc(base ? base.name : '')}" placeholder="${esc(t('kb.f_name_ph'))}"></div>
        <div class="field" style="margin-top:12px"><label>${t('kb.f_desc')}</label>
          <input class="input" id="kbDesc" maxlength="280" value="${esc(base ? base.description || '' : '')}" placeholder="${esc(t('kb.f_desc_ph'))}"></div>
        <div class="field" style="margin-top:12px"><label>${t('kb.f_paths')}</label>
          <textarea class="textarea mono" id="kbPaths" rows="4" maxlength="2000" placeholder="${esc(t('kb.f_paths_ph'))}">${esc(base ? (base.paths || []).join('\n') : '')}</textarea>
          <span class="field-hint">${t('kb.f_paths_hint')}</span></div>
        <div class="field" style="margin-top:12px"><label>${t('kb.f_agents')}</label>
          <div class="perm-list" id="kbAgents">
            ${store.agents.map((a) => `
              <button class="toggle-chip" role="switch" aria-checked="${sel.has(a.id)}" data-aid="${esc(a.id)}"
                style="--t-c:var(--cyan)" ${a.status === 'offline' ? 'disabled' : ''}>${esc(agentAvatar(a))} ${esc(a.name)}</button>`).join('') || `<span class="dim">${t('kb.no_team_agents')}</span>`}
          </div>
          <span class="field-hint">${t('kb.f_agents_hint')}</span></div>
        <div id="kbRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>${t('kb.cancel')}</button>
               <button class="btn btn-primary" id="kbSave">${icon('check')}${t('kb.save')}</button>`,
    });
    m.modal.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.modal.querySelectorAll('[data-aid]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.aid;
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
        b.setAttribute('aria-checked', String(sel.has(id)));
      });
    });
    m.modal.querySelector('#kbSave').addEventListener('click', async () => {
      const btn = m.modal.querySelector('#kbSave');
      const resBox = m.modal.querySelector('#kbRes');
      const paths = (m.modal.querySelector('#kbPaths').value || '').split('\n').map((s) => s.trim()).filter(Boolean);
      btn.innerHTML = `<span class="spinner"></span>${t('kb.saving')}`;
      btn.style.pointerEvents = 'none';
      try {
        await saveKb({
          ...(base ? { id: base.id } : {}),
          name: (m.modal.querySelector('#kbName').value || '').trim(),
          description: (m.modal.querySelector('#kbDesc').value || '').trim(),
          paths,
          agentIds: [...sel],
        });
        toast(t('kb.toast_saved'), t('kb.toast_saved_text', { paths: paths.length, agents: sel.size }), 'ok');
        m.close();
        render();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}${t('kb.save')}`;
        btn.style.pointerEvents = '';
      }
    });
  }

  getKb().then(render);
  refreshRag().then(() => { if (page.isConnected) render(); });
  render();
  return () => {};
}
