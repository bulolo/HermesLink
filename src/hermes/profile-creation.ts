import { EventEmitter } from "events";
import { type RuntimePaths } from "../runtime/paths.js";

const creationEvents = new EventEmitter();

export async function readHermesProfileCreationStatus(
  _paths: RuntimePaths,
): Promise<Record<string, unknown>> {
  return {
    ok: true,
    state: "idle",
    profile_name: null,
    started_at: null,
    finished_at: null,
    pid: null,
    job_id: null,
    lines: [],
    error: null,
  };
}

export async function startHermesProfileCreation(
  _input: Record<string, unknown>,
  options: { paths: RuntimePaths; logger?: unknown },
): Promise<Record<string, unknown>> {
  return readHermesProfileCreationStatus(options.paths);
}

export function subscribeHermesProfileCreationStatus(
  listener: (status: Record<string, unknown>) => void,
): () => void {
  creationEvents.on("status", listener);
  return () => creationEvents.off("status", listener);
}
