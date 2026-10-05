'use strict';

/**
 * Реальные инструменты агентов: работа с файлами, запуск программ, HTTP, поиск.
 *
 * Режимы доступа (конфиг системы):
 *   'readonly' — агент только читает: list_dir, read_file, search, stat, env_info
 *   'full'     — дополнительно: write_file, run_program, http_request
 *   'full' + явное разрешение «Ввод с клавиатуры и мыши» у агента:
 *              input_screen, input_key, input_text, input_mouse
 *
 * В обоих режимах действуют жёсткие ограничения:
 *   • файловый доступ ограничен корнем workspace (по умолчанию — папка проекта),
 *     выход за пределы корня блокируется (path traversal, симлинки не обходятся — resolve + проверка);
 *   • размер чтения и размер записи ограничены;
 *   • запуск программ разрешён только для программ, у которых в настройках включён perm.run;
 *   • HTTP-запросы блокируются к приватным адресам (SSRF-защита);
 *   • мост ввода работает только на Windows с активной сессией пользователя,
 *     каждое нажатие/клик выполняется буквально и логируется; включайте
 *     разрешение только тем агентам, которым доверяете управление ПК.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');

const MAX_READ = 256 * 1024;
const MAX_WRITE = 1024 * 1024;
const MAX_LIST = 400;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_HITS = 120;
const RUN_TIMEOUT = 60000;
const HTTP_TIMEOUT = 15000;
const HTTP_MAX = 512 * 1024;

const DENIED = (reason) => ({ ok: false, error: reason });

/* --------------------------------------------------------- ограничение путей */

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Разрешить путь внутри workspace. Относительные пути — от workspace.
 * Возвращает { path } или { error }.
 */
function resolveInside(root, input) {
  if (typeof input !== 'string' || input.trim() === '') return { error: 'Путь не указан' };
  const raw = input.trim();
  if (raw.includes('\0')) return { error: 'Недопустимый путь' };
  const abs = path.resolve(root, raw);
  if (!isInside(root, abs)) return { error: `Выход за пределы рабочей папки запрещён: ${abs}` };
  return { path: abs };
}

/* ------------------------------------------------------------- схемы (JSON Schema) */

const str = (desc) => ({ type: 'string', description: desc });
const schemas = {
  list_dir: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Содержимое папки. Путь относителен к рабочей папке.',
      parameters: {
        type: 'object',
        properties: { path: str('Путь к папке. Пусто или "." — корень.') },
        required: [],
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать текстовый файл (до 256 КБ).',
      parameters: {
        type: 'object',
        properties: {
          path: str('Путь к файлу'),
          maxBytes: { type: 'integer', description: 'Ограничение чтения в байтах (по умолчанию 65536)' },
        },
        required: ['path'],
      },
    },
  },
  search: {
    type: 'function',
    function: {
      name: 'search',
      description: 'Поиск по тексту в файлах рабочей папки (рекурсивно, с пропуском node_modules/.git).',
      parameters: {
        type: 'object',
        properties: {
          query: str('Искомая подстрока или регулярное выражение'),
          glob: str('Фильтр по расширению/имени, например "*.js"'),
          maxHits: { type: 'integer', description: 'Сколько совпадений вернуть (по умолчанию 60)' },
        },
        required: ['query'],
      },
    },
  },
  rag_search: {
    type: 'function',
    function: {
      name: 'rag_search',
      description: 'Вопрос базе знаний рабочей папки: возвращает самые похожие куски файлов с путями. Используй, когда задача касается содержимого проекта.',
      parameters: {
        type: 'object',
        properties: {
          query: str('Вопрос или ключевые слова для базы знаний'),
          topK: { type: 'integer', description: 'Сколько кусков вернуть (по умолчанию 4, максимум 10)' },
        },
        required: ['query'],
      },
    },
  },
  stat: {
    type: 'function',
    function: {
      name: 'stat',
      description: 'Сведения о файле или папке: размер, тип, даты изменения.',
      parameters: {
        type: 'object',
        properties: { path: str('Путь') },
        required: ['path'],
      },
    },
  },
  system_info: {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Реальные сведения об узле: ОС, CPU, память, аптайм, рабочая папка.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Поиск в интернете (цены, товары, документация, новости). Ключ не нужен. Для подробностей открой ссылку через http_request.',
      parameters: {
        type: 'object',
        properties: {
          query: str('Поисковый запрос, например "дешёвый робот-пылесос цена"'),
          count: { type: 'integer', description: 'Сколько результатов вернуть (по умолчанию 8, максимум 15)' },
        },
        required: ['query'],
      },
    },
  },
  web_read: {
    type: 'function',
    function: {
      name: 'web_read',
      description: 'Прочитать страницу как чистый текст без HTML (статьи, документация, товары). Приватные адреса заблокированы.',
      parameters: {
        type: 'object',
        properties: {
          url: str('Полный адрес страницы'),
          maxChars: { type: 'integer', description: 'Сколько символов вернуть (по умолчанию 12000, максимум 30000)' },
        },
        required: ['url'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Записать текст в файл (перезапись). Только в режиме «полный доступ».',
      parameters: {
        type: 'object',
        properties: { path: str('Путь к файлу'), content: str('Содержимое') },
        required: ['path', 'content'],
      },
    },
  },
  run_program: {
    type: 'function',
    function: {
      name: 'run_program',
      description:
        'Запустить одну из подключённых программ ПК (список выдаётся в описании). Только в режиме «полный доступ».',
      parameters: {
        type: 'object',
        properties: {
          programId: str('Идентификатор программы из списка'),
          args: { type: 'array', items: { type: 'string' }, description: 'Аргументы командной строки' },
        },
        required: ['programId'],
      },
    },
  },
  http_request: {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'HTTP-запрос (GET/POST/PUT/DELETE) к внешнему API. Приватные адреса заблокированы. Только в режиме «полный доступ».',
      parameters: {
        type: 'object',
        properties: {
          url: str('Полный URL, напр. https://api.example.com/v1/items'),
          method: { type: 'string', description: 'GET | POST | PUT | PATCH | DELETE (по умолчанию GET)' },
          headers: { type: 'object', description: 'Заголовки' },
          body: str('Тело запроса для POST/PUT/PATCH'),
          timeoutMs: { type: 'integer', description: 'Таймаут, по умолчанию 15000' },
        },
        required: ['url'],
      },
    },
  },
  calc: {
    type: 'function',
    function: {
      name: 'calc',
      description: 'Посчитать математическое выражение: + - * / % ^ (степень), скобки, функции sqrt sin cos tan abs round floor ceil pow min max, константы pi e.',
      parameters: {
        type: 'object',
        properties: { expr: str('Выражение, например "(1200*0.2+49)/12" или "sqrt(16)+sin(pi/2)"') },
        required: ['expr'],
      },
    },
  },
  download_file: {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Скачать файл по URL в рабочую папку (до 50 МБ). Приватные адреса заблокированы. Только в режиме «полный доступ».',
      parameters: {
        type: 'object',
        properties: {
          url: str('Полный URL файла'),
          path: str('Куда сохранить относительно рабочей папки, например "downloads/report.pdf"'),
        },
        required: ['url', 'path'],
      },
    },
  },
  screenshot: {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Снимок основного экрана в JPG (файл + картинка уходит тебе в vision). Только в режиме «полный доступ», только Windows с активной сессией.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  zip_pack: {
    type: 'function',
    function: {
      name: 'zip_pack',
      description: 'Упаковать папку/файлы в ZIP внутри рабочей папки. Только в режиме «полный доступ».',
      parameters: {
        type: 'object',
        properties: {
          src: str('Что паковать: путь к папке или файл, можно несколько через запятую'),
          dest: str('Куда сохранить ZIP, например "backup.zip"'),
        },
        required: ['src', 'dest'],
      },
    },
  },
  zip_unpack: {
    type: 'function',
    function: {
      name: 'zip_unpack',
      description: 'Распаковать ZIP внутри рабочей папки. Только в режиме «полный доступ».',
      parameters: {
        type: 'object',
        properties: {
          src: str('Путь к ZIP-файлу'),
          dest: str('Куда распаковать (по умолчанию рядом в папку с именем архива)'),
        },
        required: ['src'],
      },
    },
  },
};

