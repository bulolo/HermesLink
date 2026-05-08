import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { createHermesRun, streamHermesRunEvents, cancelHermesRun } from "../../hermes/runs.js";

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

function readOptionalProfileName(body: Record<string, unknown>): string | null {
  return readString(body, "profile") ?? readString(body, "profile_name") ?? readString(body, "profileName");
}

export function createRunsRouter(options: {
  paths: RuntimePaths;
  logger: Logger;
}): Router {
  const { paths, logger } = options;
  const router = new Router();

  // POST /api/v1/runs
  router.post("/api/v1/runs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const profileName = readOptionalProfileName(body);
    const input = readString(body, "input");
    if (!input) throw new (await import("../../core/errors.js")).LinkHttpError(400, "run_input_required", "input is required");
    ctx.status = 202;
    ctx.body = await createHermesRun(
      {
        input,
        instructions: readString(body, "instructions") ?? undefined,
        session_id: readString(body, "session_id") ?? readString(body, "sessionId") ?? undefined,
        conversation_history: Array.isArray(body.conversation_history) ? (body.conversation_history as unknown[]) : [],
      },
      { logger, profileName },
    );
  });

  // GET /api/v1/runs/:runId/events - SSE stream proxy
  router.get("/api/v1/runs/:runId/events", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profileName = readString(ctx.query as Record<string, unknown>, "profile") ?? null;

    const controller = new AbortController();
    ctx.req.once("close", () => controller.abort());
    ctx.req.once("aborted", () => controller.abort());

    const upstreamResponse = await streamHermesRunEvents(ctx.params.runId, {
      logger,
      profileName,
      signal: controller.signal,
    });

    ctx.respond = false;
    const res = ctx.res;
    res.writeHead(200, {
      "Content-Type": upstreamResponse.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            break;
          }
          if (!res.writableEnded) {
            res.write(value);
          }
        }
      };
      pump().catch(() => {
        if (!res.writableEnded) res.end();
      });
    } else {
      res.end();
    }
  });

  // POST /api/v1/runs/:runId/cancel
  router.post("/api/v1/runs/:runId/cancel", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const body = await readJsonBody(ctx.req);
    const profileName = readOptionalProfileName(body);
    await cancelHermesRun(ctx.params.runId, { logger, profileName });
    ctx.body = { ok: true };
  });

  return router;
}
