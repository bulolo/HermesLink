import { mkdir, readFile, stat } from "fs/promises";
import path from "path";
import { atomicWriteFilePreservingMetadata } from "../storage/atomic-file.js";
import { LinkHttpError } from "../core/errors.js";
import { resolveHermesProfileDir, resolveHermesConfigPath } from "./config.js";
import YAML from "yaml";

const ENTRY_DELIMITER = "\n§\n";
const DEFAULT_MEMORY_LIMIT = 2200;
const DEFAULT_USER_LIMIT = 1375;

export class HermesMemoryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function resolveMemoryDir(profileName: string): string {
  return path.join(resolveHermesProfileDir(profileName), "memories");
}

function memoryFilePath(profileName: string, target: "user" | "memory"): string {
  return path.join(resolveMemoryDir(profileName), target === "user" ? "USER.md" : "MEMORY.md");
}

async function readMemoryEntries(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  });
  if (!raw.trim()) return [];
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

async function readMemoryLimits(profileName: string): Promise<{ memory: number; user: number }> {
  const raw = await readFile(resolveHermesConfigPath(profileName), "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  });
  const config = (raw ? YAML.parse(raw) : {}) as Record<string, unknown>;
  const memory = (config.memory ?? {}) as Record<string, unknown>;
  const toPositiveInt = (v: unknown) => (typeof v === "number" && v > 0 && Number.isInteger(v) ? v : null);
  return {
    memory: toPositiveInt(memory.memory_char_limit) ?? DEFAULT_MEMORY_LIMIT,
    user: toPositiveInt(memory.user_char_limit) ?? DEFAULT_USER_LIMIT,
  };
}

function limitForTarget(limits: { memory: number; user: number }, target: "user" | "memory" | "all"): number {
  return target === "user" ? limits.user : limits.memory;
}

function assertWithinLimit(target: "user" | "memory", entries: string[], limits: { memory: number; user: number }): void {
  const limit = limitForTarget(limits, target);
  const chars = entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
  if (chars > limit) {
    throw new HermesMemoryError("memory_limit_exceeded", `记忆内容超过 ${limit} 字符上限，请先缩短或删除部分条目。`);
  }
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 31 + value.charCodeAt(i)) >>> 0);
  }
  return hash.toString(16);
}

async function readMemoryStore(
  profileName: string,
  target: "user" | "memory",
  limits: { memory: number; user: number },
): Promise<Record<string, unknown>> {
  const filePath = memoryFilePath(profileName, target);
  const entries = await readMemoryEntries(filePath);
  const fileStat = await stat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  const chars = entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
  const limit = limitForTarget(limits, target);
  return {
    target,
    label: target === "user" ? "关于用户" : "Agent 笔记",
    description: target === "user" ? "用户偏好、沟通方式、长期身份信息。" : "环境事实、项目约定、工具习惯和长期经验。",
    fileName: target === "user" ? "USER.md" : "MEMORY.md",
    path: filePath,
    exists: fileStat !== null,
    updatedAt: (fileStat as { mtime: Date } | null)?.mtime.toISOString() ?? null,
    entries: entries.map((content, index) => ({
      id: `${target}_${index}_${hashString(content)}`,
      content,
    })),
    entryCount: entries.length,
    usage: {
      chars,
      limit,
      percent: limit > 0 ? Math.min(100, Math.floor((chars / limit) * 100)) : 0,
    },
  };
}

export async function readHermesProfileMemory(profileName = "default"): Promise<Record<string, unknown>> {
  const memoryDir = resolveMemoryDir(profileName);
  const limits = await readMemoryLimits(profileName);
  const [memoryStore, userStore] = await Promise.all([
    readMemoryStore(profileName, "memory", limits),
    readMemoryStore(profileName, "user", limits),
  ]);
  return {
    ok: true,
    profileName,
    memoryDir,
    stores: [userStore, memoryStore],
    settings: { provider: "built-in" },
    notice: "记忆修改会写入当前 Profile 的磁盘文件；已经启动的会话通常要到新会话才会完整读取最新快照。",
  };
}

async function writeMemoryEntries(profileName: string, target: "user" | "memory", entries: string[]): Promise<void> {
  const limits = await readMemoryLimits(profileName);
  assertWithinLimit(target, entries, limits);
  const filePath = memoryFilePath(profileName, target);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await atomicWriteFilePreservingMetadata(filePath, entries.join(ENTRY_DELIMITER));
}

function normalizeEntryContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw new HermesMemoryError("memory_content_empty", "记忆内容不能为空。");
  return normalized;
}

function normalizeNeedle(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new HermesMemoryError("memory_match_empty", "匹配内容不能为空。");
  return normalized;
}

