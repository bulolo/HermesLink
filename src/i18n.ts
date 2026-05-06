export type Language = "en" | "zh-CN";

type MessageKey =
  | "program.description"
  | "program.version"
  | "status.description"
  | "status.json"
  | "status.runtime"
  | "status.mode"
  | "status.port"
  | "status.lanHost"
  | "status.notSet"
  | "status.environmentWarning"
  | "status.linkId"
  | "status.notPaired"
  | "start.description"
  | "start.backgroundStarted"
  | "start.alreadyRunning"
  | "start.notPaired"
  | "start.notPaired.detail"
  | "start.listening"
  | "start.relayConnecting"
  | "stop.description"
  | "stop.stopped"
  | "stop.notRunning"
  | "restart.description"
  | "deliver.description"
  | "deliver.imported"
  | "deliver.none"
  | "config.description"
  | "config.set.description"
  | "config.unset.description"
  | "config.unknownKey"
  | "config.lanHostInvalid"
  | "config.lanHostSet"
  | "config.lanHostUnset"
  | "config.logLevelInvalid"
  | "config.logLevelSet"
  | "config.logLevelUnset"
  | "config.reported"
  | "config.reportSkippedUnpaired"
  | "daemon.description"
  | "daemon.foreground"
  | "logs.description"
  | "logs.servicePath"
  | "logs.daemonPath"
  | "autostart.description"
  | "autostart.on.description"
  | "autostart.off.description"
  | "autostart.status.description"
  | "autostart.enabled"
  | "autostart.disabled"
  | "autostart.status.enabled"
  | "autostart.status.disabled"
  | "autostart.unsupported"
  | "autostart.alreadyEnabled"
  | "pair.description"
  | "pair.preflight"
  | "pair.preflight.hermesFiles"
  | "pair.preflight.hermesCli"
  | "pair.preflight.hermesApiServer"
  | "pair.hermesHome"
  | "pair.hermesVersion"
  | "pair.apiReady"
  | "pair.preparing"
  | "pair.scan"
  | "pair.openPairingPage"
  | "pair.manualCode"
  | "pair.expires"
  | "pair.expired"
  | "pair.claimed"
  | "pair.claimedRunning"
  | "pair.relayOnlyNotice"
  | "pair.relayOnlyLanHostHint"
  | "pair.relayOnlySafetyHint"
  | "pair.autostartUnchanged"
  | "pair.autostartFailed"
  | "doctor.description"
  | "doctor.identityOk"
  | "doctor.installId"
  | "doctor.linkId"
  | "doctor.notAssigned"
  | "doctor.lanHost"
  | "doctor.networkWarning"
  | "doctor.hermesCli"
  | "doctor.hermesCliUnavailable"
  | "doctor.apiReady"
  | "doctor.apiStarted"
  | "doctor.apiUnavailable"
  | "error.relayPublicKeyMismatch"
  | "error.relayChallengeInvalid"
  | "error.relayLinkInvalid"
  | "error.relayEmpty"
  | "error.serverHttp"
  | "error.pairingServerUnreachable"
  | "error.pairingRelayUnreachable"
  | "error.portInUse"
  | "error.pairingRequires"
  | "error.pairingRequires.detail";

