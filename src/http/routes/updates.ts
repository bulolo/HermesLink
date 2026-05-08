import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { beginSseStream, writeJsonSseEvent } from "../sse-stream.js";
import {
  readHermesUpdateCheck,
  startHermesUpdate,
  readHermesUpdateStatus,
  subscribeHermesUpdateStatus,
} from "../../hermes/update-manager.js";
import {
  readLinkUpdateCheck,
  startLinkUpdate,
  readLinkUpdateStatus,
  subscribeLinkUpdateStatus,
} from "../../link/update-manager.js";

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

export function createUpdatesRouter(options: {
  paths: RuntimePaths;
  logger: Logger;
}): Router {
  const { paths, logger } = options;
  const router = new Router();

  // Hermes update routes
  router.get("/api/v1/hermes/update-check", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await readHermesUpdateCheck({ paths, logger, refreshRemote: true });
  });

  router.get("/api/v1/hermes/update/status", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await readHermesUpdateStatus(paths);
  });

  router.post("/api/v1/hermes/update", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.status = 202;
    ctx.body = await startHermesUpdate({ paths, logger });
  });

  router.get("/api/v1/hermes/update/events", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.respond = false;
    const response = ctx.res;
    let unsubscribe = () => { /* noop */ };
    beginSseStream(ctx.req, response, { onClose: () => unsubscribe() });
    writeJsonSseEvent(response, {
      event: "hermes.update.status",
      data: await readHermesUpdateStatus(paths),
    });
    unsubscribe = subscribeHermesUpdateStatus((status) => {
      writeJsonSseEvent(response, { event: "hermes.update.status", data: status });
    });
  });

  // Link update routes
  router.get("/api/v1/link/update-check", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await readLinkUpdateCheck({ paths, logger });
  });

  router.get("/api/v1/link/update/status", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    ctx.body = await readLinkUpdateStatus(paths);
  });

  router.post("/api/v1/link/update", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    ctx.status = 202;
    ctx.body = await startLinkUpdate({
      paths,
      logger,
      targetVersion: readString(body, "target_version") ?? readString(body, "targetVersion") ?? undefined,
    });
  });

  router.get("/api/v1/link/update/events", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.respond = false;
    const response = ctx.res;
    let unsubscribe = () => { /* noop */ };
    beginSseStream(ctx.req, response, { onClose: () => unsubscribe() });
    writeJsonSseEvent(response, {
      event: "link.update.status",
      data: await readLinkUpdateStatus(paths),
    });
    unsubscribe = subscribeLinkUpdateStatus((status) => {
      writeJsonSseEvent(response, { event: "link.update.status", data: status });
    });
  });

  return router;
}
