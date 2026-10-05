/**
 * NEXUS — реальные коннекторы к внешним сервисам.
 *
 * Каждый интеграционный модуль умеет:
 *   verify(creds) — живая проверка ключа настоящим запросом к API;
 *   actions       — список операций для агента и для ручной проверки из UI.
 *
 * Ключи приходят уже расшифрованными и в память не пишутся.
 * Все адреса фиксированы в коде, кроме Webhook-интеграции: там URL задаёт
 * пользователь/агент, поэтому request() режет приватные хосты и http.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const TIMEOUT = 20000;
const MAX_BYTES = 1024 * 1024;

/** Минимальный JSON/HTTP-клиент с таймаутом и лимитом ответа. */
function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  /* Приватные IPv4-литералы + IPv6-локальные */
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6\d|7\d|8\d|9\d|10\d|11\d|12[0-7])\.|224\.|::1$|::\$|fe80|fc00|fd00)/i.test(h)) return true;
  if (/^::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h)) return true;
  return false;
}

function request(method, url, { headers = {}, body, form } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, status: 0, error: `неверный адрес: ${url}` });
    }
    if (u.protocol !== 'https:') {
      return resolve({ ok: false, status: 0, error: 'разрешён только https (http заблокирован от SSRF)' });
    }
    if (isBlockedHost(u.hostname)) {
      return resolve({ ok: false, status: 0, error: `хост ${u.hostname} заблокирован (приватная сеть)` });
    }

    let payload = null;
    const head = { ...headers, Accept: 'application/json', 'User-Agent': 'NEXUS/1.0' };
    if (form) {
      payload = Buffer.from(form);
      head['Content-Type'] = 'application/x-www-form-urlencoded';
      head['Content-Length'] = String(payload.length);
    } else if (body !== undefined) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      head['Content-Type'] = head['Content-Type'] || 'application/json';
      head['Content-Length'] = String(payload.length);
    }

    const req = https.request(
      { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: head, timeout: TIMEOUT },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BYTES) chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* не JSON — вернём как текст */ }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: `таймаут ${TIMEOUT} мс` }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

const trim = (s, n = 2000) => String(s === undefined || s === null ? '' : s).slice(0, n);
const need = (v, name) => {
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(`не задан параметр «${name}»`);
  return String(v).trim();
};

/* ============================================================ Telegram */

const telegram = {
  id: 'telegram',
  name: 'Telegram',
  icon: 'send',
  category: 'Мессенджеры',
  keyLabel: 'токен бота',
  keyHint: 'от @BotFather: /newbot → строка вида 1234567890:AAE...',
  keyUrl: 'https://t.me/BotFather',
  baseUrl: 'https://api.telegram.org',
  docs: 'https://core.telegram.org/bots/api',
  authKind: 'tokenPath',
  verify: (creds) => request('GET', `https://api.telegram.org/bot${need(creds.apiKey, 'токен бота')}/getMe`),
  detail: (r) => (r.json && r.json.result ? `@${r.json.result.username} (${r.json.result.first_name})` : ''),
  actions: [
    {
      name: 'sendMessage', label: 'Отправить сообщение', write: true,
      params: {
        chat_id: str('ID чата или @username получателя'),
        text: str('Текст сообщения'),
        parse_mode: opt('Markdown|HTML', 'Markdown'),
      },
      run: async (c, a) => request('POST', `https://api.telegram.org/bot${c.apiKey}/sendMessage`, {
        body: pick(a, ['chat_id', 'text', 'parse_mode', 'reply_markup']),
      }),
    },
    {
      name: 'getUpdates', label: 'Прочитать входящие', write: false,
      params: { limit: opt('Сколько последних сообщений', '10'), offset: opt('С какого update_id (для моста)', '') },
      run: async (c, a) => {
        let url = `https://api.telegram.org/bot${c.apiKey}/getUpdates?limit=${encodeURIComponent(a.limit || '10')}`;
        if (a.offset) url += `&offset=${encodeURIComponent(a.offset)}`;
        return request('GET', url);
      },
    },
    {
      name: 'getChat', label: 'Информация о чате', write: false,
      params: { chat_id: str('ID чата или @username') },
      run: async (c, a) => request('GET', `https://api.telegram.org/bot${c.apiKey}/getChat?chat_id=${encodeURIComponent(need(a.chat_id, 'chat_id'))}`),
    },
    {
      name: 'setWebhook', label: 'Настроить webhook', write: true,
      params: { url: str('HTTPS-адрес вебхука'), secret_token: opt('Секретный токен', '') },
      run: async (c, a) => request('POST', `https://api.telegram.org/bot${c.apiKey}/setWebhook`, {
        body: pick({ url: need(a.url, 'url'), secret_token: a.secret_token || undefined }, ['url', 'secret_token']),
      }),
    },
  ],
};

/* ======================================================== Google Drive */

const gdrive = {
  id: 'gdrive',
  name: 'Google Drive',
  icon: 'cloud',
  category: 'Хранилища',
  keyLabel: 'OAuth access token',
  keyHint: 'токен с scope https://www.googleapis.com/auth/drive — обновляйте его при истечении',
  keyUrl: 'https://developers.google.com/drive/api/guides/about-auth',
  baseUrl: 'https://www.googleapis.com/drive/v3',
  docs: 'https://developers.google.com/drive/api/reference/rest',
  authKind: 'bearer',
  verify: (creds) => request('GET', 'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
    headers: { Authorization: `Bearer ${need(creds.apiKey, 'OAuth токен')}` },
  }),
  detail: (r) => (r.json && r.json.user ? r.json.user.emailAddress || r.json.user.displayName : ''),
  actions: [
    {
      name: 'listFiles', label: 'Список файлов', write: false,
      params: {
        q: opt('Фильтр Drive, напр. name contains \'отчёт\'', ''),
        pageSize: opt('Сколько файлов', '25'),
        orderBy: opt('Сортировка, напр. modifiedTime desc', 'modifiedTime desc'),
      },
      run: async (c, a) => {
        const params = new URLSearchParams({ pageSize: a.pageSize || '25', orderBy: a.orderBy || 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken' });
        if (a.q) params.set('q', a.q);
        return request('GET', `https://www.googleapis.com/drive/v3/files?${params}`, { headers: auth(c) });
      },
    },
    {
      name: 'getFile', label: 'Скачать файл по id', write: false,
      params: { fileId: str('Идентификатор файла (id)') },
      run: async (c, a) => request('GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(need(a.fileId, 'fileId'))}?alt=media`, { headers: auth(c) }),
    },
    {
      name: 'createFolder', label: 'Создать папку', write: true,
      params: { name: str('Имя папки'), parentId: opt('ID родительской папки', 'root') },
      run: async (c, a) => request('POST', 'https://www.googleapis.com/drive/v3/files', {
        headers: auth(c),
        body: { name: need(a.name, 'name'), mimeType: 'application/vnd.google-apps.folder', ...(a.parentId ? { parents: [a.parentId] } : {}) },
      }),
    },
    {
      name: 'updateFile', label: 'Обновить содержимое файла', write: true,
      params: { fileId: str('ID файла'), content: str('Новое текстовое содержимое') },
      run: async (c, a) => request('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(need(a.fileId, 'fileId'))}?uploadType=media`, {
        headers: { ...auth(c), 'Content-Type': 'text/plain; charset=utf-8' },
        body: String(a.content || ''),
      }),
    },
    {
      name: 'shareFile', label: 'Открыть доступ по ссылке', write: true,
      params: { fileId: str('ID файла'), role: opt('Роль: reader|writer|commenter', 'reader') },
      run: async (c, a) => request('POST', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(need(a.fileId, 'fileId'))}/permissions`, {
        headers: auth(c), body: { type: 'anyone', role: a.role || 'reader' },
      }),
    },
    {
      name: 'deleteFile', label: 'Удалить файл', write: true,
      params: { fileId: str('ID файла') },
      run: async (c, a) => request('DELETE', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(need(a.fileId, 'fileId'))}`, { headers: auth(c) }),
    },
  ],
};

/* ============================================================== GitHub */

