import { spawn } from "child_process";
import { EventEmitter } from "events";
import { mkdir, readFile, rm } from "fs/promises";
import path from "path";
import { type RuntimePaths } from "../runtime/paths.js";
import { createRotatingTextLogWriter } from "../runtime/logger.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";
import { resolveHermesBin } from "./cli.js";
import { readHermesVersion } from "./gateway.js";

const UPDATE_LOG_FILE = "hermes-update.log";
const UPDATE_LOG_MAX_FILES = 3;
const MAX_UPDATE_LOG_LINES = 240;
const MAX_OUTPUT_LINE_LENGTH = 1200;

const updateEvents = new EventEmitter();
let runningUpdate: Promise<Record<string, unknown>> | null = null;

export async function readHermesUpdateCheck(options: {
  paths: RuntimePaths;
  logger?: unknown;
  refreshRemote?: boolean;
}): Promise<Record<string, unknown>> {
  const version = await readHermesVersion(null).catch(() => null);
  return {
    ok: true,
    local: {
      version: version ?? null,
      raw: version ?? null,
    },
    remote: null,
    update_available: false,
    check_state: "unavailable",
    issue: "Remote Hermes release check is not available in local-only mode",
  };
}

export async function startHermesUpdate(options: {
  paths: RuntimePaths;
  logger?: { info?: (msg: string, fields?: Record<string, unknown>) => Promise<void> | void; error?: (msg: string, fields?: Record<string, unknown>) => Promise<void> | void };
}): Promise<Record<string, unknown>> {
  const current = await readHermesUpdateStatus(options.paths);
  if (runningUpdate || current.state === "running") {
    return current;
  }

  const now = () => new Date();
  const jobId = `hermes_update_${now().getTime().toString(36)}`;

  await clearUpdateLogFiles(options.paths);

  const writer = createRotatingTextLogWriter({
    paths: options.paths,
    fileName: UPDATE_LOG_FILE,
    maxFileBytes: 512 * 1024,
    maxFiles: UPDATE_LOG_MAX_FILES,
  });

  const startedAt = now().toISOString();
  const started: Record<string, unknown> = {
    state: "running",
    job_id: jobId,
    pid: null,
    started_at: startedAt,
    finished_at: null,
    exit_code: null,
    signal: null,
    error: null,
  };

  await mkdir(options.paths.runDir, { recursive: true, mode: 0o700 });
  await writer.write(`\n=== hermes update started ${startedAt} ===\n`);
  await writeUpdateState(options.paths, started);

  const child = spawn(resolveHermesBin(), ["update"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HERMES_NONINTERACTIVE: "1" },
    windowsHide: true,
    detached: false,
  });

  started.pid = child.pid ?? null;

  const appendChunk = async (chunk: Buffer | string) => {
    await writer.write(chunk);
    await emitUpdateStatus(options.paths);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    void appendChunk(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    void appendChunk(chunk);
  });

  runningUpdate = new Promise<Record<string, unknown>>((resolve) => {
    child.on("error", (error: Error) => {
      void (async () => {
        const failed = {
          ...started,
          state: "failed",
          finished_at: now().toISOString(),
          error: error.message,
        };
        await writer.write(`\n[failed] hermes update failed to start: ${error.message}\n`);
        await writeUpdateState(options.paths, failed);
        await emitUpdateStatus(options.paths);
        void options.logger?.error?.("hermes_update_spawn_failed", { job_id: jobId, error: error.message });
        resolve(await readHermesUpdateStatus(options.paths));
      })();
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      void (async () => {
        const state = {
          ...started,
          state: code === 0 ? "succeeded" : "failed",
          finished_at: now().toISOString(),
          exit_code: code,
          signal,
          error: code === 0 ? null : `hermes update exited with code ${code ?? "unknown"}`,
        };
        await writer.write(
          `\n=== hermes update finished ${state.finished_at} exit=${code ?? "null"} signal=${signal ?? "null"} ===\n`,
        );
        await writeUpdateState(options.paths, state);
        await emitUpdateStatus(options.paths);
        void options.logger?.info?.(code === 0 ? "hermes_update_succeeded" : "hermes_update_failed", {
          job_id: jobId,
          exit_code: code,
          signal: signal ?? null,
        });
        resolve(await readHermesUpdateStatus(options.paths));
      })();
    });
  }).finally(() => {
    runningUpdate = null;
  }) as Promise<Record<string, unknown>>;

  await emitUpdateStatus(options.paths);
  void options.logger?.info?.("hermes_update_started", {
    job_id: jobId,
    pid: child.pid ?? null,
    log_path: writer.filePath,
  });

  return readHermesUpdateStatus(options.paths);
}

export async function readHermesUpdateStatus(paths: RuntimePaths): Promise<Record<string, unknown>> {
  let state = (await readJsonFile(updateStatePath(paths))) as Record<string, unknown> | null;

  if (
    state?.state === "running" &&
    !runningUpdate &&
    !isRecentRunningState(state) &&
    !isProcessAlive(state.pid as number | null)
  ) {
    state = {
      ...state,
      state: "failed",
      finished_at: new Date().toISOString(),
      error: (state.error as string | null) ?? "Hermes update was interrupted before Link could observe completion.",
    };
    await writeUpdateState(paths, state);
  }

  const lines = await readUpdateLogLines(paths);

  return {
    ok: true,
    state: state?.state ?? "idle",
    job_id: state?.job_id ?? null,
    pid: state?.pid ?? null,
    started_at: state?.started_at ?? null,
    finished_at: state?.finished_at ?? null,
    exit_code: state?.exit_code ?? null,
    signal: state?.signal ?? null,
    log_path: updateLogPath(paths),
    lines,
    error: state?.error ?? null,
  };
}

export function subscribeHermesUpdateStatus(
  listener: (status: Record<string, unknown>) => void,
): () => void {
  updateEvents.on("status", listener);
  return () => updateEvents.off("status", listener);
}

async function emitUpdateStatus(paths: RuntimePaths): Promise<void> {
  updateEvents.emit("status", await readHermesUpdateStatus(paths));
}

async function writeUpdateState(paths: RuntimePaths, state: Record<string, unknown>): Promise<void> {
  await writeJsonFile(updateStatePath(paths), state);
}

async function readUpdateLogLines(paths: RuntimePaths): Promise<string[]> {
  const raw = await readFile(updateLogPath(paths), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-MAX_UPDATE_LOG_LINES)
    .map((line) => (line.length > MAX_OUTPUT_LINE_LENGTH ? `${line.slice(0, MAX_OUTPUT_LINE_LENGTH)}...` : line));
}

function updateStatePath(paths: RuntimePaths): string {
  return path.join(paths.runDir, "hermes-update-state.json");
}

function updateLogPath(paths: RuntimePaths): string {
  return path.join(paths.logsDir, UPDATE_LOG_FILE);
}

async function clearUpdateLogFiles(paths: RuntimePaths): Promise<void> {
  const primary = updateLogPath(paths);
  await Promise.all([
    rm(primary, { force: true }).catch(() => undefined),
    ...Array.from({ length: UPDATE_LOG_MAX_FILES }, (_, index) =>
      rm(`${primary}.${index + 1}`, { force: true }).catch(() => undefined),
    ),
  ]);
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRecentRunningState(state: Record<string, unknown>): boolean {
  if (!state.started_at) return false;
  const startedAt = Date.parse(state.started_at as string);
  return Number.isFinite(startedAt) && Date.now() - startedAt < 30_000;
}
