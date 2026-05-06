import { execFile } from "child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const MACOS_LABEL = "com.hermes.link";

export type AutostartMethod = "launchd" | "systemd-user" | "xdg-autostart" | "windows-startup" | "unsupported";

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  method: AutostartMethod;
  filePath: string | null;
}

interface AutostartDefinition {
  method: AutostartMethod;
  filePath: string;
  content: string;
}

export async function enableAutostart(): Promise<AutostartStatus> {
  const definition = await resolveAutostartDefinition();
  if (!definition) {
    return unsupportedStatus();
  }
  await mkdir(path.dirname(definition.filePath), { recursive: true, mode: 0o700 });
  await writeFile(definition.filePath, definition.content, { mode: 0o600 });
  if (definition.method === "systemd-user") {
    await execFileAsync("systemctl", ["--user", "enable", path.basename(definition.filePath)]).catch(async () => {
      await rm(definition.filePath, { force: true }).catch(() => undefined);
      const fallback = xdgAutostartDefinition();
      await mkdir(path.dirname(fallback.filePath), { recursive: true, mode: 0o700 });
      await writeFile(fallback.filePath, fallback.content, { mode: 0o600 });
    });
  }
  return getAutostartStatus();
}

export async function disableAutostart(): Promise<AutostartStatus> {
  const definitions = await allAutostartDefinitions();
  for (const definition of definitions) {
    if (definition.method === "systemd-user") {
      await execFileAsync("systemctl", ["--user", "disable", path.basename(definition.filePath)]).catch(() => undefined);
    }
    await rm(definition.filePath, { force: true }).catch(() => undefined);
  }
  return getAutostartStatus();
}

export async function getAutostartStatus(): Promise<AutostartStatus> {
  const definitions = await allAutostartDefinitions();
  if (definitions.length === 0) {
    return unsupportedStatus();
  }
  for (const definition of definitions) {
    const content = await readFile(definition.filePath, "utf8").catch(() => null);
    if (content !== null) {
      return {
        supported: true,
        enabled: true,
        method: definition.method,
        filePath: definition.filePath,
      };
    }
  }
  const primary = definitions[0];
  return {
    supported: true,
    enabled: false,
    method: primary.method,
    filePath: primary.filePath,
  };
}

async function resolveAutostartDefinition(): Promise<AutostartDefinition | null> {
  if (process.platform === "darwin") {
    return launchdDefinition();
  }
  if (process.platform === "win32") {
    return windowsStartupDefinition();
  }
  if (process.platform === "linux") {
    return (await hasSystemctlUser()) ? systemdUserDefinition() : xdgAutostartDefinition();
  }
  return null;
}

async function allAutostartDefinitions(): Promise<AutostartDefinition[]> {
  if (process.platform === "darwin") {
    return [launchdDefinition()];
  }
  if (process.platform === "win32") {
    return [windowsStartupDefinition()];
  }
  if (process.platform === "linux") {
    return [systemdUserDefinition(), xdgAutostartDefinition()];
  }
  return [];
}

async function hasSystemctlUser(): Promise<boolean> {
  try {
    await execFileAsync("systemctl", ["--user", "show-environment"]);
    return true;
  } catch {
    return false;
  }
}

function launchdDefinition(): AutostartDefinition {
  const filePath = path.join(os.homedir(), "Library", "LaunchAgents", `${MACOS_LABEL}.plist`);
  return {
    method: "launchd",
    filePath,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(currentCliScriptPath())}</string>
    <string>daemon-supervisor</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`,
  };
}

function systemdUserDefinition(): AutostartDefinition {
  const filePath = path.join(os.homedir(), ".config", "systemd", "user", "hermeslink.service");
  return {
    method: "systemd-user",
    filePath,
    content: `[Unit]
Description=Hermes Link
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(currentCliScriptPath())} daemon-supervisor
Restart=no

[Install]
WantedBy=default.target
`,
  };
}

function xdgAutostartDefinition(): AutostartDefinition {
  const filePath = path.join(os.homedir(), ".config", "autostart", "hermeslink.desktop");
  return {
    method: "xdg-autostart",
    filePath,
    content: `[Desktop Entry]
Type=Application
Name=Hermes Link
Exec=${desktopQuote(process.execPath)} ${desktopQuote(currentCliScriptPath())} daemon-supervisor
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  };
}

function windowsStartupDefinition(): AutostartDefinition {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const filePath = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "HermesLink.cmd",
  );
  return {
    method: "windows-startup",
    filePath,
    content: `@echo off\r\nstart "" /min "${process.execPath}" "${currentCliScriptPath()}" daemon-supervisor\r\n`,
  };
}

function unsupportedStatus(): AutostartStatus {
  return { supported: false, enabled: false, method: "unsupported", filePath: null };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function desktopQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function currentCliScriptPath(): string {
  return process.argv[1];
}