const github = {
  id: 'github',
  name: 'GitHub',
  icon: 'github',
  category: 'Код',
  keyLabel: 'personal access token',
  keyHint: 'токен с scope repo — создаётся в Settings → Developer settings',
  keyUrl: 'https://github.com/settings/tokens',
  baseUrl: 'https://api.github.com',
  docs: 'https://docs.github.com/rest',
  authKind: 'bearer',
  verify: (creds) => request('GET', 'https://api.github.com/user', { headers: auth(creds) }),
  detail: (r) => (r.json && r.json.login ? `${r.json.login}${r.json.name ? ` (${r.json.name})` : ''}` : ''),
  actions: [
    {
      name: 'listRepos', label: 'Список репозиториев', write: false,
      params: { perPage: opt('Сколько репозиториев', '30'), sort: opt('created|updated|pushed|full_name', 'updated') },
      run: async (c, a) => request('GET', `https://api.github.com/user/repos?per_page=${encodeURIComponent(a.perPage || '30')}&sort=${encodeURIComponent(a.sort || 'updated')}`, { headers: auth(c) }),
    },
    {
      name: 'listIssues', label: 'Задачи репозитория', write: false,
      params: { owner: str('Владелец'), repo: str('Репозиторий'), state: opt('open|closed|all', 'open') },
      run: async (c, a) => request('GET', `https://api.github.com/repos/${esc(need(a.owner, 'owner'))}/${esc(need(a.repo, 'repo'))}/issues?state=${encodeURIComponent(a.state || 'open')}`, { headers: auth(c) }),
    },
    {
      name: 'createIssue', label: 'Создать задачу', write: true,
      params: { owner: str('Владелец'), repo: str('Репозиторий'), title: str('Заголовок'), body: opt('Описание', '') },
      run: async (c, a) => request('POST', `https://api.github.com/repos/${esc(need(a.owner, 'owner'))}/${esc(need(a.repo, 'repo'))}/issues`, {
        headers: auth(c), body: pick({ title: need(a.title, 'title'), body: a.body || undefined }, ['title', 'body']),
      }),
    },
    {
      name: 'commentIssue', label: 'Комментарий к задаче', write: true,
      params: { owner: str('Владелец'), repo: str('Репозиторий'), issueNumber: str('Номер задачи'), body: str('Текст комментария') },
      run: async (c, a) => request('POST', `https://api.github.com/repos/${esc(need(a.owner, 'owner'))}/${esc(need(a.repo, 'repo'))}/issues/${encodeURIComponent(need(a.issueNumber, 'issueNumber'))}/comments`, {
        headers: auth(c), body: { body: need(a.body, 'body') },
      }),
    },
    {
      name: 'getFile', label: 'Прочитать файл из репозитория', write: false,
      params: { owner: str('Владелец'), repo: str('Репозиторий'), path: str('Путь к файлу'), ref: opt('Ветка или коммит', 'HEAD') },
      run: async (c, a) => request('GET', `https://api.github.com/repos/${esc(need(a.owner, 'owner'))}/${esc(need(a.repo, 'repo'))}/contents/${esc(need(a.path, 'path'))}?ref=${encodeURIComponent(a.ref || 'HEAD')}`, { headers: auth(c) }),
    },
  ],
};

/* =============================================================== Slack */

const slack = {
  id: 'slack',
  name: 'Slack',
  icon: 'slack',
  category: 'Командная работа',
  keyLabel: 'bot token (xoxb-…)',
  keyHint: 'Create New App → OAuth & Permissions → Bot User Scopes',
  keyUrl: 'https://api.slack.com/authentication/token-types',
  baseUrl: 'https://slack.com/api',
  docs: 'https://api.slack.com/methods',
  authKind: 'bearer',
  verify: (creds) => request('POST', 'https://slack.com/api/auth.test', { headers: auth(creds) }),
  detail: (r) => (r.json && r.json.user ? `${r.json.user} · ${r.json.team}` : ''),
  actions: [
    {
      name: 'postMessage', label: 'Отправить в канал', write: true,
      params: { channel: str('ID канала (напр. C0123456789)'), text: str('Текст сообщения'), thread_ts: opt('TS для ответа в тред', '') },
      run: async (c, a) => request('POST', 'https://slack.com/api/chat.postMessage', {
        headers: auth(c), body: pick({ channel: need(a.channel, 'channel'), text: need(a.text, 'text'), thread_ts: a.thread_ts || undefined }, ['channel', 'text', 'thread_ts']),
      }),
    },
    {
      name: 'listChannels', label: 'Список каналов', write: false,
      params: { limit: opt('Сколько каналов', '100') },
      run: async (c, a) => request('GET', `https://slack.com/api/conversations.list?limit=${encodeURIComponent(a.limit || '100')}`, { headers: auth(c) }),
    },
    {
      name: 'listUsers', label: 'Список участников', write: false,
      params: { limit: opt('Сколько участников', '100') },
      run: async (c, a) => request('GET', `https://slack.com/api/users.list?limit=${encodeURIComponent(a.limit || '100')}`, { headers: auth(c) }),
    },
    {
      name: 'history', label: 'История канала', write: false,
      params: { channel: str('ID канала'), limit: opt('Сколько сообщений', '30') },
      run: async (c, a) => request('GET', `https://slack.com/api/conversations.history?channel=${encodeURIComponent(need(a.channel, 'channel'))}&limit=${encodeURIComponent(a.limit || '30')}`, { headers: auth(c) }),
    },
  ],
};

/* ============================================================== Notion */

const notion = {
  id: 'notion',
  name: 'Notion',
  icon: 'notion',
  category: 'Заметки',
  keyLabel: 'internal integration token',
  keyHint: 'secret_… из настроек интеграции, страницу нужно открыть для доступа',
  keyUrl: 'https://www.notion.so/my-integrations',
  baseUrl: 'https://api.notion.com/v1',
  docs: 'https://developers.notion.com',
  authKind: 'notion',
  verify: (creds) => request('GET', 'https://api.notion.com/v1/users/me', { headers: auth(creds) }),
  detail: (r) => (r.json && r.json.bot ? `${r.json.bot.owner && r.json.bot.owner.user ? r.json.bot.owner.user.email : ''}` || r.json.bot.id : ''),
  actions: [
    {
      name: 'search', label: 'Поиск по страницам', write: false,
      params: { query: opt('Поисковый запрос', ''), limit: opt('Сколько результатов', '20') },
      run: async (c, a) => request('POST', 'https://api.notion.com/v1/search', {
        headers: auth(c),
        body: { page_size: Number(a.limit) || 20, ...(a.query ? { query: a.query } : {}) },
      }),
    },
    {
      name: 'queryDatabase', label: 'Запрос к базе данных', write: false,
      params: { databaseId: str('ID базы данных') },
      run: async (c, a) => request('POST', `https://api.notion.com/v1/databases/${encodeURIComponent(need(a.databaseId, 'databaseId'))}/query`, {
        headers: auth(c), body: { page_size: 50 },
      }),
    },
    {
      name: 'createPage', label: 'Создать страницу', write: true,
      params: { parentId: str('ID родительской страницы или базы'), title: str('Заголовок'), content: opt('Текст страницы', '') },
      run: async (c, a) => request('POST', 'https://api.notion.com/v1/pages', {
        headers: auth(c),
        body: {
          parent: { page_id: need(a.parentId, 'parentId') },
          properties: { title: { title: [{ type: 'text', text: { content: need(a.title, 'title') } }] } },
          children: a.content ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: trim(a.content, 1800) } }] } }] : [],
        },
      }),
    },
    {
      name: 'appendBlock', label: 'Дописать блок на страницу', write: true,
      params: { pageId: str('ID страницы'), text: str('Текст блока') },
      run: async (c, a) => request('PATCH', `https://api.notion.com/v1/blocks/${encodeURIComponent(need(a.pageId, 'pageId'))}/children`, {
        headers: auth(c),
        body: { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: trim(a.text, 1800) } }] } }] },
      }),
    },
  ],
};

/* ============================================================= GitLab */

