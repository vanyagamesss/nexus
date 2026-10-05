# NEXUS — AI agent team system

A dark "neo-cyber control room" for building and running a team of local AI agents:
LLM providers, agents, tools, MCP servers and host metrics. Zero dependencies —
plain Node.js built-ins only. UI in **English (default), Русский, 中文** —
switch with the globe button (sidebar or Pult header).

## Quickstart

```bash
node server.js
```

Open **http://localhost:3100**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3100` | Server port (`$env:PORT=3200; node server.js`) |
| `HOST` | `0.0.0.0` | Bind interface: `0.0.0.0` exposes it to your phone on LAN |
| `NEXUS_DATA` | `data/` | Different data dir (tests, parallel runs) |
| `NEXUS_TRUST_PROXY` | off | Trust `X-Forwarded-For` — enable **only** behind a reverse proxy |

- Dependencies: **none** (Node.js built-ins only, no `npm install`)
- Data is created automatically in `data/*.json` on first start
- Reset everything: `node server.js --reseed`

## Languages

- English is the default (`localStorage nexus_lang`, globe button cycles EN → RU → 中文).
- Almost the whole UI is translated: nav, Pult, Team, Knowledge bases, Constructor,
  Connections, palette, toasts, dialogs, dates/numbers/voice locales.
- Slash commands accept English aliases too (`/status`, `/team`, `/company`,
  `/chain`, `/history`, `/repeat`, `/export`, `/find`, `/agents`, `/clear`,
  `/schedule`, `/cancel`, `/open`, `/pause`, `/resume`, `/models`, `/services`,
  `/programs`, `/access`, `/screen`, `/statistics`).
- Server-side texts (Telegram bridge replies, provider errors) stay in Russian.

## No stubs

The UI shows only what really happened — a project principle, not a debug mode.

| What | How it's guaranteed |
|---|---|
| Tokens & tasks | Derived from `data/runs.json`, written only on a real provider reply |
| Model list | Live provider `/models`; offline catalog models are labeled as catalog |
| MCP servers | Real `initialize` + `tools/list`; tools are never typed by hand |
| Programs | Real `PATH` + known-locations scan merged with your list; missing files are flagged `missing`, never silently deleted |
| Services | Start disconnected, you enter the key; checks are real API requests |
| Team events | Only real runs; fictional seed events are removed by migration |

Agents start "clean": no invented permissions, tasks or statuses. Access appears
after you connect services, programs and MCP servers.

## Phone access

Default PIN is **1111**. Change it immediately:
**Connections → Access → PIN → Change PIN**. While the default stands,
the Access tab shows a warning — everyone reading this README knows it.

1. On your PC open **Connections → Access** and set your PIN (4–12 digits).
2. A QR code appears with an address like `http://192.168.0.112:3100`.
3. Point your phone camera, enter the PIN — the login screen opens.

Until a PIN is set, LAN login is blocked: random codes won't work.
Guests get **one-time** invite codes (30 minutes by default).
Invite codes are visible to authorized clients only.

### Work modes

| Mode | What agents can do |
|---|---|
| `readonly` | Read only. File writes and program runs are blocked |
| `full` | Write into the work folder and run allowed programs |

Switching to `full` requires confirmation; remote clients get it only with
`allowRemoteRun`.

### Security model

- Local requests (`127.0.0.1` / `::1`) are always trusted — no PIN asked.
- `X-Forwarded-For` is **ignored** by default, otherwise any LAN client could
  pose as local. Enable `NEXUS_TRUST_PROXY` only behind a trusted proxy.
- Sessions live in the `nexus_session` cookie; login attempts are rate-limited (5 per 15 min).
- API keys are encrypted with AES-256-GCM, the key is `data/.secret`.

### Telegram remote

Control the team from Telegram. The user enters the bot token:
**Connections → Services → Telegram** (token from @BotFather, stored encrypted),
then **Connections → Access → Telegram bridge**: service, performer
(whole team or one agent) and allowed chat IDs.
The bot has menu buttons: Status, Agents, Schedule, Help — and commands
/start, /status, /agents, /schedule, /menu, /help.

