# @bulolo/hermes-link

本地伴随服务，为 [Hermes Agent](https://github.com/nousresearch/hermes-agent) 提供 API 接入能力，支持公网、局域网直连。

## 概述

Hermes Link 是一个运行在本机的后台 HTTP 服务，默认监听 `http://0.0.0.0:18642`。客户端（App / 浏览器）通过公网或局域网直接访问，对话、文件、指令均在本地处理，数据不经过外部服务器。

所有 API 请求分为两类：

- **无需鉴权**：`/pair`、`/api/v1/bootstrap`
- **需要 Bearer Token**：其余接口均需 `Authorization: Bearer hpat_xxx`，通过配对流程获取

## 为什么需要 HermesLink？

Hermes Agent 内置了一个 API Server（端口 8642），但它只有 **12 个接口**：

| 功能 | Hermes API Server `:8642` | HermesLink `:18642` |
|------|:---:|:---:|
| 接口数量 | 12 | **97** |
| Agent 执行 / 事件流 | ✓ | ✓（代理转发） |
| 模型列表 / 定时任务 | ✓ | ✓（代理转发） |
| 认证 | 单一共享 Key | 设备独立 Token，可单独吊销 |
| 设备配对 | — | ✓ 二维码 / 多设备管理 |
| 对话存储 | — | ✓ 本地历史 + 附件 |
| Profile & Memory 管理 | — | ✓ 多 Profile、记忆、权限、工具开关 |
| 使用统计 | — | ✓ Token 用量按日期 / 模型 / Profile |
| 工具调用审批 | — | ✓ Approve / deny 流程 |
| 更新管理 / 开机自启 | — | ✓ |

### 如何选择

- **只需本机脚本 / 受信任内部服务直连** → 直接用 Hermes API Server（8642）
- **开发移动 App 或多设备接入** → 需要 HermesLink（18642）
- **需要对话历史 / Profile / 统计等完整功能** → 需要 HermesLink（18642）

## 工作原理

```
客户端（浏览器 / App）
   │
   └──→ hermeslink (本机, 端口 18642)
              │
              ├── 鉴权 / 设备管理 / 对话存储 / Profile & Memory    ← HermesLink 自身处理（~87 个接口）
              │
              └──→ Hermes Agent API Server (127.0.0.1:8642)         ← 仅 runs / models / cron jobs（~10 个接口）
```

绝大多数功能由 HermesLink 独立完成，不依赖 API Server。API Server 未运行时，认证、配对、对话查询、Profile 管理等接口仍可正常使用，仅 Agent 执行、模型列表、定时任务不可用。所有数据均存储在本机，不经过外部服务器。

## 环境要求

### 1. Node.js >= 20.0.0

```bash
node --version   # 需要 >= v20.0.0
```

如未安装，推荐通过 [nvm](https://github.com/nvm-sh/nvm) 安装：

```bash
nvm install 20
nvm use 20
```

### 2. 启动 Hermes Agent API Server

Hermes Link 通过 `127.0.0.1:8642` 与本机的 **Hermes Agent API Server** 通信。

> 如果 Hermes Agent API Server 未运行，对话、Profiles 等功能将无法使用，但认证、配对、设备管理、日志等基础接口仍可正常工作。

在 `~/.hermes/.env` 中添加以下配置以启用 API Server：

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=your-secret-key
API_SERVER_HOST=0.0.0.0
API_SERVER_CORS_ORIGINS=*
GATEWAY_ALLOW_ALL_USERS=true
```

| 配置项 | 说明 |
|--------|------|
| `API_SERVER_ENABLED` | 设为 `true` 开启 API Server |
| `API_SERVER_KEY` | 认证密钥，替换为强随机字符串 `openssl rand -hex 32` |
| `API_SERVER_HOST` | 监听地址，`0.0.0.0` 允许本机所有网卡 |
| `API_SERVER_CORS_ORIGINS` | CORS 来源，本地调试可设为 `*` |

配置完成后启动：

```bash
hermes gateway stop
hermes gateway start
或者
hermes gateway restart
```

验证是否就绪：

```bash
curl -s http://127.0.0.1:8642/v1/health
```

如缺失或版本过旧：

```bash
hermes update
```

## 安装

npm 包地址：[https://www.npmjs.com/package/@bulolo/hermes-link](https://www.npmjs.com/package/@bulolo/hermes-link)

```bash
npm install -g @bulolo/hermes-link
```

> 安装后如果终端找不到 `hermeslink` 命令，说明 npm 全局 bin 目录不在 PATH 中，运行以下命令添加：
>
> ```bash
> export PATH="$(npm prefix -g)/bin:$PATH"
> ```
>
> 也可以直接用完整路径调用：`$(npm prefix -g)/bin/hermeslink`

## 快速开始

```bash
# 1. 启动后台服务
hermeslink start

# 2. 生成配对页面（浏览器打开完成配对）
hermeslink pair

# 3. 查看状态
hermeslink status

# 4. 查看日志
hermeslink logs
```

## 配对流程

### 方式一：App 扫码配对（标准流程）

二维码内容是一段 JSON，App 解析后获取连接所需的全部信息：

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

App 拿到上述信息后：

```
1. 取 preferred_urls[0] 作为服务地址（优先局域网 IP）
2. POST {baseUrl}/api/v1/pairing/claim
   Body: { "session_id": "...", "claim_token": "<code 字段的值>" }
3. 响应中获得 access_token 和 refresh_token
4. 后续 API 请求携带 Authorization: Bearer <access_token>
```

### 方式二：浏览器配对

```bash
hermeslink pair
# 在浏览器打开终端输出的 Pairing page URL
# 点击"在此设备上配对"，页面直接显示 access_token 和 refresh_token
```

### 方式三：命令行脚本（适合自动化）

```bash
# 1. 获取 connect_token
CONNECT_TOKEN=$(hermeslink pair 2>&1 | grep "Connect token:" | awk '{print $NF}')

# 2. 用 connect_token 换 access_token
curl -s -X POST http://localhost:18642/api/v1/auth/device-session \
  -H "Authorization: Bearer $CONNECT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"device_label":"my-script","device_platform":"cli"}'
```

---

> **Token 有效期**：access_token 15 分钟，refresh_token 90 天。access_token 过期后用 refresh_token 换新，无需重新配对。

## 命令一览

| 命令 | 说明 |
|------|------|
| `hermeslink start` | 启动后台守护进程 |
| `hermeslink stop` | 停止守护进程 |
| `hermeslink restart` | 重启守护进程 |
| `hermeslink status` | 查看运行状态 |
| `hermeslink pair` | 生成配对 URL 和二维码 |
| `hermeslink config get` | 查看当前配置 |
| `hermeslink config set <key> <value>` | 修改配置 |
| `hermeslink autostart on` | 开机自启（同 `enable`）|
| `hermeslink autostart off` | 关闭自启（同 `disable`）|
| `hermeslink logs` | 查看 Link 日志 |
| `hermeslink logs --gateway` | 查看 Hermes 网关日志 |
| `hermeslink logs -n 100` | 查看最近 100 条日志 |
| `hermeslink version` | 查看版本号 |

## 配置

```bash
hermeslink config set port 18642              # 修改监听端口（默认 18642）
hermeslink config set lan-host 192.168.1.10   # 手动指定局域网 IP（默认自动检测）
hermeslink config set language zh-CN          # 语言：auto / en / zh-CN
hermeslink config set log-level debug         # 日志级别：debug / info / warn / error
```

配置文件位于 `~/.hermeslink/config.json`。

## API 参考

服务默认监听 `http://0.0.0.0:18642`。所有需要鉴权的接口均使用 Bearer Token（`hpat_` 前缀）。

### Token 说明

| Token | 前缀 | 有效期 | 用途 |
|-------|------|--------|------|
| Connect Token | 无前缀（base64url）| 5 分钟，一次性 | 兑换 access_token |
| Access Token | `hpat_` | 15 分钟 | 所有 API 请求 |
| Refresh Token | `hprt_` | 90 天 | 刷新 access_token |

### 无需鉴权

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/pair` | 配对网页（浏览器打开） |
| GET | `/api/v1/bootstrap` | 服务基础信息，含 link_id、版本、能力 |

### 认证 / 设备

所有以下接口需要 Header：`Authorization: Bearer hpat_xxx`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/auth/me` | 当前 Token 信息及设备信息 |
| POST | `/api/v1/auth/device-session` | 用 connect_token 换取 access/refresh token |
| POST | `/api/v1/auth/refresh` | 用 refresh_token 换新 access_token |
| POST | `/api/v1/auth/logout` | 撤销 refresh_token |

**POST `/api/v1/auth/device-session`** 的 Authorization 头需放 **connect_token**（不是 hpat_），Body：

```json
{
  "device_label": "我的设备",
  "device_platform": "ios|android|web|cli",
  "device_model": "可选，设备型号"
}
```

响应：

```json
{
  "ok": true,
  "device": { "device_id": "dev_xxx", "label": "我的设备", "platform": "ios" },
  "access_token":  { "token": "hpat_xxx", "expires_at": "2026-05-08T13:00:00Z" },
  "refresh_token": { "token": "hprt_xxx", "expires_at": "2026-08-06T12:00:00Z" }
}
```

**POST `/api/v1/auth/refresh`** Body：

```json
{ "refresh_token": "hprt_xxx" }
```

### 配对

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/pairing/session` | 查询配对会话状态（含 claimed 字段） |
| POST | `/api/v1/pairing/claim` | App 端用来完成配对 |

**GET `/api/v1/pairing/session`** 查询参数：`?session_id=ps_xxx`

**POST `/api/v1/pairing/claim`** Body：

```json
{
  "session_id": "ps_xxx",
  "claim_token": "connect_token值",
  "device_label": "My App",
  "device_platform": "ios"
}
```

### 系统状态

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/status` | 服务整体状态（版本、设备数、profiles 数量等） |
| GET | `/api/v1/logs` | 最近日志（`?source=link\|gateway&limit=50`） |

### 设备列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/devices` | 列出所有已配对设备 |
| PATCH | `/api/v1/devices/:deviceId` | 重命名设备（`{"label":"新名字"}`） |
| DELETE | `/api/v1/devices/:deviceId` | 撤销设备（吊销 token） |
| DELETE | `/api/v1/devices/:deviceId/app-listing` | 从列表中隐藏已撤销设备 |

### 对话（Conversations）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/conversations` | 列出所有对话（`?limit=20&cursor=xxx`） |
| GET | `/api/v1/conversations/search` | 搜索对话（`?q=关键词`） |
| POST | `/api/v1/conversations` | 新建对话 |
| DELETE | `/api/v1/conversations` | 批量删除对话 |
| DELETE | `/api/v1/conversations/:id` | 删除单个对话 |
| GET | `/api/v1/conversations/:id/messages` | 获取对话消息列表 |
| POST | `/api/v1/conversations/:id/messages` | 发送消息 |
| GET | `/api/v1/conversations/:id/events` | SSE 实时事件流 |
| GET | `/api/v1/conversations/events` | 所有对话事件流（SSE） |
| PATCH | `/api/v1/conversations/:id/title` | 重命名对话（`{"title":"新标题"}`） |
| PATCH | `/api/v1/conversations/:id/model` | 切换模型 |
| PATCH | `/api/v1/conversations/:id/profile` | 切换 profile |
| POST | `/api/v1/conversations/:id/ack` | 确认已读 |
| POST | `/api/v1/conversations/clear-plans` | 创建批量清理计划 |
| GET | `/api/v1/conversations/clear-plans/:planId` | 查询清理计划状态 |
| POST | `/api/v1/conversations/clear-plans/:planId/execute` | 执行清理计划 |
| POST | `/api/v1/conversations/:id/runs/:runId/cancel` | 取消对话内的某次执行 |
| POST | `/api/v1/conversations/:id/approvals/:approvalId/approve` | 审批工具调用（允许） |
| POST | `/api/v1/conversations/:id/approvals/:approvalId/deny` | 审批工具调用（拒绝） |
| POST | `/api/v1/conversations/:id/blobs` | 上传附件 |
| GET | `/api/v1/conversations/:id/blobs/:blobId` | 下载附件 |
| DELETE | `/api/v1/conversations/:id/blobs/:blobId` | 删除附件 |

### 统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/statistics` | 全局使用统计（对话、消息数等） |
| GET | `/api/v1/statistics/usage` | Token 用量统计（`?days=7&from=2026-05-01&to=2026-05-08&model=xxx&profile=xxx`） |

### 模型（Models）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/models` | 列出可用模型（来自 Hermes API Server，OpenAI 兼容格式） |
| GET | `/api/v1/model-configs` | 列出全局模型配置 |
| POST | `/api/v1/model-configs` | 新增全局模型配置 |
| PATCH | `/api/v1/model-configs/defaults` | 更新默认模型配置 |
| DELETE | `/api/v1/model-configs` | 删除全局模型配置 |

### Profiles

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/profiles` | 列出所有 Profile 名称 |
| POST | `/api/v1/profiles` | 创建新 Profile（异步，返回 202） |
| PATCH | `/api/v1/profiles/:name` | 重命名（`{"name":"new-name"}`）或更新元数据 |
| DELETE | `/api/v1/profiles/:name` | 删除 Profile |
| GET | `/api/v1/profiles/catalog` | 完整目录（包含各 Profile 的 capabilities、permissions、modelConfigs）|
| GET | `/api/v1/profile-creation/status` | 查询创建进度 |
| GET | `/api/v1/profile-creation/events` | 创建进度 SSE 流 |
| GET | `/api/v1/profiles/:name/status` | Profile 状态（存在性、API Key 配置等） |
| GET | `/api/v1/profiles/:name/statistics` | Profile 的对话统计 |
| GET | `/api/v1/profiles/:name/skills` | 列出 Profile Skills（`?include_disabled=true`）|
| PATCH | `/api/v1/profiles/:name/skills/:skillName` | 启用/禁用 Skill（`{"enabled":true}`） |
| GET | `/api/v1/profiles/:name/memory` | 查看记忆（USER.md + MEMORY.md） |
| POST | `/api/v1/profiles/:name/memory/entries` | 新增记忆条目（`{"target":"memory","content":"..."}`)  |
| PATCH | `/api/v1/profiles/:name/memory/entries` | 替换记忆条目（`{"target":"memory","match":"旧内容","content":"新内容"}`）|
| DELETE | `/api/v1/profiles/:name/memory/entries` | 删除记忆条目（`{"target":"memory","match":"匹配内容"}`）|
| DELETE | `/api/v1/profiles/:name/memory` | 重置记忆（`{"target":"memory\|user\|all"}`）|
| PATCH | `/api/v1/profiles/:name/memory/settings` | 更新记忆 Provider 设置 |
| PATCH | `/api/v1/profiles/:name/memory/provider` | 切换记忆 Provider（`{"provider":"built-in"}`）|
| GET | `/api/v1/profiles/:name/permissions` | 查看权限配置 |
| PATCH | `/api/v1/profiles/:name/permissions` | 更新权限配置 |
| GET | `/api/v1/profiles/:name/tool-configs/:toolKey` | 查看工具配置（toolKey：`web` / `image_gen` / `stt` / `tts` / `messaging` / `homeassistant` / `rl`）|
| PATCH | `/api/v1/profiles/:name/tool-configs/:toolKey` | 更新工具配置（同上 toolKey）|
| GET | `/api/v1/profiles/:name/model-configs` | 列出 Profile 的模型配置 |
| POST | `/api/v1/profiles/:name/model-configs` | 新增 Profile 的模型配置 |
| PATCH | `/api/v1/profiles/:name/model-configs/defaults` | 更新 Profile 默认模型 |
| DELETE | `/api/v1/profiles/:name/model-configs` | 删除 Profile 的模型配置 |

记忆 `target` 字段：`"memory"`（Agent 笔记，MEMORY.md）或 `"user"`（用户信息，USER.md）。

### Cron Jobs（定时任务）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/cron-jobs` | 汇总列出所有 Profile 的定时任务 |
| GET | `/api/v1/profiles/:name/cron-jobs` | 列出指定 Profile 的定时任务 |
| POST | `/api/v1/profiles/:name/cron-jobs` | 创建定时任务 |
| GET | `/api/v1/profiles/:name/cron-jobs/:jobId` | 查看定时任务详情 |
| PATCH | `/api/v1/profiles/:name/cron-jobs/:jobId` | 更新定时任务 |
| DELETE | `/api/v1/profiles/:name/cron-jobs/:jobId` | 删除定时任务 |
| POST | `/api/v1/profiles/:name/cron-jobs/:jobId/pause` | 暂停定时任务 |
| POST | `/api/v1/profiles/:name/cron-jobs/:jobId/resume` | 恢复定时任务 |
| POST | `/api/v1/profiles/:name/cron-jobs/:jobId/run` | 立即执行定时任务 |

### Runs（执行任务）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/runs` | 向 Hermes Agent 提交执行任务（返回 202） |
| GET | `/api/v1/runs/:runId/events` | 订阅执行事件流（SSE 代理） |
| POST | `/api/v1/runs/:runId/cancel` | 取消执行任务 |

**POST `/api/v1/runs`** Body：

```json
{
  "input": "请帮我整理 ~/Downloads 目录",
  "profile": "default",
  "instructions": "可选的系统指令",
  "session_id": "可选的会话 ID",
  "conversation_history": []
}
```

响应（202）：

```json
{
  "run_id": "run_xxx",
  "fallback": false
}
```

### 更新管理（Updates）

#### Hermes Agent 更新

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/hermes/update-check` | 检查 Hermes Agent 是否有新版本 |
| GET | `/api/v1/hermes/update/status` | 查询 Hermes 更新进度 |
| POST | `/api/v1/hermes/update` | 触发 Hermes Agent 更新 |
| GET | `/api/v1/hermes/update/events` | 更新进度 SSE 流 |

#### Link 自身更新

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/link/update-check` | 检查 Link 是否有新版本 |
| GET | `/api/v1/link/update/status` | 查询 Link 更新进度 |
| POST | `/api/v1/link/update` | 触发 Link 自更新（`{"version":"0.3.0"}`）|
| GET | `/api/v1/link/update/events` | 更新进度 SSE 流 |

### 系统（System）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/system/status` | 系统详情（版本、自启状态、网络环境）|
| GET | `/api/v1/system/version` | 仅返回 Link 版本号 |
| POST | `/api/v1/system/autostart/enable` | 开启开机自启 |
| POST | `/api/v1/system/autostart/disable` | 关闭开机自启 |
| GET | `/api/v1/system/logs` | 最近 Link 日志 |
| GET | `/api/v1/system/logs/gateway` | 最近 Gateway 日志 |
| GET | `/api/v1/system/updates` | 查询可用更新（Hermes + Link 汇总）|
| POST | `/api/v1/system/updates/dismiss` | 忽略当前可用更新提示 |

### 错误响应格式

所有错误均返回：

```json
{
  "ok": false,
  "error": {
    "code": "error_code",
    "message": "Human readable message"
  }
}
```

常见错误码：

| code | HTTP | 说明 |
|------|------|------|
| `auth_required` | 401 | 未提供 Authorization |
| `device_access_token_invalid` | 401 | access_token 已过期或无效 |
| `auth_invalid` | 401 | connect_token 无效或已用过 |
| `pairing_session_not_found` | 404 | 配对会话不存在 |
| `pairing_session_expired` | 404 | 配对会话已过期 |
| `pairing_claim_mismatch` | 409 | 配对 token 不匹配 |
| `link_not_paired` | 409 | 服务尚未分配 link_id |

## 调用示例

### 全流程脚本

```bash
#!/bin/bash
BASE="http://localhost:18642"

# Step 1: 生成配对 token
CONNECT=$(hermeslink pair 2>&1 | grep "Connect token:" | awk '{print $NF}')
echo "Connect token: $CONNECT"

# Step 2: 兑换 access_token 和 refresh_token
RESP=$(curl -s -X POST "$BASE/api/v1/auth/device-session" \
  -H "Authorization: Bearer $CONNECT" \
  -H "Content-Type: application/json" \
  -d '{"device_label":"my-script","device_platform":"cli"}')

ACCESS=$(echo $RESP | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token']['token'])")
REFRESH=$(echo $RESP | python3 -c "import json,sys; print(json.load(sys.stdin)['refresh_token']['token'])")
echo "Access:  $ACCESS"
echo "Refresh: $REFRESH"

# Step 3: 查询状态
curl -s "$BASE/api/v1/status" -H "Authorization: Bearer $ACCESS" | python3 -m json.tool
```

### 刷新 Token

```bash
curl -s -X POST http://localhost:18642/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH\"}"
```

### 查询设备列表

```bash
curl -s http://localhost:18642/api/v1/devices \
  -H "Authorization: Bearer $ACCESS"
```

### 查询对话列表

```bash
curl -s "http://localhost:18642/api/v1/conversations?limit=10" \
  -H "Authorization: Bearer $ACCESS"
```

## 开机自启

- **macOS**：通过 launchd（`~/Library/LaunchAgents/com.hermes.link.plist`）
- **Linux**：通过 systemd 用户服务或 XDG autostart
- **Windows**：通过 Startup 文件夹

```bash
hermeslink autostart on
hermeslink autostart off
```

## 运行时文件

所有文件存储于 `~/.hermeslink/`：

| 路径 | 说明 |
|------|------|
| `config.json` | 用户配置 |
| `identity.json` | 设备身份（ed25519 密钥对 + link_id）|
| `credentials.json` | 已配对设备的访问令牌 |
| `app-connect-tokens.json` | 待使用的配对 token（5 分钟有效）|
| `conversations/` | 对话数据 |
| `blobs/` | 文件附件 |
| `pairing/` | 配对会话 |
| `link.db` | SQLite 数据库（统计信息）|
| `logs/` | 日志文件 |

卸载 npm 包不会删除此目录，重新安装后仍可复用同一 link_id。

## 环境变量

| 变量 | 说明 |
|------|------|
| `HERMESLINK_HOME` | 覆盖运行时目录（默认 `~/.hermeslink`）|
| `HERMESLINK_LOG_LEVEL` | 覆盖日志级别 |
| `HERMESLINK_LANG` | 覆盖语言（`en` / `zh-CN`）|
| `HERMES_BIN` | `hermes` 二进制路径（默认 `hermes`）|
| `HERMESLINK_LISTEN_HOST` | HTTP 监听地址（默认 `0.0.0.0`）|

## 开发调试

```bash
# 安装依赖并构建
npm install
npm run build

# 前台运行（调试）
npm run dev:run
# 或
node dist/cli/index.js daemon --foreground

# watch 模式（自动重编译，需手动重启服务）
npm run dev:watch     # 终端1：监听源码变化自动 build
node dist/cli/index.js daemon --foreground  # 终端2：运行服务

# TypeScript 类型检查
npm run check
```

服务运行后可访问 `http://localhost:18642/api/v1/bootstrap` 验证是否正常。

## License

MIT
