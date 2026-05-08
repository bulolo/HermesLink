import { readFile, readdir } from "fs/promises";
import path from "path";
import YAML from "yaml";
import { atomicWriteFilePreservingMetadata } from "../storage/atomic-file.js";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import {
  resolveHermesConfigPath,
  resolveHermesProfileDir,
} from "./config.js";
import { getHermesProfileStatus, type HermesProfileStatus } from "./profile-status.js";

export class HermesSkillNotFoundError extends Error {
  constructor(skillName: string) {
    super(`skill "${skillName}" does not exist`);
    this.name = "HermesSkillNotFoundError";
  }
}

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const EXCLUDED_SKILL_DIRS = new Set([".git", ".github", ".hub"]);

interface SkillMetadata {
  name: string;
  category: string | null;
  description: string;
  enabled: boolean;
  source: string;
  trust: string | null;
  relativePath: string;
}

interface SkillProvenance {
  source: string;
  trust: string | null;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = toRecord(target[key]);
  if (current !== target[key]) {
    target[key] = current;
  }
  return current;
}

export async function listHermesProfileSkills(
  profileName: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<Record<string, unknown>> {
  const profile = await readExistingProfile(profileName, paths);
  const profileDir = resolveHermesProfileDir(profile.name);
  const skillsRoot = path.join(profileDir, "skills");

  const [skillFiles, disabled, provenance] = await Promise.all([
    findSkillFiles(skillsRoot),
    readDisabledSkillNames(resolveHermesConfigPath(profile.name)),
    readSkillProvenance(skillsRoot),
  ]);

  const seenNames = new Set<string>();
  const skills: SkillMetadata[] = [];

  for (const skillFile of skillFiles) {
    const skill = await readSkillMetadata({ skillFile, skillsRoot, disabled, provenance });
    if (!skill || seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    skills.push(skill);
  }

  skills.sort(compareSkills);

  return {
    ok: true,
    profile,
    skills,
    categories: summarizeCategories(skills),
  };
}

export async function setHermesProfileSkillEnabled(
  profileName: string,
  skillName: string,
  enabled: boolean,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<Record<string, unknown>> {
  const current = await listHermesProfileSkills(profileName, paths);
  const target = (current.skills as SkillMetadata[]).find((s) => s.name === skillName);
  if (!target) {
    throw new HermesSkillNotFoundError(skillName);
  }

  const configPath = resolveHermesConfigPath((current.profile as HermesProfileStatus).name);
  const { document, config, existingRaw } = await readHermesConfigDocumentLocal(configPath);

  const skillsConfig = ensureRecord(config, "skills");
  const disabledSet = new Set(readStringList(skillsConfig.disabled));

  if (enabled) {
    disabledSet.delete(target.name);
  } else {
    disabledSet.add(target.name);
  }

  skillsConfig.disabled = [...disabledSet].sort((a, b) => a.localeCompare(b));

  const backupPath = await writeHermesConfigDocumentLocal({ configPath, document, config, existingRaw });

  const updated = await listHermesProfileSkills((current.profile as HermesProfileStatus).name, paths);
  const skill = (updated.skills as SkillMetadata[]).find((s) => s.name === target.name);
  if (!skill) {
    throw new HermesSkillNotFoundError(target.name);
  }

  return { ...updated, skill, backupPath };
}

async function readExistingProfile(
  profileName: string,
  paths: RuntimePaths,
): Promise<HermesProfileStatus> {
  const profile = await getHermesProfileStatus(profileName, paths);
  if (!profile.exists && profile.name !== "default") {
    throw new Error("profile does not exist");
  }
  return profile;
}

async function findSkillFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  await collectSkillFiles(root, results);
  return results.sort((a, b) => a.localeCompare(b));
}

async function collectSkillFiles(directory: string, results: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED_SKILL_DIRS.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(entryPath, results);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(entryPath);
    }
  }
}

async function readSkillMetadata(input: {
  skillFile: string;
  skillsRoot: string;
  disabled: Set<string>;
  provenance: Map<string, SkillProvenance>;
}): Promise<SkillMetadata | null> {
  const raw = await readFile(input.skillFile, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "EACCES")) return null;
    throw error;
  });

  if (raw === null) return null;

  const skillDir = path.dirname(input.skillFile);
  const { frontmatter, body } = parseSkillDocument(raw.slice(0, 4000));
  const name = normalizeSkillName(readStr(frontmatter.name) ?? path.basename(skillDir));

  if (!name) return null;

  const description = normalizeDescription(readStr(frontmatter.description) ?? firstBodyDescription(body));
  const provenance = input.provenance.get(name) ?? { source: "local", trust: "local" };

  return {
    name,
    category: categoryFromPath(input.skillsRoot, input.skillFile),
    description,
    enabled: !input.disabled.has(name),
    source: provenance.source,
    trust: provenance.trust,
    relativePath: path.relative(input.skillsRoot, skillDir),
  };
}