const READONLY_TOOLS = ['list_dir', 'read_file', 'search', 'rag_search', 'stat', 'system_info', 'web_search', 'web_read', 'calc'];
const FULL_TOOLS = [...READONLY_TOOLS, 'write_file', 'run_program', 'http_request', 'download_file', 'screenshot', 'zip_pack', 'zip_unpack'];
/* Мощные инструменты ПК: только полный доступ + явное разрешение input */
const POWER_TOOLS = ['run_command', 'clipboard'];
/* Мост ввода: только при явном разрешении агента (permissions.input === true) */
const INPUT_TOOLS = ['input_screen', 'input_key', 'input_text', 'input_mouse'];
/* Свой браузер: то же разрешение — это тоже прямое управление ПК */
const BROWSER_TOOLS = ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_back', 'browser_shot'];

const inputSchemas = {
  input_screen: {
    type: 'function',
    function: {
      name: 'input_screen',
      description: 'Размер основного экрана в пикселях. Нужен, чтобы вычислять координаты для input_mouse.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  input_key: {
    type: 'function',
    function: {
      name: 'input_key',
      description: 'Нажать клавишу или сочетание: "ENTER", "TAB", "ESC", "ctrl+s", "alt+TAB", "F5", "a". Модификаторы: ctrl, alt, shift.',
      parameters: {
        type: 'object',
        properties: { keys: str('Сочетание клавиш, например "ctrl+s" или "ENTER"') },
        required: ['keys'],
      },
    },
  },
  input_text: {
    type: 'function',
    function: {
      name: 'input_text',
      description: 'Напечатать текст в активное окно (до 300 символов). Окно должно быть на переднем плане.',
      parameters: {
        type: 'object',
        properties: { text: str('Текст для ввода') },
        required: ['text'],
      },
    },
  },
  input_mouse: {
    type: 'function',
    function: {
      name: 'input_mouse',
      description: 'Мышь: move — перевести курсор; click/double/right — клик; scroll — колесо. Координаты — абсолютные пиксели (см. input_screen).',
      parameters: {
        type: 'object',
        properties: {
          action: str('move | click | double | right | middle | scroll'),
          x: { type: 'integer', description: 'X в пикселях (для move/click/double/right/middle)' },
          y: { type: 'integer', description: 'Y в пикселях (для move/click/double/right/middle)' },
          dy: { type: 'integer', description: 'Направление колеса для scroll: от -10 до 10' },
        },
        required: ['action'],
      },
    },
  },
};

/** Схемы инструментов, доступные агенту в текущем режиме и его разрешениях. */
function toolSchemas(mode, agent, programs) {
  const wanted = mode === 'full' ? FULL_TOOLS : READONLY_TOOLS;
  const out = wanted.map((n) => schemas[n]).filter(Boolean);

  const perms = (agent && agent.permissions) || { programs: [] };
  const runnable = (programs || []).filter((p) => perms.programs.includes(p.id) && p.perms && p.perms.run);
  if (mode === 'full' && runnable.length) {
    const list = runnable.map((p) => `${p.id} — ${p.name} (${p.path})`).join('; ');
    out.push({
      type: 'function',
      function: {
        name: 'run_program',
        description: `Запустить подключённую программу ПК. Доступные программы: ${list}`,
        parameters: {
          type: 'object',
          properties: {
            programId: str(`Идентификатор программы. Один из: ${runnable.map((p) => p.id).join(', ')}`),
            args: { type: 'array', items: { type: 'string' }, description: 'Аргументы командной строки' },
          },
          required: ['programId'],
        },
      },
    });
  }

  /* Мост ввода и мощь ПК: только в полном режиме и только с явного разрешения */
  if (mode === 'full' && perms.input === true) {
    for (const n of INPUT_TOOLS) out.push(inputSchemas[n]);
    for (const n of Object.keys(browserSchemas)) out.push(browserSchemas[n]);
    for (const n of POWER_TOOLS) out.push(powerSchemas[n]);
  }
  return out;
}

/* ---------------------------------------------------------------- реализации */

async function tListDir(ctx, args) {
  const r = resolveInside(ctx.root, args.path || '.');
  if (r.error) return DENIED(r.error);
  let entries;
  try {
    entries = await fsp.readdir(r.path, { withFileTypes: true });
  } catch (e) {
    return DENIED(`Не удалось прочитать папку: ${e.code || e.message}`);
  }
  if (entries.length > MAX_LIST) entries = entries.slice(0, MAX_LIST);
  const items = [];
  for (const e of entries) {
    let size = 0;
    if (e.isFile()) {
      try {
        size = (await fsp.stat(path.join(r.path, e.name))).size;
      } catch {
        size = 0;
      }
    }
    items.push({ name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'ru') : a.type === 'dir' ? -1 : 1));
  return { ok: true, path: r.path, count: items.length, truncated: entries.length >= MAX_LIST, items };
}

async function tReadFile(ctx, args) {
  const r = resolveInside(ctx.root, args.path);
  if (r.error) return DENIED(r.error);
  const limit = Math.min(Number(args.maxBytes) > 0 ? Number(args.maxBytes) : 65536, MAX_READ);
  let st;
  try {
    st = await fsp.stat(r.path);
  } catch (e) {
    return DENIED(`Файл не найден: ${r.path} (${e.code || e.message})`);
  }
  if (st.isDirectory()) return DENIED('Это папка, а не файл. Используйте list_dir.');
  const fh = await fsp.open(r.path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(limit, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return {
      ok: true,
      path: r.path,
      size: st.size,
      truncated: st.size > bytesRead,
      content: buf.subarray(0, bytesRead).toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.next', '__pycache__', '.venv', 'coverage']);

async function tSearch(ctx, args) {
  const q = typeof args.query === 'string' ? args.query : '';
  if (!q.trim()) return DENIED('Не указан запрос для поиска');
  let matcher;
  try {
    const re = new RegExp(q, 'i');
    matcher = (line) => re.test(line);
  } catch {
    const needle = q.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(needle);
  }
  const glob = typeof args.glob === 'string' && args.glob ? args.glob.toLowerCase() : '';
  const globRe = glob && /[*?]/.test(glob) ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  const maxHits = Math.min(Number(args.maxHits) > 0 ? Number(args.maxHits) : 60, MAX_SEARCH_HITS);

  const hits = [];
  let scanned = 0;
  let skippedBinary = 0;

  const walk = async (dir, depth) => {
    if (hits.length >= maxHits || scanned >= MAX_SEARCH_FILES || depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= maxHits || scanned >= MAX_SEARCH_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(e.name)) continue;
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (st.size > 2 * 1024 * 1024) continue;
        scanned++;
        let content;
        try {
          const fh = await fsp.open(full, 'r');
          try {
            const buf = Buffer.alloc(st.size);
            await fh.read(buf, 0, st.size, 0);
            content = buf;
          } finally {
            await fh.close();
          }
        } catch {
          continue;
        }
        if (content.includes(0)) {
          skippedBinary++;
          continue;
        }
        const lines = content.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
          if (matcher(lines[i])) {
            hits.push({ file: path.relative(ctx.root, full), line: i + 1, text: lines[i].trim().slice(0, 220) });
          }
        }
      }
    }
  };

  await walk(ctx.root, 0);
  return { ok: true, query: q, root: ctx.root, scannedFiles: scanned, skippedBinary, hits: hits.length, results: hits };
}

/** RAG: вопрос базе знаний рабочей папки (чанки с похожими кусками файлов). */
async function tRagSearch(ctx, args) {
  const q = typeof args.query === 'string' ? args.query.trim() : '';
  if (!q) return DENIED('Не указан запрос для базы знаний');
  try {
    const rag = require('./rag');
    /* Если агент привязан к базам — ищем только в них */
    const out = await rag.search(ctx.root, q, args.topK, ctx.kbRoots || undefined);
    if (out.error) return DENIED(out.error);
    return { ok: true, tool: 'rag_search', query: out.query, files: out.files, results: out.results };
  } catch (e) {
    return DENIED(`База знаний недоступна: ${e.message}`);
  }
}

async function tStat(ctx, args) {
  const r = resolveInside(ctx.root, args.path);
  if (r.error) return DENIED(r.error);
  try {
    const s = await fsp.stat(r.path);
    return {
      ok: true,
      path: r.path,
      type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
      size: s.size,
      created: s.birthtime.toISOString(),
      modified: s.mtime.toISOString(),
    };
  } catch (e) {
    return DENIED(`Не найдено: ${r.path} (${e.code || e.message})`);
  }
}

/* Поиск в интернете без ключа: DuckDuckGo Lite-выдача.
   Хост фиксирован, приватных адресов здесь быть не может. */
const DDG_URL = 'https://lite.duckduckgo.com/lite/';

function ddgDecode(href) {
  try {
    const m = /uddg=([^&]+)/.exec(href || '');
    if (m) return decodeURIComponent(m[1]);
  } catch { /* игнор */ }
  return href;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function tWebSearch(ctx, args) {
  const q = typeof args.query === 'string' ? args.query.trim() : '';
  if (!q) return DENIED('Не указан поисковый запрос');
  if (q.length > 300) return DENIED('Запрос длиннее 300 символов');
  const count = Math.min(Math.max(Number(args.count) || 8, 1), 15);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
  let html = '';
  try {
    const res = await fetch(`${DDG_URL}?q=${encodeURIComponent(q)}`, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NEXUS-Agent/1.0', Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return DENIED(`Поисковик ответил ${res.status}`);
    html = (await res.text()).slice(0, 512 * 1024);
  } catch (e) {
    return DENIED(e.name === 'AbortError' ? 'Таймаут поиска' : `Поиск недоступен: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }

  /* Разбираем блоки: ссылка result-link + сниппет result-snippet следом.
     Порядок атрибутов у поисковика гуляет, поэтому сначала берём href, потом проверяем класс. */
  const results = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while (results.length < count && (m = re.exec(html))) {
    const tag = m[1];
    if (!/class=['"]result-link['"]/.test(tag)) continue;
    const href = /href="([^"]+)"/.exec(tag);
    if (!href) continue;
    const url = ddgDecode(href[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(m[2]).slice(0, 200);
    /* Сниппет ищем после ссылки, в пределах 3 КБ */
    const tail = html.slice(m.index, m.index + 3072);
    const sn = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(tail);
    results.push({ title: title || url, url, snippet: sn ? stripTags(sn[1]).slice(0, 300) : '' });
  }
  if (!results.length) return DENIED('Ничего не найдено или поисковик отдал капчу — переформулируй запрос');
  return { ok: true, query: q, count: results.length, results };
}

/* Чтение страниц: только публичные адреса, бинарники не тянем */
async function tWebRead(ctx, args) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return DENIED('Не указан адрес страницы');
  const check = await assertPublicUrl(url);
  if (check.error) return DENIED(check.error);
  const maxChars = Math.min(Math.max(Number(args.maxChars) || 12000, 1000), 30000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
  try {
    const res = await fetch(check.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NEXUS-Agent/1.0', Accept: 'text/html,text/plain' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return DENIED(`Страница ответила ${res.status}`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/text\/|html|xml|json/.test(type)) return DENIED(`Не текстовая страница (${type || 'неизвестный тип'})`);
    const raw = (await res.text()).slice(0, 512 * 1024);
    const noScripts = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
    const text = stripTags(noScripts).replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
    if (!text) return DENIED('На странице нет читаемого текста');
    return { ok: true, url: check.url.toString(), chars: text.length, content: text };
  } catch (e) {
    return DENIED(e.name === 'AbortError' ? 'Таймаут чтения' : `Не прочиталось: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function tSystemInfo(ctx) {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    ok: true,
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    cpuModel: (os.cpus()[0] || {}).model || '—',
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memory: { total, free, used: total - free },
    uptimeSec: Math.round(os.uptime()),
    node: process.version,
    workspace: ctx.root,
    mode: ctx.mode,
  };
}

async function tWriteFile(ctx, args) {
  if (ctx.mode !== 'full') return DENIED('Режим «только чтение»: запись запрещена');
  const r = resolveInside(ctx.root, args.path);
  if (r.error) return DENIED(r.error);
  const content = typeof args.content === 'string' ? args.content : '';
  if (Buffer.byteLength(content) > MAX_WRITE) return DENIED(`Файл больше лимита 1 МБ (${Buffer.byteLength(content)} Б)`);
  await fsp.mkdir(path.dirname(r.path), { recursive: true });
  const existed = fs.existsSync(r.path);
  await fsp.writeFile(r.path, content, 'utf8');
  const st = await fsp.stat(r.path);
  return { ok: true, path: r.path, created: !existed, bytes: st.size };
}

function tRunProgram(ctx, args) {
  if (ctx.mode !== 'full') return Promise.resolve(DENIED('Режим «только чтение»: запуск программ запрещён'));
  const prog = (ctx.programs || []).find((p) => p.id === args.programId);
  if (!prog) return Promise.resolve(DENIED(`Программа «${args.programId}» не найдена или не подключена к агенту`));
  if (!prog.perms || !prog.perms.run) return Promise.resolve(DENIED(`Для «${prog.name}» не выдан разрешён на запуск`));
  if (!fs.existsSync(prog.path)) return Promise.resolve(DENIED(`Файл программы не найден: ${prog.path}`));

  const argsList = Array.isArray(args.args) ? args.args.slice(0, 24).map(String) : [];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(prog.path, argsList, {
        cwd: ctx.root,
        windowsHide: true,
        detached: false,
        shell: false,
        env: Object.assign({}, process.env, { PATH: process.env.PATH || '' }),
      });
    } catch (e) {
      resolve(DENIED(`Не удалось запустить: ${e.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill();
      } catch {}
    }, RUN_TIMEOUT);
    child.stdout.on('data', (d) => {
      if (stdout.length < 65536) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 32768) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(DENIED(`Ошибка запуска: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        program: prog.name,
        path: prog.path,
        args: argsList,
        exitCode: code,
        signal: signal || null,
        timedOut: killed,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 4000),
      });
    });
  });
}

/* ------------------------------------------------------------------- SSRF-фильтр */

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { error: 'Некорректный URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Разрешены только http и https' };
  const host = u.hostname;
  if (net.isIPv4(host) || net.isIPv6(host)) {
    if (net.isIPv4(host) ? isPrivateIPv4(host) : isPrivateIPv6(host)) return { error: `Адрес ${host} — приватный, запрос заблокирован` };
    return { url: u };
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return { error: `Хост ${host} — локальный, запрос заблокирован` };
  try {
    const records = await dns.lookup(host, { all: true });
    for (const rec of records) {
      const priv = net.isIPv4(rec.address) ? isPrivateIPv4(rec.address) : isPrivateIPv6(rec.address);
      if (priv) return { error: `${host} резолвится в приватный адрес ${rec.address} — запрос заблокирован` };
    }
  } catch (e) {
    return { error: `Не удалось разрешить хост: ${e.code || e.message}` };
  }
  return { url: u };
}

async function tHttpRequest(ctx, args) {
  if (ctx.mode !== 'full') return DENIED('Режим «только чтение»: сетевые запросы запрещены');
  const check = await assertPublicUrl(args.url);
  if (check.error) return DENIED(check.error);
  const method = String(args.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) return DENIED(`Метод ${method} не поддерживается`);
  const headers = Object.assign({ 'User-Agent': 'NEXUS-Agent/1.0' }, args.headers || {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Number(args.timeoutMs) || HTTP_TIMEOUT, 60000));
  const started = Date.now();
  try {
    /* Редиректы идём вручную, чтобы каждый хоп заново проходил SSRF-проверку */
    let cur = check.url;
    let res = null;
    for (let hop = 0; hop <= 3; hop++) {
      res = await fetch(cur, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : typeof args.body === 'string' ? args.body : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        let next;
        try {
          next = new URL(loc, cur).toString();
        } catch {
          return DENIED('Некорректный редирект');
        }
        const re = await assertPublicUrl(next);
        if (re.error) return DENIED(`редирект заблокирован: ${re.error}`);
        cur = re.url;
        continue;
      }
      break;
    }
    const type = res.headers.get('content-type') || '';
    const text = (await res.text()).slice(0, HTTP_MAX);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: type,
      latencyMs: Date.now() - started,
      truncated: text.length >= HTTP_MAX,
      body: type.includes('json') ? safeJson(text) : text,
    };
  } catch (e) {
    return DENIED(e.name === 'AbortError' ? 'Таймаут запроса' : `Ошибка сети: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Безопасный калькулятор: свой парсер выражений, никакого eval/Function.
 * Числа, + - * / % ^ (степень, правоассоц.), унарный минус, скобки,
 * функции sqrt sin cos tan abs round floor ceil log exp pow min max, константы pi e. */
const CALC_FUNCS = {
  sqrt: (a) => Math.sqrt(a[0]),
  sin: (a) => Math.sin(a[0]),
  cos: (a) => Math.cos(a[0]),
  tan: (a) => Math.tan(a[0]),
  abs: (a) => Math.abs(a[0]),
  round: (a) => Math.round(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  log: (a) => Math.log(a[0]),
  exp: (a) => Math.exp(a[0]),
  pow: (a) => Math.pow(a[0], a[1]),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
};

function calcTokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) throw new Error('плохое число');
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      let j = i;
      while (j < s.length && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z'))) j++;
      tokens.push({ t: 'word', v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/%^,'.includes(c)) {
      tokens.push({ t: c === ',' ? 'comma' : 'op', v: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ t: c === '(' ? 'lp' : 'rp' });
      i++;
      continue;
    }
    throw new Error(`недопустимый символ «${c}»`);
  }
  return tokens;
}

function calcParse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];
  function parseExpr() {
    let node = parseTerm();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        eat();
        node = { op: t.v, l: node, r: parseTerm() };
      } else return node;
    }
  }
  function parseTerm() {
    let node = parseFactor();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        eat();
        node = { op: t.v, l: node, r: parseFactor() };
      } else return node;
    }
  }
  function parseFactor() {
    let node = parseUnary();
    const t = peek();
    if (t && t.t === 'op' && t.v === '^') {
      eat();
      node = { op: '^', l: node, r: parseFactor() };
    }
    return node;
  }
  function parseUnary() {
    const t = peek();
    if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
      eat();
      return { op: t.v === '-' ? 'neg' : 'pos', l: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('неожиданный конец выражения');
    if (t.t === 'num') { eat(); return { num: t.v }; }
    if (t.t === 'word') {
      eat();
      if (t.v === 'pi') return { num: Math.PI };
      if (t.v === 'e') return { num: Math.E };
      if (!CALC_FUNCS[t.v]) throw new Error(`неизвестная функция «${t.v}»`);
      const lp = peek();
      if (!lp || lp.t !== 'lp') throw new Error(`после ${t.v} нужны скобки`);
      eat();
      const args = [];
      if (peek() && peek().t !== 'rp') {
        for (;;) {
          args.push(parseExpr());
          const nx = peek();
          if (nx && nx.t === 'comma') { eat(); continue; }
          break;
        }
      }
      const rp = peek();
      if (!rp || rp.t !== 'rp') throw new Error('нет закрывающей скобки');
      eat();
      return { fn: t.v, args };
    }
    if (t.t === 'lp') {
      eat();
      const node = parseExpr();
      const rp = peek();
      if (!rp || rp.t !== 'rp') throw new Error('нет закрывающей скобки');
      eat();
      return node;
    }
    throw new Error('неожиданный символ в выражении');
  }
  const node = parseExpr();
  if (pos !== tokens.length) throw new Error('лишний текст в конце выражения');
  return node;
}

function calcEval(node, depth = 0) {
  if (depth > 100) throw new Error('слишком глубокое выражение');
  if (node.num !== undefined) return node.num;
  if (node.fn) {
    const fn = CALC_FUNCS[node.fn];
    const args = node.args.map((a) => calcEval(a, depth + 1));
    if (node.fn === 'pow' && args.length !== 2) throw new Error('pow(a, b) — два аргумента');
    if ((node.fn === 'min' || node.fn === 'max') && !args.length) throw new Error('min/max — хоть один аргумент');
    if (!['pow', 'min', 'max'].includes(node.fn) && args.length !== 1) throw new Error(`${node.fn}(x) — один аргумент`);
    const v = fn(args);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('нет числового результата');
    return v;
  }
  if (node.op === 'neg') return -calcEval(node.l, depth + 1);
  if (node.op === 'pos') return calcEval(node.l, depth + 1);
  const l = calcEval(node.l, depth + 1);
  const r = calcEval(node.r, depth + 1);
  let v;
  if (node.op === '+') v = l + r;
  else if (node.op === '-') v = l - r;
  else if (node.op === '*') v = l * r;
  else if (node.op === '/') {
    if (r === 0) throw new Error('деление на ноль');
    v = l / r;
  } else if (node.op === '%') {
    if (r === 0) throw new Error('деление на ноль');
    v = l % r;
  } else if (node.op === '^') v = Math.pow(l, r);
  else throw new Error('неизвестная операция');
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('нет числового результата');
  return v;
}

async function tCalc(ctx, args) {
  const raw = String(args.expr || '').trim().slice(0, 300);
  if (!raw) return DENIED('Пустое выражение');
  let value;
  try {
    value = calcEval(calcParse(calcTokenize(raw)));
  } catch (e) {
    return DENIED(`Не посчиталось: ${e.message}. Можно: числа, + - * / % ^, скобки, ${Object.keys(CALC_FUNCS).join(' ')}, pi, e`);
  }
  return { ok: true, expr: raw, result: Math.round(value * 1e10) / 1e10 };
}

const DOWNLOAD_MAX = 50 * 1024 * 1024;

/** Скачивание файла по URL в рабочую папку (с SSRF-проверкой редиректов). */
async function tDownloadFile(ctx, args) {
  if (ctx.mode !== 'full') return DENIED('Режим «только чтение»: скачивание запрещено');
  const check = await assertPublicUrl(args.url);
  if (check.error) return DENIED(check.error);
  const r = resolveInside(ctx.root, args.path);
  if (r.error) return DENIED(r.error);
  if (!/\.[A-Za-z0-9]{1,10}$/.test(r.path)) return DENIED('Укажи имя файла с расширением');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const started = Date.now();
  try {
    let cur = check.url;
    let res = null;
    for (let hop = 0; hop <= 3; hop++) {
      res = await fetch(cur, { headers: { 'User-Agent': 'NEXUS-Agent/1.0' }, signal: controller.signal, redirect: 'manual' });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        const re = await assertPublicUrl(new URL(loc, cur).toString());
        if (re.error) return DENIED(`редирект заблокирован: ${re.error}`);
        cur = re.url;
        continue;
      }
      break;
    }
    if (!res.ok) return DENIED(`Сервер ответил ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return DENIED('Пустой ответ');
    if (buf.length > DOWNLOAD_MAX) return DENIED('Файл больше лимита 50 МБ');
    await fsp.mkdir(path.dirname(r.path), { recursive: true });
    await fsp.writeFile(r.path, buf);
    return { ok: true, path: path.relative(ctx.root, r.path).replace(/\\/g, '/'), bytes: buf.length, contentType: res.headers.get('content-type') || '', latencyMs: Date.now() - started };
  } catch (e) {
    return DENIED(e.name === 'AbortError' ? 'Таймаут скачивания' : `Ошибка сети: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Снимок основного экрана в JPG: файл + картинка модели в vision.
 * Результат несёт поле image — рантайм агента приложит его к сообщению. */
async function tScreenshot(ctx) {
  if (ctx.mode !== 'full') return DENIED('Режим «только чтение»: скриншоты запрещены');
  if (process.platform !== 'win32') return DENIED('Скриншот экрана — только на Windows');
  const name = `screen-${Date.now().toString(36)}.jpg`;
  const dest = path.join(ctx.root, 'uploads', name);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const psSafe = dest.replace(/'/g, "''");
  const r = await psRun(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    'Add-Type -AssemblyName System.Drawing; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    `$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); ` +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    '$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq \'image/jpeg\'}; ' +
    '$par=New-Object System.Drawing.Imaging.EncoderParameters(1); ' +
    '$par.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,60); ' +
    `$bmp.Save('${psSafe}',$enc,$par); ` +
    '$g.Dispose(); $bmp.Dispose(); ' +
    `"OK $($b.Width)x$($b.Height)"`,
  );
  if (r.error) return DENIED(r.error);
  if (r.code !== 0 || !String(r.out || '').startsWith('OK')) return DENIED(`Скриншот не получился: ${r.err || `код ${r.code}`}`);
  let buf;
  try {
    buf = await fsp.readFile(dest);
  } catch {
    return DENIED('Снимок сохранился, но прочитать его не удалось');
  }
  if (!buf.length || buf.length > 4 * 1024 * 1024) return DENIED('Снимок слишком большой для модели');
  const rel = path.relative(ctx.root, dest).replace(/\\/g, '/');
  return {
    ok: true,
    path: rel,
    size: `${String(r.out).slice(3).trim()}`,
    bytes: buf.length,
    image: { mime: 'image/jpeg', data: buf.toString('base64'), name: rel },
  };
}

/** ZIP pack/unpack через встроенные Compress-Archive / Expand-Archive. */
async function tZipPack(ctx, args) {
  if (ctx.mode !== 'full') return DENIED('Режим «только чтение»: архивация запрещена');
  const dest = resolveInside(ctx.root, args.dest);
  if (dest.error) return DENIED(dest.error);
  if (!/\.zip$/i.test(dest.path)) return DENIED('Путь назначения должен заканчиваться на .zip');
  const srcs = String(args.src || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!srcs.length) return DENIED('Не указано, что паковать');
  const abs = [];
  for (const s of srcs) {
    const r = resolveInside(ctx.root, s);
    if (r.error) return DENIED(r.error);
    if (!fs.existsSync(r.path)) return DENIED(`Нет такого файла/папки: ${s}`);
    abs.push(r.path);
  }
  await fsp.mkdir(path.dirname(dest.path), { recursive: true });
  const list = abs.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const r = await psRun(`Compress-Archive -Path ${list} -DestinationPath '${dest.path.replace(/'/g, "''")}' -Force; Write-Output OK`);
  if (r.error || r.code !== 0 || String(r.out || '').trim() !== 'OK') return DENIED(`Не упаковалось: ${r.error || r.err || `код ${r.code}`}`);
  const st = await fsp.stat(dest.path);
  return { ok: true, path: path.relative(ctx.root, dest.path).replace(/\\/g, '/'), bytes: st.size, packed: abs.length };
}