const messages: Record<Language, Record<MessageKey, string>> = {
  en: {
    "program.description": "Hermes Link companion service",
    "program.version": "print Hermes Link version",
    "status.description": "Show local Hermes Link status",
    "status.json": "print machine-readable status",
    "status.runtime": "Runtime: {value}",
    "status.mode": "Mode: {value}",
    "status.port": "Local port: {value}",
    "status.lanHost": "Configured LAN host: {value}",
    "status.notSet": "not set",
    "status.environmentWarning": "Network note: {message}",
    "status.linkId": "Link ID: {value}",
    "status.notPaired": "not paired",
    "start.description": "Start Hermes Link daemon",
    "start.backgroundStarted": "Hermes Link is running in the background. PID: {pid}",
    "start.alreadyRunning": "Hermes Link is already running. PID: {pid}",
    "start.notPaired": "Hermes Link is not paired yet. Starting in local-only maintenance mode.",
    "start.notPaired.detail":
      "Relay, Server polling, and LAN entrypoints stay disabled until you run `hermeslink pair`.",
    "start.listening": "Hermes Link API listening on http://127.0.0.1:{port}",
    "start.relayConnecting": "Relay control connecting for {linkId}",
    "stop.description": "Stop the background Hermes Link daemon",
    "stop.stopped": "Hermes Link stopped.",
    "stop.notRunning": "Hermes Link is not running.",
    "restart.description": "Restart the background Hermes Link daemon",
    "deliver.description": "Import files from a Hermes Link delivery staging directory",
    "deliver.imported": "Delivered {count} file(s) to conversation {conversationId}.",
    "deliver.none": "No new files were delivered for conversation {conversationId}.",
    "config.description": "Manage local Hermes Link configuration",
    "config.set.description": "Set a configuration value",
    "config.unset.description": "Unset a configuration value",
    "config.unknownKey": "Unknown config key: {key}",
    "config.lanHostInvalid": "lan-host must be a private LAN IPv4 address, such as 192.168.1.23.",
    "config.lanHostSet": "Configured LAN host: {value}",
    "config.lanHostUnset": "Configured LAN host cleared.",
    "config.logLevelInvalid": "log-level must be one of: debug, info, warn, error.",
    "config.logLevelSet": "Configured log level: {value}",
    "config.logLevelUnset": "Configured log level reset to the default: {value}.",
    "config.reported": "Updated HermesPilot Server with the latest LAN address.",
    "config.reportSkippedUnpaired": "Hermes Link is not paired yet. The LAN address will be reported after pairing.",
    "daemon.description": "Run Hermes Link in the foreground",
    "daemon.foreground": "Hermes Link foreground daemon is running. Press Ctrl+C to stop.",
    "logs.description": "Show Hermes Link log paths",
    "logs.servicePath": "Service log: {path}",
    "logs.daemonPath": "Daemon stdout/stderr log: {path}",
    "autostart.description": "Manage boot autostart",
    "autostart.on.description": "Enable boot autostart",
    "autostart.off.description": "Disable boot autostart",
    "autostart.status.description": "Show boot autostart status",
    "autostart.enabled": "Boot autostart enabled via {method}: {path}",
    "autostart.disabled": "Boot autostart disabled.",
    "autostart.status.enabled": "Boot autostart: enabled via {method}: {path}",
    "autostart.status.disabled": "Boot autostart: disabled. Method: {method}. File: {path}",
    "autostart.unsupported": "Boot autostart is not supported on this platform yet.",
    "autostart.alreadyEnabled": "Boot autostart is already enabled via {method}: {path}",
    "pair.description": "Create a Hermes Link pairing session",
    "pair.preflight": "Checking local Hermes configuration before pairing...",
    "pair.preflight.hermesFiles": "Checking Hermes data directory, config, and environment files...",
    "pair.preflight.hermesCli": "Checking whether the Hermes CLI is available...",
    "pair.preflight.hermesApiServer": "Checking whether the Hermes API Server is ready...",
    "pair.hermesHome": "Hermes home: {path}",
    "pair.hermesVersion": "Hermes CLI: {value}",
    "pair.apiReady": "Hermes API Server is ready on 127.0.0.1:{port}",
    "pair.preparing": "Creating the pairing session...",
    "pair.scan": "Please scan the QR code below in the HermesPilot App:",
    "pair.openPairingPage": "If the QR code is hard to scan, you can open this page locally: {url}",
    "pair.manualCode":
      "You can also use the HermesPilot App manual connection mode and enter this pairing code:",
    "pair.expires": "Pairing expires in 10 minutes. Press Ctrl+C to cancel waiting.",
    "pair.expired": "Pairing expired. Please run `hermeslink pair` again.",
    "pair.claimed": "Pairing succeeded. Starting Hermes Link in the background...",
    "pair.claimedRunning": "Pairing succeeded. Hermes Link is already running in the background.",
    "pair.relayOnlyNotice":
      "Network note: this {kind} environment does not expose a phone-reachable LAN/public direct address by default. The App will connect through Relay.",
    "pair.relayOnlyLanHostHint":
      "If you manually expose this Link from Windows or your router, run `hermeslink config set lan-host <Windows LAN IP>` to publish the reachable LAN address.",
    "pair.relayOnlySafetyHint":
      "Hermes Link will not automatically change Windows/WSL bridge, firewall, or portproxy settings because those are system-level network exposure choices.",
    "pair.autostartUnchanged": "Existing paired devices found. Boot autostart settings were left unchanged.",
    "pair.autostartFailed": "Pairing succeeded, but boot autostart could not be enabled: {message}",
    "doctor.description": "Run local diagnostics",
    "doctor.identityOk": "Runtime identity: OK",
    "doctor.installId": "Install ID: {value}",
    "doctor.linkId": "Link ID: {value}",
    "doctor.notAssigned": "not assigned",
    "doctor.lanHost": "Configured LAN host: {value}",
    "doctor.networkWarning": "Network note: {message}",
    "doctor.hermesCli": "Hermes CLI: {value}",
    "doctor.hermesCliUnavailable":
      "Hermes CLI is unavailable. Please make sure the `hermes` command can run in this system.",
    "doctor.apiReady": "Hermes API Server: ready",
    "doctor.apiStarted": "Hermes API Server: started and ready",
    "doctor.apiUnavailable": "Hermes API Server: unavailable. {message}",
    "error.relayPublicKeyMismatch":
      "Relay rejected the pairing request because the Server-issued bootstrap token does not match this Link public key. Make sure Server and Relay are deployed with the same bootstrap key configuration, then run `hermeslink pair` again.",
    "error.relayChallengeInvalid": "Relay did not return a valid install challenge.",
    "error.relayLinkInvalid": "Relay did not return a valid link_id.",
    "error.relayEmpty": "Relay returned an empty response.",
    "error.serverHttp": "HermesPilot Server request failed with HTTP {status}.",
    "error.pairingServerUnreachable":
      "Could not reach HermesPilot Server while creating the pairing session. Check whether {url} is reachable, then try again. If you use a proxy network, add hermes-server.clawpilot.me and hermes-relay.clawpilot.me to the proxy exclusion list, or temporarily turn off VPN/proxy and retry.",
    "error.pairingRelayUnreachable":
      "Could not reach Hermes Relay while creating the pairing session. Check whether {url} is reachable, then try again. If you use a proxy network, add hermes-server.clawpilot.me and hermes-relay.clawpilot.me to the proxy exclusion list, or temporarily turn off VPN/proxy and retry.",
    "error.portInUse":
      "Local port {port} is already in use by another process. Stop that process or change the Hermes Link port, then run `hermeslink pair` again.",
    "error.pairingRequires": "Pairing needs HermesPilot Server and Relay, but this command could not start a complete pairing session.",
    "error.pairingRequires.detail":
      "The deployed services may be healthy, but the installed Link package must call Server for a short-lived relay bootstrap token before it can request a link_id.",
  },
  "zh-CN": {
    "program.description": "Hermes Link 本地伴随服务",
    "program.version": "输出 Hermes Link 版本号",
    "status.description": "查看本机 Hermes Link 状态",
    "status.json": "输出机器可读的状态 JSON",
    "status.runtime": "运行目录：{value}",
    "status.mode": "模式：{value}",
    "status.port": "本地端口：{value}",
    "status.lanHost": "已配置局域网主机：{value}",
    "status.notSet": "未设置",
    "status.environmentWarning": "网络提示：{message}",
    "status.linkId": "Link ID：{value}",
    "status.notPaired": "尚未配对",
    "start.description": "启动 Hermes Link 服务",
    "start.backgroundStarted": "Hermes Link 已在后台运行。PID：{pid}",
    "start.alreadyRunning": "Hermes Link 已经在运行。PID：{pid}",
    "start.notPaired": "Hermes Link 还没有配对，将以本地维护模式启动。",
    "start.notPaired.detail": "在你运行 `hermeslink pair` 前，Relay、Server 轮询和局域网入口都会保持关闭。",
    "start.listening": "Hermes Link API 正在监听 http://127.0.0.1:{port}",
    "start.relayConnecting": "正在为 {linkId} 连接 Relay 控制通道",
    "stop.description": "停止后台 Hermes Link 服务",
    "stop.stopped": "Hermes Link 已停止。",
    "stop.notRunning": "Hermes Link 没有在运行。",
    "restart.description": "重启后台 Hermes Link 服务",
    "deliver.description": "导入 Hermes Link 交付中转目录中的文件",
    "deliver.imported": "已向会话 {conversationId} 交付 {count} 个文件。",
    "deliver.none": "会话 {conversationId} 没有新的可交付文件。",
    "config.description": "管理本机 Hermes Link 配置",
    "config.set.description": "设置配置项",
    "config.unset.description": "清除配置项",
    "config.unknownKey": "未知配置项：{key}",
    "config.lanHostInvalid": "lan-host 必须是局域网 IPv4 地址，例如 192.168.1.23。",
    "config.lanHostSet": "已配置局域网主机：{value}",
    "config.lanHostUnset": "已清除局域网主机配置。",
    "config.logLevelInvalid": "log-level 只能是以下值之一：debug、info、warn、error。",
    "config.logLevelSet": "已配置日志级别：{value}",
    "config.logLevelUnset": "已将日志级别恢复为默认值：{value}。",
    "config.reported": "已把最新局域网地址更新到 HermesPilot Server。",
    "config.reportSkippedUnpaired": "Hermes Link 还没有配对，局域网地址会在配对后上报。",
    "daemon.description": "以前台方式运行 Hermes Link",
    "daemon.foreground": "Hermes Link 前台服务正在运行。按 Ctrl+C 停止。",
    "logs.description": "显示 Hermes Link 日志路径",
    "logs.servicePath": "服务日志：{path}",
    "logs.daemonPath": "Daemon 标准输出/错误日志：{path}",
    "autostart.description": "管理开机自启",
    "autostart.on.description": "启用开机自启",
    "autostart.off.description": "关闭开机自启",
    "autostart.status.description": "查看开机自启状态",
    "autostart.enabled": "已启用开机自启，方式：{method}，文件：{path}",
    "autostart.disabled": "已关闭开机自启。",
    "autostart.status.enabled": "开机自启：已启用，方式：{method}，文件：{path}",
    "autostart.status.disabled": "开机自启：未启用。方式：{method}，文件：{path}",
    "autostart.unsupported": "当前平台暂不支持开机自启。",
    "autostart.alreadyEnabled": "开机自启已启用，方式：{method}，文件：{path}",
    "pair.description": "创建 Hermes Link 配对会话",
    "pair.preflight": "正在配对前检查本机 Hermes 配置...",
    "pair.preflight.hermesFiles": "正在检查 Hermes 数据目录、配置文件和环境文件...",
    "pair.preflight.hermesCli": "正在检查 Hermes CLI 是否可用...",
    "pair.preflight.hermesApiServer": "正在检查 Hermes API Server 是否就绪...",
    "pair.hermesHome": "Hermes 数据目录：{path}",
    "pair.hermesVersion": "Hermes CLI：{value}",
    "pair.apiReady": "Hermes API Server 已就绪：127.0.0.1:{port}",
    "pair.preparing": "正在创建配对会话...",
    "pair.scan": "请在 HermesPilot App 中扫码下面的二维码：",
    "pair.openPairingPage": "如果二维码不容易扫描，你可以在本机打开这个页面：{url}",
    "pair.manualCode": "你也可以在 HermesPilot App 中使用手动连接模式，输入以下配对码进行连接：",
    "pair.expires": "配对会话 10 分钟后过期。按 Ctrl+C 退出等待。",
    "pair.expired": "配对会话已过期，请重新运行 `hermeslink pair`。",
    "pair.claimed": "配对已成功。正在把 Hermes Link 切换到后台运行...",
    "pair.claimedRunning": "配对已成功。Hermes Link 已在后台持续运行。",
    "pair.relayOnlyNotice":
      "网络提示：当前是 {kind} 环境，默认不会暴露手机可访问的局域网或公网直连地址。App 会通过 Relay 连接。",
    "pair.relayOnlyLanHostHint":
      "如果你已经在 Windows 或路由器侧手动把这个 Link 暴露到局域网，可以运行 `hermeslink config set lan-host <Windows 局域网 IP>` 更新可访问地址。",
    "pair.relayOnlySafetyHint":
      "Hermes Link 不会自动修改 Windows/WSL 桥接、防火墙或端口代理配置，因为这些属于系统级网络暴露设置。",
    "pair.autostartUnchanged": "检测到已有配对设备，开机自启设置保持不变。",
    "pair.autostartFailed": "配对已成功，但启用开机自启失败：{message}",
    "doctor.description": "运行本机诊断",
    "doctor.identityOk": "运行身份：正常",
    "doctor.installId": "Install ID：{value}",
    "doctor.linkId": "Link ID：{value}",
    "doctor.notAssigned": "尚未分配",
    "doctor.lanHost": "已配置局域网主机：{value}",
    "doctor.networkWarning": "网络提示：{message}",
    "doctor.hermesCli": "Hermes CLI：{value}",
    "doctor.hermesCliUnavailable": "Hermes CLI：不可用。请确认当前系统可以直接运行 `hermes` 命令。",
    "doctor.apiReady": "Hermes API Server：已就绪",
    "doctor.apiStarted": "Hermes API Server：已自动启动并就绪",
    "doctor.apiUnavailable": "Hermes API Server：不可用。{message}",
    "error.relayPublicKeyMismatch":
      "Relay 拒绝了配对请求：Server 签发的 bootstrap token 与本机 Link 公钥不匹配。请确认 Server 和 Relay 使用同一套 bootstrap key 配置，然后重新运行 `hermeslink pair`。",
    "error.relayChallengeInvalid": "Relay 没有返回有效的安装挑战。",
    "error.relayLinkInvalid": "Relay 没有返回有效的 link_id。",
    "error.relayEmpty": "Relay 返回了空响应。",
    "error.serverHttp": "HermesPilot Server 请求失败，HTTP 状态码：{status}。",
    "error.pairingServerUnreachable":
      "创建配对会话时无法连接 HermesPilot Server。请先确认 {url} 可以访问，然后重试。重点提醒：如果你使用了代理网络，可以把 hermes-server.clawpilot.me 和 hermes-relay.clawpilot.me 加入代理排除名单，或临时关闭 VPN/代理后再试。",
    "error.pairingRelayUnreachable":
      "创建配对会话时无法连接 Hermes Relay。请先确认 {url} 可以访问，然后重试。重点提醒：如果你使用了代理网络，可以把 hermes-server.clawpilot.me 和 hermes-relay.clawpilot.me 加入代理排除名单，或临时关闭 VPN/代理后再试。",
    "error.portInUse":
      "本地端口 {port} 已被其他进程占用。请先停止占用该端口的程序，或调整 Hermes Link 端口后重新运行 `hermeslink pair`。",
    "error.pairingRequires": "配对需要 HermesPilot Server 和 Relay，但当前命令没有能启动完整配对会话。",
    "error.pairingRequires.detail":
      "云端服务可以是已部署且健康的；本机 Link 仍必须先向 Server 申请短期 relay bootstrap token，才能再向 Relay 申请 link_id。",
  },
};

