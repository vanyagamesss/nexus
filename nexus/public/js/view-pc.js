/* NEXUS — вид «Управление ПК»: экран, программы, процессы, буфер, терминал, ввод.
 * Все действия — вживую на этом компьютере. Опасное (kill, ввод, команды)
 * только в режиме «полный доступ», сервер перепроверяет каждое действие.
 */

import { esc, icon, toast, confirmDialog, fmtDateTime } from './ui.js';
import { t } from './i18n.js';
import { api } from './api.js';
import { store, bus } from './store.js';

export function mount(container) {
  const page = document.createElement('div');
  page.className = 'page';
  container.appendChild(page);

  let mode = 'readonly';
  let procs = [];
  let procFilter = '';
  let shotPath = null;
  let shotMeta = '';
  let screen = null;
  let timer = 0;

  const isFull = () => mode === 'full';
  const dis = () => (isFull() ? '' : 'disabled');

  function fmtMem(mb) {
    if (mb == null) return '—';
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ${t('pc.unit_gb')}` : `${mb} ${t('pc.unit_mb')}`;
  }

  function render() {
    if (!page.isConnected) return;
    page.innerHTML = `
      <div class="sec-head" style="margin-top:0">
        <div>
          <div class="kicker">pc <span class="k-dim">/ live</span></div>
          <h2>${esc(t('pc.title'))}</h2>
        </div>
        <span class="badge ${isFull() ? 'badge-ok' : 'badge-off'}"><i></i>${esc(isFull() ? t('pc.mode_full') : t('pc.mode_ro'))}</span>
      </div>
      <p class="muted" style="margin:0 0 14px">${esc(t('pc.sub'))}</p>
      ${isFull() ? '' : `<div class="banner banner-warn" style="margin-bottom:14px">${icon('alert')}<div>${esc(t('pc.need_full'))} <a href="#/connect">${esc(t('pc.go_access'))}</a></div></div>`}

      <div class="pc-grid">
        <section class="panel pc-card" aria-label="${esc(t('pc.screen_h'))}">
          <h3>${icon('appWindow')}${esc(t('pc.screen_h'))}</h3>
          <div class="pc-shot-wrap" id="shotWrap">
            <div class="empty" style="padding:18px"><p>${esc(t('pc.shot_empty'))}</p></div>
          </div>
          <div class="pc-row">
            <button class="btn btn-primary" id="shotBtn" ${dis()}>${icon('scan')}<span>${esc(t('pc.shot_take'))}</span></button>
            <span class="mono dim" id="screenSize">${esc(t('pc.screen_unknown'))}</span>
          </div>
        </section>

        <section class="panel pc-card" aria-label="${esc(t('pc.launch_h'))}">
          <h3>${icon('play')}${esc(t('pc.launch_h'))}</h3>
          <div class="pc-launch" id="launchBox"></div>
        </section>

        <section class="panel pc-card pc-wide" aria-label="${esc(t('pc.proc_h'))}">
          <div class="pc-head">
            <h3>${icon('activity')}${esc(t('pc.proc_h'))} <span class="mono dim" id="procCount"></span></h3>
            <div class="pc-row">
              <input class="input" id="procFilter" maxlength="60" placeholder="${esc(t('pc.proc_search_ph'))}" aria-label="${esc(t('pc.proc_search_ph'))}">
              <button class="btn btn-ghost" id="procReload" ${dis()}>${icon('refresh')}<span>${esc(t('pc.proc_refresh'))}</span></button>
            </div>
          </div>
          <div class="proc-wrap"><table class="proc-table">
            <thead><tr>
              <th>${esc(t('pc.proc_th_name'))}</th><th>PID</th><th>CPU</th>
              <th>${esc(t('pc.proc_th_mem'))}</th><th>${esc(t('pc.proc_th_started'))}</th><th></th>
            </tr></thead>
            <tbody id="procBody"></tbody>
          </table></div>
        </section>

        <section class="panel pc-card" aria-label="${esc(t('pc.clip_h'))}">
          <h3>${icon('clipboard')}${esc(t('pc.clip_h'))}</h3>
          <textarea class="textarea mono" id="clipText" rows="4" placeholder="${esc(t('pc.clip_ph'))}"></textarea>
          <div class="pc-row">
            <button class="btn btn-ghost" id="clipRead" ${dis()}>${esc(t('pc.clip_read'))}</button>
            <button class="btn btn-primary" id="clipWrite" ${dis()}>${esc(t('pc.clip_write'))}</button>
          </div>
        </section>

        <section class="panel pc-card" aria-label="${esc(t('pc.term_h'))}">
          <h3>${icon('terminal')}${esc(t('pc.term_h'))}</h3>
          <div class="pc-row">
            <input class="input mono" id="cmdInput" maxlength="2000" placeholder="${esc(t('pc.term_ph'))}" aria-label="${esc(t('pc.term_ph'))}" ${dis()}>
            <button class="btn btn-primary" id="cmdRun" ${dis()}>${esc(t('pc.term_run'))}</button>
          </div>
          <pre class="term-out mono" id="cmdOut">${esc(t('pc.term_empty'))}</pre>
        </section>

        <section class="panel pc-card pc-wide" aria-label="${esc(t('pc.input_h'))}">
          <h3>${icon('zap')}${esc(t('pc.input_h'))}</h3>
          <p class="muted" style="font-size:12.5px;margin:0 0 10px">${esc(t('pc.input_hint'))}</p>
          <div class="pc-row">
            <input class="input" id="inText" maxlength="300" placeholder="${esc(t('pc.input_text_ph'))}" aria-label="${esc(t('pc.input_text_ph'))}" ${dis()}>
            <button class="btn btn-ghost" id="inType" ${dis()}>${esc(t('pc.input_type'))}</button>
          </div>
          <div class="pc-row">
            <input class="input mono" id="inKeys" maxlength="60" placeholder="${esc(t('pc.input_keys_ph'))}" aria-label="${esc(t('pc.input_keys_ph'))}" ${dis()}>
            <button class="btn btn-ghost" id="inPress" ${dis()}>${esc(t('pc.input_press'))}</button>
          </div>
          <div class="pc-row">
            <input class="input mono" id="inX" inputmode="numeric" placeholder="X" aria-label="X" ${dis()}>
            <input class="input mono" id="inY" inputmode="numeric" placeholder="Y" aria-label="Y" ${dis()}>
            <button class="btn btn-ghost" data-mclick="click" ${dis()}>${esc(t('pc.input_click'))}</button>
            <button class="btn btn-ghost" data-mclick="move" ${dis()}>${esc(t('pc.input_move'))}</button>
            <button class="btn btn-ghost" data-mclick="right" ${dis()}>${esc(t('pc.input_right'))}</button>
          </div>
        </section>
      </div>`;
    wire();
    updateLaunch();
  }

  /* ---------------------------------------------------------- программы */

  function updateLaunch() {
    const box = page.querySelector('#launchBox');
    if (!box) return;
    const runnable = (store.programs || []).filter((p) => p.perms && p.perms.run && !p.missing);
    box.innerHTML = runnable.length ? runnable.map((p) => `
      <button class="btn btn-ghost pc-app" data-launch="${esc(p.id)}" ${isFull() ? '' : 'disabled'}>${icon('play')}<span>${esc(p.name)}</span></button>
    `).join('') : `<div class="empty" style="padding:14px"><p>${esc(t('pc.launch_empty'))}</p></div>`;
    box.querySelectorAll('[data-launch]').forEach((b) => {
      b.addEventListener('click', async () => {
        const p = (store.programs || []).find((x) => x.id === b.dataset.launch);
        if (!p) return;
        b.disabled = true;
        try {
          const out = await api(`/api/programs/${encodeURIComponent(p.id)}/open`, { method: 'POST', body: {} });
          toast(t('pc.launched'), `${out.name} · pid ${out.pid || '—'}`, 'ok');
        } catch (e) {
          toast(t('pc.launch_fail'), e.message, 'err');
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  /* ---------------------------------------------------------- процессы */

  function procRows() {
    const q = procFilter.trim().toLowerCase();
    const list = procs.filter((p) => !q || String(p.name || '').toLowerCase().includes(q) || String(p.pid) === q);
    const body = page.querySelector('#procBody');
    const count = page.querySelector('#procCount');
    if (!body) return;
    if (count) count.textContent = `· ${procs.length}`;
    body.innerHTML = list.length ? list.map((p) => `
      <tr data-pid="${p.pid}">
        <td><b>${esc(p.name)}</b>${p.title ? `<span class="dim"> · ${esc(p.title)}</span>` : ''}</td>
        <td class="mono">${p.pid}</td>
        <td class="mono">${p.cpu == null ? '—' : p.cpu}</td>
        <td class="mono">${fmtMem(p.memMb)}</td>
        <td class="mono dim">${p.started ? esc(fmtDateTime(p.started)) : '—'}</td>
        <td class="proc-act">${p.protected
          ? `<span class="chip" style="--chip-c:var(--text-3)"><i></i>${esc(t('pc.proc_sys'))}</span>`
          : `<button class="btn btn-mini btn-ghost danger" data-kill="${p.pid}" ${dis()}>${esc(t('pc.proc_kill'))}</button>`}</td>
      </tr>`).join('')
      : `<tr><td colspan="6" class="dim" style="text-align:center;padding:16px">${esc(t('pc.proc_empty'))}</td></tr>`;
    body.querySelectorAll('[data-kill]').forEach((b) => {
      b.addEventListener('click', async () => {
        const pid = Number(b.dataset.kill);
        const p = procs.find((x) => x.pid === pid);
        const ok = await confirmDialog({
          kicker: 'pc',
          title: t('pc.kill_title'),
          text: t('pc.kill_text', { name: (p && p.name) || '?', pid }),
          okText: t('pc.kill_ok'),
        });
        if (!ok) return;
        try {
          const out = await api('/api/pc/process-kill', { method: 'POST', body: { pid } });
          toast(t('pc.killed'), `${out.name} · pid ${out.pid}`, 'ok');
          await loadProcs();
        } catch (e) {
          toast(t('pc.kill_fail'), e.message, 'err');
        }
      });
    });
  }

  async function loadProcs(silent) {
    if (!isFull()) return;
    try {
      const out = await api('/api/pc/processes');
      procs = Array.isArray(out.items) ? out.items : [];
      procRows();
    } catch (e) {
      if (!silent) toast(t('pc.proc_load_fail'), e.message, 'err');
    }
  }

  /* ---------------------------------------------------------- wiring */

  function wire() {
    page.querySelector('#procFilter').addEventListener('input', (e) => {
      procFilter = e.target.value;
      procRows();
    });
    page.querySelector('#procReload').addEventListener('click', () => loadProcs());

    page.querySelector('#shotBtn').addEventListener('click', async () => {
      const btn = page.querySelector('#shotBtn');
      const wrap = page.querySelector('#shotWrap');
      btn.disabled = true;
      try {
        const out = await api('/api/pc/screenshot', { method: 'POST', body: {} });
        shotPath = out.path;
        shotMeta = `${out.size || ''} · ${out.at ? new Date(out.at).toLocaleTimeString() : ''}`;
        wrap.innerHTML = `<a href="/api/files?path=${encodeURIComponent(shotPath)}" target="_blank" rel="noopener"><img class="pc-shot" src="/api/files?path=${encodeURIComponent(shotPath)}&t=${Date.now()}" alt="screenshot"></a>`;
        const sz = page.querySelector('#screenSize');
        if (sz && screen) sz.textContent = t('pc.screen_size', { w: screen.width, h: screen.height });
      } catch (e) {
        wrap.innerHTML = `<div class="banner banner-err" style="margin:0">${esc(t('pc.shot_fail'))}: ${esc(e.message)}</div>`;
      } finally {
        btn.disabled = !isFull();
      }
    });

    page.querySelector('#clipRead').addEventListener('click', async () => {
      try {
        const out = await api('/api/pc/clipboard');
        page.querySelector('#clipText').value = out.text || '';
      } catch (e) {
        toast(t('pc.clip_read_fail'), e.message, 'err');
      }
    });
    page.querySelector('#clipWrite').addEventListener('click', async () => {
      const text = page.querySelector('#clipText').value || '';
      if (!text.trim()) return;
      try {
        await api('/api/pc/clipboard', { method: 'POST', body: { text: text.slice(0, 4000) } });
        toast(t('pc.clip_wrote'), '', 'ok');
      } catch (e) {
        toast(t('pc.clip_write_fail'), e.message, 'err');
      }
    });

    const cmdInput = page.querySelector('#cmdInput');
    const cmdOut = page.querySelector('#cmdOut');
    const cmdRun = page.querySelector('#cmdRun');
    const runCmd = async () => {
      const command = (cmdInput.value || '').trim();
      if (!command) return;
      cmdRun.disabled = true;
      cmdOut.textContent = '…';
      try {
        const out = await api('/api/pc/command', { method: 'POST', body: { command: command.slice(0, 2000) } });
        const head = t('pc.term_exit', { code: out.exitCode ?? '?', ms: out.ms ?? 0 });
        cmdOut.textContent = `$ ${command}\n[${head}]\n${out.stdout || ''}${out.stderr ? `\n--- stderr ---\n${out.stderr}` : ''}${out.error ? `\n! ${out.error}` : ''}`.slice(0, 12000);
      } catch (e) {
        cmdOut.textContent = `${t('pc.term_fail')}: ${e.message}`;
      } finally {
        cmdRun.disabled = !isFull();
      }
    };
    cmdRun.addEventListener('click', runCmd);
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCmd(); }
    });

    const doInput = async (payload) => {
      try {
        await api('/api/pc/input', { method: 'POST', body: payload });
        toast(t('pc.input_done'), '', 'ok');
      } catch (e) {
        toast(t('pc.input_fail'), e.message, 'err');
      }
    };
    page.querySelector('#inType').addEventListener('click', () => {
      const v = page.querySelector('#inText').value || '';
      if (v.trim()) doInput({ kind: 'text', text: v.slice(0, 300) });
    });
    page.querySelector('#inPress').addEventListener('click', () => {
      const v = page.querySelector('#inKeys').value || '';
      if (v.trim()) doInput({ kind: 'key', keys: v.slice(0, 60) });
    });
    page.querySelectorAll('[data-mclick]').forEach((b) => {
      b.addEventListener('click', () => {
        const x = Number(page.querySelector('#inX').value);
        const y = Number(page.querySelector('#inY').value);
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
          toast(t('pc.input_fail'), 'X/Y', 'err');
          return;
        }
        doInput({ kind: 'mouse', action: b.dataset.mclick, x, y });
      });
    });
  }

  async function loadInfo() {
    try {
      const out = await api('/api/pc/info');
      if (out.screen) {
        screen = out.screen;
        const sz = page.querySelector('#screenSize');
        if (sz) sz.textContent = t('pc.screen_size', { w: screen.width, h: screen.height });
      }
    } catch { /* readonly — секция и так отключена */ }
  }

  async function loadClip() {
    if (!isFull()) return;
    try {
      const out = await api('/api/pc/clipboard');
      const ta = page.querySelector('#clipText');
      if (ta && !ta.value) ta.value = out.text || '';
    } catch { /* пустой буфер — не ошибка */ }
  }

  const onPrograms = () => { if (page.isConnected) updateLaunch(); };
  bus.addEventListener('programs', onPrograms);

  (async () => {
    try {
      const a = await api('/api/access');
      mode = ((a || {}).access || {}).mode || 'readonly';
    } catch { mode = 'readonly'; }
    render();
    await Promise.allSettled([loadInfo(), loadProcs(), loadClip()]);
    timer = setInterval(() => {
      if (!document.hidden && page.isConnected) loadProcs(true);
    }, 15000);
  })();

  return () => {
    clearInterval(timer);
    bus.removeEventListener('programs', onPrograms);
  };
}