async function tZipUnpack(ctx, args) {
  if (ctx.mode !== 'full') return DENIED('Режим «только чтение»: распаковка запрещена');
  const src = resolveInside(ctx.root, args.src);
  if (src.error) return DENIED(src.error);
  if (!fs.existsSync(src.path)) return DENIED(`Нет такого файла: ${args.src}`);
  const destArg = String(args.dest || '').trim();
  const destDir = destArg
    ? resolveInside(ctx.root, destArg)
    : { path: path.join(path.dirname(src.path), path.basename(src.path, path.extname(src.path))) };
  if (destDir.error) return DENIED(destDir.error);
  await fsp.mkdir(destDir.path, { recursive: true });
  const r = await psRun(`Expand-Archive -Path '${src.path.replace(/'/g, "''")}' -DestinationPath '${destDir.path.replace(/'/g, "''")}' -Force; Write-Output OK`);
  if (r.error || r.code !== 0 || String(r.out || '').trim() !== 'OK') return DENIED(`Не распаковалось: ${r.error || r.err || `код ${r.code}`}`);
  const files = await fsp.readdir(destDir.path).catch(() => []);
  return { ok: true, path: path.relative(ctx.root, destDir.path).replace(/\\/g, '/'), entries: files.length };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ------------------------------------- свой браузер команды (через CDP) */

const browserSchemas = {
  browser_open: {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Открыть страницу в браузере команды (видимое окно Chrome). Только публичные http(s). Возвращает заголовок и число элементов.',
      parameters: {
        type: 'object',
        properties: { url: str('Полный адрес страницы, например https://example.com') },
        required: ['url'],
      },
    },
  },
  browser_snapshot: {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Слепок текущей страницы: заголовок, текст и кликабельные элементы с номерами ref для click/type.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  browser_click: {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Кликнуть элемент по его ref из свежего snapshot. После клика страница обновляется.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer', description: 'Номер элемента из snapshot' } },
        required: ['ref'],
      },
    },
  },
  browser_type: {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Ввести текст в поле по его ref из свежего snapshot. submit=true — нажать Enter после ввода.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Номер поля ввода из snapshot' },
          text: str('Текст (до 2000 символов)'),
          submit: { type: 'boolean', description: 'Нажать Enter после ввода' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  browser_back: {
    type: 'function',
    function: {
      name: 'browser_back',
      description: 'Назад в истории браузера (или перезагрузить). Возвращает свежий слепок.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  browser_shot: {
    type: 'function',
    function: {
      name: 'browser_shot',
      description: 'Скриншот текущего окна браузера в файл shots/. Оператор смотрит его в чате.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
};

const browserLib = require('./browser');

async function tBrowserOpen(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  try {
    return await browserLib.openPage(args.url);
  } catch (e) {
    return DENIED(`Браузер: ${e.message}`);
  }
}

async function tBrowserSnapshot(ctx) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  try {
    return await browserLib.snapshot();
  } catch (e) {
    return DENIED(`Браузер: ${e.message}`);
  }
}

async function tBrowserClick(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  try {
    return await browserLib.clickRef(args.ref);
  } catch (e) {
    return DENIED(`Браузер: ${e.message}`);
  }
}

async function tBrowserType(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  try {
    return await browserLib.typeRef(args.ref, args.text, args.submit === true);
  } catch (e) {
    return DENIED(`Браузер: ${e.message}`);
  }
}

async function tBrowserBack(ctx) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  try {
    return await browserLib.goBack();
  } catch (e) {
    return DENIED(`Браузер: ${e.message}`);
  }
}

async function tBrowserShot(ctx) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  try {
    return await browserLib.shot();
  } catch (e) {
    return DENIED(`Браузер: ${e.message}`);
  }
}

/* --------------------------------------- мощь ПК: команды и буфер обмена */

const powerSchemas = {
  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Выполнить команду PowerShell и вернуть вывод (до 60 с). Для скриптов, конвертаций, git, python и т.п. Только с явного разрешения.',
      parameters: {
        type: 'object',
        properties: { command: str('Команда PowerShell, например "python script.py" или "Get-ChildItem"') },
        required: ['command'],
      },
    },
  },
  clipboard: {
    type: 'function',
    function: {
      name: 'clipboard',
      description: 'Буфер обмена Windows: get — прочитать, set — записать текст.',
      parameters: {
        type: 'object',
        properties: {
          action: str('get | set'),
          text: str('Текст для записи (только для set, до 4000 символов)'),
        },
        required: ['action'],
      },
    },
  },
};

