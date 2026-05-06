# Hermes Link — 完全复刻实施方案

> 参考：`@hermespilot/link v0.4.4`（已解压至 `reference/hermeslink/`）  
> 目标：一模一样地复刻 Link 的全部功能，仅替换 npm scope/包名，其余行为、协议、目录结构完全相同。

---

## 1. 包名与 scope

| 字段 | 值 |
|------|----|
| npm 包名 | `@bulolo/hermes-link` |
| 二进制命令 | `hermeslink` |
| 运行时目录 | `~/.hermeslink/` |
| 配置文件 | `~/.hermeslink/config.json` |
| 默认端口 | `52379` |
| macOS 自启标签 | `com.hermes.link` |
| Linux service | `hermeslink.service` |
| 身份字段 | `link_id` |
| 环境变量前缀 | `HERMESLINK_*` |
| API 前缀 | `/api/v1/` |
| 配对页路径 | `/pair` |
| Relay WS 路径 | `/api/v1/relay/link/connect` |

除 npm scope/包名外，所有标识符、路径、协议与 `@hermespilot/link v0.4.4` **完全相同**。

---

## 2. 技术栈（与 Link v0.4.4 完全一致）

```
Runtime:        Node.js >= 20.0.0
Language:       TypeScript 5.x (ESM)
HTTP:           koa ^2.15.3 + @koa/router ^15.4.0 + @koa/cors
WebSocket:      ws ^8.18.0
Database:       better-sqlite3 ^12.9.0
CLI:            commander ^12.1.0
Config:         yaml ^2.6.1
Validation:     zod ^3.24.1
QR Code:        qrcode ^1.5.4 + qrcode-terminal ^0.12.0
Logging:        pino ^9.x + pino-pretty（开发）
Build:          tsup ^8.3.5（多入口：src/cli/index.ts + src/http/app.ts）
Test:           vitest ^2.1.8
```

---

## 3. 完整目录结构

