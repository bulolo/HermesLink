import { LinkHttpError } from "../core/errors.js";
import { callHermesApi, readJsonResponse } from "./api-proxy.js";

type CronJobOptions = {
  logger?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  profileName?: string | null;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listHermesCronJobs(
  options: CronJobOptions & { includeDisabled?: boolean } = {},
): Promise<unknown[]> {
  const query = options.includeDisabled ? "?include_disabled=true" : "";
  const response = await callHermesApi(`/api/jobs${query}`, { method: "GET" }, options);
  const payload = await readJsonResponse(response);
  const jobs = payload.jobs;
  return Array.isArray(jobs) ? jobs.filter(isRecord).map((job) => ({ ...job })) : [];
}

export async function getHermesCronJob(
  jobId: string,
  options: CronJobOptions = {},
): Promise<Record<string, unknown>> {
  const response = await callHermesApi(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" },
    options,
  );
  const payload = await readJsonResponse(response);
  if (!isRecord(payload.job)) {
    throw new LinkHttpError(502, "hermes_cron_job_invalid", "Hermes API Server did not return a cron job");
  }
  return { ...(payload.job as Record<string, unknown>) };
}

export async function createHermesCronJob(
  input: Record<string, unknown>,
  options: CronJobOptions = {},
): Promise<Record<string, unknown>> {
  const response = await callHermesApi(
    "/api/jobs",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
    options,
  );
  const payload = await readJsonResponse(response);
  if (!isRecord(payload.job)) {
    throw new LinkHttpError(502, "hermes_cron_job_invalid", "Hermes API Server did not return a cron job");
  }
  return { ...(payload.job as Record<string, unknown>) };
}

export async function updateHermesCronJob(
  jobId: string,
  input: Record<string, unknown>,
  options: CronJobOptions = {},
): Promise<Record<string, unknown>> {
  const response = await callHermesApi(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
    options,
  );
  const payload = await readJsonResponse(response);
  if (!isRecord(payload.job)) {
    throw new LinkHttpError(502, "hermes_cron_job_invalid", "Hermes API Server did not return a cron job");
  }
  return { ...(payload.job as Record<string, unknown>) };
}

export async function deleteHermesCronJob(
  jobId: string,
  options: CronJobOptions = {},
): Promise<void> {
  const response = await callHermesApi(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
    options,
  );
  await readJsonResponse(response);
}

export async function runHermesCronJobAction(
  jobId: string,
  action: string,
  options: CronJobOptions = {},
): Promise<Record<string, unknown>> {
  const response = await callHermesApi(
    `/api/jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" },
    options,
  );
  const payload = await readJsonResponse(response);
  if (!isRecord(payload.job)) {
    throw new LinkHttpError(502, "hermes_cron_job_invalid", "Hermes API Server did not return a cron job");
  }
  return { ...(payload.job as Record<string, unknown>) };
}
