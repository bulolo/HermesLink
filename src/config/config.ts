import { LINK_DEFAULT_PORT } from "../constants.js";
import { resolveRuntimePaths, type RuntimePaths } from "../runtime/paths.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Language = "auto" | "en" | "zh-CN";

export interface LinkConfig {
  port: number;
  lanHost: string | null;
  language: Language;
  logLevel: LogLevel;
}

const defaultLinkConfig: LinkConfig = {
  port: LINK_DEFAULT_PORT,
  lanHost: null,
  language: "auto",
  logLevel: "warn",
};

export async function loadConfig(paths: RuntimePaths = resolveRuntimePaths()): Promise<LinkConfig> {
  const existing = (await readJsonFile(paths.configFile)) as Partial<LinkConfig> | null;
  const language = normalizeConfiguredLanguage(existing?.language);
  const lanHost = normalizeLanHost(existing?.lanHost);
  const logLevel = normalizeLogLevel(existing?.logLevel ?? process.env.HERMESLINK_LOG_LEVEL);
  return {
    ...defaultLinkConfig,
    ...(existing ?? {}),
    language,
    lanHost,
    logLevel,
  };
}

export async function saveConfig(
  patch: Partial<LinkConfig>,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<LinkConfig> {
  const current = await loadConfig(paths);
  const next: LinkConfig = {
    ...current,
    ...patch,
    logLevel: patch.logLevel === undefined ? current.logLevel : normalizeLogLevel(patch.logLevel),
  };
  await writeJsonFile(paths.configFile, next);
  return next;
}

export function normalizeConfiguredLanguage(language: unknown): Language {
  if (language === "zh-CN" || language === "en" || language === "auto") {
    return language;
  }
  return defaultLinkConfig.language;
}

export function normalizeLogLevel(level: unknown): LogLevel {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  return defaultLinkConfig.logLevel;
}

export function parseLogLevel(value: unknown): LogLevel | null {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

export function normalizeLanHost(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const host = value.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  if (!host) return null;
  if (!isValidHostIpv4(host)) return null;
  return host;
}

function isValidHostIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [, , , fourth] = parts;
  // Reject network address and broadcast
  return fourth !== 0 && fourth !== 255;
}
