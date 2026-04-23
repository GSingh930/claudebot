# 🤖 ClaudeBot — Discord Bot with Web Dashboard

A Claude-powered Discord bot that can chat and generate VBA scripts from Excel files, with a web dashboard to configure and test it.

## Features
- 💬 **AI Chat** — Conversational Claude responses, per-channel history
- 📊 **VBA Generator** — Attach an Excel file + prompt → get a working VBA macro
- 🌐 **Web Dashboard** — Configure tokens, system prompt, test chat & VBA in browser
- 🔒 **Channel Restrictions** — Optionally limit bot to specific channels

## Quick Start

```bash
npm install
node dashboard.js
```

Open http://localhost:3000 and follow the Setup Guide tab.

## Bot Commands (Discord)
| Command | Description |
|---|---|
| `!claude <message>` | Chat with Claude |
| `@ClaudeBot <message>` | Mention to chat |
| `@ClaudeBot [excel file] <prompt>` | Generate VBA script |
| `/clear` | Reset channel conversation history |

## Files
- `bot.js` — Discord bot logic
- `dashboard.js` — Express web server + API
- `start-bot.js` — Standalone bot entry point
- `config.json` — Your settings (auto-created, not committed)
- `public/index.html` — Dashboard UI
