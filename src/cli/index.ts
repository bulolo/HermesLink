#!/usr/bin/env node
import { mkdir } from "fs/promises";
import path from "path";
import qrcode from "qrcode-terminal";
import { LINK_COMMAND, LINK_VERSION, LINK_DEFAULT_PORT } from "../constants.js";
import { loadConfig, saveConfig } from "../config/config.js";
import { ensureIdentity, getIdentityStatus, loadIdentity, saveAssignedLinkId } from "../identity/identity.js";
import { resolveRuntimePaths } from "../runtime/paths.js";
import { resolveLanguage, translate, detectSystemLanguage } from "../i18n.js";
import { enableAutostart, disableAutostart, getAutostartStatus } from "../autostart/autostart.js";
import { discoverLanIps } from "../network/topology.js";
import { detectRuntimeEnvironment } from "../network/environment.js";
import {
  getDaemonStatus,
  startDaemonProcess,
  stopDaemonProcess,
  runDaemonSupervisor,
  probeLocalLinkService,
} from "../daemon/process.js";
import { bootstrapWithRelay } from "../relay/bootstrap.js";
import { startLinkService } from "../http/app.js";
import { runPairingPreflight } from "../pairing/preflight.js";
import { normalizeLanHost } from "../config/config.js";
import { readRecentLogEntries, readRecentGatewayLogEntries } from "../runtime/logger.js";
import { checkForUpdates } from "../link/updates.js";

const args = process.argv.slice(2);
const command = args[0];

function hasFlag(...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

function getFlagValue(...flags: string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (flags.includes(args[i])) return args[i + 1];
  }
  return null;
}

