<div align="center">

# hermes-link

**Local access layer for Hermes Agent**

Provides full client API, multi-device auth and conversation management for [Hermes Agent](https://github.com/nousresearch/hermes-agent), with LAN and internet connectivity.

[![npm](https://img.shields.io/npm/v/@bulolo/hermes-link?color=cb3837&logo=npm)](https://www.npmjs.com/package/@bulolo/hermes-link)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue)](#)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#)

[中文](./README.md) | **English**

[npm package](https://www.npmjs.com/package/@bulolo/hermes-link)

<p>
  <a href="https://github.com/bulolo/HermesLink">
    <img src="https://img.shields.io/badge/⭐_Star-Project-yellow?style=for-the-badge&logo=github" alt="Star Project"/>
  </a>
</p>

**If this project helps you, please ⭐ Star it — it means a lot to the developer!**

</div>

---

## Overview

Hermes Link is a background HTTP service running on your local machine, listening on `http://0.0.0.0:18642` by default. Clients (App / browser) connect directly over LAN or the internet — all conversations, files and commands are processed locally, with no data leaving your machine.

All API requests fall into two categories:

- **No auth required**: `/pair`, `/api/v1/bootstrap`
- **Bearer Token required**: all other endpoints require `Authorization: Bearer hpat_xxx`, obtained through the pairing flow

## Why HermesLink?

Hermes Agent ships with a built-in API Server (port 8642), but it only exposes **12 endpoints**:

| Feature | Hermes API Server `:8642` | HermesLink `:18642` |
|---------|:---:|:---:|
| Endpoint count | 12 | **97** |
| Agent execution / event stream | ✓ | ✓ (proxied) |
| Model list / Cron jobs | ✓ | ✓ (proxied) |
| Authentication | Single shared key | Per-device token, individually revocable |
| Device pairing | — | ✓ QR code / multi-device management |
| Conversation storage | — | ✓ Local history + attachments |
| Profile & Memory management | — | ✓ Multi-profile, memory, permissions, tool switches |
| Usage statistics | — | ✓ Token usage by date / model / profile |
| Tool call approval | — | ✓ Approve / deny flow |
| Update management / autostart | — | ✓ |

### When to use which

- **Local scripts / trusted internal services calling Hermes directly** → use Hermes API Server (8642)
- **Building a mobile app or multi-device access** → HermesLink (18642) required
- **Need conversation history / Profile management / statistics** → HermesLink (18642) required

## How It Works

```
Client (browser / App)
   │
   └──→ hermeslink (local machine, port 18642)
              │
              ├── auth / device management / conversation storage / Profile & Memory  ← handled by HermesLink (~87 endpoints)
              │
              └──→ Hermes Agent API Server (127.0.0.1:8642)   ← only runs / models / cron jobs (~10 endpoints)
```

The vast majority of functionality is handled by HermesLink independently, without relying on the API Server. If the API Server is not running, auth, pairing, conversation queries, and Profile management all continue to work — only Agent execution, model listing, and cron jobs become unavailable. All data is stored locally.

## Requirements

### 1. Node.js >= 20.0.0

```bash
node --version   # must be >= v20.0.0
```

If not installed, use [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 20
nvm use 20
```

### 2. Start the Hermes Agent API Server

HermesLink communicates with the **Hermes Agent API Server** at `127.0.0.1:8642`.

> If the API Server is not running, conversation and Profile features will be unavailable, but auth, pairing, device management, and logs still work fine.

Add the following to `~/.hermes/.env` to enable the API Server:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=your-secret-key
API_SERVER_HOST=0.0.0.0
API_SERVER_CORS_ORIGINS=*
GATEWAY_ALLOW_ALL_USERS=true
```

| Option | Description |
|--------|-------------|
| `API_SERVER_ENABLED` | Set to `true` to enable the API Server |
| `API_SERVER_KEY` | Auth key — replace with a strong random string: `openssl rand -hex 32` |
| `API_SERVER_HOST` | Listen address — `0.0.0.0` allows all network interfaces |
| `API_SERVER_CORS_ORIGINS` | CORS origins — can be `*` for local development |

Then restart:

```bash
hermes gateway restart
```

Verify it's running:

```bash
curl -s http://127.0.0.1:8642/v1/health
```

If missing or outdated:

```bash
hermes update
```

## Installation

npm package: [https://www.npmjs.com/package/@bulolo/hermes-link](https://www.npmjs.com/package/@bulolo/hermes-link)

```bash
npm install -g @bulolo/hermes-link
```

> If the `hermeslink` command is not found after installation, the npm global bin directory is not in your PATH. Fix it with:
>
> ```bash
> export PATH="$(npm prefix -g)/bin:$PATH"
> ```
>
> Or call it directly: `$(npm prefix -g)/bin/hermeslink`

## Quick Start

```bash
# 1. Start the background daemon
hermeslink start

# 2. Open the pairing page in a browser
hermeslink pair

# 3. Check status
hermeslink status

# 4. View logs
hermeslink logs
```

## Pairing

### Method 1: App QR code scan (standard flow)

The QR code contains a JSON payload the app parses to get everything it needs:

```json
{
  "kind": "hermes_link_pairing",
  "version": 1,
  "link_id": "link_xxx",
  "display_name": "Hermes Link",
  "session_id": "ps_xxx",
  "code": "xxx",
  "preferred_urls": ["http://192.168.1.10:18642", "http://127.0.0.1:18642"]
}
```

Once the app has this:

```
1. Use preferred_urls[0] as the base URL (LAN IP preferred)
2. POST {baseUrl}/api/v1/pairing/claim
   Body: { "session_id": "...", "claim_token": "<value of the code field>" }
3. Response contains access_token and refresh_token
4. Include Authorization: Bearer <access_token> on all subsequent requests
```

### Method 2: Browser pairing

```bash
hermeslink pair
# Open the Pairing page URL printed in the terminal
# Click "Pair on this device" — the page shows your access_token and refresh_token
```

### Method 3: CLI / script (automation-friendly)

```bash
# 1. Get the connect_token
CONNECT_TOKEN=$(hermeslink pair 2>&1 | grep "Connect token:" | awk '{print $NF}')

# 2. Exchange it for an access_token
curl -s -X POST http://localhost:18642/api/v1/auth/device-session \
  -H "Authorization: Bearer $CONNECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_label":"my-script","device_platform":"cli"}'
```

---

> **Token expiry**: access_token lasts 15 minutes, refresh_token lasts 90 days. When the access_token expires, use the refresh_token to get a new one — no need to re-pair.

## Commands

| Command | Description |
|---------|-------------|
| `hermeslink start` | Start the background daemon |
| `hermeslink stop` | Stop the daemon |
| `hermeslink restart` | Restart the daemon |
| `hermeslink status` | Show running status |
| `hermeslink pair` | Generate pairing URL and QR code |
| `hermeslink config get` | Show current config |
| `hermeslink config set <key> <value>` | Update a config value |
| `hermeslink autostart on` | Enable autostart on login (alias: `enable`) |
| `hermeslink autostart off` | Disable autostart (alias: `disable`) |
| `hermeslink logs` | View Link logs |
| `hermeslink logs --gateway` | View Hermes gateway logs |
| `hermeslink logs -n 100` | View last 100 log lines |
| `hermeslink version` | Show version |

## Configuration

```bash
hermeslink config set port 18642              # Change listen port (default: 18642)
hermeslink config set lan-host 192.168.1.10   # Set LAN IP manually (default: auto-detect)
hermeslink config set language en             # Language: auto / en / zh-CN
hermeslink config set log-level debug         # Log level: debug / info / warn / error
```

Config file is at `~/.hermeslink/config.json`.

## API Reference

Service listens on `http://0.0.0.0:18642` by default. All authenticated endpoints use a Bearer Token with the `hpat_` prefix.

### Token Types

| Token | Prefix | Expiry | Purpose |
|-------|--------|--------|---------|
| Connect Token | none (base64url) | 5 min, one-time | Exchange for access_token |
| Access Token | `hpat_` | 15 min | All API requests |
| Refresh Token | `hprt_` | 90 days | Refresh access_token |

### No Auth Required

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pair` | Pairing web page (open in browser) |
| GET | `/api/v1/bootstrap` | Service info: link_id, version, capabilities |

### Auth / Devices

All endpoints below require `Authorization: Bearer hpat_xxx`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/auth/me` | Current token info and device details |
| POST | `/api/v1/auth/device-session` | Exchange connect_token for access/refresh tokens |
| POST | `/api/v1/auth/refresh` | Refresh access_token using refresh_token |
| POST | `/api/v1/auth/logout` | Revoke refresh_token |

**POST `/api/v1/auth/device-session`** — Authorization header takes the **connect_token** (not hpat_). Body:

```json
{
  "device_label": "My Device",
  "device_platform": "ios|android|web|cli",
  "device_model": "optional device model"
}
```

Response:

```json
{
  "ok": true,
  "device": { "device_id": "dev_xxx", "label": "My Device", "platform": "ios" },
  "access_token":  { "token": "hpat_xxx", "expires_at": "2026-05-08T13:00:00Z" },
  "refresh_token": { "token": "hprt_xxx", "expires_at": "2026-08-06T12:00:00Z" }
}
```

**POST `/api/v1/auth/refresh`** Body:

```json
{ "refresh_token": "hprt_xxx" }
```

### Pairing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/pairing/session` | Query pairing session status (includes `claimed` field) |
| POST | `/api/v1/pairing/claim` | Complete pairing from the app side |

**GET `/api/v1/pairing/session`** query: `?session_id=ps_xxx`

**POST `/api/v1/pairing/claim`** Body:

```json
{
  "session_id": "ps_xxx",
  "claim_token": "<connect_token value>",
  "device_label": "My App",
  "device_platform": "ios"
}
```

### System Status

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/status` | Overall service status (version, device count, profile count, etc.) |
| GET | `/api/v1/logs` | Recent logs (`?source=link\|gateway&limit=50`) |

### Devices

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/devices` | List all paired devices |
| PATCH | `/api/v1/devices/:deviceId` | Rename device (`{"label":"New Name"}`) |
| DELETE | `/api/v1/devices/:deviceId` | Revoke device (invalidates its tokens) |
| DELETE | `/api/v1/devices/:deviceId/app-listing` | Hide a revoked device from the list |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/conversations` | List conversations (`?limit=20&cursor=xxx`) |
| GET | `/api/v1/conversations/search` | Search conversations (`?q=keyword`) |
| POST | `/api/v1/conversations` | Create a new conversation |
| DELETE | `/api/v1/conversations` | Bulk delete conversations |
| DELETE | `/api/v1/conversations/:id` | Delete a single conversation |
| GET | `/api/v1/conversations/:id/messages` | Get messages in a conversation |
| POST | `/api/v1/conversations/:id/messages` | Send a message |
| GET | `/api/v1/conversations/:id/events` | SSE event stream for a conversation |
| GET | `/api/v1/conversations/events` | SSE stream for all conversations |
| PATCH | `/api/v1/conversations/:id/title` | Rename conversation (`{"title":"New Title"}`) |
| PATCH | `/api/v1/conversations/:id/model` | Switch model |
| PATCH | `/api/v1/conversations/:id/profile` | Switch profile |
| POST | `/api/v1/conversations/:id/ack` | Acknowledge events read |
| POST | `/api/v1/conversations/clear-plans` | Create a bulk-clear plan |
| GET | `/api/v1/conversations/clear-plans/:planId` | Query clear plan status |
| POST | `/api/v1/conversations/clear-plans/:planId/execute` | Execute clear plan |
| POST | `/api/v1/conversations/:id/runs/:runId/cancel` | Cancel an in-progress run |
| POST | `/api/v1/conversations/:id/approvals/:approvalId/approve` | Approve a tool call |
| POST | `/api/v1/conversations/:id/approvals/:approvalId/deny` | Deny a tool call |
| POST | `/api/v1/conversations/:id/blobs` | Upload attachment |
| GET | `/api/v1/conversations/:id/blobs/:blobId` | Download attachment |
| DELETE | `/api/v1/conversations/:id/blobs/:blobId` | Delete attachment |

### Statistics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/statistics` | Global usage stats (conversation count, message count, etc.) |
| GET | `/api/v1/statistics/usage` | Token usage (`?days=7&from=2026-05-01&to=2026-05-08&model=xxx&profile=xxx`) |

### Models

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/models` | List available models (from Hermes API Server, OpenAI-compatible format) |
| GET | `/api/v1/model-configs` | List global model configs |
| POST | `/api/v1/model-configs` | Add global model config |
| PATCH | `/api/v1/model-configs/defaults` | Update default model config |
| DELETE | `/api/v1/model-configs` | Delete global model config |

### Profiles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/profiles` | List all profile names |
| POST | `/api/v1/profiles` | Create new profile (async, returns 202) |
| PATCH | `/api/v1/profiles/:name` | Rename (`{"name":"new-name"}`) or update metadata |
| DELETE | `/api/v1/profiles/:name` | Delete profile |
| GET | `/api/v1/profiles/catalog` | Full catalog (capabilities, permissions, modelConfigs per profile) |
| GET | `/api/v1/profile-creation/status` | Query creation progress |
| GET | `/api/v1/profile-creation/events` | Creation progress SSE stream |
| GET | `/api/v1/profiles/:name/status` | Profile status (existence, API key configuration, etc.) |
| GET | `/api/v1/profiles/:name/statistics` | Profile conversation statistics |
| GET | `/api/v1/profiles/:name/skills` | List profile skills (`?include_disabled=true`) |
| PATCH | `/api/v1/profiles/:name/skills/:skillName` | Enable/disable skill (`{"enabled":true}`) |
| GET | `/api/v1/profiles/:name/memory` | View memory (USER.md + MEMORY.md) |
| POST | `/api/v1/profiles/:name/memory/entries` | Add memory entry (`{"target":"memory","content":"..."}`) |
| PATCH | `/api/v1/profiles/:name/memory/entries` | Replace memory entry (`{"target":"memory","match":"old","content":"new"}`) |
| DELETE | `/api/v1/profiles/:name/memory/entries` | Delete memory entry (`{"target":"memory","match":"text to match"}`) |
| DELETE | `/api/v1/profiles/:name/memory` | Reset memory (`{"target":"memory\|user\|all"}`) |
| PATCH | `/api/v1/profiles/:name/memory/settings` | Update memory provider settings |
| PATCH | `/api/v1/profiles/:name/memory/provider` | Switch memory provider (`{"provider":"built-in"}`) |
| GET | `/api/v1/profiles/:name/permissions` | View permissions config |
| PATCH | `/api/v1/profiles/:name/permissions` | Update permissions config |
| GET | `/api/v1/profiles/:name/tool-configs/:toolKey` | View tool config (toolKey: `web` / `image_gen` / `stt` / `tts` / `messaging` / `homeassistant` / `rl`) |
| PATCH | `/api/v1/profiles/:name/tool-configs/:toolKey` | Update tool config |
| GET | `/api/v1/profiles/:name/model-configs` | List profile model configs |
| POST | `/api/v1/profiles/:name/model-configs` | Add profile model config |
| PATCH | `/api/v1/profiles/:name/model-configs/defaults` | Update profile default model |
| DELETE | `/api/v1/profiles/:name/model-configs` | Delete profile model config |

Memory `target` values: `"memory"` (agent notes, MEMORY.md) or `"user"` (user info, USER.md).

### Cron Jobs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/cron-jobs` | List all cron jobs across all profiles |
| GET | `/api/v1/profiles/:name/cron-jobs` | List cron jobs for a specific profile |
| POST | `/api/v1/profiles/:name/cron-jobs` | Create cron job |
| GET | `/api/v1/profiles/:name/cron-jobs/:jobId` | Get cron job details |
| PATCH | `/api/v1/profiles/:name/cron-jobs/:jobId` | Update cron job |
| DELETE | `/api/v1/profiles/:name/cron-jobs/:jobId` | Delete cron job |
| POST | `/api/v1/profiles/:name/cron-jobs/:jobId/pause` | Pause cron job |
| POST | `/api/v1/profiles/:name/cron-jobs/:jobId/resume` | Resume cron job |
| POST | `/api/v1/profiles/:name/cron-jobs/:jobId/run` | Run cron job immediately |

### Runs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/runs` | Submit a run to Hermes Agent (returns 202) |
| GET | `/api/v1/runs/:runId/events` | Subscribe to run event stream (SSE proxy) |
| POST | `/api/v1/runs/:runId/cancel` | Cancel a run |

**POST `/api/v1/runs`** Body:

```json
{
  "input": "Please organise my ~/Downloads folder",
  "profile": "default",
  "instructions": "optional system instructions",
  "session_id": "optional session ID",
  "conversation_history": []
}
```

Response (202):

```json
{
  "run_id": "run_xxx",
  "fallback": false
}
```

### Updates

#### Hermes Agent

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/hermes/update-check` | Check for a new Hermes Agent version |
| GET | `/api/v1/hermes/update/status` | Query Hermes update progress |
| POST | `/api/v1/hermes/update` | Trigger Hermes Agent update |
| GET | `/api/v1/hermes/update/events` | Update progress SSE stream |

#### Link itself

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/link/update-check` | Check for a new Link version |
| GET | `/api/v1/link/update/status` | Query Link update progress |
| POST | `/api/v1/link/update` | Trigger Link self-update (`{"version":"0.3.0"}`) |
| GET | `/api/v1/link/update/events` | Update progress SSE stream |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/system/status` | System details (version, autostart state, network info) |
| GET | `/api/v1/system/version` | Link version only |
| POST | `/api/v1/system/autostart/enable` | Enable autostart on login |
| POST | `/api/v1/system/autostart/disable` | Disable autostart |
| GET | `/api/v1/system/logs` | Recent Link logs |
| GET | `/api/v1/system/logs/gateway` | Recent gateway logs |
| GET | `/api/v1/system/updates` | Available updates (Hermes + Link combined) |
| POST | `/api/v1/system/updates/dismiss` | Dismiss current update notification |

### Error Response Format

All errors return:

```json
{
  "ok": false,
  "error": {
    "code": "error_code",
    "message": "Human readable message"
  }
}
```

Common error codes:

| code | HTTP | Description |
|------|------|-------------|
| `auth_required` | 401 | No Authorization header |
| `device_access_token_invalid` | 401 | access_token expired or invalid |
| `auth_invalid` | 401 | connect_token invalid or already used |
| `pairing_session_not_found` | 404 | Pairing session not found |
| `pairing_session_expired` | 404 | Pairing session expired |
| `pairing_claim_mismatch` | 409 | Pairing token mismatch |
| `link_not_paired` | 409 | Service has not been assigned a link_id yet |

## Examples

### Full pairing and usage script

```bash
#!/bin/bash
BASE="http://localhost:18642"

# Step 1: Generate a connect token
CONNECT=$(hermeslink pair 2>&1 | grep "Connect token:" | awk '{print $NF}')
echo "Connect token: $CONNECT"

# Step 2: Exchange for access_token and refresh_token
RESP=$(curl -s -X POST "$BASE/api/v1/auth/device-session" \
  -H "Authorization: Bearer $CONNECT" \
  -H "Content-Type: application/json" \
  -d '{"device_label":"my-script","device_platform":"cli"}')

ACCESS=$(echo $RESP | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token']['token'])")
REFRESH=$(echo $RESP | python3 -c "import json,sys; print(json.load(sys.stdin)['refresh_token']['token'])")
echo "Access:  $ACCESS"
echo "Refresh: $REFRESH"

# Step 3: Check status
curl -s "$BASE/api/v1/status" -H "Authorization: Bearer $ACCESS" | python3 -m json.tool
```

### Refresh token

```bash
curl -s -X POST http://localhost:18642/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH\"}"
```

### List devices

```bash
curl -s http://localhost:18642/api/v1/devices \
  -H "Authorization: Bearer $ACCESS"
```

### List conversations

```bash
curl -s "http://localhost:18642/api/v1/conversations?limit=10" \
  -H "Authorization: Bearer $ACCESS"
```

## Autostart

- **macOS**: via launchd (`~/Library/LaunchAgents/com.hermes.link.plist`)
- **Linux**: via systemd user service or XDG autostart
- **Windows**: via the Startup folder

```bash
hermeslink autostart on
hermeslink autostart off
```

## Runtime Files

All files are stored under `~/.hermeslink/`:

| Path | Description |
|------|-------------|
| `config.json` | User configuration |
| `identity.json` | Device identity (ed25519 key pair + link_id) |
| `credentials.json` | Access tokens for paired devices |
| `app-connect-tokens.json` | Pending pairing tokens (5-minute TTL) |
| `conversations/` | Conversation data |
| `blobs/` | File attachments |
| `pairing/` | Pairing sessions |
| `link.db` | SQLite database (usage statistics) |
| `logs/` | Log files |

Uninstalling the npm package does not delete this directory — reinstalling reuses the same link_id.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HERMESLINK_HOME` | Override the runtime directory (default: `~/.hermeslink`) |
| `HERMESLINK_LOG_LEVEL` | Override log level |
| `HERMESLINK_LANG` | Override language (`en` / `zh-CN`) |
| `HERMES_BIN` | Path to the `hermes` binary (default: `hermes`) |
| `HERMESLINK_LISTEN_HOST` | HTTP listen address (default: `0.0.0.0`) |

## Development

```bash
# Install dependencies and build
npm install
npm run build

# Run in foreground (for debugging)
npm run dev:run
# or
node dist/cli/index.js daemon --foreground

# Watch mode (auto-rebuild on source changes, restart manually)
npm run dev:watch     # terminal 1: watch and rebuild
node dist/cli/index.js daemon --foreground  # terminal 2: run the service

# TypeScript type check
npm run check
```

After starting, visit `http://localhost:18642/api/v1/bootstrap` to verify the service is running.

## License

MIT
