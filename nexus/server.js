'use strict';

/**
 * NEXUS — локальный сервер команды ИИ-агентов.
 * Только встроенные модули Node.js (http, fs, path, crypto).
 * Запуск: node server.js  →  http://localhost:3100
 * Пере-создание демо-данных: node server.js --reseed
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const providers = require('./lib/providers');
const toolsLib = require('./lib/tools');
const mcpLib = require('./lib/mcp');
const metrics = require('./lib/metrics');
const auth = require('./lib/auth');
const agentRuntime = require('./lib/agent');
const store = require('./lib/store');
const integrations = require('./lib/integrations');
const tgbridge = require('./lib/tgbridge');
const tgSchedule = require('./lib/schedule');
const rag = require('./lib/rag');

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.NEXUS_DATA
  ? path.resolve(process.env.NEXUS_DATA)
  : path.join(ROOT, 'data');
const RESEED = process.argv.includes('--reseed');
const BODY_LIMIT = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ утилиты */

const uid = (prefix) => prefix + '_' + crypto.randomBytes(4).toString('hex');
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const int = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isStr(v, min = 1, max = 500) {
  return typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra) {
  sendJSON(res, status, Object.assign({ error: message }, extra || {}));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(httpError(413, 'Тело запроса превышает 1 МБ'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const raw = (await readBody(req)).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('not object');
    return parsed;
  } catch {
    throw httpError(400, 'Некорректный JSON в теле запроса');
  }
}

/* ------------------------------------------------------------ демо-данные */

function seedTeamFile() {
  const now = Date.now();
  const ago = (mins) => new Date(now - mins * 60000).toISOString();
  return {
    team: {
      id: 'team_nexus',
      name: 'ИИ-Компания «Нексус»',
      description:
        'Целая ИИ-компания в одном окне: директор, разработка, исследования, тексты, цифры, инфраструктура, тесты, дизайн и поддержка. Задачу даёте команде — агенты совещаются, в чат падает готовый итог.',
      mission: 'Разработка',
      orchestration: 'hierarchy',
      /* Счётчики реальные: наполняются только фактическими прогонами.
         Заглушечных значений нет - иначе интерфейс показывает несуществующие расходы. */
      budgetSteps: 0,
      tasksCompleted: 0,
      tokens: 0,
      createdAt: ago(43200),
    },
    agents: [
      {
        id: 'ag_director',
        name: 'Директор',
        role: 'Директор',
        roleKey: 'assistant',
        accent: '#FBBF24',
        avatar: '🤵',
        model: 'gpt-5.2',
        temperature: 0.4,
        systemPrompt:
          'Ты — директор ИИ-компании. Разбираешь задачу на подзадачи, следишь за итогом и отвечаешь за результат. Говоришь кратко и по делу.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [50, 55, 60, 58, 64, 70, 66, 72, 78, 74, 80, 82],
        lastActive: ago(1),
      },
      {
        id: 'ag_archimedes',
        name: 'Архимед',
        role: 'Разработчик',
        roleKey: 'dev',
        accent: '#38E8FF',
        avatar: '🧑‍💻',
        model: 'claude-sonnet-4',
        temperature: 0.3,
        systemPrompt:
          'Ты — ведущий разработчик. Пишешь чистый, типизированный код, добавляешь тесты и объясняешь каждое решение одним абзацем.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [34, 52, 41, 66, 58, 72, 61, 80, 74, 69, 86, 78],
        lastActive: ago(1),
      },
      {
        id: 'ag_sapphire',
        name: 'Сапфир',
        role: 'Исследователь',
        roleKey: 'research',
        accent: '#8B5CF6',
        avatar: '🔎',
        model: 'gpt-5.2',
        temperature: 0.6,
        systemPrompt:
          'Ты — аналитик-исследователь. Собираешь факты из нескольких источников, сверяешь их и выдаёшь структурированную сводку со ссылками.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [22, 31, 47, 39, 55, 61, 52, 64, 58, 70, 66, 73],
        lastActive: ago(3),
      },
      {
        id: 'ag_logos',
        name: 'Логос',
        role: 'Редактор',
        roleKey: 'editor',
        accent: '#A3E635',
        avatar: '✍️',
        model: 'gpt-5.2-mini',
        temperature: 0.7,
        systemPrompt:
          'Ты — редактор. Проверяешь стиль, грамматику и тон, сохраняя авторский посыл. Правки даёшь списком: было → стало.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [61, 55, 72, 68, 81, 76, 88, 79, 91, 84, 89, 93],
        lastActive: ago(0),
      },
      {
        id: 'ag_graviton',
        name: 'Гравитон',
        role: 'Аналитик',
        roleKey: 'analyst',
        accent: '#60A5FA',
        avatar: '📊',
        model: 'claude-opus-4.1',
        temperature: 0.2,
        systemPrompt:
          'Ты — продуктовый аналитик. Строишь метрики, находишь аномалии и формулируешь выводы в терминах бизнеса, а не в терминах таблиц.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [40, 44, 38, 57, 63, 59, 71, 66, 77, 72, 81, 85],
        lastActive: ago(6),
      },
      {
        id: 'ag_kuznets',
        name: 'Кузнец',
        role: 'DevOps',
        roleKey: 'devops',
        accent: '#FBBF24',
        avatar: '🛠️',
        model: 'qwen3-coder',
        temperature: 0.1,
        systemPrompt:
          'Ты — инженер инфраструктуры. Деплоишь осторожно: сначала план и откат, потом действие. Каждый шаг логируешь.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [55, 48, 60, 42, 36, 44, 30, 25, 18, 12, 8, 4],
        lastActive: ago(41),
      },
      {
        id: 'ag_probe',
        name: 'Пробирка',
        role: 'Тестировщик',
        roleKey: 'tester',
        accent: '#2DD4BF',
        avatar: '🧪',
        model: 'gpt-5.2-mini',
        temperature: 0.4,
        systemPrompt:
          'Ты — тестировщик. Ломаешь всё, что движется: регресс, граничные случаи, шаги воспроизведения и важность каждого бага.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [45, 50, 48, 60, 55, 62, 70, 66, 74, 71, 78, 80],
        lastActive: ago(4),
      },
      {
        id: 'ag_pixel',
        name: 'Пиксель',
        role: 'Дизайнер',
        roleKey: 'designer',
        accent: '#E879F9',
        avatar: '🎨',
        model: 'gpt-5.2-mini',
        temperature: 0.7,
        systemPrompt:
          'Ты — дизайнер интерфейсов. Думаешь иерархией и сценариями, а не декором. Описываешь экраны структурой: шапка, контент, действия.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [58, 52, 63, 60, 68, 72, 69, 76, 73, 80, 77, 84],
        lastActive: ago(5),
      },
      {
        id: 'ag_echo',
        name: 'Эхо',
        role: 'Ассистент',
        roleKey: 'assistant',
        accent: '#F472B6',
        avatar: '🤖',
        model: 'gpt-5.2-mini',
        temperature: 0.5,
        systemPrompt:
          'Ты — ассистент поддержки. Отвечаешь быстро, дружелюбно и по делу. Эскалируешь сложные кейсы подходящему агенту.',
        status: 'online',
        currentTask: 'готов к задаче',
        permissions: {
          services: [],
          programs: [],
          mcp: [],
        },
        spark: [70, 66, 74, 69, 77, 82, 75, 88, 84, 90, 86, 92],
        lastActive: ago(2),
      },
    ],
    events: [
      { id: uid('ev'), t: ago(3), text: 'Гравитон: дашборд удержания опубликован', kind: 'ok' },
      { id: uid('ev'), t: ago(8), text: 'MCP-сервер mcp-browser переподключён', kind: 'ok' },
      { id: uid('ev'), t: ago(12), text: 'Логос выполняет: вычитка раздела «Тарифы»', kind: 'run' },
      { id: uid('ev'), t: ago(27), text: 'Сервис Google Drive отключён оператором', kind: 'warn' },
      { id: uid('ev'), t: ago(41), text: 'Кузнец ушёл в офлайн: агент на паузе', kind: 'warn' },
      { id: uid('ev'), t: ago(52), text: 'Сапфир завершила исследование: 14 источников', kind: 'ok' },
      { id: uid('ev'), t: ago(74), text: 'Сканирование ПК: найдено 8 программ', kind: 'system' },
      { id: uid('ev'), t: ago(96), text: 'Команда перезапущена после обновления конфигурации', kind: 'system' },
    ],
  };
}

/**
 * Убирает из seed заглушки, которые выдавали бы себя за реальную активность:
 * выдуманные разрешения, текущие задачи и статусы. Агенты появляются
 * «чистыми» - доступы и реальные статусы появляются после подключения
 * сервисов и фактических прогонов.
 */
function sanitizeSeedTeam(seed) {
  for (const a of seed.agents || []) {
    a.permissions = { services: [], programs: [], mcp: [], kb: [], input: false };
    a.currentTask = 'готов к задаче';
    a.status = 'online';
  }
  seed.events = [];
  return seed;
}

function seedServices() {
  /* Ключи не зашиты в код: сервисы стартуют неподключёнными, ключ задаёт пользователь. */
  return [
    { id: 'telegram', name: 'Telegram', icon: 'telegram', category: 'Мессенджеры', url: 'https://api.telegram.org', integrationId: 'telegram', status: 'disconnected', lastCheck: null },
    { id: 'gdrive', name: 'Google Drive', icon: 'cloud', category: 'Хранилища', url: 'https://www.googleapis.com/drive/v3', integrationId: 'gdrive', status: 'disconnected', lastCheck: null },
    { id: 'github', name: 'GitHub', icon: 'github', category: 'Код', url: 'https://api.github.com', integrationId: 'github', status: 'disconnected', lastCheck: null },
    { id: 'slack', name: 'Slack', icon: 'slack', category: 'Командная работа', url: 'https://slack.com/api', integrationId: 'slack', status: 'disconnected', lastCheck: null },
    { id: 'notion', name: 'Notion', icon: 'notion', category: 'Заметки', url: 'https://api.notion.com/v1', integrationId: 'notion', status: 'disconnected', lastCheck: null },
    { id: 'discord', name: 'Discord', icon: 'message', category: 'Мессенджеры', url: 'https://discord.com/api/v10', integrationId: 'discord', status: 'disconnected', lastCheck: null },
    { id: 'resend', name: 'Почта (Resend)', icon: 'mail', category: 'Почта', url: 'https://api.resend.com', integrationId: 'resend', status: 'disconnected', lastCheck: null },
    { id: 'jira', name: 'Jira', icon: 'checkSquare', category: 'Задачи', url: 'https://your-domain.atlassian.net', integrationId: 'jira', status: 'disconnected', lastCheck: null },
    { id: 'linear', name: 'Linear', icon: 'zap', category: 'Задачи', url: 'https://api.linear.app/graphql', integrationId: 'linear', status: 'disconnected', lastCheck: null },
    { id: 'airtable', name: 'Airtable', icon: 'layout', category: 'Таблицы', url: '', integrationId: 'airtable', status: 'disconnected', lastCheck: null },
    { id: 'supabase', name: 'Supabase', icon: 'database', category: 'Базы данных', url: '', integrationId: 'supabase', status: 'disconnected', lastCheck: null },
    { id: 'searxng', name: 'SearXNG (поиск)', icon: 'search', category: 'Поиск', url: '', integrationId: 'searxng', status: 'disconnected', lastCheck: null },
    { id: 'webhook', name: 'Webhook / HTTP', icon: 'plug', category: 'Прочее', url: '', integrationId: 'webhook', status: 'disconnected', lastCheck: null },
  ];
}

/**
 * MCP-серверы невозможно угадать за пользователя, а выдуманные записи
 * (несуществующие URL и команды) только мешают и врут в интерфейсе.
 * Поэтому список пустой: подключение - через «Настройки → MCP-серверы».
 */
function seedMcp() {
  return [];
}

/** Кандидаты известных программ: в сид попадает только то, что реально есть на диске. */
const PROGRAM_CANDIDATES = [
  { name: 'Visual Studio Code', path: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'] },
  { name: 'Cursor', path: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
  { name: 'PowerShell 7', path: ['%ProgramFiles%\\PowerShell\\7\\pwsh.exe'] },
  { name: 'Git', path: ['%ProgramFiles%\\Git\\cmd\\git.exe', '%ProgramFiles%\\Git\\bin\\git.exe'] },
  { name: 'Google Chrome', path: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe'] },
  { name: 'Firefox', path: ['%ProgramFiles%\\Mozilla Firefox\\firefox.exe'] },
  { name: 'Docker Desktop', path: ['%ProgramFiles%\\Docker\\Docker\\Docker Desktop.exe'] },
  { name: 'Notepad++', path: ['%ProgramFiles%\\Notepad++\\notepad++.exe'] },
  { name: '7-Zip', path: ['%ProgramFiles%\\7-Zip\\7z.exe'] },
  { name: 'FFmpeg', path: ['%ProgramFiles%\\ffmpeg\\bin\\ffmpeg.exe'] },
    { name: 'Microsoft Excel', path: ['%ProgramFiles%\\Microsoft Office\\root\\Office16\\EXCEL.EXE'] },
    { name: 'Microsoft Word', path: ['%ProgramFiles%\\Microsoft Office\\root\\Office16\\WINWORD.EXE'] },
    { name: 'Adobe Photoshop', path: ['%ProgramFiles%\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe', '%ProgramFiles%\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe', '%ProgramFiles%\\Adobe\\Adobe Photoshop 2023\\Photoshop.exe'] },
    { name: 'Blender', path: ['%ProgramFiles%\\Blender Foundation\\Blender 4.2\\blender.exe', '%ProgramFiles%\\Blender Foundation\\Blender 4.1\\blender.exe', '%ProgramFiles%\\Blender Foundation\\Blender 4.0\\blender.exe', '%ProgramFiles%\\Blender Foundation\\Blender 3.6\\blender.exe'] },
    { name: 'Obsidian', path: ['%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe'] },
  ];

/** Раскрываем %VAR% и проверяем, что файл действительно существует. */
function resolveEnvPath(p) {
  const expanded = String(p).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] || m);
  try {
    return fs.existsSync(expanded) ? expanded : null;
  } catch {
    return null;
  }
}

/**
 * Реальное сканирование установленных программ: известные пути + исполняемые
 * файлы в PATH. Возвращает только реально существующие файлы.
 */
function detectPrograms() {
  const found = new Map();
  const add = (name, p, source) => {
    if (!p || found.has(p)) return;
    found.set(p, {
      id: 'prg_' + (found.size + 1),
      name,
      path: p,
      perms: { run: true, read: true, write: false },
      source,
    });
  };

  for (const c of PROGRAM_CANDIDATES) {
    for (const p of c.path) {
      const real = resolveEnvPath(p);
      if (real) { add(c.name, real, 'scan'); break; }
    }
  }

  const fromPath = [
    { file: 'python.exe', name: 'Python' },
    { file: 'node.exe', name: 'Node.js' },
    { file: 'git.exe', name: 'Git' },
    { file: 'pwsh.exe', name: 'PowerShell 7' },
    { file: 'ffmpeg.exe', name: 'FFmpeg' },
    { file: 'curl.exe', name: 'curl' },
  ];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const it of fromPath) {
      const p = path.join(dir, it.file);
      try { if (fs.existsSync(p)) add(it.name, p, 'path'); } catch {}
    }
  }

  return [...found.values()];
}

