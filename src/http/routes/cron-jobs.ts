import Router from "@koa/router";
import type { IncomingMessage } from "http";
import { type RuntimePaths } from "../../runtime/paths.js";
import { type Logger } from "pino";
import { authenticateRequest } from "../auth.js";
import { LinkHttpError } from "../../core/errors.js";
import { listHermesProfiles } from "../../hermes/gateway.js";
import {
  listHermesCronJobs,
  getHermesCronJob,
  createHermesCronJob,
  updateHermesCronJob,
  deleteHermesCronJob,
  runHermesCronJobAction,
} from "../../hermes/cron-jobs.js";
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

function readQueryString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  return null;
}

export function createCronJobsRouter(options: {
  paths: RuntimePaths;
  logger: Logger;
}): Router {
  const { paths, logger } = options;
  const router = new Router();

  // GET /api/v1/cron-jobs - list all cron jobs across all profiles
  router.get("/api/v1/cron-jobs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    ctx.set("cache-control", "no-store");
    const includeDisabled =
      readQueryString(ctx.query.include_disabled)?.toLowerCase() === "true" ||
      readQueryString(ctx.query.includeDisabled)?.toLowerCase() === "true";
    const names = await listHermesProfiles();
    const unique = ["default", ...names.filter((n) => n !== "default")];

    const results = await Promise.allSettled(
      unique.map(async (name) => ({
        profile: name,
        jobs: await listHermesCronJobs({ logger, profileName: name, includeDisabled }),
      })),
    );

    const jobs: unknown[] = [];
    const failures: Array<{ profile: string; message: string }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        for (const job of result.value.jobs) {
          jobs.push({ ...(job as Record<string, unknown>), _profile: result.value.profile });
        }
      } else {
        failures.push({
          profile: unique[i] ?? "unknown",
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    ctx.body = { ok: failures.length === 0, jobs, failures };
  });

  // GET /api/v1/profiles/:name/cron-jobs
  router.get("/api/v1/profiles/:name/cron-jobs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    ctx.set("cache-control", "no-store");
    const includeDisabled =
      readQueryString(ctx.query.include_disabled)?.toLowerCase() === "true" ||
      readQueryString(ctx.query.includeDisabled)?.toLowerCase() === "true";
    const jobs = await listHermesCronJobs({ logger, profileName: profile.name, includeDisabled });
    ctx.body = { ok: true, profile, jobs };
  });

  // POST /api/v1/profiles/:name/cron-jobs
  router.post("/api/v1/profiles/:name/cron-jobs", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    const body = await readJsonBody(ctx.req);
    const job = await createHermesCronJob(body, { logger, profileName: profile.name });
    ctx.status = 201;
    ctx.body = { ok: true, job };
  });

  // GET /api/v1/profiles/:name/cron-jobs/:jobId
  router.get("/api/v1/profiles/:name/cron-jobs/:jobId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    ctx.set("cache-control", "no-store");
    const job = await getHermesCronJob(ctx.params.jobId, { logger, profileName: profile.name });
    ctx.body = { ok: true, job };
  });

  // PATCH /api/v1/profiles/:name/cron-jobs/:jobId
  router.patch("/api/v1/profiles/:name/cron-jobs/:jobId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    const body = await readJsonBody(ctx.req);
    const job = await updateHermesCronJob(ctx.params.jobId, body, { logger, profileName: profile.name });
    ctx.body = { ok: true, job };
  });

  // DELETE /api/v1/profiles/:name/cron-jobs/:jobId
  router.delete("/api/v1/profiles/:name/cron-jobs/:jobId", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    await deleteHermesCronJob(ctx.params.jobId, { logger, profileName: profile.name });
    ctx.body = { ok: true };
  });

  // POST /api/v1/profiles/:name/cron-jobs/:jobId/pause
  router.post("/api/v1/profiles/:name/cron-jobs/:jobId/pause", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    const job = await runHermesCronJobAction(ctx.params.jobId, "pause", { logger, profileName: profile.name });
    ctx.body = { ok: true, job };
  });

  // POST /api/v1/profiles/:name/cron-jobs/:jobId/resume
  router.post("/api/v1/profiles/:name/cron-jobs/:jobId/resume", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    const job = await runHermesCronJobAction(ctx.params.jobId, "resume", { logger, profileName: profile.name });
    ctx.body = { ok: true, job };
  });

  // POST /api/v1/profiles/:name/cron-jobs/:jobId/run
  router.post("/api/v1/profiles/:name/cron-jobs/:jobId/run", async (ctx) => {
    await authenticateRequest(ctx, paths);
    const profile = await getHermesProfileStatus(ctx.params.name, paths);
    const job = await runHermesCronJobAction(ctx.params.jobId, "run", { logger, profileName: profile.name });
    ctx.body = { ok: true, job };
  });

  return router;
}
