import { appendFile, mkdir, open, readFile, rename, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import pino from "pino";
import { DAEMON_LOG_FILE, DEFAULT_LOG_FILE, GATEWAY_LOG_FILE } from "../constants.js";
import { type RuntimePaths, resolveRuntimePaths } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1000;
const DEFAULT_MAX_BYTES_PER_FILE = 512 * 1024;

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LinkLogger {
  debug(message: string, fields?: Record<string, unknown>): Promise<void>;
  info(message: string, fields?: Record<string, unknown>): Promise<void>;
  warn(message: string, fields?: Record<string, unknown>): Promise<void>;
  error(message: string, fields?: Record<string, unknown>): Promise<void>;
  flush(): Promise<void>;
}

class FileLogger implements LinkLogger {
  readonly filePath: string;
  private readonly paths: RuntimePaths;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly minLevel: LogLevel;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: {
    paths?: RuntimePaths;
    fileName?: string;
    maxFileBytes?: number;
    maxFiles?: number;
    minLevel?: LogLevel;
    now?: () => Date;
  } = {}) {
    this.paths = options.paths ?? resolveRuntimePaths();
    this.filePath = getLinkLogFile(this.paths, options.fileName);
    this.maxFileBytes = Math.max(256, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
    this.maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
    this.minLevel = options.minLevel ?? "warn";
    this.now = options.now ?? (() => new Date());
  }

  debug(message: string, fields?: Record<string, unknown>): Promise<void> {
    return this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): Promise<void> {
    return this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): Promise<void> {
    return this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): Promise<void> {
    return this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): Promise<void> {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return Promise.resolve();
    }
    const entry = {
      ts: this.now().toISOString(),
      level,
      message,
      ...(fields ? { fields: sanitizeFields(fields) } : {}),
    };
    const next = this.queue
      .then(() => this.appendEntry(entry))
      .catch(() => undefined);
    this.queue = next;
    return next;
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private async appendEntry(entry: object): Promise<void> {
    await mkdir(this.paths.logsDir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(entry)}\n`;
    await rotateLogFileIfNeeded(this.filePath, Buffer.byteLength(line, "utf8"), this.maxFileBytes, this.maxFiles);
    await appendFile(this.filePath, line, { mode: 0o600 });
  }
}

export function createFileLogger(
  options: {
    paths?: RuntimePaths;
    fileName?: string;
    maxFileBytes?: number;
    maxFiles?: number;
    minLevel?: LogLevel;
  } = {},
): LinkLogger {
  return new FileLogger(options);
}

export function getLinkLogFile(
  paths: RuntimePaths = resolveRuntimePaths(),
  fileName: string = DEFAULT_LOG_FILE,
): string {
  return path.join(paths.logsDir, fileName);
}

export function getDaemonLogFile(paths: RuntimePaths = resolveRuntimePaths()): string {
  return getLinkLogFile(paths, DAEMON_LOG_FILE);
}

export function getGatewayRuntimeLogFile(paths: RuntimePaths = resolveRuntimePaths()): string {
  return getLinkLogFile(paths, GATEWAY_LOG_FILE);
}

export function getGatewayLogFiles(paths: RuntimePaths = resolveRuntimePaths()): string[] {
  const runtimeGatewayLog = getGatewayRuntimeLogFile(paths);
  const effectiveHome =
    path.basename(paths.homeDir) === ".hermeslink" ? path.dirname(paths.homeDir) : os.homedir();
  const hermesGatewayErrorLog = path.join(effectiveHome, ".hermes", "logs", "gateway.error.log");
  return Array.from(new Set([runtimeGatewayLog, hermesGatewayErrorLog]));
}

export interface RotatingTextLogWriter {
  filePath: string;
  write(chunk: string | Buffer): Promise<void>;
  flush(): Promise<void>;
}

export function createRotatingTextLogWriter(
  options: {
    paths?: RuntimePaths;
    fileName: string;
    maxFileBytes?: number;
    maxFiles?: number;
  },
): RotatingTextLogWriter {
  const paths = options.paths ?? resolveRuntimePaths();
  const filePath = getLinkLogFile(paths, options.fileName);
  const maxFileBytes = Math.max(256, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  let queue: Promise<void> = Promise.resolve();
  return {
    filePath,
    write(chunk: string | Buffer): Promise<void> {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      if (buffer.length === 0) {
        return queue;
      }
      const next = queue
        .then(async () => {
          await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
          await rotateLogFileIfNeeded(filePath, buffer.length, maxFileBytes, maxFiles);
          await appendFile(filePath, buffer, { mode: 0o600 });
        })
        .catch(() => undefined);
      queue = next;
      return next;
    },
    flush(): Promise<void> {
      return queue;
    },
  };
}

export interface LogEntry {
  ts: string | null;
  level: string;
  message: string;
  timestampSource?: "structured" | "embedded" | "file_mtime";
  fields?: Record<string, unknown>;
}

export async function readRecentLogEntries(
  options: {
    paths?: RuntimePaths;
    fileName?: string;
    limit?: number;
    maxFiles?: number;
    maxBytesPerFile?: number;
  } = {},
): Promise<LogEntry[]> {
  const paths = options.paths ?? resolveRuntimePaths();
  const filePath = getLinkLogFile(paths, options.fileName);
  const limit = clampLimit(options.limit);
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxBytesPerFile = Math.max(1024, Math.floor(options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE));
  const files = [
    filePath,
    ...Array.from({ length: maxFiles }, (_, index) => rotatedLogFile(filePath, index + 1)),
  ];
  const entries: LogEntry[] = [];
  for (const file of files) {
    const raw = await readTail(file, maxBytesPerFile);
    if (!raw) continue;
    const lines = raw.split(/\r?\n/u).filter(Boolean);
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const entry = parseLogLine(lines[index]);
      if (entry) entries.push(entry);
    }
    if (entries.length >= limit) break;
  }
  return entries.reverse();
}

export async function readRecentTextLogEntries(
  options: {
    paths?: RuntimePaths;
    fileName?: string;
    filePaths?: string[];
    limit?: number;
    maxFiles?: number;
    maxBytesPerFile?: number;
  } = {},
): Promise<LogEntry[]> {
  const paths = options.paths ?? resolveRuntimePaths();
  const primaryFiles = options.filePaths ?? [getLinkLogFile(paths, options.fileName)];
  const limit = clampLimit(options.limit);
  const maxFiles = Math.max(0, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
  const maxBytesPerFile = Math.max(1024, Math.floor(options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE));
  const files = primaryFiles.flatMap((filePath) => [
    filePath,
    ...Array.from({ length: maxFiles }, (_, index) => rotatedLogFile(filePath, index + 1)),
  ]);
  const entries: LogEntry[] = [];
  for (const file of files) {
    const tail = await readTailWithMetadata(file, maxBytesPerFile);
    if (!tail) continue;
    const lines = tail.content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      entries.push(parseTextLogLine(lines[index], tail.modifiedAt));
    }
    if (entries.length >= limit) break;
  }
  return entries.reverse();
}

export function readRecentGatewayLogEntries(
  options: {
    paths?: RuntimePaths;
    filePaths?: string[];
    limit?: number;
    maxFiles?: number;
    maxBytesPerFile?: number;
  } = {},
): Promise<LogEntry[]> {
  const paths = options.paths ?? resolveRuntimePaths();
  return readRecentTextLogEntries({
    ...options,
    paths,
    filePaths: options.filePaths ?? getGatewayLogFiles(paths),
  });
}

export function createLogger(options: {
  paths?: RuntimePaths;
  fileName?: string;
  level?: LogLevel;
}): pino.Logger {
  const paths = options.paths ?? resolveRuntimePaths();
  const logFile = getLinkLogFile(paths, options.fileName);
  return pino({ level: options.level ?? "warn" }, pino.destination({ dest: logFile, sync: false, mkdir: true }));
}

function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(value)));
}

async function rotateLogFileIfNeeded(
  filePath: string,
  nextBytes: number,
  maxFileBytes: number,
  maxFiles: number,
): Promise<void> {
  const current = await stat(filePath).catch(() => null);
  if (!current || current.size === 0 || current.size + nextBytes <= maxFileBytes) return;
  if (maxFiles === 0) {
    await rm(filePath, { force: true }).catch(() => undefined);
    return;
  }
  await rm(rotatedLogFile(filePath, maxFiles), { force: true }).catch(() => undefined);
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    await moveIfExists(rotatedLogFile(filePath, index), rotatedLogFile(filePath, index + 1));
  }
  await moveIfExists(filePath, rotatedLogFile(filePath, 1));
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(fields, 0);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
  if (Array.isArray(value)) {
    if (depth >= 3) return "[array]";
    return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    if (depth >= 3) return "[object]";
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    if (isSensitiveKey(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitizeValue(child, depth);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /(authorization|cookie|token|secret|password|private[_-]?key|api[_-]?key)/iu.test(key);
}

function parseLogLine(line: string): LogEntry | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!value || typeof value.ts !== "string" || !isLogLevel(value.level) || typeof value.message !== "string") {
      return null;
    }
    return {
      ts: value.ts,
      level: value.level as string,
      message: value.message,
      timestampSource: "structured",
      ...(value.fields && typeof value.fields === "object" ? { fields: value.fields as Record<string, unknown> } : {}),
    };
  } catch {
    return null;
  }
}

function parseTextLogLine(line: string, fallbackTimestamp: string | null): LogEntry {
  const embeddedTimestamp = readTimestampFromTextLog(line);
  return {
    ts: embeddedTimestamp ?? fallbackTimestamp ?? null,
    level: inferTextLogLevel(line),
    message: line,
    ...(embeddedTimestamp
      ? { timestampSource: "embedded" as const }
      : fallbackTimestamp
        ? { timestampSource: "file_mtime" as const }
        : {}),
  };
}

function readTimestampFromTextLog(line: string): string | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u.exec(line);
  if (iso) return iso[0];
  const bracketed = /^\[?(?<value>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]?/u.exec(line);
  if (!bracketed?.groups?.value) return null;
  const parsed = new Date(bracketed.groups.value.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function inferTextLogLevel(line: string): string {
  if (/\b(error|fatal|traceback|failed|failure)\b/iu.test(line)) return "error";
  if (/\b(warn|warning)\b/iu.test(line)) return "warn";
  if (/\b(debug|trace)\b/iu.test(line)) return "debug";
  return "info";
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

async function readTail(filePath: string, maxBytes: number): Promise<string | null> {
  const tail = await readTailWithMetadata(filePath, maxBytes);
  return tail?.content ?? null;
}

async function readTailWithMetadata(
  filePath: string,
  maxBytes: number,
): Promise<{ content: string; modifiedAt: string } | null> {
  const info = await stat(filePath).catch(() => null);
  if (!info || info.size <= 0) return null;
  const modifiedAt = info.mtime.toISOString();
  if (info.size <= maxBytes) {
    const content = await readFile(filePath, "utf8").catch(() => null);
    return content === null ? null : { content, modifiedAt };
  }
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return { content: buffer.toString("utf8"), modifiedAt };
  } finally {
    await handle.close();
  }
}

async function moveIfExists(from: string, to: string): Promise<void> {
  await rm(to, { force: true }).catch(() => undefined);
  await rename(from, to).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function rotatedLogFile(filePath: string, index: number): string {
  return `${filePath}.${index}`;
}