function seedPrograms() {
  return detectPrograms();
}

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const seeds = {
    'team.json': () => sanitizeSeedTeam(seedTeamFile()),
    'services.json': seedServices,
    'programs.json': seedPrograms,
    'mcp.json': seedMcp,
    'kb.json': () => [],
  };
  for (const [file, make] of Object.entries(seeds)) {
    const p = path.join(DATA_DIR, file);
    if (RESEED || !fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(make(), null, 2));
      console.log(`[seed] создан ${path.join('data', file)}`);
    }
  }
  validateDataShapes();
  migrateServiceSecrets();
  ensureKnownServices();
  backfillAvatars();
  syncTeamStats();
  migrateFakeMcp();
  migrateFakeEvents();
  markMissingPrograms();
}

/**
 * Битые JSON-файлы (пустые, обрезанные после сбоя, не той формы) чиним сами:
 * бэкапим в *.bak и пересеиваем. Иначе интерфейс падает с
 * «Cannot read properties of null» на ровном месте.
 */
function validateDataShapes() {
  const team = readJSONFile('team.json');
  if (!team || typeof team.team !== 'object' || !team.team || !Array.isArray(team.agents)) {
    backupCorrupt('team.json');
    writeJSONFile('team.json', sanitizeSeedTeam(seedTeamFile()));
    console.log('[seed] team.json был повреждён — создан заново из сида');
  }
  for (const f of ['services.json', 'programs.json', 'mcp.json', 'kb.json']) {
    const v = readJSONFile(f);
    if (!Array.isArray(v)) {
      backupCorrupt(f);
      const maker = f === 'services.json' ? seedServices : f === 'programs.json' ? seedPrograms : f === 'kb.json' ? (() => []) : seedMcp;
      writeJSONFile(f, maker());
      console.log(`[seed] ${f} был повреждён — создан заново из сида`);
    }
  }
}

function backupCorrupt(file) {
  try {
    const p = path.join(DATA_DIR, file);
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, path.join(DATA_DIR, `${file}.${Date.now()}.bak`));
    }
  } catch { /* бэкап не обязателен */ }
}
const FAKE_EVENT_SEEDS = [
  'Гравитон: дашборд удержания опубликован',
  'MCP-сервер mcp-browser переподключён',
  'Логос выполняет: вычитка раздела «Тарифы»',
  'Сервис Google Drive отключён оператором',
  'Кузнец ушёл в офлайн: агент на паузе',
  'Сапфир завершила исследование: 14 источников',
  'Сканирование ПК: найдено 8 программ',
  'Команда перезапущена после обновления конфигурации',
];

function migrateFakeEvents() {
  const p = path.join(DATA_DIR, 'team.json');
  if (!fs.existsSync(p)) return;
  const data = readJSONFile('team.json');
  if (!data || !Array.isArray(data.events)) return;

  const kept = data.events.filter((e) => !FAKE_EVENT_SEEDS.includes(e.text));
  const removed = data.events.length - kept.length;
  if (!removed) return;
  data.events = kept;
  writeJSONFile('team.json', data);
  console.log(`[migrate] удалено выдуманных событий: ${removed}`);
}

/**
 * Старый сид содержал выдуманные MCP-серверы (несуществующие домены и команды)
 * с правдоподобными логами и списками инструментов. Убираем именно их,
 * трогая только записи, совпадающие с теми фиктивными целями.
 */
const FAKE_MCP_SEEDS = [
  'npx -y @modelcontextprotocol/server-github',
  'npx -y @modelcontextprotocol/server-filesystem D:\\projects',
  'npx -y @modelcontextprotocol/server-postgres postgresql://nexus.local/nexus',
  'https://mcp.slack.internal/sse',
  'http://127.0.0.1:8931/mcp',
];

function migrateFakeMcp() {
  const p = path.join(DATA_DIR, 'mcp.json');
  if (!fs.existsSync(p)) return;
  const list = readJSONFile('mcp.json');
  if (!Array.isArray(list) || !list.length) return;

  const kept = list.filter((m) => !FAKE_MCP_SEEDS.includes(String(m.target || '').trim()));
  if (kept.length === list.length) return;
  writeJSONFile('mcp.json', kept);
  console.log(`[migrate] удалено фиктивных MCP-серверов: ${list.length - kept.length}`);
}

/** Программы, чей файл сейчас недоступен, НЕ удаляем (данные пользователя),
 * а помечаем флагом missing — в интерфейсе виден бейдж «файл не найден»,
 * запуск таких программ блокируется с понятной ошибкой. */
function markMissingPrograms() {
  const p = path.join(DATA_DIR, 'programs.json');
  if (!fs.existsSync(p)) return;
  const list = readJSONFile('programs.json');
  if (!Array.isArray(list) || !list.length) return;

  let changed = false;
  for (const x of list) {
    let exists = false;
    try { exists = !!x.path && fs.existsSync(x.path); } catch { exists = false; }
    if (!!x.missing === exists) { x.missing = !exists; changed = true; }
  }
  if (!changed) return;
  writeJSONFile('programs.json', list);
  const n = list.filter((x) => x.missing).length;
  if (n) console.log(`[programs] недоступных файлов: ${n} — помечены, не удалены`);
}

/**
 * Счётчики токенов и задач - производные от журнала прогонов, а не отдельные
 * счётчики: так они не могут разойтись с реальностью.
 * В старых версиях team.json был заполнен демо-значениями (4.8 млн токенов),
 * из-за чего интерфейс показывал расходы, которых не было.
 * Каждый запуск приводит team.json к фактическим totals.
 */
function syncTeamStats() {
  const p = path.join(DATA_DIR, 'team.json');
  if (!fs.existsSync(p)) return;
  const data = readJSONFile('team.json');
  const t = data && data.team;
  if (!t) return;

  const s = metrics.stats();
  const tokens = Math.max(0, Math.round(s.totals.totalTokens || 0));
  const tasks = Math.max(0, Math.round(s.totals.ok || 0));

  if (t.tokens !== tokens || t.tasksCompleted !== tasks) {
    t.tokens = tokens;
    t.tasksCompleted = tasks;
    writeJSONFile('team.json', data);
    console.log(`[счётчики] токены=${tokens}, задачи=${tasks} (по журналу прогонов)`);
  }
}

/**
 * Новые интеграции из свежих версий: дописываем отсутствующие сервисы
 * в services.json, чтобы они появились в Подключениях без пересоздания данных.
 */
function ensureKnownServices() {
  const list = readJSONFile('services.json');
  if (!Array.isArray(list)) return;
  const have = new Set(list.map((s) => s && s.id));
  const fresh = seedServices().filter((s) => !have.has(s.id));
  if (!fresh.length) return;
  for (const s of fresh) list.push(s);
  writeJSONFile('services.json', list);
  console.log(`[migrate] добавлены новые сервисы: ${fresh.map((s) => s.id).join(', ')}`);
}

/* Весёлые эмодзи-аватары старым агентам, у которых их ещё нет. */
const AVATAR_BY_ROLE = {
  dev: '🧑‍💻', research: '🔎', editor: '✍️', analyst: '📊',
  devops: '🛠️', assistant: '🤖', tester: '🧪', designer: '🎨',
};

function backfillAvatars() {
  const data = readJSONFile('team.json');
  if (!data || !Array.isArray(data.agents)) return;
  let changed = false;
  for (const a of data.agents) {
    if (!a.avatar && AVATAR_BY_ROLE[a.roleKey]) {
      a.avatar = AVATAR_BY_ROLE[a.roleKey];
      changed = true;
    }
    /* Поле привязки баз знаний у старых агентов */
    if (a.permissions && !Array.isArray(a.permissions.kb)) {
      a.permissions.kb = [];
      changed = true;
    }
  }
  if (changed) {
    writeJSONFile('team.json', data);
    console.log('[migrate] агентам выданы эмодзи-аватары');
  }
}

/**
 * Старые версии хранили ключи сервисов открытым текстом в services.json.
 * Переносим их в шифротекст; нерабочие демо-ключи из seed удаляем.
 */
