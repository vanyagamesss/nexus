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
    }).join('') || '<span class="dim" style="font-size:12px">пока никому — агент увидит всю папку</span>';
  }

  function cardHTML(b) {
    const n = filesOf(b.id);
    return `
      <article class="panel kb-card" data-kb="${esc(b.id)}">
        <header class="kb-head">
          <div>
            <div class="kicker">база знаний</div>
            <h3>${esc(b.name)}</h3>
          </div>
          <span class="chip" style="--chip-c:var(--violet)"><i></i>${n === null ? '…' : `${fmtInt(n)} файлов`}</span>
        </header>
        ${b.description ? `<p class="kb-desc">${esc(b.description)}</p>` : ''}
        <div class="kb-paths">${(b.paths || []).map((p) => `<span class="chip" style="--chip-c:var(--blue)"><i></i>${esc(p)}</span>`).join('')}</div>
        <div class="kb-agents"><span class="dim" style="font-size:11.5px">агенты:</span> ${agentChips(b.agentIds)}</div>
        <div class="kb-test" hidden>
          <div class="field-row" style="margin-top:10px">
            <input class="input" data-test-q maxlength="300" placeholder="Проверочный вопрос базе…">
            <button class="btn btn-mini" data-test-go>${icon('search')}Проверить</button>
          </div>
          <div class="kb-results" data-test-res></div>
        </div>
        <footer class="kb-foot">
          <button class="btn btn-mini btn-ghost" data-kb-test>${icon('search')}<span>Проверить</span></button>
          <button class="btn btn-mini btn-ghost" data-kb-edit>${icon('pencil')}<span>Изменить</span></button>
          <button class="btn btn-mini btn-ghost danger" data-kb-del>${icon('trash')}<span>Удалить</span></button>
        </footer>
      </article>`;
  }

  function render() {
    if (!page.isConnected) return;
    page.innerHTML = `
      <div class="sec-head" style="margin-top:0">
        <div>
          <div class="kicker">rag <span class="k-dim">/ знания команды</span></div>
          <h2>Базы знаний</h2>
        </div>
        <button class="btn btn-primary" id="kbAdd">${icon('plus')}<span>Новая база</span></button>
      </div>
      <div class="banner" style="margin-bottom:14px">${icon('info')}<div>База — это папки и файлы рабочей папки <b>плюс список агентов</b>. Привязанные агенты ищут только в своих базах (<span class="mono">rag_search</span> + автоконтекст), остальные видят всю папку как раньше. Пути — относительно рабочей папки команды, например <span class="mono">notes/</span> или <span class="mono">docs/guide.md</span>.</div></div>
      ${store.kb.length ? `<div class="kb-grid">${store.kb.map(cardHTML).join('')}</div>` : `
        <div class="empty">
          <div class="empty-icon">${icon('database')}</div>
          <h3>Баз пока нет</h3>
          <p>Создайте первую: укажите папки с документами и выберите агентов — хоть одного, хоть всю команду.</p>
          <button class="btn btn-primary" id="kbAdd2">${icon('plus')}Создать базу</button>
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
        const t = card.querySelector('.kb-test');
        t.hidden = !t.hidden;
        if (!t.hidden) t.querySelector('[data-test-q]').focus();
      });
      card.querySelector('[data-test-go]').addEventListener('click', async () => {
        const q = (card.querySelector('[data-test-q]').value || '').trim();
        const box = card.querySelector('[data-test-res]');
        if (!q) return;
        box.innerHTML = '<div class="dim" style="font-size:12px">Ищу…</div>';
        try {
          const out = await searchKb(id, q);
          box.innerHTML = out.results.length
            ? out.results.map((r) => `<div class="kb-hit"><b class="mono">${esc(r.path)}</b><span class="mono dim"> · ${r.score}</span><p>${esc(r.text.slice(0, 280))}</p></div>`).join('')
            : '<div class="dim" style="font-size:12px">Ничего похожего в базе нет.</div>';
        } catch (e) {
          box.innerHTML = `<div class="banner banner-err" style="margin:8px 0 0">${esc(e.message)}</div>`;
        }
      });
      card.querySelector('[data-kb-edit]').addEventListener('click', () => kbModal(base));
      card.querySelector('[data-kb-del]').addEventListener('click', async () => {
        const ok = await confirmDialog({
          kicker: 'удаление базы',
          title: `Удалить «${base.name}»?`,
          text: 'Файлы на диске останутся. Привязки у агентов снимутся, они снова увидят всю папку.',
          okText: 'Удалить базу',
        });
        if (!ok) return;
        try {
          await removeKb(id);
          toast('База удалена', base.name, 'ok');
          render();
        } catch (e) {
          toast('Не удалилось', e.message, 'err');
        }
      });
    });
  }

  /* Окно создания/редактирования: название, описание, пути, агенты */
  function kbModal(base) {
    const sel = new Set(base ? base.agentIds || [] : store.agents.filter((a) => a.status !== 'offline').map((a) => a.id));
    const m = openModal({
      kicker: base ? 'редактирование базы' : 'новая база',
      title: base ? base.name : 'База знаний',
      body: `
        <div class="field"><label>название</label>
          <input class="input" id="kbName" maxlength="60" value="${esc(base ? base.name : '')}" placeholder="например: Документация продукта"></div>
        <div class="field" style="margin-top:12px"><label>описание</label>
          <input class="input" id="kbDesc" maxlength="280" value="${esc(base ? base.description || '' : '')}" placeholder="что лежит внутри (необязательно)"></div>
        <div class="field" style="margin-top:12px"><label>папки и файлы (каждый с новой строки)</label>
          <textarea class="textarea mono" id="kbPaths" rows="4" maxlength="2000" placeholder="notes/&#10;docs/guide.md">${esc(base ? (base.paths || []).join('\n') : '')}</textarea>
          <span class="field-hint">Относительно рабочей папки команды. Несуществующие пути просто дадут ноль файлов.</span></div>
        <div class="field" style="margin-top:12px"><label>агенты (можно нескольких)</label>
          <div class="perm-list" id="kbAgents">
            ${store.agents.map((a) => `
              <button class="toggle-chip" role="switch" aria-checked="${sel.has(a.id)}" data-aid="${esc(a.id)}"
                style="--t-c:var(--cyan)" ${a.status === 'offline' ? 'disabled' : ''}>${esc(agentAvatar(a))} ${esc(a.name)}</button>`).join('') || '<span class="dim">В команде нет агентов</span>'}
          </div>
          <span class="field-hint">Пустой список = база ни к кому не привязана (лежит про запас).</span></div>
        <div id="kbRes"></div>`,
      footer: `<button class="btn btn-ghost" data-cancel>Отмена</button>
               <button class="btn btn-primary" id="kbSave">${icon('check')}Сохранить</button>`,
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
      btn.innerHTML = '<span class="spinner"></span>Сохраняем';
      btn.style.pointerEvents = 'none';
      try {
        await saveKb({
          ...(base ? { id: base.id } : {}),
          name: (m.modal.querySelector('#kbName').value || '').trim(),
          description: (m.modal.querySelector('#kbDesc').value || '').trim(),
          paths,
          agentIds: [...sel],
        });
        toast('База сохранена', `${paths.length} путей · ${sel.size} агентов`, 'ok');
        m.close();
        render();
      } catch (e) {
        resBox.innerHTML = `<div class="banner banner-err" style="margin:12px 0 0">${esc(e.message)}</div>`;
        btn.innerHTML = `${icon('check')}Сохранить`;
        btn.style.pointerEvents = '';
      }
    });
  }

  getKb().then(render);
  refreshRag().then(() => { if (page.isConnected) render(); });
  render();
  return () => {};
}
