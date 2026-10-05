# NEXUS — AI agent team

Local AI agent team control: Pult chat, constructor, PC programs, MCP servers,
Telegram remote, RAG knowledge bases and vision attachments.
Zero dependencies — Node.js built-ins only.

```bash
cd nexus
node server.js
# → http://localhost:3100
```

Full documentation — in [nexus/README.md](nexus/README.md).
UI languages: English (default), Русский, 中文 — globe button.

## Before publishing

The `nexus/data/` folder (keys, PIN, chats, journal) is excluded from git
via `.gitignore` and recreated on first launch.