function migrateServiceSecrets() {
  const list = readJSONFile('services.json');
  if (!Array.isArray(list)) return;
  let changed = false;
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;

    /* Демо-ключи из прежнего seed не рабочие — не шифруем, а убираем. */
    if (typeof s.apiKey === 'string' && s.apiKey && /demo|local|nexus_demo/i.test(s.apiKey)) {
      delete s.apiKey;
      s.keyCipher = '';
      s.status = 'disconnected';
      s.lastCheckOk = false;
      s.checkDetail = 'ключ не задан';
      changed = true;
      continue;
    }

    if (typeof s.apiKey === 'string' && s.apiKey) {
      s.keyCipher = s.keyCipher || store.encrypt(s.apiKey);
      s.status = s.status === 'connected' ? 'connected' : 'disconnected';
      changed = true;
    }

    /* Пустое поле тоже убираем: ключ хранится только в шифротексте */
    if ('apiKey' in s && !s.apiKey) {
      delete s.apiKey;
      changed = true;
    }

    if (!s.integrationId) {
      const guess = integrations.get(s.id) ? s.id : null;
      if (guess) { s.integrationId = guess; changed = true; }
    }
  }
  if (changed) {
    writeJSONFile('services.json', list);
    console.log('[migrate] ключи сервисов перенесены в data/.secret');
  }
}

/* Чтение/запись данных — через единое хранилище lib/store (общий кэш и очередь). */

function readJSONFile(file) {
  const value = store.read(file, null);
  return value && typeof value === 'object' ? value : null;
}

function writeJSONFile(file, data) {
  return store.write(file, data);
}

/* ---------------------------------------------------------------- API: team */

function normalizeAgent(input, existing) {
  const a = Object.assign({}, existing || {}, input);
  if (!isStr(a.name, 1, 40)) throw httpError(400, 'Агент: «Имя» — от 1 до 40 символов');
  if (!isStr(a.role, 1, 40)) throw httpError(400, 'Агент: «Роль» — от 1 до 40 символов');
  a.name = a.name.trim();
  a.role = a.role.trim();
  /* Привязка к настроенному провайдеру: agentConfigId — точная настройка, providerId — семейство */
  a.providerConfigId = isStr(a.providerConfigId, 1, 60) ? a.providerConfigId : null;
  a.providerId = isStr(a.providerId, 1, 40) ? a.providerId : null;
  if (!a.providerId && a.providerConfigId) {
    const conf = readJSONFile('config.json') || { providers: [] };
    const entry = (conf.providers || []).find((p) => p.id === a.providerConfigId);
    if (entry) a.providerId = entry.providerId;
  }
  a.model = typeof a.model === 'string' && a.model.trim() ? a.model.trim().slice(0, 60) : 'gpt-5.2-mini';
  a.temperature = clamp(Number(a.temperature) || 0, 0, 1);
  a.systemPrompt = typeof a.systemPrompt === 'string' ? a.systemPrompt.slice(0, 2000) : '';
  a.status = ['online', 'busy', 'offline'].includes(a.status) ? a.status : 'online';
  a.currentTask = typeof a.currentTask === 'string' ? a.currentTask.slice(0, 140) : 'готов к задаче';
  a.roleKey = isStr(a.roleKey, 1, 30) ? a.roleKey : 'assistant';
  a.accent = typeof a.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(a.accent) ? a.accent : '#38E8FF';
  /* Весёлый эмодзи-аватар агента (показывается в команде, чате и Telegram). */
  a.avatar = typeof a.avatar === 'string' ? [...a.avatar.trim()].slice(0, 3).join('').slice(0, 12) : '';
  if (!Array.isArray(a.spark) || !a.spark.length) a.spark = Array.from({ length: 12 }, () => int(20, 80));
  a.spark = a.spark.slice(-12).map((n) => clamp(Number(n) || 0, 0, 100));
  const perm = a.permissions && typeof a.permissions === 'object' ? a.permissions : {};
  const strArr = (v) => (Array.isArray(v) ? v.filter((s) => isStr(s, 1, 60)).slice(0, 40) : []);
  /* input — явное разрешение на мост ввода (клавиатура/мышь). По умолчанию выключено. */
  a.permissions = { services: strArr(perm.services), programs: strArr(perm.programs), mcp: strArr(perm.mcp), kb: strArr(perm.kb), input: perm.input === true };
  a.lastActive = typeof a.lastActive === 'string' ? a.lastActive : new Date().toISOString();
  return a;
}

function normalizeTeamPatch(patch) {
  const t = {};
  if (patch.name !== undefined) {
    if (!isStr(patch.name, 1, 60)) throw httpError(400, 'Команда: «Имя» — от 1 до 60 символов');
    t.name = patch.name.trim();
  }
  if (patch.description !== undefined) t.description = String(patch.description).slice(0, 280);
  if (patch.mission !== undefined) {
    if (!isStr(patch.mission, 1, 40)) throw httpError(400, 'Команда: «Миссия» — от 1 до 40 символов');
    t.mission = patch.mission.trim();
  }
  if (patch.orchestration !== undefined) {
    if (!['parallel', 'sequential', 'hierarchy'].includes(patch.orchestration))
      throw httpError(400, 'Команда: схема оркестрации — parallel | sequential | hierarchy');
    t.orchestration = patch.orchestration;
  }
  if (patch.budgetSteps !== undefined) {
    const b = Number(patch.budgetSteps);
    if (!Number.isFinite(b) || b < 1 || b > 1000) throw httpError(400, 'Команда: бюджет шагов — 1…1000');
    t.budgetSteps = Math.round(b);
  }
  if (patch.workspace !== undefined) {
    /* Рабочая папка команды: выбирает владелец при создании. Только существующая папка. */
    const w = String(patch.workspace || '').trim();
    if (!w) {
      t.workspace = '';
    } else {
      if (w.length > 300) throw httpError(400, 'Команда: путь слишком длинный');
      if (!path.isAbsolute(w)) throw httpError(400, 'Команда: укажите полный путь к папке, например D:\\проекты\\бот');
      let st = null;
      try {
        st = fs.statSync(w);
      } catch {
        st = null;
      }
      if (!st || !st.isDirectory()) throw httpError(400, `Команда: папка не найдена: ${w}`);
      t.workspace = w;
    }
  }
  return t;
}

function handleTeam(req, res) {
  if (req.method === 'GET') {
    const data = readJSONFile('team.json');
    if (!data) throw httpError(500, 'Файл data/team.json повреждён или отсутствует');
    return sendJSON(res, 200, data);
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  return readJSON(req).then((body) => {
    const existingTeam = readJSONFile('team.json');
/* Очищаем только заглушки; реальные данные команды не трогаем */
const data = existingTeam || sanitizeSeedTeam(seedTeamFile());
    let changed = false;

    if (body.team !== undefined) {
      Object.assign(data.team, normalizeTeamPatch(body.team));
      changed = true;
    }
    if (body.agents !== undefined) {
      if (!Array.isArray(body.agents)) throw httpError(400, 'agents — должен быть массивом');
      if (body.agents.length > 12) throw httpError(400, 'Максимум 12 агентов в команде');
      const used = new Set();
      data.agents = body.agents.map((input) => {
        const a = normalizeAgent(input, null);
        a.id = a.id && isStr(a.id, 3, 40) && !used.has(a.id) ? a.id : uid('ag');
        used.add(a.id);
        if (a.status === 'busy') a.status = 'online';
        return a;
      });
      changed = true;
    }
    if (body.agent !== undefined) {
      const input = body.agent;
      const idx = input.id ? data.agents.findIndex((a) => a.id === input.id) : -1;
      const agent = normalizeAgent(input, idx >= 0 ? data.agents[idx] : null);
      if (idx >= 0) data.agents[idx] = agent;
      else {
        agent.id = agent.id && isStr(agent.id, 3, 40) ? agent.id : uid('ag');
        data.agents.push(agent);
      }
      changed = true;
    }
    if (body.removeAgentId !== undefined) {
      if (!isStr(body.removeAgentId, 3, 40)) throw httpError(400, 'removeAgentId: некорректный id');
      const before = data.agents.length;
      data.agents = data.agents.filter((a) => a.id !== body.removeAgentId);
      if (data.agents.length === before) throw httpError(404, `Агент «${body.removeAgentId}» не найден`);
      changed = true;
    }
    if (body.event !== undefined) {
      const e = body.event;
      if (!isStr(e && e.text, 1, 200)) throw httpError(400, 'event.text — от 1 до 200 символов');
      data.events = data.events || [];
      data.events.unshift({
        id: uid('ev'),
        t: new Date().toISOString(),
        text: e.text.slice(0, 200),
        kind: ['ok', 'warn', 'run', 'system'].includes(e.kind) ? e.kind : 'system',
      });
      data.events = data.events.slice(0, 60);
      changed = true;
    }
    if (!changed) throw httpError(400, 'Пустой запрос: ожидается team, agent, removeAgentId или event');

    writeJSONFile('team.json', data);
    sendJSON(res, 200, data);
  });
}

/* ------------------------------------------------------- API: ресурсы списка */

const RESOURCES = {
  services: {
    file: 'services.json',
    public: publicServices,
    validate(item, existing) {
      const o = Object.assign({}, existing || {}, item);
      if (!isStr(o.name, 1, 40)) throw httpError(400, 'Сервис: «Имя» — от 1 до 40 символов');
      o.name = o.name.trim();
      o.icon = isStr(o.icon, 1, 30) ? o.icon : 'custom';
      o.category = isStr(o.category, 1, 40) ? o.category.trim() : 'Прочее';
      o.url = typeof o.url === 'string' ? o.url.slice(0, 200) : '';
      o.integrationId = integrations.get(item.integrationId)
        ? item.integrationId
        : (integrations.get(o.id) ? o.id : null);
      o.extra = o.extra && typeof o.extra === 'object' && !Array.isArray(o.extra) ? o.extra : {};

      /* Ключ наружу не отдаётся: наружу — только отпечаток */
      const key = typeof item.apiKey === 'string' ? item.apiKey.trim() : '';
      if (key) o.keyCipher = store.encrypt(key.slice(0, 400));
      /* Интеграции без ключа (локальный Obsidian): ключ не требуется вовсе */
      const keyless = (integrations.get(o.integrationId || o.id) || {}).keyRequired === false;
      if (!o.keyCipher && !keyless) throw httpError(400, 'Сервис: задайте API-ключ');
      delete o.apiKey;

      o.status = o.lastCheckOk === true ? 'connected' : 'disconnected';
      o.lastCheck = typeof o.lastCheck === 'string' ? o.lastCheck : null;
      o.checkDetail = typeof o.checkDetail === 'string' ? o.checkDetail.slice(0, 300) : '';
      return o;
    },
  },
  programs: {
    file: 'programs.json',
    validate(item, existing) {
      const o = Object.assign({ perms: {} }, existing || {}, item);
      if (!isStr(o.name, 1, 60)) throw httpError(400, 'Программа: «Имя» — от 1 до 60 символов');
      if (!isStr(o.path, 3, 300)) throw httpError(400, 'Программа: «Путь» — от 3 до 300 символов');
      o.name = o.name.trim();
      o.path = o.path.trim();
      const p = o.perms && typeof o.perms === 'object' ? o.perms : {};
      o.perms = { run: !!p.run, read: !!p.read, write: !!p.write };
      o.source = ['scan', 'manual'].includes(o.source) ? o.source : 'manual';
      /* Существование файла проверяем, но не запрещаем: недоступные помечаются */
      let exists = false;
      try { exists = fs.existsSync(o.path); } catch { exists = false; }
      o.missing = !exists;
      return o;
    },
  },
  mcp: {
    file: 'mcp.json',
    validate(item, existing) {
      const o = Object.assign({ tools: [], log: [] }, existing || {}, item);
      if (!isStr(o.name, 1, 60)) throw httpError(400, 'MCP: «Имя» — от 1 до 60 символов');
      if (!['stdio', 'sse', 'http'].includes(o.transport)) throw httpError(400, 'MCP: транспорт — stdio | sse | http');
      if (!isStr(o.target, 2, 300)) throw httpError(400, 'MCP: «Команда/URL» — от 2 до 300 символов');
      o.name = o.name.trim();
      o.target = o.target.trim();
      o.status = ['connected', 'off', 'error', 'connecting'].includes(o.status) ? o.status : 'off';
      /* Список инструментов заполняется автоматически при реальном handshake:
         вводить его руками не нужно, поле только показывается в интерфейсе. */
      o.tools = Array.isArray(o.tools) ? o.tools.filter((s) => isStr(s, 1, 40)).slice(0, 200) : [];

      /* Переменные окружения для stdio-серверов (токены и т.п.) */
      if (o.env !== undefined) {
        if (o.env === null || o.env === '') delete o.env;
        else if (typeof o.env === 'object' && !Array.isArray(o.env)) {
          const clean = {};
          let n = 0;
          for (const [k, v] of Object.entries(o.env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(k)) continue;
            if (n >= 30) break;
            clean[k] = String(v == null ? '' : v).slice(0, 500);
            n++;
          }
          o.env = clean;
        } else throw httpError(400, 'MCP: env должен быть объектом «ПЕРЕМЕННАЯ=значение»');
      }

      /* Заголовки для http/sse (Bearer-токены и пр.) */
      if (o.headers !== undefined) {
        if (o.headers === null || o.headers === '') delete o.headers;
        else if (typeof o.headers === 'object' && !Array.isArray(o.headers)) {
          const clean = {};
          let n = 0;
          for (const [k, v] of Object.entries(o.headers)) {
            if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(k)) continue;
            if (n >= 20) break;
            clean[k] = String(v == null ? '' : v).slice(0, 500);
            n++;
          }
          o.headers = clean;
        } else throw httpError(400, 'MCP: headers должен быть объектом');
      }

      o.log = Array.isArray(o.log)
        ? o.log.slice(-40).map((l) => ({
            t: typeof l.t === 'string' ? l.t : new Date().toISOString(),
            line: String(l.line || '').slice(0, 300),
            level: ['info', 'ok', 'warn', 'err'].includes(l.level) ? l.level : 'info',
          }))
        : [];
      return o;
    },
  },
};

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow.join(', '));
  sendError(res, 405, `Метод не поддерживается. Допустимые: ${allow.join(', ')}`);
}

