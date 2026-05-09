import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { LinkHttpError } from "../../core/errors.js";
import { beginSseStream, writeJsonSseEvent } from "../sse-stream.js";
import {
  readHermesProfilePermissions,
  saveHermesProfilePermissions,
  readHermesProfileToolConfig,
  saveHermesProfileToolConfig,
  listHermesModelConfigs,
} from "../../hermes/config.js";
import { reloadHermesGateway } from "../../hermes/gateway.js";
import { listHermesProfiles } from "../../hermes/gateway.js";
import {
  getHermesProfileStatus,
  readHermesProfileCapabilities,
  updateHermesProfileMetadata,
  renameHermesProfile,
  deleteHermesProfile,
} from "../../hermes/profile-status.js";
import {
  listHermesProfileSkills,
  setHermesProfileSkillEnabled,
  HermesSkillNotFoundError,
} from "../../hermes/skills.js";
import {
  readHermesProfileMemory,
  addHermesMemoryEntry,
  replaceHermesMemoryEntry,
  removeHermesMemoryEntry,
  resetHermesMemoryStore,
  saveHermesMemorySettings,
  saveHermesMemoryProviderSettings,
  setHermesMemoryProvider,
  readMemoryTarget,
  readRequiredMemoryContent,
  readRequiredMemoryMatch,
  readMemoryResetTarget,
  readMemorySettingsPatch,
  toMemoryHttpError,
  HermesMemoryError,
} from "../../hermes/profile-memory.js";
import {
  startHermesProfileCreation,
  readHermesProfileCreationStatus,
  subscribeHermesProfileCreationStatus,
} from "../../hermes/profile-creation.js";
import { ConversationService } from "../../conversations/service.js";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  return undefined;
}

