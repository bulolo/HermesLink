import { LinkHttpError } from "../core/errors.js";
import { callHermesApi, readJsonResponse } from "./api-proxy.js";
import { readHermesVersion } from "./gateway.js";
import { assertHermesRunsApiSupported } from "./gateway.js";

type RunOptions = {
  logger?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  profileName?: string | null;
  fetchImpl?: typeof fetch;
};

function readStr(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function createHermesRun(
  input: {
    input: string;
    instructions?: string;
    conversation_history?: unknown[];
    session_id?: string;
  },
  options: RunOptions = {},
): Promise<{ run_id: string; fallback: boolean }> {
  const response = await callHermesApi(
    "/v1/runs",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
    options,
  );

  if (response.status === 404 || response.status === 503) {
    assertHermesRunsApiSupported(
      await readHermesVersion(options.profileName).catch(() => null),
    );
    throw new LinkHttpError(503, "hermes_api_server_unavailable", "Hermes API Server is unavailable");
  }

  const payload = await readJsonResponse(response);
  const runId =
    readStr(payload, "run_id") ?? readStr(payload, "runId") ?? readStr(payload, "id");
  if (!runId) {
    throw new LinkHttpError(502, "hermes_run_invalid", "Hermes API Server did not return a run id");
  }

  return { run_id: runId, fallback: false };
}

export async function streamHermesRunEvents(
  runId: string,
  options: RunOptions & { signal?: AbortSignal } = {},
): Promise<Response> {
  const response = await callHermesApi(
    `/v1/runs/${encodeURIComponent(runId)}/events`,
    { method: "GET", signal: options.signal } as RequestInit & { method: string },
    options,
  );

  assertHermesRunsApiSupported(
    await readHermesVersion(options.profileName).catch(() => null),
  );

  if (!response.ok || !response.body) {
    throw new LinkHttpError(502, "hermes_events_unavailable", "Hermes run event stream is unavailable");
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function cancelHermesRun(runId: string, options: RunOptions = {}): Promise<void> {
  const response = await callHermesApi(
    `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
    options,
  );

  if (response.status === 404 || response.status === 405 || response.status === 501) {
    throw new LinkHttpError(
      501,
      "hermes_cancel_unsupported",
      "Hermes Agent does not expose a run cancel endpoint; only Link-managed conversation runs can be cancelled.",
    );
  }

  if (!response.ok) {
    throw new LinkHttpError(502, "hermes_cancel_failed", "Hermes run cancel failed");
  }
}