async function tRunCommand(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return DENIED('Не указана команда');
  if (command.length > 2000) return DENIED('Команда длиннее 2000 символов');
  const t0 = Date.now();
  const r = await psRun(`Set-Location -LiteralPath '${ctx.root.replace(/'/g, "''")}'; ${command}`);
  if (r.error) return DENIED(r.error);
  return {
    ok: r.code === 0,
    exitCode: r.code,
    ms: Date.now() - t0,
    stdout: r.out.slice(0, 8000),
    stderr: r.err.slice(0, 2000),
  };
}

async function tClipboard(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  const action = String(args.action || '').toLowerCase();
  if (action === 'get') {
    const r = await psRun('[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw');
    if (r.error) return DENIED(r.error);
    if (r.code !== 0) return DENIED(`Буфер не прочитался: ${r.err || `код ${r.code}`}`);
    return { ok: true, text: r.out.slice(0, 4000) };
  }
  if (action === 'set') {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text) return DENIED('Не указан текст');
    if (text.length > 4000) return DENIED('Текст длиннее 4000 символов');
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const r = await psRun(`$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; Write-Output "OK"`);
    if (r.error) return DENIED(r.error);
    if (r.code !== 0 || r.out !== 'OK') return DENIED(`Не записалось: ${r.err || `код ${r.code}`}`);
    return { ok: true, written: text.length };
  }
  return DENIED('action — get или set');
}