const gitlab = {
  id: 'gitlab',
  name: 'GitLab',
  icon: 'gitBranch',
  category: 'Код',
  keyLabel: 'personal access token',
  keyHint: 'токен со scope api — создаётся в Preferences → Access Tokens',
  keyUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  baseUrl: 'https://gitlab.com/api/v4',
  docs: 'https://docs.gitlab.com/ee/api/',
  authKind: 'gitlab',
  verify: (creds) => request('GET', 'https://gitlab.com/api/v4/user', { headers: auth(creds) }),
  detail: (r) => (r.json && r.json.username ? `${r.json.username}${r.json.name ? ` (${r.json.name})` : ''}` : ''),
  actions: [
    {
      name: 'listProjects', label: 'Список проектов', write: false,
      params: { perPage: opt('Сколько проектов', '20'), membership: opt('true — только свои', 'true') },
      run: async (c, a) => request('GET', `https://gitlab.com/api/v4/projects?membership=${encodeURIComponent(a.membership || 'true')}&per_page=${encodeURIComponent(a.perPage || '20')}&order_by=last_activity_at`, { headers: auth(c) }),
    },
    {
      name: 'listIssues', label: 'Задачи (issues)', write: false,
      params: { projectId: opt('ID проекта (пусто — все доступные)', ''), state: opt('opened|closed|all', 'opened') },
      run: async (c, a) => {
        const scope = a.projectId
          ? `/projects/${encodeURIComponent(need(a.projectId, 'projectId'))}/issues`
          : '/issues';
        return request('GET', `https://gitlab.com/api/v4${scope}?state=${encodeURIComponent(a.state || 'opened')}&per_page=20`, { headers: auth(c) });
      },
    },
    {
      name: 'createIssue', label: 'Создать задачу', write: true,
      params: { projectId: str('ID проекта'), title: str('Заголовок'), description: opt('Описание', '') },
      run: async (c, a) => request('POST', `https://gitlab.com/api/v4/projects/${encodeURIComponent(need(a.projectId, 'projectId'))}/issues`, {
        headers: auth(c),
        body: pick({ title: need(a.title, 'title'), description: a.description || undefined }, ['title', 'description']),
      }),
    },
    {
      name: 'getFile', label: 'Прочитать файл из репозитория', write: false,
      params: { projectId: str('ID проекта'), path: str('Путь к файлу'), ref: opt('Ветка', 'main') },
      run: async (c, a) => request('GET', `https://gitlab.com/api/v4/projects/${encodeURIComponent(need(a.projectId, 'projectId'))}/repository/files/${encodeURIComponent(need(a.path, 'path'))}?ref=${encodeURIComponent(a.ref || 'main')}`, { headers: auth(c) }),
    },
  ],
};

/* ============================================================= Discord */

const discord = {
  id: 'discord',
  name: 'Discord',
  icon: 'message',
  category: 'Мессенджеры',
  keyLabel: 'bot token',
  keyHint: 'Discord Developer Portal → Application → Bot → Reset Token',
  keyUrl: 'https://discord.com/developers/applications',
  baseUrl: 'https://discord.com/api/v10',
  docs: 'https://discord.com/developers/docs',
  authKind: 'bearer',
  verify: (creds) => request('GET', 'https://discord.com/api/v10/users/@me', { headers: auth(creds) }),
  detail: (r) => (r.json && r.json.username ? `${r.json.username}#${r.json.discriminator || '0'}` : ''),
  actions: [
    {
      name: 'sendMessage', label: 'Отправить в канал', write: true,
      params: { channelId: str('ID канала'), content: str('Текст сообщения') },
      run: async (c, a) => request('POST', `https://discord.com/api/v10/channels/${encodeURIComponent(need(a.channelId, 'channelId'))}/messages`, {
        headers: auth(c), body: { content: trim(need(a.content, 'content'), 1900) },
      }),
    },
    {
      name: 'listChannels', label: 'Каналы сервера', write: false,
      params: { guildId: str('ID сервера (гильда)') },
      run: async (c, a) => request('GET', `https://discord.com/api/v10/guilds/${encodeURIComponent(need(a.guildId, 'guildId'))}/channels`, { headers: auth(c) }),
    },
  ],
};

/* ============================================================== Resend */

const resend = {
  id: 'resend',
  name: 'Почта (Resend)',
  icon: 'mail',
  category: 'Почта',
  keyLabel: 'API key (re_…)',
  keyHint: 'только отправка писем; домен отправителя должен быть подтверждён',
  keyUrl: 'https://resend.com/api-keys',
  baseUrl: 'https://api.resend.com',
  docs: 'https://resend.com/docs/api-reference',
  authKind: 'bearer',
  verify: (creds) => request('GET', 'https://api.resend.com/domains', { headers: auth(creds) }),
  detail: (r) => (Array.isArray(r.json && r.json.data) ? `доменов: ${r.json.data.length}` : ''),
  actions: [
    {
      name: 'sendEmail', label: 'Отправить письмо', write: true,
      params: { from: str('Отправитель, напр. NEXUS <bot@ваш-домен>'), to: str('Получатель'), subject: str('Тема'), html: opt('HTML-тело письма', '') },
      run: async (c, a) => request('POST', 'https://api.resend.com/emails', {
        headers: auth(c),
        body: pick({ from: need(a.from, 'from'), to: need(a.to, 'to'), subject: need(a.subject, 'subject'), html: a.html || undefined }, ['from', 'to', 'subject', 'html']),
      }),
    },
  ],
};

/* ==================================== Obsidian: локальное хранилище заметок */

const obsidian = {
  id: 'obsidian',
  name: 'Obsidian',
  icon: 'pen',
  category: 'Заметки',
  keyLabel: 'ключ не нужен',
  keyHint: 'Укажите путь к хранилищу в поле ниже, например C:\\Users\\you\\Documents\\vault',
  keyUrl: '',
  baseUrl: '',
  urlLabel: 'Путь к хранилищу (папка)',
  docs: 'https://help.obsidian.md',
  authKind: 'none',
  /* Единственная интеграция без ключа: доступ — это путь к папке на этом ПК */
  keyRequired: false,
  verify: (creds) => {
    const v = vaultRoot(creds);
    if (v.error) return Promise.resolve({ ok: false, error: v.error });
    let notes = 0;
    try {
      notes = listVaultMd(v.root).length;
    } catch (e) {
      return Promise.resolve({ ok: false, error: `Не удалось прочитать хранилище: ${e.message}` });
    }
    return Promise.resolve({ ok: true, status: 200, json: { vault: v.root, notes } });
  },
  detail: (r) => (r.json ? `${r.json.notes} заметок · ${r.json.vault}` : ''),
  actions: [
    {
      name: 'list_notes', label: 'Список заметок', write: false,
      params: { limit: opt('Сколько показать', '100') },
      run: async (c) => {
        const v = vaultRoot(c);
        if (v.error) return { ok: false, error: v.error };
        const all = listVaultMd(v.root);
        const n = Math.min(Math.max(Number(c.limit) || 100, 1), 200);
        return { ok: true, json: { vault: v.root, count: all.length, notes: all.slice(0, n) } };
      },
    },
    {
      name: 'read_note', label: 'Прочитать заметку', write: false,
      params: { name: str('Имя заметки (можно без .md)') },
      run: async (c, a) => {
        const v = vaultRoot(c);
        if (v.error) return { ok: false, error: v.error };
        const f = vaultNote(v.root, a.name);
        if (f.error) return { ok: false, error: f.error };
        let st;
        try {
          st = fs.statSync(f.path);
        } catch {
          return { ok: false, error: `Заметка не найдена: ${a.name}` };
        }
        if (!st.isFile()) return { ok: false, error: 'Это не файл' };
        if (st.size > 256 * 1024) return { ok: false, error: 'Заметка больше 256 КБ' };
        return { ok: true, json: { name: f.rel, size: st.size, content: fs.readFileSync(f.path, 'utf8') } };
      },
    },
    {
      name: 'write_note', label: 'Создать/перезаписать заметку', write: true,
      params: { name: str('Имя заметки (можно без .md)'), content: str('Текст в Markdown') },
      run: async (c, a) => {
        const v = vaultRoot(c);
        if (v.error) return { ok: false, error: v.error };
        const f = vaultNote(v.root, a.name, true);
        if (f.error) return { ok: false, error: f.error };
        const content = typeof a.content === 'string' ? a.content : '';
        if (Buffer.byteLength(content) > 256 * 1024) return { ok: false, error: 'Текст больше 256 КБ' };
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, content, 'utf8');
        return { ok: true, json: { name: f.rel, bytes: Buffer.byteLength(content) } };
      },
    },
    {
      name: 'search_notes', label: 'Поиск по заметкам', write: false,
      params: { query: str('Искомая подстрока'), limit: opt('Сколько совпадений', '30') },
      run: async (c, a) => {
        const v = vaultRoot(c);
        if (v.error) return { ok: false, error: v.error };
        const q = String(a.query || '');
        if (!q.trim()) return { ok: false, error: 'Не указан запрос' };
        const n = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
        const hits = [];
        for (const rel of listVaultMd(v.root)) {
          if (hits.length >= n) break;
          const full = path.join(v.root, rel);
          let text = '';
          try {
            const st = fs.statSync(full);
            if (st.size > 1024 * 1024) continue;
            text = fs.readFileSync(full, 'utf8');
          } catch { continue; }
          const idx = text.toLowerCase().indexOf(q.toLowerCase());
          if (idx >= 0) {
            hits.push({ note: rel, at: idx, fragment: text.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, ' ').trim().slice(0, 240) });
          }
        }
        return { ok: true, json: { query: q, hits: hits.length, results: hits } };
      },
    },
  ],
};