function readString(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

async function readCatalogField<T>(
  field: string,
  load: () => Promise<T>,
): Promise<{ value: T | null; errors: Array<{ field: string; message: string }> }> {
  try {
    return { value: await load(), errors: [] };
  } catch (error) {
    return {
      value: null,
      errors: [{ field, message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

async function reloadGatewayAfterProfileConfigChange(
  result: Record<string, unknown>,
  options: { paths: RuntimePaths; logger: Logger; profileName: string; configKind: string; label: string },
): Promise<Record<string, unknown>> {
  try {
    await reloadHermesGateway({ paths: options.paths, profileName: options.profileName });
    return { ...result, gatewayReloaded: true, requiresGatewayReload: false, restartHint: `${options.label}已保存，${options.profileName} Profile 的 Hermes Gateway 已自动重载。新的 Run 会读取最新配置。` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void options.logger.warn({ config_kind: options.configKind, profile: options.profileName, error: message }, "hermes_gateway_reload_after_profile_config_failed");
    return { ...result, gatewayReloaded: false, reloadError: message, requiresGatewayReload: true, restartHint: `${options.label}已保存，但 ${options.profileName} Profile 的 Hermes Gateway 自动重载失败：${message}` };
  }
}

function readProfilePermissionsInput(body: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const readOptObj = (key: string) => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
    const v = body[key];
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new LinkHttpError(400, "profile_permissions_invalid", `${key} must be an object`);
    return v as Record<string, unknown>;
  };
  const approvals = readOptObj("approvals");
  if (approvals) input.approvals = { mode: readString(approvals, "mode", "approval_mode", "approvalMode"), timeout: approvals.timeout, cronMode: readString(approvals, "cron_mode", "cronMode") };
  const terminal = readOptObj("terminal");
  if (terminal) input.terminal = { backend: readString(terminal, "backend"), cwd: readString(terminal, "cwd"), containerCpu: terminal.container_cpu ?? terminal.containerCpu, containerMemory: terminal.container_memory ?? terminal.containerMemory, containerDisk: terminal.container_disk ?? terminal.containerDisk, containerPersistent: terminal.container_persistent ?? terminal.containerPersistent };
  const toolsets = readOptObj("toolsets");
  if (toolsets) input.toolsets = { enabledToolsets: toolsets.enabled_toolsets ?? toolsets.enabledToolsets ?? toolsets.enabled, mcpEnabled: toolsets.mcp_enabled ?? toolsets.mcpEnabled };
  if (Object.keys(input).length === 0) throw new LinkHttpError(400, "profile_permissions_update_empty", "No permission fields were provided");
  return input;
}

function readProfileToolConfigInput(body: Record<string, unknown>): { values: Record<string, unknown> } {
  const values = (typeof body.values === "object" && body.values !== null && !Array.isArray(body.values))
    ? (body.values as Record<string, unknown>)
    : body;
  if (Object.keys(values).length === 0) throw new LinkHttpError(400, "profile_tool_config_update_empty", "No tool config fields were provided");
  return { values };
}

function readProfileMetadataInput(body: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(body, "displayName") || Object.prototype.hasOwnProperty.call(body, "display_name")) {
    metadata.displayName = readString(body, "displayName", "display_name") ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    metadata.description = readString(body, "description") ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "avatarType") || Object.prototype.hasOwnProperty.call(body, "avatar_type")) {
    const v = readString(body, "avatarType", "avatar_type") ?? "default";
    if (v !== "default" && v !== "url") throw new LinkHttpError(400, "invalid_profile_avatar_type", 'avatar_type must be "default" or "url"');
    metadata.avatarType = v;
  }
  if (Object.prototype.hasOwnProperty.call(body, "avatarUrl") || Object.prototype.hasOwnProperty.call(body, "avatar_url")) {
    metadata.avatarUrl = readString(body, "avatarUrl", "avatar_url") ?? null;
  }
  return metadata;
}

export function createProfilesRouter(options: {
  paths: RuntimePaths;
  logger: Logger;
  conversations: ConversationService;
}): Router {
  const { paths, logger, conversations } = options;
  const router = new Router();

  // GET /api/v1/profiles - list all profiles
  router.get("/api/v1/profiles", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const names = await listHermesProfiles();
    ctx.body = { ok: true, profiles: names };
  });

  // POST /api/v1/profiles - start profile creation
  router.post("/api/v1/profiles", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    ctx.status = 202;
    ctx.body = await startHermesProfileCreation(body, { paths, logger });
  });

  // GET /api/v1/profile-creation/status
  router.get("/api/v1/profile-creation/status", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await readHermesProfileCreationStatus(paths);
  });

  // GET /api/v1/profile-creation/events - SSE
  router.get("/api/v1/profile-creation/events", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.respond = false;
    const response = ctx.res;
    let unsubscribe = () => { /* noop */ };
    beginSseStream(ctx.req, response, { onClose: () => unsubscribe() });
    writeJsonSseEvent(response, {
      event: "profile.creation.status",
      data: await readHermesProfileCreationStatus(paths),
    });
    unsubscribe = subscribeHermesProfileCreationStatus((status) => {
      writeJsonSseEvent(response, { event: "profile.creation.status", data: status });
    });
  });

  // GET /api/v1/profiles/catalog - catalog of all profiles
  router.get("/api/v1/profiles/catalog", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const names = await listHermesProfiles();
    const unique = ["default", ...names.filter((n) => n !== "default")];
    ctx.body = {
      ok: true,
      generatedAt: new Date().toISOString(),
      profiles: await Promise.all(
        unique.map(async (name) => {
          const profile = await getHermesProfileStatus(name, paths).catch(() => null);
          const [capabilities, permissions, modelConfigs] = await Promise.all([
            readCatalogField("capabilities", () => readHermesProfileCapabilities(name)),
            readCatalogField("permissions", () => readHermesProfilePermissions(name)),
            readCatalogField("modelConfigs", () => listHermesModelConfigs(name)),
          ]);
          return {
            profile,
            capabilities: capabilities.value,
            permissions: permissions.value,
            modelConfigs: modelConfigs.value,
            errors: [...capabilities.errors, ...permissions.errors, ...modelConfigs.errors],
          };
        }),
      ),
    };
  });

  // GET /api/v1/profiles/:name/status
  router.get("/api/v1/profiles/:name/status", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = { ok: true, profile: await getHermesProfileStatus(ctx.params.name, paths) };
  });

  // GET /api/v1/profiles/:name/statistics
  router.get("/api/v1/profiles/:name/statistics", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const [profile, capabilities] = await Promise.all([
      getHermesProfileStatus(ctx.params.name, paths),
      readHermesProfileCapabilities(ctx.params.name).catch(() => null),
    ]);
    const statistics = await conversations.getStatistics({
      profileUid: profile.uid,
      profileName: profile.name,
    });
    if (capabilities) {
      (statistics as Record<string, unknown> & { models?: Record<string, unknown>; skills?: Record<string, unknown>; tools?: Record<string, unknown>; profiles?: Record<string, unknown> }).models ??= {};
      ((statistics as Record<string, Record<string, unknown>>).models).total = capabilities.modelCount;
      (statistics as Record<string, unknown> & { skills?: Record<string, unknown> }).skills ??= {};
      ((statistics as Record<string, Record<string, unknown>>).skills).total = capabilities.skillCount;
      (statistics as Record<string, unknown> & { tools?: Record<string, unknown> }).tools ??= {};
      ((statistics as Record<string, Record<string, unknown>>).tools).total = capabilities.toolCount;
      (statistics as Record<string, unknown> & { profiles?: Record<string, unknown> }).profiles ??= {};
      ((statistics as Record<string, Record<string, unknown>>).profiles).total = 1;
    }
    ctx.body = { ok: true, profile, capabilities, statistics };
  });

  // PATCH /api/v1/profiles/:name - rename or update metadata
  router.patch("/api/v1/profiles/:name", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    if (typeof body.name === "string") {
      ctx.body = { ok: true, profile: await renameHermesProfile(ctx.params.name, body.name, paths) };
      return;
    }
    ctx.body = { ok: true, profile: await updateHermesProfileMetadata(ctx.params.name, readProfileMetadataInput(body) as Parameters<typeof updateHermesProfileMetadata>[1], paths) };
  });

  // DELETE /api/v1/profiles/:name
  router.delete("/api/v1/profiles/:name", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await deleteHermesProfile(ctx.params.name, paths);
    const cleanup = await conversations.deleteLocalConversationsForProfile({
      profileName: profile.name,
      profileUid: profile.uid,
    }).catch(() => ({ deleted_count: 0 }));
    void logger.info({ profile: profile.name, profile_uid: profile.uid, deleted_conversations: (cleanup as { deleted_count?: number }).deleted_count }, "profile_deleted");
    ctx.status = 204;
  });

  // GET /api/v1/profiles/:name/skills
  router.get("/api/v1/profiles/:name/skills", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await listHermesProfileSkills(ctx.params.name, paths);
  });

  // PATCH /api/v1/profiles/:name/skills/:skillName
  router.patch("/api/v1/profiles/:name/skills/:skillName", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const enabled = readBoolean(body.enabled);
    if (enabled === undefined) {
      throw new LinkHttpError(400, "skill_enabled_required", "enabled must be a boolean");
    }
    try {
      ctx.body = await setHermesProfileSkillEnabled(ctx.params.name, ctx.params.skillName, enabled, paths);
    } catch (error) {
      if (error instanceof HermesSkillNotFoundError) {
        throw new LinkHttpError(404, "skill_not_found", error.message);
      }
      throw error;
    }
  });

  // GET /api/v1/profiles/:name/memory
  router.get("/api/v1/profiles/:name/memory", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    await getHermesProfileStatus(ctx.params.name, paths);
    ctx.body = await readHermesProfileMemory(ctx.params.name);
  });

  // POST /api/v1/profiles/:name/memory/entries
  router.post("/api/v1/profiles/:name/memory/entries", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await addHermesMemoryEntry(
        ctx.params.name,
        readMemoryTarget(body),
        readRequiredMemoryContent(body),
      );
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // PATCH /api/v1/profiles/:name/memory/entries
  router.patch("/api/v1/profiles/:name/memory/entries", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await replaceHermesMemoryEntry(
        ctx.params.name,
        readMemoryTarget(body),
        readRequiredMemoryMatch(body),
        readRequiredMemoryContent(body),
      );
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // DELETE /api/v1/profiles/:name/memory/entries
  router.delete("/api/v1/profiles/:name/memory/entries", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await removeHermesMemoryEntry(
        ctx.params.name,
        readMemoryTarget(body),
        readRequiredMemoryMatch(body),
      );
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // DELETE /api/v1/profiles/:name/memory
  router.delete("/api/v1/profiles/:name/memory", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await resetHermesMemoryStore(
        ctx.params.name,
        readMemoryResetTarget(body),
      );
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // PATCH /api/v1/profiles/:name/memory/settings
  router.patch("/api/v1/profiles/:name/memory/settings", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await saveHermesMemorySettings(ctx.params.name, readMemorySettingsPatch(body));
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // PATCH /api/v1/profiles/:name/memory/provider
  router.patch("/api/v1/profiles/:name/memory/provider", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await setHermesMemoryProvider(ctx.params.name, body.provider);
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // PATCH /api/v1/profiles/:name/memory/providers/:provider/settings
  router.patch("/api/v1/profiles/:name/memory/providers/:provider/settings", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      ctx.body = await saveHermesMemoryProviderSettings(ctx.params.name, ctx.params.provider, readMemorySettingsPatch(body));
    } catch (error) {
      throw toMemoryHttpError(error);
    }
  });

  // GET /api/v1/profiles/:name/permissions
  router.get("/api/v1/profiles/:name/permissions", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    await getHermesProfileStatus(ctx.params.name, paths);
    ctx.body = { ok: true, permissions: await readHermesProfilePermissions(ctx.params.name) };
  });

  // PATCH /api/v1/profiles/:name/permissions
  router.patch("/api/v1/profiles/:name/permissions", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      const result = await saveHermesProfilePermissions(ctx.params.name, readProfilePermissionsInput(body) as Parameters<typeof saveHermesProfilePermissions>[1]);
      ctx.body = {
        ok: true,
        permissions: await reloadGatewayAfterProfileConfigChange(result as Record<string, unknown>, {
          paths, logger, profileName: ctx.params.name, configKind: "profile_permissions", label: "权限配置",
        }),
      };
    } catch (error) {
      if (error instanceof LinkHttpError) throw error;
      throw new LinkHttpError(400, "profile_permissions_invalid", error instanceof Error ? error.message : "Invalid profile permissions");
    }
  });

  // GET /api/v1/profiles/:name/tool-configs/:toolKey
  router.get("/api/v1/profiles/:name/tool-configs/:toolKey", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    await getHermesProfileStatus(ctx.params.name, paths);
    ctx.body = await readHermesProfileToolConfig(ctx.params.name, ctx.params.toolKey);
  });

  // PATCH /api/v1/profiles/:name/tool-configs/:toolKey
  router.patch("/api/v1/profiles/:name/tool-configs/:toolKey", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    await getHermesProfileStatus(ctx.params.name, paths);
    try {
      const result = await saveHermesProfileToolConfig(ctx.params.name, ctx.params.toolKey, readProfileToolConfigInput(body) as Parameters<typeof saveHermesProfileToolConfig>[2]);
      ctx.body = {
        ok: true,
        config: await reloadGatewayAfterProfileConfigChange(result as Record<string, unknown>, {
          paths, logger, profileName: ctx.params.name, configKind: "profile_tool_config", label: "工具后端配置",
        }),
      };
    } catch (error) {
      if (error instanceof LinkHttpError) throw error;
      throw new LinkHttpError(400, "profile_tool_config_invalid", error instanceof Error ? error.message : "Invalid profile tool config");
    }
  });

  return router;
}
