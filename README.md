# @bulolo/hermes-link

本地伴随服务，为 [Hermes Agent](https://github.com/nousresearch/hermes-agent) 提供移动端接入能力，支持局域网直连。

## 概述

Hermes Link 是一个运行在本机的后台 HTTP 服务，默认监听 `http://0.0.0.0:52379`。客户端（App / 浏览器）通过局域网直接访问，对话、文件、指令均在本地处理，数据不经过外部服务器。

所有 API 请求分为两类：

- **无需鉴权**：`/pair`、`/api/v1/bootstrap`
- **需要 Bearer Token**：其余接口均需 `Authorization: Bearer hpat_xxx`，通过配对流程获取

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
  "preferred_urls": ["http://192.168.1.10:52379", "http://127.0.0.1:52379"]
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
curl -s -X POST http://localhost:52379/api/v1/auth/device-session \
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
hermeslink config set port 52379              # 修改监听端口（默认 52379）
hermeslink config set lan-host 192.168.1.10   # 手动指定局域网 IP（默认自动检测）
hermeslink config set language zh-CN          # 语言：auto / en / zh-CN
hermeslink config set log-level debug         # 日志级别：debug / info / warn / error
```

配置文件位于 `~/.hermeslink/config.json`。

## API 参考

服务默认监听 `http://0.0.0.0:52379`。所有需要鉴权的接口均使用 Bearer Token（`hpat_` 前缀）。

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
| GET | `/api/v1/link/update-check` | 检查 Link 版本更新 |
| GET | `/api/v1/hermes/update-check` | 检查 Hermes Agent 版本更新 |

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
| POST | `/api/v1/conversations/:id/blobs` | 上传附件 |
| GET | `/api/v1/conversations/:id/blobs/:blobId` | 下载附件 |
| DELETE | `/api/v1/conversations/:id/blobs/:blobId` | 删除附件 |

### 统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/statistics` | 全局使用统计 |
| GET | `/api/v1/statistics/usage` | Token 用量统计（`?days=7`） |

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
BASE="http://localhost:52379"

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
curl -s -X POST http://localhost:52379/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH\"}"
```

### 查询设备列表

```bash
curl -s http://localhost:52379/api/v1/devices \
  -H "Authorization: Bearer $ACCESS"
```

### 查询对话列表

```bash
curl -s "http://localhost:52379/api/v1/conversations?limit=10" \
  -H "Authorization: Bearer $ACCESS"
```

## 工作原理

```
客户端（浏览器 / App）
   │
   └──→ hermeslink (本机, 端口 52379)
              │
              └──→ Hermes Agent API Server (127.0.0.1:8642)
```

`hermeslink` 在本机运行一个 HTTP 服务，客户端通过局域网直接访问。对话、文件、指令均在本地处理，数据不经过外部服务器。

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

## 开机自启

- **macOS**：通过 launchd（`~/Library/LaunchAgents/com.hermes.link.plist`）
- **Linux**：通过 systemd 用户服务或 XDG autostart
- **Windows**：通过 Startup 文件夹

```bash
hermeslink autostart on
hermeslink autostart off
```

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

服务运行后可访问 `http://localhost:52379/api/v1/bootstrap` 验证是否正常。

## License

MIT
