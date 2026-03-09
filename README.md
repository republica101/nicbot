# NicBot

Nicotine taper accountability Discord bot. DMs you on a schedule, tracks your pouch usage, and exposes an API for external check-ins.

## Setup

1. Create a Discord bot at https://discord.com/developers/applications
   - Enable MESSAGE CONTENT intent under Bot settings
   - Enable SERVER MEMBERS intent
   - Bot permissions needed: Send Messages, Add Reactions, Read Message History
   - Generate an invite link with the bot scope and invite to any server (bot uses DMs, but needs to share a server with you)

2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN` - your bot token
   - `DISCORD_USER_ID` - your Discord user ID (enable developer mode, right-click yourself, Copy ID)
   - `API_KEY` - any random string for API auth
   - `PORT` - defaults to 3000

3. `npm install && npm start`

## DM Commands

| Command | What it does |
|---------|-------------|
| `1` | Log 1 pouch at current target mg |
| `3 4` | Log 3 pouches at 4mg |
| `skip` / `s` | Log a skipped craving |
| `undo` / `u` | Remove last entry |
| `status` / `st` | Current phase + today's count |
| `stats` / `week` | Last 7 days summary |
| `help` / `h` | Show commands |

## API Endpoints

All require `x-api-key` header (or `?key=` query param).

- `GET /health` - health check
- `GET /api/today` - today's usage vs targets
- `GET /api/week` - last 7 days summary
- `GET /api/logs?days=N` - arbitrary range

## Railway Deployment

Push to a GitHub repo, connect to Railway, set env vars in Railway dashboard. Done.