```
project-root/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── PLAN.md
├── LICENSE
├── scripts/
│   ├── check-node-version.mjs
│   └── postinstall.mjs
├── reference/
│   └── hermeslink/                        # @hermespilot/link v0.4.4 参考源
└── src/
    ├── constants.ts                       # LINK_COMMAND, LINK_DEFAULT_PORT, LINK_RUNTIME_DIR_NAME
    │
    ├── cli/
    │   └── index.ts                       # Commander 主入口 + autostart + i18n
    │
    ├── autostart/
    │   └── autostart.ts                   # 四平台开机自启
    │
    ├── i18n.ts                            # en + zh-CN 内联消息（单文件，对齐 Link）
    │
    ├── config/
    │   └── config.ts                      # loadConfig / saveConfig（JSON）
    │
    ├── runtime/
    │   ├── paths.ts                       # resolveRuntimePaths()
    │   └── logger.ts                      # pino logger 工厂，createLogger()
    │
    ├── core/
    │   └── errors.ts                      # LinkHttpError
    │
    ├── storage/
    │   ├── sqlite.ts                      # openSqliteDatabase()
    │   ├── atomic-json.ts                 # readJsonFile / writeJsonFile
    │   ├── atomic-file.ts                 # 原子文件写入
    │   └── link-database.ts               # initLinkDatabase()，直接建表 + 全部读写函数
    │
    ├── identity/
    │   └── identity.ts                    # ensureIdentity / loadIdentity / signRelayNonce
    │
    ├── security/
    │   ├── devices.ts                     # 设备 CRUD & token 管理
    │   └── app-connect-token.ts           # JWT 验证
    │
    ├── hermes/
    │   ├── config.ts                      # 写 ~/.hermes/config.yaml，读 .env API_SERVER_*
    │   ├── cli.ts                         # resolveHermesBin / readHermesVersion
    │   ├── gateway.ts                     # ensureHermesApiServerAvailable / gatewayRunArgs
    │   ├── api-server.ts                  # readHermesApiServerConfig / readHermesApiServerHealth
    │   ├── stt.ts                         # STT 支持
    │   └── cron-link-delivery.ts          # Cron 文件交付
    │
    ├── relay/
    │   ├── relay-client.ts                # connectRelayControl()
    │   └── bootstrap.ts                   # bootstrapRelayLink()
    │
    ├── network/
    │   ├── discovery.ts                   # discoverRouteCandidates()
    │   └── environment.ts                 # detectRuntimeEnvironment()（WSL/Container）
    │
    ├── conversations/
    │   ├── conversation-service.ts        # ConversationService（EventEmitter）
    │   ├── conversation-store.ts
    │   ├── conversation-queries.ts        # 列表/搜索/游标分页
    │   ├── conversation-metadata.ts
    │   ├── conversation-turns.ts
    │   ├── conversation-orchestration.ts
    │   ├── conversation-commands.ts
    │   ├── conversation-session-ids.ts
    │   ├── conversation-maintenance.ts
    │   ├── conversation-clear-plans.ts
    │   ├── conversation-view.ts
    │   ├── run-lifecycle.ts
    │   ├── hermes-session-sync.ts
    │   ├── hermes-sse.ts
    │   ├── stream-events.ts
    │   ├── agent-events.ts
    │   ├── history-builder.ts
    │   ├── slash-commands.ts
    │   ├── approvals.ts
    │   ├── statistics.ts
    │   ├── blob-store.ts
    │   ├── media.ts
    │   ├── delivery-staging.ts
    │   ├── delivery-import.ts
    │   ├── delivery-contract.ts
    │   └── profile-runtime.ts
    │
    └── http/
        ├── app.ts                         # Koa 应用工厂
        ├── auth.ts                        # authenticateRequest middleware
        ├── request.ts                     # readJsonBody / readString 等
        ├── sse.ts                         # SSE 响应工具
        └── routes/
            ├── system.ts                  # bootstrap / status / logs / devices / pairing / updates
            ├── conversations.ts           # 会话完整路由
            ├── runs.ts                    # runs + SSE + cancel
            ├── cron-jobs.ts               # cron-jobs CRUD
            ├── profiles.ts                # profiles + 统计 + profile-creation SSE
            ├── model-configs.ts
            ├── memory.ts
            ├── skills.ts
            ├── permissions.ts
            └── statistics.ts
```

---

## 4. 核心模块规格

### 4.1 CLI 命令（完整集）

```bash
hermeslink --version
hermeslink status [--json]
hermeslink start
hermeslink stop
hermeslink restart
hermeslink daemon                      # 前台运行
hermeslink daemon-supervisor           # 内部：supervisor 进程
hermeslink pair
hermeslink doctor
hermeslink logs
hermeslink autostart on
hermeslink autostart off
hermeslink autostart status
hermeslink config set <key> <value>    # 支持: port, lan-host, log-level
hermeslink config unset <key>
hermeslink deliver <staging-dir>       # 内部：Cron 文件交付
```

### 4.2 常量（`src/constants.ts`）

```typescript
export const LINK_COMMAND = "hermeslink";
export const LINK_DEFAULT_PORT = 52379;
export const LINK_RUNTIME_DIR_NAME = ".hermeslink";
export const DEFAULT_LOG_FILE = "hermeslink.log";
export const MIN_API_SERVER_VERSION = "0.4.0";
export const DEFAULT_HERMES_API_SERVER_HOST = "127.0.0.1";
export const DEFAULT_HERMES_API_SERVER_PORT = 8642;
export const PROFILE_API_SERVER_PORT_START = 8643;
export const PROFILE_API_SERVER_PORT_END = 9641;
```

### 4.3 运行时目录（`src/runtime/paths.ts`）

