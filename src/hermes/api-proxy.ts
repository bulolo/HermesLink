import { LinkHttpError } from "../core/errors.js";
import { ensureHermesApiServerAvailable } from "./gateway.js";

export async function callHermesApi(
  path: string,
  init: RequestInit & { method: string },
  options: {
    logger?: { debug?: (msg: string, fields?: Record<string, unknown>) => void; warn?: (msg: string, fields?: Record<string, unknown>) => void };
    profileName?: string | null;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const method = init.method ?? "GET";
  const fetchImpl = options.fetchImpl ?? fetch;

  const config = await ensureHermesApiServerAvailable({
    fetchImpl: options.fetchImpl,
    profileName: options.profileName,
  });

  const makeRequest = () => fetchHermesApi(fetchImpl, config, path, init, options);

  let response: Response;
  try {
    response = await makeRequest();
  } catch (error) {
    if (isAbortError(error)) throw error;
    void options.logger?.warn?.("hermes_api_server_connect_failed", {
      method,
      path,
      profile: options.profileName ?? "default",
      port: config.port ?? null,
      url: `http://127.0.0.1:${config.port}${path}`,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new LinkHttpError(503, "hermes_api_server_unavailable", "Hermes API Server is unavailable");
  }

  if (response.status !== 401) {
    return response;
  }

  // Retry once on 401
  const refreshedConfig = await ensureHermesApiServerAvailable({
    fetchImpl: options.fetchImpl,
    profileName: options.profileName,
  });

  const makeRequest2 = () => fetchHermesApi(fetchImpl, refreshedConfig, path, init, options);

  try {
    response = await makeRequest2();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new LinkHttpError(503, "hermes_api_server_unavailable", "Hermes API Server is unavailable");
  }

  return response;
}

async function fetchHermesApi(
  fetcher: typeof fetch,
  config: { port: number; apiKey?: string },
  path: string,
  init: RequestInit & { method: string },
  options: {
    logger?: { warn?: (msg: string, fields?: Record<string, unknown>) => void };
    profileName?: string | null;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const headers = new Headers(init.headers as HeadersInit);
  headers.set("accept", headers.get("accept") ?? "application/json");
  if (config.apiKey) {
    headers.set("x-api-key", config.apiKey);
    headers.set("authorization", `Bearer ${config.apiKey}`);
  }
  const signal = (init as RequestInit & { signal?: AbortSignal }).signal ?? options.signal;
  return await fetcher(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers,
    ...(signal ? { signal } : {}),
  }).catch((error: unknown) => {
    if (isAbortError(error)) {
      throw error;
    }
    void options.logger?.warn?.("hermes_api_server_connect_failed", {
      method: String(init.method ?? "GET").toUpperCase(),
      path,
      profile: options.profileName ?? "default",
      port: config.port ?? null,
      url: `http://127.0.0.1:${config.port}${path}`,
      error: error instanceof Error ? (error as Error).message : String(error),
    });
    throw new LinkHttpError(503, "hermes_api_server_unavailable", "Hermes API Server is unavailable");
  });
}

export async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text().catch(() => "");
  const payload = parseJsonObject(raw);
  if (!response.ok || typeof payload !== "object" || payload === null) {
    throw new LinkHttpError(
      502,
      "hermes_response_invalid",
      `Hermes API Server returned HTTP ${response.status}: ${readUpstreamMessage(payload, raw)}`,
    );
  }
  return payload as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readUpstreamMessage(payload: Record<string, unknown> | null, raw: string): string {
  const error =
    typeof payload?.error === "object" && payload.error !== null
      ? (payload.error as Record<string, unknown>)
      : null;
  const message = readStr(error ?? {}, "message") ?? readStr(payload ?? {}, "message");
  if (message) return message;
  const body = raw.trim().replace(/\s+/gu, " ").slice(0, 500);
  return body || "empty response body";
}

function readStr(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