/* ============================================================= Trello */

const trello = {
  id: 'trello',
  name: 'Trello',
  icon: 'checkSquare',
  category: 'Задачи',
  keyLabel: 'ключ и токен через двоеточие',
  keyHint: 'вставьте как key:token — ключ с trello.com/app-key, токен по ссылке Authorize',
  keyUrl: 'https://trello.com/app-key',
  baseUrl: 'https://api.trello.com/1',
  docs: 'https://developer.atlassian.com/cloud/trello/rest/',
  authKind: 'trello',
  verify: (creds) => {
    const t = trelloCreds(creds);
    if (t.error) return Promise.resolve({ ok: false, error: t.error });
    return request('GET', `https://api.trello.com/1/members/me?key=${esc(t.key)}&token=${esc(t.token)}`);
  },
  detail: (r) => (r.json && r.json.username ? `${r.json.username}${r.json.fullName ? ` (${r.json.fullName})` : ''}` : ''),
  actions: [
    {
      name: 'listBoards', label: 'Список досок', write: false,
      params: {},
      run: async (c) => {
        const t = trelloCreds(c);
        if (t.error) return { ok: false, error: t.error };
        return request('GET', `https://api.trello.com/1/members/me/boards?filter=open&fields=id,name,url&key=${esc(t.key)}&token=${esc(t.token)}`);
      },
    },
    {
      name: 'listLists', label: 'Колонки доски', write: false,
      params: { boardId: str('ID доски') },
      run: async (c, a) => {
        const t = trelloCreds(c);
        if (t.error) return { ok: false, error: t.error };
        return request('GET', `https://api.trello.com/1/boards/${esc(need(a.boardId, 'boardId'))}/lists?filter=open&fields=id,name&key=${esc(t.key)}&token=${esc(t.token)}`);
      },
    },
    {
      name: 'listCards', label: 'Карточки доски', write: false,
      params: { boardId: str('ID доски') },
      run: async (c, a) => {
        const t = trelloCreds(c);
        if (t.error) return { ok: false, error: t.error };
        return request('GET', `https://api.trello.com/1/boards/${esc(need(a.boardId, 'boardId'))}/cards?filter=open&fields=id,name,desc,due,url&limit=50&key=${esc(t.key)}&token=${esc(t.token)}`);
      },
    },
    {
      name: 'createCard', label: 'Создать карточку', write: true,
      params: { listId: str('ID колонки'), name: str('Название'), desc: opt('Описание', '') },
      run: async (c, a) => {
        const t = trelloCreds(c);
        if (t.error) return { ok: false, error: t.error };
        return request('POST', `https://api.trello.com/1/cards?idList=${esc(need(a.listId, 'listId'))}&name=${esc(need(a.name, 'name'))}&desc=${esc(a.desc || '')}&key=${esc(t.key)}&token=${esc(t.token)}`);
      },
    },
  ],
};

function trelloCreds(c) {
  const raw = String((c && c.apiKey) || '');
  const i = raw.indexOf(':');
  if (i < 0) return { error: 'Вставьте ключ как key:token (ключ, двоеточие, токен)' };
  const key = raw.slice(0, i).trim();
  const token = raw.slice(i + 1).trim();
  if (!key || !token) return { error: 'Вставьте ключ как key:token (ключ, двоеточие, токен)' };
  return { key, token };
}

/* ========================================================= OpenWeather */

const openweather = {
  id: 'openweather',
  name: 'Погода (OpenWeather)',
  icon: 'cloud',
  category: 'Данные',
  keyLabel: 'API key',
  keyHint: 'бесплатный ключ с openweathermap.org — раздел API keys',
  keyUrl: 'https://openweathermap.org/appid',
  baseUrl: 'https://api.openweathermap.org/data/2.5',
  docs: 'https://openweathermap.org/current',
  authKind: 'query',
  verify: (creds) => request('GET', `https://api.openweathermap.org/data/2.5/weather?q=Moscow&appid=${esc(need(creds.apiKey, 'API key'))}&units=metric&lang=ru`),
  detail: (r) => (r.json && r.json.name ? `${r.json.name}: ${r.json.main && Math.round(r.json.main.temp)}°C` : ''),
  actions: [
    {
      name: 'current', label: 'Погода сейчас', write: false,
      params: { city: str('Город, например Москва') },
      run: async (c, a) => request('GET', `https://api.openweathermap.org/data/2.5/weather?q=${esc(need(a.city, 'city'))}&appid=${esc(need(c.apiKey, 'API key'))}&units=metric&lang=ru`),
    },
    {
      name: 'forecast', label: 'Прогноз на дни', write: false,
      params: { city: str('Город, например Москва') },
      run: async (c, a) => request('GET', `https://api.openweathermap.org/data/2.5/forecast?q=${esc(need(a.city, 'city'))}&appid=${esc(need(c.apiKey, 'API key'))}&units=metric&lang=ru&cnt=16`),
    },
  ],
};

/* ================================================== Google Поиск (свой API-ключ) */

const googlesearch = {
  id: 'googlesearch',
  name: 'Google Поиск',
  icon: 'search',
  category: 'Поиск',
  keyLabel: 'API key (Custom Search)',
  keyHint: 'ключ Google Cloud (Custom Search API) + ID поисковой системы (CX) в поле ниже',
  keyUrl: 'https://developers.google.com/custom-search/v1/overview',
  baseUrl: 'https://www.googleapis.com/customsearch/v1',
  urlLabel: 'ID поисковой системы (CX)',
  docs: 'https://developers.google.com/custom-search/v1/overview',
  authKind: 'query',
  verify: (creds) => request('GET', `https://www.googleapis.com/customsearch/v1?key=${esc(need(creds.apiKey, 'API key'))}&cx=${esc(need(creds.url, 'CX'))}&q=test&num=1`),
  detail: (r) => (r.json && r.json.searchInformation
    ? `найдено: ${r.json.searchInformation.formattedTotalResults || '?'}, ${((r.json.searchInformation.searchTime || 0)).toFixed(2)} с`
    : ''),
  actions: [
    {
      name: 'search', label: 'Поиск в Google', write: false,
      params: { query: str('Поисковый запрос'), count: opt('Сколько результатов (1–10)', '8') },
      run: async (c, a) => {
        const n = Math.min(Math.max(Number(a.count) || 8, 1), 10);
        const res = await request('GET', `https://www.googleapis.com/customsearch/v1?key=${esc(need(c.apiKey, 'API key'))}&cx=${esc(need(c.url, 'CX'))}&q=${esc(need(a.query, 'query'))}&num=${n}&lr=lang_ru`);
        if (!res.ok || !res.json) return res;
        const items = (res.json.items || []).map((it) => ({ title: it.title, url: it.link, snippet: it.snippet }));
        return { ok: true, json: { query: a.query, count: items.length, results: items } };
      },
    },
  ],
};

/* ============================================================ Exa AI */