```
~/.hermeslink/
├── identity.json        # install_id, link_id, public_key_pem, private_key_pem, created_at
├── config.json          # 用户持久配置（JSON 扁平）
├── hermeslink.pid       # daemon PID
├── hermeslink.db        # SQLite（3 张表，直接建表）
├── pairing/             # 配对会话临时文件
├── run/                 # 运行时临时状态
└── logs/
    ├── hermeslink.log         # 服务日志（pino NDJSON）
    └── hermeslink-daemon.log  # daemon supervisor stdout/stderr
```

### 4.4 配置文件（`~/.hermeslink/config.json`）

```json
{
  "port": 52379,
  "lanHost": null,
  "serverBaseUrl": "https://hermes-server.clawpilot.me",
  "relayBaseUrl": "https://hermes-relay.clawpilot.me",
  "appConnectTokenIssuer": "https://hermes-server.clawpilot.me",
  "appConnectTokenAudience": "hermes-link",
  "language": "auto",
  "logLevel": "warn"
}
```

`loadConfig()` 合并 `HERMESLINK_LOG_LEVEL` 环境变量覆盖。

### 4.5 数据库（`src/storage/link-database.ts`）

不使用 migration 框架，直接在首次连接时用 `CREATE TABLE IF NOT EXISTS` 建全部表。

```sql
-- 表 1: conversation_stats
CREATE TABLE IF NOT EXISTS conversation_stats (
  conversation_id   TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL,
  hermes_session_id TEXT NOT NULL,
  profile           TEXT,
  model             TEXT,
  provider          TEXT,
  context_window    INTEGER,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  run_count         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  stats_updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_stats_status     ON conversation_stats(status);
CREATE INDEX IF NOT EXISTS idx_conversation_stats_updated_at ON conversation_stats(updated_at);
CREATE INDEX IF NOT EXISTS idx_conversation_stats_model      ON conversation_stats(model);
CREATE INDEX IF NOT EXISTS idx_conversation_stats_profile    ON conversation_stats(profile);

-- 表 2: profile_registry
CREATE TABLE IF NOT EXISTS profile_registry (
  profile_uid   TEXT PRIMARY KEY,
  profile_name  TEXT NOT NULL UNIQUE,
  profile_path  TEXT NOT NULL,
  display_name  TEXT,
  description   TEXT,
  avatar_type   TEXT NOT NULL DEFAULT 'default',
  avatar_url    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 表 3: run_usage_facts
CREATE TABLE IF NOT EXISTS run_usage_facts (
  run_id                TEXT PRIMARY KEY,
  conversation_id       TEXT NOT NULL,
  profile_uid           TEXT,
  profile_name_snapshot TEXT,
  profile               TEXT,
  model                 TEXT,
  provider              TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  message_count         INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT NOT NULL,
  completed_at          TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_usage_facts_completed_at         ON run_usage_facts(completed_at);
CREATE INDEX IF NOT EXISTS idx_run_usage_facts_conversation_id      ON run_usage_facts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_run_usage_facts_model                ON run_usage_facts(model);
CREATE INDEX IF NOT EXISTS idx_run_usage_facts_profile_uid          ON run_usage_facts(profile_uid);
CREATE INDEX IF NOT EXISTS idx_run_usage_facts_profile_name_snapshot ON run_usage_facts(profile_name_snapshot);
```

`initLinkDatabase(paths)` 在 `openSqliteDatabase()` 后直接执行上述 DDL，幂等安全。

### 4.6 完整 HTTP 路由（82 条）

