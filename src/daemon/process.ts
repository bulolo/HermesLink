import { execFile, spawn } from "child_process";
import { mkdir, readFile, writeFile, rm } from "fs/promises";
import { setTimeout as sleep } from "timers/promises";
import path from "path";
import { promisify } from "util";
import { DAEMON_LOG_FILE } from "../constants.js";
import { createRotatingTextLogWriter } from "../runtime/logger.js";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { currentCliScriptPath } from "../autostart/autostart.js";

const execFileAsync = promisify(execFile);

export type DaemonState = "running" | "stopped" | "unknown";

export interface DaemonStatus {
  state: DaemonState;
  pid: number | null;
}

export interface ProbeResult {
  reachable: boolean;
  statusCode?: number;
}

function pidFilePath(paths: RuntimePaths): string {
  return path.join(paths.homeDir, "daemon.pid");
}

async function readPid(paths: RuntimePaths): Promise<number | null> {
  try {
    const raw = await readFile(pidFilePath(paths), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function writePid(paths: RuntimePaths, pid: number): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await writeFile(pidFilePath(paths), String(pid), { mode: 0o600 });
}

async function clearPid(paths: RuntimePaths): Promise<void> {
  await rm(pidFilePath(paths), { force: true }).catch(() => undefined);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms: number): Promise<void> {
  return sleep(ms);
}

export async function getDaemonStatus(paths?: RuntimePaths): Promise<DaemonStatus> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const pid = await readPid(runtimePaths);
  if (pid === null) {
    return { state: "stopped", pid: null };
  }
  if (isProcessAlive(pid)) {
    return { state: "running", pid };
  }
  await clearPid(runtimePaths);
  return { state: "stopped", pid: null };
}

export async function probeLocalLinkService(options: {
  port: number;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(`http://127.0.0.1:${options.port}/api/v1/system/status`, {
      signal: AbortSignal.timeout(3000),
    });
    return { reachable: true, statusCode: response.status };
  } catch {
    return { reachable: false };
  }
}

export async function startDaemonProcess(options: {
  paths?: RuntimePaths;
}): Promise<void> {
  const paths = options.paths ?? resolveRuntimePaths();
  const status = await getDaemonStatus(paths);
  if (status.state === "running") return;

  const child = spawn(
    process.execPath,
    [currentCliScriptPath(), "daemon-supervisor"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  // Wait up to 3 seconds for daemon to write its PID
  for (let i = 0; i < 6; i++) {
    await wait(500);
    const newStatus = await getDaemonStatus(paths);
    if (newStatus.state === "running") return;
  }
}

export async function stopDaemonProcess(options: {
  paths?: RuntimePaths;
  timeoutMs?: number;
}): Promise<void> {
  const paths = options.paths ?? resolveRuntimePaths();
  const timeoutMs = options.timeoutMs ?? 5000;
  const status = await getDaemonStatus(paths);
  if (status.state !== "running" || status.pid === null) return;

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    await clearPid(paths);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(200);
    if (!isProcessAlive(status.pid)) {
      await clearPid(paths);
      return;
    }
  }

  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // ignore
  }
  await clearPid(paths);
}

export async function runDaemonSupervisor(options: {
  paths?: RuntimePaths;
  port?: number;
}): Promise<void> {
  const paths = options.paths ?? resolveRuntimePaths();
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await writePid(paths, process.pid);

  const logWriter = createRotatingTextLogWriter({ paths, fileName: DAEMON_LOG_FILE });

  const cleanup = async () => {
    await clearPid(paths).catch(() => undefined);
    await logWriter.flush().catch(() => undefined);
  };

  process.once("SIGTERM", () => {
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.once("SIGINT", () => {
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  const runDaemon = () =>
    new Promise<number>((resolve) => {
      const args = [currentCliScriptPath(), "daemon", "--foreground"];
      if (options.port) {
        args.push("--port", String(options.port));
      }
      const child = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        logWriter.write(chunk).catch(() => undefined);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        logWriter.write(chunk).catch(() => undefined);
      });

      child.once("exit", (code) => {
        resolve(code ?? 1);
      });
      child.once("error", () => {
        resolve(1);
      });
    });

  // Supervisor loop: restart on crash with backoff
  let consecutiveFastExits = 0;
  while (true) {
    const startTime = Date.now();
    const code = await runDaemon();
    const elapsed = Date.now() - startTime;

    if (code === 0) {
      // Clean exit — stop supervising
      break;
    }

    if (elapsed < 2000) {
      consecutiveFastExits++;
    } else {
      consecutiveFastExits = 0;
    }

    if (consecutiveFastExits >= 5) {
      // Too many fast crashes — give up
      break;
    }

    const backoffMs = Math.min(1000 * consecutiveFastExits, 5000);
    await wait(backoffMs);
  }

  await cleanup();
}