const exa = {
  id: 'exa',
  name: 'Exa AI',
  icon: 'zap',
  category: 'Поиск',
  keyLabel: 'API key',
  keyHint: 'ключ с dashboard.exa.ai — нейропоиск + чтение страниц целиком',
  keyUrl: 'https://dashboard.exa.ai/api-keys',
  baseUrl: 'https://api.exa.ai',
  docs: 'https://docs.exa.ai',
  authKind: 'exa',
  verify: (creds) => request('POST', 'https://api.exa.ai/search', {
    headers: exaAuth(creds),
    body: { query: 'test', numResults: 1 },
  }),
  detail: (r) => (r.json && Array.isArray(r.json.results) ? `поиск работает: ${r.json.results.length} результат` : ''),
  actions: [
    {
      name: 'search', label: 'Нейропоиск', write: false,
      params: { query: str('Вопрос или тема'), count: opt('Сколько результатов (1–10)', '8') },
      run: async (c, a) => {
        const n = Math.min(Math.max(Number(a.count) || 8, 1), 10);
        const res = await request('POST', 'https://api.exa.ai/search', {
          headers: exaAuth(c),
          body: { query: need(a.query, 'query'), numResults: n, text: true },
        });
        if (!res.ok || !res.json) return res;
        const items = ((res.json.results || []).map((it) => ({ title: it.title, url: it.url, snippet: (it.text || '').slice(0, 300) })));
        return { ok: true, json: { query: a.query, count: items.length, results: items } };
      },
    },
    {
      name: 'contents', label: 'Прочитать страницы', write: false,
      params: { urls: str('URL через запятую (до 5)'), maxChars: opt('Сколько символов с каждой (макс. 8000)', '4000') },
      run: async (c, a) => {
        const urls = String(a.urls || '').split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)).slice(0, 5);
        if (!urls.length) return { ok: false, error: 'Укажи хотя бы один http(s)-адрес' };
        const n = Math.min(Math.max(Number(a.maxChars) || 4000, 500), 8000);
        const res = await request('POST', 'https://api.exa.ai/contents', {
          headers: exaAuth(c),
          body: { urls, text: { maxCharacters: n } },
        });
        if (!res.ok || !res.json) return res;
        const items = (res.json.results || []).map((it) => ({ title: it.title, url: it.url, text: (it.text || '').slice(0, n) }));
        return { ok: true, json: { count: items.length, results: items } };
      },
    },
  ],
};

function exaAuth(creds) {
  return { 'Content-Type': 'application/json', 'x-api-key': need(creds.apiKey, 'API key') };
}

/* ============================================================ RSS-ленты */

const rss = {
  id: 'rss',
  name: 'RSS-ленты',
  icon: 'link',
  category: 'Данные',
  keyLabel: 'ключ не нужен',
  keyHint: 'Укажите адрес RSS/Atom-ленты в поле ниже — агент будет читать новости и статьи',
  keyUrl: '',
  baseUrl: '',
  urlLabel: 'Адрес RSS-ленты',
  docs: '',
  authKind: 'none',
  keyRequired: false,
  verify: async (creds) => {
    const items = await readRssFeed(creds.url, 3);
    if (items.error) return { ok: false, error: items.error };
    return { ok: true, status: 200, json: { feed: creds.url, items: items.items } };
  },
  detail: (r) => (r.json ? `лента жива: ${r.json.items.length} новостей` : ''),
  actions: [
    {
      name: 'read', label: 'Прочитать ленту', write: false,
      params: { url: opt('Другая лента (по умолчанию — сохранённая)', '') },
      run: async (c, a) => {
        const feed = (a.url || '').trim() || c.url;
        const items = await readRssFeed(feed, 20);
        if (items.error) return { ok: false, error: items.error };
        return { ok: true, json: { feed, count: items.items.length, items: items.items } };
      },
    },
  ],
};

async function readRssFeed(feedUrl, limit) {
  const raw = String(feedUrl || '').trim();
  if (!raw) return { error: 'Не указан адрес ленты' };
  if (!/^https?:\/\//i.test(raw)) return { error: 'Адрес ленты — только http(s)' };
  let xml = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(raw, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NEXUS-Agent/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: controller.signal,
      redirect: 'follow',
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { error: `Лента ответила ${res.status}` };
    xml = (await res.text()).slice(0, 1024 * 1024);
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'Таймаут ленты' : `Лента недоступна: ${e.message}` };
  }
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    if (items.length >= limit) break;
    const tag = (name) => {
      const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(b);
      return m ? stripTags(m[1]).slice(0, 400) : '';
    };
    const linkM = /<link[^>]*href="([^"]+)"[^>]*\/?>/i.exec(b) || /<link[^>]*>([\s\S]*?)<\/link>/i.exec(b);
    const title = tag('title');
    const link = stripTags(linkM ? linkM[1] : '').trim();
    if (!title && !link) continue;
    items.push({ title: title || link, link, date: tag('pubDate') || tag('published') || tag('updated') });
  }
  if (!items.length) return { error: 'В ленте нет новостей или это не RSS/Atom' };
  return { items };
}

/* ========================================================= Hacker News */

