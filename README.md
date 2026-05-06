# @bulolo/hermes-link

Local companion service and CLI for connecting [Hermes Agent](https://catwiki.ai) to your devices through zhiji.

## Requirements

- Node.js >= 20
- A running [Hermes Agent](https://catwiki.ai) installation

## Installation

```bash
npm install -g @bulolo/hermes-link
```

## Quick Start

```bash
# Start the background daemon
hermeslink start

# Check status
hermeslink status

# View logs
hermeslink logs
```

## Commands

| Command | Description |
|---------|-------------|
| `hermeslink start` | Start the background daemon |
| `hermeslink stop` | Stop the daemon |
| `hermeslink restart` | Restart the daemon |
| `hermeslink status` | Show daemon and service status |
| `hermeslink pair` | Generate a pairing URL for your device |
| `hermeslink config get` | Show current configuration |
| `hermeslink config set <key> <value>` | Set a configuration value |
| `hermeslink autostart` | Show autostart status |
| `hermeslink autostart enable` | Enable autostart on login |
| `hermeslink autostart disable` | Disable autostart |
| `hermeslink logs` | Show recent log entries |
| `hermeslink logs --gateway` | Show Hermes gateway logs |
| `hermeslink version` | Print version |

## Configuration

```bash
hermeslink config set port 52379          # Change listen port
hermeslink config set lan-host 192.168.1.10  # Set LAN IP manually
hermeslink config set language zh-CN      # Set language (auto/en/zh-CN)
hermeslink config set log-level debug     # Set log level (debug/info/warn/error)
```

Config is stored at `~/.hermeslink/config.json`.

## How It Works

```
Hermes App (mobile)
       │
       ▼
hermes-relay.catwiki.ai  ──────────────────┐
                                           │ WebSocket tunnel
                                    hermeslink (this service)
                                           │
                                           ▼
                                   Hermes Agent (local)
                                   localhost:8642
```

`hermeslink` runs a local HTTP server (default port `52379`) and maintains a persistent WebSocket connection to the relay server. The mobile app connects through the relay and proxies requests to your local Hermes Agent.

## Runtime Files

All runtime files are stored in `~/.hermeslink/`:

| Path | Description |
|------|-------------|
| `config.json` | User configuration |
| `identity.json` | Device identity (ed25519 keypair) |
| `link.db` | SQLite database (stats, usage) |
| `logs/` | Log files |
| `daemon.pid` | Daemon PID file |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HERMESLINK_HOME` | Override runtime directory (default `~/.hermeslink`) |
| `HERMESLINK_LOG_LEVEL` | Override log level |
| `HERMESLINK_LANG` | Override language |
| `HERMES_BIN` | Path to `hermes` binary (default: `hermes`) |

## Autostart

On macOS, autostart is managed via launchd (`~/Library/LaunchAgents/com.hermes.link.plist`).  
On Linux, via systemd user service or XDG autostart.  
On Windows, via the Startup folder.

```bash
hermeslink autostart enable
hermeslink autostart disable
```

## License

MIT
