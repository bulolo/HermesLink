import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { createHermesRun, streamHermesRunEvents, cancelHermesRun } from "../../hermes/runs.js";
import { upsertRunUsageFact } from "../../storage/link-database.js";

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

function toRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readInt(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function extractRunUsage(payload: Record<string, unknown>): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  const usage = toRecord(payload.usage);
  const response = toRecord(payload.response);
  const responseUsage = toRecord(response.usage);
  const inp = readInt(usage, "input_tokens") ?? readInt(usage, "prompt_tokens")
    ?? readInt(responseUsage, "input_tokens") ?? readInt(payload, "input_tokens") ?? null;
  const out = readInt(usage, "output_tokens") ?? readInt(usage, "completion_tokens")
    ?? readInt(responseUsage, "output_tokens") ?? readInt(payload, "output_tokens") ?? null;
  if (inp === null && out === null) return null;
  const i = inp ?? 0, o = out ?? 0;
  const t = readInt(usage, "total_tokens") ?? readInt(responseUsage, "total_tokens") ?? readInt(payload, "total_tokens") ?? i + o;
  return { inputTokens: i, outputTokens: o, totalTokens: t };
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed && typeof parsed === "object") events.push(parsed as Record<string, unknown>);
      } catch { /* ignore malformed */ }
    }
  }
  return events;
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
      const decoder = new TextDecoder();
      const runId = ctx.params.runId;
      const startedAt = new Date().toISOString();
      let sseBuffer = "";

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          if (!res.writableEnded) res.write(value);

          sseBuffer += decoder.decode(value, { stream: true });
          const parts = sseBuffer.split(/\r?\n\r?\n/);
          sseBuffer = parts.pop() ?? "";
          for (const part of parts) {
            for (const event of parseSseEvents(part + "\n\n")) {
              const type = typeof event.type === "string" ? event.type
                : typeof event.payloadType === "string" ? event.payloadType : "";
              if (type !== "run.completed" && type !== "run.failed") continue;
              const payload = toRecord(event.payload ?? event);
              const runPayload = toRecord(payload.run ?? payload);
              const usage = extractRunUsage(payload) ?? extractRunUsage(runPayload);
              if (!usage) continue;
              const now = new Date().toISOString();
              const profile = typeof runPayload.profile === "string" ? runPayload.profile
                : typeof runPayload.profile_name_snapshot === "string" ? runPayload.profile_name_snapshot
                : profileName ?? null;
              const model = typeof runPayload.model === "string" ? runPayload.model : null;
              const provider = typeof runPayload.provider === "string" ? runPayload.provider : null;
              upsertRunUsageFact(paths, {
                runId,
                conversationId: null,
                profileNameSnapshot: profile,
                profile,
                model,
                provider,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
                messageCount: 0,
                startedAt,
                completedAt: now,
                updatedAt: now,
              }).catch(() => undefined);
            }
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