const hackernews = {
  id: 'hackernews',
  name: 'Hacker News',
  icon: 'message',
  category: 'Данные',
  keyLabel: 'ключ не нужен',
  keyHint: 'Технологические новости и обсуждения — всё открыто, без регистрации',
  keyUrl: '',
  baseUrl: 'https://hn.algolia.com/api/v1',
  docs: 'https://hn.algolia.com/api',
  authKind: 'none',
  keyRequired: false,
  verify: (creds) => request('GET', 'https://hn.algolia.com/api/v1/search?query=test&hitsPerPage=1'),
  detail: () => 'API доступен',
  actions: [
    {
      name: 'search', label: 'Поиск по новостям', write: false,
      params: { query: str('Запрос, например artificial intelligence'), count: opt('Сколько (1–15)', '8') },
      run: async (c, a) => {
        const n = Math.min(Math.max(Number(a.count) || 8, 1), 15);
        const res = await request('GET', `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(need(a.query, 'query'))}&hitsPerPage=${n}`);
        if (!res.ok || !res.json) return res;
        const items = ((res.json.hits || []).map((h) => ({
          title: h.title, url: h.url, points: h.points, comments: h.num_comments, date: h.created_at,
        })));
        return { ok: true, json: { query: a.query, count: items.length, results: items } };
      },
    },
    {
      name: 'front', label: 'Главная сейчас', write: false,
      params: {},
      run: async () => {
        const res = await request('GET', 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15');
        if (!res.ok || !res.json) return res;
        const items = ((res.json.hits || []).map((h) => ({
          title: h.title, url: h.url, points: h.points, comments: h.num_comments,
        })));
        return { ok: true, json: { count: items.length, results: items } };
      },
    },
  ],
};

/* ============================================================ CoinGecko */

const coingecko = {
  id: 'coingecko',
  name: 'Крипта (CoinGecko)',
  icon: 'chart',
  category: 'Данные',
  keyLabel: 'ключ не нужен',
  keyHint: 'Курсы криптовалют — публичный бесплатный API',
  keyUrl: '',
  baseUrl: 'https://api.coingecko.com/api/v3',
  docs: 'https://docs.coingecko.com/reference/introduction',
  authKind: 'none',
  keyRequired: false,
  verify: (creds) => request('GET', 'https://api.coingecko.com/api/v3/ping'),
  detail: (r) => (r.json && r.json.gecko_says ? 'API доступен' : ''),
  actions: [
    {
      name: 'price', label: 'Курс монет', write: false,
      params: { coins: str('ID через запятую, например bitcoin,ethereum,solana'), currency: opt('Валюта', 'usd') },
      run: async (c, a) => request('GET', `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(need(a.coins, 'coins'))}&vs_currencies=${encodeURIComponent(a.currency || 'usd')}&include_24hr_change=true`),
    },
    {
      name: 'top', label: 'Топ монет', write: false,
      params: { count: opt('Сколько (1–20)', '10'), currency: opt('Валюта', 'usd') },
      run: async (c, a) => {
        const n = Math.min(Math.max(Number(a.count) || 10, 1), 20);
        const res = await request('GET', `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${encodeURIComponent(a.currency || 'usd')}&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=24h`);
        if (!res.ok || !res.json) return res;
        const items = ((Array.isArray(res.json) ? res.json : []).map((m) => ({
          name: m.name, symbol: m.symbol, price: m.current_price, change24h: m.price_change_percentage_24h,
        })));
        return { ok: true, json: { count: items.length, results: items } };
      },
    },
  ],
};

/* ================================================== Валюты (Frankfurter) */

const currency = {
  id: 'currency',
  name: 'Валюты',
  icon: 'chart',
  category: 'Данные',
  keyLabel: 'ключ не нужен',
  keyHint: 'Курсы мировых валют (кроме RUB — ЦБ Европы его больше не публикует)',
  keyUrl: '',
  baseUrl: 'https://api.frankfurter.dev/v1',
  docs: 'https://www.frankfurter.app/docs/',
  authKind: 'none',
  keyRequired: false,
  verify: (creds) => request('GET', 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR'),
  detail: (r) => (r.json && r.json.rates ? `курсы доступны: ${(r.json.date || '').slice(0, 10)}` : ''),
  actions: [
    {
      name: 'rates', label: 'Курсы валют', write: false,
      params: { base: opt('Базовая валюта (USD, EUR, RUB)', 'USD') },
      run: async (c, a) => {
        const base = String(a.base || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
        return request('GET', 'https://api.frankfurter.dev/v1/latest?base=' + base);
      },
    },
    {
      name: 'convert', label: 'Перевести сумму', write: false,
      params: { amount: str('Сумма'), from: str('Из валюты'), to: str('В валюту') },
      run: async (c, a) => {
        const amount = Number(a.amount);
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Сумма — положительное число' };
        const from = String(a.from || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
        const to = String(a.to || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
        if (!from || !to) return { ok: false, error: 'Укажи валюты кодами: USD, EUR, RUB' };
        const res = await request('GET', 'https://api.frankfurter.dev/v1/latest?base=' + from + '&symbols=' + to);
        if (!res.ok || !res.json) return res;
        const rate = res.json && res.json.rates ? res.json.rates[to] : null;
        if (rate == null) return { ok: false, error: 'Нет такого курса' };
        return { ok: true, json: { amount, from, to, rate, result: Math.round(amount * rate * 100) / 100 } };
      },
    },
  ],
};

/* =========================================================== Wikipedia */

const wikipedia = {
  id: 'wikipedia',
  name: 'Википедия',
  icon: 'search',
  category: 'Данные',
  keyLabel: 'ключ не нужен',
  keyHint: 'Справки и факты — открытое API без регистрации',
  keyUrl: '',
  baseUrl: 'https://ru.wikipedia.org/api/rest_v1',
  docs: 'https://www.mediawiki.org/wiki/Wikimedia_REST_API',
  authKind: 'none',
  keyRequired: false,
  verify: (creds) => request('GET', 'https://ru.wikipedia.org/api/rest_v1/page/summary/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0'),
  detail: (r) => (r.json && r.json.title ? `API доступно: ${r.json.title}` : ''),
  actions: [
    {
      name: 'summary', label: 'Справка по теме', write: false,
      params: { topic: str('Тема, например Квантовый компьютер') },
      run: async (c, a) => {
        const res = await request('GET', `https://ru.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(need(a.topic, 'topic'))}`);
        if (!res.ok || !res.json) return { ok: false, error: res.error || 'Статья не найдена' };
        const j = res.json;
        return { ok: true, json: { title: j.title, text: (j.extract || '').slice(0, 2000), url: j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page } };
      },
    },
    {
      name: 'search', label: 'Поиск статей', write: false,
      params: { query: str('Запрос'), count: opt('Сколько (1–10)', '5') },
      run: async (c, a) => {
        const n = Math.min(Math.max(Number(a.count) || 5, 1), 10);
        const res = await request('GET', `https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(need(a.query, 'query'))}&srlimit=${n}&format=json&formatversion=2`);
        if (!res.ok || !res.json) return res;
        const items = (((res.json.query || {}).search || []).map((s) => ({ title: s.title, snippet: stripTags(s.snippet || '').slice(0, 200) })));
        return { ok: true, json: { query: a.query, count: items.length, results: items } };
      },
    },
  ],
};

/* ================================================================ Jira */

function jiraParts(c) {
  const raw = String((c && c.apiKey) || '');
  const i = raw.indexOf(':');
  if (i < 0) return { error: 'Вставьте ключ как email:API-токен (токен — из Atlassian Account → Security → API token)' };
  const email = raw.slice(0, i).trim();
  const token = raw.slice(i + 1).trim();
  const site = String((c && c.url) || '').replace(/\/+$/, '');
  if (!email || !token) return { error: 'Вставьте ключ как email:API-токен' };
  if (!/^https:\/\//i.test(site)) return { error: 'В поле адреса укажите сайт Jira: https://ваш-домен.atlassian.net' };
  const headers = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
  return { site, headers };
}

const jira = {
  id: 'jira',
  name: 'Jira',
  icon: 'checkSquare',
  category: 'Задачи',
  keyLabel: 'email и API-токен через двоеточие',
  keyHint: 'вставьте как email:токен — токен создаётся в Atlassian Account → Безопасность',
  keyUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  baseUrl: 'https://your-domain.atlassian.net',
  urlLabel: 'Адрес Jira (https://….atlassian.net)',
  docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
  authKind: 'jira',
  customBase: true,
  verify: (creds) => {
    const j = jiraParts(creds);
    if (j.error) return Promise.resolve({ ok: false, error: j.error });
    return request('GET', `${j.site}/rest/api/3/myself`, { headers: j.headers });
  },
  detail: (r) => (r.json && r.json.emailAddress ? `${r.json.displayName} (${r.json.emailAddress})` : ''),
  actions: [
    {
      name: 'search', label: 'Поиск задач (JQL)', write: false,
      params: { jql: str('JQL-запрос, например project = DEV ORDER BY updated DESC'), limit: opt('Сколько (1–50)', '20') },
      run: async (c, a) => {
        const j = jiraParts(c);
        if (j.error) return { ok: false, error: j.error };
        const n = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
        const res = await request('GET', `${j.site}/rest/api/3/search/jql?jql=${esc(need(a.jql, 'jql'))}&maxResults=${n}&fields=summary,status,assignee,updated`, { headers: j.headers });
        if (!res.ok || !res.json) return res;
        const items = ((res.json.issues || []).map((it) => ({ key: it.key, summary: it.fields && it.fields.summary, status: it.fields && it.fields.status && it.fields.status.name })));
        return { ok: true, json: { total: res.json.total, issues: items } };
      },
    },
    {
      name: 'get', label: 'Карточка задачи', write: false,
      params: { key: str('Ключ задачи, например DEV-123') },
      run: async (c, a) => {
        const j = jiraParts(c);
        if (j.error) return { ok: false, error: j.error };
        const res = await request('GET', `${j.site}/rest/api/3/issue/${esc(need(a.key, 'key'))}?fields=summary,description,status,assignee,priority,updated`, { headers: j.headers });
        if (!res.ok || !res.json) return res;
        return { ok: true, json: { key: res.json.key, fields: res.json.fields } };
      },
    },
    {
      name: 'create', label: 'Создать задачу', write: true,
      params: { project: str('Ключ проекта, например DEV'), summary: str('Заголовок'), desc: opt('Описание', ''), issueType: opt('Тип задачи', 'Task') },
      run: async (c, a) => {
        const j = jiraParts(c);
        if (j.error) return { ok: false, error: j.error };
        return request('POST', `${j.site}/rest/api/3/issue`, {
          headers: j.headers,
          body: { fields: { project: { key: need(a.project, 'project') }, summary: need(a.summary, 'summary'), description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(a.desc || '') }] }] }, issuetype: { name: a.issueType || 'Task' } } },
        });
      },
    },
  ],
};

/* ============================================================== Linear */

const linear = {
  id: 'linear',
  name: 'Linear',
  icon: 'zap',
  category: 'Задачи',
  keyLabel: 'Personal API key',
  keyHint: 'ключ из Linear → Settings → API → Personal API keys',
  keyUrl: 'https://linear.app/settings/api',
  baseUrl: 'https://api.linear.app/graphql',
  docs: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
  authKind: 'bearer',
  verify: (creds) => request('POST', 'https://api.linear.app/graphql', {
    headers: auth(creds),
    body: { query: '{ viewer { id name email } }' },
  }),
  detail: (r) => (r.json && r.json.data && r.json.data.viewer ? `${r.json.data.viewer.name} (${r.json.data.viewer.email || ''})` : ''),
  actions: [
    {
      name: 'list', label: 'Список задач', write: false,
      params: { limit: opt('Сколько (1–50)', '20') },
      run: async (c, a) => {
        const n = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
        const res = await request('POST', 'https://api.linear.app/graphql', {
          headers: auth(c),
          body: { query: `{ issues(first: ${n}, orderBy: updatedAt) { nodes { identifier title state { name } assignee { name } } } }` },
        });
        if (!res.ok || !res.json || !res.json.data) return { ok: false, error: (res.json && res.json.errors && res.json.errors[0] && res.json.errors[0].message) || res.error || 'Linear отклонил запрос' };
        return { ok: true, json: { issues: res.json.data.issues.nodes } };
      },
    },
    {
      name: 'create', label: 'Создать задачу', write: true,
      params: { teamId: str('ID команды (видно в URL настроек команды)'), title: str('Заголовок'), desc: opt('Описание', '') },
      run: async (c, a) => {
        const res = await request('POST', 'https://api.linear.app/graphql', {
          headers: auth(c),
          body: { query: 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier title url } } }', variables: { input: { teamId: need(a.teamId, 'teamId'), title: need(a.title, 'title'), description: String(a.desc || '') } } },
        });
        if (!res.ok || !res.json || !((res.json.data || {}).issueCreate || {}).success) {
          return { ok: false, error: (res.json && res.json.errors && res.json.errors[0] && res.json.errors[0].message) || res.error || 'Linear отклонил запрос' };
        }
        return { ok: true, json: res.json.data.issueCreate.issue };
      },
    },
  ],
};

