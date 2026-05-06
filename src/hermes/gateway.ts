import { execFile, spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { promisify } from "util";
import {
  DEFAULT_HERMES_API_SERVER_HOST,
  DEFAULT_HERMES_API_SERVER_PORT,
  MIN_API_SERVER_VERSION,
} from "../constants.js";
import { createFileLogger, createRotatingTextLogWriter } from "../runtime/logger.js";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { GATEWAY_LOG_FILE } from "../constants.js";
import {
  ensureHermesApiServerConfig,
  isValidProfileName,
  readHermesApiServerConfig,
  resolveHermesProfilesDir,
} from "./config.js";
import { resolveHermesBin, profileArgs } from "./cli.js";
import { readdir } from "fs/promises";

const execFileAsync = promisify(execFile);

export interface HermesApiServerInfo {
  enabled: boolean;
  host: string;
  port: number;
  apiKey?: string;
}

export interface HermesVersionInfo {
  version: string;
  supportsApiServer: boolean;
}

export interface HermesApiHealth {
  ok: boolean;
  version?: string;
}

const gatewayStartInFlightByProfile = new Map<string, Promise<void>>();
const hermesVersionCache = new Map<string, { version: string; ts: number }>();
const VERSION_CACHE_TTL_MS = 30_000;

export function normalizeProfileName(profileName: string | null | undefined): string {
  if (!profileName || profileName.trim() === "") return "default";
  return profileName.trim();
}

export async function listHermesProfiles(): Promise<string[]> {
  try {
    const profilesDir = resolveHermesProfilesDir();
    const entries = await readdir(profilesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isValidProfileName(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export async function assertProfileExists(profileName: string): Promise<void> {
  const normalized = normalizeProfileName(profileName);
  if (normalized === "default") return;
  const profiles = await listHermesProfiles();
  if (!profiles.includes(normalized)) {
    const err = new Error(`Profile "${normalized}" does not exist`);
    (err as NodeJS.ErrnoException).code = "PROFILE_NOT_FOUND";
    throw err;
  }
}

export async function readHermesVersion(
  profileName?: string | null,
): Promise<string | null> {
  const profile = normalizeProfileName(profileName);
  const cached = hermesVersionCache.get(profile);
  if (cached && Date.now() - cached.ts < VERSION_CACHE_TTL_MS) {
    return cached.version;
  }
  return probeHermesVersion(profile);
}

async function probeHermesVersion(profile: string): Promise<string | null> {
  try {
    const bin = resolveHermesBin();
    const args = [...profileArgs(profile), "--version"];
    const { stdout } = await execFileAsync(bin, args, { timeout: 5000 });
    const version = stdout.trim().split(/\s+/u).pop() ?? null;
    if (version) {
      hermesVersionCache.set(profile, { version, ts: Date.now() });
    }
    return version;
  } catch {
    return null;
  }
}

export function assertHermesRunsApiSupported(version: string | null): void {
  if (!version) return;
  const parts = version.split(".").map((v) => Number.parseInt(v, 10));
  const minParts = MIN_API_SERVER_VERSION.split(".").map((v) => Number.parseInt(v, 10));
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (a > b) return;
    if (a < b) {
      throw new Error(
        `Hermes version ${version} does not support the API server. Minimum required: ${MIN_API_SERVER_VERSION}`,
      );
    }
  }
}

export async function readHermesApiServerHealth(options: {
  host: string;
  port: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<HermesApiHealth> {
  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`http://${options.host}:${options.port}/api/health`, {
      headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const version = typeof body?.version === "string" ? body.version : undefined;
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

async function waitForHermesApiHealth(options: {
  host: string;
  port: number;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const health = await readHermesApiServerHealth(options);
    if (health.ok) return true;
    await sleep(500);
  }
  return false;
}

function extractApiServerInfo(raw: Record<string, unknown>): HermesApiServerInfo {
  const apiServer = raw.apiServer as Record<string, unknown> | null | undefined ?? {};
  return {
    enabled: apiServer.enabled === true,
    host: typeof apiServer.host === "string" ? apiServer.host : DEFAULT_HERMES_API_SERVER_HOST,
    port: typeof apiServer.port === "number" ? apiServer.port : DEFAULT_HERMES_API_SERVER_PORT,
    apiKey: typeof apiServer.key === "string" ? apiServer.key : undefined,
  };
}

export async function startHermesGateway(options: {
  profileName?: string | null;
  paths?: RuntimePaths;
}): Promise<void> {
  const profile = normalizeProfileName(options.profileName);
  const inFlight = gatewayStartInFlightByProfile.get(profile);
  if (inFlight) return inFlight;
  const promise = doStartHermesGateway({ ...options, profileName: profile }).finally(() => {
    gatewayStartInFlightByProfile.delete(profile);
  });
  gatewayStartInFlightByProfile.set(profile, promise);
  return promise;
}

async function doStartHermesGateway(options: {
  profileName: string;
  paths?: RuntimePaths;
}): Promise<void> {
  const paths = options.paths ?? resolveRuntimePaths();
  const raw = await ensureHermesApiServerConfig(options.profileName);
  const config = extractApiServerInfo(raw);
  if (!config.enabled) return;

  const health = await readHermesApiServerHealth({
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
  });
  if (health.ok) return;

  const version = await readHermesVersion(options.profileName);
  assertHermesRunsApiSupported(version);

  const bin = resolveHermesBin();
  const spawnArgs = [
    ...profileArgs(options.profileName),
    "api-server",
    "--host",
    config.host,
    "--port",
    String(config.port),
  ];

  const logger = createFileLogger({ paths });
  const logWriter = createRotatingTextLogWriter({ paths, fileName: GATEWAY_LOG_FILE });

  await logger.info("Starting Hermes API server gateway", {
    profile: options.profileName,
    bin,
  });

  const child = spawn(bin, spawnArgs, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    logWriter.write(chunk).catch(() => undefined);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logWriter.write(chunk).catch(() => undefined);
  });
  child.once("error", (err: Error) => {
    logger.error("Hermes gateway process error", { error: String(err) }).catch(() => undefined);
  });
  child.unref();

  const ready = await waitForHermesApiHealth({
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
    timeoutMs: 15_000,
  });

  if (!ready) {
    await logger.warn("Hermes API server did not become healthy in time", {
      profile: options.profileName,
    });
  }
}

export async function ensureHermesApiServerAvailable(options: {
  profileName?: string | null;
  paths?: RuntimePaths;
  fetchImpl?: typeof fetch;
}): Promise<HermesApiServerInfo> {
  const profile = normalizeProfileName(options.profileName);
  const raw = await ensureHermesApiServerConfig(profile);
  const config = extractApiServerInfo(raw);

  const health = await readHermesApiServerHealth({
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
    fetchImpl: options.fetchImpl,
  });

  if (!health.ok) {
    await startHermesGateway({ profileName: profile, paths: options.paths });
  }

  return config;
}

export async function reloadHermesGateway(options: {
  profileName?: string | null;
  paths?: RuntimePaths;
}): Promise<void> {
  const profile = normalizeProfileName(options.profileName);
  const raw = await readHermesApiServerConfig(profile).catch(() => null);
  if (!raw) return;
  const config = extractApiServerInfo(raw);
  if (!config.enabled) return;

  try {
    await fetch(`http://${config.host}:${config.port}/api/reload`, {
      method: "POST",
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    await startHermesGateway(options);
  }
}
