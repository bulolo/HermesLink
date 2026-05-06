# @bulolo/hermes-link

本地伴随服务，为 [Hermes Agent](https://github.com/nousresearch/hermes-agent) 提供移动端接入能力，支持局域网直连。

## 环境要求

- Node.js >= 20
- 已安装并运行的 [Hermes Agent](https://github.com/nousresearch/hermes-agent)

## 安装

```bash
npm install -g @bulolo/hermes-link --registry https://registry.npmjs.org
```

## 快速开始

```bash
# 启动后台服务
hermeslink start

# 生成配对二维码（手机扫码连接）
hermeslink pair

# 查看状态
hermeslink status

# 查看日志
hermeslink logs
```

## 配对流程

```
1. 运行 hermeslink pair
        │
        ▼
   终端显示二维码
        │
        ▼
   手机 App 扫码
        │
        ▼
   直连本地服务 (局域网 / 127.0.0.1)
```

配对完成后，手机 App 获得访问令牌，后续请求直接连接本地服务，无需经过外部服务器。

## 命令一览

| 命令 | 说明 |
|------|------|
| `hermeslink start` | 启动后台守护进程 |
| `hermeslink stop` | 停止守护进程 |
| `hermeslink restart` | 重启守护进程 |
| `hermeslink status` | 查看运行状态 |
| `hermeslink pair` | 生成配对二维码 |
| `hermeslink config get` | 查看当前配置 |
| `hermeslink config set <key> <value>` | 修改配置 |
| `hermeslink autostart enable` | 开机自启 |
| `hermeslink autostart disable` | 关闭自启 |
| `hermeslink logs` | 查看日志 |
| `hermeslink logs --gateway` | 查看 Hermes 网关日志 |
| `hermeslink version` | 查看版本 |

## 配置

```bash
hermeslink config set port 52379              # 修改监听端口
hermeslink config set lan-host 192.168.1.10   # 手动指定局域网 IP
hermeslink config set language zh-CN          # 语言 (auto/en/zh-CN)
hermeslink config set log-level debug         # 日志级别 (debug/info/warn/error)
```

配置文件位于 `~/.hermeslink/config.json`。

## 工作原理

```
手机 App
   │
   └──→ hermeslink (本地, 端口 52379)
              │
              └──→ Hermes Agent (localhost:8642)
```

`hermeslink` 在本地运行一个 HTTP 服务，手机 App 通过局域网直接访问。对话、文件、指令均在本地处理，数据不经过外部服务器。

## 运行时文件

所有文件存储于 `~/.hermeslink/`：

| 路径 | 说明 |
|------|------|
| `config.json` | 用户配置 |
| `identity.json` | 设备身份（ed25519 密钥对）|
| `credentials.json` | 已配对设备的访问令牌 |
| `conversations/` | 对话数据 |
| `blobs/` | 文件附件 |
| `pairing/` | 配对会话 |
| `link.db` | SQLite 数据库（统计信息）|
| `logs/` | 日志文件 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `HERMESLINK_HOME` | 覆盖运行时目录（默认 `~/.hermeslink`）|
| `HERMESLINK_LOG_LEVEL` | 覆盖日志级别 |
| `HERMESLINK_LANG` | 覆盖语言 |
| `HERMES_BIN` | `hermes` 二进制路径（默认 `hermes`）|

## 开机自启

- **macOS**：通过 launchd（`~/Library/LaunchAgents/com.hermes.link.plist`）
- **Linux**：通过 systemd 用户服务或 XDG autostart
- **Windows**：通过 Startup 文件夹

```bash
hermeslink autostart enable
hermeslink autostart disable
```

## License

MIT