function findSingleMatch(entries: string[], needle: string): number {
  const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(needle));
  if (matches.length === 0) throw new HermesMemoryError("memory_entry_not_found", "没有找到匹配的记忆条目。");
  if (new Set(matches.map(({ entry }) => entry)).size > 1) throw new HermesMemoryError("memory_entry_ambiguous", "有多条记忆匹配这个片段，请输入更具体的内容后再试。");
  return matches[0].index;
}

function assertMemoryTarget(target: unknown): asserts target is "user" | "memory" {
  if (target !== "user" && target !== "memory") throw new HermesMemoryError("memory_invalid_target", 'target must be "user" or "memory"');
}

function assertResetTarget(target: unknown): asserts target is "user" | "memory" | "all" {
  if (target !== "user" && target !== "memory" && target !== "all") throw new HermesMemoryError("memory_invalid_target", 'target must be "user", "memory", or "all"');
}

async function mutateMemoryEntries(profileName: string, target: "user" | "memory", mutate: (entries: string[]) => string[]): Promise<void> {
  const current = await readMemoryEntries(memoryFilePath(profileName, target));
  await writeMemoryEntries(profileName, target, mutate([...new Set(current)]));
}

export function readMemoryTarget(body: unknown): "user" | "memory" {
  const target = (body as Record<string, unknown>)?.target;
  assertMemoryTarget(target);
  return target;
}

export function readRequiredMemoryContent(body: unknown): string {
  const content = (body as Record<string, unknown>)?.content;
  if (typeof content !== "string") throw new HermesMemoryError("memory_content_required", "content (string) is required");
  return content;
}

export function readRequiredMemoryMatch(body: unknown): string {
  const match = (body as Record<string, unknown>)?.match;
  if (typeof match !== "string") throw new HermesMemoryError("memory_match_required", "match (string) is required");
  return match;
}

export function readMemoryResetTarget(body: unknown): "user" | "memory" | "all" {
  const target = (body as Record<string, unknown>)?.target ?? "all";
  assertResetTarget(target);
  return target;
}

export function readMemorySettingsPatch(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  return body as Record<string, unknown>;
}

export async function addHermesMemoryEntry(profileName: string, target: "user" | "memory", content: string): Promise<Record<string, unknown>> {
  const normalized = normalizeEntryContent(content);
  await mutateMemoryEntries(profileName, target, (entries) => {
    if (entries.includes(normalized)) return entries;
    return [...entries, normalized];
  });
  return readHermesProfileMemory(profileName);
}

export async function replaceHermesMemoryEntry(profileName: string, target: "user" | "memory", oldText: string, content: string): Promise<Record<string, unknown>> {
  const needle = normalizeNeedle(oldText);
  const normalized = normalizeEntryContent(content);
  await mutateMemoryEntries(profileName, target, (entries) => {
    const index = findSingleMatch(entries, needle);
    const next = [...entries];
    next[index] = normalized;
    return next;
  });
  return readHermesProfileMemory(profileName);
}

export async function removeHermesMemoryEntry(profileName: string, target: "user" | "memory", oldText: string): Promise<Record<string, unknown>> {
  const needle = normalizeNeedle(oldText);
  await mutateMemoryEntries(profileName, target, (entries) => {
    const index = findSingleMatch(entries, needle);
    return entries.filter((_, i) => i !== index);
  });
  return readHermesProfileMemory(profileName);
}

export async function resetHermesMemoryStore(profileName: string, target: "user" | "memory" | "all"): Promise<Record<string, unknown>> {
  if (target === "all") {
    await Promise.all([
      writeMemoryEntries(profileName, "memory", []),
      writeMemoryEntries(profileName, "user", []),
    ]);
  } else {
    await writeMemoryEntries(profileName, target, []);
  }
  return readHermesProfileMemory(profileName);
}

export async function saveHermesMemorySettings(_profileName: string, _patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  throw new HermesMemoryError("memory_settings_builtin_only", "当前 Profile 使用 built-in memory，没有可保存的外部 provider 设置。");
}

export async function saveHermesMemoryProviderSettings(_profileName: string, _provider: string, _patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  throw new HermesMemoryError("memory_settings_builtin_only", "当前 Profile 使用 built-in memory，没有可保存的外部 provider 设置。");
}

export async function setHermesMemoryProvider(_profileName: string, _provider: unknown): Promise<Record<string, unknown>> {
  throw new HermesMemoryError("memory_provider_builtin_only", "当前仅支持 built-in memory provider。");
}

export function toMemoryHttpError(error: unknown): LinkHttpError {
  if (error instanceof HermesMemoryError) {
    return new LinkHttpError(400, error.code, error.message);
  }
  if (error instanceof LinkHttpError) return error;
  const msg = error instanceof Error ? error.message : String(error);
  return new LinkHttpError(500, "internal_error", msg);
}