function handleResource(req, res, name) {
  const cfg = RESOURCES[name];
if (req.method === 'GET') {
    const data = readJSONFile(cfg.file);
    if (!data) throw httpError(500, `Файл data/${cfg.file} недоступен или повреждён`);
    return sendJSON(res, 200, cfg.public ? cfg.public(data) : data);
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  return readJSON(req).then((body) => {
    const list = readJSONFile(cfg.file) || [];
    if (body.removeId !== undefined) {
      if (!isStr(body.removeId, 1, 60)) throw httpError(400, 'removeId: некорректный id');
      const idx = list.findIndex((x) => x.id === body.removeId);
      if (idx < 0) throw httpError(404, `Запись «${body.removeId}» не найдена в ${name}`);
      list.splice(idx, 1);
      writeJSONFile(cfg.file, list);
      return sendJSON(res, 200, list);
    }
    if (body.item !== undefined) {
      const input = body.item;
      const idx = input.id ? list.findIndex((x) => x.id === input.id) : -1;
      const item = cfg.validate(input, idx >= 0 ? list[idx] : null);
      if (idx >= 0) list[idx] = item;
      else {
        item.id = item.id && isStr(item.id, 1, 60) ? item.id : uid(name.slice(0, 3));
        list.push(item);
      }
      writeJSONFile(cfg.file, list);
      return sendJSON(res, 200, list);
    }
    throw httpError(400, 'Пустой запрос: ожидается item или removeId');
  });
}

/* --------------------------------------------- API: проверка сервиса/переподкл. */

/** Реальная проверка: сервисы с apiKey проверяем через провайдера из config.json. */
function handleServiceCheck(req, res, id) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async () => {
    const list = readJSONFile('services.json') || [];
    const svc = list.find((s) => s.id === id);
    if (!svc) throw httpError(404, `Сервис «${id}» не найден`);

    const conf = readJSONFile('config.json') || { providers: [] };
    const entry = (conf.providers || []).find((p) => p.serviceId === id);
    let out;

    if (entry) {
      /* Сервис привязан к LLM-провайдеру — проверяем сам провайдер */
      try {
        const cfg = providers.buildConfig(entry, null);
        const r = await providers.verify(entry);
        out = { ok: true, latencyMs: r.latencyMs, detail: `${cfg.providerName}: ${r.detail}`, models: r.models };
      } catch (e) {
        out = { ok: false, latencyMs: 0, detail: e.message, error: true };
      }
    } else {
      /* Обычный сервис: живой запрос к его API (Telegram, Drive, Slack, …) */
      const it = integrations.get(svc.integrationId || svc.id);
      if (!it) {
        out = {
          ok: false,
          latencyMs: 0,
          detail: svc.id === 'ollama'
            ? 'Локальный Ollama проверяется в разделе «Провайдеры LLM»'
            : 'Для этого сервиса нет готового коннектора — добавьте интеграцию «Webhook / HTTP»',
        };
      } else if (!store.decrypt(svc.keyCipher || '') && (integrations.get(svc.integrationId || svc.id) || {}).keyRequired !== false) {
        out = { ok: false, latencyMs: 0, detail: 'не задан API-ключ' };
      } else {
        out = await integrations.verify(it.id, serviceCreds(svc));
      }
    }

    saveServiceCheck(svc, out);
    writeJSONFile('services.json', list);
    sendJSON(res, 200, { id: svc.id, status: svc.status, ...out });
  });
}

/** Каталог доступных интеграций: что вводить и какие операции отдаются агенту. */
function handleIntegrationsCatalog(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const list = readJSONFile('services.json') || [];
  const configured = new Set(list.map((s) => s.integrationId || s.id));
  sendJSON(res, 200, {
    integrations: integrations.catalog().map((i) => ({ ...i, configured: configured.has(i.id) })),
  });
}

/** Ручной вызов операции сервиса из интерфейса (проверка входных данных). */
function handleServiceAction(req, res, id) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const list = readJSONFile('services.json') || [];
    const svc = list.find((s) => s.id === id);
    if (!svc) throw httpError(404, `Сервис «${id}» не найден`);

    const it = integrations.get(svc.integrationId || svc.id);
    if (!it) throw httpError(400, `У сервиса «${svc.name}» нет коннектора`);
    if (!isStr(body.action, 1, 60)) throw httpError(400, 'Не указана операция');
    const act = it.actions.find((a) => a.name === body.action);
    if (!act) throw httpError(400, `У сервиса «${svc.name}» нет операции «${body.action}»`);
    if (!store.decrypt(svc.keyCipher || '') && (it.keyRequired !== false)) throw httpError(400, 'Сначала задайте API-ключ сервиса');

    const cfg = readJSONFile('config.json') || { providers: [] };
    const mode = (cfg.access && cfg.access.mode) === 'full' ? 'full' : 'readonly';
    if (act.write && mode !== 'full') {
      throw httpError(403, `«${act.label}» меняет данные — включите режим «полный доступ» в Настройках → Доступ`);
    }

    const out = await integrations.runAction(it.id, act.name, serviceCreds(svc), body.args || {});
    if (out.ok) saveServiceCheck(svc, { ok: true, detail: `${act.label}: ок`, latencyMs: out.latencyMs });
    writeJSONFile('services.json', list);
    if (!out.ok) {
      sendJSON(res, 200, { id: svc.id, ok: false, action: act.name, error: out.error, latencyMs: out.latencyMs });
      return;
    }
    sendJSON(res, 200, { id: svc.id, ok: true, action: act.name, result: out.result, latencyMs: out.latencyMs });
  });
}

/** Реальный handshake MCP: tools/list и живой лог обмена. */
/**
 * Проверка MCP-сервера без сохранения: настоящий handshake (initialize +
 * tools/list). Нужен, чтобы пользователь увидел реальный список инструментов
 * до того, как сервер появится в mcp.json.
 */
async function handleMcpTest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const draft = RESOURCES.mcp.validate(body, null);
    draft.id = '__probe__';
    let out;
    try {
      out = await mcpLib.probe(draft);
    } catch (e) {
      out = { ok: false, error: e.message, tools: [], log: mcpLib.getLog('__probe__') };
    } finally {
      mcpLib.disconnect('__probe__');
    }
    const ok = !!(out && out.ok);
    sendJSON(res, 200, {
      ok,
      tools: out.tools || [],
      serverName: (out.serverInfo && out.serverInfo.name) || '',
      error: ok ? '' : out.error || 'сервер не ответил',
      log: (out.log || []).slice(-40),
    });
  });
}

async function handleMcpReconnect(req, res, id) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const list = readJSONFile('mcp.json') || [];
  const m = list.find((x) => x.id === id);
  if (!m) throw httpError(404, `MCP-сервер «${id}» не найден`);

  m.status = 'connecting';
  writeJSONFile('mcp.json', list);
  let out;
  try {
    /* reconnect() возвращает объект сессии, а не результат проверки,
       поэтому проверяем через probe(): он отдаёт ok/tools/serverInfo/log. */
    await mcpLib.reconnect(m);
    out = await mcpLib.probe(m);
  } catch (e) {
    out = { ok: false, error: e.message, tools: [], log: mcpLib.getLog(id) };
  }

  m.status = out.ok ? 'connected' : 'error';
  m.tools = out.tools || [];
  m.log = (out.log || []).slice(-40);
  if (out.serverInfo && out.serverInfo.name) m.serverName = String(out.serverInfo.name).slice(0, 60);
  writeJSONFile('mcp.json', list);
  sendJSON(res, 200, {
    id: m.id,
    ok: out.ok === true,
    status: m.status,
    tools: m.tools,
    serverName: m.serverName || '',
    error: out.ok ? '' : out.error || 'сервер не ответил',
    latencyMs: out.latencyMs,
    log: m.log,
  });
}


/* -------------------------------------------------- API: прогон агента (NDJSON) */

const running = new Map();

const DEFAULT_TASKS = {
  dev: 'проверь структуру проекта и предложи конкретные улучшения',
  research: 'собери и структурируй сводку по материалам рабочей папки',
  editor: 'вычитай тексты и исправь явные ошибки в найденных файлах',
  analyst: 'проанализируй данные проекта и покажи ключевые числа',
  devops: 'проверь состояние узла и составь план действий',
  assistant: 'разбери входящие задачи и предложи порядок работы',
  tester: 'найди потенциальные проблемы и составь чек-лист проверок',
  designer: 'опиши, что стоит улучшить в структуре интерфейса',
  pm: 'разбей цель на задачи и расставь приоритеты',
  marketer: 'придумай 5 заголовков и план продвижения',
  translator: 'переведи текст, сохранив стиль',
  mentor: 'объясни тему простыми словами с примерами',
  custom: 'выполни задачу команды и отчитайся о результате',
  default: 'выполни задачу команды и отчитайся о результате',
};

/**
 * Реальный прогон агента: LLM вызов + выполнение инструментов.
 * Поток NDJSON в UI, реальный usage/cost — в журнал data/runs.json.
 */
