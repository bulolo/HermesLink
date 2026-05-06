import Router from "@koa/router";
import type { Context } from "koa";
import { LINK_VERSION } from "../../constants.js";
import { type LinkConfig } from "../../config/config.js";
import { type LinkIdentity } from "../../identity/identity.js";
import { type RuntimePaths } from "../../runtime/paths.js";
import { getAutostartStatus, enableAutostart, disableAutostart } from "../../autostart/autostart.js";
import { detectRuntimeEnvironment } from "../../network/environment.js";
import { readLinkState } from "../../link/state.js";
import { checkForUpdates, dismissUpdate } from "../../link/updates.js";
import { readRecentLogEntries, readRecentGatewayLogEntries } from "../../runtime/logger.js";
import { requireAuth } from "../auth.js";
import { parseJsonBody } from "../request.js";

export function createSystemRouter(options: {
  config: LinkConfig;
  identity: LinkIdentity;
  paths: RuntimePaths;
}): Router {
  const router = new Router({ prefix: "/api/v1/system" });
  const auth = requireAuth(options.paths);

  router.get("/status", async (ctx: Context) => {
    const state = await readLinkState(options.paths);
    const autostart = await getAutostartStatus();
    const environment = detectRuntimeEnvironment();
    ctx.body = {
      version: LINK_VERSION,
      linkId: options.identity.link_id,
      installId: options.identity.install_id,
      port: options.config.port,
      autostart: {
        supported: autostart.supported,
        enabled: autostart.enabled,
        method: autostart.method,
      },
      environment: {
        kind: environment.kind,
        warning: environment.warning,
      },
      networkReport: state.networkReport,
      updateAvailable: state.updateAvailable,
    };
  });

  router.get("/version", (ctx: Context) => {
    ctx.body = { version: LINK_VERSION };
  });

  router.post("/autostart/enable", auth, async (ctx: Context) => {
    const status = await enableAutostart();
    ctx.body = status;
  });

  router.post("/autostart/disable", auth, async (ctx: Context) => {
    const status = await disableAutostart();
    ctx.body = status;
  });

  router.get("/logs", auth, async (ctx: Context) => {
    const limit = Number(ctx.query.limit) || undefined;
    const entries = await readRecentLogEntries({ paths: options.paths, limit });
    ctx.body = { entries };
  });

  router.get("/logs/gateway", auth, async (ctx: Context) => {
    const limit = Number(ctx.query.limit) || undefined;
    const entries = await readRecentGatewayLogEntries({ paths: options.paths, limit });
    ctx.body = { entries };
  });

  router.get("/updates", auth, async (ctx: Context) => {
    const info = await checkForUpdates({
      relayBaseUrl: options.config.relayBaseUrl,
      paths: options.paths,
    });
    ctx.body = info;
  });

  router.post("/updates/dismiss", auth, async (ctx: Context) => {
    await dismissUpdate(options.paths);
    ctx.body = { ok: true };
  });

  return router;
}