```
# 系统 & 认证
GET    /api/v1/bootstrap
GET    /api/v1/status
GET    /api/v1/auth/me
POST   /api/v1/auth/device-session
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/logs
GET    /api/v1/statistics

# 配对
GET    /pair
GET    /api/v1/pairing/session
POST   /api/v1/pairing/claim

# 会话
GET    /api/v1/conversations
GET    /api/v1/conversations/search
POST   /api/v1/conversations
DELETE /api/v1/conversations
GET    /api/v1/conversations/events
GET    /api/v1/conversations/clear-plans/:planId
POST   /api/v1/conversations/clear-plans
GET    /api/v1/conversations/:id/messages
GET    /api/v1/conversations/:id/events
POST   /api/v1/conversations/:id/messages
POST   /api/v1/conversations/:id/blobs
POST   /api/v1/conversations/:id/ack
PATCH  /api/v1/conversations/:id/model
PATCH  /api/v1/conversations/:id/profile
PATCH  /api/v1/conversations/:id/title
DELETE /api/v1/conversations/:id

# Runs
POST   /api/v1/runs
GET    /api/v1/runs/:id/events
POST   /api/v1/runs/:id/cancel

# 设备
GET    /api/v1/devices
PATCH  /api/v1/devices/:id
DELETE /api/v1/devices/:id
DELETE /api/v1/devices/:id/app-listing

# Profiles
GET    /api/v1/profiles
GET    /api/v1/profiles/catalog
POST   /api/v1/profiles
GET    /api/v1/profile-creation/status
GET    /api/v1/profile-creation/events
GET    /api/v1/profiles/:name/status
GET    /api/v1/profiles/:name/statistics
PATCH  /api/v1/profiles/:name
DELETE /api/v1/profiles/:name

# Model configs
GET    /api/v1/models
GET    /api/v1/model-configs
POST   /api/v1/model-configs
PATCH  /api/v1/model-configs/defaults
DELETE /api/v1/model-configs
GET    /api/v1/profiles/:name/model-configs
POST   /api/v1/profiles/:name/model-configs
PATCH  /api/v1/profiles/:name/model-configs/defaults
DELETE /api/v1/profiles/:name/model-configs

# 权限 & 工具配置
GET    /api/v1/profiles/:name/permissions
PATCH  /api/v1/profiles/:name/permissions
GET    /api/v1/profiles/:name/tool-configs/:toolKey
PATCH  /api/v1/profiles/:name/tool-configs/:toolKey

# Memory
GET    /api/v1/profiles/:name/memory
POST   /api/v1/profiles/:name/memory/entries
PATCH  /api/v1/profiles/:name/memory/entries
DELETE /api/v1/profiles/:name/memory/entries
DELETE /api/v1/profiles/:name/memory
PATCH  /api/v1/profiles/:name/memory/settings
PATCH  /api/v1/profiles/:name/memory/provider

# Skills
GET    /api/v1/profiles/:name/skills
PATCH  /api/v1/profiles/:name/skills/:skillName

# Cron jobs
GET    /api/v1/cron-jobs
GET    /api/v1/profiles/:name/cron-jobs
POST   /api/v1/profiles/:name/cron-jobs
GET    /api/v1/profiles/:name/cron-jobs/:jobId
PATCH  /api/v1/profiles/:name/cron-jobs/:jobId
DELETE /api/v1/profiles/:name/cron-jobs/:jobId
POST   /api/v1/profiles/:name/cron-jobs/:jobId/pause
POST   /api/v1/profiles/:name/cron-jobs/:jobId/resume
POST   /api/v1/profiles/:name/cron-jobs/:jobId/run

# 自动更新
GET    /api/v1/hermes/update-check
GET    /api/v1/hermes/update/status
POST   /api/v1/hermes/update
GET    /api/v1/hermes/update/events
GET    /api/v1/link/update-check
GET    /api/v1/link/update/status
POST   /api/v1/link/update
GET    /api/v1/link/update/events

# 内部（仅 loopback）
POST   /internal/deliver
```

### 4.7 Bootstrap 响应

