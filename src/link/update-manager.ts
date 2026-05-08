import { spawn } from "child_process";
import { EventEmitter } from "events";
import { mkdir, readFile, rm } from "fs/promises";
import path from "path";
import { type RuntimePaths } from "../runtime/paths.js";
import { createRotatingTextLogWriter } from "../runtime/logger.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";
import { LINK_VERSION, LINK_COMMAND } from "../constants.js";
import { checkForUpdates } from "./updates.js";

const LINK_NPM_PACKAGE = "@hermespilot/link";
const UPDATE_LOG_FILE2 = "link-update.log";
const UPDATE_LOG_MAX_FILES2 = 3;
const MAX_UPDATE_LOG_LINES2 = 240;
const MAX_OUTPUT_LINE_LENGTH3 = 1200;
const AUTO_RESTART_DELAY_MS = 1500;

const updateEvents2 = new EventEmitter();
let runningUpdate2: Promise<Record<string, unknown>> | null = null;

export async function readLinkUpdateCheck(options: {
  paths: RuntimePaths;
  logger?: unknown;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const update = await checkForUpdates({ paths: options.paths });
  const updateAvailable = update.availableVersion !== null && update.availableVersion !== update.currentVersion;

  return {
    ok: true,
    local: {
      version: LINK_VERSION,
      raw: LINK_VERSION,
    },
    remote: update.availableVersion
      ? {
          current_version: update.availableVersion,
          min_safe_version: null,
          target_version: update.availableVersion,
          release_url: null,
          published_at: null,
        }
      : null,
    state: updateAvailable ? "update_available" : "current",
    update_available: updateAvailable,
    unsafe: false,
    blocked: false,
    check_state: "cached",
    issue: null,
    manual: {
      command: update.availableVersion ? `npm install -g ${LINK_NPM_PACKAGE}@${update.availableVersion}` : null,
      package: LINK_NPM_PACKAGE,
      version: update.availableVersion ?? null,
    },
  };
}

export async function startLinkUpdate(options: {
  paths: RuntimePaths;
  logger?: {
    info?: (msg: string, fields?: Record<string, unknown>) => Promise<void> | void;
    error?: (msg: string, fields?: Record<string, unknown>) => Promise<void> | void;
    warn?: (msg: string, fields?: Record<string, unknown>) => Promise<void> | void;
  };
  targetVersion?: string | null;
}): Promise<Record<string, unknown>> {
  const current = await readLinkUpdateStatus(options.paths);
  if (runningUpdate2 || current.state === "running") {
    return current;
  }

  const check = await readLinkUpdateCheck(options);
  const targetVersion = (options.targetVersion ?? (check.remote as Record<string, unknown> | null)?.target_version ?? null) as string | null;

  if (!targetVersion) {
    return writeFailedStartState(options, "No target version available.", null);
  }

  if (check.state === "current") {
    return writeFailedStartState(options, "Hermes Link is already on the current version.", targetVersion);
  }

  const now = () => new Date();
  const jobId = `link_update_${now().getTime().toString(36)}`;

  await clearUpdateLogFiles2(options.paths);

  const writer = createRotatingTextLogWriter({
    paths: options.paths,
    fileName: UPDATE_LOG_FILE2,
    maxFileBytes: 512 * 1024,
    maxFiles: UPDATE_LOG_MAX_FILES2,
  });

  const startedAt = now().toISOString();
  const manualCommand = `npm install -g ${LINK_NPM_PACKAGE}@${targetVersion}`;

  const started: Record<string, unknown> = {
    state: "running",
    job_id: jobId,
    pid: null,
    target_version: targetVersion,
    started_at: startedAt,
    finished_at: null,
    exit_code: null,
    signal: null,
    error: null,
    manual_command: manualCommand,
  };

  await mkdir(options.paths.runDir, { recursive: true, mode: 0o700 });
  await writer.write(`\n=== link update started ${startedAt} target=${targetVersion} ===\n`);
  await writer.write(`$ ${manualCommand}\n`);
  await writeUpdateState2(options.paths, started);

  const child = spawn(resolveNpmBin(), ["install", "-g", `${LINK_NPM_PACKAGE}@${targetVersion}`], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
    shell: false,
  });

  started.pid = child.pid ?? null;
  await writeUpdateState2(options.paths, started);

  const appendChunk = async (chunk: Buffer | string) => {
    await writer.write(chunk);
    await emitUpdateStatus2(options.paths);
  };

  child.stdout?.on("data", (chunk: Buffer) => { void appendChunk(chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { void appendChunk(chunk); });

  runningUpdate2 = new Promise<Record<string, unknown>>((resolve) => {
    child.on("error", (error: Error) => {
      void (async () => {
        const failed = {
          ...started,
          state: "failed",
          finished_at: now().toISOString(),
          error: error.message,
        };
        await writer.write(`\n[failed] link update failed to start: ${error.message}\n`);
        await writeUpdateState2(options.paths, failed);
        await emitUpdateStatus2(options.paths);
        void options.logger?.error?.("link_update_spawn_failed", { job_id: jobId, target_version: targetVersion, error: error.message });
        resolve(await readLinkUpdateStatus(options.paths));
      })();
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      void (async () => {
        const succeeded = code === 0;
        const state = {
          ...started,
          state: succeeded ? "restart_required" : "failed",
          finished_at: now().toISOString(),
          exit_code: code,
          signal,
          error: succeeded ? null : `npm install exited with code ${code ?? "unknown"}`,
        };
        await writer.write(
          `\n=== link update finished ${state.finished_at} exit=${code ?? "null"} signal=${signal ?? "null"} ===\n`,
        );
        if (succeeded) {
          await writer.write(
            `\n[restart-scheduled] Hermes Link will restart automatically. If it does not reconnect, run \`${LINK_COMMAND} restart\` on this computer.\n`,
          );
        }
        await writeUpdateState2(options.paths, state);
        await emitUpdateStatus2(options.paths);
        if (succeeded) {
          await writer.flush();
          scheduleAutomaticRestart(options);
        }
        void options.logger?.info?.(succeeded ? "link_update_restart_required" : "link_update_failed", {
          job_id: jobId,
          target_version: targetVersion,
          exit_code: code,
          signal: signal ?? null,
        });
        resolve(await readLinkUpdateStatus(options.paths));
      })();
    });
  }).finally(() => {
    runningUpdate2 = null;
  }) as Promise<Record<string, unknown>>;

  await emitUpdateStatus2(options.paths);
  void options.logger?.info?.("link_update_started", { job_id: jobId, pid: child.pid ?? null, target_version: targetVersion, log_path: writer.filePath });

  return readLinkUpdateStatus(options.paths);
}

export async function readLinkUpdateStatus(paths: RuntimePaths): Promise<Record<string, unknown>> {
  let state = (await readJsonFile(updateStatePath2(paths))) as Record<string, unknown> | null;

  if (state?.state === "restart_required" && state.target_version) {
    if (compareSemver(LINK_VERSION, state.target_version as string) >= 0) {
      state = {
        ...state,
        state: "succeeded",
        finished_at: state.finished_at ?? new Date().toISOString(),
      };
      await writeUpdateState2(paths, state);
    }
  }

  if (
    state?.state === "running" &&
    !runningUpdate2 &&
    !isRecentRunningState3(state) &&
    !isProcessAlive4(state.pid as number | null)
  ) {
    state = {
      ...state,
      state: "failed",
      finished_at: new Date().toISOString(),
      error: (state.error as string | null) ?? "Link update was interrupted before Hermes Link could observe completion.",
    };
    await writeUpdateState2(paths, state);
  }

  return {
    ok: true,
    state: state?.state ?? "idle",
    job_id: state?.job_id ?? null,
    pid: state?.pid ?? null,
    target_version: state?.target_version ?? null,
    started_at: state?.started_at ?? null,
    finished_at: state?.finished_at ?? null,
    exit_code: state?.exit_code ?? null,
    signal: state?.signal ?? null,
    log_path: updateLogPath2(paths),
    lines: await readUpdateLogLines2(paths),
    error: state?.error ?? null,
    manual_command: state?.manual_command ?? null,
  };
}

export function subscribeLinkUpdateStatus(
  listener: (status: Record<string, unknown>) => void,
): () => void {
  updateEvents2.on("status", listener);
  return () => updateEvents2.off("status", listener);
}

function scheduleAutomaticRestart(options: {
  paths: RuntimePaths;
  logger?: { info?: (msg: string, fields?: Record<string, unknown>) => Promise<void> | void };
}) {
  setTimeout(() => {
    const child = spawn(process.execPath, [currentCliScriptPath(), "restart"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    void options.logger?.info?.("link_update_restart_scheduled", {
      delay_ms: AUTO_RESTART_DELAY_MS,
      command: `${LINK_COMMAND} restart`,
    });
  }, AUTO_RESTART_DELAY_MS).unref();
}

function currentCliScriptPath(): string {
  // Try to find the CLI entry point
  return process.argv[1] ?? "hermeslink";
}

async function writeFailedStartState(
  options: { paths: RuntimePaths },
  error: string,
  targetVersion: string | null,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const state = {
    state: "failed",
    job_id: `link_update_${now.getTime().toString(36)}`,
    pid: null,
    target_version: targetVersion,
    started_at: now.toISOString(),
    finished_at: now.toISOString(),
    exit_code: null,
    signal: null,
    error,
    manual_command: targetVersion ? `npm install -g ${LINK_NPM_PACKAGE}@${targetVersion}` : null,
  };
  await writeUpdateState2(options.paths, state);
  await emitUpdateStatus2(options.paths);
  return readLinkUpdateStatus(options.paths);
}

async function emitUpdateStatus2(paths: RuntimePaths): Promise<void> {
  updateEvents2.emit("status", await readLinkUpdateStatus(paths));
}

async function writeUpdateState2(paths: RuntimePaths, state: Record<string, unknown>): Promise<void> {
  await writeJsonFile(updateStatePath2(paths), state);
}

async function readUpdateLogLines2(paths: RuntimePaths): Promise<string[]> {
  const raw = await readFile(updateLogPath2(paths), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-MAX_UPDATE_LOG_LINES2)
    .map((line) => (line.length > MAX_OUTPUT_LINE_LENGTH3 ? `${line.slice(0, MAX_OUTPUT_LINE_LENGTH3)}...` : line));
}

function updateStatePath2(paths: RuntimePaths): string {
  return path.join(paths.runDir, "link-update-state.json");
}

function updateLogPath2(paths: RuntimePaths): string {
  return path.join(paths.logsDir, UPDATE_LOG_FILE2);
}

async function clearUpdateLogFiles2(paths: RuntimePaths): Promise<void> {
  const primary = updateLogPath2(paths);
  await Promise.all([
    rm(primary, { force: true }).catch(() => undefined),
    ...Array.from({ length: UPDATE_LOG_MAX_FILES2 }, (_, index) =>
      rm(`${primary}.${index + 1}`, { force: true }).catch(() => undefined),
    ),
  ]);
}

function resolveNpmBin(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function compareSemver(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let i = 0; i < 3; i++) {
    const diff = leftParts[i] - rightParts[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  return [
    parseInt(match?.[1] ?? "0", 10),
    parseInt(match?.[2] ?? "0", 10),
    parseInt(match?.[3] ?? "0", 10),
  ];
}

function isRecentRunningState3(state: Record<string, unknown>, now = Date.now()): boolean {
  const startedAt = state.started_at ? Date.parse(state.started_at as string) : Number.NaN;
  return Number.isFinite(startedAt) && now - startedAt < 10_000;
}

function isProcessAlive4(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