function parseSkillDocument(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const content = raw.replace(/^﻿/u, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    return {
      frontmatter: toRecord(YAML.parse(match[1] ?? "")),
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function categoryFromPath(skillsRoot: string, skillFile: string): string | null {
  const relative = path.relative(skillsRoot, skillFile);
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.length >= 3 ? (parts[0] ?? null) : null;
}

function firstBodyDescription(body: string): string {
  for (const line of body.split(/\r?\n/u)) {
    const text = line.trim();
    if (text && !text.startsWith("#")) return text;
  }
  return "";
}

function normalizeSkillName(value: string): string {
  return value.trim().slice(0, MAX_SKILL_NAME_LENGTH);
}

function normalizeDescription(value: string): string {
  const description = value.trim().replace(/\s+/gu, " ");
  if (description.length <= MAX_DESCRIPTION_LENGTH) return description;
  return `${description.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
}

async function readDisabledSkillNames(configPath: string): Promise<Set<string>> {
  const raw = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  });

  if (!raw.trim()) return new Set();

  const config = toRecord(YAML.parse(raw));
  const skills = toRecord(config.skills);
  return new Set(readStringList(skills.disabled));
}

async function readSkillProvenance(root: string): Promise<Map<string, SkillProvenance>> {
  const provenance = new Map<string, SkillProvenance>();

  for (const name of await readBundledSkillNames(root)) {
    provenance.set(name, { source: "builtin", trust: "builtin" });
  }

  for (const [name, entry] of await readHubInstalledSkills(root)) {
    provenance.set(name, entry);
  }

  return provenance;
}

async function readBundledSkillNames(root: string): Promise<Set<string>> {
  const raw = await readFile(path.join(root, ".bundled_manifest"), "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  });

  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value) continue;
    const [name] = value.split(":", 1);
    const normalized = normalizeSkillName(name ?? "");
    if (normalized) names.add(normalized);
  }
  return names;
}

async function readHubInstalledSkills(root: string): Promise<Map<string, SkillProvenance>> {
  const raw = await readFile(path.join(root, ".hub", "lock.json"), "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  });

  if (!raw.trim()) return new Map();

  let lock: Record<string, unknown>;
  try {
    lock = toRecord(JSON.parse(raw) as unknown);
  } catch {
    return new Map();
  }

  const installed = toRecord(lock.installed);
  const result = new Map<string, SkillProvenance>();

  for (const [name, rawEntry] of Object.entries(installed)) {
    const entry = toRecord(rawEntry);
    result.set(normalizeSkillName(name), {
      source: readStr(entry.source) ?? "hub",
      trust: readStr(entry.trust_level) ?? null,
    });
  }

  return result;
}

function summarizeCategories(
  skills: SkillMetadata[],
): Array<{ name: string | null; label: string; total: number; enabled: number; disabled: number }> {
  const categories = new Map<
    string,
    { name: string | null; label: string; total: number; enabled: number; disabled: number }
  >();

  for (const skill of skills) {
    const key = skill.category ?? "";
    const current = categories.get(key) ?? {
      name: skill.category,
      label: skill.category ?? "未分类",
      total: 0,
      enabled: 0,
      disabled: 0,
    };
    current.total += 1;
    if (skill.enabled) {
      current.enabled += 1;
    } else {
      current.disabled += 1;
    }
    categories.set(key, current);
  }

  return [...categories.values()].sort(compareCategories);
}

function compareSkills(a: SkillMetadata, b: SkillMetadata): number {
  const category = compareCategoryNames(a.category, b.category);
  if (category !== 0) return category;
  return a.name.localeCompare(b.name);
}

function compareCategories(
  a: { name: string | null },
  b: { name: string | null },
): number {
  return compareCategoryNames(a.name, b.name);
}

function compareCategoryNames(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

async function readHermesConfigDocumentLocal(configPath: string): Promise<{
  document: ReturnType<typeof YAML.parseDocument>;
  config: Record<string, unknown>;
  existingRaw: string | null;
}> {
  const existingRaw = await readFile(configPath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  const document = existingRaw
    ? YAML.parseDocument(existingRaw)
    : new YAML.Document({});
  return {
    document,
    config: toRecord(document.toJSON() as unknown),
    existingRaw,
  };
}

async function writeHermesConfigDocumentLocal(input: {
  configPath: string;
  document: ReturnType<typeof YAML.parseDocument>;
  config: Record<string, unknown>;
  existingRaw: string | null;
}): Promise<string | null> {
  const backupPath = input.existingRaw ? `${input.configPath}.bak.${Date.now()}` : null;
  if (backupPath) {
    await atomicWriteFilePreservingMetadata(backupPath, input.existingRaw!, {
      metadataSourcePath: input.configPath,
    });
  }
  input.document.contents = input.document.createNode(input.config) as typeof input.document.contents;
  await atomicWriteFilePreservingMetadata(input.configPath, input.document.toString());
  return backupPath;
}