```json
{
  "link_id": "...",
  "display_name": "Hermes Link",
  "version": "0.1.0",
  "api_version": 1,
  "paired": true,
  "pairing_supported": true,
  "preferred_pairing_urls": [],
  "routes": [],
  "capabilities": {
    "runs": true, "sse": true, "relay": true,
    "profiles": true, "logs": true, "statistics": true,
    "conversations": true, "conversation_events": true,
    "conversation_delete": true, "conversation_bulk_delete": true,
    "conversation_clear_plan": true, "conversation_cancel": true,
    "conversation_rename": true, "blobs": true,
    "devices": true, "device_delete": true,
    "device_revoke": true, "device_rename": true,
    "device_session_enroll": true,
    "cron_jobs": true,
    "profile_skills": true, "profile_memory": true,
    "hermes_updates": true
  }
}
```

### 4.8 Relay 实现（`src/relay/relay-client.ts`）

WebSocket 连接：`${relayBaseUrl}/api/v1/relay/link/connect`

**入站帧（接收）：**
- `http.request` → 代理到 `http://127.0.0.1:PORT`
- `http.cancel` → 取消 in-flight 请求

**出站帧（发送）：**
- `network.routes` → 上报 LAN/公网可达地址
- `http.response` → 完整响应
- `http.stream.start` / `http.stream.chunk` / `http.stream.end` → SSE 流
- `http.error` → 502 代理出错

**重连退避：** base 1000ms，max 30000ms，指数退避，默认最多 5 次，超出 → `failed`

**Relay Bootstrap：**
1. `POST ${serverBaseUrl}/…/relay/link/bootstrap` — 获取 Server 签发的 bootstrap token
2. `POST ${relayBaseUrl}/api/v1/relay/link/bootstrap` — 凭 token 向 Relay 注册，分配 `link_id`

### 4.9 Hermes Agent 集成（`src/hermes/gateway.ts`）

```
默认 Agent 端口:    127.0.0.1:8642
Profile 端口范围:  8643–9641
最低版本要求:      >= 0.4.0
```

**请求到来时流程：**
1. 写 `~/.hermes/config.yaml`（profile 写 `~/.hermes/profiles/<name>/config.yaml`）
2. 检查 `127.0.0.1:8642/health`
3. 不可达 → 执行 `hermes gateway run --replace`（profile 加 `-p <name>`）
4. 若 `~/Library/LaunchAgents/ai.hermes.gateway.plist` 存在 → 走 `hermes gateway restart`
5. 轮询等待 Agent 就绪，超时返回错误

**`.env` 覆盖（`~/.hermes/.env`）：**`API_SERVER_ENABLED` / `API_SERVER_HOST` / `API_SERVER_PORT` / `API_SERVER_KEY`

**错误提示（Agent 缺失/过旧）：**
```
hermes update
hermes gateway run
```

### 4.10 Daemon 进程模型

```
hermeslink start
  └── spawn([node, link-cli, daemon-supervisor], detached)
        └── spawn([node, link-cli, daemon, --foreground], stdio:pipe)
              └── startLinkService() — Koa HTTP + Relay WS + Server 轮询
```

- Probe：`GET http://127.0.0.1:52379/api/v1/bootstrap`，验证 `api_version === 1` 且 `link_id` 匹配
- Stop：SIGTERM → 等 5s（20×250ms）→ SIGKILL → 等 2.5s → 删 PID 文件

### 4.11 开机自启（`src/autostart/autostart.ts`）

| 平台 | 方式 | 文件路径 |
|------|------|---------|
| macOS | launchd `RunAtLoad=true, KeepAlive=false` | `~/Library/LaunchAgents/com.hermes.link.plist` |
| Linux（有 systemd-user） | systemd user，`Restart=no` | `~/.config/systemd/user/hermeslink.service` |
| Linux（无 systemd-user） | XDG autostart | `~/.config/autostart/hermeslink.desktop` |
| Windows | Startup folder `.cmd` | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HermesLink.cmd` |

所有平台均以 `daemon-supervisor` 子命令启动。

### 4.12 Logger（`src/runtime/logger.ts`）

使用 **pino**，写入文件（`pino.destination(logFilePath)`），默认级别 `warn`。

```typescript
import pino from "pino";