/* ============================================================= Airtable */

function airtableBase(c, a) {
  const base = String((a && a.base) || (c && c.url) || '').trim().replace(/\/+$/, '');
  if (!/^app[A-Za-z0-9]+$/.test(base)) return { error: 'Укажите ID базы (app…): в поле адреса сервиса или параметром base' };
  return { base };
}

const airtable = {
  id: 'airtable',
  name: 'Airtable',
  icon: 'layout',
  category: 'Таблицы',
  keyLabel: 'Personal Access Token',
  keyHint: 'токен с airtable.com/create/tokens + ID базы (app…) в поле адреса',
  keyUrl: 'https://airtable.com/create/tokens',
  baseUrl: 'https://api.airtable.com/v0',
  urlLabel: 'ID базы (app…)',
  docs: 'https://airtable.com/developers/web/api/introduction',
  authKind: 'bearer',
  customBase: true,
  verify: (creds) => request('GET', 'https://api.airtable.com/v0/meta/bases', { headers: auth(creds) }),
  detail: (r) => (r.json && Array.isArray(r.json.bases) ? `баз доступно: ${r.json.bases.length}` : ''),
  actions: [
    {
      name: 'list', label: 'Строки таблицы', write: false,
      params: { base: opt('ID базы (по умолчанию — из адреса сервиса)', ''), table: str('Имя или ID таблицы'), limit: opt('Сколько (1–100)', '20') },
      run: async (c, a) => {
        const b = airtableBase(c, a);
        if (b.error) return { ok: false, error: b.error };
        const n = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
        return request('GET', `https://api.airtable.com/v0/${b.base}/${esc(need(a.table, 'table'))}?maxRecords=${n}`, { headers: auth(c) });
      },
    },
    {
      name: 'create', label: 'Добавить строку', write: true,
      params: { base: opt('ID базы (по умолчанию — из адреса сервиса)', ''), table: str('Имя или ID таблицы'), fields: str('Поля JSON-объектом, например {"Name":"Тест"}') },
      run: async (c, a) => {
        const b = airtableBase(c, a);
        if (b.error) return { ok: false, error: b.error };
        let fields;
        try {
          fields = JSON.parse(need(a.fields, 'fields'));
        } catch {
          return { ok: false, error: 'fields — некорректный JSON' };
        }
        return request('POST', `https://api.airtable.com/v0/${b.base}/${esc(need(a.table, 'table'))}`, { headers: auth(c), body: { fields } });
      },
    },
  ],
};

/* ============================================================= Supabase */

function supabaseParts(c) {
  const url = String((c && c.url) || '').replace(/\/+$/, '');
  if (!/^https:\/\/.+\.supabase\.co$/i.test(url) && !/^https:\/\//i.test(url)) {
    return { error: 'В поле адреса укажите URL проекта: https://ваш-проект.supabase.co' };
  }
  if (!/^https:\/\//i.test(url)) return { error: 'В поле адреса укажите URL проекта: https://ваш-проект.supabase.co' };
  return { url };
}

const supabase = {
  id: 'supabase',
  name: 'Supabase',
  icon: 'database',
  category: 'Базы данных',
  keyLabel: 'service_role или anon key',
  keyHint: 'ключ из Project Settings → API; для записи нужен service_role',
  keyUrl: 'https://supabase.com/dashboard/project/_/settings/api',
  baseUrl: '',
  urlLabel: 'URL проекта (https://….supabase.co)',
  docs: 'https://supabase.com/docs/reference/javascript/introduction',
  authKind: 'bearer',
  customBase: true,
  verify: (creds) => request('GET', `${supabaseParts(creds).url}/auth/v1/health`, { headers: auth(creds) }),
  detail: (r) => (r.json && r.json.version ? `Auth API жив, версия ${r.json.version}` : ''),
  actions: [
    {
      name: 'select', label: 'Прочитать строки', write: false,
      params: { table: str('Имя таблицы'), columns: opt('Колонки через запятую', '*'), limit: opt('Сколько (1–100)', '20') },
      run: async (c, a) => {
        const s = supabaseParts(c);
        if (s.error) return { ok: false, error: s.error };
        const cols = String(a.columns || '*').trim() || '*';
        const n = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
        return request('GET', `${s.url}/rest/v1/${esc(need(a.table, 'table'))}?select=${esc(cols)}&limit=${n}`, {
          headers: { ...auth(c), apikey: need(c.apiKey, 'ключ Supabase') },
        });
      },
    },
    {
      name: 'insert', label: 'Добавить строку', write: true,
      params: { table: str('Имя таблицы'), row: str('Строка JSON-объектом, например {"name":"Тест"}') },
      run: async (c, a) => {
        const s = supabaseParts(c);
        if (s.error) return { ok: false, error: s.error };
        let row;
        try {
          row = JSON.parse(need(a.row, 'row'));
        } catch {
          return { ok: false, error: 'row — некорректный JSON' };
        }
        return request('POST', `${s.url}/rest/v1/${esc(need(a.table, 'table'))}`, {
          headers: { ...auth(c), apikey: need(c.apiKey, 'ключ Supabase'), Prefer: 'return=representation' },
          body: row,
        });
      },
    },
  ],
};

/* ============================================================== SearXNG */

const searxng = {
  id: 'searxng',
  name: 'SearXNG (поиск)',
  icon: 'search',
  category: 'Поиск',
  keyLabel: 'ключ не нужен',
  keyHint: 'Свой или публичный инстанс SearXNG — адрес в поле ниже',
  keyUrl: 'https://searx.space',
  baseUrl: '',
  urlLabel: 'Адрес инстанса (https://…)',
  docs: 'https://docs.searxng.org/dev/search_api.html',
  authKind: 'none',
  keyRequired: false,
  customBase: true,
  verify: (creds) => {
    const base = String((creds && creds.url) || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return Promise.resolve({ ok: false, error: 'Укажите адрес инстанса: https://…' });
    return request('GET', `${base}/search?q=test&format=json`);
  },
  detail: (r) => (r.json && Array.isArray(r.json.results) ? `поиск отвечает, пример: ${((r.json.results[0] || {}).title || '').slice(0, 60)}` : ''),
  actions: [
    {
      name: 'search', label: 'Поиск в вебе', write: false,
      params: { query: str('Запрос'), count: opt('Сколько (1–20)', '8'), lang: opt('Язык (ru, en…)', 'ru') },
      run: async (c, a) => {
        const base = String((c && c.url) || '').replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Укажите адрес инстанса в настройках сервиса' };
        const n = Math.min(Math.max(Number(a.count) || 8, 1), 20);
        const res = await request('GET', `${base}/search?q=${esc(need(a.query, 'query'))}&format=json&language=${esc(a.lang || 'ru')}`);
        if (!res.ok || !res.json) return res;
        const items = ((res.json.results || []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 300) })));
        return { ok: true, json: { query: a.query, count: items.length, results: items } };
      },
    },
  ],
};

/* ============================================== Общий webhook (любой API) */