- Without an allowlist the bridge won't turn on; foreign chats are silently ignored.
- `/start` — greeting, `/status` — team state, everything else becomes tasks.
- With no performer assigned the team **debates as a chain**: each agent sees
  previous answers, chatter lands in the event feed and console, only the final
  verdict goes to chat.
- `@Name <task>` assigns one agent directly (e.g. `@Archimedes check the code`).
- Agent replies return to the same chat; runs go to the shared journal.
- Find your chat ID with "Show chats": message the bot, then press it.

### Knowledge base (RAG)

Agents remember the work folder: files are chunked, relevance is scored by words —
no external services or embeddings.

- `rag_search` tool: ask the knowledge base, get matching chunks with paths.
- Auto-context: top chunks are injected into the prompt before every task.
- **Knowledge bases** section (`#/kb`): sets of folders/files + assigned agents
  (one or many). Assigned agents search only their bases, others see the whole folder.
- Team view panel shows how many files/chunks the agent sees.
- API: `GET /api/rag/status` → `{root, files, chunks, bytes, bases[]}`,
  `GET/POST /api/kb`, `POST /api/kb/search`.

### Input bridge: keyboard, mouse and your own browser

An agent can really drive the PC: type, press hotkeys, move the cursor, click —
and steer its own visible browser (Chrome + CDP, no dependencies, separate profile,
no automation flag): open sites (`browser_open`), read page snapshots
(`browser_snapshot`), click (`browser_click`), fill forms (`browser_type`).
Screenshots for the model go through `screenshot` (vision) and `/screen` in chat.
Captchas, SMS and 2FA can't be passed — the agent will honestly say so.

- Enabled **only explicitly**: the "Keyboard & mouse input" toggle on the agent card
  (or constructor checkbox) **plus** "Full access" mode.
- Tools: `input_screen`, `input_key` (`ENTER`, `ctrl+s`), `input_text` (300 chars),
  `input_mouse` (move/click/double/right/scroll).
- PowerShell + .NET implementation, no external dependencies, Windows only
  with an active user session. Every action literally executes —
  enable only for agents you trust.

## What's inside

| File / folder | Purpose |
|---|---|
| `server.js` | HTTP server: static + REST API + NDJSON agent runs |
| `lib/store.js` | Persistence, in-memory cache, secret encryption |
| `lib/providers.js` | Provider catalog, LLM adapters, live model list |
| `lib/agent.js` | Agent loop: prompt → RAG auto-context → tools → answer |
| `lib/rag.js` | Knowledge base: workspace chunking, word search, panel summary |
| `lib/tools.js` | FS/system tools, `rag_search`, `calc`, `download_file`, `screenshot` (vision), `zip_pack`/`zip_unpack`, path jail, SSRF guard, input bridge, web search & read, PowerShell commands, clipboard |
| `lib/browser.js` | Team's own browser: Chrome + CDP, own profile, screenshots |
| `lib/mcp.js` | MCP client: stdio / SSE / HTTP, handshake and tools list |
| `lib/tgbridge.js` | Telegram → team bridge: incoming polling, chat allowlist, chain debates, @Name, task runs |
| `lib/metrics.js` | Real CPU, memory, disk, uptime, LAN addresses |
| `lib/auth.js` | PIN, sessions, invites |
| `public/index.html` | SPA shell (sidebar, bottom tab-bar, console dock, drawer) |
| `public/sw.js`, `manifest.webmanifest` | PWA: offline shell, install on phone |
| `public/css/style.css` | Design system: tokens, components, responsive, a11y, polish layer |
| `public/js/*.js` | Modules: router, state, console, views, utils |
| `public/js/i18n*.js` | EN/RU/ZH dictionaries (`t('ns.key')`, default English) |
| `data/*.json` | State (created by the server) |

Agent internals use camelCase (`toolCalls`/`toolCallId`), the wire strictly follows
each provider's format (`toOpenAIMessages`/`toOllamaMessages`/Anthropic/Gemini
converters, all vision-aware). Calls without ids get a generated id — otherwise
providers answer 400.
| `lib/metrics.js` | Real CPU, memory, disk, uptime, LAN addresses |
| `lib/auth.js` | PIN, sessions, invites |

