import { LINK_VERSION } from "../constants.js";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { readLinkState, updateLinkState } from "./state.js";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string | null;
  dismissed: boolean;
}

export async function checkForUpdates(options: {
  relayBaseUrl: string;
  paths?: RuntimePaths;
  fetchImpl?: typeof fetch;
}): Promise<UpdateInfo> {
  const paths = options.paths ?? resolveRuntimePaths();
  const state = await readLinkState(paths);
  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(
      `${options.relayBaseUrl.replace(/\/+$/u, "")}/api/v1/relay/link-versions/latest`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) {
      return buildUpdateInfo(state.updateAvailable, state.updateDismissedAt);
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const latestVersion = typeof body?.version === "string" ? body.version : null;
    if (latestVersion && latestVersion !== LINK_VERSION) {
      await updateLinkState({ updateAvailable: latestVersion }, paths);
      return buildUpdateInfo(latestVersion, state.updateDismissedAt);
    }
    return buildUpdateInfo(latestVersion, state.updateDismissedAt);
  } catch {
    return buildUpdateInfo(state.updateAvailable, state.updateDismissedAt);
  }
}

function buildUpdateInfo(
  availableVersion: string | null,
  dismissedAt: string | null,
): UpdateInfo {
  return {
    currentVersion: LINK_VERSION,
    availableVersion,
    dismissed: dismissedAt !== null,
  };
}

export async function dismissUpdate(paths?: RuntimePaths): Promise<void> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  await updateLinkState({ updateDismissedAt: new Date().toISOString() }, runtimePaths);
}