const webhook = {
  id: 'webhook',
  name: 'Webhook / HTTP',
  icon: 'plug',
  category: 'Прочее',
  keyLabel: 'токен или заголовок',
  keyHint: 'произвольный сервис: токен уходит в заголовке Authorization: Bearer',
  keyUrl: '',
  baseUrl: '',
  docs: '',
  authKind: 'bearer',
  customBase: true,
  verify: (creds) => request('GET', need(creds.url, 'адрес сервиса'), { headers: auth(creds) }),
  detail: (r) => (r.status ? `HTTP ${r.status}` : ''),
  actions: [
    {
      name: 'send', label: 'HTTP-запрос к сервису', write: true,
      params: { url: str('Полный URL запроса'), method: opt('GET|POST|PUT|PATCH|DELETE', 'POST'), body: opt('Тело запроса (JSON или текст)', '') },
      run: async (c, a) => {
        const method = String(a.method || 'POST').toUpperCase();
        const body = a.body ? (/^\s*[[{]/.test(a.body) ? a.body : undefined) : undefined;
        const asText = a.body && body === undefined ? a.body : undefined;
        return request(method, need(a.url, 'url'), {
          headers: { ...auth(c), ...(asText ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}) },
          body: body !== undefined ? body : asText,
        });
      },
    },
  ],
};

/* ------------------------------------------------------------- реестр */

const INTEGRATIONS = { telegram, gdrive, github, gitlab, slack, notion, discord, resend, webhook, obsidian, trello, openweather, googlesearch, exa, rss, hackernews, coingecko, currency, wikipedia, jira, linear, airtable, supabase, searxng };

/* --------------------------------------- Obsidian: помощники хранилища */

/** Корень хранилища из creds.url. Возвращает { root } или { error }. */
function vaultRoot(creds) {
  const raw = creds && typeof creds.url === 'string' ? creds.url.trim() : '';
  if (!raw) return { error: 'Не указан путь к хранилищу' };
  const root = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return { error: `Папка не найдена: ${raw}` };
  }
  if (!st.isDirectory()) return { error: `Это не папка: ${raw}` };
  return { root };
}

/** Все .md-файлы хранилища относительно корня (защита от выхода наружу). */
function listVaultMd(root) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= 2000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Путь заметки внутри хранилища. create=true — разрешить новые подпапки. */
function vaultNote(root, name, create = false) {
  let rel = String(name || '').trim().replace(/\0/g, '');
  if (!rel) return { error: 'Не указано имя заметки' };
  if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
  const full = path.resolve(root, rel);
  const rel2 = path.relative(root, full);
  if (rel2 === '' || rel2.startsWith('..') || path.isAbsolute(rel2)) {
    return { error: 'Имя заметки выходит за пределы хранилища' };
  }
  if (!create) return { path: full, rel: rel2 };
  return { path: full, rel: rel2 };
}

/* ------------------------------------------------------------ хелперы */

function auth(creds) {
  const h = {};
  if (!creds || !creds.apiKey) return h;
  switch (creds.kind) {
    case 'gitlab':
      h['PRIVATE-TOKEN'] = creds.apiKey;
      break;
    case 'notion':
      h.Authorization = `Bearer ${creds.apiKey}`;
      h['Notion-Version'] = '2022-06-28';
      break;
    case 'github':
      h.Authorization = `Bearer ${creds.apiKey}`;
      h['X-GitHub-Api-Version'] = '2022-11-28';
      break;
    default:
      h.Authorization = `Bearer ${creds.apiKey}`;
  }
  return h;
}

function str(desc) { return { type: 'string', description: desc }; }
function opt(desc, def) { return { type: 'string', description: `${desc}${def !== undefined ? ` · по умолчанию «${def}»` : ''}` }; }
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
function esc(s) { return encodeURIComponent(String(s)); }

function get(id) { return INTEGRATIONS[id] || null; }

function catalog() {
  return Object.values(INTEGRATIONS).map((i) => ({
    id: i.id,
    name: i.name,
    icon: i.icon,
    category: i.category,
    keyLabel: i.keyLabel,
    keyHint: i.keyHint,
    keyUrl: i.keyUrl,
    urlLabel: i.urlLabel || '',
    keyRequired: i.keyRequired !== false,
    baseUrl: i.baseUrl,
    docs: i.docs,
    customBase: !!i.customBase,
    authKind: i.authKind,
    actions: i.actions.map((a) => ({
      name: a.name, label: a.label, write: !!a.write,
      params: Object.entries(a.params || {}).map(([k, v]) => ({ name: k, description: v.description })),
    })),
  }));
}

/** Живая проверка ключа настоящим запросом. */
async function verify(id, creds) {
  const it = get(id);
  if (!it) return { ok: false, detail: `неизвестный сервис <${id}>`, latencyMs: 0 };
  const t0 = Date.now();
  let res;
  try {
    res = await it.verify({ ...creds, kind: it.authKind });
  } catch (e) {
    return { ok: false, detail: e.message, latencyMs: Date.now() - t0 };
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, latencyMs, detail: res.error || describe(res) };
  }
  /* Slack и подобные возвращают 200 с ok:false внутри — учитываем это */
  if (res.json && res.json.ok === false) {
    return { ok: false, latencyMs, detail: res.json.error || 'сервис отклонил запрос' };
  }
  return { ok: true, latencyMs, detail: (it.detail && it.detail(res)) || describe(res), account: account(res) };
}

function describe(res) {
  if (res.error) return res.error;
  if (res.json) return trim(JSON.stringify(res.json), 240);
  return `HTTP ${res.status}`;
}

function account(res) {
  const j = res.json || {};
  return trim(j.login || j.username || j.emailAddress || (j.user && j.user.email) || j.id || j.user_id || j.url || '', 120);
}

/** Выполнить действие интеграции (для агента и ручной проверки из UI). */
async function runAction(id, actionName, creds, args = {}) {
  const it = get(id);
  if (!it) throw new Error(`неизвестный сервис <${id}>`);
  const act = it.actions.find((a) => a.name === actionName);
  if (!act) throw new Error(`у сервиса ${it.name} нет действия «${actionName}»`);
  const t0 = Date.now();
  const res = await act.run({ ...creds, kind: it.authKind }, args || {});
  const latencyMs = Date.now() - t0;
  if (!res.ok) return { ok: false, latencyMs, error: res.error || describe(res) };
  if (res.json && res.json.ok === false) return { ok: false, latencyMs, error: res.json.error || 'сервис отклонил запрос' };
  return { ok: true, latencyMs, result: truncate(res.json !== null ? res.json : res.text) };
}

/** Схемы инструментов для агента — только по разрешённым сервисам. */
function toolSchemas(serviceIds, mode) {
  const out = [];
  for (const sid of serviceIds || []) {
    const it = get(sid);
    if (!it) continue;
    for (const a of it.actions) {
      if (a.write && mode !== 'full') continue; /* запись только в полном режиме */
      const props = {};
      for (const [k, v] of Object.entries(a.params || {})) props[k] = v;
      out.push({
        __integration: true,
        service: sid,
        write: !!a.write,
        type: 'function',
        function: {
          name: `svc_${sid}_${a.name}`,
          description: `${it.name}: ${a.label}.${a.write ? ' Изменяет данные — только в режиме «полный доступ».' : ''}`,
          parameters: { type: 'object', properties: props, required: requiredParams(a) },
        },
      });
    }
  }
  return out;
}

function requiredParams(action) {
  const req = [];
  for (const [k, v] of Object.entries(action.params || {})) {
    /* Поля без «по умолчанию» считаем обязательными */
    if (!/по умолчанию/.test(v.description || '')) req.push(k);
  }
  return req;
}

/** Найти интеграцию по tool-имени: svc_<service>_<action>. */
function parseToolName(name) {
  const m = /^svc_([a-z0-9]+)_([A-Za-z0-9_]+)$/.exec(String(name || ''));
  if (!m) return null;
  const it = get(m[1]);
  if (!it) return null;
  const act = it.actions.find((a) => a.name === m[2]);
  return act ? { service: m[1], action: act, integration: it } : null;
}

function truncate(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  return trim(s, 6000);
}

module.exports = {
  INTEGRATIONS,
  get,
  catalog,
  verify,
  runAction,
  toolSchemas,
  parseToolName,
};