## REST API

### Team and resources

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/team` | Team + agents. POST: `{team}`, `{agent}`, `{agents}`, `{removeAgentId}`, `{event}` |
| GET/POST | `/api/services` | Services. POST: `{item}` (upsert) / `{removeId}` |
| GET/POST | `/api/programs` | PC programs. POST: `{item}` / `{removeId}` (missing files flagged, not deleted) |
| POST | `/api/programs/scan` | Real PC scan + merge → `{added, total, programs}` |
| GET/POST | `/api/kb` | RAG knowledge bases. POST: `{item}` / `{removeId}` |
| POST | `/api/kb/search` | Test a base: `{id, query}` → matching chunks |
| GET | `/api/files?path=` | Image previews from the work folder (png/jpg/gif/webp/bmp ≤ 8 MB) |
| GET/POST | `/api/mcp` | MCP servers. POST: `{item}` / `{removeId}` |
| POST | `/api/services/:id/check` | Live service check (latency + key validation) |
| POST | `/api/mcp/:id/reconnect` | MCP reconnect with log |
| POST | `/api/mcp/:id/probe` | Real MCP handshake and tools list |
| POST | `/api/mcp/probe-all` | Probe all MCP servers |

### LLM providers and metrics

| Method | Path | Description |
|---|---|---|
| GET | `/api/providers` | Configured providers (no keys, mask only) |
| GET | `/api/providers/catalog` | Catalog of 27 providers + configured ones |
| POST | `/api/providers` | `{providerId, apiKey, baseUrl, isDefault, test}` / `{removeId}` / `{id, models[]}` |
| POST | `/api/providers/:id/probe` | Key check + live model list refresh |
| GET | `/api/metrics` | `{node: {cpu, memory, disk, process, host}, stats, lan}` |
| GET | `/api/runs` | Run history and aggregate stats |
| GET | `/api/rag/status` | Knowledge base: `{root, files, chunks, bytes, bases[]}` |

#### Live model list and manual pick

Providers with `dynamicModels` (OpenAI, OpenRouter, Anthropic, Gemini, Groq, Together,
DeepSeek, Mistral, xAI, Cerebras, SambaNova and any OpenAI-compatible one) return a real
`/models` list on key check: up to 1000 ids with context window and per-1M-token prices.

- `POST /api/providers/:id/probe` returns `{ok, models: string[], meta: [{id, ctx, in, out, src}]}`.
- Offline/unreachable keys fall back to the catalog marked `src: "catalog"`.
- `POST /api/providers` with `{id, models: [...]}` saves the selection (up to 500 ids).
- The UI opens the picker automatically after a successful check, plus a "Models"
  button on each provider card. Search, select-all/clear and manual id input included.
- The agent constructor lists only models saved for that `providerConfigId`.

### Access

| Method | Path | Description |
|---|---|---|
| GET | `/api/access` | Mode, PIN presence, `isLocal` (invites for authorized only) |
| GET | `/api/access/session` | Current session: `authed`, `isLocal`, `requiresAuth` |
| POST | `/api/access/login` | `{pin}` or `{invite}` |
| POST | `/api/access/logout` | End session |
| POST | `/api/access/pin` | Set/change PIN |
| POST | `/api/access/pin/clear` | Disable PIN |
| POST | `/api/access/mode` | `{mode, workspace, requirePinForLan, allowRemoteRun}` |
| POST | `/api/access/invite` | Create one-time code (`{ttlMin}`) |
| POST | `/api/access/invite/revoke` | Revoke all codes |
| GET | `/api/net` | LAN addresses and port (codes for authorized only) |

### Agent runs

| Method | Path | Description |
|---|---|---|
| POST | `/api/agents/:id/run` | NDJSON log stream + final `{type:"done"}`. Body: `{task, attachments[]}` (workspace-relative paths, images go to vision) |
| GET | `/api/health` | Service ping (no auth) |

### Services and integrations

| Method | Path | Description |
|---|---|---|
| GET | `/api/services` | Services without keys: `hasKey`, `keyHintMask`, operations |
| POST | `/api/services` | `{item}` or `{removeId}` — key is encrypted on save |
| POST | `/api/services/:id/check` | Live check with a real API request |
| POST | `/api/services/:id/action` | `{action, args}` — manual operation call |
| GET | `/api/integrations` | Connector catalog: what to enter, which operations agents get |

### MCP servers

| Method | Path | Description |
|---|---|---|
| GET | `/api/mcp` | Connected servers: transport, status, tool count |
| POST | `/api/mcp` | `{item}` or `{removeId}` — connect without listing tools |
| POST | `/api/mcp/test` | Pre-save config check: handshake + `tools/list` |
| POST | `/api/mcp/:id/reconnect` | Reconnect and re-probe |

- Transports: `stdio` (spawn command), `sse`, `http`.
- `env` goes to the child process environment for `stdio`; `headers` to HTTP/SSE headers.
- The tool list is **never** typed by hand: it comes from a real `tools/list` response.
- Tools reach agents as `mcp__<server>__<tool>` and work in readonly and full modes.
- `POST /api/mcp/test` returns `{ok, serverName, tools, error, log}` without saving.

Errors: `400/401/403/404/405/409/413/429` + JSON `{ "error": "..." }`.

All `/api/*` require auth except `health`, `access`, `access/session`,
`access/login` and `net` — otherwise a phone couldn't render the login screen.

## Integrations with external services

An agent only gets tools for services that are **connected** (check passed)
and **allowed** for it in the constructor. Write operations appear only in
"full access" mode; in readonly mode the model never sees them.

| Service | Key | Operations |
|---|---|---|
| Telegram | bot token from @BotFather | send message, read incoming, chat info, webhook |
| Google Drive | OAuth access token (`…/auth/drive`) | list files, download, create folder, update, share, delete |
| GitHub | personal access token (`repo`) | repos, issues, create issue, comment, read file |
| Slack | bot token (`xoxb-…`) | send to channel, channels, members, history |
| Notion | internal integration token (`secret_…`) | search, database query, create page, append block |
| Discord | bot token | send to channel, server channels |
| GitLab | personal access token (`api`) | projects, issues, create issue, read file |
| Trello | key and token as `key:token` | boards, lists, cards, create card |
| Weather (OpenWeather) | API key | current weather, forecast |
| Google Search | API key + search-engine CX | Google search (up to 10 results) |
| Exa AI | API key | neural search + full page reading |
| RSS feeds | no key, feed URL | news reading (habr, vedomosti, any RSS/Atom) |
| Hacker News | no key | search and tech front page |
| Crypto (CoinGecko) | no key | coin prices, top by market cap |
| Currencies | no key | world currency rates (except RUB), conversion |
| Wikipedia | no key | summaries and article search |
| Mail (Resend) | API key (`re_…`) | send email |
| Jira | email and API token as `email:token` + site URL | JQL search, issue card, create issue |
| Linear | Personal API key | list issues, create issue |
| Airtable | Personal Access Token + base ID (`app…`) | table rows, add row |
| Supabase | service_role/anon key + project URL | read rows, insert row |
| SearXNG | no key, instance URL | web search without Google |
| Webhook / HTTP | any Bearer token | arbitrary HTTP request to your service |
| Obsidian | no key, just vault path | list notes, read, create/overwrite, search |

Tools are named `svc_<service>_<operation>`, e.g. `svc_telegram_sendMessage`.

### How to connect

1. **Connections → Services** → pick a service under "Available integrations" → "Connect".
2. Paste the key. It is encrypted into `data/.secret` and never served back —
   the API only shows `hasKey` and a fingerprint like `12345:est`.
3. Press "Check": NEXUS performs a real request against the service API.
4. **Constructor** → enable this service for the agent under "services".

The "operations" button on each card runs any operation manually — handy for
verifying a key with a real action, not just the account check.

### Adding your own integration

All connectors live in `lib/integrations.js`. Add an object with
`id`, `name`, `keyLabel`, `verify(creds)` and `actions[]` to `INTEGRATIONS` —
UI, checks and agent tool grants pick it up automatically.

## Supported LLM providers

OpenAI, OpenRouter, Anthropic, Ollama, Google Gemini, Groq, Together AI, DeepSeek,
Mistral, xAI Grok, Moonshot (Kimi), Zhipu GLM, Qwen (Alibaba), Cohere, Fireworks AI,
Perplexity, Novita AI, DeepInfra, Hyperbolic, Nebius, Cerebras, SambaNova,
YandexGPT, GigaChat (Sber), LM Studio, vLLM
and any OpenAI-compatible address (base URL field).
No key needed for Ollama/LM Studio/vLLM; models are listed live.
YandexGPT: model as `folder-id/yandexgpt` (or `…/yandexgpt-lite`),
service-account API key; Yandex API has no tools, the agent answers with text
while files come through RAG.
GigaChat: Studio key (Authorization key), OAuth token refreshes itself.

## Interface sections

1. **Pult** (`#/`) — full-screen messenger-style control chat: plain text becomes
   a task for the selected recipient (whole team or specific agents). Attach work
   files with the clip, drag & drop or paste — they land in `uploads/` of the work
   folder, the agent reads them via `read_file`, and **images are also seen**
   through vision (OpenAI, Anthropic, Gemini, Ollama). The whole run is visible
   in the execution console, only the finished answer lands in chat (errors surface
   immediately). Long answers collapse with "Show more", every answer has a
   "copy" button, Markdown renders (headings, lists, tables, code with a
   "To file" button, full access only). `/find` searches history. While the agent
   works — a "typing…" indicator with step number. Voice input (mic, in-browser
   recognition) and history clearing. Commands: `/together`, `/team Name |
   Mission | roles`, `/company` (a whole 9-agent AI company in one click),
   `/connect`, `/telegram`, `/models`, `/social`, `/pc`, `/mcp`, `/access`,
   `/pin`, `/repeat`, `/agents`, `/export`, `/clear`, `/find`, `/status`,
   `/pause <name>` / `/resume <name>`, `/history`, `/repeat N`, `/research`,
   `/chain`, `/open <program>`, `/browser`, `/screen`. Everything also works in
   English (`/status`, `/team`, `/chain`…). The same screen works great from a
   phone. Light theme included (sidebar footer + Pult header toggle, remembered).
2. **Team** (`#/team`) — hero with stats, team work folder
   (picked at creation, pencil to change — all agent files live there),
   whole-team runs in two modes (each on their own / chain with one verdict),
   agent grid with fun emoji avatars, "New agent" window (name, role, avatar,
   model, prompt), agent drawer with permissions and runs, event feed,
   "Knowledge base" panel (how many files/chunks RAG sees) and "System pulse"
   with **real** node metrics (CPU, memory, disk, uptime) plus run summaries.
3. **Knowledge bases** (`#/kb`) — RAG sets: folders/files + assigned agents
   (one or the whole crew). Bound agents search only their bases.
4. **Constructor** (`#/constructor`) — extended 4-step wizard: mission →
   agents (model, creativity, prompt, permissions, knowledge bases) → orchestration → review.
   Per-agent card: LLM provider + model, service/social, PC program and MCP bindings.
   Roles: developer, researcher, editor, analyst, DevOps, assistant, tester, designer,
   manager, marketer, translator, mentor — plus a "Custom role" button (your own
   profession name and rules). One-click presets: AI company, Researchers,
   Developers, Autopilot.
5. **Connections** (`#/connect`) — tabs:
   - **LLM models** — providers with status, latency and models; catalog add,
     key check, default provider pick.
   - **Services & socials** — Telegram, Slack, Discord, Notion, GitHub, Google Drive:
     add, live key check.
   - **PC programs** — real scan (known paths + PATH) merged with your list:
     nothing of yours is overwritten, missing files get a "file not found" badge.
   - **MCP servers** — your server: transport, env/headers, real check,
     tools pull themselves, reconnect.
   - **Access** — work mode, PIN, phone QR, invites.

The bottom console shows the live "typed" log stream during runs:
launches, chain relays, thinking aloud from reasoning models — and final answers.
Compact thumb-friendly navigation appears on phones.
