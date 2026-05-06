import { type RuntimePaths, resolveRuntimePaths } from "../runtime/paths.js";
import { readJsonFile, writeJsonFile } from "../storage/atomic-json.js";
import path from "path";

const STATE_FILE = "link-state.json";

export interface NetworkReportState {
  lastReportedAt: string | null;
  preferredUrls: string[];
  lanIps: string[];
  publicIpv4s: string[];
  publicIpv6s: string[];
}

export interface LinkState {
  networkReport: NetworkReportState;
  updateAvailable: string | null;
  updateDismissedAt: string | null;
}

function stateFilePath(paths: RuntimePaths): string {
  return path.join(paths.homeDir, STATE_FILE);
}

function defaultLinkState(): LinkState {
  return {
    networkReport: {
      lastReportedAt: null,
      preferredUrls: [],
      lanIps: [],
      publicIpv4s: [],
      publicIpv6s: [],
    },
    updateAvailable: null,
    updateDismissedAt: null,
  };
}

export async function readLinkState(paths?: RuntimePaths): Promise<LinkState> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const raw = await readJsonFile(stateFilePath(runtimePaths));
  if (!raw || typeof raw !== "object") return defaultLinkState();
  const state = raw as Partial<LinkState>;
  return {
    networkReport: readNetworkReportState(state.networkReport),
    updateAvailable: typeof state.updateAvailable === "string" ? state.updateAvailable : null,
    updateDismissedAt: typeof state.updateDismissedAt === "string" ? state.updateDismissedAt : null,
  };
}

function readNetworkReportState(value: unknown): NetworkReportState {
  if (!value || typeof value !== "object") {
    return defaultLinkState().networkReport;
  }
  const v = value as Partial<NetworkReportState>;
  return {
    lastReportedAt: typeof v.lastReportedAt === "string" ? v.lastReportedAt : null,
    preferredUrls: readStringArray(v.preferredUrls),
    lanIps: readStringArray(v.lanIps),
    publicIpv4s: readStringArray(v.publicIpv4s),
    publicIpv6s: readStringArray(v.publicIpv6s),
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export async function updateNetworkReportState(
  update: Partial<NetworkReportState>,
  paths?: RuntimePaths,
): Promise<LinkState> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const current = await readLinkState(runtimePaths);
  const next: LinkState = {
    ...current,
    networkReport: { ...current.networkReport, ...update },
  };
  await writeJsonFile(stateFilePath(runtimePaths), next);
  return next;
}

export async function updateLinkState(
  update: Partial<Omit<LinkState, "networkReport">>,
  paths?: RuntimePaths,
): Promise<LinkState> {
  const runtimePaths = paths ?? resolveRuntimePaths();
  const current = await readLinkState(runtimePaths);
  const next: LinkState = { ...current, ...update };
  await writeJsonFile(stateFilePath(runtimePaths), next);
  return next;
}
