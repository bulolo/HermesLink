import { readdir, rename, rm, stat } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { LinkHttpError } from "../core/errors.js";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { openSqliteDatabase } from "../storage/sqlite.js";
import {
  isValidProfileName,
  listHermesModelConfigs,
  readHermesApiServerConfig,
  resolveHermesConfigPath,
  resolveHermesProfileDir,
} from "./config.js";
import { listHermesProfiles } from "./gateway.js";

export interface HermesProfileStatus {
  uid: string;
  name: string;
  active: boolean;
  path: string;
  configPath: string;
  displayName: string | null;
  description: string | null;
  avatarType: string;
  avatarUrl: string | null;
  exists: boolean;
  apiKeyConfigured: boolean;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

interface ProfileRow {
  profile_uid: string;
  profile_name: string;
  profile_path: string;
  display_name: string | null;
  description: string | null;
  avatar_type: string;
  avatar_url: string | null;
}

function ensureProfileIdentitySync(
  paths: RuntimePaths,
  profileName: string,
  profilePath: string,
): { uid: string; displayName: string | null; description: string | null; avatarType: string; avatarUrl: string | null } {
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  try {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM profile_registry WHERE profile_name = ?").get(profileName) as ProfileRow | undefined;
    if (existing) {
      db.prepare("UPDATE profile_registry SET profile_path = ?, updated_at = ? WHERE profile_uid = ?")
        .run(profilePath, now, existing.profile_uid);
      return {
        uid: existing.profile_uid,
        displayName: existing.display_name,
        description: existing.description,
        avatarType: existing.avatar_type ?? "default",
        avatarUrl: existing.avatar_url,
      };
    }
    const uid = `prof_${randomUUID().replace(/-/g, "")}`;
    db.prepare("INSERT INTO profile_registry (profile_uid, profile_name, profile_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(uid, profileName, profilePath, now, now);
    return { uid, displayName: null, description: null, avatarType: "default", avatarUrl: null };
  } finally {
    db.close();
  }
}

export async function getHermesProfileStatus(
  name: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<HermesProfileStatus> {
  if (!isValidProfileName(name)) {
    throw new LinkHttpError(400, "invalid_profile_name", "invalid profile name");
  }

  const profilePath = resolveHermesProfileDir(name);
  const configPath = resolveHermesConfigPath(name);

  const exists = await stat(profilePath)
    .then((s) => s.isDirectory())
    .catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    });

  const config = await readHermesApiServerConfig(name, configPath).catch(() => ({} as Record<string, unknown>));
  const identity = ensureProfileIdentitySync(paths, name, profilePath);

  return {
    uid: identity.uid,
    name,
    active: false,
    path: profilePath,
    configPath,
    displayName: identity.displayName,
    description: identity.description,
    avatarType: identity.avatarType,
    avatarUrl: identity.avatarUrl,
    exists,
    apiKeyConfigured: Boolean(config.key),
  };
}

export async function updateHermesProfileMetadata(
  name: string,
  metadata: { displayName?: string | null; description?: string | null; avatarType?: "default" | "url"; avatarUrl?: string | null },
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<HermesProfileStatus> {
  if (!isValidProfileName(name)) {
    throw new LinkHttpError(400, "invalid_profile_name", "invalid profile name");
  }
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  try {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT profile_uid FROM profile_registry WHERE profile_name = ?").get(name) as { profile_uid: string } | undefined;
    if (!existing) throw new LinkHttpError(404, "profile_not_found", `Profile "${name}" not found`);
    const updates: string[] = [];
    const params: unknown[] = [];
    if ("displayName" in metadata) { updates.push("display_name = ?"); params.push(metadata.displayName ?? null); }
    if ("description" in metadata) { updates.push("description = ?"); params.push(metadata.description ?? null); }
    if ("avatarType" in metadata) { updates.push("avatar_type = ?"); params.push(metadata.avatarType ?? "default"); }
    if (metadata.avatarType === "default") { updates.push("avatar_url = NULL"); }
    else if ("avatarUrl" in metadata) { updates.push("avatar_url = ?"); params.push(metadata.avatarUrl ?? null); }
    if (updates.length > 0) {
      db.prepare(`UPDATE profile_registry SET ${updates.join(", ")}, updated_at = ? WHERE profile_name = ?`).run(...params, now, name);
    }
  } finally {
    db.close();
  }
  return getHermesProfileStatus(name, paths);
}

export async function renameHermesProfile(
  oldName: string,
  newName: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<HermesProfileStatus> {
  if (oldName === "default") throw new LinkHttpError(400, "default_profile_not_mutable", "default profile cannot be renamed or deleted");
  if (!isValidProfileName(oldName)) throw new LinkHttpError(400, "invalid_profile_name", "invalid old profile name");
  if (!isValidProfileName(newName)) throw new LinkHttpError(400, "invalid_profile_name", "invalid new profile name");
  const oldPath = resolveHermesProfileDir(oldName);
  const newPath = resolveHermesProfileDir(newName);
  await rename(oldPath, newPath);
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  try {
    const now = new Date().toISOString();
    db.prepare("UPDATE profile_registry SET profile_name = ?, profile_path = ?, updated_at = ? WHERE profile_name = ?")
      .run(newName, newPath, now, oldName);
  } finally {
    db.close();
  }
  return getHermesProfileStatus(newName, paths);
}

export async function deleteHermesProfile(
  name: string,
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<HermesProfileStatus> {
  if (name === "default") throw new LinkHttpError(400, "default_profile_not_mutable", "default profile cannot be renamed or deleted");
  if (!isValidProfileName(name)) throw new LinkHttpError(400, "invalid_profile_name", "invalid profile name");
  const profile = await getHermesProfileStatus(name, paths);
  if (!profile.exists) throw new LinkHttpError(404, "profile_not_found", `Profile "${name}" does not exist`);
  await rm(profile.path, { recursive: true, force: true });
  const db = openSqliteDatabase(paths.databaseFile, { timeout: 5000 });
  try {
    db.prepare("DELETE FROM profile_registry WHERE profile_name = ?").run(name);
  } finally {
    db.close();
  }
  return profile;
}

export async function readHermesProfileCapabilities(
  name: string,
): Promise<{ defaultModel: string | null; modelCount: number; skillCount: number; toolCount: number }> {
  if (!isValidProfileName(name)) {
    throw new LinkHttpError(400, "invalid_profile_name", "invalid profile name");
  }

  const listedModels = await listHermesModelConfigs(name).catch(() => null);
  const profileDir = resolveHermesProfileDir(name);

  return {
    defaultModel: (listedModels?.defaultModel as string | null) ?? null,
    modelCount: Array.isArray(listedModels?.models) ? (listedModels.models as unknown[]).length : 0,
    skillCount: await countSkills(path.join(profileDir, "skills")).catch(() => 0),
    toolCount: 0,
  };
}

async function countSkills(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });

  let count = 0;
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.name === ".git" || entry.name === ".hub") {
      continue;
    }
    if (entry.isDirectory()) {
      count += await countSkills(entryPath);
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      count += 1;
    }
  }
  return count;
}

export async function listHermesProfilesFull(
  paths: RuntimePaths = resolveRuntimePaths(),
): Promise<HermesProfileStatus[]> {
  const names = await listHermesProfiles();
  const unique = ["default", ...names.filter((n) => n !== "default")];
  return Promise.all(unique.map((name) => getHermesProfileStatus(name, paths)));
}
