import { LINK_VERSION } from "../constants.js";
import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { readLinkState, updateLinkState } from "./state.js";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string | null;
  dismissed: boolean;
}

export async function checkForUpdates(options: {
  paths?: RuntimePaths;
} = {}): Promise<UpdateInfo> {
  const paths = options.paths ?? resolveRuntimePaths();
  const state = await readLinkState(paths);
  return buildUpdateInfo(state.updateAvailable, state.updateDismissedAt);
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