async function main(): Promise<void> {
  if (hasFlag("--version", "-v")) {
    process.stdout.write(`${LINK_VERSION}\n`);
    return;
  }

  if (!command || hasFlag("--help", "-h")) {
    printHelp();
    return;
  }

  const paths = resolveRuntimePaths();
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });

  switch (command) {
    case "start":
      await cmdStart(paths);
      break;
    case "stop":
      await cmdStop(paths);
      break;
    case "status":
      await cmdStatus(paths);
      break;
    case "restart":
      await cmdStop(paths);
      await cmdStart(paths);
      break;
    case "daemon":
      await cmdDaemon(paths);
      break;
    case "daemon-supervisor":
      await cmdDaemonSupervisor(paths);
      break;
    case "pair":
      await cmdPair(paths);
      break;
    case "config":
      await cmdConfig(paths);
      break;
    case "logs":
      await cmdLogs(paths);
      break;
    case "autostart":
      await cmdAutostart(paths);
      break;
    case "version":
      process.stdout.write(`${LINK_VERSION}\n`);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

async function cmdStart(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const status = await getDaemonStatus(paths);
  if (status.state === "running") {
    process.stdout.write(`Hermes Link is already running (PID ${status.pid}).\n`);
    return;
  }
  await startDaemonProcess({ paths });
  process.stdout.write("Hermes Link started.\n");
}

async function cmdStop(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const status = await getDaemonStatus(paths);
  if (status.state !== "running") {
    process.stdout.write("Hermes Link is not running.\n");
    return;
  }
  await stopDaemonProcess({ paths });
  process.stdout.write("Hermes Link stopped.\n");
}

async function cmdStatus(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const config = await loadConfig(paths);
  const daemonStatus = await getDaemonStatus(paths);
  const probe = await probeLocalLinkService({ port: config.port });
  const identity = await loadIdentity(paths).catch(() => null);
  const autostartStatus = await getAutostartStatus();
  const env = detectRuntimeEnvironment();

  process.stdout.write(`Hermes Link ${LINK_VERSION}\n`);
  process.stdout.write(`Daemon:    ${daemonStatus.state}${daemonStatus.pid ? ` (PID ${daemonStatus.pid})` : ""}\n`);
  process.stdout.write(`HTTP:      ${probe.reachable ? `reachable on port ${config.port}` : `not reachable`}\n`);
  process.stdout.write(`Link ID:   ${identity?.link_id ?? "unassigned"}\n`);
  process.stdout.write(`Autostart: ${autostartStatus.enabled ? "enabled" : "disabled"} (${autostartStatus.method})\n`);
  process.stdout.write(`Env:       ${env.kind}\n`);
  if (env.warning) process.stdout.write(`Warning:   ${env.warning}\n`);
}

async function cmdDaemon(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  if (!hasFlag("--foreground")) {
    process.stderr.write("Use 'hermeslink start' or 'hermeslink daemon-supervisor'\n");
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(paths);
  const identity = await ensureIdentity(paths);

  // Bootstrap relay if needed
  let relayToken = "";
  try {
    const bootstrapResult = await bootstrapWithRelay({
      relayBaseUrl: config.relayBaseUrl,
      identity,
      port: config.port,
    });
    if (!identity.link_id) {
      await saveAssignedLinkId(bootstrapResult.linkId, paths);
    }
    relayToken = bootstrapResult.token;
  } catch (err) {
    process.stderr.write(`Warning: Relay bootstrap failed: ${(err as Error).message}\n`);
  }

  const service = await startLinkService({ config, identity, paths, relayToken });

  process.stdout.write(`Hermes Link running on port ${config.port}\n`);

  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

async function cmdDaemonSupervisor(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const config = await loadConfig(paths);
  await runDaemonSupervisor({ paths, port: config.port });
}

async function cmdPair(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const config = await loadConfig(paths);
  const identity = await ensureIdentity(paths);
  if (!identity.link_id) {
    process.stderr.write("Error: Hermes Link is not connected to relay. Run 'hermeslink start' first.\n");
    process.exitCode = 1;
    return;
  }
  const result = await runPairingPreflight({ identity, config, paths });
  process.stdout.write("\n");
  qrcode.generate(result.pairingUrl, { small: true });
  process.stdout.write(`\nPairing URL:   ${result.pairingUrl}\n`);
  process.stdout.write(`Connect token: ${result.connectToken}\n`);
}

async function cmdConfig(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "get") {
    const config = await loadConfig(paths);
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return;
  }
  if (subcommand === "set") {
    const key = args[2];
    const value = args[3];
    if (!key || value === undefined) {
      process.stderr.write("Usage: hermeslink config set <key> <value>\n");
      process.exitCode = 1;
      return;
    }
    await applyConfigSet(key, value, paths);
    return;
  }
  process.stderr.write("Usage: hermeslink config [get|set]\n");
  process.exitCode = 1;
}

async function applyConfigSet(key: string, value: string, paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  switch (key) {
    case "port": {
      const port = Number.parseInt(value, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        process.stderr.write("Invalid port number\n");
        process.exitCode = 1;
        return;
      }
      await saveConfig({ port }, paths);
      process.stdout.write(`Port set to ${port}\n`);
      break;
    }
    case "lan-host": {
      const lanHost = normalizeLanHost(value) ?? null;
      await saveConfig({ lanHost }, paths);
      process.stdout.write(`LAN host set to ${lanHost ?? "(auto)"}\n`);
      break;
    }
    case "language": {
      const lang = value as "auto" | "en" | "zh-CN";
      await saveConfig({ language: lang }, paths);
      process.stdout.write(`Language set to ${lang}\n`);
      break;
    }
    case "log-level": {
      const level = value as "debug" | "info" | "warn" | "error";
      await saveConfig({ logLevel: level }, paths);
      process.stdout.write(`Log level set to ${level}\n`);
      break;
    }
    default:
      process.stderr.write(`Unknown config key: ${key}\n`);
      process.exitCode = 1;
  }
}

async function cmdLogs(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const isGateway = hasFlag("--gateway");
  const limit = getFlagValue("--limit", "-n");
  const limitNum = limit ? Number.parseInt(limit, 10) : 50;
  const entries = isGateway
    ? await readRecentGatewayLogEntries({ paths, limit: limitNum })
    : await readRecentLogEntries({ paths, limit: limitNum });
  for (const entry of entries) {
    const ts = entry.ts ? new Date(entry.ts).toLocaleString() : "??";
    process.stdout.write(`[${ts}] ${entry.level.toUpperCase()} ${entry.message}\n`);
  }
}

async function cmdAutostart(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const subcommand = args[1];
  if (subcommand === "enable") {
    const status = await enableAutostart();
    process.stdout.write(`Autostart ${status.enabled ? "enabled" : "could not be enabled"} (${status.method})\n`);
    return;
  }
  if (subcommand === "disable") {
    const status = await disableAutostart();
    process.stdout.write(`Autostart ${status.enabled ? "still enabled" : "disabled"} (${status.method})\n`);
    return;
  }
  const status = await getAutostartStatus();
  process.stdout.write(`Autostart: ${status.enabled ? "enabled" : "disabled"} (${status.method})\n`);
}

function printHelp(): void {
  process.stdout.write(`Hermes Link ${LINK_VERSION} — Local service for Hermes Agent

Usage: ${LINK_COMMAND} <command> [options]

Commands:
  start              Start the Hermes Link daemon
  stop               Stop the Hermes Link daemon
  restart            Restart the daemon
  status             Show daemon and service status
  pair               Generate a pairing URL for your device
  config get         Show current configuration
  config set         Set a configuration value
  autostart          Show/enable/disable autostart
  logs               Show recent log entries (--gateway for gateway logs)
  version            Print version

Options:
  --version, -v      Print version
  --help, -h         Show this help
`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
});
