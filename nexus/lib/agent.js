'use strict';

/**
 * Реальный рантайм агента.
 *
 * Цикл выполнения (обычный agent loop, как в OpenAI/Anthropic SDK):
 *   1. собрать системный промпт из роли, режима доступа и доступных инструментов;
 *   2. вызвать LLM-провайдера со стримингом;
 *   3. если модель вернула вызовы инструментов — выполнить их по-настоящему
 *      (файлы/программы/сеть) или через MCP-сервер, подставить результаты и повторить;
 *   4. повторять до финального текста или исчерпания бюджета шагов.
 *
 * Все числа в статистике — реальные: usage приходит от провайдера, длительность
 * замеряется, стоимость считается по прайсу модели.
 */

const providers = require('./providers');
const tools = require('./tools');
const mcp = require('./mcp');
const metrics = require('./metrics');
const auth = require('./auth');
const integrations = require('./integrations');
const store = require('./store');

const MAX_STEPS = 12;
const MAX_HISTORY_CHARS = 8000;

function systemPromptFor(agent, ctx) {
  const perms = agent.permissions || { services: [], programs: [], mcp: [] };
  const lines = [];

  lines.push(agent.systemPrompt && agent.systemPrompt.trim()
    ? agent.systemPrompt.trim()
    : `Ты — ${agent.role}. Выполняй задачи команды точно и по делу, отвечай на русском языке.`);

  lines.push('');
  lines.push(`Твоя роль в команде: ${agent.role}. Текущая задача поставлена оператором.`);
  lines.push(`Режим доступа к ПК: ${ctx.mode === 'full' ? 'ПОЛНЫЙ (можно писать файлы, запускать программы, делать HTTP-запросы)' : 'ТОЛЬКО ЧТЕНИЕ (можно только читать файлы и просматривать папки)'}.`);
  lines.push(`Рабочая папка (корень всех файловых операций): ${ctx.root}`);
  lines.push(`Подключённые сервисы: ${perms.services.length ? perms.services.join(', ') : 'нет'}.`);
  lines.push(`Подключённые программы ПК: ${perms.programs.length ? perms.programs.join(', ') : 'нет'}.`);
  lines.push(`MCP-серверы: ${perms.mcp.length ? perms.mcp.join(', ') : 'нет'}.`);

  if (ctx.mode !== 'full') {
    lines.push('');
    lines.push('ВАЖНО: ты не можешь изменять файлы и запускать программы. Если задача требует изменения — опиши, что нужно сделать, и укажи это в ответе.');
  } else {
    lines.push('');
    lines.push('Код, тексты, таблицы и скрипты — создавай ФАЙЛАМИ через write_file (папки создаются сами), а в ответе давай краткую сводку и путь к файлу. Длинные листинги в чат не вываливай.');
    lines.push('Актуальные данные из интернета (цены, товары, документация) — ищи через web_search, подробности страниц читай через http_request.');
  }

  if (ctx.mode === 'full' && perms.input === true) {
    lines.push('');
    lines.push('ВВОД С КЛАВИАТУРЫ И МЫШИ ВКЛЮЧЁН — ты реально управляешь этим ПК:');
    lines.push('1) input_screen — узнай размер экрана, без него координаты не вычисляй;');
    lines.push('2) run_program — открой нужную программу (браузер, Photoshop, Blender) и дождись окна следующим шагом;');
    lines.push('3) input_mouse move/click — наводи и кликай, input_text — печатай короткими кусками, input_key — ENTER, TAB, ctrl+s и т.п.;');
    lines.push('4) после КАЖДОГО действия смотри результат следующим шагом и только потом действуй дальше — не кликай вслепую серией.');
    lines.push('5) процессы: pc_processes — кто запущен (pid, память, CPU); pc_process_kill — завершить по pid (системные заблокированы). Сначала смотри screenshot, потом действуй.');
    lines.push('СВОЙ БРАУЗЕР (видимое окно Chrome): browser_open — открыть сайт; browser_snapshot — текст и элементы с номерами ref; browser_click — клик по ref; browser_type — ввести текст в поле (submit=true — нажать Enter); browser_back — назад. Так заполняются формы и регистрации: открой, сними слепок, введи, кликни. Капчу, SMS и 2FA пройти нельзя — честно скажи об этом.');
  }

  lines.push('');
  lines.push('Если для решения задачи нужен доступ к данным — используй инструменты. Не выдумывай содержимое файлов и результаты вызовов.');
  lines.push('Приложенные к задаче изображения ты видишь прямо в сообщении (vision) — описывай и анализируй их содержимое, а не имя файла.');
  lines.push('База знаний проекта: инструмент rag_search ищет похожие куски файлов рабочей папки — спрашивай его, прежде чем отвечать о содержимом проекта. Перед ответом тебе уже подложат самые похожие куски.');
  return lines.join('\n');
}

