import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { LinkHttpError, isLinkHttpError } from "../../core/errors.js";
import {
  listHermesModelConfigs,
  saveHermesModelConfig,
  deleteHermesModelConfig,
  saveHermesModelDefaults,
} from "../../hermes/config.js";
import { reloadHermesGateway, listHermesProfiles } from "../../hermes/gateway.js";
import { listHermesModels } from "../../hermes/models.js";
import { getHermesProfileStatus } from "../../hermes/profile-status.js";

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

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === 1) return true;
  if (value === false || value === "false" || value === 0) return false;
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : undefined;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function readQueryString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return null;
}

function readModelConfigInput(body: Record<string, unknown>): Record<string, unknown> {
  const id = readString(body, "id") ?? readString(body, "model_id") ?? readString(body, "modelId");
  const provider = readString(body, "provider") ?? readString(body, "provider_key") ?? readString(body, "providerKey");
  const baseUrl = readString(body, "base_url") ?? readString(body, "baseUrl");

  if (!id || !provider || !baseUrl) {
    throw new LinkHttpError(400, "model_config_invalid", "id, provider and base_url are required");
  }

  return {
    id,
    originalModelId: readString(body, "original_model_id") ?? readString(body, "originalModelId") ?? readString(body, "original_id") ?? undefined,
    provider,
    providerName: readString(body, "provider_name") ?? readString(body, "providerName") ?? undefined,
    baseUrl,
    apiKey: readString(body, "api_key") ?? readString(body, "apiKey") ?? undefined,
    apiMode: readString(body, "api_mode") ?? readString(body, "apiMode") ?? undefined,
    contextLength: readPositiveInteger(body.context_length ?? body.contextLength),
    keyEnv: readString(body, "key_env") ?? readString(body, "keyEnv") ?? undefined,
    setDefault: readBoolean(body.set_default ?? body.setDefault),
    reasoningEffort: readString(body, "reasoning_effort") ?? readString(body, "reasoningEffort") ?? undefined,
  };
}

function readModelDefaultsInput(body: Record<string, unknown>): { taskModelId?: string; compressionModelId?: string } {
  return {
    taskModelId: readString(body, "task_model_id") ?? readString(body, "taskModelId") ?? readString(body, "default_model_id") ?? readString(body, "defaultModelId") ?? undefined,
    compressionModelId: readString(body, "compression_model_id") ?? readString(body, "compressionModelId") ?? undefined,
  };
}

function shouldReloadGateway(body: Record<string, unknown>): boolean {
  const explicit = readBoolean(body.reload_gateway ?? body.reloadGateway) ??
    (readBoolean(body.skip_gateway_reload ?? body.skipGatewayReload) === true ? false : undefined);
  return explicit ?? true;
}

function markAppliedWithoutGatewayReload(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...result,
    requiresGatewayReload: false,
    restartHint: "模型配置已保存。新的 Run 会直接读取最新配置，无需重载 Hermes Gateway。",
  };
}

async function reloadGatewayAfterModelConfigChange(
  result: Record<string, unknown>,
  options: { paths: RuntimePaths; logger: Logger; profileName?: string | null },
): Promise<Record<string, unknown>> {
  try {
    await reloadHermesGateway({ profileName: options.profileName ?? "default", paths: options.paths });
  } catch {
    // Gateway reload failure is non-fatal
  }
  return { ...result, requiresGatewayReload: true };
}

function toModelConfigHttpError(error: unknown): LinkHttpError {
  if (isLinkHttpError(error)) return error;
  if (error instanceof Error) return new LinkHttpError(400, "model_config_invalid", error.message);
  return new LinkHttpError(400, "model_config_invalid", "Invalid model config");
}

export function createModelsRouter(options: {
  paths: RuntimePaths;
  logger: Logger;
}): Router {
  const { paths, logger } = options;
  const router = new Router();

  router.get("/api/v1/models", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.body = await listHermesModels({
      logger,
      profileName: readQueryString(ctx.query.profile),
    });
  });

  router.get("/api/v1/model-configs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await listHermesModelConfigs();
  });

  router.post("/api/v1/model-configs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    try {
      const result = await saveHermesModelConfig(readModelConfigInput(body));
      ctx.body = shouldReloadGateway(body)
        ? await reloadGatewayAfterModelConfigChange(result, { paths, logger })
        : markAppliedWithoutGatewayReload(result);
    } catch (error) {
      throw toModelConfigHttpError(error);
    }
  });

  router.patch("/api/v1/model-configs/defaults", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    try {
      ctx.body = await saveHermesModelDefaults(readModelDefaultsInput(body));
    } catch (error) {
      throw toModelConfigHttpError(error);
    }
  });

  router.delete("/api/v1/model-configs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const modelId = readString(body, "model_id") ?? readString(body, "modelId");
    if (!modelId) {
      throw new LinkHttpError(400, "model_id_required", "model_id is required");
    }
    try {
      const result = await deleteHermesModelConfig(modelId);
      ctx.body = await reloadGatewayAfterModelConfigChange(result, { paths, logger });
    } catch (error) {
      throw toModelConfigHttpError(error);
    }
  });

  router.get("/api/v1/profiles/:name/model-configs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    await getHermesProfileStatus(ctx.params.name, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await listHermesModelConfigs(ctx.params.name);
  });

  router.post("/api/v1/profiles/:name/model-configs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    await getHermesProfileStatus(ctx.params.name, paths);
    const body = await readJsonBody(ctx.req);
    try {
      const result = await saveHermesModelConfig(readModelConfigInput(body), ctx.params.name);
      ctx.body = shouldReloadGateway(body)
        ? await reloadGatewayAfterModelConfigChange(result, { paths, logger, profileName: ctx.params.name })
        : markAppliedWithoutGatewayReload(result);
    } catch (error) {
      throw toModelConfigHttpError(error);
    }
  });

  router.patch("/api/v1/profiles/:name/model-configs/defaults", async (ctx) => {
    await authenticateRequest(ctx, paths);
    await getHermesProfileStatus(ctx.params.name, paths);
    const body = await readJsonBody(ctx.req);
    try {
      ctx.body = await saveHermesModelDefaults(readModelDefaultsInput(body), ctx.params.name);
    } catch (error) {
      throw toModelConfigHttpError(error);
    }
  });

  router.delete("/api/v1/profiles/:name/model-configs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    await getHermesProfileStatus(ctx.params.name, paths);
    const body = await readJsonBody(ctx.req);
    const modelId = readString(body, "model_id") ?? readString(body, "modelId");
    if (!modelId) {
      throw new LinkHttpError(400, "model_id_required", "model_id is required");
    }
    try {
      const result = await deleteHermesModelConfig(modelId, ctx.params.name);
      ctx.body = await reloadGatewayAfterModelConfigChange(result, { paths, logger, profileName: ctx.params.name });
    } catch (error) {
      throw toModelConfigHttpError(error);
    }
  });

  return router;
}