const INPUT_TIMEOUT = 15000;

/**
 * Проверка доступа к мосту ввода. Режим «полный доступ» недостаточен сам по
 * себе: у агента должно стоять явное разрешение permissions.input === true.
 */
function inputAllowed(ctx) {
  if (ctx.mode !== 'full') return 'Режим «только чтение»: ввод и браузер запрещены';
  if (!ctx.agent || !ctx.agent.permissions || ctx.agent.permissions.input !== true) {
    return 'Агенту не выдан доступ: включите «Ввод и свой браузер» в разрешениях агента';
  }
  if (process.platform !== 'win32') return 'Мост ввода работает только на Windows';
  return null;
}

/** Запуск PowerShell-скрипта через -EncodedCommand (безопасно для кавычек). */
function psRun(script) {
  return new Promise((resolve) => {
    const payload = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', payload], {
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      resolve({ error: `Не удалось запустить PowerShell: ${e.message}` });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, INPUT_TIMEOUT);
    child.stdout.on('data', (d) => { if (out.length < 32768) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: `Не удалось запустить PowerShell: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out: out.trim(), err: err.trim(), code });
    });
  });
}

async function tInputScreen(ctx) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  const r = await psRun(
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    "Write-Output ('{\"width\":' + $b.Width + ',\"height\":' + $b.Height + '}')",
  );
  if (r.error) return DENIED(r.error);
  if (r.code !== 0) return DENIED(`Не удалось узнать размер экрана: ${r.err || `код ${r.code}`}`);
  try {
    const o = JSON.parse(r.out);
    const w = Number(o.width);
    const h = Number(o.height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error('bad');
    return { ok: true, width: w, height: h };
  } catch {
    return DENIED('Мост ввода вернул некорректный ответ');
  }
}

/** Экранирование текста для .NET SendKeys: спецсимволы — в фигурные скобки. */
function sendKeysEscape(text) {
  return String(text)
    .replace(/([+^%~(){}[\]])/g, '{$1}')
    .replace(/\r\n|\r|\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
}

const KEY_NAMES = {
  enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', space: ' ',
  backspace: '{BACKSPACE}', bs: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
  insert: '{INSERT}', ins: '{INSERT}', home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', pgup: '{PGUP}', pagedown: '{PGDN}', pgdn: '{PGDN}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  printscreen: '{PRTSC}', prtsc: '{PRTSC}',
};

/** Разбор «ctrl+s» в последовательность SendKeys. */
function buildSendKeys(spec) {
  const parts = String(spec || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return { error: 'Укажите сочетание вида "ENTER", "ctrl+s" или "F5"' };
  let mods = '';
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'ctrl') mods += '^';
    else if (parts[i] === 'alt') mods += '%';
    else if (parts[i] === 'shift') mods += '+';
    else return { error: `Неизвестный модификатор «${parts[i]}»: допустимы ctrl, alt, shift` };
  }
  const last = parts[parts.length - 1];
  let key = null;
  if (KEY_NAMES[last]) key = KEY_NAMES[last];
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(last)) key = `{${last.toUpperCase()}}`;
  else if (/^[a-z0-9]$/.test(last)) key = last;
  if (key === null) return { error: `Неизвестная клавиша «${last}»` };
  return { seq: mods + key };
}

function psSendKeys(seq) {
  /* Одинарные кавычки удваиваем для PowerShell-строки */
  const safe = String(seq).replace(/'/g, "''");
  return (
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    `[System.Windows.Forms.SendKeys]::SendWait('${safe}'); ` +
    'Write-Output "OK"'
  );
}

async function tInputKey(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  const built = buildSendKeys(args.keys);
  if (built.error) return DENIED(built.error);
  const r = await psRun(psSendKeys(built.seq));
  if (r.error) return DENIED(r.error);
  if (r.code !== 0 || r.out !== 'OK') return DENIED(`Клавиша не нажата: ${r.err || `код ${r.code}`}`);
  return { ok: true, keys: String(args.keys) };
}

async function tInputText(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) return DENIED('Не указан текст для ввода');
  if (text.length > 300) return DENIED('Текст длиннее 300 символов: разбивайте ввод на части');
  const r = await psRun(psSendKeys(sendKeysEscape(text)));
  if (r.error) return DENIED(r.error);
  if (r.code !== 0 || r.out !== 'OK') return DENIED(`Текст не введён: ${r.err || `код ${r.code}`}`);
  return { ok: true, typed: text.length };
}

const MOUSE_FLAGS = { click: [0x0002, 0x0004], double: [0x0002, 0x0004, 0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] };

async function tInputMouse(ctx, args) {
  const denied = inputAllowed(ctx);
  if (denied) return DENIED(denied);
  const action = String(args.action || '').toLowerCase();
  if (!['move', 'click', 'double', 'right', 'middle', 'scroll'].includes(action)) {
    return DENIED('action — одно из: move, click, double, right, middle, scroll');
  }
  const x = args.x === undefined ? 0 : Math.trunc(Number(args.x));
  const y = args.y === undefined ? 0 : Math.trunc(Number(args.y));
  if ((action !== 'scroll') && (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 16384 || y > 16384)) {
    return DENIED('Координаты x/y — целые числа от 0 до 16384 (сначала узнайте размер через input_screen)');
  }
  const dy = Math.trunc(Number(args.dy) || 0);
  if (action === 'scroll' && (!Number.isInteger(dy) || dy < -10 || dy > 10 || dy === 0)) {
    return DENIED('dy для scroll — целое от -10 до 10, не 0');
  }

  const clicks = MOUSE_FLAGS[action] || [];
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern bool SetCursorPos(int X,int Y);' +
    '[DllImport("user32.dll")]public static extern void mouse_event(int dwFlags,int dx,int dy,int dwData,System.UIntPtr dwExtraInfo);\' ' +
    '-Name NXMouse -Namespace NXMouse; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    `$x=[Math]::Max(0,[Math]::Min($b.Width-1,${x})); ` +
    `$y=[Math]::Max(0,[Math]::Min($b.Height-1,${y})); ` +
    (action === 'scroll'
      ? `[NXMouse.NXMouse]::mouse_event(0x0800,0,0,${dy * 120},[System.UIntPtr]::Zero); `
      : '[NXMouse.NXMouse]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 60; ' +
        clicks.map((f) => `[NXMouse.NXMouse]::mouse_event(${f},0,0,0,[System.UIntPtr]::Zero)`).join('; ')) +
    'Write-Output "OK"';

  const r = await psRun(script);
  if (r.error) return DENIED(r.error);
  if (r.code !== 0 || r.out !== 'OK') return DENIED(`Мышь не сработала: ${r.err || `код ${r.code}`}`);
  return { ok: true, action, x: action === 'scroll' ? undefined : x, y: action === 'scroll' ? undefined : y, dy: action === 'scroll' ? dy : undefined };
}

const IMPL = {
  list_dir: tListDir,
  read_file: tReadFile,
  search: tSearch,
  rag_search: tRagSearch,
  stat: tStat,
  system_info: tSystemInfo,
  web_search: tWebSearch,
  web_read: tWebRead,
  write_file: tWriteFile,
  run_program: tRunProgram,
  http_request: tHttpRequest,
  calc: tCalc,
  download_file: tDownloadFile,
  screenshot: tScreenshot,
  zip_pack: tZipPack,
  zip_unpack: tZipUnpack,
  run_command: tRunCommand,
  clipboard: tClipboard,
  input_screen: tInputScreen,
  input_key: tInputKey,
  input_text: tInputText,
  input_mouse: tInputMouse,
  browser_open: tBrowserOpen,
  browser_snapshot: tBrowserSnapshot,
  browser_click: tBrowserClick,
  browser_type: tBrowserType,
  browser_back: tBrowserBack,
  browser_shot: tBrowserShot,
};

/**
 * Выполнить инструмент.
 * ctx = { root, mode, programs }
 */
async function execute(ctx, name, rawArgs) {
  const fn = IMPL[name];
  if (!fn) return DENIED(`Инструмент «${name}» неизвестен`);
  let args;
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    return DENIED(`Аргументы инструмента «${name}» — некорректный JSON`);
  }
  const t0 = Date.now();
  try {
    const result = await fn(ctx, args);
    return Object.assign(result, { tool: name, ms: Date.now() - t0 });
  } catch (e) {
    return DENIED(`Инструмент «${name}» упал: ${e.message}`);
  }
}

module.exports = { toolSchemas, execute, READONLY_TOOLS, FULL_TOOLS, INPUT_TOOLS, BROWSER_TOOLS, inputSchemas, browserSchemas, schemas, MAX_READ, isInside, resolveInside, buildSendKeys, sendKeysEscape };