function priceOf(cfg, entry, model) {
  const base = providers.getProvider(entry.providerId);
  const custom = base.models.find((m) => m.id === model);
  if (custom) return { in: custom.in, out: custom.out };
  const found = providers.PROVIDERS.flatMap((p) => p.models).find((m) => m.id === model);
  return found ? { in: found.in, out: found.out } : { in: 0, out: 0 };
}

function computeCost(cfg, entry, model, usage) {
  const price = priceOf(cfg, entry, model);
  if (!price.in && !price.out) return 0;
  const usd = ((usage.promptTokens || 0) * price.in + (usage.completionTokens || 0) * price.out) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

function clip(text, n = MAX_HISTORY_CHARS) {
  const s = typeof text === 'string' ? text : '';
  return s.length > n ? `${s.slice(0, n)}\n…[обрезано]` : s;
}

/**
 * Выполнить задачу агента.
 * emit(event) — {type:'line'|'delta'|'step'|'tool'|'done'|'error', ...}
 * Возвращает сводку прогона.
 */
async function run({ agent, task, emit, signal, attachments }) {
  const cfg = auth.config();
  const mode = cfg.access.mode === 'full' ? 'full' : 'readonly';
  const team = store.read('team.json', { team: {}, agents: [] });
  /* Рабочая папка: сначала своя у команды, потом общая из доступа, потом корень данных */
  const teamRoot = team.team && typeof team.team.workspace === 'string' && team.team.workspace.trim()
    ? team.team.workspace.trim()
    : '';
  const root = teamRoot || cfg.access.workspace || store.DATA_DIR.replace(/[\\/]data$/, '') || process.cwd();
  const programs = store.read('programs.json', []);
  const mcpList = store.read('mcp.json', []);

  const entry = resolveProviderEntry(agent);
  if (!entry) {
    const err = new Error('Ни один провайдер не настроен. Откройте Подключения → Модели и добавьте ключ или укажите локальный Ollama.');
    err.status = 400;
    throw err;
  }
  const model = agent.model && isKnownModel(agent.model, entry) ? agent.model : firstModel(entry);
  const pcfg = providers.buildConfig(entry, model);

  const ctx = { root, mode, programs, agent };

  /* Базы знаний агента: если привязаны — ищем только в них, иначе по всей папке */
  let kbRoots = null;
  let kbNames = [];
  try {
    const allKb = store.read('kb.json', []);
    const mine = (Array.isArray(allKb) ? allKb : []).filter((b) => ((agent.permissions && agent.permissions.kb) || []).includes(b.id));
    if (mine.length) {
      kbRoots = mine.flatMap((b) => b.paths || []).slice(0, 40);
      kbNames = mine.map((b) => b.name);
      if (!kbRoots.length) kbRoots = null;
    }
  } catch { /* без баз — как раньше, по всей папке */ }
  ctx.kbRoots = kbRoots;
  const startedAt = Date.now();
  let ttft = 0;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const toolLog = [];
  let steps = 0;
  let toolCalls = 0;
  let fullText = '';

  emit({ type: 'line', level: 'info', text: `задача: ${task}` });
  emit({ type: 'line', level: 'info', text: `провайдер: ${pcfg.providerName} · модель: ${model} · режим ПК: ${mode === 'full' ? 'полный' : 'только чтение'}` });
  emit({ type: 'line', level: 'info', text: `рабочая папка: ${root}` });

  const nativeSchemas = tools.toolSchemas(mode, agent, programs);
  const mcpEntries = mcpList.filter((m) => agent.permissions.mcp.includes(m.id));
  const mcpSchemas = await buildMcpSchemas(mcpEntries);

  /* Интеграции: только реально подключённые и разрешённые агенту */
  const svcList = store.read('services.json', []);
  const allowedSvcs = (agent.permissions.services || []).filter((sid) => {
    const s = svcList.find((x) => x.id === sid);
    return s && s.lastCheckOk === true && integrations.get(s.integrationId || s.id);
  });
  const svcSchemas = integrations.toolSchemas(
    allowedSvcs.map((sid) => {
      const s = svcList.find((x) => x.id === sid);
      return s.integrationId || s.id;
    }),
    mode,
  );

  const allTools = nativeSchemas.concat(svcSchemas, mcpSchemas)
    .filter((s) => s && s.function && typeof s.function.name === 'string' && s.function.name);

  const inputCount = nativeSchemas.filter((s) => s && s.function && typeof s.function.name === 'string' && (s.function.name.startsWith('input_') || s.function.name.startsWith('browser_'))).length;
  emit({
    type: 'line',
    level: 'ok',
    text: `инструменты: ${nativeSchemas.length - inputCount} системных${inputCount ? ` + ${inputCount} управления ПК (ввод, свой браузер)` : ''}${svcSchemas.length ? ` + ${svcSchemas.length} сервисных` : ''}${mcpSchemas.length ? ` + ${mcpSchemas.length} MCP` : ''}`,
  });

  const messages = [
    { role: 'system', content: systemPromptFor(agent, ctx) },
  ];

  /* RAG-автоконтекст: топ-чанки базы знаний сразу в промпт, чтобы агент
     отвечал по файлам, а не выдумывал. Тихо пропускаем при пустой папке. */
  try {
    const rag = require('./rag');
    const found = await rag.search(root, task, 4, kbRoots);
    if (found && found.ok && found.results && found.results.length) {
      const ctxText = found.results
        .map((r, i) => `[${i + 1}] ${r.path}:\n${r.text}`)
        .join('\n\n')
        .slice(0, 4000);
      messages.push({
        role: 'system',
        content: `${kbNames.length ? `Контекст из твоих баз знаний (${kbNames.join(', ')})` : 'Контекст из файлов рабочей папки'} (похожие куски, свежее на момент задачи):\n${ctxText}`,
      });
      emit({ type: 'line', level: 'info', text: `база знаний${kbNames.length ? ` «${kbNames.join(', ')}»` : ''}: ${found.results.length} кусков из ${found.files} файлов` });
    }
  } catch { /* RAG не обязателен — агент справится инструментами */ }

  messages.push({ role: 'user', content: taskContract(task) });

  /* Vision: картинки из вложений кладем прямо в первое сообщение пользователя.
     Читаем из рабочей папки (jail), до 3 штук по 4 МБ — иначе только упоминаем. */
  const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
  const visionImages = [];
  const visionSkipped = [];
  for (const rel of (Array.isArray(attachments) ? attachments : []).slice(0, 10)) {
    const r = tools.resolveInside(root, String(rel || ''));
    if (r.error) continue;
    const ext = require('path').extname(r.path).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    try {
      const st = require('fs').statSync(r.path);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) { visionSkipped.push(rel); continue; }
      if (visionImages.length >= 3) { visionSkipped.push(rel); continue; }
      visionImages.push({ mime, data: require('fs').readFileSync(r.path).toString('base64'), name: rel });
    } catch { visionSkipped.push(rel); }
  }
  if (visionImages.length) {
    messages[messages.length - 1].images = visionImages;
    emit({ type: 'line', level: 'info', text: `вложения: ${visionImages.length} изобр. (${visionImages.map((x) => x.name).join(', ')}) уходят модели вместе с задачей` });
  }
  if (visionSkipped.length) {
    messages.push({ role: 'system', content: `Не удалось показать модели изображения (слишком большие или лимит 3 шт.): ${visionSkipped.join(', ')}. Работай с ними как с файлами через read_file.` });
  }

  for (let step = 1; step <= MAX_STEPS; step++) {
    steps = step;
    emit({ type: 'step', step, of: MAX_STEPS });

    const queue = [];
    let assistantText = '';
    let pendingToolCalls = [];

    const onEvent = (ev) => {
      if (ev.type === 'delta') {
        assistantText += ev.text;
        fullText += ev.text;
        queue.push(ev);
        if (!ttft) ttft = Date.now() - startedAt;
      } else if (ev.type === 'tool') {
        pendingToolCalls = normalizeToolCalls(ev.calls, step);
      } else if (ev.type === 'usage') {
        usage.promptTokens = Math.max(usage.promptTokens, ev.usage.promptTokens || 0);
        usage.completionTokens = Math.max(usage.completionTokens, ev.usage.completionTokens || 0);
        usage.totalTokens = Math.max(usage.totalTokens, ev.usage.totalTokens || 0);
      }
    };

    try {
      await providers.stream(
        pcfg,
        {
          model,
          messages,
          temperature: Number(agent.temperature) || 0.3,
          max_tokens: 4096,
          tools: allTools.length ? allTools : undefined,
        },
        onEvent,
        signal,
      );
    } catch (e) {
      if (signal && signal.aborted) throw new Error('Выполнение остановлено оператором');
      throw new Error(`Ошибка провайдера: ${e.message}`);
    }

    for (const q of queue) emit(q);

    if (!pendingToolCalls.length) {
      emit({ type: 'line', level: 'ok', text: `ответ получен · ${usage.totalTokens} токенов · ${((Date.now() - startedAt) / 1000).toFixed(1)} с` });
      break;
    }

    messages.push({ role: 'assistant', content: assistantText, toolCalls: pendingToolCalls });

    for (const call of pendingToolCalls) {
      toolCalls++;
      const nativeName = call.name.startsWith('mcp__') ? call.name.slice(5).replaceAll('__', ':') : call.name;

      let result;
      if (call.name.startsWith('mcp__')) {
        const parts = nativeName.split(':');
        const serverName = parts[0];
        const toolName = parts.slice(1).join(':');
        const entryM = mcpEntries.find((m) => m.name === serverName || m.id === serverName);
        emit({ type: 'tool', name: nativeName, state: 'start', text: `MCP ${serverName} → ${toolName}()` });
        try {
          result = entryM
            ? await mcp.callTool(entryM, toolName, call.args)
            : { ok: false, error: `MCP-сервер «${serverName}» не подключён` };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
      } else {
        /* Инструмент внешнего сервиса: svc_<service>_<action> */
        const svcCall = integrations.parseToolName(call.name);
        if (svcCall) {
          const it = svcCall.integration;
          emit({ type: 'tool', name: call.name, state: 'start', text: `${it.name} → ${svcCall.action.label}` });
          result = await callService(svcCall, call.args, mode);
        } else {
          const argPreview = (() => {
            try {
              const s = typeof call.args === 'string' ? call.args : JSON.stringify(call.args || {});
              if (!s || s === '{}') return '';
              return s.length > 120 ? ` ${s.slice(0, 120)}…` : ` ${s}`;
            } catch { return ''; }
          })();
          emit({ type: 'tool', name: call.name, state: 'start', text: `инструмент ${call.name}${argPreview}` });
          result = await tools.execute(ctx, call.name, call.args);
        }
      }

      const entryLog = {
        t: Date.now(),
        tool: call.name,
        ok: !!result.ok,
        ms: result.ms,
        error: result.error || null,
        summary: summarizeResult(call.name, result),
      };
      toolLog.push(entryLog);
      emit({ type: 'tool', name: call.name, state: 'done', ok: !!result.ok, ms: result.ms, text: entryLog.summary });

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        /* base64 картинки в историю не пишем — она едет отдельным сообщением ниже */
        content: clip(JSON.stringify(result && result.image
          ? Object.assign({}, result, { image: `[картинка ${result.image.name || 'screenshot'} приложена отдельно]` })
          : result)),
      });
      /* Скриншот: картинка уходит модели в vision следующим сообщением */
      if (result && result.ok && result.image && result.image.data) {
        messages.push({
          role: 'user',
          content: `Скриншот экрана (${result.size || ''}), файл: ${result.path}. Смотри на него и действуй дальше по задаче.`,
          images: [{ mime: result.image.mime || 'image/jpeg', data: result.image.data }],
        });
        emit({ type: 'line', level: 'info', text: `скриншот ${result.path} показан модели` });
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const costUsd = computeCost(pcfg, entry, model, usage);

  return {
    text: fullText.trim(),
    usage,
    costUsd,
    durationMs,
    ttftMs: ttft,
    steps,
    toolCalls,
    toolLog,
    provider: pcfg.providerName,
    model,
    mode,
    root,
  };
}

/** Вызов операции внешнего сервиса от имени агента. */
async function callService(svcCall, args, mode) {
  const it = svcCall.integration;
  /* Один тип интеграции может быть настроен несколько раз — берём
     подключённый (connected) сервис, иначе первый подходящий. */
  const candidates = store.read('services.json', []).filter((s) => (s.integrationId || s.id) === it.id);
  const svc = candidates.find((s) => s.status === 'connected') || candidates[0];
  if (!svc) return { ok: false, error: `сервис «${it.name}» не настроен` };

  if (svcCall.action.write && mode !== 'full') {
    return { ok: false, error: `«${svcCall.action.label}» меняет данные — включите режим «полный доступ»` };
  }

  const secret = store.decrypt(svc.keyCipher || '');
  if (!secret && it.keyRequired !== false) return { ok: false, error: `у сервиса «${it.name}» не задан API-ключ` };

  const out = await integrations.runAction(it.id, svcCall.action.name, {
    apiKey: secret,
    url: svc.url || '',
    kind: it.authKind,
  }, args || {});
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, service: it.name, result: out.result };
}

function summarizeResult(name, r) {
  if (!r.ok) return `ошибка: ${r.error}`;
  if (r.service) return `${r.service}: ок`;
  switch (name) {
    case 'read_file':
      return `прочитано ${(r.content || '').length} симв. из ${r.path}${r.truncated ? ' (обрезано)' : ''}`;
    case 'write_file':
      return `${r.created ? 'создан' : 'перезаписан'} ${r.path} · ${r.bytes} Б`;
    case 'list_dir':
      return `${r.count} элементов в ${r.path}`;
    case 'search':
      return `${r.hits} совпадений в ${r.scannedFiles} файлах`;
    case 'stat':
      return `${r.type} · ${r.size} Б · ${r.path}`;
    case 'run_program':
      return `${r.program}: код ${r.exitCode}${r.timedOut ? ' (таймаут)' : ''}`;
    case 'http_request':
      return `${r.status} ${r.statusText || ''} · ${r.latencyMs} мс`;
    case 'system_info':
      return `${r.cpus} ядра · память ${(r.memory.used / 1024 ** 3).toFixed(1)} ГБ из ${(r.memory.total / 1024 ** 3).toFixed(1)} ГБ`;
    default:
      return r.text ? clip(r.text, 200).replace(/\n/g, ' ') : 'готово';
  }
}

/** Найти активную запись провайдера: экземпляр агента → дефолт → первая рабочая. */
function resolveProviderEntry(agent) {
  const conf = store.read('config.json', { providers: [] });
  const list = conf.providers || [];
  if (!list.length) return null;

  /* Точная привязка к конкретной настройке провайдера */
  if (agent.providerConfigId) {
    const exact = list.find((p) => p.id === agent.providerConfigId);
    if (exact && exact.enabled !== false) return exact;
  }
  /* Привязка к семейству провайдера (например, «openai») */
  if (agent.providerId) {
    const wanted = list.find((p) => p.providerId === agent.providerId);
    if (wanted && wanted.enabled !== false) return wanted;
  }
  const def = list.find((p) => p.isDefault);
  if (def) return def;
  return list.find((p) => p.enabled !== false) || list[0];
}

function isKnownModel(model, entry) {
  if (!model) return false;
  const base = providers.getProvider(entry.providerId);
  if (base.models.some((m) => m.id === model)) return true;
  if (entry.models && entry.models.includes(model)) return true;
  // неизвестная модель допустима, если у провайдера динамический каталог
  return !!base.dynamicModels;
}

function firstModel(entry) {
  const base = providers.getProvider(entry.providerId);
  return (entry.models && entry.models[0]) || (base.models[0] && base.models[0].id) || 'default';
}

async function buildMcpSchemas(entries) {
  const out = [];
  for (const entry of entries) {
    try {
      const rec = await mcp.handshake(entry);
      if (!rec.ready) continue;
      for (const t of rec.toolDefs) {
        out.push({
          __mcp: true,
          type: 'function',
          function: {
            name: `mcp__${entry.name.replace(/[^\w]/g, '_')}__${t.name.replace(/[^\w]/g, '_')}`,
            description: `[MCP ${entry.name}] ${t.description || t.name}`.slice(0, 500),
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    } catch {
      /* сервер недоступен — пропускаем */
    }
  }
  return out;
}

/**
 * Контракт задачи: модель обязана делать именно то, что просят, а не
 * подменять задачу своей. Без user-сообщения модель видела только роль
 * и разбредалась по посторонним темам.
 */
function taskContract(task) {
  return `ЗАДАЧА ОПЕРАТОРА — выполни именно её, не подменяй другой задачей:\n${task}\n---\nПравила: делай ровно то, что просят выше; файлы создавай инструментами, в ответ — только краткий итог и пути к файлам; в конце — результат, без воды и посторонних тем.`;
}

/**
 * Нормализация tool_call от модели. Некоторые модели (особенно бесплатные)
 * возвращают вызов без id или без имени. Пустой tool_call_id роняет следующий
 * запрос с 400, поэтому подставляем свой id — один и тот же для вызова
 * в assistant-сообщении и для tool-результата.
 */
function normalizeToolCalls(calls, step) {
  return (calls || [])
    .filter((c) => c && c.name && String(c.name).trim())
    .map((c, i) => ({
      name: String(c.name).trim(),
      args: c.args,
      id: c.id && String(c.id).trim()
        ? String(c.id)
        : `call_${Date.now().toString(36)}_${step}_${i}`,
    }));
}

module.exports = { run, resolveProviderEntry, computeCost, systemPromptFor, MAX_STEPS, normalizeToolCalls, taskContract };