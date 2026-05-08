import { callHermesApi, readJsonResponse } from "./api-proxy.js";

export async function listHermesModels(
  options: {
    logger?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
    profileName?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  const response = await callHermesApi("/v1/models", { method: "GET" }, options);
  if (response.status === 404) {
    return { models: [] };
  }
  return await readJsonResponse(response);
}