async function handleAgentRun(req, res, agentId) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (running.has(agentId)) throw httpError(409, 'Агент уже выполняет задачу');

  const body = await readJSON(req);
  const data = readJSONFile('team.json');
  if (!data) throw httpError(500, 'Файл data/team.json повреждён');
  const agent = data.agents.find((a) => a.id === agentId);
  if (!agent) throw httpError(404, `Агент «${agentId}» не найден`);

  let task;
  if (body.task === undefined || body.task === null || body.task === '') {
    task = DEFAULT_TASKS[agent.roleKey] || DEFAULT_TASKS.default;
  } else if (isStr(body.task, 1, 2000)) {
    task = body.task.trim();
  } else {
    throw httpError(400, 'task — от 1 до 2000 символов');
  }

  /* Вложения: пути вида uploads/x.png внутри рабочей папки (макс. 10).
     Проверяем каждый путь через jail, иначе 400. */
  let attachments = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) throw httpError(400, 'attachments — должен быть массивом путей');
    const conf0 = auth.config();
    const team0 = readJSONFile('team.json');
    const teamRoot0 = team0 && team0.team && typeof team0.team.workspace === 'string' && team0.team.workspace.trim()
      ? team0.team.workspace.trim()
      : '';
    const root0 = teamRoot0 || conf0.access.workspace || DATA_DIR;
    attachments = body.attachments.slice(0, 10).map((p) => {
      if (!isStr(p, 1, 300)) throw httpError(400, 'attachments: путь — от 1 до 300 символов');
      const r = toolsLib.resolveInside(root0, p.trim());
      if (r.error) throw httpError(400, `attachments: ${r.error}`);
      return path.relative(root0, r.path).replace(/\\/g, '/');
    });
  }

  const conf = auth.config();
  if (conf.access.allowRemoteRun === false && !auth.isLocalRequest(req)) {
    throw httpError(403, 'Запуск агентов с удалённых устройств отключён в настройках доступа');
  }

  const ctrl = new AbortController();
  running.set(agentId, ctrl);
  const prevStatus = agent.status;

  agent.status = 'busy';
  agent.currentTask = task.slice(0, 140);
  agent.lastActive = new Date().toISOString();
  writeJSONFile('team.json', data);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  req.on('aborted', () => {
    closed = true;
    ctrl.abort();
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      ctrl.abort();
    }
  });

  const emit = (ev) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(JSON.stringify(Object.assign({ ts: Date.now(), agentId }, ev)) + '\n');
    } catch {}
  };

  let outcome = null;
  let failure = null;

  try {
    outcome = await agentRuntime.run({ agent, task, emit, signal: ctrl.signal, attachments });
  } catch (e) {
    failure = e;
    emit({ type: 'line', level: 'err', text: `сбой: ${e.message}` });
  }

  const startedRunAt = Date.now();
  const usage = (outcome && outcome.usage) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const durationMs = outcome ? outcome.durationMs : Date.now() - startedRunAt;

  try {
    await metrics.recordRun({
      agentId: agent.id,
      agentName: agent.name,
      task,
      status: failure ? 'failed' : 'ok',
      provider: outcome ? outcome.provider : '',
      model: outcome ? outcome.model : agent.model,
      usage,
      costUsd: outcome ? outcome.costUsd : 0,
      durationMs,
      ttftMs: outcome ? outcome.ttftMs : 0,
      steps: outcome ? outcome.steps : 0,
      toolCalls: outcome ? outcome.toolCalls : 0,
      error: failure ? failure.message : null,
      toolLog: outcome ? outcome.toolLog : [],
    });
  } catch (e) {
    emit({ type: 'line', level: 'err', text: `журнал: не записался (${e.message})` });
  }

  try {
    // восстановление состояния агента и статистики команды
    const fresh = readJSONFile('team.json') || data;
  const a = fresh.agents.find((x) => x.id === agentId);
  if (a) {
    a.status = prevStatus === 'offline' ? 'online' : prevStatus === 'busy' ? 'online' : prevStatus;
    a.currentTask = failure ? 'ошибка выполнения' : 'готов к задаче';
    a.lastActive = new Date().toISOString();
  }
  fresh.events = fresh.events || [];
  fresh.events.unshift({
    id: uid('ev'),
    t: new Date().toISOString(),
    text: failure
      ? `${agent.name}: ошибка — ${failure.message.slice(0, 120)}`
      : `${agent.name}: «${task.slice(0, 60)}» за ${(durationMs / 1000).toFixed(1)} с · ${usage.totalTokens} токенов`,
    kind: failure ? 'warn' : 'ok',
  });
  fresh.events = fresh.events.slice(0, 60);
  /* Счётчики всегда равны журналу прогонов, а не копятся отдельно:
     запись о прогоне уже сделана в metrics.recordRun выше. */
  const totals = metrics.stats().totals;
  fresh.team.tasksCompleted = Math.max(0, Math.round(totals.ok || 0));
  fresh.team.tokens = Math.max(0, Math.round(totals.totalTokens || 0));
  writeJSONFile('team.json', fresh);

  if (!closed) {
    emit({
      type: 'done',
      agentId,
      /* Готовый ответ целиком: чат показывает его, консоль — весь ход работы */
      text: outcome ? outcome.text : '',
      stats: {
        tokens: usage.totalTokens,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: outcome ? outcome.costUsd : 0,
        steps: outcome ? outcome.steps : 0,
        toolCalls: outcome ? outcome.toolCalls : 0,
        seconds: Math.round(durationMs / 100) / 10,
        durationMs,
        ttftMs: outcome ? outcome.ttftMs : 0,
        provider: outcome ? outcome.provider : '',
        model: outcome ? outcome.model : agent.model,
        mode: outcome ? outcome.mode : conf.access.mode,
        summary: failure ? `ошибка: ${failure.message}` : `«${task}» — выполнено`,
      },
    });
  }
  } finally {
    running.delete(agentId);
    try {
      res.end();
    } catch {}
  }
}

/* --------------------------------- API: планировщик задач команды */

function handleSchedules(req, res) {
  if (req.method === 'GET') {
    const now = Date.now();
    sendJSON(res, 200, {
      schedules: tgSchedule.list().map((s) => ({
        id: s.id, kind: s.kind, everyMin: s.everyMin, at: s.at,
        task: s.task, targetAgentId: s.targetAgentId, enabled: s.enabled,
        lastRun: s.lastRun || null, nextRun: tgSchedule.nextRun(s, now),
        text: tgSchedule.describe(s, now),
      })),
    });
    return Promise.resolve();
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  return readJSON(req).then((body) => {
    if (body.removeId) {
      tgSchedule.remove(String(body.removeId));
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (body.toggleId) {
      const s = tgSchedule.toggle(String(body.toggleId), body.enabled !== false);
      sendJSON(res, 200, { ok: true, enabled: s.enabled });
      return;
    }
    const b = body.schedule || {};
    if (b.kind !== 'every' && b.kind !== 'daily') throw httpError(400, 'kind — every или daily');
    if (b.kind === 'every' && (!Number.isFinite(Number(b.everyMin)) || Number(b.everyMin) < 5)) {
      throw httpError(400, 'Интервал — от 5 минут');
    }
    if (b.kind === 'daily' && !/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(b.at || ''))) {
      throw httpError(400, 'Время — HH:MM, например 09:00');
    }
    try {
      const item = tgSchedule.add({
        kind: b.kind,
        everyMin: b.kind === 'every' ? Math.round(Number(b.everyMin)) : undefined,
        at: b.kind === 'daily' ? String(b.at) : undefined,
        task: b.task,
        targetAgentId: b.targetAgentId || null,
      });
      sendJSON(res, 200, { ok: true, schedule: item });
    } catch (e) {
      throw httpError(400, e.message);
    }
  });
}

/* --------------------------------- API: мост Telegram → команда */

function handleTgBridge(req, res) {
  if (req.method === 'GET') {
    sendJSON(res, 200, tgbridge.getPublic());
    return Promise.resolve();
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  return readJSON(req).then((body) => {
    try {
      const next = tgbridge.save(body || {});
      sendJSON(res, 200, { ok: true, bridge: tgbridge.getPublic(), enabled: next.enabled });
    } catch (e) {
      throw httpError(400, e.message);
    }
  });
}

function handleTgBridgeTest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    try {
      const out = await tgbridge.sendTest(body && body.chat_id);
      sendJSON(res, 200, out);
    } catch (e) {
      throw httpError(400, e.message);
    }
  });
}

function handleTgBridgeRecent(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  return (async () => {
    try {
      sendJSON(res, 200, { chats: await tgbridge.recentChats() });
    } catch (e) {
      throw httpError(400, e.message);
    }
  })();
}

/* ------------------------------------------ API: сервисы (ключи шифруются) */

/** Публичный вид сервиса: ключ наружу не отдаётся, только отпечаток. */
function publicServices() {
  const list = readJSONFile('services.json') || [];
  return list.map((s) => {
    const it = integrations.get(s.integrationId || s.id);
    const secret = store.decrypt(s.keyCipher || '');
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || (it && it.icon) || 'plug',
      category: s.category || (it && it.category) || 'Прочее',
      url: s.url || (it && it.baseUrl) || '',
      integrationId: (s.integrationId || s.id) && integrations.get(s.integrationId || s.id) ? (s.integrationId || s.id) : null,
      /* Что именно вводить для этого сервиса и какие операции доступны агенту */
      keyLabel: (it && it.keyLabel) || 'токен или ключ API',
      keyHint: (it && it.keyHint) || '',
      keyUrl: (it && it.keyUrl) || '',
      urlLabel: (it && it.urlLabel) || '',
      noKey: !!(it && it.keyRequired === false),
      hasKey: !!secret,
      keyHintMask: store.fingerprint(secret),
      actions: it ? it.actions.map((a) => ({ name: a.name, label: a.label, write: !!a.write })) : [],
      status: s.status === 'connected' ? 'connected' : 'disconnected',
      lastCheck: s.lastCheck || null,
      lastCheckOk: s.lastCheckOk === undefined ? null : !!s.lastCheckOk,
      checkDetail: s.checkDetail || '',
      latencyMs: s.latencyMs || null,
    };
  });
}

/** Расшифрованные креды сервиса для интеграционного слоя. */
function serviceCreds(svc) {
  const it = integrations.get(svc.integrationId || svc.id);
  return { apiKey: store.decrypt(svc.keyCipher || ''), url: svc.url || '', kind: it ? it.authKind : 'bearer' };
}

/** Записать результат проверки в services.json. */
function saveServiceCheck(svc, out) {
  svc.lastCheck = new Date().toISOString();
  svc.lastCheckOk = !!out.ok;
  svc.status = out.ok ? 'connected' : 'disconnected';
  svc.checkDetail = String(out.detail || out.error || '').slice(0, 300);
  svc.latencyMs = out.latencyMs || null;
}

/* ------------------------------------------ API: провайдеры LLM (ключи, модели) */

function publicProviders() {
  const conf = readJSONFile('config.json') || { providers: [] };
  return (conf.providers || []).map((p) => ({
    id: p.id,
    providerId: p.providerId,
    providerName: providers.getProvider(p.providerId).name,
    family: providers.getProvider(p.providerId).family,
    baseUrl: p.baseUrl,
    hasKey: !!store.decrypt(p.keyCipher || ''),
    keyHint: store.fingerprint(store.decrypt(p.keyCipher || '')),
    models: p.models || [],
    allModels: p.allModels || [],
    enabled: p.enabled !== false,
    isDefault: !!p.isDefault,
    serviceId: p.serviceId || null,
    lastCheck: p.lastCheck || null,
    lastCheckOk: p.lastCheckOk === undefined ? null : !!p.lastCheckOk,
    lastCheckDetail: p.lastCheckDetail || '',
    latencyMs: p.latencyMs || null,
    extraHeaders: p.extraHeaders || null,
  }));
}

function handleProvidersCatalog(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  sendJSON(res, 200, { catalog: providers.catalog(), configured: publicProviders() });
}