export function parseLanguage(value: unknown): Language | null {
  const normalized = (value as string | undefined)?.trim().replace("_", "-").toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "c" || normalized === "posix") {
    return null;
  }
  if (normalized.startsWith("zh")) {
    return "zh-CN";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  return null;
}

export function detectSystemLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const candidates = [
    env.HERMESLINK_LANG,
    env.HERMESLINK_LANGUAGE,
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
    env.LANGUAGE?.split(":")[0],
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];
  for (const candidate of candidates) {
    const language = parseLanguage(candidate);
    if (language) {
      return language;
    }
  }
  return "en";
}

export function resolveLanguage(setting: unknown): Language {
  const configured = parseLanguage(setting);
  if (configured) {
    return configured;
  }
  return detectSystemLanguage();
}

export function translate(language: Language, key: MessageKey, values: Record<string, unknown> = {}): string {
  const template = messages[language][key] ?? messages.en[key];
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => String(values[name] ?? ""));
}

export function localizeErrorMessage(error: unknown, language: Language): string {
  const message = error instanceof Error ? error.message : String(error);
  if (language === "en") {
    return message;
  }
  const mapped = translateKnownError(message, language);
  return mapped ?? message;
}

function translateKnownError(message: string, language: Language): string | null {
  if (message === "Relay bootstrap token does not match public key") {
    return translate(language, "error.relayPublicKeyMismatch");
  }
  if (message === "Relay did not return a valid install challenge") {
    return translate(language, "error.relayChallengeInvalid");
  }
  if (message === "Relay did not return a valid link_id") {
    return translate(language, "error.relayLinkInvalid");
  }
  if (message === "Relay returned an empty response") {
    return translate(language, "error.relayEmpty");
  }
  const portInUse = /^listen EADDRINUSE: address already in use .*:(?<port>\d+)$/u.exec(message);
  if (portInUse?.groups?.port) {
    return translate(language, "error.portInUse", { port: portInUse.groups.port });
  }
  const serverHttp = /^HermesPilot Server request failed with HTTP (?<status>\d+)$/u.exec(message);
  if (serverHttp?.groups?.status) {
    return translate(language, "error.serverHttp", { status: serverHttp.groups.status });
  }
  const pairingServerUnreachable =
    /^HermesPilot Server is unreachable while trying to [^.]+\. Please check whether (?<url>\S+) is reachable\./u.exec(
      message,
    );
  if (pairingServerUnreachable?.groups?.url) {
    return translate(language, "error.pairingServerUnreachable", {
      url: pairingServerUnreachable.groups.url,
    });
  }
  const pairingRelayUnreachable =
    /^Hermes Relay is unreachable while trying to [^.]+\. Please check whether (?<url>\S+) is reachable\./u.exec(
      message,
    );
  if (pairingRelayUnreachable?.groups?.url) {
    return translate(language, "error.pairingRelayUnreachable", {
      url: pairingRelayUnreachable.groups.url,
    });
  }
  if (message.includes("Pairing requires HermesPilot Server and Relay")) {
    return [translate(language, "error.pairingRequires"), translate(language, "error.pairingRequires.detail")].join(
      "\n",
    );
  }
  return null;
}