export function createLogger(options: { paths: RuntimePaths; level?: string }): pino.Logger {
  return pino({ level: options.level ?? "warn" }, pino.destination(options.paths.logFile));
}
```

`GET /api/v1/logs` 直接流式读取 pino 输出的 NDJSON 文件，App 侧负责解析。

### 4.13 i18n（`src/i18n.ts`，单文件）

```typescript
const messages = {
  en: { /* 完整英文消息，见 reference/hermeslink/dist/cli/index.js 第 229–327 行 */ },
  "zh-CN": { /* 完整中文消息，见同文件第 328–425 行 */ }
}
function detectSystemLanguage(env?: NodeJS.ProcessEnv): "en" | "zh-CN"
function t(key: string, params?: Record<string, string>): string
```

`HERMESLINK_LANG` 环境变量覆盖语言。全套消息 key 完全对齐参考源。

---

## 5. package.json

```json
{
  "name": "@bulolo/hermes-link",
  "version": "0.1.0",
  "description": "Hermes Link companion service and CLI for connecting hermes-agent through zhiji",
  "license": "MIT",
  "type": "module",
  "bin": { "hermeslink": "dist/cli/index.js" },
  "files": ["dist", "scripts/check-node-version.mjs", "scripts/postinstall.mjs", "README.md", "LICENSE"],
  "keywords": ["hermes", "hermes-agent", "relay", "link", "cli"],
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build":       "tsup src/cli/index.ts src/http/app.ts --format esm --target node20 --dts --clean",
    "check":       "tsc --noEmit",
    "dev":         "tsx src/cli/index.ts",
    "preinstall":  "node ./scripts/check-node-version.mjs",
    "postinstall": "node ./scripts/postinstall.mjs",
    "prepack":     "npm run build",
    "start":       "node ./dist/cli/index.js",
    "test":        "vitest",
    "publish:npm": "npm publish --access public"
  },
  "dependencies": {
    "@koa/cors":        "^5.0.0",
    "@koa/router":      "^15.4.0",
    "better-sqlite3":   "^12.9.0",
    "commander":        "^12.1.0",
    "koa":              "^2.15.3",
    "qrcode":           "^1.5.4",
    "pino":             "^9.0.0",
    "qrcode-terminal":  "^0.12.0",
    "ws":               "^8.18.0",
    "yaml":             "^2.6.1",
    "zod":              "^3.24.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/koa":            "^2.15.0",
    "@types/node":           "^20.19.39",
    "@types/pino":           "^9.0.0",
    "@types/qrcode":         "^1.5.6",
    "@types/qrcode-terminal":"^0.12.2",
    "@types/ws":             "^8.5.13",
    "pino-pretty":           "^13.0.0",
    "tsup":                  "^8.3.5",
    "tsx":                   "^4.19.2",
    "typescript":            "^5.7.2",
    "vitest":                "^2.1.8"
  }
}
```

---

## 6. 实施阶段

### Phase 1 — 骨架与基础模块
- [ ] `package.json` / `tsconfig.json` / `tsup.config.ts`
- [ ] `scripts/check-node-version.mjs` + `scripts/postinstall.mjs`（复制参考源）
- [ ] `src/constants.ts`
- [ ] `src/runtime/paths.ts` — `resolveRuntimePaths()`
- [ ] `src/runtime/logger.ts` — `createLogger()`（pino）
- [ ] `src/core/errors.ts` — `LinkHttpError`
- [ ] `src/storage/sqlite.ts`
- [ ] `src/storage/atomic-json.ts` + `src/storage/atomic-file.ts`
- [ ] `src/storage/link-database.ts` — `initLinkDatabase()`，直接建表 + 全部读写函数
- [ ] `src/config/config.ts` — `loadConfig` / `saveConfig`
- [ ] `src/identity/identity.ts`

### Phase 2 — CLI & i18n & autostart
- [ ] `src/i18n.ts` — 完整 en/zh-CN 消息（照抄参考源，不遗漏任何 key）
- [ ] `src/autostart/autostart.ts` — 四平台
- [ ] `src/cli/index.ts` — 全部命令：version / status / start / stop / restart / daemon / daemon-supervisor / pair / doctor / logs / autostart / config / deliver

### Phase 3 — Hermes Agent & Network
- [ ] `src/hermes/config.ts`
- [ ] `src/hermes/cli.ts`
- [ ] `src/hermes/api-server.ts`
- [ ] `src/hermes/gateway.ts`
- [ ] `src/hermes/stt.ts`
- [ ] `src/hermes/cron-link-delivery.ts`
- [ ] `src/network/discovery.ts`
- [ ] `src/network/environment.ts`

### Phase 4 — Relay & 认证
- [ ] `src/relay/bootstrap.ts`
- [ ] `src/relay/relay-client.ts`（WebSocket + 重连退避 + 帧代理）
- [ ] `src/security/devices.ts`
- [ ] `src/security/app-connect-token.ts`
- [ ] `src/http/auth.ts`
- [ ] `src/http/request.ts`
- [ ] `src/http/sse.ts`

### Phase 5 — HTTP 服务器 & 配对
- [ ] `src/http/app.ts`
- [ ] `src/http/routes/system.ts`（bootstrap / status / auth / logs / devices / pairing / updates）
- [ ] 配对 HTML 页面（`/pair`，对齐参考源 HTML 模板）
- [ ] `src/http/routes/statistics.ts`

### Phase 6 — Conversations & Runs
- [ ] `src/conversations/conversation-service.ts`（EventEmitter 核心）
- [ ] `src/conversations/conversation-store.ts`
- [ ] `src/conversations/conversation-queries.ts`（游标分页 + 搜索）
- [ ] `src/conversations/conversation-metadata.ts`
- [ ] `src/conversations/conversation-turns.ts`
- [ ] `src/conversations/run-lifecycle.ts`
- [ ] `src/conversations/hermes-session-sync.ts`
- [ ] `src/conversations/hermes-sse.ts` + `stream-events.ts` + `agent-events.ts`
- [ ] `src/conversations/history-builder.ts`
- [ ] `src/conversations/conversation-orchestration.ts`
- [ ] `src/conversations/conversation-commands.ts`
- [ ] `src/conversations/slash-commands.ts`
- [ ] `src/conversations/approvals.ts`
- [ ] `src/conversations/statistics.ts`
- [ ] `src/conversations/blob-store.ts` + `media.ts`
- [ ] `src/conversations/delivery-staging.ts` + `delivery-import.ts` + `delivery-contract.ts`
- [ ] `src/conversations/conversation-view.ts`
- [ ] `src/conversations/conversation-session-ids.ts`
- [ ] `src/conversations/conversation-maintenance.ts`
- [ ] `src/conversations/conversation-clear-plans.ts`
- [ ] `src/conversations/profile-runtime.ts`
- [ ] `src/http/routes/conversations.ts`（16 条路由）
- [ ] `src/http/routes/runs.ts`（3 条）

### Phase 7 — Profiles & 扩展功能
- [ ] `src/http/routes/profiles.ts`（catalog + CRUD + statistics + profile-creation SSE）
- [ ] `src/http/routes/model-configs.ts`
- [ ] `src/http/routes/memory.ts`
- [ ] `src/http/routes/skills.ts`
- [ ] `src/http/routes/permissions.ts`
- [ ] `src/http/routes/cron-jobs.ts`（9 条路由：CRUD + pause/resume/run）

### Phase 8 — 自动更新 & 收尾
- [ ] Link 自身更新（npm install 流程 + scheduleAutomaticRestart）
- [ ] Hermes Agent 更新
- [ ] `POST /internal/deliver` 路由
- [ ] LAN IP 上报到 Server（`reportLinkStatusToServer`）
- [ ] 完整 i18n 消息校对（逐 key 对照参考源）
- [ ] vitest 测试覆盖