function handleProviders(req, res) {
  if (req.method === 'GET') return sendJSON(res, 200, publicProviders());

  return readJSON(req).then(async (body) => {
    const conf = readJSONFile('config.json') || { providers: [] };

    if (body.removeId !== undefined) {
      const before = conf.providers.length;
      conf.providers = conf.providers.filter((p) => p.id !== body.removeId);
      if (conf.providers.length === before) throw httpError(404, `Провайдер «${body.removeId}» не найден`);
      writeJSONFile('config.json', conf);
      return sendJSON(res, 200, publicProviders());
    }

    const providerId = isStr(body.providerId, 1, 40) ? body.providerId : null;
    if (!providerId) throw httpError(400, 'providerId обязателен');
    const base = providers.getProvider(providerId);

    const list = conf.providers || (conf.providers = []);
    const existing = body.id ? list.find((p) => p.id === body.id) : null;

    const entry = existing || { id: uid('prv'), providerId, keyCipher: '', baseUrl: base.baseUrl, models: [], enabled: true };
    if (existing && existing.providerId !== providerId) {
      entry.keyCipher = '';
      entry.baseUrl = base.baseUrl;
      entry.models = [];
      entry.allModels = [];
    }
    entry.providerId = providerId;
    entry.providerName = base.name;

    if (body.baseUrl !== undefined) {
      const u = String(body.baseUrl || '').trim();
      if (u && !/^https?:\/\//i.test(u)) throw httpError(400, 'baseUrl должен начинаться с http:// или https://');
      if (u.length > 300) throw httpError(400, 'baseUrl: максимум 300 символов');
      entry.baseUrl = u;
    }
    if (!entry.baseUrl) entry.baseUrl = base.baseUrl;

    if (body.apiKey !== undefined) {
      const key = String(body.apiKey || '').trim();
      if (key === '') entry.keyCipher = '';
      else if (key.includes('•')) {
        if (!entry.keyCipher) throw httpError(400, 'Укажите реальный API-ключ');
      } else if (key.length > 400) throw httpError(400, 'API-ключ: максимум 400 символов');
      else entry.keyCipher = store.encrypt(key);
    }

    if (body.models !== undefined) {
      if (!Array.isArray(body.models)) throw httpError(400, 'models должен быть массивом');
      /* Пользователь может выбрать сотни моделей (у OpenRouter их много) */
      entry.models = body.models.filter((m) => isStr(m, 1, 120)).slice(0, 500);
    } else if (!entry.models || !entry.models.length) {
      entry.models = entry.allModels || base.models.map((m) => m.id);
    }

    if (body.enabled !== undefined) entry.enabled = !!body.enabled;
    if (body.serviceId !== undefined) entry.serviceId = isStr(body.serviceId, 1, 40) ? body.serviceId : null;
    if (body.extraHeaders !== undefined) {
      if (body.extraHeaders && typeof body.extraHeaders === 'object' && !Array.isArray(body.extraHeaders)) {
        const out = {};
        let n = 0;
        for (const [k, v] of Object.entries(body.extraHeaders)) {
          if (!isStr(k, 1, 60) || !isStr(v, 1, 400)) continue;
          out[k.slice(0, 60)] = String(v).slice(0, 400);
          if (++n >= 20) break;
        }
        entry.extraHeaders = Object.keys(out).length ? out : null;
      } else entry.extraHeaders = null;
    }

    if (body.isDefault) {
      entry.isDefault = true;
      entry.enabled = true;
      for (const p of list) p.isDefault = false;
    }

    if (!existing) list.push(entry);
    writeJSONFile('config.json', conf);

    let checked = null;
    if (body.test) {
      const t0 = Date.now();
      try {
        const r = await providers.verify(entry);
        checked = { ok: true, latencyMs: r.latencyMs, detail: r.detail };
      } catch (e) {
        checked = { ok: false, latencyMs: Date.now() - t0, detail: e.message };
      }
      const fresh = readJSONFile('config.json');
      const rec = (fresh.providers || []).find((p) => p.id === entry.id);
      if (rec) {
        rec.lastCheck = new Date().toISOString();
        rec.lastCheckOk = checked.ok;
        rec.lastCheckDetail = checked.detail.slice(0, 300);
        rec.latencyMs = checked.latencyMs;
        writeJSONFile('config.json', fresh);
      }
    }

    sendJSON(res, 200, { providers: publicProviders(), check: checked });
  });
}

/** Реальная проверка connection + подтягивание живого списка моделей. */
function handleProviderProbe(req, res, id) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const conf = readJSONFile('config.json') || { providers: [] };
  const entry = (conf.providers || []).find((p) => p.id === id);
  if (!entry) throw httpError(404, `Провайдер «${id}» не найден`);
  return providers
    .liveModels(entry)
    .then(async (models) => {
      const t0 = Date.now();
      let verified;
      try {
        verified = await providers.verify(entry);
      } catch (e) {
        verified = { ok: false, detail: e.message };
      }
      const fresh = readJSONFile('config.json');
      const rec = (fresh.providers || []).find((p) => p.id === id);
      if (rec) {
        rec.allModels = models.map((m) => m.id).slice(0, 1000);
        rec.models = rec.models || [];
        rec.lastCheck = new Date().toISOString();
        rec.lastCheckOk = verified.ok;
        rec.lastCheckDetail = String(verified.detail || '').slice(0, 300);
        rec.latencyMs = Date.now() - t0;
        writeJSONFile('config.json', fresh);
      }
      sendJSON(res, 200, {
        ok: verified.ok,
        models: models.map((m) => m.id),
        meta: models,
        detail: verified.detail,
        latencyMs: Date.now() - t0,
      });
    })
    .catch((e) => sendError(res, 400, `Проверка не удалась: ${e.message}`, { ok: false, models: [] }));
}

/* --------------------------------------------- API: реальные метрики и журнал */

function handleMetrics(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const snap = metrics.snapshot();
  const stats = metrics.stats();
  const lan = metrics.lanAddresses();
  sendJSON(res, 200, { node: snap, stats, lan });
}

function handleRuns(req, res) {
  if (req.method === 'DELETE') {
    metrics.clearRuns();
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'DELETE']);
  const data = metrics.runs();
  sendJSON(res, 200, { recent: data.runs.slice(0, 60), totals: data.totals });
}

/* Корень базы знаний = рабочая папка команды, иначе общая папка узла. */
function ragRoot() {
  const team = readJSONFile('team.json');
  const teamRoot = team && team.team && typeof team.team.workspace === 'string' && team.team.workspace.trim()
    ? team.team.workspace.trim()
    : '';
  const conf = auth.config();
  return teamRoot || conf.access.workspace || DATA_DIR;
}

/** Сводка базы знаний RAG: сколько файлов/чанков видит агент. */
async function handleRagStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const st = await rag.status(ragRoot());
  const bases = readJSONFile('kb.json') || [];
  st.bases = [];
  for (const b of bases) {
    let files = 0;
    try {
      const s = await rag.status(ragRoot(), b.paths || []);
      files = s.files;
    } catch { files = 0; }
    st.bases.push({ id: b.id, name: b.name, files, agents: (b.agentIds || []).length });
  }
  sendJSON(res, 200, st);
}

/* ----------------------------------------------- API: базы знаний RAG */

function normalizeKbItem(input, existing) {
  const o = Object.assign({}, existing || {}, input);
  if (!isStr(o.name, 1, 60)) throw httpError(400, 'База: «Название» — от 1 до 60 символов');
  o.name = o.name.trim();
  o.description = typeof o.description === 'string' ? o.description.slice(0, 280) : '';
  const rawPaths = Array.isArray(o.paths) ? o.paths : [];
  o.paths = rawPaths
    .map((p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim().slice(0, 300))
    .filter((p) => p && p !== '.' && !p.startsWith('..'))
    .slice(0, 20);
  if (!o.paths.length) throw httpError(400, 'База: укажите хотя бы одну папку или файл (например notes/ или docs/guide.md)');
  const team = readJSONFile('team.json');
  const ids = new Set(((team && team.agents) || []).map((a) => a.id));
  o.agentIds = (Array.isArray(o.agentIds) ? o.agentIds : []).filter((id) => ids.has(id)).slice(0, 12);
  o.updatedAt = new Date().toISOString();
  if (!o.createdAt) o.createdAt = o.updatedAt;
  return o;
}

function handleKb(req, res) {
  if (req.method === 'GET') {
    const list = readJSONFile('kb.json') || [];
    return sendJSON(res, 200, list);
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  return readJSON(req).then((body) => {
    const list = readJSONFile('kb.json') || [];
    if (body.removeId !== undefined) {
      if (!isStr(body.removeId, 1, 60)) throw httpError(400, 'removeId: некорректный id');
      const idx = list.findIndex((x) => x.id === body.removeId);
      if (idx < 0) throw httpError(404, `База «${body.removeId}» не найдена`);
      const [gone] = list.splice(idx, 1);
      writeJSONFile('kb.json', list);
      /* Чистим привязки у агентов */
      const team = readJSONFile('team.json');
      if (team && Array.isArray(team.agents)) {
        let touched = false;
        for (const a of team.agents) {
          if (a.permissions && Array.isArray(a.permissions.kb) && a.permissions.kb.includes(gone.id)) {
            a.permissions.kb = a.permissions.kb.filter((k) => k !== gone.id);
            touched = true;
          }
        }
        if (touched) writeJSONFile('team.json', team);
      }
      return sendJSON(res, 200, list);
    }
    if (body.item !== undefined) {
      const input = body.item;
      const idx = input.id ? list.findIndex((x) => x.id === input.id) : -1;
      const item = normalizeKbItem(input, idx >= 0 ? list[idx] : null);
      if (idx >= 0) list[idx] = item;
      else {
        item.id = item.id && isStr(item.id, 1, 60) ? item.id : uid('kb');
        list.push(item);
      }
      writeJSONFile('kb.json', list);
      return sendJSON(res, 200, list);
    }
    throw httpError(400, 'Пустой запрос: ожидается item или removeId');
  });
}

/** Проверка базы: поиск тестового запроса только внутри её путей. */
function handleKbSearch(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const list = readJSONFile('kb.json') || [];
    const base = list.find((x) => x.id === body.id);
    if (!base) throw httpError(404, 'База не найдена');
    if (!isStr(body.query, 1, 300)) throw httpError(400, 'query — от 1 до 300 символов');
    const out = await rag.search(ragRoot(), body.query.trim(), 5, base.paths || []);
    if (out.error) throw httpError(400, out.error);
    sendJSON(res, 200, out);
  });
}

/* ------------------------------------------------------ API: инструменты и ПК */

function handleToolTest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const conf = auth.config();
    const mode = conf.access.mode === 'full' ? 'full' : 'readonly';
    const root = conf.access.workspace || DATA_DIR;
    const ctx = { root, mode, programs: readJSONFile('programs.json') || [] };
    const name = isStr(body.tool, 1, 40) ? body.tool : null;
    if (!name) throw httpError(400, 'tool обязателен');
    const result = await toolsLib.execute(ctx, name, body.args || {});
    sendJSON(res, 200, result);
  });
}

function handleWorkspace(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }
  const conf = auth.config();
  sendJSON(res, 200, {
    mode: conf.access.mode,
    workspace: conf.access.workspace || DATA_DIR,
    readonlyTools: toolsLib.READONLY_TOOLS,
    fullTools: toolsLib.FULL_TOOLS,
  });
}

/**
 * Загрузка рабочего файла для агентов (вложения из чата).
 * Человек прикладывает файл → он ложится в uploads/ рабочей папки,
 * агент читает его обычной read_file. Лимит 5 МБ — поэтому здесь свой
 * читатель тела, а не общий readJSON на 1 МБ.
 */
const UPLOAD_LIMIT = 5 * 1024 * 1024;

function readUploadBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > UPLOAD_LIMIT + 1024 * 1024) {
        reject(httpError(413, 'Файл больше лимита 5 МБ'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeUploadName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().trim();
  const clean = base.replace(/[^\wа-яёА-ЯЁ.\-()+ ]/gi, '_').slice(0, 120);
  return clean.replace(/^\.+/, '').trim() || 'file';
}

function handleWorkspaceUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readUploadBody(req).then(async (raw) => {
    let body;
    try {
      body = raw.trim() ? JSON.parse(raw.trim()) : {};
    } catch {
      throw httpError(400, 'Некорректный JSON');
    }
    const conf = auth.config();
    const root = conf.access.workspace || DATA_DIR;
    const name = safeUploadName(body.name);
    if (!/\.[\w]{1,12}$/.test(name)) throw httpError(400, 'У файла должно быть расширение');
    const b64 = typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
    if (!b64) throw httpError(400, 'Пустое содержимое');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      throw httpError(400, 'Содержимое — не base64');
    }
    if (!buf.length || buf.length > UPLOAD_LIMIT) throw httpError(400, 'Файл больше лимита 5 МБ');
    /* Имя без сюрпризов: только uploads/, коллизии — суффиксом */
    const dir = path.join(root, 'uploads');
    await fsp.mkdir(dir, { recursive: true });
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const dot = name.lastIndexOf('.');
      const stem = name.slice(0, dot);
      const ext = name.slice(dot);
      let i = 1;
      while (fs.existsSync(target) && i < 100) {
        target = path.join(dir, `${stem} (${i})${ext}`);
        i++;
      }
      if (fs.existsSync(target)) throw httpError(409, 'Файл с таким именем уже есть');
    }
    const check = toolsLib.resolveInside(root, path.relative(root, target));
    if (check.error) throw httpError(400, check.error);
    await fsp.writeFile(target, buf);
    const rel = path.relative(root, target).replace(/\\/g, '/');
    sendJSON(res, 200, { ok: true, path: rel, bytes: buf.length });
  });
}
function handleWorkspaceFile(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const conf = auth.config();
    if (conf.access.mode !== 'full') throw httpError(403, 'Сохранение файлов доступно только в режиме «полный доступ»');
    const root = conf.access.workspace || DATA_DIR;
    const r = toolsLib.resolveInside(root, body.path);
    if (r.error) throw httpError(400, r.error);
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content) throw httpError(400, 'Пустое содержимое');
    if (Buffer.byteLength(content) > 1024 * 1024) throw httpError(400, 'Файл больше лимита 1 МБ');
    await fsp.mkdir(path.dirname(r.path), { recursive: true });
    const existed = fs.existsSync(r.path);
    if (body.append === true && existed) {
      const prev = await fsp.readFile(r.path, 'utf8');
      const joined = prev + (prev.endsWith('\n') ? '' : '\n') + content + '\n';
      if (Buffer.byteLength(joined) > 1024 * 1024) throw httpError(400, 'Файл больше лимита 1 МБ');
      await fsp.writeFile(r.path, joined, 'utf8');
      const st = await fsp.stat(r.path);
      sendJSON(res, 200, { ok: true, path: r.path, created: false, appended: true, bytes: st.size });
      return;
    }
    await fsp.writeFile(r.path, content, 'utf8');
    sendJSON(res, 200, { ok: true, path: r.path, created: !existed, bytes: Buffer.byteLength(content) });
  });
}

/* ---------------------------------------------------- API: MCP — реальный probe */

/**
 * Показать окно браузера команды человеку (поднять на передний план).
 * Только полный доступ: окно — общее для агентов и оператора.
 */
function handleBrowserShow(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async () => {
    const conf = auth.config();
    if (conf.access.mode !== 'full') throw httpError(403, 'Окно браузера доступно только в режиме «полный доступ»');
    const browserLib = require('./lib/browser');
    try {
      const out = await browserLib.showWindow();
      sendJSON(res, 200, out);
    } catch (e) {
      throw httpError(500, `Браузер: ${e.message}`);
    }
  });
}

/**
 * Скриншот окна браузера (для оператора: смотреть глазами агента).
 * Только полный доступ.
 */
function handleBrowserShot(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async () => {
    const conf = auth.config();
    if (conf.access.mode !== 'full') throw httpError(403, 'Скриншоты доступны только в режиме «полный доступ»');
    const browserLib = require('./lib/browser');
    try {
      const out = await browserLib.shot();
      sendJSON(res, 200, out);
    } catch (e) {
      throw httpError(500, `Браузер: ${e.message}`);
    }
  });
}

/** Отдача PNG-скриншотов из data/shots (только наши файлы shot-*.png). */
function handleShotFile(req, res, name) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD']);
  if (!/^shot-[a-z0-9]+\.png$/i.test(name)) throw httpError(400, 'Некорректное имя файла');
  const p = path.join(DATA_DIR, 'shots', name);
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    throw httpError(404, 'Скриншот не найден');
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'max-age=60' });
  if (req.method === 'GET') res.end(buf);
  else res.end();
}

const FILEVIEW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Отдача картинок из рабочей папки для превью в чате. Только изображения,
 * строго внутри корня (jail), до 8 МБ. Путь — query ?path=uploads/x.png */
function handleFileView(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD']);
  const rel = String((url.searchParams.get('path') || '')).slice(0, 300);
  if (!rel) throw httpError(400, 'Не указан path');
  const ext = path.extname(rel).toLowerCase();
  const mime = FILEVIEW_MIME[ext];
  if (!mime) throw httpError(400, 'Предпросмотр доступен только для картинок (png/jpg/gif/webp/bmp)');
  const conf = auth.config();
  const team = readJSONFile('team.json');
  const teamRoot = team && team.team && typeof team.team.workspace === 'string' && team.team.workspace.trim()
    ? team.team.workspace.trim()
    : '';
  const root = teamRoot || conf.access.workspace || DATA_DIR;
  const r = toolsLib.resolveInside(root, rel);
  if (r.error) throw httpError(400, r.error);
  let st;
  try {
    st = fs.statSync(r.path);
  } catch {
    throw httpError(404, 'Файл не найден');
  }
  if (!st.isFile() || st.size > 8 * 1024 * 1024) throw httpError(404, 'Файл не найден или слишком большой');
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'max-age=60' });
  if (req.method === 'GET') fs.createReadStream(r.path).pipe(res);
  else res.end();
}

/**
 * Состояние браузера команды для индикатора. Не запускает ничего,
 * поэтому доступно в любом режиме.
 */
function handleBrowserState(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const browserLib = require('./lib/browser');
  return browserLib.state()
    .then((out) => sendJSON(res, 200, out))
    .catch((e) => sendJSON(res, 200, { ok: true, running: false, error: e.message }));
}

/**
 * Открыть программу ПК по кнопке человека (не агента): браузер, Photoshop,
 * Blender и т.д. Только полный доступ, только программы с perm.run.
 * Процесс открепляется и не ждёт закрытия — ответ сразу.
 */
function handleProgramOpen(req, res, id) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const conf = auth.config();
    if (conf.access.mode !== 'full') throw httpError(403, 'Открытие программ доступно только в режиме «полный доступ»');
    const list = readJSONFile('programs.json') || [];
    const prog = list.find((p) => p.id === id);
    if (!prog) throw httpError(404, `Программа «${id}» не найдена`);
    if (!prog.perms || !prog.perms.run) throw httpError(403, `Для «${prog.name}» не выдан запуск`);
    if (!fs.existsSync(prog.path)) throw httpError(400, `Файл программы не найден: ${prog.path}`);
    const argsList = Array.isArray(body.args) ? body.args.slice(0, 12).map(String) : [];
    const { spawn } = require('child_process');
    let child;
    try {
      child = spawn(prog.path, argsList, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    } catch (e) {
      throw httpError(500, `Не удалось запустить: ${e.message}`);
    }
    child.on('error', () => {});
    child.unref();
    sendJSON(res, 200, { ok: true, name: prog.name, pid: child.pid || null });
  });
}

function handleMcpProbe(req, res, id) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const list = readJSONFile('mcp.json') || [];
  const m = list.find((x) => x.id === id);
  if (!m) throw httpError(404, `MCP-сервер «${id}» не найден`);
  return mcpLib
    .probe(m)
    .then((out) => {
      m.status = out.ok ? 'connected' : 'error';
      m.tools = out.tools || [];
      m.log = (out.log || []).slice(-40);
      writeJSONFile('mcp.json', list);
      sendJSON(res, 200, out);
    })
    .catch((e) => sendError(res, 500, e.message || 'MCP-сервер не ответил', { ok: false, tools: [], log: mcpLib.getLog(id) }));
}

/** Массовая проверка всех MCP-серверов (кнопка «Проверить все»). */
function handleMcpProbeAll(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const list = readJSONFile('mcp.json') || [];
  return Promise.all(
    list.map(async (m) => {
      try {
        const out = await mcpLib.probe(m);
        m.status = out.ok ? 'connected' : 'error';
        m.tools = out.tools || [];
        m.log = (out.log || []).slice(-40);
        return { id: m.id, ok: out.ok, tools: out.tools.length, detail: out.detail, error: out.error, latencyMs: out.latencyMs };
      } catch (e) {
        m.status = 'error';
        return { id: m.id, ok: false, tools: 0, error: e.message };
      }
    }),
  ).then((results) => {
    writeJSONFile('mcp.json', list);
    sendJSON(res, 200, { results });
  });
}

/** Настоящее сканирование ПК: detectPrograms() + слияние со списком пользователя.
 * Существующие записи (id, разрешения) не трогаем — только снимаем missing
 * и добавляем genuinely новые. Ничего не удаляем. */
function handleProgramsScan(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const list = readJSONFile('programs.json') || [];
  const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
  const byPath = new Map(list.map((x) => [norm(x.path), x]));
  const detected = detectPrograms();
  let added = 0;
  for (const d of detected) {
    const ex = byPath.get(norm(d.path));
    if (ex) {
      ex.missing = false;
      if (!ex.name) ex.name = d.name;
    } else {
      list.push({ id: uid('prg'), name: d.name, path: d.path, perms: d.perms, source: 'scan', missing: false });
      added++;
    }
  }
  markMissingPrograms();
  writeJSONFile('programs.json', list);
  sendJSON(res, 200, { ok: true, added, total: list.length, programs: list });
}

/* --------------------------------------- API: доступ (PIN, сессии, приглашения) */

function handleAccess(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const conf = auth.config();
  const cookies = auth.parseCookies(req.headers.cookie);
  const isLocal = auth.isLocalRequest(req);
  const authed = isLocal || auth.sessionValid(cookies.nexus_session, conf);
  sendJSON(res, 200, {
    access: conf.access,
    pinEnabled: conf.pin.enabled,
    pinLength: conf.pin.length,
    pinIsDefault: conf.pin.enabled === true && conf.pin.isDefault === true,
    requiresAuth: auth.isPrivileged(conf),
    isLocal,
    /* Коды приглашений — только для авторизованных: иначе их украдут из сети */
    invites: authed ? auth.listInvites() : [],
  });
}

function handleAccessLogin(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return readJSON(req).then(async (body) => {
    const ip = auth.clientIp(req);
    const conf = auth.config();
    const left = auth.attemptsLeft(ip);
    if (left <= 0) {
      throw httpError(429, 'Превышено число попыток. Подождите 15 минут.');
    }

    let ok = false;
    if (body.invite) ok = await auth.consumeInvite(String(body.invite));
    else if (auth.isLocalRequest(req)) ok = true; // локальному компьютеру PIN не нужен
    else if (!conf.pin.enabled || !conf.pin.hash) {
      /* Критично: без настроенного PIN любой код проходил бы как верный.
         Отказываем явно, пока владелец не задаст PIN на самой машине. */
      throw httpError(403, 'PIN не задан. Откройте NEXUS на этом компьютере и задайте PIN в разделе «Доступ».');
    } else ok = auth.verifyPin(body.pin, conf);

    if (!ok) {
      const rec = auth.registerFailure(ip);
      throw httpError(401, `Неверный код. Осталось попыток: ${Math.max(0, 5 - rec.count)}`);
    }
    auth.clearAttempts(ip);

    const isLocal = auth.isLocalRequest(req);
    const token = await auth.createSession(auth.clientIp(req), isLocal);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, false));
    sendJSON(res, 200, { ok: true, isLocal, label: `сессия с ${auth.clientIp(req)}` });
  });
}

function handleAccessLogout(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.dropSession(cookies.nexus_session).then(() => {
    res.setHeader('Set-Cookie', auth.clearCookie());
    sendJSON(res, 200, { ok: true });
  });
}

