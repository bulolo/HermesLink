import Router from "@koa/router";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest, readAppInstanceIdHeader, readDeviceModelHeader } from "../auth.js";
import {
  createDeviceSession,
  refreshDeviceSession,
  revokeDeviceRefreshToken,
  recordDeviceSeen,
} from "../../security/credentials.js";
import { loadIdentity } from "../../identity/identity.js";
import { LinkHttpError } from "../../core/errors.js";

function readString(body: unknown, ...keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  for (const key of keys) {
    const val = (body as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return null;
}

async function readJsonBody(req: import("http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

export function createAuthRouter(options: { paths: RuntimePaths; logger: Logger }): Router {
  const { paths, logger } = options;
  const router = new Router();

  router.get("/api/v1/auth/me", async (ctx) => {
    const auth = await authenticateRequest(ctx, paths);
    const identity = await loadIdentity(paths);
    if (!identity?.link_id) throw new LinkHttpError(409, "link_not_paired", "Hermes Link is not paired");
    const device = auth.device
      ? await recordDeviceSeen(
          auth.device.id,
          { appInstanceId: readAppInstanceIdHeader(ctx), model: readDeviceModelHeader(ctx) },
          paths,
        ) ?? auth.device
      : null;
    ctx.body = {
      ok: true,
      auth: { kind: auth.kind, account_id: auth.accountId ?? null },
      link: { link_id: identity.link_id, display_name: "Hermes Link" },
      device: device
        ? { id: device.id, device_id: device.id, label: device.label, platform: device.platform, model: device.model ?? null, scope: device.scope }
        : null,
    };
  });

  router.post("/api/v1/auth/device-session", async (ctx) => {
    const auth = await authenticateRequest(ctx, paths);
    if (auth.kind !== "app-connect") {
      throw new LinkHttpError(403, "app_connect_required", "App connect token is required to create a device session");
    }
    if (auth.scopes && auth.scopes.length > 0 && !auth.scopes.includes("device:enroll")) {
      throw new LinkHttpError(403, "device_enroll_scope_required", "App connect token cannot enroll a device");
    }
    const identity = await loadIdentity(paths);
    if (!identity?.link_id) throw new LinkHttpError(409, "link_not_paired", "Hermes Link is not paired");
    const body = await readJsonBody(ctx.req);
    const session = await createDeviceSession(
      {
        label: readString(body, "device_label", "deviceLabel") ?? "HermesPilot App",
        platform: readString(body, "device_platform", "devicePlatform") ?? "unknown",
        model: readString(body, "device_model", "deviceModel"),
        appInstanceId: auth.appInstanceId,
      },
      paths,
    );
    ctx.body = {
      ok: true,
      link: { link_id: identity.link_id, display_name: "Hermes Link" },
      device: session.device,
      access_token: { token: session.accessToken.token, expires_at: session.accessToken.expiresAt },
      refresh_token: { token: session.refreshToken.token, expires_at: session.refreshToken.expiresAt },
    };
    logger.info({ device_id: session.device.device_id, device_platform: session.device.platform }, "device_session_enrolled");
  });

  router.post("/api/v1/auth/refresh", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const refreshToken = readString(body, "refresh_token", "refreshToken");
    if (!refreshToken) throw new LinkHttpError(400, "refresh_token_required", "refresh_token is required");
    const session = await refreshDeviceSession(
      refreshToken,
      {
        appInstanceId: readString(body, "app_instance_id", "appInstanceId"),
        label: readString(body, "device_label", "deviceLabel"),
        platform: readString(body, "device_platform", "devicePlatform"),
        model: readString(body, "device_model", "deviceModel"),
      },
      paths,
    );
    ctx.body = {
      ok: true,
      device: session.device,
      access_token: { token: session.accessToken.token, expires_at: session.accessToken.expiresAt },
      refresh_token: { token: session.refreshToken.token, expires_at: session.refreshToken.expiresAt },
    };
  });

  router.post("/api/v1/auth/logout", async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const refreshToken = readString(body, "refresh_token", "refreshToken");
    if (refreshToken) await revokeDeviceRefreshToken(refreshToken, paths);
    ctx.body = { ok: true };
  });

  return router;
}