function handleAccessSession(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const cookies = auth.parseCookies(req.headers.cookie);
  const conf = auth.config();
  const isLocal = auth.isLocalRequest(req);
  const authed = isLocal || auth.sessionValid(cookies.nexus_session, conf);
  sendJSON(res, 200, { authed, isLocal, requiresAuth: auth.isPrivileged(conf), pinEnabled: conf.pin.enabled });
}

function handleAccessSetPin(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const cookies = auth.parseCookies(req.headers.cookie);
  const conf = auth.config();
  if (!auth.isLocalRequest(req) && !auth.sessionValid(cookies.nexus_session, conf)) {
    throw httpError(401, 'Требуется вход');
  }
  return readJSON(req)
    .then((body) => auth.setPin(body.pin))
    .then((out) => sendJSON(res, 200, out));
}

function handleAccessClearPin(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const cookies = auth.parseCookies(req.headers.cookie);
  const conf = auth.config();
  if (!auth.isLocalRequest(req) && !auth.sessionValid(cookies.nexus_session, conf)) {
    throw httpError(401, 'Требуется вход');
  }
  return auth.clearPin().then((out) => sendJSON(res, 200, out));
}

function handleAccessMode(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const cookies = auth.parseCookies(req.headers.cookie);
  const conf = auth.config();
  if (!auth.isLocalRequest(req) && !auth.sessionValid(cookies.nexus_session, conf)) {
    throw httpError(401, 'Требуется вход');
  }
  return readJSON(req)
    .then((body) => {
      if (body.mode !== undefined && !['readonly', 'full'].includes(body.mode)) {
        throw httpError(400, 'mode — readonly | full');
      }
      return auth.save((data) => {
        if (body.mode !== undefined) data.access.mode = body.mode;
        if (body.workspace !== undefined) {
          const w = String(body.workspace || '').trim();
          if (w && !path.isAbsolute(w)) throw httpError(400, 'Рабочая папка — абсолютный путь');
          if (w && !fs.existsSync(w)) throw httpError(400, `Папка не найдена: ${w}`);
          data.access.workspace = w;
        }
        if (body.requirePinForLan !== undefined) data.access.requirePinForLan = !!body.requirePinForLan;
        if (body.allowRemoteRun !== undefined) data.access.allowRemoteRun = !!body.allowRemoteRun;
        return data;
      });
    })
    .then(() => {
      const c = auth.config();
      sendJSON(res, 200, { access: c.access });
    });
}

function handleAccessInvite(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const cookies = auth.parseCookies(req.headers.cookie);
  const conf = auth.config();
  if (!auth.isLocalRequest(req) && !auth.sessionValid(cookies.nexus_session, conf)) {
    throw httpError(401, 'Требуется вход');
  }
  return readJSON(req)
    .then((body) => auth.createInvite(Math.min(Number(body.ttlMin) || 30, 24 * 60)))
    .then((inv) => sendJSON(res, 200, { invite: inv, invites: auth.listInvites() }));
}

function handleAccessInviteRevoke(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  return auth.revokeInvites().then(() => sendJSON(res, 200, { ok: true, invites: [] }));
}

/** QR-ссылки для телефона: адреса локальной сети + готовый invite. */
function handleNetInfo(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const lan = metrics.lanAddresses();
  const port = PORT;
  const url = (ip) => `http://${ip}:${port}`;
  const conf = auth.config();
  const cookies = auth.parseCookies(req.headers.cookie);
  const isLocal = auth.isLocalRequest(req);
  const authed = isLocal || auth.sessionValid(cookies.nexus_session, conf);
  sendJSON(res, 200, {
    port,
    lan: lan.map((n) => ({ ...n, url: url(n.address) })),
    /* Не показываем коды приглашений неавторизованным клиентам */
    invites: authed ? auth.listInvites() : [],
    pinEnabled: conf.pin.enabled,
  });
}

/* ------------------------------------------------------------ статика + роутер */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  const relToPublic = path.relative(PUBLIC_DIR, filePath);
  if (relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
    return sendError(res, 403, 'Доступ запрещён');
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    if (!path.extname(filePath)) {
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(idx)) return streamFile(req, res, idx);
    }
    return sendError(res, 404, `Не найдено: ${pathname}`);
  }
  if (stat.isDirectory()) return streamFile(req, res, path.join(filePath, 'index.html'));
  streamFile(req, res, filePath);
}

function streamFile(req, res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendError(res, 404, 'Файл не найден');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=60',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/** Эндпоинты, доступные без авторизации (вход и статика для экрана входа). */
const PUBLIC_API = new Set([
  '/api/health',
  '/api/access',
  '/api/access/session',
  '/api/access/login',
  '/api/net',
]);

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendError(res, 400, 'Некорректный URL');
  }
  const pathname = url.pathname;
  const fail = (e) => {
    const status = (e && e.status) || 500;
    if (status >= 500) console.error('[error]', e);
    if (!res.headersSent) sendError(res, status, (e && e.message) || 'Внутренняя ошибка сервера');
    else if (!res.writableEnded) res.end();
  };
  const done = (fn) => {
    try {
      const out = fn();
      if (out && typeof out.catch === 'function') out.catch(fail);
    } catch (e) {
      fail(e);
    }
  };

  res.on('finish', () => {
    if (pathname.startsWith('/api')) {
      console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${pathname} → ${res.statusCode}`);
    }
  });

  // авторизация: локальный хост — свободный вход, из сети — по PIN/сессии
  if (pathname.startsWith('/api/') && !PUBLIC_API.has(pathname)) {
    const cookies = auth.parseCookies(req.headers.cookie);
    const verdict = auth.authorize(req, auth.config(), cookies);
    if (!verdict.ok) {
      return sendError(res, 401, verdict.reason === 'invite'
        ? 'Приглашение истекло или уже использовано — запросите новое'
        : 'Требуется вход по PIN-коду', { auth: true, reason: verdict.reason });
    }
  }

  if (pathname === '/api/health') {
    return done(() => sendJSON(res, 200, { ok: true, uptime: process.uptime(), agents: (readJSONFile('team.json') || { agents: [] }).agents.length }));
  }

  if (pathname === '/api/providers') return done(() => handleProviders(req, res));
  if (pathname === '/api/providers/catalog') return done(() => handleProvidersCatalog(req, res));
  if (pathname === '/api/metrics') return done(() => handleMetrics(req, res));
  if (pathname === '/api/runs') return done(() => handleRuns(req, res));
  if (pathname === '/api/rag/status') return done(() => handleRagStatus(req, res));
  if (pathname === '/api/kb') return done(() => handleKb(req, res));
  if (pathname === '/api/kb/search') return done(() => handleKbSearch(req, res));
  if (pathname === '/api/tools/test') return done(() => handleToolTest(req, res));
  if (pathname === '/api/workspace') return done(() => handleWorkspace(req, res));
  if (pathname === '/api/workspace/file') return done(() => handleWorkspaceFile(req, res));
  if (pathname === '/api/workspace/upload') return done(() => handleWorkspaceUpload(req, res));
  if (pathname === '/api/mcp/probe-all') return done(() => handleMcpProbeAll(req, res));
  if (pathname === '/api/mcp/test') return done(() => handleMcpTest(req, res));
  if (pathname === '/api/access') return done(() => handleAccess(req, res));
  if (pathname === '/api/access/session') return done(() => handleAccessSession(req, res));
  if (pathname === '/api/access/login') return done(() => handleAccessLogin(req, res));
  if (pathname === '/api/access/logout') return done(() => handleAccessLogout(req, res));
  if (pathname === '/api/access/pin') return done(() => handleAccessSetPin(req, res));
  if (pathname === '/api/access/pin/clear') return done(() => handleAccessClearPin(req, res));
  if (pathname === '/api/access/mode') return done(() => handleAccessMode(req, res));
  if (pathname === '/api/access/invite') return done(() => handleAccessInvite(req, res));
  if (pathname === '/api/access/invite/revoke') return done(() => handleAccessInviteRevoke(req, res));
  if (pathname === '/api/net') return done(() => handleNetInfo(req, res));

  if (pathname === '/api/team') return done(() => handleTeam(req, res));
  if (pathname === '/api/services') return done(() => handleResource(req, res, 'services'));
  if (pathname === '/api/programs') return done(() => handleResource(req, res, 'programs'));
  if (pathname === '/api/programs/scan') return done(() => handleProgramsScan(req, res));
  if (pathname === '/api/mcp') return done(() => handleResource(req, res, 'mcp'));

  let m = pathname.match(/^\/api\/services\/([A-Za-z0-9_-]+)\/check$/);
  if (m) return done(() => handleServiceCheck(req, res, m[1]));
  m = pathname.match(/^\/api\/services\/([A-Za-z0-9_-]+)\/action$/);
  if (m) return done(() => handleServiceAction(req, res, m[1]));
  if (pathname === '/api/integrations') return done(() => handleIntegrationsCatalog(req, res));
  if (pathname === '/api/telegram-bridge') return done(() => handleTgBridge(req, res));
  if (pathname === '/api/telegram-bridge/test') return done(() => handleTgBridgeTest(req, res));
  if (pathname === '/api/telegram-bridge/recent') return done(() => handleTgBridgeRecent(req, res));
  if (pathname === '/api/schedules') return done(() => handleSchedules(req, res));
  m = pathname.match(/^\/api\/mcp\/([A-Za-z0-9_-]+)\/reconnect$/);
  if (m) return done(() => handleMcpReconnect(req, res, m[1]));
  m = pathname.match(/^\/api\/mcp\/([A-Za-z0-9_-]+)\/probe$/);
  if (m) return done(() => handleMcpProbe(req, res, m[1]));
  m = pathname.match(/^\/api\/programs\/([A-Za-z0-9_-]+)\/open$/);
  if (m) return done(() => handleProgramOpen(req, res, m[1]));
  if (pathname === '/api/browser/show') return done(() => handleBrowserShow(req, res));
  if (pathname === '/api/browser/shot') return done(() => handleBrowserShot(req, res));
  if (pathname === '/api/browser/state') return done(() => handleBrowserState(req, res));
  m = pathname.match(/^\/api\/shots\/([A-Za-z0-9-]+\.png)$/);
  if (m) return done(() => handleShotFile(req, res, m[1]));
  if (pathname === '/api/files') return done(() => handleFileView(req, res, url));
  m = pathname.match(/^\/api\/providers\/([A-Za-z0-9_-]+)\/probe$/);
  if (m) return done(() => handleProviderProbe(req, res, m[1]));
  m = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/run$/);
  if (m) return done(() => handleAgentRun(req, res, m[1]));

  if (pathname.startsWith('/api/')) {
    return done(() => sendError(res, 404, `Неизвестный эндпоинт: ${pathname}`));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return done(() => methodNotAllowed(res, ['GET', 'HEAD']));
  }
  done(() => serveStatic(req, res, pathname));
});

ensureData();
/* PIN по умолчанию (1111), если владелец не задавал свой. Только после этого слушаем порт. */
auth.ensureDefaultPin()
  .then((applied) => {
    if (applied) console.log('[auth] задан PIN по умолчанию: 1111 — смените его в Подключения → Доступ');
  })
  .catch((e) => console.error('[auth] не удалось задать PIN по умолчанию:', e.message))
  .finally(() => {
    server.listen(PORT, HOST, () => {
  const lan = metrics.lanAddresses();
  console.log('──────────────────────────────────────────────');
  console.log('  NEXUS · сервер команды ИИ-агентов запущен');
  console.log(`  → http://localhost:${PORT}`);
  for (const n of lan) console.log(`  → с телефона: http://${n.address}:${PORT}`);
  console.log(`  → данные: ${DATA_DIR}`);
  console.log('──────────────────────────────────────────────');
  /* Мост Telegram: опрос входящих каждые 5 секунд (сам молчит, если выключен) */
  setInterval(() => { tgbridge.tick().catch(() => {}); }, 5000);
  /* Планировщик: проверка расписаний каждые 30 секунд */
  setInterval(() => { tgSchedule.tick().catch(() => {}); }, 30000);
  });
});
